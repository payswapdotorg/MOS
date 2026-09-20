/**
 * MarketingOS module: /social-accounts
 * Authority: Social Account and OAuth Connection Model (MKT-055 —
 * spec/effective-backlog-v1.6.md; spec/architecture-v1.6.md §4: "Social
 * accounts are external account identities attached to a Client/Workspace
 * through an authorized integration"; spec/architecture-lock-v1.6.md
 * rules #18 (each platform behind the provider-neutral Integration
 * contract), #19 (capability parity never assumed) and #28
 * (social-account authorization, product/source access, store access and
 * other credentials remain SEPARATE least-privilege grants)).
 *
 * This module owns:
 *
 *   - the ACCOUNT IDENTITY BINDING records (migration 046): one external
 *     account identity — platform id (the OPAQUE provider identifier
 *     carried from the integration connection's adapter key), external
 *     account id, display identity, verified-at — attached to a Client
 *     (agency derived SERVER-SIDE through the integration connection's
 *     own owning chain) and an OPTIONAL Workspace, THROUGH an EXISTING
 *     authorized Integration connection (the canonical integration
 *     reference is READ-ONLY: the binding can never be moved to another
 *     connection, and no integration row is ever mutated from here);
 *   - the OAUTH AUTHORIZATION-GRANT lifecycle (the connect-flow states
 *     pending → authorized → expired/revoked/refreshed/superseded): each
 *     grant records the credential-vault REFERENCE of its token set and
 *     the successor link; refresh and reauthorize are NEW grant records +
 *     history events (append-only), never in-place rewrites of recorded
 *     authorization facts;
 *   - the EXACT granted scope list recorded VERBATIM plus the
 *     platform-normalized CAPABILITY TAGS (the scope records of migration
 *     046) — a faithful RECORD of what the platform granted, never an
 *     assumption of parity (lock rule 19): the module never interprets,
 *     expands or compares capability tags; it records them;
 *   - the APPEND-ONLY authorization-grant/history tail (every lifecycle
 *     event with SERVER-DERIVED provenance and the operator |
 *     external-signal initiation source);
 *   - the FAIL-CLOSED death semantics (MKT-055 AC-5): disconnect and
 *     revocation — both operator-initiated and externally-signalled —
 *     leave the connection UNUSABLE; every authorization read of a
 *     disconnected/revoked connection refuses; replaced grants' vault
 *     references are DISABLED through the /credentials public contract
 *     (no zombie grants).
 *
 * What this module deliberately does NOT do (MKT-056+ scope — the
 * adapter contract and the platform adapters are LATER work items):
 *   - it defines the provider-neutral OAuth flow CONTRACT (the flow port
 *     below) but ships NO flow implementation: real platform OAuth
 *     endpoints are not callable from the delivery sandbox, and the
 *     integration tests exercise the connection model through a LOCAL
 *     provider double served from the test process (a disclosed test
 *     double at the provider boundary ONLY — the connection model under
 *     test is fully real). Flow implementations arrive as DATA through
 *     the module dependencies (the MKT-023 adapter-registry precedent)
 *     and are EMPTY in the production composition until the MKT-056+
 *     adapter deliveries wire real ones;
 *   - NO platform-specific knowledge lives in this module: the platform
 *     identity is the integration connection's adapter key carried as
 *     data, the OAuth protocol shapes are provider-neutral, and a static
 *     boundary test proves no platform-specific strings/logic exist in
 *     src/ outside test doubles (lock rule 18);
 *   - NO secret material ever enters this module's tables (§21): tokens
 *     are provisioned into the platform secret backend BY THE FLOW
 *     IMPLEMENTATION (the provider boundary) and reach this module only
 *     as an OPAQUE handle, which is immediately turned into a
 *     /credentials vault REFERENCE (the MKT-021 house discipline — the
 *     model stores the reference + the grant metadata only). Material
 *     resolves ONLY through the /credentials authorized-execution path,
 *     in-process, after fail-closed /policies allows (the integrations
 *     resolveCallMaterial precedent);
 *   - the grant is its OWN least-privilege credential reference (kind
 *     'social_account_oauth' — never shared with product/source/store
 *     credentials; lock rule 28): this module confers NO product, source
 *     or store access — it has no such surface at all;
 *   - NO capability discovery, publishing, analytics or distribution
 *     surface: the capability tags are recorded facts, and their
 *     interpretation belongs to the future adapter contract (MKT-056).
 *
 * DEPENDENCY POSTURE (frozen matrix: /social-accounts ──→ /integrations,
 * /credentials, /policies, /workspaces): this public entry imports the
 * /integrations, /credentials and /policies public contracts DIRECTLY
 * (the only matrix-allowed module dependencies); the REQUIRED canonical
 * Workspace ownership resolution arrives through a declared STRUCTURAL
 * PORT (the /app-installs precedent — the real WorkspacesModuleApi
 * instance satisfies it at the composition root while the frozen import
 * list stays minimal). The canonical Client ownership chain is resolved
 * THROUGH the /integrations public contract's own
 * resolveConnectionOwnership (the integration connection owns the
 * canonical chain — this module never re-derives tenants from caller
 * input).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { CredentialsModuleApi } from '../credentials/public.ts';
import type { IntegrationsModuleApi } from '../integrations/public.ts';
import type {
  IntegrationsClientOwnershipSnapshot,
  IntegrationsConnectionOwnerContext,
} from '../integrations/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// The frozen lifecycle vocabularies (MKT-055 AC-2/AC-5 — CHECK-fenced in
// migration 046; pinned by unit tests)
// ---------------------------------------------------------------------------

/**
 * The frozen ACCOUNT BINDING lifecycle. `connected` is the born state;
 * `disconnected` (the operator-initiated removal) and `revoked` (the
 * externally-signalled or operator-recorded authorization revocation) are
 * BOTH TERMINAL — a dead binding can never be re-activated in place
 * (MKT-055 AC-5). Re-connecting the same external account under the same
 * integration is the NEW-RECORD path: a fresh binding row + a fresh
 * authorization cycle.
 */
