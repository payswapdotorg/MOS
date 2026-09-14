/**
 * /api/app-marketplace APP MARKETPLACE routes (MKT-050 — App
 * Marketplace, Trust and Certification: the discovery surface, the
 * trust-transition command surface and the review command surface over
 * the /apps registry).
 *
 *   GET  /api/app-marketplace/:agencyId/apps                            the agency-scoped marketplace LISTING with search/filters (any active member of the agency)
 *   GET  /api/app-marketplace/:agencyId/apps/:appKey                    the marketplace app DETAIL: registry version history + the derived trust state + the append-only trust/review tails (any active member of the agency)
 *   GET  /api/app-marketplace/:agencyId/apps/:appKey/policy-eligibility the POLICY ELIGIBILITY read-side query — the derived trust level + review state in the policy-consumable vocabulary (AC-5)
 *   POST /api/app-marketplace/apps/:appKey/trust                        record ONE trust transition (platform_administrator | service principal — the OPERATOR/GOVERNANCE gate; a platform_developer is explicitly INSUFFICIENT: a developer can never self-certify)
 *   POST /api/app-marketplace/apps/:appKey/reviews                      record ONE community review (any active member — the global-catalog posture of the /apps registry reads)
 *
 * NO UPDATE ROUTE. NO DELETE ROUTE. Trust transitions and reviews are
 * APPEND-ONLY (migration 042 triggers reject UPDATE/DELETE outright);
 * corrections are NEW event/review rows — history is never rewritten,
 * and the /apps registry rows stay frozen at their birth state (the
 * marketplace NEVER rewrites the registry). The route surface is
 * exactly the five frozen routes above (asserted by
 * tests/architecture/app-marketplace-boundary.test.ts).
 *
 * Server-derived authority posture (implementation-contract §3/§23; the
 * reporting command-center + /apps precedents):
 *   - DISCOVERY is AGENCY-SCOPED with SERVER-DERIVED scope (the
 *     command-center posture): the durable agency row and the caller's
 *     membership resolve from durable state BEFORE any dependent
 *     traversal; a malformed, unknown or FOREIGN agency identifier is
 *     the UNIFORM 404 (no cross-agency existence oracle); a SUSPENDED
 *     membership or disabled identity is the 403; anonymous calls fail
 *     closed 401 at the authenticator. The catalog itself is global
 *     registry state with no tenant columns (the 037 posture, disclosed
 *     in the runbook — the agency scope is AUTHORIZATION, not a data
 *     partition);
 *   - every mutating route resolves the caller's authorization context
 *     from durable state BEFORE validate/execute; the transition state,
 *     the review provenance and every derived value are NEVER
 *     request-suppliable (the DTOs reject them explicitly plus every
 *     material-shaped key — §21); the module input guard is the single
 *     semantic enforcement point behind the DTO;
 *   - READ-ONLY DISCOVERY BY CONSTRUCTION: the three discovery routes
 *     are GETs that read no body — no mutation surface exists for the
 *     catalog, ever (a frontend bypass has nothing to drive).
 */

import { ForbiddenError, InvalidRequestError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { FieldSpec } from '../platform/http/validation.ts';
import {
  intField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  AppMarketplaceModuleApi,
  AppReviewRecord,
  MarketplaceAppDetail,
  MarketplaceAppEntry,
  MarketplacePolicyEligibility,
  TrustEventRecord,
} from '../modules/app-marketplace/public.ts';
import type { AppCertificationState } from '../modules/apps/public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRUST_LEVEL_PATTERN = /^(UNVERIFIED|COMMUNITY_VERIFIED|MOS_CERTIFIED)$/;
const TRANSITION_PATTERN = /^(verify|certify|decertify|revoke)$/;
const VERDICT_PATTERN = /^(positive|mixed|negative)$/;
const PUBLISHER_KIND_PATTERN = /^(first-party|community)$/;

/**
 * Material-shaped keys rejected on EVERY /app-marketplace surface
 * (§21/CRED-001 — the module store guard and the migration-042 CHECK
 * columns enforce the identical set behind the DTO).
 */
const MATERIAL_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialValue',
  'secretValue',
] as const;

/**
 * Fields always server-derived on EVERY marketplace mutation (derived
 * state, provenance, lineage identity) — plus every material-shaped
 * key, so no secret VALUE and no forged trust state can be smuggled
 * through the route surface.
 */
