/**
 * /api/clients/:clientId/experiment-analysis/* routes (MKT-067 — the
 * Experiment Analysis and Adaptive Allocation surface).
 *
 *   POST  /api/clients/:clientId/experiment-analysis/analyses                        record one analysis (owner|admin) — the deterministic two-sample computation over the /metrics window
 *   GET   /api/clients/:clientId/experiment-analysis/analyses                        the client's analyses (any active member)
 *   GET   /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId   the experiment's sequential analysis tail (any active member)
 *   GET   /api/clients/:clientId/experiment-analysis/analyses/:analysisId           one analysis + its full input snapshot (any active member)
 *   POST  /api/clients/:clientId/experiment-analysis/allocations                     record one allocation recommendation (owner|admin) — the deterministic bounded allocator
 *   GET   /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId  the experiment's recommendation tail (any active member)
 *   GET   /api/clients/:clientId/experiment-analysis/allocations/:recommendationId  one recommendation + its full input snapshot (any active member)
 *
 * Literal-segment routes (by-experiment) are registered BEFORE the
 * :analysisId / :recommendationId patterns: the literal segments sit in
 * the parameter position and the router resolves first-match-wins (the
 * jobs-queue / content-rights precedent).
 *
 * There is deliberately NO update route (recorded analyses and
 * recommendations are immutable — the migration 054 triggers reject it at
 * the database), NO delete route (both tails are append-only — a
 * negative or inconclusive result is preserved, never erased) and NO
 * route of ANY kind that mutates experiment exposure, platform state or
 * workflow inputs (the no-second-execution-engine boundary: allocation
 * results are recommendations recorded as DATA toward the
 * mission/operator layer; the /experiments authority stays sole for
 * experiment lifecycle — its own conclude transition belongs to its own
 * routes).
 *
 * AUTHORITY FIELDS ARE NEVER REQUEST-SUPPLIABLE: the DTOs reject
 * identity/ownership/outcome/provenance fields AND every material-shaped
 * key (§21). Computed outcomes (effect estimates, uncertainty,
 * sequential state, the outcome, the recommended allocation, the
 * computed shares, the digests, the rationale) have NO input surface at
 * all — they are derived exclusively by the deterministic module core
 * from the consumed public-contract data. The tenant scope chain is
 * server-derived from the canonical /clients ownership resolution.
 *
 * Authorization follows the established hard-boundary posture: every
 * route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /clients chain; the record-scoped
 * routes additionally resolve canonical analysis/recommendation
 * ownership and yield a UNIFORM 404 for unknown/foreign/mismatched
 * identifiers — no cross-tenant oracle) and authorizes against the
 * SAME /agencies membership authority as every other scoped check.
 */

import { NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import {
  arrayField,
  intField,
  numberField,
  objectField,
  optionalArrayField,
  optionalInt,
  optionalNumber,
  optionalString,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { ApplicationModules } from './application.ts';
import { requireClientAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  AllocationRecommendationRecord,
  ExperimentAnalysisRecord,
  ExperimentAnalysisProvenance,
} from '../modules/experiment-analysis/public.ts';
import {
  EXPERIMENT_ANALYSIS_DEFAULT_PRACTICAL_THRESHOLD,
  EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
} from '../modules/experiment-analysis/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ARM_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const ARM_KIND_PATTERN = /^(treatment|comparison|strategy_variant|human_treatment)$/;
const UNCERTAINTY_LEVEL_PATTERN = /^(0\.9|0\.95|0\.99)$/;

/**
 * Fields always server-derived on the experiment-analysis surfaces —
 * plus every material-shaped key is rejected (§21: nothing secret can
 * even be smuggled into an analysis or an allocation; evidence arrives
 * as /evidence REFERENCES resolved through the evidence authority,
 * never as inline payloads).
 */
const EXPERIMENT_ANALYSIS_AUTHORITY_FIELDS = [
  // Server-derived identity/ownership/outcome.
  'analysisId',
  'recommendationId',
  'agencyId',
  'clientId',
  'analysisMethod',
  'analysisMethodVersion',
  'vocabularyVersion',
  'outcome',
  'resultState',
  'effectEstimate',
  'standardError',
  'uncertainty',
  'sequentialState',
  'confounders',
  'limitations',
  'recommendedNextAllocation',
  'sampleSizes',
  'treatmentMean',
  'comparisonMean',
  'inputSnapshot',
  'inputDigest',
  'allocation',
  'shares',
  'eligibleArms',
  'zeroCapacityArms',
  'humanTreatmentConsideration',
  'explorationShare',
  'rationale',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'createdAt',
  'updatedAt',
  'observationWindowStart',
  'observationWindowEnd',
  'metricObservationRefs',
  'learningRefs',
  // Material-shaped keys are rejected outright on every surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialMaterial',
] as const;
// NOTE: `workspaceId` is deliberately NOT on the forbidden list — it is
// the OPTIONAL workspace narrowing of the record inputs (the
// content-rights authorize-start precedent): the route validates it
// against canonical workspace ownership BEFORE the module call, so it
// is a validated selection input, never a server-authoritative value
// the caller could forge.

/**
 * SERVER-DERIVED provenance for HTTP-surface experiment-analysis
 * mutations: actor from the authenticated principal, correlation from
 * the ambient correlation context, recording surface 'api'. No value in
 * here is reachable from the request body (every DTO rejects
 * provenance-shaped keys).
 */
function serverProvenance(principal: Principal): ExperimentAnalysisProvenance {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (presentation only; every field of the record ships)
// ---------------------------------------------------------------------------

function serializeProvenance(
  provenance: ExperimentAnalysisRecord['provenance'],
): Record<string, unknown> {
  return {
    actor: provenance.actor,
    recordedVia: provenance.recordedVia,
    correlationId: provenance.correlationId,
    ...(provenance.causationId === null ? {} : { causationId: provenance.causationId }),
    recordedAt: provenance.recordedAt,
  };
}

function serializeAnalysis(analysis: ExperimentAnalysisRecord): Record<string, unknown> {
  return {
    analysisId: analysis.analysisId,
    clientId: analysis.clientId,
    ...(analysis.workspaceId === null ? {} : { workspaceId: analysis.workspaceId }),
    experimentId: analysis.experimentId,
    analysisMethod: analysis.analysisMethod,
    analysisMethodVersion: analysis.analysisMethodVersion,
    vocabularyVersion: analysis.vocabularyVersion,
    observationWindowStart: analysis.observationWindowStart,
    observationWindowEnd: analysis.observationWindowEnd,
    sampleSizes: analysis.sampleSizes,
    ...(analysis.treatmentMean === null ? {} : { treatmentMean: analysis.treatmentMean }),
    ...(analysis.comparisonMean === null ? {} : { comparisonMean: analysis.comparisonMean }),
    ...(analysis.effectEstimate === null ? {} : { effectEstimate: analysis.effectEstimate }),
    ...(analysis.standardError === null ? {} : { standardError: analysis.standardError }),
    uncertainty: analysis.uncertainty,
    sequentialState: analysis.sequentialState,
    confounders: analysis.confounders,
    limitations: analysis.limitations,
    practicalThreshold: analysis.practicalThreshold,
    outcome: analysis.outcome,
    recommendedNextAllocation: analysis.recommendedNextAllocation,
    inputSnapshot: analysis.inputSnapshot,
    inputDigest: analysis.inputDigest,
    evidenceRefs: analysis.evidenceRefs,
    metricObservationRefs: analysis.metricObservationRefs,
    learningRefs: analysis.learningRefs,
    provenance: serializeProvenance(analysis.provenance),
  };
}

function serializeRecommendation(
  recommendation: AllocationRecommendationRecord,
): Record<string, unknown> {
  return {
    recommendationId: recommendation.recommendationId,
    clientId: recommendation.clientId,
    ...(recommendation.workspaceId === null ? {} : { workspaceId: recommendation.workspaceId }),
    experimentId: recommendation.experimentId,
    ...(recommendation.analysisId === null ? {} : { analysisId: recommendation.analysisId }),
    vocabularyVersion: recommendation.vocabularyVersion,
    arms: recommendation.arms,
    allocation: recommendation.allocation,
    explorationFloor: recommendation.explorationFloor,
    explorationFloorSource: recommendation.explorationFloorSource,
    inputSnapshot: recommendation.inputSnapshot,
    inputDigest: recommendation.inputDigest,
    rationale: recommendation.rationale,
    provenance: serializeProvenance(recommendation.provenance),
  };
}

/** The validated analysis DTO. */
type ValidatedAnalysisBody = {
  readonly experimentId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly uncertaintyLevel: string | undefined;
  readonly minObservationsPerArm: number | undefined;
  readonly practicalThreshold: number | undefined;
  readonly practicalThresholdDescription: string | undefined;
  readonly declaredConfounders: string[] | undefined;
  readonly declaredLimitations: string[] | undefined;
  readonly evidenceRefs: string[] | undefined;
  readonly workspaceId: string | undefined;
};

/** The validated arm entry of the allocation DTO. */
type ValidatedArmBody = {
  readonly armKey: string;
  readonly kind: string;
  readonly capacity: number;
  readonly sampleSize: number;
  readonly mean: number;
  readonly variance: number;
};

/** The validated allocation DTO. */
type ValidatedAllocationBody = {
  readonly experimentId: string;
  readonly analysisId: string | undefined;
  readonly explorationFloor: number | undefined;
  readonly arms: ValidatedArmBody[];
  readonly workspaceId: string | undefined;
};

/** Per-arm authority keys rejected inside the nested arm objects (§21 + computed fields). */
const ARM_AUTHORITY_FIELDS = [
  'share',
  'score',
  'signal',
  'eligible',
  'excluded',
  'reason',
  'provenance',
  'secret',
  'password',
  'token',
  'apiKey',
] as const;

export function registerExperimentAnalysisRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('experiment-analysis.api');

  /** Canonical client owner scope; 404 BEFORE dependent traversal. */
  async function clientOwner(clientId: string): Promise<OwnerScope> {
    const ownership = await modules.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    return {
      kind: 'client',
      agencyId: ownership.client.agencyId,
      clientId: ownership.client.clientId,
    };
  }

  /**
   * The canonical ANALYSIS owner resolution for every record-scoped
   * route: the module resolves the record + its owning chain; a record
   * that does not exist, or that belongs to ANOTHER Client than the
   * path's, is the SAME uniform 404 (a foreign identifier is not a
   * traversal oracle). Malformed ids are the same uniform 404.
   */
  async function requireAnalysisInClient(analysisId: string, clientId: string) {
    if (!UUID_PATTERN.test(analysisId)) {
      throw new NotFoundError('experiment_analysis_record', analysisId);
    }
    const ownership = await modules.experimentAnalysis.resolveExperimentAnalysisOwnership(analysisId);
    if (ownership === null || ownership.analysis.clientId !== clientId) {
      throw new NotFoundError('experiment_analysis_record', analysisId);
    }
    return ownership;
  }

  /**
   * The canonical RECOMMENDATION owner resolution (the same uniform-404
   * discipline as the analysis resolution).
   */
  async function requireRecommendationInClient(recommendationId: string, clientId: string) {
    if (!UUID_PATTERN.test(recommendationId)) {
      throw new NotFoundError('experiment_allocation_recommendation', recommendationId);
    }
    const ownership =
      await modules.experimentAnalysis.resolveAllocationRecommendationOwnership(recommendationId);
    if (ownership === null || ownership.recommendation.clientId !== clientId) {
      throw new NotFoundError('experiment_allocation_recommendation', recommendationId);
    }
    return ownership;
  }

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/experiment-analysis/analyses — record one
  // analysis (owner|admin): the deterministic two-sample computation over
  // the /metrics observation window. Every computed field (effects,
  // uncertainty, sequential state, outcome, the recommended allocation)
  // is derived server-side; the DTO carries only the declared inputs.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/experiment-analysis/analyses',
    defineMutationRoute<{ clientId: string }, ExperimentAnalysisRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedAnalysisBody>(ctx.request.body, {
          forbiddenKeys: EXPERIMENT_ANALYSIS_AUTHORITY_FIELDS,
          fields: {
            experimentId: stringField({ pattern: UUID_PATTERN }),
            windowStart: stringField({
              pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
            }),
            windowEnd: stringField({
              pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
            }),
            uncertaintyLevel: optionalString({ pattern: UNCERTAINTY_LEVEL_PATTERN }),
            minObservationsPerArm: optionalInt({ min: 1, max: 10000 }),
            practicalThreshold: optionalNumber({ min: 0 }),
            practicalThresholdDescription: optionalString({ minLength: 1, maxLength: 500 }),
            declaredConfounders: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 1, maxLength: 500 }),
            }),
            declaredLimitations: optionalArrayField({
              maxItems: 50,
              item: stringField({ minLength: 1, maxLength: 500 }),
            }),
            evidenceRefs: optionalArrayField({
              maxItems: 50,
              item: stringField({ pattern: UUID_PATTERN }),
            }),
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedAnalysisBody;
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        // The recorded practical threshold: a declared value rides with
        // source 'declared_input'; the absence of one resolves to the
        // module's recorded default (source 'module_default_v1') — the
        // threshold is DATA either way.
        const thresholdValue = body.practicalThreshold ?? EXPERIMENT_ANALYSIS_DEFAULT_PRACTICAL_THRESHOLD;
        return modules.experimentAnalysis.recordExperimentAnalysis(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            experimentId: body.experimentId,
            windowStart: body.windowStart,
            windowEnd: body.windowEnd,
            uncertaintyLevel:
              body.uncertaintyLevel === undefined
                ? null
                : (Number(body.uncertaintyLevel) as 0.9 | 0.95 | 0.99),
            minObservationsPerArm: body.minObservationsPerArm ?? null,
            practicalThreshold: {
              value: thresholdValue,
              source: body.practicalThreshold === undefined ? 'module_default_v1' : 'declared_input',
              description: body.practicalThresholdDescription ?? null,
            },
            declaredConfounders: body.declaredConfounders ?? [],
            declaredLimitations: body.declaredLimitations ?? [],
            evidenceRefs: body.evidenceRefs ?? [],
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('experiment_analysis.recorded', undefined, {
          client_id: ctx.params.clientId,
          analysis_id: ctx.result.analysisId,
          experiment_id: ctx.result.experimentId,
          outcome: ctx.result.outcome,
          input_digest: ctx.result.inputDigest,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'experiment_analysis.recorded',
          targetType: 'experiment_analysis_record',
          targetId: ctx.result.analysisId,
          idempotencyKey: null,
          details: {
            experimentId: ctx.result.experimentId,
            outcome: ctx.result.outcome,
            recommendedNextAllocation: ctx.result.recommendedNextAllocation,
            inputDigest: ctx.result.inputDigest,
            sampleSizes: `${ctx.result.sampleSizes.treatment}/${ctx.result.sampleSizes.comparison}`,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          analysis: serializeAnalysis(ctx.result),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiment-analysis/analyses — the
  // client's analyses, newest first (any active member).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiment-analysis/analyses',
    defineQueryRoute<{ clientId: string }, readonly ExperimentAnalysisRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.experimentAnalysis.listExperimentAnalysesForClient(ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          analyses: ctx.result.map(serializeAnalysis),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId
  // — the experiment's sequential analysis tail, oldest first (any active
  // member; the experiment anchor resolves canonically — uniform 404 on
  // foreign identifiers).
  // Registered BEFORE the :analysisId pattern (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId',
    defineQueryRoute<
      { clientId: string; experimentId: string },
      readonly ExperimentAnalysisRecord[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.experimentAnalysis.listExperimentAnalysesForExperiment(
          ctx.params.clientId,
          ctx.params.experimentId,
        ),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          experimentId: ctx.params.experimentId,
          analyses: ctx.result.map(serializeAnalysis),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiment-analysis/analyses/:analysisId
  // — one analysis with its FULL input snapshot (any active member;
  // uniform 404 for unknown/foreign identifiers).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiment-analysis/analyses/:analysisId',
    defineQueryRoute<
      { clientId: string; analysisId: string },
      Awaited<ReturnType<typeof requireAnalysisInClient>>
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        requireAnalysisInClient(ctx.params.analysisId, ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          analysis: serializeAnalysis(ctx.result.analysis),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/clients/:clientId/experiment-analysis/allocations — record
  // one adaptive-allocation recommendation (owner|admin): the
  // deterministic bounded exploration/exploitation allocator over the
  // declared arms. The computed shares are derived server-side; the DTO
  // carries only the declared arms and the (optional) exploration floor.
  // -------------------------------------------------------------------------
  router.add(
    'POST',
    '/api/clients/:clientId/experiment-analysis/allocations',
    defineMutationRoute<{ clientId: string }, AllocationRecommendationRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => clientOwner(params.clientId),
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedAllocationBody>(ctx.request.body, {
          forbiddenKeys: EXPERIMENT_ANALYSIS_AUTHORITY_FIELDS,
          fields: {
            experimentId: stringField({ pattern: UUID_PATTERN }),
            analysisId: optionalString({ pattern: UUID_PATTERN }),
            explorationFloor: optionalNumber({ min: 0.000001, max: 0.5 }),
            arms: arrayField({
              minItems: 1,
              maxItems: 16,
              item: objectField({
                forbiddenKeys: ARM_AUTHORITY_FIELDS,
                fields: {
                  armKey: stringField({ pattern: ARM_KEY_PATTERN }),
                  kind: stringField({ pattern: ARM_KIND_PATTERN }),
                  capacity: intField({ min: 0 }),
                  sampleSize: intField({ min: 0 }),
                  mean: numberField(),
                  variance: numberField({ min: 0 }),
                },
              }),
            }),
            workspaceId: optionalString({ pattern: UUID_PATTERN }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedAllocationBody;
        if (body.workspaceId !== undefined) {
          await requireWorkspaceAccess(modules, ctx.principal, body.workspaceId);
        }
        const ownership = await modules.clients.resolveClientOwnership(ctx.params.clientId);
        if (ownership === null) {
          throw new NotFoundError('client', ctx.params.clientId);
        }
        return modules.experimentAnalysis.recordAllocationRecommendation(
          {
            clientId: ctx.params.clientId,
            workspaceId: body.workspaceId ?? null,
            experimentId: body.experimentId,
            analysisId: body.analysisId ?? null,
            explorationFloor: body.explorationFloor === undefined ? null : body.explorationFloor,
            arms: body.arms.map((arm) => ({
              armKey: arm.armKey,
              kind: arm.kind as
                | 'treatment'
                | 'comparison'
                | 'strategy_variant'
                | 'human_treatment',
              capacity: arm.capacity,
              sampleSize: arm.sampleSize,
              mean: arm.mean,
              variance: arm.variance,
            })),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('experiment_allocation.recorded', undefined, {
          client_id: ctx.params.clientId,
          recommendation_id: ctx.result.recommendationId,
          experiment_id: ctx.result.experimentId,
          eligible_arms: ctx.result.allocation.eligibleArms.length,
          exploration_floor: ctx.result.explorationFloor,
          input_digest: ctx.result.inputDigest,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'experiment_allocation.recommended',
          targetType: 'experiment_allocation_recommendation',
          targetId: ctx.result.recommendationId,
          idempotencyKey: null,
          details: {
            experimentId: ctx.result.experimentId,
            eligibleArms: ctx.result.allocation.eligibleArms.join(','),
            zeroCapacityArms: ctx.result.allocation.zeroCapacityArms
              .map((arm) => arm.armKey)
              .join(','),
            explorationFloor: ctx.result.explorationFloor,
            explorationFloorSource: ctx.result.explorationFloorSource,
            inputDigest: ctx.result.inputDigest,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          recommendation: serializeRecommendation(ctx.result),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId
  // — the experiment's recommendation tail, oldest first (any active
  // member; the experiment anchor resolves canonically — uniform 404 on
  // foreign identifiers).
  // Registered BEFORE the :recommendationId pattern (first-match-wins).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId',
    defineQueryRoute<
      { clientId: string; experimentId: string },
      readonly AllocationRecommendationRecord[]
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        modules.experimentAnalysis.listAllocationRecommendationsForExperiment(
          ctx.params.clientId,
          ctx.params.experimentId,
        ),
      respond: (ctx) =>
        jsonResponse(200, {
          clientId: ctx.params.clientId,
          experimentId: ctx.params.experimentId,
          recommendations: ctx.result.map(serializeRecommendation),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/clients/:clientId/experiment-analysis/allocations/:recommendationId
  // — one recommendation with its FULL input snapshot (any active member;
  // uniform 404 for unknown/foreign identifiers).
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/clients/:clientId/experiment-analysis/allocations/:recommendationId',
    defineQueryRoute<
      { clientId: string; recommendationId: string },
      Awaited<ReturnType<typeof requireRecommendationInClient>>
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientAccess(modules, ctx.principal, ctx.params.clientId);
      },
      execute: async (ctx) =>
        requireRecommendationInClient(ctx.params.recommendationId, ctx.params.clientId),
      respond: (ctx) =>
        jsonResponse(200, {
          recommendation: serializeRecommendation(ctx.result.recommendation),
          vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
        }),
    }),
  );
}
