/**
 * MarketingOS module: /extensions
 * Authority: Extension registry/invocation contract (spec/implementation-contract.md §1, §19).
 *
 * MKT-022 implements this authority (EXT-001 — "Provide versioned extension
 * manifests, permissions, configuration, installation and invocation
 * contracts"; dependencies TENANT-002 + EXEC-001 per requirements.md).
 * This module owns:
 *
 *   - the VERSIONED EXTENSION REGISTRY: one immutable row per
 *     (publisher, extension key, version) — registration is PUBLICATION
 *     (spec/extension-model.md §4 "Publish"): the manifest content is
 *     IMMUTABLE after publication (re-registration of the same version is
 *     rejected; a new version is a NEW record — implementation-contract §19
 *     "An extension has a stable publisher + extension ID + version.
 *     Versions are immutable");
 *   - the MANIFEST CONTRACT (spec/extension-model.md §2): identifier/
 *     publisher, version, compatibility range, capability list (the §3
 *     closed category set), permissions (§5 least-privilege — a CLOSED
 *     action vocabulary that structurally cannot declare workflow-state
 *     mutation, credential creation, evidence-provenance fabrication or
 *     audit disabling), required secrets BY LOGICAL NAME (never values —
 *     the CRED-001 posture), data scopes (closed vocabulary), network
 *     requirements, runtime class, input/output contracts, event
 *     subscriptions, UI surfaces and the configuration contract used to
 *     validate installation configuration;
 *   - the INSTALL/CONFIGURE LIFECYCLE (spec/extension-model.md §4
 *     "Install → Configure → Authorize → Invoke → Observe" plus the
 *     Disable/Uninstall/Version edges): installation records the extension
 *     VERSION against a canonical Client/Workspace context (scope resolved
 *     by the CALLER from durable ownership state and re-fenced by the
 *     database scope-chain triggers — the /credentials scope-as-data
 *     posture; /extensions has no /clients or /workspaces dependency in
 *     the frozen matrix); configuration values are validated against the
 *     manifest's declared config contract; secret bindings map REQUIRED
 *     LOGICAL NAMES to credential REFERENCES (never material — resolved
 *     through the /credentials public contract, fail-closed);
 *   - the INVOCATION CONTRACT (implementation-contract §19): invocation is
 *     always ExtensionId + Version + ExecutionId + GrantedCapabilitySet +
 *     InputContract. beginExtensionInvocation derives a SHORT-LIVED
 *     invocation context from the installed+authorized extension version
 *     and the EXECUTION's canonical ownership (resolved through the
 *     /executions public contract — the ONLY sanctioned tenant-resolution
 *     path here): the context carries identity, the granted data scopes,
 *     the capability set and the POLICY POSTURE (the append-only decision
 *     recorded by the merged /policies engine). It is NEVER a platform
 *     credential: no secret material, no secret handle, no reusable
 *     authorization token — extensions cannot create credentials for
 *     themselves (extension-model.md §5).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-022):
 *   - NO Extension Developer Portal UI (MKT-032) and NO UI of any kind;
 *   - NO provider-specific extensions (MKT-024) and NO domain packs
 *     (MKT-036) — the registry is provider-neutral;
 *   - NO sandbox runtime: /executions owns the runtime contract extension
 *     code executes under (MKT-011/012 merged surfaces); this module only
 *     derives the invocation context the host enforces;
 *   - NO workflow-state mutation, NO credential creation, NO evidence
 *     creation and NO provenance fabrication: the frozen matrix gives
 *     /extensions exactly /executions, /policies, /credentials, /audit —
 *     /workflows and /evidence are structurally unreachable (EXT-AC-03,
 *     EXT-AC-04);
 *   - NO second tenant, permission or audit authority: installation
 *     authorization stays exactly the /agencies membership authority
 *     composed with canonical /workspaces owner resolution at the route
 *     layer; the invocation policy posture is delegated to the merged
 *     /policies engine (fail-closed on unknown/error).
 *
 * DEPENDENCY POSTURE (frozen matrix: /extensions ──→ /executions, /policies,
 * /credentials, /audit): this public entry imports the /executions, /policies
 * and /credentials public contracts DIRECTLY (the matrix-allowed
 * dependencies). /audit is wired at the ROUTE layer (recordMutationAudit —
 * the same posture as /policies); the /executions dependency is used for
 * canonical execution ownership resolution; /policies evaluates the
 * extension-dimension boundary on install and invoke; /credentials resolves
 * secret-binding REFERENCES only (never material).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { RuntimeClass } from '../executions/public.ts';
import type { CredentialsModuleApi } from '../credentials/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';

// ---------------------------------------------------------------------------
// Capability categories (spec/extension-model.md §3 — the closed set)
// ---------------------------------------------------------------------------

/**
 * The closed capability-category vocabulary of extension-model.md §3:
 * "data source; research/discovery; content/creative generation; execution
 * action; measurement; CRM/commerce integration; field acquisition
 * capability; AI capability; approval/UI surface". A manifest capability
 * declares exactly one category plus a bounded capability NAME (the
 * invocable unit — invocation requests name capabilities by that name).
 * Category is a code + DB CHECK, never a caller freedom.
 */