export type SocialAccountStatus = 'connected' | 'disconnected' | 'revoked';

export const SOCIAL_ACCOUNT_STATUSES: readonly SocialAccountStatus[] = [
  'connected',
  'disconnected',
  'revoked',
];

/** The frozen account transition table: connected → disconnected | revoked. */
export const SOCIAL_ACCOUNT_TRANSITIONS: Readonly<
  Record<SocialAccountStatus, readonly SocialAccountStatus[]>
> = {
  connected: ['disconnected', 'revoked'],
  disconnected: [],
  revoked: [],
};

export function isLegalSocialAccountTransition(
  from: SocialAccountStatus,
  to: SocialAccountStatus,
): boolean {
  return SOCIAL_ACCOUNT_TRANSITIONS[from].includes(to);
}

/**
 * The frozen AUTHORIZATION-GRANT lifecycle (MKT-055 AC-2): `pending` is
 * born at authorize-start; the single completion fill moves it to
 * `authorized`; `expired` (token expiry observed/signalled), `revoked`
 * (operator or external signal), `refreshed` and `superseded` (replaced
 * by a successor grant) follow. `revoked`, `refreshed` and `superseded`
 * are TERMINAL. Refresh and reauthorize transitions are NEW records +
 * history events — never in-place rewrites of the recorded facts.
 */
export type SocialGrantState =
  | 'pending'
  | 'authorized'
  | 'expired'
  | 'revoked'
  | 'refreshed'
  | 'superseded';

export const SOCIAL_GRANT_STATES: readonly SocialGrantState[] = [
  'pending',
  'authorized',
  'expired',
  'revoked',
  'refreshed',
  'superseded',
];

/** The frozen grant transition table (the migration-046 trigger mirror). */
export const SOCIAL_GRANT_TRANSITIONS: Readonly<
  Record<SocialGrantState, readonly SocialGrantState[]>
