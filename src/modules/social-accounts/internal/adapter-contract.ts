/**
 * MKT-056 — the NORMALIZED SOCIAL PLATFORM ADAPTER CONTRACT of
 * /social-accounts (spec/effective-backlog-v1.6.md MKT-056: "formalize
 * per-platform capability matrix and normalized social account/content/
 * analytics/publish operations"; spec/architecture-v1.6.md §4: "Platform
 * adapters remain independent. A normalized MOS contract describes the
 * semantic capability; platform-specific rules remain inside the adapter.
 * The contract MUST allow a platform to expose a subset of capabilities.
 * The UI and planner cannot assume parity"; spec/architecture-lock-v1.6.md
 * rules #18 (each platform behind the provider-neutral Integration
 * contract), #19 (capability parity never assumed) and #37 ("Any future
 * platform adapter must declare its current capability matrix,
 * authorization constraints, policy dependencies and limitations before
 * acceptance"); spec/module-dependency-matrix-v1.6.md boundary rules 1/2:
 * social adapters are concrete provider implementations importable ONLY
 * by the composition root; domain/application modules consume
 * platform-neutral Social capability contracts, never a provider SDK).
 *
 * This file is the PROVIDER-NEUTRAL normalized vocabulary + the PURE
 * registration/scope guards of the social capability surface (the
 * MKT-071 commerce-normalization precedent: pure vocabulary + mapping
 * semantics living under internal/, re-exported through the module PUBLIC
 * entry so they are part of the TESTED module contract, and the sanctioned
 * import surface for the concrete platform adapters of MKT-057..061 is
 * internal/adapters/adapter-contract.ts — the re-export shim).
 *
 * WHAT IS NORMALIZED HERE (and what deliberately is NOT):
 *   - the CAPABILITY FAMILIES (the frozen five of the dispatch: account /
 *     content-read / analytics-read / publish / restriction-signals) and
 *     the CLOSED per-family OPERATION vocabularies. A platform declares a
 *     SUBSET — a capability-subset adapter is FIRST-CLASS (lock rule 19);
 *     unknown capability keys and operations outside a declared family
 *     FAIL CLOSED (registration refuses loudly; runtime operations
 *     surface the 'unsupported-capability' failure with ZERO provider
 *     traffic);
 *   - the ERROR TAXONOMY (auth-expired / rate-limited / restricted /
 *     policy-denied / provider-unavailable + the two fail-closed
 *     pre-flight refusals unsupported-capability / insufficient-scope):
 *     every normalized operation returns invocation failures as DATA
 *     (ok=false + failure), never thrown exceptions — the adapter
 *     taxonomy of the dispatch, CHECK-fenced where outcomes are stored
 *     (migration 050);
 *   - the NORMALIZED OPERATION SHAPES: account identity binding (the
 *     provider's current identity facts over the bound grant), content
 *     discovery/reads (paged, engagement observations NULLABLE — never
 *     fabricated), analytics reads (observed metric points, provider
 *     labels verbatim), the publish lifecycle (submit → accepted →
 *     published/failed/restricted with provider refs, host-side
 *     idempotency fence) and the status/restriction signals (ONLY what
 *     the provider exposes — architecture-v1.6.md §11: hidden moderation
 *     state is never invented);
 *   - the SCOPE CONVENTION: each capability declares the provider scopes
 *     its operations require; the host pre-checks them against the
 *     MKT-055 grant's EXACT VERBATIM granted-scope list (stricter than
 *     the commerce precedent — the social grant ALWAYS records a list,
 *     and a required scope missing from it refuses fail-closed BEFORE
 *     any policy evaluation or provider traffic);
 *   - the RATE-LIMIT OBSERVATION surface (the NormalizedRateLimit shape
 *     of the /integrations precedent): adapters report the observable
 *     quota/limit signals of each call as data. POLICY ENFORCEMENT STAYS
 *     IN /policies — the host consults the fail-closed engine BEFORE
 *     every provider-touching operation and only an explicit allow
 *     proceeds; observations are records, never decisions;
 *   - the ADAPTER PORT a concrete platform adapter (MKT-057..061)
 *     implements, including the account/session handling over the
 *     social-accounts credentials (the call context carries the bound
 *     external identity, the VERBATIM grant scopes, the capability tags,
 *     the non-secret provider config and the credential MATERIAL resolved
 *     in-process only, after the fail-closed policy allows — §21).
 *
 * INVARIANTS (the frozen boundaries):
 *   - NO platform-specific knowledge anywhere in this file or the module
 *     core: the platform identity is the integration connection's adapter
 *     key carried as DATA; the concrete adapters (the MKT-057..061
 *     platform implementations) live exclusively under
 *     internal/adapters/<platform>/ and are imported ONLY by the
 *     composition root (CONCRETE_ADAPTER_ACCESS);
 *   - NO provider SDK may be imported by this contract or any adapter
 *     (the /integrations INT-001 discipline; tools/arch-check
 *     EXTERNAL_PACKAGE_IN_SRC);
 *   - adapters return invocation failures as DATA; only malformed INPUT
 *     throws (InvalidRequestError, fail-closed by rejection);
 *   - every normalized shape is bounded and carries NO material-shaped
 *     key at any nesting level (the §21 backstops run on the publish
 *     request/attribution/passthrough guards below and on the durable
 *     writes of migration 050);
 *   - attribution rides VERBATIM as PASSTHROUGH data (architecture-v1.6
 *   §16) — recorded, never linked, matched or causally interpreted
 *   (MKT-073 owns attribution later).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { SocialAccountFlowIdentity } from '../public.ts';

// ---------------------------------------------------------------------------
// The capability families + the closed operation vocabularies (MKT-056 AC-1)
// ---------------------------------------------------------------------------

/**
 * The frozen five CAPABILITY FAMILIES of the social capability plane (the
 * dispatch vocabulary; architecture-v1.6.md §4 lists the richer
 * per-platform surface — public content discovery, own-content reads,
 * audience/analytics reads, publish, scheduling, media upload, status
 * polling, webhooks/events, restrictions/eligibility signals, comments —
 * which map onto these families as OPERATION subsets declared per
 * platform). A platform adapter declares a SUBSET of families; the
 * UI and planner can never assume parity (lock rule 19).
 */