export type ExtensionCapabilityCategory =
  | 'data-source'
  | 'research-discovery'
  | 'content-creative-generation'
  | 'execution-action'
  | 'measurement'
  | 'crm-commerce-integration'
  | 'field-acquisition'
  | 'ai-capability'
  | 'approval-ui-surface';

export const EXTENSION_CAPABILITY_CATEGORIES: readonly ExtensionCapabilityCategory[] = [
  'data-source',
  'research-discovery',
  'content-creative-generation',
  'execution-action',
  'measurement',
  'crm-commerce-integration',
  'field-acquisition',
  'ai-capability',
  'approval-ui-surface',
];

/** Interpretable meaning of every capability category (traceability). */
export const EXTENSION_CAPABILITY_CATEGORY_MEANINGS: Readonly<
  Record<ExtensionCapabilityCategory, string>
> = {
  'data-source': 'provides/acquires external data (feeds, scraping-class sources, integrations)',
  'research-discovery': 'discovers/researches audiences, keywords, markets, creatives',
  'content-creative-generation': 'generates content or creative assets',
  'execution-action': 'performs side-effecting marketing actions',
  measurement: 'measures outcomes and platform-reported metrics',
  'crm-commerce-integration': 'integrates CRM/commerce systems',
  'field-acquisition': 'provides field acquisition capabilities (human/field-side)',
  'ai-capability': 'provides an AI capability (models, evaluators, tooling)',
  'approval-ui-surface': 'provides an approval or UI surface',
};

