/**
 * MarketingOS module: /app-marketplace
 * Authority: App Marketplace, Trust and Certification — the discovery,
 * trust-transition and review surface over the /apps registry (MKT-050).
 *
 * This module owns:
 *
 *   - the MARKETPLACE DISCOVERY read model: a DERIVED listing + search/
 *     filter over PUBLISHED App Versions (registry rows only — the
 *     marketplace NEVER becomes a second registry: no app catalog table
 *     is owned here, every catalog fact comes from the /apps public
 *     contract, and the only durable state is the trust/review ledgers
 *     below). First-party/community classification is DERIVED from the
 *     server-derived registry publisher identity ('svc:<label>' =
 *     first-party, 'dev:<userId>' = community — the MKT-032/047 role
 *     model); category filtering matches declared manifest capabilities;
 *     version visibility lists the immutable registry version history;
 *   - the TRUST TRANSITION LEDGER (migration 042 trust_events): the
 *     append-only governance record of every trust move. The frozen
 *     vocabulary is the one-way ladder UNVERIFIED → COMMUNITY_VERIFIED
 *     → MOS_CERTIFIED (spec/mos-app-ecosystem-v1.5.md "Trust levels";
 *     no skipping — UNVERIFIED → MOS_CERTIFIED is illegal); the
 *     DISCLOSED down moves (decertify, revoke) are APPEND-ONLY EVENTS
 *     with operator provenance — never a silent rewrite. The CURRENT
 *     trust state of a lineage is DERIVED (the newest event's to_state;
 *     no events → the UNVERIFIED registry birth state). The /apps
 *     registry's own certification_state column stays frozen at birth
 *     (migration 037 rejects every UPDATE — this ledger IS the platform
 *     marketplace/trust surface that migration anticipated);
 *   - the REVIEW RECORDS (migration 042 app_reviews): structured
 *     append-only reviews (rating, verdict, reviewer provenance,
 *     timestamps) attached at the app or exact app-version level.
 *     Reviews are DISPLAY METADATA: no policy consumes review state in
 *     this delivery (disclosed) — the eligibility vocabulary exposes it
 *     read-side for FUTURE explicit policy consumption only;
 *   - the POLICY ELIGIBILITY read-side query (AC-5): the derived
 *     trust-level + review state in a POLICY-CONSUMABLE VOCABULARY (the
 *     attribute shape /policies rules match). The MKT-048 install gate
 *     consumes the TRUST part through the disclosed additive wiring
 *     (the optional trustState structural port on /app-installs, wired
 *     at the composition root): the gate action's certificationState
 *     attribute then carries the marketplace-DERIVED current state
 *     instead of the frozen registry birth state. Trust NEVER grants
 *     authority by itself: the fail-closed /policies evaluation stays
 *     the sole install authority (MKT-048 semantics preserved);
 *   - the MARKETPLACE ATTRIBUTION BOUNDARY (mos-app-ecosystem-v1.5.md
 *     "Economics": "Marketplace attribution is separate from the core
 *     financial authority"): NO billing, charging, metering or
 *     attribution state is owned here — MKT-052 territory.
 *
 * This module does NOT own:
 *
 *   - the app registry (MKT-047 /apps — consumed READ-ONLY through its
 *     public contract; no registry mutation surface exists here);
 *   - the install/upgrade/rollback authority (MKT-048 /app-installs —
 *     the policy gate remains the sole install authority; this module
 *     only enriches one policy ACTION ATTRIBUTE additively);
 *   - any policy decision (MKT-021 /policies — rules and evaluation
 *     stay exactly there);
 *   - metering/attribution (MKT-052) or any financial authority;
 *   - any tenant/identity authority (route-layer authorization resolves
 *     /agencies memberships + platform roles; the module holds no
 *     agency/client/workspace columns at all — the trust/review ledgers
 *     are global catalog state, the 028/030/037 posture).
 */

import type { Db } from '../../platform/db/contract.ts';
import type { Clock } from '../../platform/clock/clock.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { AppsModuleApi } from '../apps/public.ts';
import type { AppCertificationState } from '../apps/public.ts';

// Re-exported so marketplace consumers bind to the ONE frozen trust
// vocabulary (the /apps registry's certification enum — there is no
// second trust vocabulary anywhere).
export type {
  AppCertificationState,
  AppVersionRecord,
} from '../apps/public.ts';