const MARKETPLACE_AUTHORITY_FIELDS = [
  // Trust state is PLATFORM territory — never caller-suppliable.
  'certificationState',
  'trustLevel',
  'trust',
  'fromState',
  'toState',
  'transitionSeq',
  'eventId',
  // Review derivation is server-owned.
  'reviewId',
  'reviewSummary',
  'averageRating',
  'reviewCount',
  // Provenance + command identity are server-derived.
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'createFingerprint',
  'replayed',
  ...MATERIAL_KEYS,
] as const;

// ---------------------------------------------------------------------------
// Serialization — the marketplace response vocabulary (presentation only)
// ---------------------------------------------------------------------------

function serializeTrustEvent(event: TrustEventRecord): Record<string, unknown> {
  return {
    eventId: event.eventId,
    appKey: event.appKey,
    transitionSeq: event.transitionSeq,
    transition: event.transition,
    fromState: event.fromState,
    toState: event.toState,
    reason: event.reason,
    provenance: {
      recordedActor: event.recordedActor,
      recordedVia: event.recordedVia,
      correlationId: event.correlationId,
      ...(event.causationId === null ? {} : { causationId: event.causationId }),
      recordedAt: event.recordedAt,
    },
    idempotencyKey: event.idempotencyKey,
    createFingerprint: event.createFingerprint,
  };
}

function serializeReview(review: AppReviewRecord): Record<string, unknown> {
  return {
    reviewId: review.reviewId,
    appKey: review.appKey,
    ...(review.appVersionId === null ? {} : { appVersionId: review.appVersionId }),
    rating: review.rating,
    verdict: review.verdict,
    body: review.body,
    provenance: {
      recordedActor: review.recordedActor,
      recordedVia: review.recordedVia,
      correlationId: review.correlationId,
      ...(review.causationId === null ? {} : { causationId: review.causationId }),
      recordedAt: review.recordedAt,
    },
    idempotencyKey: review.idempotencyKey,
    createFingerprint: review.createFingerprint,
  };
}

function serializeEntry(entry: MarketplaceAppEntry): Record<string, unknown> {
  return {
    appKey: entry.appKey,
    // SERVER-DERIVED registry publisher identity (never a request field).
    publisher: entry.publisher,
    publisherKind: entry.publisherKind,
    latestVersion: entry.latestVersion === null ? null : {
      appVersionId: entry.latestVersion.appVersionId,
      version: entry.latestVersion.version,
      publishedAt: entry.latestVersion.publishedAt,
      capabilities: entry.latestVersion.capabilities,
      runtimeClass: entry.latestVersion.runtimeClass,
    },
    // Version visibility: the full immutable registry version history.
    versions: entry.versions.map((version) => ({
      appVersionId: version.appVersionId,
      version: version.version,
      publishedAt: version.publishedAt,
      capabilities: version.capabilities,
      runtimeClass: version.runtimeClass,
    })),
    trustState: {
      appKey: entry.trustState.appKey,
      trustLevel: entry.trustState.trustLevel,
      ...(entry.trustState.sinceEventId === null
        ? {}
        : { sinceEventId: entry.trustState.sinceEventId }),
      transitionCount: entry.trustState.transitionCount,
    },
    reviewSummary: {
      reviewCount: entry.reviewSummary.reviewCount,
      ...(entry.reviewSummary.averageRating === null
        ? {}
        : { averageRating: entry.reviewSummary.averageRating }),
      verdictCounts: entry.reviewSummary.verdictCounts,
      ...(entry.reviewSummary.lastReviewAt === null
        ? {}
        : { lastReviewAt: entry.reviewSummary.lastReviewAt }),
    },
  };
}

function serializeDetail(detail: MarketplaceAppDetail): Record<string, unknown> {
  return {
    entry: serializeEntry(detail.entry),
    trustEvents: detail.trustEvents.map(serializeTrustEvent),
    reviews: detail.reviews.map(serializeReview),
  };
}

