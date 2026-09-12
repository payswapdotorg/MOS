/**
 * MarketingOS module: /integrations
 * Authority: Integration contracts (spec/implementation-contract.md §1, §20).
 *
 * MKT-023 implements this authority (INT-001 — the provider integration
 * boundary). External providers are normalized behind ADAPTERS: this module
 * owns the GENERIC INTEGRATION PORTS and the FIRST-PARTY ADAPTER
 * MECHANISM —
 *
 *   - the PORT (implementation-contract §20): one provider-neutral adapter
 *     contract covering the frozen support list — connection lifecycle,
 *     capability discovery, read operations, mutation operations,
 *     webhook/event ingestion, rate-limit/backoff metadata, provider
 *     identifiers, and source timestamp/ETag/version where available. Core
 *     domains exchange ONLY these normalized contracts; an adapter owns
 *     ALL provider-specific API/SDK details;
 *   - the ADAPTER MECHANISM: adapters arrive as DATA through the module
 *     dependencies (`adapters: readonly IntegrationAdapter[]`) and are
 *     registered at construction — the registry is a validated map keyed
 *     by adapterKey, NEVER a hardcoded provider branch. There are NO
 *     first-party connectors in this Work Item (MKT-024 adds Meta/Google/
 *     analytics/CRM/commerce/CMS adapters); the sanctioned home for
 *     provider-specific implementations is
 *     src/modules/integrations/internal/adapters/** (the
 *     internal/adapters/adapter-contract.ts re-export is the import
 *     surface for those implementations — the /ai-runtime MKT-018
 *     precedent). Adapters use the platform HttpCallPort for egress — NO
 *     provider SDK may be imported anywhere in src/ (EXTERNAL_PACKAGE_
 *     IN_SRC: the only permitted infrastructure client is 'pg' inside
 *     platform adapters), and tests supply STUB adapters implementing
 *     this port, never real SDKs;
 *   - CONNECTION LIFECYCLE (registered → connected → error/suspended with
 *     a health state): a connection is Client-owned, references its
 *     credential by LOGICAL NAME (the /credentials reference id — NEVER
 *     material; implementation-contract §21), carries non-secret
 *     per-connection provider configuration as data, and records the
 *     normalized rate-limit/backoff state observed on provider calls;
 *   - WEBHOOK/EVENT INGESTION: append-oriented with SERVER-DERIVED
 *     provenance (architecture.md §23 "External events are validated,
 *     durably persisted, queued and handled idempotently"). A verified
 *     event flows to /evidence THROUGH /evidence's own public contract
 *     (a declared STRUCTURAL PORT — the /metrics precedent) as a
 *     'source_fact' observation of quality 'C' with integration-derived
 *     provenance: this module never fabricates evidence class, provenance
 *     or quality — it appends an honest source observation of the raw
 *     provider event;
 *   - NO SYSTEM OF RECORD (architecture.md §20: "No provider is the
 *     system of record for MarketingOS workflow, deployment, evidence,
 *     policy or execution state"): the integration state in this module
 *     is EXACTLY connection/capability metadata — status, health,
 *     credential reference, provider config, rate-limit state, last
 *     error. No workflow/deployment/evidence/policy/execution state is
 *     stored here; evidence lives in /evidence, policies in /policies,
 *     credentials in /credentials.
 *
 * What this module deliberately does NOT do (bounded scope, MKT-023):
 *   - NO first-party connectors (MKT-024) and NO extension-registry
 *     integrations (MKT-022): the adapter set arrives as instances
 *     through the deps and is empty until those Work Items land;
 *   - NO credential storage: connections reference the /credentials
 *     authority by logical name; material resolves ONLY inside this
 *     module, after a fail-closed /policies evaluation, through the
 *     /credentials public contract's authorized-execution path, and is
 *     passed to the adapter IN-PROCESS — never persisted, logged,
 *     audited or queued (implementation-contract §21);
 *   - NO policy engine: every provider-touching action (connect probe,
 *     read, mutation, webhook verification) delegates to the /policies
 *     public contract's fail-closed evaluateAction and proceeds ONLY on
 *     an explicit allow (enforcementOutcome; unknown/deny/error = the
 *     action does not happen — POL-001 fail-closed). The network
 *     dimension governs provider egress (operations
 *     integration.connect/integration.read/integration.mutate); the
 *     secrets dimension governs credential use for the call
 *     (operation integration.credential with the credential reference as
 *     resource). Pure bookkeeping (register/suspend/list/get) touches no
 *     provider and is not policy-gated;
 *   - NO workflow/execution/deployment mutation and NO second tenant,
 *     audit, evidence or credential authority.
 *
 * DEPENDENCY POSTURE (frozen matrix: /integrations ──→ /credentials,
 * /policies): this public entry imports those two public contracts
 * DIRECTLY (the only matrix-allowed module dependencies). The REQUIRED
 * canonical Client ownership resolution (implementation-contract §2) and
 * the /evidence append flow arrive through declared STRUCTURAL PORTS:
 * narrow typed views of the /clients and /evidence public contracts. The
 * concrete public-contract instances satisfy these ports structurally
 * and are wired at the composition root — the resolution/appends still
 * execute server-side THROUGH those public contracts while the frozen
 * import matrix stays intact (no /clients or /evidence import exists
 * inside src/modules/integrations — verified by tools/arch-check and
 * tests/architecture/integrations-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { CredentialsModuleApi } from '../credentials/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// Provider identifiers + capability discovery (implementation-contract §20)
// ---------------------------------------------------------------------------

/**
 * The identity of one registered adapter. `adapterKey` is the registration
 * key connections reference (stable, provider-neutral symbol — e.g.
 * 'meta-ads'); `providerLabel` is the human provider label; the module
 * stores both as connection DATA (the registry is data, not code branches).
 */