> = {
  pending: ['authorized', 'expired', 'revoked'],
  authorized: ['expired', 'revoked', 'refreshed', 'superseded'],
  expired: ['refreshed', 'superseded', 'revoked'],
  revoked: [],
  refreshed: [],
  superseded: [],
};

export function isLegalSocialGrantTransition(
  from: SocialGrantState,
  to: SocialGrantState,
): boolean {
  return SOCIAL_GRANT_TRANSITIONS[from].includes(to);
}

/**
 * The frozen scope-record vocabulary: the EXACT granted scope list is
 * recorded VERBATIM ('granted-scope', order preserved) and the
 * platform-normalized capability tags ride as 'capability-tag' records —
 * a faithful RECORD of what the platform granted, never an assumption of
 * parity (lock rule 19).
 */
export type SocialGrantScopeKind = 'granted-scope' | 'capability-tag';

export const SOCIAL_GRANT_SCOPE_KINDS: readonly SocialGrantScopeKind[] = [
  'granted-scope',
  'capability-tag',
];

/**
 * The credential kind of every social-account OAuth token reference: the
 * grant's OWN least-privilege vault reference (lock rule 28 — never
 * shared with product/source/store credentials, which carry their own
 * kinds through their own authorities).
 */
export const SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND = 'social_account_oauth' as const;

/**
 * True when the grant state admits a REFRESH or REAUTHORIZE cycle: an
 * authorized grant (the normal case) or an expired one (the refresh-token
 * recovery path). Pending/revoked/refreshed/superseded grants never
 * refresh — fail-closed.
 */
export function isGrantRefreshable(state: SocialGrantState): boolean {
  return state === 'authorized' || state === 'expired';
}

// ---------------------------------------------------------------------------
// Records (the durable shapes of migration 046)
// ---------------------------------------------------------------------------

/**
 * One ACCOUNT IDENTITY BINDING record: the external identity attached
 * through an EXISTING authorized integration connection. The agency is
 * derived SERVER-SIDE through the connection's own owning chain; the
 * platform id is the connection's adapter key carried as data; the
 * external identity is the provider's own, recorded verbatim. The record
 * carries NO token material of any kind (§21).
 */