// ---------------------------------------------------------------------------
// The frozen trust-transition vocabulary (the lifecycle state machine)
// ---------------------------------------------------------------------------

/**
 * The closed trust-transition label vocabulary: the two frozen one-way
 * UP arrows of the spec ladder (verify, certify) plus the DISCLOSED
 * DOWN moves (decertify, revoke — the revocation family). Transitions
 * are OPERATOR/GOVERNANCE actions (platform_administrator or the
 * internal service principal at the route layer — a platform_developer
 * is explicitly INSUFFICIENT: a developer can never self-certify, the
 * MKT-047 contract), never community self-service.
 */
export type TrustTransition = 'verify' | 'certify' | 'decertify' | 'revoke';

export const TRUST_TRANSITIONS: readonly TrustTransition[] = [
  'verify',
  'certify',
  'decertify',
  'revoke',
];

/**
 * The legal (transition, from, to) triples — the frozen state machine.
 * UP: exactly the spec's one-way arrows, NO skipping (UNVERIFIED →
 * MOS_CERTIFIED is illegal; certification follows community
 * verification). DOWN (disclosed): decertify (MOS_CERTIFIED →
 * COMMUNITY_VERIFIED) and revoke (either elevated state → UNVERIFIED).
 * A same-state transition is structurally illegal.
 */
export const TRUST_TRANSITION_TARGETS: Readonly<
  Record<TrustTransition, ReadonlyArray<{ readonly from: AppCertificationState; readonly to: AppCertificationState }>>
> = {
  verify: [{ from: 'UNVERIFIED', to: 'COMMUNITY_VERIFIED' }],
  certify: [{ from: 'COMMUNITY_VERIFIED', to: 'MOS_CERTIFIED' }],
  decertify: [{ from: 'MOS_CERTIFIED', to: 'COMMUNITY_VERIFIED' }],
  revoke: [
    { from: 'COMMUNITY_VERIFIED', to: 'UNVERIFIED' },
    { from: 'MOS_CERTIFIED', to: 'UNVERIFIED' },
  ],
};

/**
 * Evaluates ONE proposed transition against the CURRENT derived trust
 * state (the pure state machine — unit-tested). Ok returns the target
 * state; not-ok returns the honest reason (illegal skip, illegal down
 * move, same-state no-op or illegal label). Pure.
 */
export function evaluateTrustTransition(
  current: AppCertificationState,
  transition: TrustTransition,
): { readonly ok: true; readonly toState: AppCertificationState } | { readonly ok: false; readonly reason: string } {
  const targets = TRUST_TRANSITION_TARGETS[transition];
  const match = targets.find((target) => target.from === current);
  if (match !== undefined) {
    return { ok: true, toState: match.to };
  }
  if (transition === 'verify') {
    return {
      ok: false,
      reason: `verify departs from UNVERIFIED (the frozen one-way ladder) but app is at ${current}`,
    };
  }
  if (transition === 'certify') {
    return {
      ok: false,
      reason: `certify requires COMMUNITY_VERIFIED (the frozen one-way ladder — no skipping from UNVERIFIED) but app is at ${current}`,
    };
  }
  if (transition === 'decertify') {
    return {
      ok: false,
      reason: `decertify departs from MOS_CERTIFIED but app is at ${current}`,
    };
  }
  return {
    ok: false,
    reason: `revoke departs from COMMUNITY_VERIFIED or MOS_CERTIFIED but app is at ${current}`,
  };
}

/**
 * Derives the CURRENT trust state from an append-only event tail (the
 * newest event's toState; the UNVERIFIED registry birth state when no
 * event was ever recorded). The tail must be the lineage's full ordered
 * history (the store guarantees gapless seqs). Pure.
 */
export function deriveTrustState(
  events: ReadonlyArray<{ readonly toState: AppCertificationState }>,
): AppCertificationState {
  if (events.length === 0) return 'UNVERIFIED';
  return events[events.length - 1]!.toState;
}

// ---------------------------------------------------------------------------
// The review vocabulary (display metadata — never a policy input here)
// ---------------------------------------------------------------------------

/** The closed structured-verdict vocabulary of a review record. */
export type AppReviewVerdict = 'positive' | 'mixed' | 'negative';

export const APP_REVIEW_VERDICTS: readonly AppReviewVerdict[] = [
  'positive',
  'mixed',
  'negative',
];