export interface IntegrationAdapterDescriptor {
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly description: string;
}

/** The frozen capability kinds (implementation-contract §20 support list). */
export type IntegrationCapabilityKind = 'read' | 'mutation' | 'webhook';

export const INTEGRATION_CAPABILITY_KINDS: readonly IntegrationCapabilityKind[] = [
  'read',
  'mutation',
  'webhook',
];

/**
 * One normalized capability: what the adapter can do. `operations` is the
 * CLOSED list of normalized operation labels the capability accepts —
 * executeRead/executeMutation validate the requested operation against the
 * registered capabilities BEFORE any policy read or provider call.
 */
export interface IntegrationCapability {
  readonly capabilityKey: string;
  readonly kind: IntegrationCapabilityKind;
  readonly operations: readonly string[];
  readonly description: string;
}

/** The registry view of one registered adapter (pure data). */
export interface RegisteredAdapterInfo {
  readonly descriptor: IntegrationAdapterDescriptor;
  readonly capabilities: readonly IntegrationCapability[];
}

// ---------------------------------------------------------------------------
// Rate-limit / backoff metadata (implementation-contract §20)
// ---------------------------------------------------------------------------

/**
 * The normalized rate-limit/backoff state observed on one provider call.
 * Every field is optional (providers differ); the module persists the
 * latest observed state on the connection (capability metadata — the
 * operational health of the pipe, never business state).
 */
export interface NormalizedRateLimit {
  readonly limitRemaining: number | null;
  readonly limitResetAt: string | null;
  readonly backoffUntil: string | null;
  readonly retryAfterSeconds: number | null;
}

// ---------------------------------------------------------------------------
// The generic adapter PORT (implementation-contract §20)
// ---------------------------------------------------------------------------

/**
 * The in-process call context handed to an adapter. `credentialMaterial`
 * is resolved by THIS module (only after a fail-closed /policies allow)
 * through the /credentials authorized-execution path and exists ONLY
 * in-process: it is never persisted, logged, audited or queued
 * (implementation-contract §21). `providerConfig` is the connection's
 * non-secret configuration data.
 */
export interface IntegrationAdapterCallContext {
  readonly connectionId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
  readonly credentialMaterial: Uint8Array | null;
}