/** One declared capability: category (closed set) + bounded invocable name. */
export interface ExtensionCapabilityDeclaration {
  readonly category: ExtensionCapabilityCategory;
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Permissions (spec/extension-model.md §5 — explicit, least-privilege)
// ---------------------------------------------------------------------------

/**
 * The closed permission-action vocabulary of extension-model.md §5
 * ("Permissions are explicit and least-privilege. The extension receives
 * only the data/actions needed for the invocation"). Everything NOT in
 * this set is REJECTED at registration (EXT-AC-01: a manifest that fails
 * shape/permission declaration is rejected): an extension can never
 * DECLARE workflow-state mutation, credential creation, evidence-
 * provenance assertion or audit disabling — those powers are not
 * declarable permissions at all.
 */
export type ExtensionPermissionAction =
  | 'data:read'
  | 'data:write'
  | 'network:egress'
  | 'secret:use';

export const EXTENSION_PERMISSION_ACTIONS: readonly ExtensionPermissionAction[] = [
  'data:read',
  'data:write',
  'network:egress',
  'secret:use',
];

/**
 * One declared permission: action (closed vocabulary) + optional resource
 * selector (e.g. a host for network:egress, a logical scope label for
 * data:read). Least-privilege is enforced structurally: the closed
 * vocabulary contains no workflow/credential/evidence-provenance/audit
 * action.
 */
export interface ExtensionPermissionDeclaration {
  readonly action: ExtensionPermissionAction;
  readonly resource: string | null;
}

// ---------------------------------------------------------------------------
// Data scopes (the granted Client/Workspace data boundary — EXT-AC-02)
// ---------------------------------------------------------------------------

/**
 * The closed data-scope vocabulary: WHAT KIND of data of the OWNING
 * Client/Workspace an invocation context may resolve. Scopes never carry
 * tenant identifiers — the tenant is ALWAYS the execution's canonical
 * owner (server-derived); a caller can never widen it. "Unrelated client
 * data" (extension-model.md §5) is therefore not expressible.
 */
export type ExtensionDataScope = 'client:read' | 'client:write' | 'workspace:read' | 'workspace:write';

export const EXTENSION_DATA_SCOPES: readonly ExtensionDataScope[] = [
  'client:read',
  'client:write',
  'workspace:read',
  'workspace:write',
];

// ---------------------------------------------------------------------------
// The manifest contract (spec/extension-model.md §2)
// ---------------------------------------------------------------------------

/** Platform compatibility range (inclusive min/max platform version labels). */
export interface ExtensionCompatibilityRange {
  readonly minPlatform: string;
  readonly maxPlatform: string;
}

/** One declared network requirement (egress target — policy-gated at use). */
export interface ExtensionNetworkRequirement {
  readonly host: string;
  readonly protocol: string;
  readonly port: number;
  readonly reason: string;
}

/** One configuration-field contract used to validate installation config. */
export interface ExtensionConfigFieldContract {
  readonly type: 'string' | 'number' | 'boolean' | 'object';
  readonly required: boolean;
  readonly description: string;
  readonly pattern: string | null;
}

/**
 * The versioned extension manifest (extension-model.md §2 — every listed
 * field is present; requiredSecretNames are LOGICAL NAMES ONLY: values are
 * never acceptable anywhere in a manifest, per the CRED-001 posture).
 * IMMUTABLE after publication.
 */
export interface ExtensionManifest {
  readonly extensionKey: string;
  readonly publisher: string;
  readonly version: string;
  readonly compatibility: ExtensionCompatibilityRange;
  readonly capabilities: readonly ExtensionCapabilityDeclaration[];
  readonly permissions: readonly ExtensionPermissionDeclaration[];
  readonly requiredSecretNames: readonly string[];
  readonly dataScopes: readonly ExtensionDataScope[];
  readonly networkRequirements: readonly ExtensionNetworkRequirement[];
  readonly runtimeClass: RuntimeClass;
  readonly inputContract: Readonly<Record<string, unknown>>;
  readonly outputContract: Readonly<Record<string, unknown>>;
  readonly eventSubscriptions: readonly string[];
  readonly uiSurfaces: readonly string[];
  readonly configContract: Readonly<Record<string, ExtensionConfigFieldContract>>;
}

/** One immutable REGISTRY row (a published extension version). */
export interface ExtensionRegistryRecord {
  readonly extensionId: string;
  readonly manifest: ExtensionManifest;
  /** The §8-style logical register command key (convergence proof). */
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Installation lifecycle (spec/extension-model.md §4 — install subset)
// ---------------------------------------------------------------------------

/**
 * The frozen INSTALL lifecycle state machine (extension-model.md §4:
 * "Install → Configure → Authorize → Invoke" + "Disable / Uninstall";
 * "Develop → Validate → Publish" happens BEFORE installation — the
 * registry owns publication; "Observe" is the append-only invocation
 * ledger). Transitions:
 *
 *   installed  → configured | uninstalled
 *   configured → authorized | configured (reconfigure) | uninstalled
 *   authorized → configured (reconfigure — re-authorization required) | disabled | uninstalled
 *   disabled   → authorized | uninstalled
 *   uninstalled: TERMINAL (tombstone: history stays readable, identifiers
 *   never replay back to life)
 *
 * Invocation requires 'authorized' — everything else fails closed.
 */
export type ExtensionInstallStatus =
  | 'installed'
  | 'configured'
  | 'authorized'
  | 'disabled'
  | 'uninstalled';

export const EXTENSION_INSTALL_STATUSES: readonly ExtensionInstallStatus[] = [
  'installed',
  'configured',
  'authorized',
  'disabled',
  'uninstalled',
];

export const EXTENSION_INSTALL_TRANSITIONS: Readonly<
  Record<ExtensionInstallStatus, readonly ExtensionInstallStatus[]>
> = {
  installed: ['configured', 'uninstalled'],
  configured: ['authorized', 'configured', 'uninstalled'],
  authorized: ['configured', 'disabled', 'uninstalled'],
  disabled: ['authorized', 'uninstalled'],
  uninstalled: [],
};

/** Terminal install rows — frozen, reject every change. */
export const EXTENSION_INSTALL_TERMINAL_STATUSES: readonly ExtensionInstallStatus[] = [
  'uninstalled',
];

/** Transition-guard predicate: true exactly when (from → to) is a frozen edge. */
export function isLegalExtensionInstallTransition(
  from: ExtensionInstallStatus,
  to: ExtensionInstallStatus,
): boolean {
  return EXTENSION_INSTALL_TRANSITIONS[from].includes(to);
}

/** One installation record (a version pinned to a Client/Workspace). */
export interface ExtensionInstallRecord {
  readonly installId: string;
  readonly extensionId: string;
  /** Canonical scope — server-derived at install, immutable (DB-fenced). */
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly status: ExtensionInstallStatus;
  /** Configuration values validated against the manifest config contract. */
  readonly config: Readonly<Record<string, unknown>>;
  /** LOGICAL NAME → credential REFERENCE id (never material — CRED-001). */
  readonly secretBindings: Readonly<Record<string, string>>;
  /** Granted data scopes (⊆ manifest dataScopes — checked at install). */
  readonly grantedScopes: readonly ExtensionDataScope[];
  readonly idempotencyKey: string;
  readonly version: number;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExtensionInstallOutcome {
  readonly install: ExtensionInstallRecord;
  readonly replayed: boolean;
}

// ---------------------------------------------------------------------------
// The invocation contract (implementation-contract.md §19)
// ---------------------------------------------------------------------------

/** Server-derived invocation provenance (never a request field). */
export interface ExtensionInvocationProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived surface label ('api' for the HTTP surface). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * The SHORT-LIVED invocation context (implementation-contract §19: "The
 * extension receives a short-lived invocation context rather than
 * unrestricted platform credentials"). Derived SERVER-SIDE from the
 * installed+authorized extension version and the EXECUTION's canonical
 * ownership; carries identity, granted data scopes, capability set and
 * policy posture. It is NOT a credential:
 *   - no secret material and no secret handle anywhere (CRED-001/§21);
 *   - no reusable authorization token — the invocationId selects an
 *     OBSERVABILITY record; it authorizes nothing by itself;
 *   - the tenant scope is the execution's canonical owner — never a
 *     caller-supplied value, and never widenable.
 */
export interface ExtensionInvocationContext {
  readonly invocationId: string;
  readonly extensionId: string;
  readonly extensionKey: string;
  readonly version: string;
  readonly installId: string;
  readonly executionId: string;
  /** Server-derived from the execution's canonical ownership (immutable). */
  readonly scope: {
    readonly kind: 'extension-invocation';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  /** The granted capability set (⊆ manifest capabilities — guarded). */
  readonly grantedCapabilities: readonly ExtensionCapabilityDeclaration[];
  /** The granted data scopes (install-granted ∩ manifest-declared). */
  readonly grantedDataScopes: readonly ExtensionDataScope[];
  /** The policy posture of this invocation (an explicit recorded allow). */
  readonly policyDecisionId: string;
  readonly runtimeClass: RuntimeClass;
  /** The validated input contract payload (no material-shaped keys). */
  readonly input: Readonly<Record<string, unknown>>;
  readonly provenance: ExtensionInvocationProvenance;
  readonly issuedAt: string;
  /** Short-lived: the context expires at issuedAt + TTL (bounded). */
  readonly expiresAt: string;
}

/**
 * The append-only invocation ledger row (extension-model.md §4 "Observe" —
 * observability only; NOT an authorization artifact). Every field is
 * server-derived; UPDATE and DELETE are rejected by the database.
 */
export interface ExtensionInvocationRecord {
  readonly invocationId: string;
  readonly extensionId: string;
  readonly extensionKey: string;
  readonly version: string;
  readonly installId: string;
  readonly executionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly grantedCapabilities: readonly ExtensionCapabilityDeclaration[];
  readonly grantedDataScopes: readonly ExtensionDataScope[];
  readonly policyDecisionId: string;
  readonly policyOutcome: 'allow';
  readonly input: Readonly<Record<string, unknown>>;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly recordedAt: string;
}

/**
 * The maximum invocation-context TTL the module will ever issue (the DB
 * CHECK in migration 028 fences the same bound). Short-lived by contract.
 */
export const MAX_INVOCATION_TTL_MS = 60 * 60 * 1000;

/** The module's default short-lived invocation TTL (5 minutes). */
export const DEFAULT_INVOCATION_TTL_MS = 5 * 60 * 1000;

/** Pure predicate: has the short-lived context expired at `atIso`? */
export function isInvocationContextExpired(
  record: Pick<ExtensionInvocationRecord, 'expiresAt'>,
  atIso: string,
): boolean {
  return Date.parse(atIso) >= Date.parse(record.expiresAt);
}

/**
 * Pure predicate: does the invocation context grant a data scope? The
 * scope kind must be granted AND the tenant must match the context's
 * canonical owner — an unrelated tenant's scope label is NEVER granted
 * (EXT-AC-02: invocation is scoped to granted Client/Workspace data only).
 */
export function invocationGrantsDataScope(
  context: Pick<
    ExtensionInvocationContext,
    'grantedDataScopes' | 'scope'
  >,
  requested: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly scope: ExtensionDataScope;
  },
): boolean {
  const tenantMatches =
    context.scope.agencyId === requested.agencyId &&
    context.scope.clientId === requested.clientId &&
    (requested.workspaceId === null || requested.workspaceId === context.scope.workspaceId);
  return tenantMatches && context.grantedDataScopes.includes(requested.scope);
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ExtensionsModuleApi {
  /**
   * PUBLISHES one extension version (the only registry creation path).
   * The manifest is validated against the full §2 shape guard —
   * capability categories, the closed permission vocabulary, logical
   * secret names, data-scope vocabulary and the §21 material-key
   * backstop (a manifest that fails shape/permission declaration is
   * REJECTED, EXT-AC-01). The (publisher, extensionKey, version) triple
   * is DB-fenced IMMUTABLE: re-registration of the same version is a
   * ConflictError; a new version is a new record. `actorId` and
   * `idempotencyKey` are server-derived provenance only.
   */
  registerExtensionVersion(input: {
    readonly manifest: ExtensionManifest;
    readonly actorId: string | null;
    readonly idempotencyKey: string;
  }): Promise<ExtensionRegistryRecord>;
  /** Raw registry row by id — immutable history is always readable. */
  getExtensionVersion(extensionId: string): Promise<ExtensionRegistryRecord | null>;
  /** Registry listing (optionally narrowed to one extension key), newest first. */
  listExtensionVersions(input: {
    readonly extensionKey: string | null;
  }): Promise<readonly ExtensionRegistryRecord[]>;

  /**
   * INSTALLS a published extension version against a canonical
   * Client/Workspace context. The scope is SERVER-SUPPLIED by the caller
   * (resolved from durable ownership state BEFORE authorize/execute — the
   * /credentials scope-as-data posture) and re-fenced by the migration-028
   * scope-chain triggers. `grantedScopes` must be a subset of the
   * manifest's declared data scopes (least-privilege — anything else is
   * an InvalidRequestError). The install is POLICY-GATED: the module
   * delegates an extension-dimension 'install' evaluation to the merged
   * /policies engine and FAILS CLOSED (PolicyDeniedError) unless the
   * decision is an explicit 'allow'. One install per
   * (workspace, extension version) — a duplicate logical install command
   * converges (replayed=true).
   */
  installExtension(input: {
    readonly scope: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string;
    };
    readonly extensionId: string;
    readonly grantedScopes: readonly ExtensionDataScope[];
    readonly idempotencyKey: string;
    readonly actorId: string | null;
  }, provenance: ExtensionInvocationProvenance): Promise<ExtensionInstallOutcome>;
  /** Raw install row by id (tombstones included). */
  getExtensionInstall(installId: string): Promise<ExtensionInstallRecord | null>;
  /** The installs of one Workspace in every state (terminal history stays visible), newest first. */
  listExtensionInstalls(workspaceId: string): Promise<readonly ExtensionInstallRecord[]>;

  /**
   * CONFIGURES one install: validates configuration values against the
   * manifest's declared config contract (type/required/pattern per
   * field) and binds REQUIRED SECRET LOGICAL NAMES to credential
   * REFERENCES (each binding resolved through the /credentials public
   * contract: the reference must exist, be LIVE and belong to the
   * install's agency scope — client-narrowing respected; material is
   * NEVER touched). All requiredSecretNames must be bound. CAS-guarded
   * (expectedVersion); the target state is 'configured' (reconfigure is
   * the configured → configured | authorized → configured edge — a
   * reconfigured extension requires re-authorization before invocation).
   */
  configureExtension(input: {
    readonly installId: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly secretBindings: Readonly<Record<string, string>>;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<ExtensionInstallRecord>;

  /**
   * CAS lifecycle transition on the frozen EXTENSION_INSTALL_TRANSITIONS
   * table ('authorize' → authorized, 'disable' → disabled, 'uninstall' →
   * uninstalled — terminal tombstone). `uninstalled` is terminal and the
   * identifiers never replay back to life.
   */
  setExtensionInstallStatus(input: {
    readonly installId: string;
    readonly status: ExtensionInstallStatus;
    readonly expectedVersion: number;
    readonly actorId: string | null;
  }): Promise<ExtensionInstallRecord>;

  /**
   * DERIVES the short-lived invocation context (implementation-contract
   * §19: ExtensionId + Version + ExecutionId + GrantedCapabilitySet +
   * InputContract). Fail-closed pipeline, every step server-derived:
   *   1. the EXECUTION is resolved through the /executions public
   *      contract (unknown/foreign → uniform NotFoundError) and must be
   *      an extension-kind, non-terminal execution;
   *   2. the install is resolved for (execution workspace, extension
   *      version) and must be AUTHORIZED (everything else fails closed);
   *   3. requestedCapabilities must be a subset of the manifest's
   *      declared capabilities (undeclared-capability invocation is
   *      rejected);
   *   4. the invocation input must satisfy the manifest input contract's
   *      required keys and carry no material-shaped or authority-shaped
   *      key (§21 + §3);
   *   5. the extension-dimension 'invoke' boundary is evaluated through
   *      the merged /policies engine — ONLY an explicit 'allow' proceeds
   *      (deny/unknown/error → PolicyDeniedError; the decision is
   *      recorded append-only by /policies);
   *   6. the context is composed with the granted scopes and recorded in
   *      the append-only invocation ledger (Observe) — never as a
   *      credential.
   * The tenant scope in the returned context is the EXECUTION's canonical
   * owner: a caller can never select, widen or assert it.
   */
  beginExtensionInvocation(input: {
    readonly executionId: string;
    readonly extensionId: string;
    readonly requestedCapabilities: readonly string[];
    readonly input: Readonly<Record<string, unknown>>;
  }, provenance: ExtensionInvocationProvenance): Promise<ExtensionInvocationContext>;

  /** Raw invocation ledger row by id (append-only history is always readable). */
  getExtensionInvocation(invocationId: string): Promise<ExtensionInvocationRecord | null>;
  /** The invocation ledger of one Workspace, newest first (Observe). */
  listExtensionInvocations(workspaceId: string): Promise<readonly ExtensionInvocationRecord[]>;
}

export interface ExtensionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix (/extensions ──→ /executions): the canonical Execution
   * authority — invocation resolves the execution's canonical ownership
   * (agency/client/workspace) THROUGH this contract before anything else.
   */
  readonly executions: ExecutionsModuleApi;
  /**
   * Frozen matrix (/extensions ──→ /policies): the merged execution
   * policy engine — install and invoke gate on the extension-dimension
   * boundary (fail-closed: only an explicit 'allow' proceeds).
   */
  readonly policies: PoliciesModuleApi;
  /**
   * Frozen matrix (/extensions ──→ /credentials): credential REFERENCE
   * resolution for configure-time secret bindings (references only —
   * material is never resolved or stored here).
   */
  readonly credentials: CredentialsModuleApi;
}

export { createExtensionsModule } from './internal/module.ts';
/**
 * The input guards (manifest shape/permission declaration validation,
 * install/config/invocation input validation + the §21 material-key
 * backstop) and the pure composition helpers — exported for unit tests
 * and future server-side callers (the sandbox host Work Items) so the
 * guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidExtensionManifest,
  assertValidExtensionInstallInput,
  assertValidExtensionConfigureInput,
  assertValidExtensionInvocationInput,
  assertValidInvocationProvenance,
  validateConfigAgainstContract,
  validateInvocationInputAgainstContract,
  requiredKeysOfContract,
  extensionCreateFingerprint,
  composeInvocationContext,
} from './internal/store.ts';