/** The rating band of a review record (1..5). */
export const APP_REVIEW_RATING_MIN = 1;
export const APP_REVIEW_RATING_MAX = 5;

/**
 * The derived review summary of one app lineage (display metadata):
 * the append-only tail's count, average rating (one decimal), verdict
 * tallies and the newest review stamp. Pure.
 */
export interface MarketplaceReviewSummary {
  readonly reviewCount: number;
  readonly averageRating: number | null;
  readonly verdictCounts: Readonly<Record<AppReviewVerdict, number>>;
  readonly lastReviewAt: string | null;
}

/**
 * Derives the review summary from an append-only review tail (any
 * order). The empty summary is all-zero/null — an app with no reviews
 * carries an honest empty summary, never a fabricated one. Pure.
 */
export function deriveReviewSummary(
  reviews: ReadonlyArray<{
    readonly rating: number;
    readonly verdict: AppReviewVerdict;
    readonly recordedAt: string;
  }>,
): MarketplaceReviewSummary {
  const verdictCounts: Record<AppReviewVerdict, number> = {
    positive: 0,
    mixed: 0,
    negative: 0,
  };
  let total = 0;
  let lastReviewAt: string | null = null;
  for (const review of reviews) {
    total += review.rating;
    verdictCounts[review.verdict] += 1;
    if (lastReviewAt === null || review.recordedAt > lastReviewAt) {
      lastReviewAt = review.recordedAt;
    }
  }
  return {
    reviewCount: reviews.length,
    averageRating:
      reviews.length === 0
        ? null
        : Math.round((total / reviews.length) * 10) / 10,
    verdictCounts,
    lastReviewAt,
  };
}

// ---------------------------------------------------------------------------
// Records (append-only ledgers — migration 042)
// ---------------------------------------------------------------------------

/** SERVER-DERIVED provenance for trust transitions and review records. */
export interface MarketplaceProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>'. */
  readonly actor: string;
  /** Server-derived surface label ('api' for the HTTP surface). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** One append-only trust transition event (the governance record). */