export type SocialCapabilityFamily =
  | 'account'
  | 'content-read'
  | 'analytics-read'
  | 'publish'
  | 'restriction-signals';

export const SOCIAL_CAPABILITY_FAMILIES: readonly SocialCapabilityFamily[] = [
  'account',
  'content-read',
  'analytics-read',
  'publish',
  'restriction-signals',
];

/**
 * The closed OPERATION vocabulary of the account family: the provider's
 * current identity facts over the bound grant (the binding re-verification)
 * and the account profile read (identity + observable audience facts).
 */
export const SOCIAL_ACCOUNT_OPERATIONS = ['verifyAccountIdentity', 'getAccountProfile'] as const;

/**
 * The closed OPERATION vocabulary of the content-read family: public
 * content discovery WHERE PERMITTED, the bound account's own content
 * listing and the single-content read.
 */
export const SOCIAL_CONTENT_READ_OPERATIONS = [
  'discoverPublicContent',
  'listOwnContent',
  'getContent',
] as const;

/**
 * The closed OPERATION vocabulary of the analytics-read family: the
 * account-level and the per-content analytics reads (observed metric
 * points only — never fabricated, never interpreted).
 */
export const SOCIAL_ANALYTICS_READ_OPERATIONS = ['readAccountAnalytics', 'readContentAnalytics'] as const;

/**
 * The closed OPERATION vocabulary of the publish family: the submit (the
 * host-side idempotency fence applies) and the provider-side publish
 * status read (the poll). A synchronous publisher may declare submit
 * alone; an async publisher declares both.
 */
export const SOCIAL_PUBLISH_OPERATIONS = ['submitPublish', 'getPublishStatus'] as const;

/**
 * The closed OPERATION vocabulary of the restriction-signals family: the
 * observable restriction/eligibility/status signals the provider EXPOSES
 * (platform-confirmed restrictions only — architecture-v1.6.md §11).
 */
export const SOCIAL_RESTRICTION_SIGNAL_OPERATIONS = ['readRestrictionSignals'] as const;

export type SocialOperationKey =
  | (typeof SOCIAL_ACCOUNT_OPERATIONS)[number]
  | (typeof SOCIAL_CONTENT_READ_OPERATIONS)[number]
  | (typeof SOCIAL_ANALYTICS_READ_OPERATIONS)[number]
  | (typeof SOCIAL_PUBLISH_OPERATIONS)[number]
  | (typeof SOCIAL_RESTRICTION_SIGNAL_OPERATIONS)[number];

/** Every operation key of the closed vocabulary (the union, for guards). */
export const SOCIAL_OPERATION_KEYS: readonly SocialOperationKey[] = [
  ...SOCIAL_ACCOUNT_OPERATIONS,
  ...SOCIAL_CONTENT_READ_OPERATIONS,
  ...SOCIAL_ANALYTICS_READ_OPERATIONS,
  ...SOCIAL_PUBLISH_OPERATIONS,
  ...SOCIAL_RESTRICTION_SIGNAL_OPERATIONS,
];

/** The family→operations table (pure data — the single source of truth). */
export const SOCIAL_FAMILY_OPERATIONS: Readonly<
  Record<SocialCapabilityFamily, readonly SocialOperationKey[]>
> = {
  account: SOCIAL_ACCOUNT_OPERATIONS,
  'content-read': SOCIAL_CONTENT_READ_OPERATIONS,
  'analytics-read': SOCIAL_ANALYTICS_READ_OPERATIONS,
  publish: SOCIAL_PUBLISH_OPERATIONS,
  'restriction-signals': SOCIAL_RESTRICTION_SIGNAL_OPERATIONS,
};

/**
 * The owning family of an operation key (pure lookup); null for a key
 * outside the closed vocabulary.
 */
