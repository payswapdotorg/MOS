/**
 * /api/growth-missions/:missionId/product-marketing/* routes (MKT-070 —
 * the Product Marketing Mission Planner surface).
 *
 *   POST /api/growth-missions/:missionId/product-marketing/plan          compose (or convergently replay) the plan (owner|admin; the durable references + the REQUIRED reason)
 *   GET  /api/growth-missions/:missionId/product-marketing/plan          the composed honest read-back (any active member of the owning agency)
 *   GET  /api/growth-missions/:missionId/product-marketing/plan/versions the append-only version tail (any active member)
 *
 * SURFACE DISCIPLINE (the boundary battery): GET/POST ONLY — no PUT, no
 * PATCH, no DELETE (asserted by
 * tests/architecture/product-marketing-boundary.test.ts). Plan corrections
 * are NEW version records (POST .../plan with the changed inputs + the
 * REQUIRED reason); there is NO in-place rewrite surface. NO
 * scheduler/timer/loop verb, NO provider call and NO experiment-creation
 * verb exists anywhere in this family — the planner is the deterministic,
 * auditable DECISION layer (the Growth Operator MKT-054 owns the bounded
 * delegation).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * growth-missions precedent): every surface resolves the caller's
 * authorization context and the canonical scope from durable state
 * BEFORE the module call; the path identifiers only SELECT which durable
 * scope gets resolved (a caller-supplied identifier is never an
 * authorization). Uniform 404 for foreign/unknown/malformed mission
 * identifiers (no existence oracle — foreign ≡ unknown ≡ malformed); a
 * suspended membership or disabled identity is the 403; anonymous calls
 * fail closed 401 at the authenticator. Provenance is SERVER-DERIVED from
 * the authenticated principal + the ambient correlation context (never a
 * request field; the DTOs reject every provenance-shaped key). The audit
 * details carry ONLY scalar values (the append-guard discipline).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import { optionalString, stringField, validateObject, type FieldSpec } from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { resolveContext } from './authorize.ts';
import type { OwnerScope } from '../platform/http/pipeline.ts';
import type {
  ProductMarketingPlanDetail,
  ProductMarketingPlanVersionRecord,
  ProductMarketingProvenance,
} from '../modules/product-marketing/public.ts';
import {
  PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
  PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
  PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
} from '../modules/product-marketing/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELD_PATTERN = new RegExp(UUID_PATTERN.source, 'i');

/** An optional uuid that also accepts an explicit JSON null (= absent). */
function nullableUuidField(): FieldSpec<string | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === null || value === undefined) return undefined;
      return optionalString({ pattern: UUID_FIELD_PATTERN }).parse(value, problems);
    },
  };
}

/** The validated compose DTO (exactly the durable references + the reason). */
type ValidatedCompose = {
  readonly productContextId: string;
  readonly pursuitWorkspaceId: string;
  readonly researchSessionId: string | undefined;
  readonly reason: string;
};

/**
 * Fields that are always server-derived (authority fields): the composed
 * plan, its digest, its citations and its provenance can never enter
 * through a request body (the fabrication-resistance discipline is
 * structural — the compose input is exactly the durable references + the
 * REQUIRED reason).
 */
const PLAN_AUTHORITY_FIELDS = [
  'planId',
  'planVersionId',
  'versionSeq',
  'currentVersionSeq',
  'inputDigest',
  'inputSnapshot',
  'platformPortfolio',
  'metricPlan',
  'contentStrategy',
  'attributionPlan',
  'experimentPlan',
  'decisions',
  'citations',
  'provenance',
  'goalRefs',
] as const;

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): ProductMarketingProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (the honest read-back shapes)
// ---------------------------------------------------------------------------

function serializeVersion(version: ProductMarketingPlanVersionRecord): Record<string, unknown> {
  return {
    planVersionId: version.planVersionId,
    planId: version.planId,
    versionSeq: version.versionSeq,
    productContextId: version.productContextId,
    productContextVersionId: version.productContextVersionId,
    researchSessionId: version.researchSessionId,
    reason: version.reason,
    inputSnapshot: version.inputSnapshot,
    inputDigest: version.inputDigest,
    platformPortfolio: [...version.platformPortfolio],
    metricPlan: [...version.metricPlan],
    contentStrategy: version.contentStrategy,
    attributionPlan: version.attributionPlan,
    experimentPlan: version.experimentPlan,
    decisions: [...version.decisions],
    strategyVersion: version.strategyVersion,
    provenance: { ...version.provenance },
    createdAt: version.createdAt,
  };
}