/** One normalized provider read request (operation ∈ a read capability). */
export interface NormalizedReadRequest {
  readonly operation: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** One normalized provider mutation request (operation ∈ a mutation capability). */
export interface NormalizedMutationRequest {
  readonly operation: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * One normalized provider record: the provider identifier (its record id)
 * plus the source metadata available from the provider — source timestamp,
 * ETag and version where available (implementation-contract §20).
 */
export interface NormalizedProviderRecord {
  readonly providerRecordId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly sourceTimestamp: string | null;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/**
 * The normalized read outcome. Adapters NEVER throw for invocation-level
 * outcomes — transport failures, provider errors and timeouts are returned
 * as data (ok=false + error), so the module records the health/rate-limit
 * state and the caller decides. (The /ai-runtime adapter precedent.)
 */
export interface NormalizedReadResult {
  readonly ok: boolean;
  readonly records: readonly NormalizedProviderRecord[];
  readonly error: string | null;
  readonly rateLimit: NormalizedRateLimit | null;
}

/** The normalized mutation outcome (same never-throw posture). */
export interface NormalizedMutationResult {
  readonly ok: boolean;
  readonly providerRecordId: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly rateLimit: NormalizedRateLimit | null;
}

/** The connection probe outcome (the connect/resume transition gate). */
export interface AdapterProbeResult {
  readonly reachable: boolean;
  readonly healthy: boolean;
  readonly message: string | null;
  readonly rateLimit: NormalizedRateLimit | null;
}

/** One inbound webhook delivery (the caller is the authenticated relay). */
export interface WebhookDeliveryInput {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
}

/** The adapter's authenticity verdict for one inbound delivery. */
export interface WebhookVerificationResult {
  readonly verified: boolean;
  readonly reason: string | null;
  readonly normalizedEventType: string | null;
}

/**
 * THE GENERIC INTEGRATION PORT (INT-001): the provider-neutral contract
 * every first-party adapter implements. The routing core (this module)
 * depends on this CONTRACT, never on an implementation — adapter
 * instances arrive as DATA through the module deps (first-party
 * registration surface), the composition root wires them, and tests
 * supply stubs implementing this interface.
 */
export interface IntegrationAdapter {
  readonly descriptor: IntegrationAdapterDescriptor;
  readonly capabilities: readonly IntegrationCapability[];
  /** Provider reachability/health probe (the connect transition gate). */
  probeConnection(context: IntegrationAdapterCallContext): Promise<AdapterProbeResult>;
  /** One normalized read operation. */
  read(
    context: IntegrationAdapterCallContext,
    request: NormalizedReadRequest,
  ): Promise<NormalizedReadResult>;
  /** One normalized mutation operation. */
  mutate(
    context: IntegrationAdapterCallContext,
    request: NormalizedMutationRequest,
  ): Promise<NormalizedMutationResult>;
  /** Provider-specific authenticity verification of one inbound delivery. */
  verifyWebhook(
    context: IntegrationAdapterCallContext,
    delivery: WebhookDeliveryInput,
  ): Promise<WebhookVerificationResult>;
}

// ---------------------------------------------------------------------------
// Connection lifecycle (implementation-contract §20 "connection lifecycle")
// ---------------------------------------------------------------------------

export type IntegrationConnectionStatus = 'registered' | 'connected' | 'suspended' | 'error';

/**
 * The frozen connection lifecycle. `registered` is the born state; the
 * connect probe moves registered/error/suspended → connected (or error);
 * suspension is the administrative pause of ANY live state; there is NO
 * terminal state — a connection is operational plumbing, not history, and
 * can always be reconnected. Enforced by this table, the module CAS
 * transitions and the migration 029 trigger backstop.
 */
export const INTEGRATION_CONNECTION_TRANSITIONS: Readonly<
  Record<IntegrationConnectionStatus, readonly IntegrationConnectionStatus[]>
> = {
  registered: ['connected', 'suspended', 'error'],
  connected: ['suspended', 'error'],
  error: ['connected', 'suspended'],
  suspended: ['connected'],
};

export function isLegalIntegrationConnectionTransition(
  from: IntegrationConnectionStatus,
  to: IntegrationConnectionStatus,
): boolean {
  return INTEGRATION_CONNECTION_TRANSITIONS[from].includes(to);
}

/** The frozen connection health state (probed, never caller-declared). */
export type IntegrationConnectionHealth = 'unknown' | 'healthy' | 'degraded' | 'unreachable';

export const INTEGRATION_CONNECTION_HEALTHS: readonly IntegrationConnectionHealth[] = [
  'unknown',
  'healthy',
  'degraded',
  'unreachable',
];

/**
 * One connection record — EXACTLY connection/capability metadata: identity,
 * Client ownership (agency derived server-side through the /clients chain),
 * the adapterKey + provider label (registry DATA), the credential reference
 * (LOGICAL NAME — never material), non-secret provider config, the
 * lifecycle status + health, the latest normalized rate-limit/backoff
 * state, the last error and the CAS version. There is deliberately NO
 * workflow/deployment/evidence/policy/execution state on this record
 * (architecture.md §20 — no system of record).
 */
export interface IntegrationConnectionRecord {
  readonly connectionId: string;
  readonly clientId: string;
  readonly agencyId: string;
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly status: IntegrationConnectionStatus;
  readonly health: IntegrationConnectionHealth;
  readonly credentialReferenceId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
  readonly rateLimit: NormalizedRateLimit | null;
  readonly lastError: string | null;
  readonly lastCheckedAt: string | null;
  readonly createdBy: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Webhook/event ingestion (append-oriented, server-derived provenance)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every module mutation (the MKT-013/014/021
 * pattern): built exclusively by server code from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body (route validation rejects provenance-shaped
 * authority fields; this type is a separate module-API argument so no DTO
 * can feed it structurally). `receivedAt` is stamped by the module clock.
 */
export interface IntegrationProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance as persisted on the immutable ingested-event record. */
export interface IntegrationRecordedProvenance extends IntegrationProvenance {
  readonly receivedAt: string;
}

/**
 * One immutable, append-only ingested provider event. The event is
 * verified by the adapter (provider-specific authenticity), recorded with
 * server-derived provenance, and — when verified — a derived 'source_fact'
 * observation was appended to /evidence (evidenceRef) through /evidence's
 * own public contract. This record NEVER rewrites: the ledger is the raw
 * ingestion history.
 */
export interface IntegrationIngestedEventRecord {
  readonly eventId: string;
  readonly connectionId: string;
  readonly clientId: string;
  readonly adapterKey: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly evidenceRef: string | null;
  readonly provenance: IntegrationRecordedProvenance;
}

// ---------------------------------------------------------------------------
// Read/mutation outcomes (data, never thrown invocation failures)
// ---------------------------------------------------------------------------

/** The executeRead outcome: the normalized result + the decision trail. */
export interface IntegrationReadOutcome {
  readonly connectionId: string;
  readonly adapterKey: string;
  readonly operation: string;
  readonly ok: boolean;
  readonly records: readonly NormalizedProviderRecord[];
  readonly error: string | null;
  readonly rateLimit: NormalizedRateLimit | null;
  /** The recorded network-dimension policy decision (audit trail). */
  readonly policyDecisionId: string;
  /** The connection row AFTER the health/rate-limit bookkeeping (CAS). */
  readonly connection: IntegrationConnectionRecord;
}

/** The executeMutation outcome (same shape, one provider record). */
export interface IntegrationMutationOutcome {
  readonly connectionId: string;
  readonly adapterKey: string;
  readonly operation: string;
  readonly ok: boolean;
  readonly providerRecordId: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: string | null;
  readonly rateLimit: NormalizedRateLimit | null;
  readonly policyDecisionId: string;
  readonly connection: IntegrationConnectionRecord;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients resolution
// and /evidence append — see the module header note)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /integrations consumes): the resolved Client's
 * identity, its owning Agency and its status. The real ClientOwnerContext
 * satisfies this structurally — /clients remains the ONLY Client
 * ownership authority.
 */
export interface IntegrationsClientOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'client';
    readonly agencyId: string;
    readonly clientId: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /clients public contract /integrations depends on:
 * canonical server-side Client ownership resolution from durable state.
 * Satisfied structurally by ClientsModuleApi; wired at the composition
 * root.
 */
export interface IntegrationsClientOwnershipPort {
  resolveClientOwnership(clientId: string): Promise<IntegrationsClientOwnershipSnapshot | null>;
}

/**
 * The narrow append view of the /evidence public contract /integrations
 * depends on for verified webhook events. The input is deliberately
 * PINNED to the values this module honestly produces: class is ALWAYS
 * 'source_fact' (a direct provider observation — never a claim class),
 * quality is ALWAYS 'C' (a defensible machine-recorded observation),
 * source.system is the adapter key and source.ref the event identity.
 * The module cannot fabricate evidence class, quality or provenance —
 * only the payload content and event identity vary.
 */
export interface IntegrationEvidenceAppendInput {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly class: 'source_fact';
  readonly source: {
    readonly system: string;
    readonly ref: string | null;
  };
  readonly observedAt: string;
  readonly content: Readonly<Record<string, unknown>>;
  readonly contentRef: string | null;
  readonly quality: 'C';
  readonly confidence: null;
  readonly supersedesEvidenceId: null;
}

/** The narrow provenance view /evidence receives (server-derived here). */
export interface IntegrationEvidenceProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * The slice of the /evidence public contract /integrations depends on:
 * appendEvidence. Satisfied structurally by EvidenceModuleApi; wired at
 * the composition root. /evidence remains the ONLY evidence/provenance
 * authority.
 */
export interface IntegrationEvidenceSinkPort {
  appendEvidence(
    input: IntegrationEvidenceAppendInput,
    provenance: IntegrationEvidenceProvenance,
  ): Promise<{ readonly evidenceId: string }>;
}

// ---------------------------------------------------------------------------
// Canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL CONNECTION OWNER CONTEXT: the single server-side
 * resolution of WHICH Client owns the connection (and which Agency owns
 * that Client), derived from durable state on every call. Connection-
 * scoped operations authorize against this context — never against
 * caller-supplied tenant or connection identity. The Client is the hard
 * security boundary: a tombstoned (deleted) Client never resolves (null —
 * uniform 404 upstream).
 */
export interface IntegrationsConnectionOwnerContext {
  readonly scope: {
    readonly kind: 'integration';
    readonly agencyId: string;
    readonly clientId: string;
    readonly connectionId: string;
  };
  readonly connection: IntegrationConnectionRecord;
  readonly clientOwnership: IntegrationsClientOwnershipSnapshot;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical connection owner context from an
 * ALREADY-RESOLVED /clients canonical owner context and the connection
 * record. Purity is asserted by unit tests — the same inputs always
 * compose the same context. Defined in internal/policy-gate.ts (the
 * fail-closed gate module) and re-exported here as part of the module
 * contract.
 */
export { composeIntegrationConnectionOwnerContext } from './internal/policy-gate.ts';

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface IntegrationsModuleApi {
  /**
   * The adapter registry AS DATA: every registered adapter's descriptor +
   * capabilities (the capability-discovery surface). Registry contents
   * come exclusively from the injected adapter instances — there is no
   * hardcoded provider list in this module.
   */
  listRegisteredAdapters(): readonly RegisteredAdapterInfo[];
  /**
   * Registers one connection (the born state 'registered'). Client
   * ownership is resolved canonically through the /clients structural
   * port BEFORE any write: unknown/tombstoned Client → NotFoundError
   * (uniform — a foreign identifier is not a traversal oracle); disabled
   * Client → ConflictError. The adapterKey must exist in the registry
   * (data lookup); the credential reference must resolve through the
   * /credentials public contract as LIVE and SCOPE-COMPATIBLE with the
   * Client (same agency; client-narrowed references must match) —
   * NotFoundError/ConflictError otherwise. providerConfig is guarded:
   * string→string data with NO material-shaped key (§21). The
   * (client, adapterKey, credentialReference) triple is DB-fenced against
   * duplicate registration.
   */
  registerConnection(
    input: {
      readonly clientId: string;
      readonly adapterKey: string;
      readonly credentialReferenceId: string;
      readonly providerConfig: Readonly<Record<string, string>>;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationConnectionRecord>;
  /** Raw record by id (any status — operational state is always readable). */
  getConnection(connectionId: string): Promise<IntegrationConnectionRecord | null>;
  /**
   * Canonical ownership resolution: the connection plus its owning Client
   * chain, composed into the canonical owner context. Null when the
   * connection does not exist OR its Client is a deleted tombstone —
   * callers surface a uniform 404 so foreign, unknown and orphaned
   * identifiers are indistinguishable (the hard-boundary posture).
   */
  resolveConnectionOwnership(
    connectionId: string,
  ): Promise<IntegrationsConnectionOwnerContext | null>;
  /** The Client's connections (bounded, newest first). Unknown Client → 404. */
  listConnectionsForClient(clientId: string): Promise<readonly IntegrationConnectionRecord[]>;
  /**
   * The CONNECT/RESUME transition (registered/error/suspended →
   * connected): policy-gated on the network dimension (operation
   * 'integration.connect', resource = adapterKey) — fail-closed, the
   * probe never happens without an explicit allow. The credential
   * material is resolved through /credentials (authorized-execution
   * scope) and passed to the adapter probe IN-PROCESS only. A healthy
   * probe transitions to connected/healthy; an unreachable probe
   * transitions to error/unreachable with the recorded message. CAS on
   * expectedVersion (row-locked transition).
   */
  connectConnection(
    input: {
      readonly connectionId: string;
      readonly expectedVersion: number;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationConnectionRecord>;
  /**
   * The administrative SUSPEND transition (any live state → suspended).
   * Pure bookkeeping: no provider call, no policy gate, no credential
   * resolution — suspension is the operational pause and always succeeds
   * on the CAS check.
   */
  suspendConnection(
    input: {
      readonly connectionId: string;
      readonly reason: string | null;
      readonly expectedVersion: number;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationConnectionRecord>;
  /**
   * One normalized READ operation through the adapter port. The full
   * fail-closed gate: canonical ownership → connection live-state check
   * → capability discovery (operation ∈ a registered read capability) →
   * network-dimension policy evaluation (operation 'integration.read',
   * resource = adapterKey) → secrets-dimension policy evaluation
   * (operation 'integration.credential', resource = the credential
   * reference) → credential material resolution (authorized-execution
   * scope, in-process only) → the adapter read. The outcome is DATA
   * (adapters never throw invocation failures); the connection row
   * records the observed health/rate-limit state (CAS bookkeeping). A
   * policy deny/unknown → PolicyDeniedError BEFORE any material
   * resolution or provider call.
   */
  executeRead(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationReadOutcome>;
  /**
   * One normalized MUTATION operation through the adapter port — the same
   * fail-closed gate with operation 'integration.mutate'. Mutations are
   * side-effecting; the outcome record + decision trail are the audit
   * surface.
   */
  executeMutation(
    input: {
      readonly connectionId: string;
      readonly operation: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationMutationOutcome>;
  /**
   * Ingests one inbound webhook/event (append-oriented). The adapter
   * verifies authenticity (provider-specific, using the credential
   * material resolved after a secrets-dimension policy allow — operation
   * 'integration.webhook'); an UNVERIFIED delivery is REJECTED
   * (InvalidRequestError — nothing is recorded, nothing becomes
   * evidence). A verified delivery is appended ONCE to the immutable
   * event ledger with server-derived provenance and a derived
   * 'source_fact' observation appended to /evidence through the evidence
   * sink port (class/quality/provenance pinned — see the port docs).
   */
  ingestWebhookEvent(
    input: {
      readonly connectionId: string;
      readonly eventType: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly headers: Readonly<Record<string, string>>;
    },
    provenance: IntegrationProvenance,
  ): Promise<IntegrationIngestedEventRecord>;
  /** Raw event by id (immutable history is always readable). */
  getIngestedEvent(eventId: string): Promise<IntegrationIngestedEventRecord | null>;
  /** The Client's ingested events, newest first (bounded). Unknown Client → 404. */
  listIngestedEventsForClient(clientId: string): Promise<readonly IntegrationIngestedEventRecord[]>;
}

export interface IntegrationsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix (/integrations ──→ /policies): the fail-closed decision
   * engine consulted BEFORE every provider-touching action. Only
   * explicit allows proceed (enforcementOutcome).
   */
  readonly policies: PoliciesModuleApi;
  /**
   * Frozen matrix (/integrations ──→ /credentials): credential REFERENCE
   * validation on registration and MATERIAL resolution (authorized-
   * execution scope) after a policy allow — this module is the sanctioned
   * authorized execution context for provider credentials.
   */
  readonly credentials: CredentialsModuleApi;
  /**
   * Structural port: canonical /clients ownership resolution (see the
   * module header). The concrete /clients public-contract instance is
   * wired at the composition root.
   */
  readonly clientOwnership: IntegrationsClientOwnershipPort;
  /**
   * Structural port: the /evidence append surface for verified webhook
   * events (see the module header). The concrete /evidence public-
   * contract instance is wired at the composition root.
   */
  readonly evidenceSink: IntegrationEvidenceSinkPort;
  /**
   * The FIRST-PARTY ADAPTER REGISTRATION SURFACE: adapter instances as
   * DATA. Validated at construction (unique adapterKey, legal descriptor
   * + capability shapes, declared operations) — duplicates or malformed
   * registrations fail construction loudly. Empty until MKT-024.
   */
  readonly adapters: readonly IntegrationAdapter[];
}

export { createIntegrationsModule } from './internal/module.ts';
/**
 * The input guards (adapter-descriptor/capability validation, connection
 * and event shape validation + the §21 material-key backstop) and the pure
 * registry builder — exported for unit tests and future server-side
 * callers so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  assertValidAdapterRegistration,
  assertValidConnectionRegistration,
  assertValidProvenance,
  assertValidWebhookIngestion,
  buildAdapterRegistry,
  containsMaterialShapedKey,
} from './internal/store.ts';
