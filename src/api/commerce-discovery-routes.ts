/**
 * /api/growth-missions/:missionId/commerce-discovery/* routes (MKT-072 —
 * the Commerce Discovery Mission surface).
 *
 *   POST /api/growth-missions/:missionId/commerce-discovery/plan                       compose (or convergently replay) the program (owner|admin; the durable references + the declared bounded-spend bounds + the REQUIRED reason)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/plan                       the composed honest read-back (any active member of the owning agency)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/plan/versions              the append-only version tail (any active member)
 *   POST /api/growth-missions/:missionId/commerce-discovery/candidates                 record one provenance-cited candidate (owner|admin)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/candidates                 the candidates with citations (any active member)
 *   POST /api/growth-missions/:missionId/commerce-discovery/demand-tests               launch one demand test THROUGH the experiments authority (owner|admin; fail-closed budget pre-gate)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/demand-tests               the demand tests (any active member)
 *   POST /api/growth-missions/:missionId/commerce-discovery/demand-tests/:demandTestId/conclusion  record the conclusion read-back (owner|admin)
 *   POST /api/growth-missions/:missionId/commerce-discovery/outcomes                   record one learning-loop outcome over REAL order events (owner|admin)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/outcomes                   the outcomes (any active member)
 *   POST /api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations      evaluate the economic guardrails (owner|admin)
 *   GET  /api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations      the evaluations (any active member)
 *   POST /api/growth-missions/:missionId/commerce-discovery/guardrail-blocked/resolve  resolve a guardrail block by re-evaluation (owner|admin)
 *   POST /api/growth-missions/:missionId/commerce-discovery/conclude                   the honest terminal conclude (owner|admin)
 *   POST /api/growth-missions/:missionId/commerce-discovery/stop                       the honest terminal stop (owner|admin)
 *   GET  /api/growth-missions/:missionId/commerce-discovery                            the full program read-back (any active member)
 *
 * SURFACE DISCIPLINE (the boundary battery): GET/POST ONLY — no PUT, no
 * PATCH, no DELETE (asserted by
 * tests/architecture/commerce-discovery-boundary.test.ts). Program
 * corrections are NEW version records; candidates/outcomes/evaluations are
 * append-only; the demand-test conclusion is the single guarded advance.
 * NO listing/store-mutation verb, NO provider call, NO scheduler/timer/
 * loop verb exists anywhere in this family — the listing recommendation
 * is DATA toward a human decision (lock rules 32/33; boundary rule 8).
 *
 * Server-derived scope posture (implementation-contract §3/§23; the
 * growth-missions/product-marketing precedents): every surface resolves
 * the caller's authorization context and the canonical scope from durable
 * state BEFORE the module call; the path identifiers only SELECT which
 * durable scope gets resolved (a caller-supplied identifier is never an
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
import {
  arrayField,
  intField,
  optionalArrayField,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import { resolveContext } from './authorize.ts';
import type { OwnerScope } from '../platform/http/pipeline.ts';
import type {
  CommerceDiscoveryCandidateDetail,
  CommerceDiscoveryDetail,
  CommerceDiscoveryDemandTestRecord,
  CommerceDiscoveryGuardrailEvaluationRecord,
  CommerceDiscoveryOutcomeRecord,
  CommerceDiscoveryProvenance,
  CommerceDiscoveryVersionRecord,
} from '../modules/commerce-discovery/public.ts';
import {
  COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
  COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
  COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
} from '../modules/commerce-discovery/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_FIELD_PATTERN = new RegExp(UUID_PATTERN.source, 'i');
const CURRENCY_FIELD_PATTERN = /^[A-Za-z]{3,8}$/;

/**
 * Fields that are always server-derived (authority fields): the composed
 * plan, the observed values, the verdicts, the recommendations, the
 * citations and the provenance can never enter through a request body
 * (the fabrication-resistance discipline is structural — every command
 * input is exactly the durable references + the declared bounds + the
 * REQUIRED reason).
 */