export interface TrustEventRecord {
  readonly eventId: string;
  readonly appKey: string;
  readonly transitionSeq: number;
  readonly transition: TrustTransition;
  readonly fromState: AppCertificationState;
  readonly toState: AppCertificationState;
  readonly reason: string;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

/** One append-only review record (display metadata). */
export interface AppReviewRecord {
  readonly reviewId: string;
  readonly appKey: string;
  /** NULL = an app-level review; set = an exact-version review. */
  readonly appVersionId: string | null;
  readonly rating: number;
  readonly verdict: AppReviewVerdict;
  readonly body: string;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly recordedAt: string;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

// ---------------------------------------------------------------------------
// The derived marketplace read model (registry data + trust + reviews)
// ---------------------------------------------------------------------------

/** The derived current trust state of one app lineage. */
export interface MarketplaceTrustState {
  readonly appKey: string;
  readonly trustLevel: AppCertificationState;
  /** The newest event when the lineage has any (null at birth state). */
  readonly sinceEventId: string | null;
  /** The total number of recorded transitions (0 at birth state). */
  readonly transitionCount: number;
}

/** The first-party/community classification (DERIVED from the publisher). */
export type MarketplacePublisherKind = 'first-party' | 'community';

export const MARKETPLACE_PUBLISHER_KINDS: readonly MarketplacePublisherKind[] = [
  'first-party',
  'community',
];

/**
 * Derives the publisher classification from the SERVER-DERIVED registry
 * publisher identity: platform service principals ('svc:<label>') are
 * first-party; platform developers ('dev:<userId>') are community
 * publishers (the MKT-032 platform_developer role model). Pure.
 */
export function derivePublisherKind(publisher: string): MarketplacePublisherKind {
  return publisher.startsWith('svc:') ? 'first-party' : 'community';
}

/** One registry version summary as surfaced by the marketplace listing. */
export interface MarketplaceVersionSummary {
  readonly appVersionId: string;
  readonly version: string;
  readonly publishedAt: string;
  /** The manifest's declared capabilities (the category filter input). */
  readonly capabilities: readonly string[];
  readonly runtimeClass: string;
}

/** One marketplace listing entry — ONE app lineage (registry-derived). */
export interface MarketplaceAppEntry {
  readonly appKey: string;
  readonly publisher: string;
  readonly publisherKind: MarketplacePublisherKind;
  /** The newest published version of the lineage (newest first). */
  readonly latestVersion: MarketplaceVersionSummary | null;
  /** The full immutable registry version history, newest first. */
  readonly versions: readonly MarketplaceVersionSummary[];
  readonly trustState: MarketplaceTrustState;
  readonly reviewSummary: MarketplaceReviewSummary;
}

/** The marketplace listing filters (all optional, all validated). */
export interface MarketplaceFilters {
  /** Category filter: matches any declared capability name of the lineage. */
  readonly category: string | null;
  /** Trust-level filter (the frozen vocabulary). */
  readonly trustLevel: AppCertificationState | null;
  /** First-party/community classification filter. */
  readonly publisherKind: MarketplacePublisherKind | null;
  /** Bounded search substring on the app key (lowercase). */
  readonly search: string | null;
}

/** The marketplace app detail: the listing entry + the full tails. */
export interface MarketplaceAppDetail {
  readonly entry: MarketplaceAppEntry;
  /** The append-only trust transition tail, oldest first. */
  readonly trustEvents: readonly TrustEventRecord[];
  /** The append-only review tail, newest first (bounded). */
  readonly reviews: readonly AppReviewRecord[];
}

// ---------------------------------------------------------------------------
// The policy ELIGIBILITY surface (AC-5 — the policy-consumable vocabulary)
// ---------------------------------------------------------------------------

/**
 * The policy-eligibility read-side query result: the derived trust level
 * + review state of one app lineage in a POLICY-CONSUMABLE VOCABULARY —
 * the exact Record<string, string> attribute shape /policies rules
 * match. The MKT-048 install gate consumes `certificationState` (the
 * disclosed additive trustState-port wiring); `reviewCount` /
 * `averageRating` are exposed for FUTURE explicit policy consumption
 * only — NO policy consumes review state in this delivery (disclosed:
 * reviews are display metadata).
 */
export interface MarketplacePolicyEligibility {
  readonly appKey: string;
  /** The DERIVED current trust level (the policy input). */
  readonly trustLevel: AppCertificationState;
  readonly trustSinceEventId: string | null;
  readonly transitionCount: number;
  /** The derived review state (display metadata — read-side only). */
  readonly reviewState: {
    readonly reviewCount: number;
    readonly averageRating: number | null;
    readonly lastReviewAt: string | null;
  };
  /**
   * The policy-consumable attribute vocabulary (string values — the
   * /policies action-attribute shape): certificationState,
   * reviewCount, averageRating ('none' when no reviews), transitionCount.
   */
  readonly policyAttributes: Readonly<Record<string, string>>;
}

/**
 * Builds the policy-consumable attribute vocabulary from the derived
 * trust + review state (pure — the exact shape the MKT-048 gate action
 * attribute set and future operator rules consume). Pure.
 */
export function buildPolicyAttributes(input: {
  readonly trustLevel: AppCertificationState;
  readonly transitionCount: number;
  readonly reviewCount: number;
  readonly averageRating: number | null;
}): Readonly<Record<string, string>> {
  return {
    certificationState: input.trustLevel,
    transitionCount: String(input.transitionCount),
    reviewCount: String(input.reviewCount),
    averageRating: input.averageRating === null ? 'none' : String(input.averageRating),
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface AppMarketplaceModuleApi {
  /**
   * The DISCOVERY LISTING (AC-1): every PUBLISHED app lineage derived
   * from the /apps registry rows (READ-ONLY public contract — the
   * marketplace never becomes a second registry) enriched with the
   * derived trust state and review summary, then filtered by the
   * optional category (capability), trust-level, publisher-kind and
   * search filters. Sorted newest-published first. Pure read: no state
   * changes. The agency/tenant SCOPE is resolved at the route layer
   * (server-derived authorization, uniform 404 foreign/unknown/malformed,
   * suspended 403, anonymous 401) — the catalog itself is global
   * registry state with no tenant columns (the 037 posture, disclosed).
   */
  listMarketplaceApps(filters: MarketplaceFilters): Promise<readonly MarketplaceAppEntry[]>;

  /**
   * The app DETAIL (AC-1): one lineage's listing entry (registry version
   * history — version visibility), the append-only trust transition tail
   * (oldest first) and the bounded review tail (newest first). Null when
   * the app key has no published lineage (the route surfaces the uniform
   * 404 — unknown/malformed are indistinguishable).
   */
  getMarketplaceApp(appKey: string): Promise<MarketplaceAppDetail | null>;

  /**
   * The POLICY ELIGIBILITY read-side query (AC-5): the derived trust
   * level + review state in the policy-consumable vocabulary. Null when
   * the app key has no published lineage.
   */
  resolvePolicyEligibility(appKey: string): Promise<MarketplacePolicyEligibility | null>;

  /**
   * RECORDS one trust transition (AC-2 — the OPERATOR/GOVERNANCE
   * command): appends ONE trust_events row with the server-derived
   * provenance and the §8 idempotency key. Guards (fail-closed, zero
   * rows): the app key must be a PUBLISHED lineage (uniform NotFound);
   * the transition must be LEGAL from the CURRENT derived state under
   * the frozen one-way ladder + the disclosed down moves
   * (InvalidRequestError with the honest reason — an illegal skip, a
   * same-state no-op or an illegal down move is rejected); the reason is
   * bounded non-empty; §8 replays converge (identical fingerprint → the
   * recorded event, replayed: true) and divergent key reuse is an
   * IdempotencyConflictError. The event is NEVER a rewrite: UPDATE and
   * DELETE are rejected by the migration-042 triggers, and the /apps
   * registry row stays frozen at its birth state.
   */
  recordTrustTransition(
    input: {
      readonly appKey: string;
      readonly transition: TrustTransition;
      readonly reason: string;
      readonly idempotencyKey: string;
      /** SERVER-DERIVED operator identity (the authenticated principal). */
      readonly actorId: string | null;
    },
    provenance: MarketplaceProvenance,
  ): Promise<{ readonly event: TrustEventRecord; readonly replayed: boolean }>;

  /**
   * RECORDS one review (AC-4 — the community review command): appends
   * ONE app_reviews row (rating, verdict, body, server-derived reviewer
   * provenance) attached at the app level (appVersionId null) or at an
   * exact registry version (validated to belong to the SAME lineage).
   * Guards (fail-closed, zero rows): published lineage (uniform 404);
   * a version-level target must resolve through the /apps public
   * contract and belong to the app key; rating in the closed band;
   * verdict in the closed vocabulary; body bounded non-empty; §8
   * replays converge and divergent key reuse conflicts. Reviews are
   * DISPLAY METADATA: no policy consumes review state in this delivery.
   */
  recordAppReview(
    input: {
      readonly appKey: string;
      readonly appVersionId: string | null;
      readonly rating: number;
      readonly verdict: AppReviewVerdict;
      readonly body: string;
      readonly idempotencyKey: string;
      /** SERVER-DERIVED reviewer identity (the authenticated principal). */
      readonly actorId: string | null;
    },
    provenance: MarketplaceProvenance,
  ): Promise<{ readonly review: AppReviewRecord; readonly replayed: boolean }>;

  /**
   * The DERIVED current trust state of one app lineage (the trust-state
   * structural-port method the MKT-048 install gate consumes through the
   * disclosed additive wiring — satisfied structurally, wired at the
   * composition root). Null when the app key has no published lineage.
   */
  resolveAppTrustState(appKey: string): Promise<MarketplaceTrustState | null>;

  /** The append-only trust transition tail of one lineage (oldest first). */
  listTrustEvents(appKey: string): Promise<readonly TrustEventRecord[]>;

  /** The append-only review tail of one lineage (newest first, bounded). */
  listAppReviews(appKey: string): Promise<readonly AppReviewRecord[]>;
}

export interface AppMarketplaceModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Matrix-listed direction (/app-marketplace ──→ /apps): the App
   * registry authority — the listing/version-history/version-resolution
   * reads. Consumed READ-ONLY through the public contract; the registry
   * is never mutated (composition, not authority transfer — the
   * marketplace NEVER becomes a second registry).
   */
  readonly apps: AppsModuleApi;
}

export { createAppMarketplaceModule } from './internal/module.ts';
/**
 * The input guards (transition-input/review-input/provenance validation
 * with the §21 material-key backstop) and the pure §8-style create
 * fingerprints — exported for unit tests and future server-side callers
 * so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  appReviewCreateFingerprint,
  assertValidMarketplaceFilters,
  assertValidMarketplaceProvenance,
  assertValidReviewInput,
  assertValidTransitionInput,
  classifyMarketplaceWriteConflict,
  replayOrConflict,
  trustEventCreateFingerprint,
  MARKETPLACE_MATERIAL_SHAPED_KEYS,
} from './internal/store.ts';