function serializeDetail(detail: ProductMarketingPlanDetail): Record<string, unknown> {
  return {
    plan: {
      planId: detail.plan.planId,
      missionId: detail.plan.missionId,
      agencyId: detail.plan.agencyId,
      clientId: detail.plan.clientId,
      workspaceId: detail.plan.workspaceId,
      currentVersionSeq: detail.plan.currentVersionSeq,
      version: detail.plan.version,
      createdAt: detail.plan.createdAt,
      updatedAt: detail.plan.updatedAt,
    },
    currentVersion: serializeVersion(detail.currentVersion),
    versions: detail.versions.map(serializeVersion),
    citations: [...detail.citations],
    attributionDisclosure: detail.attributionDisclosure,
    experimentDisclosure: detail.experimentDisclosure,
    evidenceTierDisclosure: detail.evidenceTierDisclosure,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProductMarketingRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('product-marketing.api');

  /**
   * The mission-scoped posture (the growth-missions route precedent): the
   * canonical mission ownership resolves from durable state BEFORE
   * authorization — a malformed/unknown mission identifier is the uniform
   * 404; a caller with NO membership in the OWNING agency gets the SAME
   * 404 (a foreign mission is not a traversal/existence oracle); a
   * suspended membership is the 403. Returns the owning agency id for the
   * pipeline owner scope.
   */
  async function requireMissionAccess(
    principal: Principal,
    missionId: string,
    roles?: ReadonlyArray<string>,
  ): Promise<string> {
    if (!UUID_PATTERN.test(missionId)) {
      throw new NotFoundError('mission', missionId);
    }
    const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(missionId);
    if (ownership === null) {
      throw new NotFoundError('mission', missionId);
    }
    const agencyId = ownership.mission.agencyId;

    if (principal.kind === 'service') return agencyId;

    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (context.platformRoles.includes('platform_administrator')) return agencyId;

    const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
    if (membership === undefined) {
      throw new NotFoundError('mission', missionId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in the mission agency required');
    }
    if (roles !== undefined && !roles.includes(membership.role)) {
      throw new ForbiddenError('This operation requires a different agency role');
    }
    return agencyId;
  }

  async function missionOwner(missionId: string): Promise<OwnerScope> {
    const ownership = await modules.growthMissions.resolveGrowthMissionOwnership(missionId);
    if (ownership === null) {
      throw new NotFoundError('mission', missionId);
    }
    return {
      kind: 'agency',
      agencyId: ownership.mission.agencyId,
    };
  }

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/product-marketing/plan — THE
  // COMPOSE COMMAND (owner|admin): the deterministic pure core over the
  // consumed public contracts (READ-ONLY), appended as ONE immutable plan
  // version with its FK-anchored citation links. The body is exactly the
  // durable references + the REQUIRED reason; every authority-shaped
  // field is rejected (there is NO route, field or parameter through
  // which a caller-declared portfolio, metric, verdict or citation could
  // enter a plan).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/product-marketing/plan',
    defineMutationRoute<
      { missionId: string },
      { readonly detail: ProductMarketingPlanDetail; readonly appended: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedCompose>(ctx.request.body, {
          forbiddenKeys: PLAN_AUTHORITY_FIELDS,
          fields: {
            productContextId: stringField({ pattern: UUID_FIELD_PATTERN }),
            pursuitWorkspaceId: stringField({ pattern: UUID_FIELD_PATTERN }),
            researchSessionId: nullableUuidField(),
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedCompose;
        // The replay-vs-append marker rides the route-local result
        // envelope (the honest status: a converged replay returns the
        // EXISTING version — 200; a new append — 201).
        const priorPlan = await modules.productMarketing.getProductMarketingPlan(
          ctx.params.missionId,
        );
        const priorSeq = priorPlan === null ? 0 : priorPlan.currentVersionSeq;
        const detail = await modules.productMarketing.composeProductMarketingPlan(
          {
            missionId: ctx.params.missionId,
            productContextId: body.productContextId,
            pursuitWorkspaceId: body.pursuitWorkspaceId,
            researchSessionId: body.researchSessionId ?? null,
            reason: body.reason,
          },
          serverProvenance(ctx.principal),
        );
        return { detail, appended: detail.plan.currentVersionSeq !== priorSeq };
      },
      emit: async (ctx) => {
        logger.info('productmarketing.plan.composed', undefined, {
          mission_id: ctx.params.missionId,
          plan_id: ctx.result.detail.plan.planId,
          version_seq: ctx.result.detail.plan.currentVersionSeq,
          appended: ctx.result.appended,
          input_digest: ctx.result.detail.currentVersion.inputDigest,
          citation_count: ctx.result.detail.citations.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'productmarketing.plan.composed',
          targetType: 'product_marketing_plan',
          targetId: ctx.result.detail.plan.planId,
          afterVersion: ctx.result.detail.plan.currentVersionSeq,
          idempotencyKey: `productmarketing.plan.composed:${ctx.result.detail.currentVersion.planVersionId}`,
          details: {
            missionId: ctx.params.missionId,
            versionSeq: ctx.result.detail.plan.currentVersionSeq,
            // The append guard requires scalar detail values: the citation
            // families ride as the deterministic comma-joined kind list.
            citationKinds: [...new Set(ctx.result.detail.citations.map((c) => c.kind))].join(','),
            citationCount: ctx.result.detail.citations.length,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.appended ? 201 : 200, serializeDetail(ctx.result.detail)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/product-marketing/plan — the
  // composed honest read-back (any active member of the owning agency;
  // uniform 404 for unknown/foreign mission identifiers or a mission with
  // no plan yet).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/product-marketing/plan',
    defineQueryRoute<{ missionId: string }, ProductMarketingPlanDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const detail = await modules.productMarketing.getProductMarketingPlanDetail(
          ctx.params.missionId,
        );
        if (detail === null) {
          throw new NotFoundError('product marketing plan', ctx.params.missionId);
        }
        return detail;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          ...serializeDetail(ctx.result),
          attributionDisclosure: PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
          experimentDisclosure: PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
          evidenceTierDisclosure: PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/product-marketing/plan/versions —
  // the append-only version tail (any active member of the owning agency).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/product-marketing/plan/versions',
    defineQueryRoute<{ missionId: string }, readonly ProductMarketingPlanVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const versions = await modules.productMarketing.getProductMarketingPlanVersions(
          ctx.params.missionId,
        );
        if (versions === null) {
          throw new NotFoundError('product marketing plan', ctx.params.missionId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          versions: ctx.result.map(serializeVersion),
        }),
    }),
  );
}