const PROGRAM_AUTHORITY_FIELDS = [
  'discoveryMissionId',
  'discoveryVersionId',
  'versionSeq',
  'currentVersionSeq',
  'inputDigest',
  'inputSnapshot',
  'nicheSelection',
  'candidateProposals',
  'demandTestPlan',
  'economicGates',
  'decisions',
  'citations',
  'provenance',
  'observedOrderCount',
  'observedOrderValues',
  'viabilityVerdict',
  'listingRecommendation',
  'verdict',
  'breachReasons',
  'experimentId',
] as const;

/** The validated compose DTO (the durable references + the declared bounds + the reason). */
type ValidatedCompose = {
  readonly productContextId: string;
  readonly pursuitWorkspaceId: string;
  readonly storeConnectionId: string;
  readonly spendCurrency: string;
  readonly testBudgetMinorUnits: number;
  readonly maxDemandTests: number;
  readonly minOrderCountForViability: number;
  readonly reason: string;
};

/** The validated candidate DTO (the descriptor + the provenance citations). */
type ValidatedCandidate = {
  readonly label: string;
  readonly niche: string;
  readonly subNiche: string | undefined;
  readonly productDescriptor: string;
  readonly estimatedCostMinorUnits: number;
  readonly estimatedPriceMinorUnits: number;
  readonly economicsCurrency: string;
  readonly demandHypothesis: string;
  readonly productDerivedModelIds: string[];
  readonly contentCandidateIds: string[];
  readonly contentHypothesisIds: string[];
};

/** The validated demand-test launch DTO. */
type ValidatedDemandTestLaunch = {
  readonly candidateId: string;
  readonly testSpendMinorUnits: number;
  readonly reason: string;
};

/** The validated outcome DTO (the REAL event references + the reason). */
type ValidatedOutcome = {
  readonly candidateId: string;
  readonly commerceEventIds: string[];
  readonly metricObservationIds: string[] | undefined;
  readonly reason: string;
};

/** The validated reason-only DTO (the guarded commands). */
type ValidatedReason = {
  readonly reason: string;
};

// ---------------------------------------------------------------------------
// Server-derived provenance (never a request field)
// ---------------------------------------------------------------------------