export function socialOperationFamilyOf(operation: string): SocialCapabilityFamily | null {
  for (const family of SOCIAL_CAPABILITY_FAMILIES) {
    if ((SOCIAL_FAMILY_OPERATIONS[family] as readonly string[]).includes(operation)) {
      return family;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The error taxonomy (MKT-056 — the frozen failure vocabulary)
// ---------------------------------------------------------------------------

/**
 * The closed FAILURE CODE vocabulary of the normalized social operations
 * (the dispatch taxonomy: auth-expired / rate-limited / restricted /
 * policy-denied / provider-unavailable, PLUS the two fail-closed HOST
 * pre-flight refusals). CHECK-fenced on the migration-050 publish ledger
 * (failure_code) — adding a code is a schema change, never a runtime
 * value.
 *
 *   auth-expired            — the authorization is unusable: the provider
 *                             signalled invalid/expired credentials OR the
 *                             host observed no usable MKT-055 grant (lazy
 *                             expiry / a dead vault reference). The
 *                             recovery is REAUTHORIZATION, never retry;
 *   rate-limited            — the provider quota/backoff was observed
 *                             (retryable; carries the observation);
 *   restricted              — the provider signalled a restriction or
 *                             eligibility block on the account/content
 *                             (carries the observable restriction
 *                             signals; NEVER invented — §11);
 *   policy-denied           — the MOS /policies engine REFUSED the
 *                             operation pre-flight (fail-closed, zero
 *                             provider traffic; the decision is recorded
 *                             in the policy engine's own ledger);
 *   provider-unavailable    — transport failure/timeout/unreachable
 *                             provider (retryable);
 *   unsupported-capability  — the operation is outside the platform's
 *                             declared capability matrix (the HOST refuses
 *                             fail-closed BEFORE any policy evaluation,
 *                             credential resolution or provider traffic);
 *   insufficient-scope      — the grant's EXACT verbatim granted-scope
 *                             list does not include a scope the
 *                             operation's capability requires (the HOST
 *                             refuses fail-closed pre-flight).
 */
export type SocialAdapterFailureCode =
  | 'auth-expired'
  | 'rate-limited'
  | 'restricted'
  | 'policy-denied'
  | 'provider-unavailable'
  | 'unsupported-capability'
  | 'insufficient-scope';

export const SOCIAL_ADAPTER_FAILURE_CODES: readonly SocialAdapterFailureCode[] = [
  'auth-expired',
  'rate-limited',
  'restricted',
  'policy-denied',
  'provider-unavailable',
  'unsupported-capability',
  'insufficient-scope',
];

export function isKnownSocialFailureCode(value: string): value is SocialAdapterFailureCode {
  return (SOCIAL_ADAPTER_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * The retryability derivation (pure): only quota/backoff observations and
 * transport failures are retryable as-is; every other failure requires a
 * state change (reauthorization, policy change, capability grant or
 * strategy change) before the same operation can succeed.
 */
export function isRetryableSocialFailure(code: SocialAdapterFailureCode): boolean {
  return code === 'rate-limited' || code === 'provider-unavailable';
}

/**
 * The normalized rate-limit/quota OBSERVATION of one provider call (the
 * /integrations NormalizedRateLimit shape): every field optional —
 * providers differ; this is a RECORD of observable signals, never an
 * enforcement decision (policy enforcement stays in /policies).
 */
export interface SocialRateLimitObservation {
  readonly limitRemaining: number | null;
  readonly limitResetAt: string | null;
  readonly backoffUntil: string | null;
  readonly retryAfterSeconds: number | null;
}

/** One normalized operation failure — data, never a thrown exception. */
export interface SocialOperationFailure {
  readonly code: SocialAdapterFailureCode;
  readonly message: string;
  readonly rateLimit: SocialRateLimitObservation | null;
}

// ---------------------------------------------------------------------------
// The normalized record shapes (observations, never interpretations)
// ---------------------------------------------------------------------------

/**
 * The provider's CURRENT identity facts for the bound grant (the account
 * identity binding re-verification): the same shape the OAuth flow
 * recorded at connection time, re-observed on demand. A DRIFT between
 * the recorded binding and the provider's current identity is the
 * caller's reauthorization signal.
 */
export type SocialProviderIdentity = SocialAccountFlowIdentity;

/** The observable engagement facts of one content record (all nullable). */
export interface SocialEngagementObservation {
  readonly viewCount: number | null;
  readonly likeCount: number | null;
  readonly commentCount: number | null;
  readonly shareCount: number | null;
}

/**
 * One normalized content record: the provider identity, the observable
 * engagement (NULLABLE — only what the provider exposed, never
 * fabricated), the source metadata where available, and the provider
 * payload VERBATIM as passthrough data (MKT-062 owns the content
 * normalization into evidence/candidates — this contract records, it
 * does not interpret).
 */
export interface SocialContentRecord {
  readonly providerContentId: string;
  readonly authorExternalAccountId: string | null;
  readonly contentFormat: string;
  readonly publishedAt: string | null;
  readonly sourceTimestamp: string | null;
  readonly engagement: SocialEngagementObservation;
  readonly data: Readonly<Record<string, unknown>>;
  readonly etag: string | null;
  readonly sourceVersion: string | null;
}

/** One page of content records + the provider's opaque next-page cursor. */
export interface SocialContentPage {
  readonly records: readonly SocialContentRecord[];
  readonly pageCursor: string | null;
}

/**
 * One observed analytics metric point: the provider's metric label
 * VERBATIM (bounded), the observed value, the window where the provider
 * reported one, and the passthrough breakdown. No metric is invented and
 * no causal claim is implied (architecture-v1.6.md §12 — analysis is
 * MKT-066/067 territory).
 */
export interface SocialAnalyticsObservation {
  readonly metric: string;
  readonly value: number;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * One observable restriction/eligibility signal the provider EXPOSES: the
 * provider's own signal label verbatim (bounded), the observation stamp,
 * the bounded description and the passthrough facts. Interpretation into
 * platform-health states (healthy/degraded/restricted/
 * suspected_distribution_anomaly/...) is MKT-066 — this contract reports
 * ONLY platform-confirmed/observable signals and NEVER invents hidden
 * moderation state (§11, lock rules 25/26).
 */
export interface SocialRestrictionSignal {
  readonly signalKind: string;
  readonly observedAt: string | null;
  readonly description: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The account profile: identity + the observable audience facts. */
export interface SocialAccountProfile {
  readonly externalAccountId: string;
  readonly displayIdentity: string;
  readonly verifiedAt: string | null;
  /** The provider's own account-type label where exposed (passthrough). */
  readonly accountKind: string | null;
  /** The observed follower/audience count where the provider exposes it. */
  readonly followerCount: number | null;
  readonly data: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The publish lifecycle (submit → accepted → published/failed/restricted)
// ---------------------------------------------------------------------------

/**
 * The frozen publish-lifecycle states of an attempt:
 *   submitted — the born MOS-side state: the request passed the
 *               capability/scope/policy gates and is IN FLIGHT toward the
 *               provider (or was interrupted — UNKNOWN, unresolved,
 *               requiring reconciliation; never silently retried);
 *   accepted  — the provider ACCEPTED the publish (an async publish job;
 *              providerPublishId is set);
 *   published — the content is live (providerContentId where reported);
 *   failed    — the publish did not succeed (failure_code carries the
 *               taxonomy failure of the ATTEMPT; providerFailureReason
 *               carries the provider's own post-processing rejection);
 *   restricted— the provider signalled a restriction/eligibility block
 *               (the observable restriction signals ride the attempt).
 * 'accepted'/'published'/'failed'/'restricted' are the terminal fill
 * states of the single submit completion (the migration-050 trigger
 * fence); 'submitted' is the only non-terminal state.
 */
export type SocialPublishState =
  | 'submitted'
  | 'accepted'
  | 'published'
  | 'failed'
  | 'restricted';

export const SOCIAL_PUBLISH_STATES: readonly SocialPublishState[] = [
  'submitted',
  'accepted',
  'published',
  'failed',
  'restricted',
];

/** The frozen publish fill transition table (the trigger mirror). */
export const SOCIAL_PUBLISH_FILL_TRANSITIONS: Readonly<
  Record<SocialPublishState, readonly SocialPublishState[]>
> = {
  submitted: ['accepted', 'published', 'failed', 'restricted'],
  accepted: [],
  published: [],
  failed: [],
  restricted: [],
};

export function isLegalSocialPublishFill(from: SocialPublishState, to: SocialPublishState): boolean {
  return SOCIAL_PUBLISH_FILL_TRANSITIONS[from].includes(to);
}

/** One media asset reference of a publish request (opaque to the contract). */
export interface SocialPublishMediaAsset {
  /** The canonical content-asset reference (carried as data; the adapter resolves what it can). */
  readonly assetReference: string;
  /** The bounded media-kind label the adapter validates ('video', 'image', ...). */
  readonly mediaKind: string;
  /** Bounded passthrough descriptor (filename/mime/duration hints). */
  readonly descriptor: Readonly<Record<string, unknown>>;
}

/**
 * One normalized publish request: the bounded content-type label (the
 * adapter's own vocabulary — the host guards the SHAPE only), the
 * provider-shaped payload (passthrough — the adapter owns validation),
 * the media asset references, the mission-scoped attribution reference
 * VERBATIM as passthrough data (§16 — recorded, never interpreted) and
 * the optional scheduling stamp (whether the platform honors scheduling
 * is provider-side, declared by the adapter's capability description).
 */
export interface SocialPublishRequest {
  readonly contentType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly mediaAssets: readonly SocialPublishMediaAsset[];
  readonly attribution: Readonly<Record<string, unknown>>;
  readonly scheduledFor: string | null;
}

/**
 * The submit outcome the adapter reports: the provider's publish state at
 * submit time, the provider refs (the publish/upload job identity and,
 * once known, the published content identity) and the observable
 * restriction signals of a 'restricted' outcome. providerFailureReason
 * carries the provider's OWN rejection reason of a processed-but-failed
 * publish (bounded passthrough — the taxonomy failure_code stays null on
 * a processed provider rejection; the taxonomy classifies the OPERATION,
 * this field records the provider's answer).
 */
export interface SocialPublishSubmission {
  readonly publishState: Exclude<SocialPublishState, 'submitted'>;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
  readonly providerFailureReason: string | null;
  readonly restrictionSignals: readonly SocialRestrictionSignal[];
  readonly providerData: Readonly<Record<string, unknown>> | null;
}

/** The provider-side publish status a poll observes (same shape as the submission). */
export interface SocialPublishStatus {
  readonly publishState: Exclude<SocialPublishState, 'submitted'>;
  readonly providerPublishId: string | null;
  readonly providerContentId: string | null;
  readonly publishedAt: string | null;
  readonly providerFailureReason: string | null;
  readonly restrictionSignals: readonly SocialRestrictionSignal[];
  readonly providerData: Readonly<Record<string, unknown>> | null;
}

// ---------------------------------------------------------------------------
// The operation input shapes (bounded, §21-guarded)
// ---------------------------------------------------------------------------

/** The public-content discovery query (a topic/keyword search; paged). */
export interface SocialContentDiscoveryQuery {
  readonly query: string;
  readonly pageCursor: string | null;
  readonly limit: number | null;
}

/** The own-content listing input (paged). */
export interface SocialContentListQuery {
  readonly pageCursor: string | null;
  readonly limit: number | null;
}

/** The single-content read input. */
export interface SocialContentReadInput {
  readonly providerContentId: string;
}

/** The account analytics window (bounded, optional stamps). */
export interface SocialAnalyticsWindow {
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
}

/** The per-content analytics input (a bounded provider content-id list + window). */
export interface SocialContentAnalyticsInput {
  readonly providerContentIds: readonly string[];
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
}

/** The publish submit input (the idempotency key + the normalized request). */
export interface SocialPublishSubmitInput {
  readonly idempotencyKey: string;
  readonly request: SocialPublishRequest;
}

/** The publish status poll input (the provider's own publish identity). */
export interface SocialPublishStatusInput {
  readonly providerPublishId: string;
}

// ---------------------------------------------------------------------------
// The normalized operation results (data, never thrown provider failures)
// ---------------------------------------------------------------------------

export type SocialAccountIdentityResult =
  | { readonly ok: true; readonly identity: SocialProviderIdentity; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialAccountProfileResult =
  | { readonly ok: true; readonly profile: SocialAccountProfile; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialContentPageResult =
  | { readonly ok: true; readonly page: SocialContentPage; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialContentResult =
  | { readonly ok: true; readonly record: SocialContentRecord | null; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialAnalyticsResult =
  | { readonly ok: true; readonly observations: readonly SocialAnalyticsObservation[]; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialRestrictionSignalsResult =
  | { readonly ok: true; readonly signals: readonly SocialRestrictionSignal[]; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialPublishSubmitResult =
  | { readonly ok: true; readonly submission: SocialPublishSubmission; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

export type SocialPublishStatusResult =
  | { readonly ok: true; readonly status: SocialPublishStatus; readonly rateLimit: SocialRateLimitObservation | null }
  | { readonly ok: false; readonly failure: SocialOperationFailure };

// ---------------------------------------------------------------------------
// The call context (identity + the in-process material — §21)
// ---------------------------------------------------------------------------

/**
 * The provider-neutral call context handed to a platform adapter: the
 * bound account's identity chain, the VERBATIM grant scope list and the
 * recorded capability tags (the MKT-055 facts, propagated faithfully),
 * the connection's non-secret provider config, and the credential
 * MATERIAL resolved by the host AFTER a fail-closed /policies allow
 * through the /credentials authorized-execution path — in-process ONLY,
 * never persisted, logged, audited or queued (§21).
 */
export interface SocialAdapterCallContext {
  readonly socialAccountId: string;
  readonly integrationConnectionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly platformId: string;
  readonly externalAccountId: string;
  readonly providerConfig: Readonly<Record<string, string>>;
  /** The EXACT granted scope list VERBATIM (order preserved — lock rule 19). */
  readonly grantedScopes: readonly string[];
  /** The platform-normalized capability tags recorded on the grant. */
  readonly capabilityTags: readonly string[];
  /** The resolved credential material — in-process only (§21). */
  readonly credentialMaterial: Uint8Array;
}

// ---------------------------------------------------------------------------
// The adapter port (what a MKT-057..061 platform adapter implements)
// ---------------------------------------------------------------------------

/** The identity of one registered platform adapter (the adapter-key discipline). */
export interface SocialAdapterDescriptor {
  /** The platform identity: the SAME key the /integrations adapter registry uses (lock rule 18). */
  readonly adapterKey: string;
  readonly providerLabel: string;
  readonly description: string;
}

/**
 * One declared capability: the family, the declared OPERATION SUBSET of
 * the family's closed vocabulary, the provider scopes the operations
 * require (the host pre-checks them against the grant's VERBATIM list —
 * empty means no adapter-side scope claim) and the bounded description
 * (which MUST disclose the platform's limitations — lock rule 37).
 */
export interface SocialCapability {
  readonly family: SocialCapabilityFamily;
  readonly operations: readonly SocialOperationKey[];
  readonly requiredScopes: readonly string[];
  readonly description: string;
}

/**
 * THE SOCIAL PLATFORM ADAPTER PORT (MKT-056): the contract a concrete
 * platform adapter (the MKT-057..061 deliveries) implements. Adapters
 * arrive as DATA through the module dependencies (the MKT-023
 * adapter-registry precedent), are validated at construction (unique
 * adapterKey; every declared operation has its implementing method; the
 * closed vocabularies hold) and are importable ONLY from the composition
 * root (CONCRETE_ADAPTER_ACCESS).
 *
 * IDEMPOTENCY RULES FOR PUBLISH (the contract a publish-capable adapter
 * must hold):
 *   - the host fences (socialAccountId, idempotencyKey) durably — a
 *     replayed submit is answered from the fence and NEVER reaches the
 *     adapter;
 *   - the adapter receives the idempotency key on every submit and MUST
 *     treat it as the at-most-once identity toward the provider (mapping
 *     it to a provider-side idempotency mechanism where one exists);
 *   - an adapter call that throws (a contract violation) leaves the
 *     attempt in the honest UNKNOWN 'submitted' state — never blindly
 *     replayed under the same key (the AGENTS.md runtime rule).
 */
export interface SocialPlatformAdapter {
  readonly descriptor: SocialAdapterDescriptor;
  readonly capabilities: readonly SocialCapability[];
  /** Present iff the account family is declared (validated at registration). */
  verifyAccountIdentity?(context: SocialAdapterCallContext): Promise<SocialAccountIdentityResult>;
  getAccountProfile?(context: SocialAdapterCallContext): Promise<SocialAccountProfileResult>;
  /** Present iff the content-read family is declared (per-operation). */
  discoverPublicContent?(
    context: SocialAdapterCallContext,
    input: SocialContentDiscoveryQuery,
  ): Promise<SocialContentPageResult>;
  listOwnContent?(
    context: SocialAdapterCallContext,
    input: SocialContentListQuery,
  ): Promise<SocialContentPageResult>;
  getContent?(
    context: SocialAdapterCallContext,
    input: SocialContentReadInput,
  ): Promise<SocialContentResult>;
  /** Present iff the analytics-read family is declared. */
  readAccountAnalytics?(
    context: SocialAdapterCallContext,
    input: SocialAnalyticsWindow,
  ): Promise<SocialAnalyticsResult>;
  readContentAnalytics?(
    context: SocialAdapterCallContext,
    input: SocialContentAnalyticsInput,
  ): Promise<SocialAnalyticsResult>;
  /** Present iff the publish family is declared (per-operation). */
  submitPublish?(
    context: SocialAdapterCallContext,
    input: SocialPublishSubmitInput,
  ): Promise<SocialPublishSubmitResult>;
  getPublishStatus?(
    context: SocialAdapterCallContext,
    input: SocialPublishStatusInput,
  ): Promise<SocialPublishStatusResult>;
  /** Present iff the restriction-signals family is declared. */
  readRestrictionSignals?(
    context: SocialAdapterCallContext,
  ): Promise<SocialRestrictionSignalsResult>;
}

/** The registry view of one registered platform adapter (pure data). */
export interface RegisteredSocialAdapterInfo {
  readonly descriptor: SocialAdapterDescriptor;
  readonly capabilities: readonly SocialCapability[];
}

// ---------------------------------------------------------------------------
// The registration guards + the registry builder (pure)
// ---------------------------------------------------------------------------

const ADAPTER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BOUNDED_LABEL_MAX = 200;
const OPERATION_KEY_METHODS: Readonly<Record<SocialOperationKey, keyof SocialPlatformAdapter>> = {
  verifyAccountIdentity: 'verifyAccountIdentity',
  getAccountProfile: 'getAccountProfile',
  discoverPublicContent: 'discoverPublicContent',
  listOwnContent: 'listOwnContent',
  getContent: 'getContent',
  readAccountAnalytics: 'readAccountAnalytics',
  readContentAnalytics: 'readContentAnalytics',
  submitPublish: 'submitPublish',
  getPublishStatus: 'getPublishStatus',
  readRestrictionSignals: 'readRestrictionSignals',
};

/**
 * The registration problems of a platform adapter (pure): unknown
 * families/operations, operations of the wrong family, duplicate family
 * declarations, empty capability lists, missing implementing methods for
 * declared operations, malformed descriptors/scopes/descriptions. An
 * adapter with problems is REFUSED at construction — fail-closed, no
 * silent degrade to a narrower surface.
 */
export function socialAdapterRegistrationProblems(adapter: SocialPlatformAdapter): string[] {
  const problems: string[] = [];
  const key = adapter?.descriptor?.adapterKey;
  const label = `social platform adapter '${String(key)}'`;

  if (adapter === null || typeof adapter !== 'object') {
    return ['social platform adapter: must be an object implementing SocialPlatformAdapter'];
  }
  if (typeof key !== 'string' || !ADAPTER_KEY_PATTERN.test(key)) {
    problems.push(
      `${label}.descriptor.adapterKey: must be 1..64 chars, lowercase alphanumerics/dashes (the SAME key the /integrations adapter registry uses)`,
    );
  }
  if (
    typeof adapter.descriptor?.providerLabel !== 'string' ||
    adapter.descriptor.providerLabel.trim() === '' ||
    adapter.descriptor.providerLabel.length > BOUNDED_LABEL_MAX
  ) {
    problems.push(`${label}.descriptor.providerLabel: must be 1..${BOUNDED_LABEL_MAX} characters`);
  }
  if (
    typeof adapter.descriptor?.description !== 'string' ||
    adapter.descriptor.description.length > 1000
  ) {
    problems.push(`${label}.descriptor.description: must be a bounded description (at most 1000 characters) disclosing the adapter's limitations`);
  }
  if (!Array.isArray(adapter.capabilities) || adapter.capabilities.length === 0) {
    problems.push(
      `${label}.capabilities: a non-empty capability list is required — a platform declares at least one family (the capability-subset is first-class, an EMPTY matrix is not)`,
    );
    return problems;
  }
  if (adapter.capabilities.length > SOCIAL_CAPABILITY_FAMILIES.length) {
    problems.push(
      `${label}.capabilities: at most ${SOCIAL_CAPABILITY_FAMILIES.length} capabilities (one per family) — duplicate family declarations are refused`,
    );
  }

  // Validate through the UNKNOWN view (a malformed registration may carry
  // any runtime shape; the typed view resumes only after the guards).
  const capabilityList: readonly unknown[] = adapter.capabilities;
  const seenFamilies = new Set<string>();
  for (const [index, capabilityUnknown] of capabilityList.entries()) {
    const capabilityLabel = `${label}.capabilities[${index}]`;
    if (capabilityUnknown === null || typeof capabilityUnknown !== 'object') {
      problems.push(`${capabilityLabel}: must be a capability declaration`);
      continue;
    }
    const capability = capabilityUnknown as {
      family?: unknown;
      operations?: unknown;
      requiredScopes?: unknown;
      description?: unknown;
    };
    if (
      typeof capability.family !== 'string' ||
      !SOCIAL_CAPABILITY_FAMILIES.includes(capability.family as SocialCapabilityFamily)
    ) {
      problems.push(
        `${capabilityLabel}.family: '${String(capability.family)}' is not a social capability family (closed vocabulary: ${SOCIAL_CAPABILITY_FAMILIES.join(', ')})`,
      );
      continue;
    }
    const family = capability.family as SocialCapabilityFamily;
    if (seenFamilies.has(family)) {
      problems.push(
        `${capabilityLabel}: duplicate family declaration '${family}' — one capability per family`,
      );
      continue;
    }
    seenFamilies.add(family);

    if (!Array.isArray(capability.operations) || capability.operations.length === 0) {
      problems.push(
        `${capabilityLabel}.operations: a non-empty operation subset of the family's closed vocabulary is required`,
      );
      continue;
    }
    const legal = SOCIAL_FAMILY_OPERATIONS[family];
    const seenOperations = new Set<string>();
    for (const [opIndex, operationUnknown] of (capability.operations as readonly unknown[]).entries()) {
      if (
        typeof operationUnknown !== 'string' ||
        !(SOCIAL_OPERATION_KEYS as readonly string[]).includes(operationUnknown)
      ) {
        problems.push(
          `${capabilityLabel}.operations[${opIndex}]: '${String(operationUnknown)}' is not a social operation key (closed vocabulary: ${SOCIAL_OPERATION_KEYS.join(', ')})`,
        );
        continue;
      }
      const operation = operationUnknown as SocialOperationKey;
      if (!(legal as readonly string[]).includes(operation)) {
        problems.push(
          `${capabilityLabel}.operations[${opIndex}]: '${operation}' belongs to family '${socialOperationFamilyOf(operation)}', not '${family}' — an operation may be declared only under its owning family`,
        );
      } else if (seenOperations.has(operation)) {
        problems.push(
          `${capabilityLabel}.operations[${opIndex}]: duplicate operation '${operation}'`,
        );
      } else {
        seenOperations.add(operation);
        // Every declared operation MUST have its implementing method.
        const method = OPERATION_KEY_METHODS[operation];
        if (typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function') {
          problems.push(
            `${label}: declares operation '${operation}' but the adapter does not implement the '${method}' method — a declared operation without its implementation is refused fail-closed`,
          );
        }
      }
    }

    if (!Array.isArray(capability.requiredScopes)) {
      problems.push(`${capabilityLabel}.requiredScopes: must be an array of provider scope strings`);
    } else {
      for (const [scopeIndex, scope] of (capability.requiredScopes as readonly unknown[]).entries()) {
        if (typeof scope !== 'string' || scope.trim() === '' || scope.length > 256) {
          problems.push(
            `${capabilityLabel}.requiredScopes[${scopeIndex}]: must be a non-empty provider scope string (at most 256 characters)`,
          );
        }
      }
    }
    if (
      typeof capability.description !== 'string' ||
      capability.description.length === 0 ||
      capability.description.length > 1000
    ) {
      problems.push(
        `${capabilityLabel}.description: must be a bounded description (1..1000 characters) disclosing the platform's limitations for this family (lock rule 37)`,
      );
    }
  }
  return problems;
}

/**
 * The validated adapter registry (the flow-registry precedent): a Map
 * keyed by adapterKey. Construction fails LOUDLY on malformed
 * registrations and duplicate keys — the registry is data, never a
 * provider branch, and EMPTY in the production composition until the
 * MKT-057..061 adapter deliveries wire real platforms (fail-closed: an
 * operation against a platform with no registered adapter is refused).
 */
export function buildSocialAdapterRegistry(
  adapters: readonly SocialPlatformAdapter[],
): ReadonlyMap<string, SocialPlatformAdapter> {
  const registry = new Map<string, SocialPlatformAdapter>();
  for (const adapter of adapters) {
    const problems = socialAdapterRegistrationProblems(adapter);
    if (problems.length > 0) {
      throw new InvalidRequestError('invalid social platform adapter registration', problems);
    }
    const key = adapter.descriptor.adapterKey;
    if (registry.has(key)) {
      throw new InvalidRequestError('invalid social platform adapter registration', [
        `duplicate social platform adapter registration for adapter key '${key}' — one adapter per platform, fail-closed`,
      ]);
    }
    registry.set(key, adapter);
  }
  return registry;
}

/**
 * The capability declaration of one family on an adapter (pure lookup);
 * null when the adapter does not declare the family.
 */
export function socialCapabilityOf(
  adapter: SocialPlatformAdapter,
  family: SocialCapabilityFamily,
): SocialCapability | null {
  for (const capability of adapter.capabilities) {
    if (capability.family === family) return capability;
  }
  return null;
}

/**
 * The capability that declares an OPERATION on an adapter (pure): the
 * owning-family capability iff the operation is in its declared subset.
 * Null → the operation is outside the platform's declared matrix and the
 * host refuses fail-closed ('unsupported-capability', zero provider
 * traffic).
 */
export function adapterCapabilityForOperation(
  adapter: SocialPlatformAdapter,
  operation: SocialOperationKey,
): SocialCapability | null {
  const family = socialOperationFamilyOf(operation);
  if (family === null) return null;
  const capability = socialCapabilityOf(adapter, family);
  if (capability === null) return null;
  return (capability.operations as readonly string[]).includes(operation) ? capability : null;
}

/**
 * The adapter-side SCOPE PRE-CHECK (pure, the STRICT social variant of
 * the commerce convention): the honest problem string when the grant's
 * EXACT VERBATIM granted-scope list does not include every scope the
 * capability requires, or null when the call may proceed. The social
 * grant ALWAYS records a verbatim list (MKT-055) — a capability with
 * requiredScopes and a grant lacking them refuses FAIL-CLOSED before any
 * policy evaluation or provider traffic. A capability with NO
 * requiredScopes makes no adapter-side scope claim (the provider decides
 * at call time).
 */
export function socialScopeProblem(
  capability: SocialCapability,
  grantedScopes: readonly string[],
): string | null {
  if (capability.requiredScopes.length === 0) return null;
  const missing = capability.requiredScopes.filter(
    (scope) => !(grantedScopes as readonly string[]).includes(scope),
  );
  if (missing.length === 0) return null;
  return `the social-account grant does not include the provider scopes required by the '${capability.family}' capability (missing: ${missing.join(
    ', ',
  )}; granted verbatim: ${grantedScopes.length === 0 ? '(none)' : grantedScopes.join(', ')}) — the operation is refused before any provider traffic`;
}

/**
 * The per-capability scope satisfaction of a capability matrix against a
 * grant's verbatim scope list (pure — the capability-view composition).
 */
export interface SocialCapabilityScopeSatisfaction {
  readonly family: SocialCapabilityFamily;
  readonly satisfied: boolean;
  readonly missingScopes: readonly string[];
}

export function socialCapabilityScopeSatisfaction(
  capabilities: readonly SocialCapability[],
  grantedScopes: readonly string[],
): readonly SocialCapabilityScopeSatisfaction[] {
  return capabilities.map((capability) => {
    const missing = capability.requiredScopes.filter(
      (scope) => !(grantedScopes as readonly string[]).includes(scope),
    );
    return { family: capability.family, satisfied: missing.length === 0, missingScopes: missing };
  });
}

// ---------------------------------------------------------------------------
// The operation input guards (pure, §21-backstopped — InvalidRequestError)
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_TYPE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PROVIDER_ID_MAX = 128;
const QUERY_MAX = 200;
const PAGE_CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:=+-]{0,255}$/;
const SCOPE_PATTERN = /^[^\s]{1,256}$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

const MATERIAL_KEY_PATTERN =
  /(password|passwd|secret|token|api[-_]?key|private[-_]?key|client[-_]?secret|access[-_]?key|credential|auth[-_]?header|bearer)/i;
const MATERIAL_VALUE_HINT_PATTERN = /^(ey[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/]{40,}={0,2}|sk-[A-Za-z0-9]{16,})$/;

function isMaterialShapedEntry(key: string, value: unknown): boolean {
  if (MATERIAL_KEY_PATTERN.test(key)) return true;
  return typeof value === 'string' && MATERIAL_VALUE_HINT_PATTERN.test(value);
}

/** Recursively asserts a bounded passthrough object carries NO material-shaped key (§21). */
function assertNoMaterialShapedKeys(container: unknown, label: string, depth = 0): void {
  if (depth > 8) {
    throw new InvalidRequestError(`invalid ${label}`, [`${label}: nesting deeper than 8 levels is refused`]);
  }
  if (container === null || typeof container !== 'object') {
    throw new InvalidRequestError(`invalid ${label}`, [`${label}: must be an object`]);
  }
  const entries = Object.entries(container as Record<string, unknown>);
  if (entries.length > 100) {
    throw new InvalidRequestError(`invalid ${label}`, [`${label}: at most 100 keys per object level`]);
  }
  for (const [key, value] of entries) {
    if (isMaterialShapedEntry(key, value)) {
      throw new InvalidRequestError(`invalid ${label}`, [
        `${label}.${key}: material-shaped keys/values are refused (§21 — secret material never enters a normalized social shape)`,
      ]);
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      assertNoMaterialShapedKeys(value, `${label}.${key}`, depth + 1);
    }
  }
}

function assertBoundedString(value: unknown, label: string, max: number, pattern?: RegExp): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new InvalidRequestError(`invalid ${label}`, [
      `${label}: must be a non-empty string of at most ${max} characters`,
    ]);
  }
  if (pattern !== undefined && !pattern.test(value)) {
    throw new InvalidRequestError(`invalid ${label}`, [`${label}: the value shape is refused`]);
  }
}

function assertIsoTimestampOrNull(value: unknown, label: string): void {
  if (value === null) return;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw new InvalidRequestError(`invalid ${label}`, [`${label}: must be an ISO-8601 timestamp or null`]);
  }
}

/** Guards a publish request (shape + §21 backstop; fail-closed by rejection). */
export function assertValidSocialPublishRequest(request: SocialPublishRequest): void {
  if (request === null || typeof request !== 'object') {
    throw new InvalidRequestError('invalid social publish request', [
      'request: must be a social publish request object',
    ]);
  }
  assertBoundedString(request.contentType, 'request.contentType', 64, CONTENT_TYPE_PATTERN);
  assertNoMaterialShapedKeys(request.payload, 'request.payload');
  if (!Array.isArray(request.mediaAssets)) {
    throw new InvalidRequestError('invalid social publish request', [
      'request.mediaAssets: must be an array of media asset references',
    ]);
  }
  if (request.mediaAssets.length > 20) {
    throw new InvalidRequestError('invalid social publish request', [
      'request.mediaAssets: at most 20 media assets per publish',
    ]);
  }
  for (const [index, asset] of request.mediaAssets.entries()) {
    if (asset === null || typeof asset !== 'object') {
      throw new InvalidRequestError('invalid social publish request', [
        `request.mediaAssets[${index}]: must be a media asset reference object`,
      ]);
    }
    assertBoundedString(asset.assetReference, `request.mediaAssets[${index}].assetReference`, 256);
    assertBoundedString(asset.mediaKind, `request.mediaAssets[${index}].mediaKind`, 64);
    assertNoMaterialShapedKeys(asset.descriptor, `request.mediaAssets[${index}].descriptor`);
  }
  assertNoMaterialShapedKeys(request.attribution, 'request.attribution');
  assertIsoTimestampOrNull(request.scheduledFor, 'request.scheduledFor');
}

/** Guards a publish idempotency key (the at-most-once identity). */
export function assertValidSocialIdempotencyKey(key: string): void {
  assertBoundedString(key, 'idempotencyKey', 128, IDEMPOTENCY_KEY_PATTERN);
}

/** Guards a public-content discovery query. */
export function assertValidSocialContentDiscoveryQuery(query: SocialContentDiscoveryQuery): void {
  assertBoundedString(query.query, 'query', QUERY_MAX);
  if (query.pageCursor !== null) {
    assertBoundedString(query.pageCursor, 'pageCursor', 256, PAGE_CURSOR_PATTERN);
  }
  if (query.limit !== null && (typeof query.limit !== 'number' || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new InvalidRequestError('invalid social content discovery query', [
      'limit: must be an integer between 1 and 100, or null',
    ]);
  }
}

/** Guards an own-content listing query. */
export function assertValidSocialContentListQuery(query: SocialContentListQuery): void {
  if (query.pageCursor !== null) {
    assertBoundedString(query.pageCursor, 'pageCursor', 256, PAGE_CURSOR_PATTERN);
  }
  if (query.limit !== null && (typeof query.limit !== 'number' || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new InvalidRequestError('invalid social content list query', [
      'limit: must be an integer between 1 and 100, or null',
    ]);
  }
}

/** Guards a single-content read input. */
export function assertValidSocialContentReadInput(input: SocialContentReadInput): void {
  assertBoundedString(input.providerContentId, 'providerContentId', PROVIDER_ID_MAX);
}

/** Guards an analytics window. */
export function assertValidSocialAnalyticsWindow(window: SocialAnalyticsWindow): void {
  assertIsoTimestampOrNull(window.windowStart, 'windowStart');
  assertIsoTimestampOrNull(window.windowEnd, 'windowEnd');
  if (
    window.windowStart !== null &&
    window.windowEnd !== null &&
    Date.parse(window.windowEnd) < Date.parse(window.windowStart)
  ) {
    throw new InvalidRequestError('invalid social analytics window', [
      'windowEnd: must not precede windowStart',
    ]);
  }
}

/** Guards a per-content analytics input. */
export function assertValidSocialContentAnalyticsInput(input: SocialContentAnalyticsInput): void {
  if (!Array.isArray(input.providerContentIds) || input.providerContentIds.length === 0) {
    throw new InvalidRequestError('invalid social content analytics input', [
      'providerContentIds: a non-empty list of provider content ids is required',
    ]);
  }
  if (input.providerContentIds.length > 20) {
    throw new InvalidRequestError('invalid social content analytics input', [
      'providerContentIds: at most 20 provider content ids per read',
    ]);
  }
  for (const [index, id] of input.providerContentIds.entries()) {
    assertBoundedString(id, `providerContentIds[${index}]`, PROVIDER_ID_MAX);
  }
  assertIsoTimestampOrNull(input.windowStart, 'windowStart');
  assertIsoTimestampOrNull(input.windowEnd, 'windowEnd');
  if (
    input.windowStart !== null &&
    input.windowEnd !== null &&
    Date.parse(input.windowEnd) < Date.parse(input.windowStart)
  ) {
    throw new InvalidRequestError('invalid social content analytics input', [
      'windowEnd: must not precede windowStart',
    ]);
  }
}

/** Guards a publish status poll input. */
export function assertValidSocialPublishStatusInput(input: SocialPublishStatusInput): void {
  assertBoundedString(input.providerPublishId, 'providerPublishId', PROVIDER_ID_MAX);
}

/** Guards a rate-limit observation shape (the recorded outcome backstop). */
export function assertValidSocialRateLimitObservation(
  observation: SocialRateLimitObservation | null,
): void {
  if (observation === null) return;
  if (
    observation.limitRemaining !== null &&
    (typeof observation.limitRemaining !== 'number' || !Number.isFinite(observation.limitRemaining))
  ) {
    throw new InvalidRequestError('invalid social rate-limit observation', [
      'limitRemaining: must be a finite number or null',
    ]);
  }
  assertIsoTimestampOrNull(observation.limitResetAt, 'limitResetAt');
  assertIsoTimestampOrNull(observation.backoffUntil, 'backoffUntil');
  if (
    observation.retryAfterSeconds !== null &&
    (typeof observation.retryAfterSeconds !== 'number' ||
      !Number.isInteger(observation.retryAfterSeconds) ||
      observation.retryAfterSeconds < 0)
  ) {
    throw new InvalidRequestError('invalid social rate-limit observation', [
      'retryAfterSeconds: must be a non-negative integer or null',
    ]);
  }
}

/** Guards a provider scope string (the strict social variant — always a list). */
export function assertValidSocialScopeString(scope: string): void {
  assertBoundedString(scope, 'scope', 256, SCOPE_PATTERN);
}