function serializeEligibility(eligibility: MarketplacePolicyEligibility): Record<string, unknown> {
  return {
    appKey: eligibility.appKey,
    trustLevel: eligibility.trustLevel,
    ...(eligibility.trustSinceEventId === null
      ? {}
      : { trustSinceEventId: eligibility.trustSinceEventId }),
    transitionCount: eligibility.transitionCount,
    reviewState: {
      reviewCount: eligibility.reviewState.reviewCount,
      ...(eligibility.reviewState.averageRating === null
        ? {}
        : { averageRating: eligibility.reviewState.averageRating }),
      ...(eligibility.reviewState.lastReviewAt === null
        ? {}
        : { lastReviewAt: eligibility.reviewState.lastReviewAt }),
    },
    // The POLICY-CONSUMABLE VOCABULARY (the /policies action-attribute
    // shape — the exact keys operator rules match).
    policyAttributes: eligibility.policyAttributes,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAppMarketplaceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('app-marketplace.api');
  const marketplace: AppMarketplaceModuleApi = modules.appMarketplace;

  /** SERVER-DERIVED provenance (the extensions route precedent). */
  function serverProvenance(principal: Principal): {
    readonly actor: string;
    readonly recordedVia: string;
    readonly correlationId: string;
    readonly causationId: string | null;
  } {
    const correlation = currentCorrelation();
    return {
      actor: auditActor(principal),
      recordedVia: 'api',
      correlationId: correlation.correlationId,
      causationId: correlation.causationId,
    };
  }

  /** The SERVER-DERIVED identity from the authenticated principal. */
  function actorId(principal: Principal): string | null {
    return principal.kind === 'user' ? principal.userId : null;
  }

  /**
   * The agency-scoped discovery posture (the command-center precedent):
   * the durable agency row and the caller's membership resolve from
   * durable state BEFORE any dependent traversal. A malformed, unknown
   * or FOREIGN agency identifier is the uniform 404 (cross-agency data
   * must 404, not 403-leak existence); a caller with an ACTIVE
   * membership passes (any agency role — the read posture of every
   * agency-scoped read surface); a SUSPENDED membership or a disabled
   * identity is the 403 (an authenticated-but-intra-tenant failure);
   * anonymous calls are 401 at the authenticator (fail closed).
   */
  async function requireMarketplaceAgency(
    principal: Principal,
    agencyId: string,
  ): Promise<void> {
    if (!UUID_PATTERN.test(agencyId)) {
      // A malformed identifier is indistinguishable from an unknown one.
      throw new NotFoundError('agency', agencyId);
    }
    const agency = await modules.agencies.getAgency(agencyId);
    if (agency === null) {
      throw new NotFoundError('agency', agencyId);
    }
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (context.platformRoles.includes('platform_administrator')) return;
    const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
    if (membership === undefined) {
      // Hard boundary: not a member of the OWNING agency → the same 404
      // as for an unknown agency (uniform, no cross-agency oracle).
      throw new NotFoundError('agency', agencyId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in this agency required');
    }
  }

  /**
   * The OPERATOR/GOVERNANCE gate for trust transitions (AC-2 — not
   * community self-service): the platform administrator role or the
   * internal service principal. A platform_developer is explicitly
   * INSUFFICIENT — a developer can never self-certify (the MKT-047
   * certification-territory contract, disclosed in the runbook).
   */
  async function requireTrustOperator(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    if (principal.kind !== 'user') {
      throw new ForbiddenError('Active user identity required');
    }
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (!context.platformRoles.includes('platform_administrator')) {
      throw new ForbiddenError(
        'Recording an app trust transition requires the platform_administrator role (operator/governance territory — a platform_developer can never self-certify)',
      );
    }
  }

  /** Any ACTIVE authenticated member (the global-catalog read posture). */
  async function requireActiveMember(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
  }

  /**
   * Parses + validates the discovery query filters (the strict DTO
   * posture applied to the query string): every key must be a known
   * filter; every value a bounded/closed-vocabulary scalar. Unknown
   * query keys are rejected 422 (surface hygiene — the module guard
   * re-fences the shapes).
   */
  function parseListingFilters(path: string): {
    readonly category: string | null;
    readonly trustLevel: AppCertificationState | null;
    readonly publisherKind: 'first-party' | 'community' | null;
    readonly search: string | null;
  } {
    const query = path.split('?')[1] ?? '';
    const params = new URLSearchParams(query);
    const allowed = new Set(['category', 'trustLevel', 'publisherKind', 'search']);
    const problems: string[] = [];
    for (const key of params.keys()) {
      if (!allowed.has(key)) {
        problems.push(`${key}: unknown filter (allowed: category, trustLevel, publisherKind, search)`);
      }
    }
    const category = params.get('category');
    if (category !== null && (category.length < 1 || category.length > 64)) {
      problems.push('category: must be 1-64 characters');
    }
    const trustLevel = params.get('trustLevel');
    if (trustLevel !== null && !TRUST_LEVEL_PATTERN.test(trustLevel)) {
      problems.push('trustLevel: must be UNVERIFIED, COMMUNITY_VERIFIED or MOS_CERTIFIED');
    }
    const publisherKind = params.get('publisherKind');
    if (publisherKind !== null && !PUBLISHER_KIND_PATTERN.test(publisherKind)) {
      problems.push('publisherKind: must be first-party or community');
    }
    const search = params.get('search');
    if (search !== null && (search.length < 1 || search.length > 64)) {
      problems.push('search: must be 1-64 characters');
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('marketplace listing filters failed validation', problems);
    }
    return {
      category,
      trustLevel: trustLevel === null ? null : (trustLevel as AppCertificationState),
      publisherKind: publisherKind === null ? null : (publisherKind as 'first-party' | 'community'),
      search,
    };
  }

  /** A well-formed app key or the uniform 404 (malformed ≡ unknown). */
  function requireAppKeyShape(appKey: string): void {
    if (!KEY_PATTERN.test(appKey)) {
      throw new NotFoundError('app', appKey);
    }
  }

  /**
   * An optional uuid field that accepts an EXPLICIT null (the "no
   * value" form — a review's absent version target) in addition to
   * omission.
   */
  function nullableUuidField(): FieldSpec<string | null | undefined> {
    return {
      required: false,
      parse: (value, problems) => {
        if (value === undefined) return undefined;
        if (value === null) return null;
        if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
          problems.push('must be a uuid or null');
          return null;
        }
        return value;
      },
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/app-marketplace/apps/:appKey/trust — record ONE trust
  // transition (the OPERATOR/GOVERNANCE command — platform territory).
  // REGISTERED FIRST: the literal 'apps' segment sits in the :agencyId
  // position of the discovery family (the jobs-queue first-match-wins
  // precedent; the different segment counts make shadowing impossible
  // either way — registered first for determinism).
  // -------------------------------------------------------------------------

  type ValidatedTrust = {
    readonly transition: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  };

  router.add(
    'POST',
    '/api/app-marketplace/apps/:appKey/trust',
    defineMutationRoute<{ appKey: string }, { event: TrustEventRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        // PLATFORM TERRITORY (AC-2): the operator/governance gate. The
        // §8 command identity and the provenance are resolved in
        // execute from the SAME authenticated principal — never request
        // fields; authorization runs BEFORE validate/execute.
        await requireTrustOperator(ctx.principal);
      },
      validate: (ctx) =>
        validateObject<ValidatedTrust>(ctx.request.body, {
          forbiddenKeys: MARKETPLACE_AUTHORITY_FIELDS,
          fields: {
            transition: stringField({ pattern: TRANSITION_PATTERN }),
            reason: stringField({ minLength: 1, maxLength: 512 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedTrust;
        return marketplace.recordTrustTransition(
          {
            appKey: ctx.params.appKey,
            transition: body.transition as 'verify' | 'certify' | 'decertify' | 'revoke',
            reason: body.reason,
            idempotencyKey: body.idempotencyKey,
            actorId: actorId(ctx.principal),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('app-marketplace.trust.transitioned', undefined, {
          app_key: ctx.params.appKey,
          event_id: ctx.result.event.eventId,
          transition: ctx.result.event.transition,
          from_state: ctx.result.event.fromState,
          to_state: ctx.result.event.toState,
          transition_seq: ctx.result.event.transitionSeq,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'app-marketplace.trust.transitioned',
          targetType: 'app_trust_event',
          targetId: ctx.result.event.eventId,
          idempotencyKey: `app-marketplace.trust.transitioned:${ctx.result.event.eventId}`,
          details: {
            appKey: ctx.result.event.appKey,
            transition: ctx.result.event.transition,
            fromState: ctx.result.event.fromState,
            toState: ctx.result.event.toState,
            transitionSeq: ctx.result.event.transitionSeq,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          event: serializeTrustEvent(ctx.result.event),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/app-marketplace/apps/:appKey/reviews — record ONE
  // community review (any active member; reviewer provenance is
  // SERVER-DERIVED).
  // -------------------------------------------------------------------------

  type ValidatedReview = {
    readonly rating: number;
    readonly verdict: string;
    readonly body: string;
    readonly appVersionId: string | null | undefined;
    readonly idempotencyKey: string;
  };

  router.add(
    'POST',
    '/api/app-marketplace/apps/:appKey/reviews',
    defineMutationRoute<{ appKey: string }, { review: AppReviewRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      validate: (ctx) =>
        validateObject<ValidatedReview>(ctx.request.body, {
          forbiddenKeys: MARKETPLACE_AUTHORITY_FIELDS,
          fields: {
            rating: intField({ min: 1, max: 5 }),
            verdict: stringField({ pattern: VERDICT_PATTERN }),
            body: stringField({ minLength: 1, maxLength: 2000 }),
            appVersionId: nullableUuidField(),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedReview;
        return marketplace.recordAppReview(
          {
            appKey: ctx.params.appKey,
            appVersionId: body.appVersionId === undefined ? null : body.appVersionId,
            rating: body.rating,
            verdict: body.verdict as 'positive' | 'mixed' | 'negative',
            body: body.body,
            idempotencyKey: body.idempotencyKey,
            actorId: actorId(ctx.principal),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('app-marketplace.review.recorded', undefined, {
          app_key: ctx.params.appKey,
          review_id: ctx.result.review.reviewId,
          rating: ctx.result.review.rating,
          verdict: ctx.result.review.verdict,
          version_level: ctx.result.review.appVersionId !== null,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'app-marketplace.review.recorded',
          targetType: 'app_review',
          targetId: ctx.result.review.reviewId,
          idempotencyKey: `app-marketplace.review.recorded:${ctx.result.review.reviewId}`,
          details: {
            appKey: ctx.result.review.appKey,
            ...(ctx.result.review.appVersionId === null
              ? {}
              : { appVersionId: ctx.result.review.appVersionId }),
            rating: ctx.result.review.rating,
            verdict: ctx.result.review.verdict,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          review: serializeReview(ctx.result.review),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/app-marketplace/:agencyId/apps — the agency-scoped
  // marketplace LISTING (the discovery surface with search/filters).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-marketplace/:agencyId/apps',
    defineQueryRoute<{ agencyId: string }, readonly MarketplaceAppEntry[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step
        // never trusts anything resolved earlier in the pipeline (the
        // house posture of the other read surfaces).
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
        const filters = parseListingFilters(ctx.request.path);
        return marketplace.listMarketplaceApps(filters);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          apps: ctx.result.map(serializeEntry),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/app-marketplace/:agencyId/apps/:appKey — the marketplace
  // app DETAIL (registry version history + derived trust + the tails).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-marketplace/:agencyId/apps/:appKey',
    defineQueryRoute<{ agencyId: string; appKey: string }, MarketplaceAppDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
        // A malformed app key is the uniform 404 (malformed ≡ unknown).
        requireAppKeyShape(ctx.params.appKey);
        const detail = await marketplace.getMarketplaceApp(ctx.params.appKey);
        if (detail === null) {
          throw new NotFoundError('app', ctx.params.appKey);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/app-marketplace/:agencyId/apps/:appKey/policy-eligibility
  // — the POLICY ELIGIBILITY read-side query (AC-5): the derived trust
  // level + review state in the policy-consumable vocabulary.
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/app-marketplace/:agencyId/apps/:appKey/policy-eligibility',
    defineQueryRoute<{ agencyId: string; appKey: string }, MarketplacePolicyEligibility>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        await requireMarketplaceAgency(ctx.principal, ctx.params.agencyId);
        requireAppKeyShape(ctx.params.appKey);
        const eligibility = await marketplace.resolvePolicyEligibility(ctx.params.appKey);
        if (eligibility === null) {
          throw new NotFoundError('app', ctx.params.appKey);
        }
        return eligibility;
      },
      respond: (ctx) => jsonResponse(200, serializeEligibility(ctx.result)),
    }),
  );
}