function serverProvenance(principal: Principal): CommerceDiscoveryProvenance {
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

function serializeVersion(version: CommerceDiscoveryVersionRecord): Record<string, unknown> {
  return {
    discoveryVersionId: version.discoveryVersionId,
    discoveryMissionId: version.discoveryMissionId,
    versionSeq: version.versionSeq,
    productContextId: version.productContextId,
    productContextVersionId: version.productContextVersionId,
    storeConnectionId: version.storeConnectionId,
    declared: { ...version.declared },
    reason: version.reason,
    inputSnapshot: version.inputSnapshot,
    inputDigest: version.inputDigest,
    nicheSelection: [...version.nicheSelection],
    candidateProposals: [...version.candidateProposals],
    demandTestPlan: { ...version.demandTestPlan },
    economicGates: { ...version.economicGates },
    decisions: [...version.decisions],
    strategyVersion: version.strategyVersion,
    provenance: { ...version.provenance },
    createdAt: version.createdAt,
  };
}

function serializeProgram(program: CommerceDiscoveryDetail['mission']): Record<string, unknown> {
  return {
    discoveryMissionId: program.discoveryMissionId,
    missionId: program.missionId,
    agencyId: program.agencyId,
    clientId: program.clientId,
    workspaceId: program.workspaceId,
    status: program.status,
    currentVersionSeq: program.currentVersionSeq,
    version: program.version,
    createdAt: program.createdAt,
    updatedAt: program.updatedAt,
  };
}

function serializeCandidate(detail: CommerceDiscoveryCandidateDetail): Record<string, unknown> {
  return {
    candidate: { ...detail.candidate, provenance: { ...detail.candidate.provenance } },
    citations: [...detail.citations],
    recommendationDisclosure: detail.recommendationDisclosure,
  };
}

function serializeDemandTest(test: CommerceDiscoveryDemandTestRecord): Record<string, unknown> {
  return {
    demandTestId: test.demandTestId,
    discoveryMissionId: test.discoveryMissionId,
    candidateId: test.candidateId,
    missionId: test.missionId,
    agencyId: test.agencyId,
    clientId: test.clientId,
    experimentId: test.experimentId,
    testSpendMinorUnits: test.testSpendMinorUnits,
    spendCurrency: test.spendCurrency,
    derivedExperimentDesign: test.derivedExperimentDesign,
    state: test.state,
    conclusionResultState: test.conclusionResultState,
    conclusionUncertaintyRepresentation: test.conclusionUncertaintyRepresentation,
    conclusionRecordedAt: test.conclusionRecordedAt,
    provenance: { ...test.provenance },
    createdAt: test.createdAt,
  };
}

function serializeOutcome(outcome: CommerceDiscoveryOutcomeRecord): Record<string, unknown> {
  return {
    outcomeId: outcome.outcomeId,
    discoveryMissionId: outcome.discoveryMissionId,
    candidateId: outcome.candidateId,
    missionId: outcome.missionId,
    agencyId: outcome.agencyId,
    clientId: outcome.clientId,
    observedOrderCount: outcome.observedOrderCount,
    observedCancelledOrderCount: outcome.observedCancelledOrderCount,
    observedOrderValues: outcome.observedOrderValues,
    viabilityVerdict: outcome.viabilityVerdict,
    listingRecommendation: outcome.listingRecommendation,
    rationale: outcome.rationale,
    reason: outcome.reason,
    provenance: { ...outcome.provenance },
    createdAt: outcome.createdAt,
  };
}

function serializeEvaluation(
  evaluation: CommerceDiscoveryGuardrailEvaluationRecord,
): Record<string, unknown> {
  return {
    evaluationId: evaluation.evaluationId,
    discoveryMissionId: evaluation.discoveryMissionId,
    missionId: evaluation.missionId,
    agencyId: evaluation.agencyId,
    clientId: evaluation.clientId,
    evaluated: { ...evaluation.evaluated },
    observed: { ...evaluation.observed },
    verdict: evaluation.verdict,
    breachReasons: [...evaluation.breachReasons],
    rationale: evaluation.rationale,
    reason: evaluation.reason,
    provenance: { ...evaluation.provenance },
    createdAt: evaluation.createdAt,
  };
}

function serializeDetail(detail: CommerceDiscoveryDetail): Record<string, unknown> {
  return {
    mission: serializeProgram(detail.mission),
    currentVersion: serializeVersion(detail.currentVersion),
    versions: detail.versions.map(serializeVersion),
    candidates: detail.candidates.map(serializeCandidate),
    demandTests: detail.demandTests.map(serializeDemandTest),
    outcomes: detail.outcomes.map(serializeOutcome),
    guardrailEvaluations: detail.guardrailEvaluations.map(serializeEvaluation),
    history: detail.history.map((event) => ({
      eventId: event.eventId,
      eventSeq: event.eventSeq,
      eventKind: event.eventKind,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      detail: event.detail,
      provenance: { ...event.provenance },
    })),
    orderTruthDisclosure: detail.orderTruthDisclosure,
    recommendationDisclosure: detail.recommendationDisclosure,
    attributionDisclosure: detail.attributionDisclosure,
    guardrailDisclosure: detail.guardrailDisclosure,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerCommerceDiscoveryRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('commerce-discovery.api');

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
  // POST /api/growth-missions/:missionId/commerce-discovery/plan — THE
  // COMPOSE COMMAND (owner|admin): the deterministic pure core over the
  // consumed public contracts (READ-ONLY), appended as ONE immutable
  // version record with its FK-anchored citation links. The body is
  // exactly the durable references + the declared bounded-spend bounds +
  // the REQUIRED reason; every authority-shaped field is rejected.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/plan',
    defineMutationRoute<
      { missionId: string },
      { readonly detail: CommerceDiscoveryDetail; readonly appended: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedCompose>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            productContextId: stringField({ pattern: UUID_FIELD_PATTERN }),
            pursuitWorkspaceId: stringField({ pattern: UUID_FIELD_PATTERN }),
            storeConnectionId: stringField({ pattern: UUID_FIELD_PATTERN }),
            spendCurrency: stringField({ pattern: CURRENCY_FIELD_PATTERN }),
            testBudgetMinorUnits: intField({ min: 0, max: 2000000000 }),
            maxDemandTests: intField({ min: 1, max: 50 }),
            minOrderCountForViability: intField({ min: 1, max: 1000 }),
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedCompose;
        const priorProgram = await modules.commerceDiscovery.getCommerceDiscoveryMission(
          ctx.params.missionId,
        );
        const priorSeq = priorProgram === null ? 0 : priorProgram.currentVersionSeq;
        const detail = await modules.commerceDiscovery.composeCommerceDiscoveryPlan(
          {
            missionId: ctx.params.missionId,
            productContextId: body.productContextId,
            pursuitWorkspaceId: body.pursuitWorkspaceId,
            storeConnectionId: body.storeConnectionId,
            declared: {
              spendCurrency: body.spendCurrency,
              testBudgetMinorUnits: body.testBudgetMinorUnits,
              maxDemandTests: body.maxDemandTests,
              minOrderCountForViability: body.minOrderCountForViability,
            },
            reason: body.reason,
          },
          serverProvenance(ctx.principal),
        );
        return { detail, appended: detail.mission.currentVersionSeq !== priorSeq };
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.plan.composed', undefined, {
          mission_id: ctx.params.missionId,
          discovery_mission_id: ctx.result.detail.mission.discoveryMissionId,
          version_seq: ctx.result.detail.mission.currentVersionSeq,
          appended: ctx.result.appended,
          input_digest: ctx.result.detail.currentVersion.inputDigest,
          citation_count: ctx.result.detail.currentVersion.nicheSelection.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.plan.composed',
          targetType: 'commerce_discovery_program',
          targetId: ctx.result.detail.mission.discoveryMissionId,
          afterVersion: ctx.result.detail.mission.currentVersionSeq,
          idempotencyKey: `commercediscovery.plan.composed:${ctx.result.detail.currentVersion.discoveryVersionId}`,
          details: {
            missionId: ctx.params.missionId,
            versionSeq: ctx.result.detail.mission.currentVersionSeq,
            appended: ctx.result.appended,
            testBudgetMinorUnits: ctx.result.detail.currentVersion.declared.testBudgetMinorUnits,
            maxDemandTests: ctx.result.detail.currentVersion.declared.maxDemandTests,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.appended ? 201 : 200, serializeDetail(ctx.result.detail)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery/plan — the
  // composed honest read-back (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/plan',
    defineQueryRoute<{ missionId: string }, CommerceDiscoveryDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const detail = await modules.commerceDiscovery.getCommerceDiscoveryDetail(
          ctx.params.missionId,
        );
        if (detail === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery/plan/versions —
  // the append-only version tail (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/plan/versions',
    defineQueryRoute<
      { missionId: string },
      readonly CommerceDiscoveryVersionRecord[] | null
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const versions = await modules.commerceDiscovery.getCommerceDiscoveryVersions(
          ctx.params.missionId,
        );
        if (versions === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return versions;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          versions: (ctx.result ?? []).map(serializeVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/commerce-discovery/candidates —
  // record one provenance-cited candidate (owner|admin).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/candidates',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryCandidateDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedCandidate>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            label: stringField({ minLength: 1, maxLength: 200 }),
            niche: stringField({ minLength: 1, maxLength: 200 }),
            subNiche: optionalString({ minLength: 1, maxLength: 200 }),
            productDescriptor: stringField({ minLength: 1, maxLength: 2000 }),
            estimatedCostMinorUnits: intField({ min: 0, max: 2000000000 }),
            estimatedPriceMinorUnits: intField({ min: 0, max: 2000000000 }),
            economicsCurrency: stringField({ pattern: CURRENCY_FIELD_PATTERN }),
            demandHypothesis: stringField({ minLength: 1, maxLength: 2000 }),
            productDerivedModelIds: arrayField({
              maxItems: 16,
              item: stringField({ pattern: UUID_FIELD_PATTERN }),
            }),
            contentCandidateIds: arrayField({
              maxItems: 32,
              item: stringField({ pattern: UUID_FIELD_PATTERN }),
            }),
            contentHypothesisIds: arrayField({
              maxItems: 32,
              item: stringField({ pattern: UUID_FIELD_PATTERN }),
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedCandidate;
        return modules.commerceDiscovery.recordCommerceDiscoveryCandidate(
          {
            missionId: ctx.params.missionId,
            label: body.label,
            niche: body.niche,
            subNiche: body.subNiche ?? null,
            productDescriptor: body.productDescriptor,
            estimatedCostMinorUnits: body.estimatedCostMinorUnits,
            estimatedPriceMinorUnits: body.estimatedPriceMinorUnits,
            economicsCurrency: body.economicsCurrency,
            demandHypothesis: body.demandHypothesis,
            productDerivedModelIds: body.productDerivedModelIds,
            contentCandidateIds: body.contentCandidateIds,
            contentHypothesisIds: body.contentHypothesisIds,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.candidate.recorded', undefined, {
          mission_id: ctx.params.missionId,
          candidate_id: ctx.result.candidate.candidateId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.candidate.recorded',
          targetType: 'commerce_discovery_candidate',
          targetId: ctx.result.candidate.candidateId,
          idempotencyKey: `commercediscovery.candidate.recorded:${ctx.result.candidate.candidateId}`,
          details: {
            missionId: ctx.params.missionId,
            citationCount: ctx.result.citations.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeCandidate(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery/candidates —
  // the candidates with citations (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/candidates',
    defineQueryRoute<
      { missionId: string },
      readonly CommerceDiscoveryCandidateDetail[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const program = await modules.commerceDiscovery.getCommerceDiscoveryDetail(
          ctx.params.missionId,
        );
        if (program === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return program.candidates;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          candidates: ctx.result.map(serializeCandidate),
          recommendationDisclosure: COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/commerce-discovery/demand-tests —
  // launch one demand test THROUGH the experiments authority (owner|admin;
  // the fail-closed budget pre-gate refuses over-budget launches).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/demand-tests',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryDemandTestRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedDemandTestLaunch>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            candidateId: stringField({ pattern: UUID_FIELD_PATTERN }),
            testSpendMinorUnits: intField({ min: 0, max: 2000000000 }),
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedDemandTestLaunch;
        return modules.commerceDiscovery.launchCommerceDiscoveryDemandTest(
          {
            missionId: ctx.params.missionId,
            candidateId: body.candidateId,
            testSpendMinorUnits: body.testSpendMinorUnits,
            reason: body.reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.demandtest.launched', undefined, {
          mission_id: ctx.params.missionId,
          demand_test_id: ctx.result.demandTestId,
          experiment_id: ctx.result.experimentId,
          test_spend_minor_units: ctx.result.testSpendMinorUnits,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.demandtest.launched',
          targetType: 'commerce_discovery_demand_test',
          targetId: ctx.result.demandTestId,
          idempotencyKey: `commercediscovery.demandtest.launched:${ctx.result.demandTestId}`,
          details: {
            missionId: ctx.params.missionId,
            experimentId: ctx.result.experimentId,
            testSpendMinorUnits: ctx.result.testSpendMinorUnits,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeDemandTest(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery/demand-tests —
  // the demand tests (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/demand-tests',
    defineQueryRoute<
      { missionId: string },
      readonly CommerceDiscoveryDemandTestRecord[] | null
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const tests = await modules.commerceDiscovery.listCommerceDiscoveryDemandTests(
          ctx.params.missionId,
        );
        if (tests === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return tests;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          demandTests: (ctx.result ?? []).map(serializeDemandTest),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST .../demand-tests/:demandTestId/conclusion — the conclusion
  // read-back from the experiments authority (owner|admin).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/demand-tests/:demandTestId/conclusion',
    defineMutationRoute<{ missionId: string; demandTestId: string }, CommerceDiscoveryDemandTestRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedReason>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        return modules.commerceDiscovery.recordCommerceDiscoveryDemandTestConclusion(
          {
            missionId: ctx.params.missionId,
            demandTestId: ctx.params.demandTestId,
            reason: (ctx.validated as ValidatedReason).reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.demandtest.concluded', undefined, {
          mission_id: ctx.params.missionId,
          demand_test_id: ctx.result.demandTestId,
          experiment_id: ctx.result.experimentId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.demandtest.concluded',
          targetType: 'commerce_discovery_demand_test',
          targetId: ctx.result.demandTestId,
          idempotencyKey: `commercediscovery.demandtest.concluded:${ctx.result.demandTestId}`,
          details: {
            missionId: ctx.params.missionId,
            experimentId: ctx.result.experimentId,
            conclusionResultState: ctx.result.conclusionResultState ?? '',
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDemandTest(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/growth-missions/:missionId/commerce-discovery/outcomes —
  // record one learning-loop outcome over REAL order events (owner|admin).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/outcomes',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryOutcomeRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) => validateObject<ValidatedOutcome>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            candidateId: stringField({ pattern: UUID_FIELD_PATTERN }),
            commerceEventIds: arrayField({
              minItems: 1,
              maxItems: 128,
              item: stringField({ pattern: UUID_FIELD_PATTERN }),
            }),
            metricObservationIds: optionalArrayField(
              {
                maxItems: 64,
                item: stringField({ pattern: UUID_FIELD_PATTERN }),
              },
            ),
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedOutcome;
        return modules.commerceDiscovery.recordCommerceDiscoveryOutcome(
          {
            missionId: ctx.params.missionId,
            candidateId: body.candidateId,
            commerceEventIds: body.commerceEventIds,
            metricObservationIds: body.metricObservationIds ?? [],
            reason: body.reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.outcome.recorded', undefined, {
          mission_id: ctx.params.missionId,
          outcome_id: ctx.result.outcomeId,
          observed_order_count: ctx.result.observedOrderCount,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.outcome.recorded',
          targetType: 'commerce_discovery_outcome',
          targetId: ctx.result.outcomeId,
          idempotencyKey: `commercediscovery.outcome.recorded:${ctx.result.outcomeId}`,
          details: {
            missionId: ctx.params.missionId,
            candidateId: ctx.result.candidateId,
            observedOrderCount: ctx.result.observedOrderCount,
            viabilityVerdict: ctx.result.viabilityVerdict,
            listingRecommendation: ctx.result.listingRecommendation,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          ...serializeOutcome(ctx.result),
          orderTruthDisclosure: COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
          attributionDisclosure: COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery/outcomes — the
  // outcomes (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/outcomes',
    defineQueryRoute<
      { missionId: string },
      readonly CommerceDiscoveryOutcomeRecord[] | null
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const outcomes = await modules.commerceDiscovery.listCommerceDiscoveryOutcomes(
          ctx.params.missionId,
        );
        if (outcomes === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return outcomes;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          outcomes: (ctx.result ?? []).map(serializeOutcome),
          orderTruthDisclosure: COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
          attributionDisclosure: COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST .../guardrail-evaluations — evaluate the economic guardrails
  // (owner|admin; a breach produces the honest guardrail_blocked state).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations',
    defineMutationRoute<
      { missionId: string },
      { readonly evaluation: CommerceDiscoveryGuardrailEvaluationRecord; readonly blocked: boolean }
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
        validateObject<ValidatedReason>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        const evaluation = await modules.commerceDiscovery.evaluateCommerceDiscoveryGuardrails(
          {
            missionId: ctx.params.missionId,
            reason: (ctx.validated as ValidatedReason).reason,
          },
          serverProvenance(ctx.principal),
        );
        const program = await modules.commerceDiscovery.getCommerceDiscoveryMission(
          ctx.params.missionId,
        );
        return {
          evaluation,
          blocked: program !== null && program.status === 'guardrail_blocked',
        };
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.guardrail.evaluated', undefined, {
          mission_id: ctx.params.missionId,
          evaluation_id: ctx.result.evaluation.evaluationId,
          verdict: ctx.result.evaluation.verdict,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.guardrail.evaluated',
          targetType: 'commerce_discovery_evaluation',
          targetId: ctx.result.evaluation.evaluationId,
          idempotencyKey: `commercediscovery.guardrail.evaluated:${ctx.result.evaluation.evaluationId}`,
          details: {
            missionId: ctx.params.missionId,
            verdict: ctx.result.evaluation.verdict,
            observedSpendMinorUnits: ctx.result.evaluation.observed.spendMinorUnits,
            observedDemandTestCount: ctx.result.evaluation.observed.demandTestCount,
            observedOrderCount: ctx.result.evaluation.observed.orderCount,
            blocked: ctx.result.blocked,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          ...serializeEvaluation(ctx.result.evaluation),
          programBlocked: ctx.result.blocked,
          guardrailDisclosure: COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET .../guardrail-evaluations — the evaluations (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery/guardrail-evaluations',
    defineQueryRoute<
      { missionId: string },
      readonly CommerceDiscoveryGuardrailEvaluationRecord[] | null
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const evaluations = await modules.commerceDiscovery.listCommerceDiscoveryGuardrailEvaluations(
          ctx.params.missionId,
        );
        if (evaluations === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return evaluations;
      },
      respond: (ctx) =>
        jsonResponse(200, {
          missionId: ctx.params.missionId,
          guardrailEvaluations: (ctx.result ?? []).map(serializeEvaluation),
          guardrailDisclosure: COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST .../guardrail-blocked/resolve — resolve a guardrail block by
  // re-evaluation (owner|admin; never a silent lift).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/guardrail-blocked/resolve',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedReason>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        return modules.commerceDiscovery.resolveCommerceDiscoveryGuardrailBlock(
          {
            missionId: ctx.params.missionId,
            reason: (ctx.validated as ValidatedReason).reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.guardrail.resolved', undefined, {
          mission_id: ctx.params.missionId,
          discovery_mission_id: ctx.result.mission.discoveryMissionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.guardrail.resolved',
          targetType: 'commerce_discovery_program',
          targetId: ctx.result.mission.discoveryMissionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `commercediscovery.guardrail.resolved:${ctx.result.mission.discoveryMissionId}:${ctx.result.mission.version}`,
          details: {
            missionId: ctx.params.missionId,
            status: ctx.result.mission.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST .../conclude — the honest terminal conclude (owner|admin).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/conclude',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedReason>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        return modules.commerceDiscovery.setCommerceDiscoveryStatus(
          {
            missionId: ctx.params.missionId,
            status: 'concluded',
            reason: (ctx.validated as ValidatedReason).reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.program.concluded', undefined, {
          mission_id: ctx.params.missionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.program.concluded',
          targetType: 'commerce_discovery_program',
          targetId: ctx.result.mission.discoveryMissionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `commercediscovery.program.concluded:${ctx.result.mission.discoveryMissionId}:${ctx.result.mission.version}`,
          details: {
            missionId: ctx.params.missionId,
            status: ctx.result.mission.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST .../stop — the honest terminal stop (owner|admin).
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/growth-missions/:missionId/commerce-discovery/stop',
    defineMutationRoute<{ missionId: string }, CommerceDiscoveryDetail>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => missionOwner(params.missionId),
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedReason>(ctx.request.body, {
          forbiddenKeys: PROGRAM_AUTHORITY_FIELDS,
          fields: {
            reason: stringField({ minLength: 1, maxLength: 4000 }),
          },
        }),
      execute: async (ctx) => {
        return modules.commerceDiscovery.setCommerceDiscoveryStatus(
          {
            missionId: ctx.params.missionId,
            status: 'stopped_by_user',
            reason: (ctx.validated as ValidatedReason).reason,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('commercediscovery.program.stopped', undefined, {
          mission_id: ctx.params.missionId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'commercediscovery.program.stopped',
          targetType: 'commerce_discovery_program',
          targetId: ctx.result.mission.discoveryMissionId,
          afterVersion: ctx.result.mission.version,
          idempotencyKey: `commercediscovery.program.stopped:${ctx.result.mission.discoveryMissionId}:${ctx.result.mission.version}`,
          details: {
            missionId: ctx.params.missionId,
            status: ctx.result.mission.status,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/growth-missions/:missionId/commerce-discovery — the full
  // program read-back (any active member; the golden path in one view).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/growth-missions/:missionId/commerce-discovery',
    defineQueryRoute<{ missionId: string }, CommerceDiscoveryDetail>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireMissionAccess(ctx.principal, ctx.params.missionId);
      },
      execute: async (ctx) => {
        const detail = await modules.commerceDiscovery.getCommerceDiscoveryDetail(
          ctx.params.missionId,
        );
        if (detail === null) {
          throw new NotFoundError('commerce discovery program', ctx.params.missionId);
        }
        return detail;
      },
      respond: (ctx) => jsonResponse(200, serializeDetail(ctx.result)),
    }),
  );
}