export interface SocialAccountRecord {
  readonly socialAccountId: string;
  readonly integrationConnectionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly platformId: string;
  readonly externalAccountId: string;
  readonly displayIdentity: string;
  readonly verifiedAt: string | null;
  readonly status: SocialAccountStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One AUTHORIZATION-GRANT record (the append-oriented grant of migration
 * 046). `socialAccountId` is null while a FRESH round is pending (the
 * external identity is unknown until the callback) and pre-set on
 * REAUTHORIZE rounds. The recorded authorization facts (account binding,
 * credential vault reference, expiry, completion provenance) are immutable
 * after the single completion fill.
 */
export interface SocialGrantRecord {
  readonly grantId: string;
  readonly integrationConnectionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  /** The optional Workspace narrowing chosen at authorize-start (carried to the binding at completion). */
  readonly workspaceId: string | null;
  readonly socialAccountId: string | null;
  readonly platformId: string;
  readonly grantState: SocialGrantState;
  readonly stateToken: string;
  readonly requestedScopes: readonly string[] | null;
  readonly credentialReferenceId: string | null;
  readonly expiresAt: string | null;
  readonly successorGrantId: string | null;
  readonly completedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The scope records of one grant: the EXACT granted scope list VERBATIM
 * (order preserved) and the platform-normalized capability tags — the
 * faithful record of what the platform granted (lock rule 19).
 */
export interface SocialGrantScopeFacts {
  readonly grantedScopes: readonly string[];
  readonly capabilityTags: readonly string[];
}

/** The frozen history-event vocabulary (CHECK-fenced in migration 046). */
export type SocialAccountEventType =
  | 'authorization_started'
  | 'authorization_completed'
  | 'authorization_expired'
  | 'authorization_revoked'
  | 'grant_refreshed'
  | 'grant_superseded'
  | 'account_disconnected'
  | 'account_revoked';

export const SOCIAL_ACCOUNT_EVENT_TYPES: readonly SocialAccountEventType[] = [
  'authorization_started',
  'authorization_completed',
  'authorization_expired',
  'authorization_revoked',
  'grant_refreshed',
  'grant_superseded',
  'account_disconnected',
  'account_revoked',
];

/**
 * One immutable row of the append-only authorization-grant/history tail
 * (migration 046): the lifecycle fact, the initiation source (operator |
 * external-signal), the bounded reason, the best-effort provider-side
 * revoke outcome (disclosure only) and the SERVER-DERIVED provenance.
 */
export interface SocialAccountEventRecord {
  readonly eventId: string;
  readonly socialAccountId: string | null;
  readonly grantId: string | null;
  readonly eventType: SocialAccountEventType;
  readonly initiatedBy: 'operator' | 'external-signal';
  readonly reason: string | null;
  readonly providerRevokeOutcome:
    | 'not-requested'
    | 'revoked'
    | 'skipped-policy-denied'
    | 'failed'
    | null;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The provider-neutral OAuth flow port (the MKT-056 adapter contract seed)
// ---------------------------------------------------------------------------

/**
 * The identity of one registered flow implementation. `adapterKey` is the
 * provider-neutral platform identity the flow serves (the SAME key the
 * /integrations adapter registry uses — lock rule 18: each platform
 * behind the provider-neutral Integration contract); the labels are
 * human-facing data.
 */
export interface SocialAccountFlowDescriptor {
  readonly adapterKey: string;
  readonly flowLabel: string;
  readonly description: string;
}

/**
 * The provider-neutral call context handed to a flow implementation:
 * identity and non-secret configuration ONLY — never credential material
 * (the refresh path hands the CURRENT token material to the flow
 * IN-PROCESS through a separate, explicit argument after a fail-closed
 * /policies allow, exactly like the /integrations adapter call context).
 */
export interface SocialAccountFlowCallContext {
  readonly connectionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly platformId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
}

/**
 * The external account identity as reported by the provider boundary —
 * recorded VERBATIM on the binding (never normalized, never a MOS
 * identity).
 */
export interface SocialAccountFlowIdentity {
  /** The opaque provider-side account identifier. */
  readonly externalAccountId: string;
  /** The display identity (handle/name) at authorization time. */
  readonly displayIdentity: string;
  /** The platform's own verification stamp, when reported. */
  readonly verifiedAt: string | null;
}

/**
 * The outcome of one provider-side exchange (code exchange or refresh):
 * the EXACT granted scope list VERBATIM, the platform-normalized
 * capability tags, the external account identity and the OPAQUE secret
 * handle under which the flow implementation provisioned the token
 * material into the platform secret backend. The handle is the ONLY
 * token-related value that ever reaches this module — and it is
 * immediately turned into a /credentials vault reference (fail-closed on
 * a handle that does not resolve).
 */
export interface SocialAccountFlowExchangeOutcome {
  readonly identity: SocialAccountFlowIdentity;
  /** The EXACT granted scope list, verbatim, order preserved (lock rule 19). */
  readonly grantedScopes: readonly string[];
  /** The platform-normalized capability tags (a RECORD, never parity). */
  readonly capabilityTags: readonly string[];
  /** The opaque backend handle of the provisioned token set. */
  readonly tokenSecretHandle: string;
  /** The platform-reported access-token expiry, when reported. */
  readonly expiresAt: string | null;
}

/**
 * THE PROVIDER-NEUTRAL OAUTH FLOW PORT (MKT-055 AC-7): the contract the
 * MKT-056+ adapter layer will implement per platform. This module
 * DEPENDS on the contract, never on an implementation — instances arrive
 * as DATA through the module dependencies (the MKT-023 adapter-registry
 * precedent), validated at construction (unique adapterKey), and the
 * registry is EMPTY in the production composition until the adapter
 * deliveries wire real flows (fail-closed: a flow step against a
 * platform with no registered flow is refused). The provider double of
 * the integration tests implements exactly this port.
 */
export interface SocialAccountFlowImplementation {
  readonly descriptor: SocialAccountFlowDescriptor;
  /** Builds the provider authorize URL of the round (the operator redirect target). */
  buildAuthorizeUrl(
    context: SocialAccountFlowCallContext,
    input: {
      readonly state: string;
      readonly requestedScopes: readonly string[] | null;
    },
  ): Promise<{ readonly authorizeUrl: string }>;
  /** Exchanges the OAuth authorization code for the token outcome. */
  exchangeAuthorizationCode(
    context: SocialAccountFlowCallContext,
    input: {
      readonly code: string;
      readonly state: string;
    },
  ): Promise<SocialAccountFlowExchangeOutcome>;
  /** Refreshes the authorization with the CURRENT token material (in-process only). */
  refreshAuthorization(
    context: SocialAccountFlowCallContext,
    input: {
      readonly currentTokenMaterial: Uint8Array;
    },
  ): Promise<SocialAccountFlowExchangeOutcome>;
  /**
   * Best-effort provider-side revocation (the disclosure outcome is
   * recorded on the event; the MOS-side fail-closed death happens
   * regardless). Never throws — failures return as data.
   */
  revokeAuthorization(
    context: SocialAccountFlowCallContext,
    input: {
      readonly currentTokenMaterial: Uint8Array;
    },
  ): Promise<{ readonly revoked: boolean; readonly message: string | null }>;
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every social-account mutation (the
 * /integrations IntegrationProvenance precedent): built exclusively from
 * the authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body. Route validation
 * rejects provenance-shaped authority fields; this type is a separate
 * module-API argument so no DTO can feed it structurally.
 */
export interface SocialAccountProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Structural ports (the frozen-matrix-compliant consumed public contracts)
// ---------------------------------------------------------------------------

/**
 * The narrow STRUCTURAL view of the /workspaces canonical owner context
 * (the /app-installs precedent): the resolved Workspace, its owning
 * Client and the owning Agency with their boundary statuses. The real
 * WorkspacesModuleApi satisfies this structurally — /workspaces remains
 * the ONLY Workspace ownership authority; the attachment scope chain is
 * always server-derived.
 */
export interface SocialAccountsWorkspaceOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'workspace';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string;
  };
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract this module depends on:
 * canonical server-side Workspace ownership resolution from durable
 * state. Satisfied structurally by WorkspacesModuleApi; wired at the
 * composition root.
 */
export interface SocialAccountsWorkspaceOwnershipPort {
  resolveWorkspaceOwnership(
    workspaceId: string,
  ): Promise<SocialAccountsWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// The canonical owner context (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL SOCIAL-ACCOUNT OWNER CONTEXT: the single server-side
 * resolution of WHICH Client owns the binding — composed from the
 * integration connection's own canonical owner context (the connection
 * owns the chain; this module never re-derives tenants from caller
 * input). Account-scoped operations authorize against this context —
 * never against caller-supplied tenant or connection identity.
 */
export interface SocialAccountOwnerContext {
  readonly scope: {
    readonly kind: 'social-account';
    readonly agencyId: string;
    readonly clientId: string;
    readonly socialAccountId: string;
  };
  readonly account: SocialAccountRecord;
  /** The canonical integration connection the binding is attached through (READ-ONLY reference). */
  readonly integrationConnection: IntegrationsConnectionOwnerContext['connection'];
  readonly clientOwnership: IntegrationsClientOwnershipSnapshot;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// The usable-authorization read (THE fail-closed consumer surface)
// ---------------------------------------------------------------------------

/**
 * The FAIL-CLOSED authorization read (MKT-055 AC-5 — the surface every
 * future consumer (the MKT-056+ adapters, distribution, analytics)
 * consumes): the account, the CURRENT authorized grant, the EXACT
 * granted scope list VERBATIM, the platform-normalized capability tags
 * and the credential-vault reference. NULL unless the account is
 * `connected`, the grant is `authorized` and the token expiry has not
 * passed (lazy expiry). A disconnected/revoked connection NEVER yields a
 * usable authorization — no zombie grants.
 */
export interface UsableSocialAuthorization {
  readonly account: SocialAccountRecord;
  readonly grant: SocialGrantRecord;
  readonly scopeFacts: SocialGrantScopeFacts;
  readonly credentialReferenceId: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface SocialAccountsModuleApi {
  /**
   * AUTHORITY-START of the OAuth connect flow (MKT-055 AC-2/AC-7):
   * validates the integration connection (must EXIST and be `connected`
   * — an authorized integration; a foreign/unknown connection or client
   * is the uniform 404; a non-connected pipe is a 409), validates the
   * OPTIONAL workspace narrowing through the /workspaces structural
   * port, resolves the flow implementation for the connection's platform
   * (a platform with no registered flow is refused fail-closed — 409),
   * appends the PENDING grant record (state token, requested scopes as
   * INTENT) + the authorization_started event, and returns the authorize
   * URL the operator's browser is redirected to. `expectedAccountId`
   * (the REAUTHORIZE entry point) pre-binds the round to a known
   * account identity.
   */
  startAuthorization(
    input: {
      readonly clientId: string;
      readonly integrationConnectionId: string;
      readonly workspaceId: string | null;
      readonly requestedScopes: readonly string[] | null;
      /** Pre-binds the round to an existing account (the reauthorize path). */
      readonly expectedAccountId: string | null;
    },
    provenance: SocialAccountProvenance,
  ): Promise<{
    readonly grant: SocialGrantRecord;
    readonly authorizeUrl: string;
  }>;

  /**
   * CALLBACK/COMPLETE of the OAuth connect flow (MKT-055 AC-2/AC-4/AC-7):
   * correlates the round by the OPAQUE state token (a consumed, unknown
   * or foreign state is the uniform 404), fail-closed policy gates the
   * provider egress, the flow implementation exchanges the code and
   * returns the verbatim grant facts, the module creates the
   * credential-vault REFERENCE through the /credentials public contract
   * (a dangling handle is REJECTED — no orphan references), completes
   * the pending grant with the single fill, and binds the account
   * identity:
   *   - a FRESH external identity on an unbound connection creates the
   *     binding (born connected);
   *   - re-connecting the SAME external account under the SAME
   *     integration is IDEMPOTENT: the existing binding is reused, the
   *     current grant is superseded (its vault reference disabled) and
   *     the new grant becomes the single authorized one — no duplicate
   *     active binding;
   *   - a CONFLICTING binding (a different external identity on a bound
   *     connection, or the same external identity on another connection
   *     of the same client) is REJECTED fail-closed (409; the
   *     migration-046 partial unique fences back the race).
   */
  completeAuthorization(
    input: {
      /** The client scope of the round (a round of ANOTHER client is never reachable — uniform 404). */
      readonly clientId: string;
      readonly state: string;
      readonly code: string;
    },
    provenance: SocialAccountProvenance,
  ): Promise<{
    readonly account: SocialAccountRecord;
    readonly grant: SocialGrantRecord;
    readonly scopeFacts: SocialGrantScopeFacts;
  }>;

  /**
   * REFRESH (MKT-055 AC-2): resolves the account's CURRENT grant
   * (authorized or expired — a pending/revoked/refreshed/superseded
   * grant never refreshes; a disconnected/revoked account never
   * refreshes — fail-closed), fail-closed policy gates the provider
   * egress and the credential use, resolves the CURRENT token material
   * through the /credentials authorized-execution path (IN-PROCESS
   * ONLY), hands it to the flow implementation, and appends the
   * successor grant (born authorized, its OWN new vault reference and
   * verbatim scope records) while the old grant moves to `refreshed`
   * with the successor link and its vault reference is DISABLED — a new
   * record/history event, never an in-place rewrite.
   */
  refreshAuthorization(
    input: {
      readonly socialAccountId: string;
    },
    provenance: SocialAccountProvenance,
  ): Promise<{
    readonly account: SocialAccountRecord;
    readonly grant: SocialGrantRecord;
    readonly scopeFacts: SocialGrantScopeFacts;
  }>;

  /**
   * The EXPLICIT expiry observation (the authorized → expired state move;
   * server-side callers observe provider token errors and record them —
   * the future adapter host, tests, background workers). The read paths
   * ALSO refuse lazily on expired-by-time grants, so this is the recorded
   * observation, not the enforcement.
   */
  expireAuthorizationGrant(
    input: {
      readonly grantId: string;
      readonly reason: string | null;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialGrantRecord>;

  /**
   * DISCONNECT (MKT-055 AC-5, operator-initiated): the connection
   * becomes UNUSABLE — the binding moves to `disconnected` (TERMINAL),
   * every live grant is revoked with the disconnected event, and the
   * live grants' vault references are DISABLED through /credentials (no
   * zombie grants). The optional best-effort provider-side revocation
   * (policy-gated, in-process material) is recorded as disclosure on the
   * event — the MOS-side death happens regardless of the provider
   * outcome. The account and event HISTORY stays readable (audit);
   * every authorization-bearing read refuses from here on.
   */
  disconnectAccount(
    input: {
      readonly socialAccountId: string;
      readonly reason: string | null;
      readonly revokeAtProvider: boolean;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialAccountRecord>;

  /**
   * EXTERNALLY-SIGNALLED REVOCATION (MKT-055 AC-5): records the
   * provider/platform-side revocation signal — the binding moves to
   * `revoked` (TERMINAL), every live grant is revoked with the
   * external-signal event, and the vault references are DISABLED. The
   * failure modes are identical to disconnect: the connection is
   * UNUSABLE and no zombie grants remain.
   */
  recordExternalRevocation(
    input: {
      readonly socialAccountId: string;
      readonly reason: string | null;
      readonly signalledVia: string;
    },
    provenance: SocialAccountProvenance,
  ): Promise<SocialAccountRecord>;

  /**
   * THE FAIL-CLOSED AUTHORIZATION READ (MKT-055 AC-5 — the consumer
   * surface): the account + current authorized grant + verbatim scope
   * records + capability tags + the credential-vault reference, or NULL
   * when the account is disconnected/revoked, no authorized grant
   * exists, or the grant's token expiry has passed (lazy expiry). A
   * dead connection NEVER yields a usable authorization.
   */
  getUsableAuthorization(
    socialAccountId: string,
  ): Promise<UsableSocialAuthorization | null>;

  /** Raw binding by id (any status — the status is the visible fact). */
  getSocialAccount(socialAccountId: string): Promise<SocialAccountRecord | null>;

  /**
   * Canonical ownership resolution: the binding + its integration
   * connection + the /clients ownership chain composed into the owner
   * context. Null when the binding does not exist, its connection does
   * not resolve, or the chain does not compose — callers surface the
   * uniform 404 (no existence oracle).
   */
  resolveAccountOwnership(
    socialAccountId: string,
  ): Promise<SocialAccountOwnerContext | null>;

  /** The Client's bindings (bounded, newest first). Unknown Client → 404. */
  listSocialAccountsForClient(clientId: string): Promise<readonly SocialAccountRecord[]>;

  /** The Workspace's bindings (bounded, newest first). Unknown Workspace → 404. */
  listSocialAccountsForWorkspace(workspaceId: string): Promise<readonly SocialAccountRecord[]>;

  /**
   * Raw grant by id — REFUSES (ConflictError) when the owning account is
   * disconnected/revoked or the grant itself is revoked (MKT-055 AC-5:
   * every read of a disconnected/revoked connection's grant refuses; the
   * grant row carries the credential reference, so a dead connection
   * exposes no authorization facts). History that carries no
   * authorization payload remains readable through the event tail.
   */
  getAuthorizationGrant(grantId: string): Promise<SocialGrantRecord>;

  /**
   * The account's grant tail (the authorization history) — the same
   * refusal contract as getAuthorizationGrant (ConflictError when the
   * account is disconnected/revoked).
   */
  listAuthorizationGrantsForAccount(socialAccountId: string): Promise<readonly SocialGrantRecord[]>;

  /** The append-only history tail of one account (always readable — audit). */
  listAccountEvents(socialAccountId: string): Promise<readonly SocialAccountEventRecord[]>;

  /**
   * The scope records of one grant (the EXACT verbatim granted scope
   * list + the capability tags) — the same refusal contract as
   * getAuthorizationGrant.
   */
  getAuthorizationGrantScopeFacts(grantId: string): Promise<SocialGrantScopeFacts>;
}

export interface SocialAccountsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Matrix-listed direction (/social-accounts ──→ /integrations): the
   * provider-neutral Integration authority — the connection lifecycle
   * surface the bindings attach THROUGH (canonical connection ownership
   * resolution + the connection records). Consumed READ-ONLY through the
   * public contract; no integration row is ever mutated from here.
   */
  readonly integrations: IntegrationsModuleApi;
  /**
   * Matrix-listed direction (/social-accounts ──→ /credentials): the
   * credential vault authority — the token references are created,
   * validated, resolved (authorized-execution scope, in-process only,
   * after a policy allow) and DISABLED through this public contract.
   * Lock rule 28: the social-account grant is its OWN least-privilege
   * reference; it confers no product/source/store access.
   */
  readonly credentials: CredentialsModuleApi;
  /**
   * Matrix-listed direction (/social-accounts ──→ /policies): the
   * fail-closed decision engine consulted BEFORE every provider-touching
   * flow step (network egress) and every credential use (secrets
   * dimension). Only explicit allows proceed (enforcementOutcome).
   */
  readonly policies: PoliciesModuleApi;
  /**
   * Matrix-listed direction (/social-accounts ──→ /workspaces), consumed
   * through the narrow canonical-ownership STRUCTURAL PORT (the
   * /app-installs precedent — satisfied structurally by the real
   * WorkspacesModuleApi instance at the composition root).
   */
  readonly workspaceOwnership: SocialAccountsWorkspaceOwnershipPort;
  /**
   * THE PROVIDER-NEUTRAL FLOW REGISTRATION SURFACE: flow implementations
   * as DATA (the MKT-023 adapter-registry precedent). Validated at
   * construction (unique adapterKey, legal descriptor shape). EMPTY in
   * the production composition until the MKT-056+ adapter deliveries
   * wire real flows — a flow step against a platform with no registered
   * flow is refused fail-closed. The integration tests supply the
   * disclosed LOCAL provider double here.
   */
  readonly flows: readonly SocialAccountFlowImplementation[];
}

export { createSocialAccountsModule } from './internal/module.ts';
/**
 * The input guards (flow-descriptor validation, requested-scope and
 * provenance validation with the §21 material-key backstop), the pure
 * lifecycle helpers, the provenance-structuring composers, the flow
 * registry builder and the write-conflict classification — exported for
 * unit tests and future server-side callers so the guard semantics are
 * part of the module contract. Pure functions.
 */
export {
  type SocialAccountEventInsert,
  MAX_EVENT_REASON_LENGTH,
  SOCIAL_ACCOUNT_EVENT_TYPE_VOCABULARY,
  SOCIAL_ACCOUNT_STATUS_VOCABULARY,
  SOCIAL_GRANT_SCOPE_KIND_VOCABULARY,
  SOCIAL_GRANT_STATE_VOCABULARY,
  assertValidCapabilityTagList,
  assertValidExpiresAt,
  assertValidFlowIdentity,
  assertValidFlowRegistration,
  assertValidGrantedScopeList,
  assertValidProvenance,
  assertValidReason,
  assertValidRequestedScopes,
  assertValidTokenSecretHandle,
  buildFlowRegistry,
  classifySocialWriteConflict,
  composeExternalRevocationReason,
  composeGrantStartEvent,
  composeGrantCompletedEvent,
  composeSocialAccountEvent,
  composeSocialAccountOwnerContext,
} from './internal/grant-validation.ts';
