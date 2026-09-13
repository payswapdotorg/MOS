/**
 * /ai-runtime API routes (MKT-017 — AI task profile and model registry:
 * AI-001, acceptance AI-AC-01..02; MKT-018 — routing: AI-002; MKT-019 —
 * evaluation framework: AI-003, acceptance AI-AC-08).
 *
 *   POST  /api/workspaces/:workspaceId/ai/task-profiles        register TaskProfile (owner|admin|platform admin)
 *   GET   /api/workspaces/:workspaceId/ai/task-profiles        list the Workspace's profiles in ALL states (any active member)
 *   GET   /api/ai/task-profiles/:taskProfileId                 read (member of the owning agency; retired history stays visible)
 *   POST  /api/ai/task-profiles/:taskProfileId/retire          single lifecycle edge, CAS (owner|admin|platform admin)
 *
 *   POST  /api/ai/models                                       register registry model (platform admin only)
 *   GET   /api/ai/models                                       list ACTIVE entries (any authenticated principal — catalog data)
 *   GET   /api/ai/models/:modelRegistryId                      read (any authenticated; retired history stays visible)
 *   POST  /api/ai/models/:modelRegistryId/retire               single lifecycle edge, CAS (platform admin only)
 *   POST  /api/ai/models/:modelRegistryId/observations         append availability/telemetry observation (platform admin only)
 *   GET   /api/ai/models/:modelRegistryId/observations         append-only history, oldest first (any authenticated)
 *
 *   POST  /api/workspaces/:workspaceId/ai/usage-telemetry      append usage telemetry (owner|admin|platform admin)
 *   GET   /api/workspaces/:workspaceId/ai/usage-telemetry      list the Workspace's telemetry, newest first (any active member)
 *   GET   /api/ai/usage-telemetry/:usageId                     read (member of the owning agency)
 *
 *   POST  /api/ai/evaluators                                   register evaluator registry entry (platform admin only) — MKT-019
 *   GET   /api/ai/evaluators                                   list ACTIVE entries (any authenticated — catalog data) — MKT-019
 *   GET   /api/ai/evaluators/:evaluatorRegistryId              read (any authenticated; retired history stays visible) — MKT-019
 *   POST  /api/ai/evaluators/:evaluatorRegistryId/retire       single lifecycle edge, CAS (platform admin only) — MKT-019
 *
 *   POST  /api/workspaces/:workspaceId/ai/evaluations          run one evaluation of a TaskProfile's evaluator contract
 *                                                               (owner|admin; BUILT-IN evaluators only — caller-supplied
 *                                                               engines are a module-level composition, never an HTTP
 *                                                               input) — MKT-019
 *   GET   /api/workspaces/:workspaceId/ai/evaluations          list the Workspace's evaluation records (any active member) — MKT-019
 *   GET   /api/ai/evaluations/:evaluationId                    read (member of the owning agency) — MKT-019
 *
 *   POST  /api/workspaces/:workspaceId/ai/review-requests      record a human-review request (owner|admin) — MKT-019
 *   GET   /api/workspaces/:workspaceId/ai/review-requests      list the Workspace's review requests (any active member) — MKT-019
 *   GET   /api/ai/review-requests/:reviewRequestId             read with transition history (member of the owning agency) — MKT-019
 *   POST  /api/ai/review-requests/:reviewRequestId/decide      record the single review decision (owner|admin) — MKT-019
 *
 * The TaskProfile surface is the PROVIDER-NEUTRAL request contract
 * (AI-AC-01): request DTOs REJECT provider/model/credential-shaped keys —
 * domain requests may never carry a provider or model selection. The model
 * registry surface carries provider/model identity as LABELS (data), never
 * SDK imports, adapter configurations or credentials (AI-AC-02). Every
 * mutation route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute, authorizes against the SAME /agencies
 * membership authority as every other scoped check (no second authorization
 * authority) and rejects every server-derived authority field caller-side.
 * Cross-tenant and unknown identifiers yield a UNIFORM 404 (no
 * traversal/existence oracle).
 *
 * MKT-019 AI-AC-08 posture: the evaluation surfaces reject
 * BUSINESS-OUTCOME-shaped request keys (metricId/kpiId/experimentId/...)
 * — evaluation is independent of business-outcome measurement — and the
 * evaluation request DTO can never select evaluators (derived from the
 * TaskProfile contract) nor fabricate outcomes (verdict/score/dimensions
 * are evaluator-computed and module-recorded). The review-request surface
 * records human-review INTENT/OUTCOME only — humans act through /jobs.
 */

import { ConflictError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  intField,
  numberField,
  optionalInt,
  optionalNumber,
  optionalRecordField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import type { AgencyRoleKey } from '../modules/agencies/public.ts';
import { requirePlatformAdministrator, requireWorkspaceAccess } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  CascadeRunRecord,
  CascadeStepRecord,
  EvaluationDimension,
  EvaluationRecord,
  EvaluatorRecord,
  ModelObservationRecord,
  ModelRegistryRecord,
  ReviewRequestRecord,
  ReviewRequestTransitionRecord,
  RoutingPolicyRecord,
  SelectionDecisionRecord,
  TaskProfileRecord,
  UsageTelemetryRecord,
} from '../modules/ai-runtime/public.ts';
import {
  EVALUATION_FORBIDDEN_INPUT_KEYS,
  EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS,
  ROUTING_POLICY_FORBIDDEN_INPUT_KEYS,
  SELECTION_DECISION_FORBIDDEN_INPUT_KEYS,
  TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
  USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
} from '../modules/ai-runtime/public.ts';

const RISK_CLASS_PATTERN = /^(low|medium|high)$/;
const PRIVACY_CLASS_PATTERN = /^(public|internal|confidential|restricted)$/;
const AVAILABILITY_STATE_PATTERN = /^(available|degraded|unavailable)$/;
const USAGE_OUTCOME_PATTERN = /^(succeeded|failed|escalated|unknown)$/;
const EVALUATOR_KIND_PATTERN =
  /^(schema-validity|factuality-grounding|evidence-citation-coverage|brand-policy-compliance|domain-rubric|human-review|downstream-task-success)$/;
const REVIEW_DECISION_PATTERN = /^(approve|reject|dismiss)$/;

/** Fields always server-derived on review DECIDE (authority fields). */
const REVIEW_REQUEST_DECIDE_AUTHORITY_FIELDS = [
  'reviewRequestId',
  'workspaceId',
  'clientId',
  'agencyId',
  'executionId',
  'evaluationId',
  'reason',
  'state',
  'decidedBy',
  'decidedAt',
  'decisionNote',
  'correlationId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'version',
] as const;

const LATENCY_MS_MAX = 86_400_000;
const COST_MAX = 1_000_000_000;
const CONTEXT_TOKENS_MAX = 10_000_000;
const TELEMETRY_LIST_DEFAULT_LIMIT = 500;

/** Fields always server-derived on TaskProfile CREATE (authority fields). */
const TASK_PROFILE_RETIRE_AUTHORITY_FIELDS = [
  'taskProfileId',
  'workspaceId',
  'clientId',
  'agencyId',
  'taskClass',
  'qualityTarget',
  'riskClass',
  'contextRequirements',
  'latencyTargetMs',
  'maxCostPerInvocation',
  'privacyClass',
  'toolRequirements',
  'outputSchema',
  'evaluatorIds',
  'escalationPolicy',
  'status',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

/** Fields always server-derived on observation APPEND (authority fields). */
const MODEL_OBSERVATION_AUTHORITY_FIELDS = [
  'observationId',
  'modelRegistryId',
  'createdBy',
  'createdAt',
] as const;

/** Fields always server-derived on model RETIRE (authority fields). */
const MODEL_RETIRE_AUTHORITY_FIELDS = [
  'modelRegistryId',
  'providerLabel',
  'modelKey',
  'displayName',
  'capabilities',
  'toolFeatures',
  'contextLimitTokens',
  'costInputPerMtok',
  'costOutputPerMtok',
  'latencyP50Ms',
  'latencyP95Ms',
  'reliability',
  'qualitySignals',
  'privacyCharacteristics',
  'availabilityState',
  'status',
  'createdBy',
  'createdAt',
  'updatedAt',
] as const;

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret registry representations)
// ---------------------------------------------------------------------------

function serializeTaskProfile(profile: TaskProfileRecord): Record<string, unknown> {
  return {
    taskProfileId: profile.taskProfileId,
    taskClass: profile.taskClass,
    qualityTarget: profile.qualityTarget,
    riskClass: profile.riskClass,
    contextRequirements: profile.contextRequirements,
    latencyTargetMs: profile.latencyTargetMs,
    maxCostPerInvocation: profile.maxCostPerInvocation,
    privacyClass: profile.privacyClass,
    toolRequirements: profile.toolRequirements,
    outputSchema: profile.outputSchema,
    evaluatorIds: profile.evaluatorIds,
    escalationPolicy: profile.escalationPolicy,
    workspaceId: profile.workspaceId,
    clientId: profile.clientId,
    agencyId: profile.agencyId,
    status: profile.status,
    idempotencyKey: profile.idempotencyKey,
    version: profile.version,
    ...(profile.createdBy === null ? {} : { createdBy: profile.createdBy }),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function serializeModel(model: ModelRegistryRecord): Record<string, unknown> {
  return {
    modelRegistryId: model.modelRegistryId,
    providerLabel: model.providerLabel,
    modelKey: model.modelKey,
    displayName: model.displayName,
    capabilities: model.capabilities,
    toolFeatures: model.toolFeatures,
    contextLimitTokens: model.contextLimitTokens,
    ...(model.costInputPerMtok === null ? {} : { costInputPerMtok: model.costInputPerMtok }),
    ...(model.costOutputPerMtok === null ? {} : { costOutputPerMtok: model.costOutputPerMtok }),
    ...(model.latencyP50Ms === null ? {} : { latencyP50Ms: model.latencyP50Ms }),
    ...(model.latencyP95Ms === null ? {} : { latencyP95Ms: model.latencyP95Ms }),
    ...(model.reliability === null ? {} : { reliability: model.reliability }),
    qualitySignals: model.qualitySignals,
    privacyCharacteristics: model.privacyCharacteristics,
    availabilityState: model.availabilityState,
    status: model.status,
    version: model.version,
    ...(model.createdBy === null ? {} : { createdBy: model.createdBy }),
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function serializeObservation(observation: ModelObservationRecord): Record<string, unknown> {
  return {
    observationId: observation.observationId,
    modelRegistryId: observation.modelRegistryId,
    availabilityState: observation.availabilityState,
    ...(observation.observedLatencyP50Ms === null ? {} : { observedLatencyP50Ms: observation.observedLatencyP50Ms }),
    ...(observation.observedLatencyP95Ms === null ? {} : { observedLatencyP95Ms: observation.observedLatencyP95Ms }),
    source: observation.source,
    ...(observation.notes === '' ? {} : { notes: observation.notes }),
    ...(observation.createdBy === null ? {} : { createdBy: observation.createdBy }),
    createdAt: observation.createdAt,
  };
}

function serializeUsageTelemetry(record: UsageTelemetryRecord): Record<string, unknown> {
  return {
    usageId: record.usageId,
    workspaceId: record.workspaceId,
    clientId: record.clientId,
    agencyId: record.agencyId,
    taskProfileId: record.taskProfileId,
    modelRegistryId: record.modelRegistryId,
    ...(record.executionId === null ? {} : { executionId: record.executionId }),
    correlationId: record.correlationId,
    outcome: record.outcome,
    latencyMs: record.latencyMs,
    costAmount: record.costAmount,
    ...(record.tokensIn === null ? {} : { tokensIn: record.tokensIn }),
    ...(record.tokensOut === null ? {} : { tokensOut: record.tokensOut }),
    ...(record.evaluationRef === null ? {} : { evaluationRef: record.evaluationRef }),
    escalationCount: record.escalationCount,
    idempotencyKey: record.idempotencyKey,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// MKT-018 (AI-002) routing serializers
// ---------------------------------------------------------------------------

function serializeRoutingPolicy(policy: RoutingPolicyRecord): Record<string, unknown> {
  return {
    routingPolicyId: policy.routingPolicyId,
    policyName: policy.policyName,
    policyContent: policy.policyContent,
    workspaceId: policy.workspaceId,
    clientId: policy.clientId,
    agencyId: policy.agencyId,
    status: policy.status,
    idempotencyKey: policy.idempotencyKey,
    version: policy.version,
    ...(policy.createdBy === null ? {} : { createdBy: policy.createdBy }),
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function serializeSelectionDecision(decision: SelectionDecisionRecord): Record<string, unknown> {
  return {
    selectionId: decision.selectionId,
    workspaceId: decision.workspaceId,
    clientId: decision.clientId,
    agencyId: decision.agencyId,
    taskProfileId: decision.taskProfileId,
    ...(decision.routingPolicyId === null ? {} : { routingPolicyId: decision.routingPolicyId }),
    eligibleSet: decision.eligibleSet,
    ranking: decision.ranking,
    tradeoff: decision.tradeoff,
    chosenModelRegistryId: decision.chosenModelRegistryId,
    ...(decision.cascadeRunId === null ? {} : { cascadeRunId: decision.cascadeRunId }),
    phaseTrace: decision.phaseTrace,
    authoritative: decision.authoritative,
    ...(decision.observedLatencyMs === null ? {} : { observedLatencyMs: decision.observedLatencyMs }),
    ...(decision.observedCostAmount === null ? {} : { observedCostAmount: decision.observedCostAmount }),
    ...(decision.evaluationRef === null ? {} : { evaluationRef: decision.evaluationRef }),
    correlationId: decision.correlationId,
    idempotencyKey: decision.idempotencyKey,
    ...(decision.createdBy === null ? {} : { createdBy: decision.createdBy }),
    createdAt: decision.createdAt,
  };
}

function serializeCascadeStep(step: CascadeStepRecord): Record<string, unknown> {
  return {
    cascadeStepId: step.cascadeStepId,
    cascadeRunId: step.cascadeRunId,
    stepIndex: step.stepIndex,
    modelRegistryId: step.modelRegistryId,
    stepType: step.stepType,
    validatorResult: step.validatorResult,
    ...(step.validatorReason === null ? {} : { validatorReason: step.validatorReason }),
    ...(step.observedLatencyMs === null ? {} : { observedLatencyMs: step.observedLatencyMs }),
    ...(step.observedCostAmount === null ? {} : { observedCostAmount: step.observedCostAmount }),
    ...(step.evaluationRef === null ? {} : { evaluationRef: step.evaluationRef }),
    outcome: step.outcome,
    createdAt: step.createdAt,
  };
}

function serializeCascadeRun(run: CascadeRunRecord): Record<string, unknown> {
  return {
    cascadeRunId: run.cascadeRunId,
    workspaceId: run.workspaceId,
    clientId: run.clientId,
    agencyId: run.agencyId,
    taskProfileId: run.taskProfileId,
    ...(run.routingPolicyId === null ? {} : { routingPolicyId: run.routingPolicyId }),
    status: run.status,
    ...(run.finalModelRegistryId === null ? {} : { finalModelRegistryId: run.finalModelRegistryId }),
    escalationCount: run.escalationCount,
    maxEscalations: run.maxEscalations,
    correlationId: run.correlationId,
    idempotencyKey: run.idempotencyKey,
    version: run.version,
    ...(run.createdBy === null ? {} : { createdBy: run.createdBy }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    cascadeSteps: run.cascadeSteps.map(serializeCascadeStep),
  };
}

// ---------------------------------------------------------------------------
// MKT-019 (AI-003) evaluation serializers
// ---------------------------------------------------------------------------

function serializeEvaluator(evaluator: EvaluatorRecord): Record<string, unknown> {
  return {
    evaluatorRegistryId: evaluator.evaluatorRegistryId,
    evaluatorKey: evaluator.evaluatorKey,
    displayName: evaluator.displayName,
    kind: evaluator.kind,
    evaluatorVersion: evaluator.evaluatorVersion,
    config: evaluator.config,
    status: evaluator.status,
    version: evaluator.version,
    ...(evaluator.createdBy === null ? {} : { createdBy: evaluator.createdBy }),
    createdAt: evaluator.createdAt,
    updatedAt: evaluator.updatedAt,
  };
}

function serializeDimension(dimension: EvaluationDimension): Record<string, unknown> {
  return {
    dimension: dimension.dimension,
    verdict: dimension.verdict,
    ...(dimension.score === null ? {} : { score: dimension.score }),
    notes: dimension.notes,
  };
}

function serializeEvaluation(evaluation: EvaluationRecord): Record<string, unknown> {
  return {
    evaluationId: evaluation.evaluationId,
    workspaceId: evaluation.workspaceId,
    clientId: evaluation.clientId,
    agencyId: evaluation.agencyId,
    taskProfileId: evaluation.taskProfileId,
    ...(evaluation.executionId === null ? {} : { executionId: evaluation.executionId }),
    ...(evaluation.usageId === null ? {} : { usageId: evaluation.usageId }),
    evaluatorRegistryId: evaluation.evaluatorRegistryId,
    evaluatorId: evaluation.evaluatorKey,
    evaluatorVersion: evaluation.evaluatorVersion,
    verdict: evaluation.verdict,
    ...(evaluation.score === null ? {} : { score: evaluation.score }),
    dimensions: evaluation.dimensions.map(serializeDimension),
    evidenceRefs: evaluation.evidenceRefs,
    uncertaintyOrLimitations: evaluation.uncertaintyOrLimitations,
    correlationId: evaluation.correlationId,
    idempotencyKey: evaluation.idempotencyKey,
    ...(evaluation.createdBy === null ? {} : { createdBy: evaluation.createdBy }),
    createdAt: evaluation.createdAt,
  };
}

function serializeReviewTransition(transition: ReviewRequestTransitionRecord): Record<string, unknown> {
  return {
    transitionId: transition.transitionId,
    reviewRequestId: transition.reviewRequestId,
    fromState: transition.fromState,
    toState: transition.toState,
    ...(transition.decidedBy === null ? {} : { decidedBy: transition.decidedBy }),
    ...(transition.note === null ? {} : { note: transition.note }),
    createdAt: transition.createdAt,
  };
}

function serializeReviewRequest(request: ReviewRequestRecord): Record<string, unknown> {
  return {
    reviewRequestId: request.reviewRequestId,
    workspaceId: request.workspaceId,
    clientId: request.clientId,
    agencyId: request.agencyId,
    ...(request.executionId === null ? {} : { executionId: request.executionId }),
    ...(request.evaluationId === null ? {} : { evaluationId: request.evaluationId }),
    reason: request.reason,
    state: request.state,
    ...(request.decidedBy === null ? {} : { decidedBy: request.decidedBy }),
    ...(request.decidedAt === null ? {} : { decidedAt: request.decidedAt }),
    ...(request.decisionNote === null ? {} : { decisionNote: request.decisionNote }),
    correlationId: request.correlationId,
    idempotencyKey: request.idempotencyKey,
    version: request.version,
    ...(request.createdBy === null ? {} : { createdBy: request.createdBy }),
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    transitions: request.transitions.map(serializeReviewTransition),
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAiRuntimeRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('ai-runtime.api');

  /**
   * Canonical Workspace owner scope for Workspace-scoped /ai-runtime routes:
   * resolved through /workspaces canonical owner resolution BEFORE
   * authorize/validate/execute (implementation-contract §2). Unknown,
   * deleted-boundary and (for the caller) foreign Workspace identifiers all
   * surface as the same 404 here or in authorize — never as a traversal.
   */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  /**
   * NEW-USE boundary policy for registry CREATE mutations (the /executions
   * module enforces this inside the module; /ai-runtime does it route-side
   * because the frozen dependency matrix gives the module no /workspaces
   * dependency — the module takes the server-derived scope as data and the
   * migration-016 scope-chain trigger is the backstop). Creating a TaskProfile
   * or appending telemetry reference an ACTIVE boundary chain.
   */
  function assertActiveBoundaries(ownership: {
    readonly workspace: { readonly status: string };
    readonly clientOwnership: { readonly client: { readonly status: string }; readonly agency: { readonly status: string } };
  }, what: string): void {
    if (
      ownership.workspace.status !== 'active' ||
      ownership.clientOwnership.client.status !== 'active' ||
      ownership.clientOwnership.agency.status !== 'active'
    ) {
      throw new ConflictError(`${what} is new use and requires ACTIVE workspace, client and agency boundaries`);
    }
  }

  /**
   * TaskProfile-scoped access check (the requireCredentialAccess pattern,
   * local to this route family to keep the MKT-017 footprint grouped):
   * load the durable record first (uniform 404 — retired history stays
   * readable), then authorize against the OWNING Workspace's canonical
   * ownership chain (the same durable membership authority as every other
   * scoped check — no second authorization authority). A TaskProfile ID is
   * NEVER an authorization credential — it only selects WHICH durable
   * ownership chain gets resolved.
   */
  async function requireTaskProfileAccess(
    principal: Principal,
    taskProfileId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<TaskProfileRecord> {
    const profile = await modules.aiRuntime.getTaskProfile(taskProfileId);
    if (profile === null) {
      throw new NotFoundError('task-profile', taskProfileId);
    }
    await requireWorkspaceAccess(modules, principal, profile.workspaceId, roles);
    return profile;
  }

  /** Usage-telemetry-scoped access check (same posture). */
  async function requireUsageTelemetryAccess(
    principal: Principal,
    usageId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<UsageTelemetryRecord> {
    const record = await modules.aiRuntime.getUsageTelemetry(usageId);
    if (record === null) {
      throw new NotFoundError('usage-telemetry', usageId);
    }
    await requireWorkspaceAccess(modules, principal, record.workspaceId, roles);
    return record;
  }

  /** Model-scoped owner resolution (uniform 404 before authorize). */
  async function modelOwner(modelRegistryId: string): Promise<OwnerScope> {
    const model = await modules.aiRuntime.getModel(modelRegistryId);
    if (model === null) {
      throw new NotFoundError('model', modelRegistryId);
    }
    return { kind: 'platform' };
  }

  // -------------------------------------------------------------------------
  // Task profiles
  // -------------------------------------------------------------------------

  // POST /api/workspaces/:workspaceId/ai/task-profiles — register the
  // provider-neutral TaskProfile. The §8-style idempotency key is REQUIRED:
  // a duplicate of the same logical command converges (201 fresh / 200
  // replayed); a key reused for a different command is a 409.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/task-profiles',
    defineMutationRoute<{ workspaceId: string }, { taskProfile: TaskProfileRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
          fields: {
            taskClass: stringField({ minLength: 2, maxLength: 100 }),
            qualityTarget: stringField({ minLength: 1, maxLength: 100 }),
            riskClass: stringField({ pattern: RISK_CLASS_PATTERN }),
            contextRequirements: recordField({ maxDepthKeys: 64 }),
            latencyTargetMs: intField({ min: 1, max: LATENCY_MS_MAX }),
            maxCostPerInvocation: numberField({ min: 0, max: COST_MAX }),
            privacyClass: stringField({ pattern: PRIVACY_CLASS_PATTERN }),
            toolRequirements: arrayField({ maxItems: 64, item: stringField({ minLength: 2, maxLength: 100 }) }),
            outputSchema: recordField({ maxDepthKeys: 64 }),
            evaluatorIds: arrayField({ maxItems: 16, item: stringField({ minLength: 2, maxLength: 100 }) }),
            escalationPolicy: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        assertActiveBoundaries(ownership, 'creating an AI task profile');
        const body = ctx.validated as Record<string, unknown>;
        return modules.aiRuntime.createTaskProfile({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          profile: {
            taskClass: body['taskClass'] as string,
            qualityTarget: body['qualityTarget'] as string,
            riskClass: body['riskClass'] as TaskProfileRecord['riskClass'],
            contextRequirements: body['contextRequirements'] as Record<string, unknown>,
            latencyTargetMs: body['latencyTargetMs'] as number,
            maxCostPerInvocation: body['maxCostPerInvocation'] as number,
            privacyClass: body['privacyClass'] as TaskProfileRecord['privacyClass'],
            toolRequirements: body['toolRequirements'] as string[],
            outputSchema: body['outputSchema'] as Record<string, unknown>,
            evaluatorIds: body['evaluatorIds'] as string[],
            escalationPolicy: body['escalationPolicy'] as Record<string, unknown>,
          },
          idempotencyKey: body['idempotencyKey'] as string,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.task_profile.created', undefined, {
          task_profile_id: ctx.result.taskProfile.taskProfileId,
          task_class: ctx.result.taskProfile.taskClass,
          workspace_id: ctx.result.taskProfile.workspaceId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.task_profile.created',
          targetType: 'ai_task_profile',
          targetId: ctx.result.taskProfile.taskProfileId,
          afterVersion: ctx.result.taskProfile.version,
          idempotencyKey: `ai_runtime.task_profile.created:${ctx.result.taskProfile.taskProfileId}`,
          details: { taskClass: ctx.result.taskProfile.taskClass, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          taskProfile: serializeTaskProfile(ctx.result.taskProfile),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/task-profiles — every lifecycle
  // state (retired history stays visible), oldest first.
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/task-profiles',
    defineQueryRoute<{ workspaceId: string }, readonly TaskProfileRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.aiRuntime.listTaskProfiles(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          taskProfiles: ctx.result.map(serializeTaskProfile),
        }),
    }),
  );

  // GET /api/ai/task-profiles/:taskProfileId — read one (member of the
  // owning agency; uniform 404 for foreign/unknown).
  router.add(
    'GET',
    '/api/ai/task-profiles/:taskProfileId',
    defineQueryRoute<{ taskProfileId: string }, TaskProfileRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireTaskProfileAccess(ctx.principal, ctx.params.taskProfileId);
      },
      execute: async (ctx) => {
        const profile = await modules.aiRuntime.getTaskProfile(ctx.params.taskProfileId);
        if (profile === null) {
          throw new NotFoundError('task-profile', ctx.params.taskProfileId);
        }
        return profile;
      },
      respond: (ctx) => jsonResponse(200, serializeTaskProfile(ctx.result)),
    }),
  );

  // POST /api/ai/task-profiles/:taskProfileId/retire — the single lifecycle
  // edge (active → retired, terminal), CAS on the presented version.
  router.add(
    'POST',
    '/api/ai/task-profiles/:taskProfileId/retire',
    defineMutationRoute<{ taskProfileId: string }, TaskProfileRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const profile = await modules.aiRuntime.getTaskProfile(params.taskProfileId);
        if (profile === null) {
          throw new NotFoundError('task-profile', params.taskProfileId);
        }
        return {
          kind: 'workspace',
          agencyId: profile.agencyId,
          clientId: profile.clientId,
          workspaceId: profile.workspaceId,
        };
      },
      authorize: async (ctx) => {
        await requireTaskProfileAccess(ctx.principal, ctx.params.taskProfileId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ version: number }>(ctx.request.body, {
          forbiddenKeys: TASK_PROFILE_RETIRE_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number };
        return modules.aiRuntime.retireTaskProfile({
          taskProfileId: ctx.params.taskProfileId,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.task_profile.retired', undefined, {
          task_profile_id: ctx.result.taskProfileId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.task_profile.retired',
          targetType: 'ai_task_profile',
          targetId: ctx.result.taskProfileId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.task_profile.retired:${ctx.result.taskProfileId}:${ctx.result.version}`,
          details: { taskClass: ctx.result.taskClass },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeTaskProfile(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // Model registry (platform-level normalized data)
  // -------------------------------------------------------------------------

  // POST /api/ai/models — register a registry entry (platform admin only).
  // The (provider_label, model_key) pair is fenced among ACTIVE entries.
  router.add(
    'POST',
    '/api/ai/models',
    defineMutationRoute<Record<string, string>, ModelRegistryRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS,
          fields: {
            providerLabel: stringField({ minLength: 2, maxLength: 64 }),
            modelKey: stringField({ minLength: 1, maxLength: 128 }),
            displayName: stringField({ minLength: 1, maxLength: 200 }),
            capabilities: arrayField({ maxItems: 64, item: stringField({ minLength: 2, maxLength: 100 }) }),
            toolFeatures: arrayField({ maxItems: 64, item: stringField({ minLength: 2, maxLength: 100 }) }),
            contextLimitTokens: intField({ min: 1, max: CONTEXT_TOKENS_MAX }),
            costInputPerMtok: optionalNumber({ min: 0, max: COST_MAX }),
            costOutputPerMtok: optionalNumber({ min: 0, max: COST_MAX }),
            latencyP50Ms: optionalInt({ min: 0, max: LATENCY_MS_MAX }),
            latencyP95Ms: optionalInt({ min: 0, max: LATENCY_MS_MAX }),
            reliability: optionalNumber({ min: 0, max: 1 }),
            qualitySignals: optionalRecordField({ maxDepthKeys: 64 }),
            privacyCharacteristics: optionalRecordField({ maxDepthKeys: 64 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        return modules.aiRuntime.registerModel({
          model: {
            providerLabel: body['providerLabel'] as string,
            modelKey: body['modelKey'] as string,
            displayName: body['displayName'] as string,
            capabilities: body['capabilities'] as string[],
            toolFeatures: body['toolFeatures'] as string[],
            contextLimitTokens: body['contextLimitTokens'] as number,
            costInputPerMtok: (body['costInputPerMtok'] as number | undefined) ?? null,
            costOutputPerMtok: (body['costOutputPerMtok'] as number | undefined) ?? null,
            latencyP50Ms: (body['latencyP50Ms'] as number | undefined) ?? null,
            latencyP95Ms: (body['latencyP95Ms'] as number | undefined) ?? null,
            reliability: (body['reliability'] as number | undefined) ?? null,
            qualitySignals: (body['qualitySignals'] as Record<string, unknown> | undefined) ?? {},
            privacyCharacteristics: (body['privacyCharacteristics'] as Record<string, unknown> | undefined) ?? {},
          },
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.model.registered', undefined, {
          model_registry_id: ctx.result.modelRegistryId,
          provider_label: ctx.result.providerLabel,
          model_key: ctx.result.modelKey,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.model.registered',
          targetType: 'ai_model_registry',
          targetId: ctx.result.modelRegistryId,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.model.registered:${ctx.result.modelRegistryId}`,
          details: { providerLabel: ctx.result.providerLabel, modelKey: ctx.result.modelKey },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeModel(ctx.result)),
    }),
  );

  // GET /api/ai/models — the ACTIVE registry entries (catalog data: any
  // authenticated principal; the AI Runtime console surface).
  router.add(
    'GET',
    '/api/ai/models',
    defineQueryRoute<Record<string, string>, readonly ModelRegistryRecord[]>({
      authenticator: services.auth,
      execute: async () => modules.aiRuntime.listModels(),
      respond: (ctx) =>
        jsonResponse(200, { models: ctx.result.map(serializeModel) }),
    }),
  );

  // GET /api/ai/models/:modelRegistryId — read one (retired history stays
  // visible; uniform 404 for unknown).
  router.add(
    'GET',
    '/api/ai/models/:modelRegistryId',
    defineQueryRoute<{ modelRegistryId: string }, ModelRegistryRecord>({
      authenticator: services.auth,
      execute: async (ctx) => {
        const model = await modules.aiRuntime.getModel(ctx.params.modelRegistryId);
        if (model === null) {
          throw new NotFoundError('model', ctx.params.modelRegistryId);
        }
        return model;
      },
      respond: (ctx) => jsonResponse(200, serializeModel(ctx.result)),
    }),
  );

  // POST /api/ai/models/:modelRegistryId/retire — the single lifecycle edge
  // (active → retired, terminal), CAS (platform admin only).
  router.add(
    'POST',
    '/api/ai/models/:modelRegistryId/retire',
    defineMutationRoute<{ modelRegistryId: string }, ModelRegistryRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => modelOwner(params.modelRegistryId),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ version: number }>(ctx.request.body, {
          forbiddenKeys: MODEL_RETIRE_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number };
        return modules.aiRuntime.retireModel({
          modelRegistryId: ctx.params.modelRegistryId,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.model.retired', undefined, {
          model_registry_id: ctx.result.modelRegistryId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.model.retired',
          targetType: 'ai_model_registry',
          targetId: ctx.result.modelRegistryId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.model.retired:${ctx.result.modelRegistryId}:${ctx.result.version}`,
          details: { providerLabel: ctx.result.providerLabel, modelKey: ctx.result.modelKey },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeModel(ctx.result)),
    }),
  );

  // POST /api/ai/models/:modelRegistryId/observations — append one
  // availability/telemetry observation (platform admin only; append-only
  // history — the current availability state is DERIVED from the latest
  // observation, never caller-supplied).
  router.add(
    'POST',
    '/api/ai/models/:modelRegistryId/observations',
    defineMutationRoute<{ modelRegistryId: string }, { observation: ModelObservationRecord; model: ModelRegistryRecord }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => modelOwner(params.modelRegistryId),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: MODEL_OBSERVATION_AUTHORITY_FIELDS,
          fields: {
            availabilityState: stringField({ pattern: AVAILABILITY_STATE_PATTERN }),
            observedLatencyP50Ms: optionalInt({ min: 0, max: LATENCY_MS_MAX }),
            observedLatencyP95Ms: optionalInt({ min: 0, max: LATENCY_MS_MAX }),
            source: stringField({ minLength: 1, maxLength: 64 }),
            notes: optionalString({ maxLength: 512 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        return modules.aiRuntime.appendModelObservation({
          modelRegistryId: ctx.params.modelRegistryId,
          availabilityState: body['availabilityState'] as ModelObservationRecord['availabilityState'],
          observedLatencyP50Ms: (body['observedLatencyP50Ms'] as number | undefined) ?? null,
          observedLatencyP95Ms: (body['observedLatencyP95Ms'] as number | undefined) ?? null,
          source: body['source'] as string,
          notes: (body['notes'] as string | undefined) ?? '',
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.model.observed', undefined, {
          model_registry_id: ctx.result.model.modelRegistryId,
          availability_state: ctx.result.observation.availabilityState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.model.observed',
          targetType: 'ai_model_registry',
          targetId: ctx.result.model.modelRegistryId,
          afterVersion: ctx.result.model.version,
          idempotencyKey: `ai_runtime.model.observed:${ctx.result.observation.observationId}`,
          details: { availabilityState: ctx.result.observation.availabilityState, source: ctx.result.observation.source },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          observation: serializeObservation(ctx.result.observation),
          model: serializeModel(ctx.result.model),
        }),
    }),
  );

  // GET /api/ai/models/:modelRegistryId/observations — the append-only
  // observation history, oldest first (any authenticated principal).
  router.add(
    'GET',
    '/api/ai/models/:modelRegistryId/observations',
    defineQueryRoute<{ modelRegistryId: string }, readonly ModelObservationRecord[]>({
      authenticator: services.auth,
      execute: async (ctx) => {
        const model = await modules.aiRuntime.getModel(ctx.params.modelRegistryId);
        if (model === null) {
          throw new NotFoundError('model', ctx.params.modelRegistryId);
        }
        return modules.aiRuntime.listModelObservations(ctx.params.modelRegistryId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          modelRegistryId: ctx.params.modelRegistryId,
          observations: ctx.result.map(serializeObservation),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // Usage telemetry (append-only)
  // -------------------------------------------------------------------------

  // POST /api/workspaces/:workspaceId/ai/usage-telemetry — append one usage
  // telemetry row. The §8-style idempotency key is REQUIRED: a duplicate of
  // the same logical command converges (201 fresh / 200 replayed); a key
  // reused for a different command is a 409. The correlation identity is
  // SERVER-DERIVED from the ambient request correlation context.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/usage-telemetry',
    defineMutationRoute<{ workspaceId: string }, { record: UsageTelemetryRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
          fields: {
            taskProfileId: stringField({ minLength: 36, maxLength: 36 }),
            modelRegistryId: stringField({ minLength: 36, maxLength: 36 }),
            executionId: optionalString({ minLength: 36, maxLength: 36 }),
            outcome: stringField({ pattern: USAGE_OUTCOME_PATTERN }),
            latencyMs: intField({ min: 0, max: LATENCY_MS_MAX }),
            costAmount: numberField({ min: 0, max: COST_MAX }),
            tokensIn: optionalInt({ min: 0, max: Number.MAX_SAFE_INTEGER }),
            tokensOut: optionalInt({ min: 0, max: Number.MAX_SAFE_INTEGER }),
            evaluationRef: optionalString({ minLength: 1, maxLength: 512 }),
            escalationCount: optionalInt({ min: 0, max: 1000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        const body = ctx.validated as Record<string, unknown>;
        // Server-authoritative derivation: the correlation identity comes
        // from the ambient request correlation context (OBS-AC-01 posture),
        // never from the request body (a caller-supplied correlationId is
        // rejected as an authority field above).
        const correlation = currentCorrelation();
        return modules.aiRuntime.appendUsageTelemetry({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          usage: {
            taskProfileId: body['taskProfileId'] as string,
            modelRegistryId: body['modelRegistryId'] as string,
            executionId: (body['executionId'] as string | undefined) ?? null,
            outcome: body['outcome'] as UsageTelemetryRecord['outcome'],
            latencyMs: body['latencyMs'] as number,
            costAmount: body['costAmount'] as number,
            tokensIn: (body['tokensIn'] as number | undefined) ?? null,
            tokensOut: (body['tokensOut'] as number | undefined) ?? null,
            evaluationRef: (body['evaluationRef'] as string | undefined) ?? null,
            escalationCount: (body['escalationCount'] as number | undefined) ?? 0,
            idempotencyKey: body['idempotencyKey'] as string,
          },
          correlationId: correlation.correlationId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.usage_telemetry.appended', undefined, {
          usage_id: ctx.result.record.usageId,
          task_profile_id: ctx.result.record.taskProfileId,
          model_registry_id: ctx.result.record.modelRegistryId,
          outcome: ctx.result.record.outcome,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.usage_telemetry.appended',
          targetType: 'ai_usage_telemetry',
          targetId: ctx.result.record.usageId,
          idempotencyKey: `ai_runtime.usage_telemetry.appended:${ctx.result.record.usageId}`,
          details: { outcome: ctx.result.record.outcome, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          usageTelemetry: serializeUsageTelemetry(ctx.result.record),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/usage-telemetry — the Workspace's
  // telemetry rows, newest first (bounded; any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/usage-telemetry',
    defineQueryRoute<{ workspaceId: string }, readonly UsageTelemetryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) =>
        // Bounded long-list handling: the module clamps the limit into
        // [1, TELEMETRY_LIST_MAX_LIMIT] (default TELEMETRY_LIST_DEFAULT_LIMIT).
        modules.aiRuntime.listUsageTelemetry(ctx.params.workspaceId, TELEMETRY_LIST_DEFAULT_LIMIT),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          usageTelemetry: ctx.result.map(serializeUsageTelemetry),
        }),
    }),
  );

  // GET /api/ai/usage-telemetry/:usageId — read one (member of the owning
  // agency; uniform 404 for foreign/unknown).
  router.add(
    'GET',
    '/api/ai/usage-telemetry/:usageId',
    defineQueryRoute<{ usageId: string }, UsageTelemetryRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireUsageTelemetryAccess(ctx.principal, ctx.params.usageId);
      },
      execute: async (ctx) => {
        const record = await modules.aiRuntime.getUsageTelemetry(ctx.params.usageId);
        if (record === null) {
          throw new NotFoundError('usage-telemetry', ctx.params.usageId);
        }
        return record;
      },
      respond: (ctx) => jsonResponse(200, serializeUsageTelemetry(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // MKT-018 (AI-002) routing routes — policy administration + selection/
  // cascade records + routing preview. Same tenant isolation + DTO
  // authority-field rejection as the registry routes.
  //
  // The routeTask operation (which requires the provider adapter) is NOT a
  // route here — the adapter is supplied by the caller at route time (the
  // composition root wires the OpenRouter adapter; the integration test
  // supplies a fake). The routing preview route runs the routing policy
  // WITHOUT the cascade (no adapter required) — useful for previewing the
  // routing decision before committing to a cascade.
  // -------------------------------------------------------------------------

  /** Fields always server-derived on routing-policy CREATE (authority fields). */
  const ROUTING_POLICY_RETIRE_AUTHORITY_FIELDS = [
    'routingPolicyId',
    'workspaceId',
    'clientId',
    'agencyId',
    'policyName',
    'policyContent',
    'status',
    'createFingerprint',
    'createdBy',
    'createdAt',
    'updatedAt',
  ] as const;

  /** Routing-policy-scoped access check (same posture as TaskProfile). */
  async function requireRoutingPolicyAccess(
    principal: Principal,
    routingPolicyId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<RoutingPolicyRecord> {
    const policy = await modules.aiRuntime.getRoutingPolicy(routingPolicyId);
    if (policy === null) {
      throw new NotFoundError('routing-policy', routingPolicyId);
    }
    await requireWorkspaceAccess(modules, principal, policy.workspaceId, roles);
    return policy;
  }

  /** Selection-decision-scoped access check. */
  async function requireSelectionDecisionAccess(
    principal: Principal,
    selectionId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<SelectionDecisionRecord> {
    const decision = await modules.aiRuntime.getSelectionDecision(selectionId);
    if (decision === null) {
      throw new NotFoundError('selection-decision', selectionId);
    }
    await requireWorkspaceAccess(modules, principal, decision.workspaceId, roles);
    return decision;
  }

  /** Cascade-run-scoped access check. */
  async function requireCascadeRunAccess(
    principal: Principal,
    cascadeRunId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<CascadeRunRecord> {
    const run = await modules.aiRuntime.getCascadeRun(cascadeRunId);
    if (run === null) {
      throw new NotFoundError('cascade-run', cascadeRunId);
    }
    await requireWorkspaceAccess(modules, principal, run.workspaceId, roles);
    return run;
  }

  // -------------------------------------------------------------------------
  // MKT-019 (AI-003) — evaluation framework + human-review hook
  // -------------------------------------------------------------------------

  /** Fields always server-derived on evaluator RETIRE (authority fields). */
  const EVALUATOR_RETIRE_AUTHORITY_FIELDS = [
    'evaluatorRegistryId',
    'evaluatorKey',
    'displayName',
    'kind',
    'evaluatorVersion',
    'config',
    'status',
    'createdBy',
    'createdAt',
    'updatedAt',
  ] as const;

  /** Evaluation-record-scoped access check (same posture as TaskProfile). */
  async function requireEvaluationAccess(
    principal: Principal,
    evaluationId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<EvaluationRecord> {
    const evaluation = await modules.aiRuntime.getEvaluation(evaluationId);
    if (evaluation === null) {
      throw new NotFoundError('evaluation', evaluationId);
    }
    await requireWorkspaceAccess(modules, principal, evaluation.workspaceId, roles);
    return evaluation;
  }

  /** Review-request-scoped access check (same posture). */
  async function requireReviewRequestAccess(
    principal: Principal,
    reviewRequestId: string,
    roles?: ReadonlyArray<AgencyRoleKey>,
  ): Promise<ReviewRequestRecord> {
    const request = await modules.aiRuntime.getReviewRequest(reviewRequestId);
    if (request === null) {
      throw new NotFoundError('review-request', reviewRequestId);
    }
    await requireWorkspaceAccess(modules, principal, request.workspaceId, roles);
    return request;
  }

  // POST /api/ai/evaluators — register an evaluator registry entry
  // (platform admin only). The evaluator_key is fenced among ACTIVE
  // entries.
  router.add(
    'POST',
    '/api/ai/evaluators',
    defineMutationRoute<Record<string, string>, EvaluatorRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS,
          fields: {
            evaluatorKey: stringField({ minLength: 2, maxLength: 100 }),
            displayName: stringField({ minLength: 1, maxLength: 200 }),
            kind: stringField({ pattern: EVALUATOR_KIND_PATTERN }),
            evaluatorVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            config: recordField({ maxDepthKeys: 64 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        return modules.aiRuntime.registerEvaluator({
          evaluator: {
            evaluatorKey: body['evaluatorKey'] as string,
            displayName: body['displayName'] as string,
            kind: body['kind'] as EvaluatorRecord['kind'],
            evaluatorVersion: body['evaluatorVersion'] as number,
            config: body['config'] as Record<string, unknown>,
          },
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.evaluator.registered', undefined, {
          evaluator_registry_id: ctx.result.evaluatorRegistryId,
          evaluator_key: ctx.result.evaluatorKey,
          kind: ctx.result.kind,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.evaluator.registered',
          targetType: 'ai_evaluator',
          targetId: ctx.result.evaluatorRegistryId,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.evaluator.registered:${ctx.result.evaluatorRegistryId}`,
          details: { evaluatorKey: ctx.result.evaluatorKey, kind: ctx.result.kind },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeEvaluator(ctx.result)),
    }),
  );

  // GET /api/ai/evaluators — the ACTIVE registry entries (catalog data:
  // any authenticated principal; the AI Runtime console surface).
  router.add(
    'GET',
    '/api/ai/evaluators',
    defineQueryRoute<Record<string, string>, readonly EvaluatorRecord[]>({
      authenticator: services.auth,
      execute: async () => modules.aiRuntime.listEvaluators(),
      respond: (ctx) =>
        jsonResponse(200, { evaluators: ctx.result.map(serializeEvaluator) }),
    }),
  );

  // GET /api/ai/evaluators/:evaluatorRegistryId — read one (retired
  // history stays visible; uniform 404 for unknown).
  router.add(
    'GET',
    '/api/ai/evaluators/:evaluatorRegistryId',
    defineQueryRoute<{ evaluatorRegistryId: string }, EvaluatorRecord>({
      authenticator: services.auth,
      execute: async (ctx) => {
        const evaluator = await modules.aiRuntime.getEvaluator(ctx.params.evaluatorRegistryId);
        if (evaluator === null) {
          throw new NotFoundError('evaluator', ctx.params.evaluatorRegistryId);
        }
        return evaluator;
      },
      respond: (ctx) => jsonResponse(200, serializeEvaluator(ctx.result)),
    }),
  );

  // POST /api/ai/evaluators/:evaluatorRegistryId/retire — the single
  // lifecycle edge (active → retired, terminal), CAS (platform admin only).
  router.add(
    'POST',
    '/api/ai/evaluators/:evaluatorRegistryId/retire',
    defineMutationRoute<{ evaluatorRegistryId: string }, EvaluatorRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePlatformAdministrator(modules, ctx.principal);
      },
      validate: (ctx) =>
        validateObject<{ version: number }>(ctx.request.body, {
          forbiddenKeys: EVALUATOR_RETIRE_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number };
        return modules.aiRuntime.retireEvaluator({
          evaluatorRegistryId: ctx.params.evaluatorRegistryId,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.evaluator.retired', undefined, {
          evaluator_registry_id: ctx.result.evaluatorRegistryId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.evaluator.retired',
          targetType: 'ai_evaluator',
          targetId: ctx.result.evaluatorRegistryId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.evaluator.retired:${ctx.result.evaluatorRegistryId}:${ctx.result.version}`,
          details: { evaluatorKey: ctx.result.evaluatorKey },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeEvaluator(ctx.result)),
    }),
  );

  // POST /api/workspaces/:workspaceId/ai/evaluations — run ONE evaluation
  // of a TaskProfile's evaluator contract (owner|admin). The evaluation
  // request is DERIVED from the profile's evaluatorIds (the caller cannot
  // select evaluators) and the outcomes are evaluator-computed (the caller
  // cannot fabricate verdict/score/dimensions). The route runs the BUILT-IN
  // deterministic evaluators only — caller-supplied engines are a
  // module-level composition (like the routing adapter), never an HTTP
  // input. The §8-style idempotency key is REQUIRED: a duplicate of the
  // same logical command converges (201 fresh / 200 replayed); a key
  // reused for a different command is a 409.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/evaluations',
    defineMutationRoute<
      { workspaceId: string },
      { evaluations: readonly EvaluationRecord[]; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: EVALUATION_FORBIDDEN_INPUT_KEYS,
          fields: {
            taskProfileId: stringField({ minLength: 36, maxLength: 36 }),
            executionId: optionalString({ minLength: 36, maxLength: 36 }),
            usageId: optionalString({ minLength: 36, maxLength: 36 }),
            output: optionalRecordField({ maxDepthKeys: 64 }),
            adapterError: optionalString({ minLength: 0, maxLength: 2000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        assertActiveBoundaries(ownership, 'running an AI evaluation');
        const body = ctx.validated as Record<string, unknown>;
        const correlation = currentCorrelation();
        return modules.aiRuntime.evaluateTask({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          taskProfileId: body['taskProfileId'] as string,
          executionId: (body['executionId'] as string | undefined) ?? null,
          usageId: (body['usageId'] as string | undefined) ?? null,
          output: (body['output'] as Record<string, unknown> | undefined) ?? null,
          adapterError: (body['adapterError'] as string | undefined) ?? null,
          idempotencyKey: body['idempotencyKey'] as string,
          correlationId: correlation.correlationId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.evaluation.recorded', undefined, {
          workspace_id: ctx.params.workspaceId,
          evaluation_count: ctx.result.evaluations.length,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        // The audit fence key uses the FIRST converged evaluation id — on
        // replay the per-evaluator fences converge to the SAME rows, so
        // the audit append dedupes naturally.
        const firstEvaluationId = ctx.result.evaluations[0]?.evaluationId ?? 'none';
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.evaluation.recorded',
          targetType: 'ai_evaluation',
          targetId: firstEvaluationId,
          idempotencyKey: `ai_runtime.evaluation.recorded:${firstEvaluationId}`,
          details: {
            evaluations: ctx.result.evaluations.length,
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          evaluations: ctx.result.evaluations.map(serializeEvaluation),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/evaluations — list the Workspace's
  // evaluation records, newest first (any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/evaluations',
    defineQueryRoute<{ workspaceId: string }, readonly EvaluationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.aiRuntime.listEvaluations(ctx.params.workspaceId, 500),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          evaluations: ctx.result.map(serializeEvaluation),
        }),
    }),
  );

  // GET /api/ai/evaluations/:evaluationId — read one (member of the owning
  // agency; uniform 404 for foreign/unknown).
  router.add(
    'GET',
    '/api/ai/evaluations/:evaluationId',
    defineQueryRoute<{ evaluationId: string }, EvaluationRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireEvaluationAccess(ctx.principal, ctx.params.evaluationId);
      },
      execute: async (ctx) => {
        const evaluation = await modules.aiRuntime.getEvaluation(ctx.params.evaluationId);
        if (evaluation === null) {
          throw new NotFoundError('evaluation', ctx.params.evaluationId);
        }
        return evaluation;
      },
      respond: (ctx) => jsonResponse(200, serializeEvaluation(ctx.result)),
    }),
  );

  // POST /api/workspaces/:workspaceId/ai/review-requests — record one
  // human-review request (owner|admin). The hook records review INTENT
  // only; humans act through /jobs (never a second human-execution engine
  // here). The §8-style idempotency key is REQUIRED.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/review-requests',
    defineMutationRoute<
      { workspaceId: string },
      { reviewRequest: ReviewRequestRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS,
          fields: {
            executionId: optionalString({ minLength: 36, maxLength: 36 }),
            evaluationId: optionalString({ minLength: 36, maxLength: 36 }),
            reason: stringField({ minLength: 1, maxLength: 2000 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        assertActiveBoundaries(ownership, 'requesting an AI human review');
        const body = ctx.validated as Record<string, unknown>;
        const correlation = currentCorrelation();
        return modules.aiRuntime.requestReview({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          executionId: (body['executionId'] as string | undefined) ?? null,
          evaluationId: (body['evaluationId'] as string | undefined) ?? null,
          reason: body['reason'] as string,
          idempotencyKey: body['idempotencyKey'] as string,
          correlationId: correlation.correlationId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.review_request.recorded', undefined, {
          review_request_id: ctx.result.reviewRequest.reviewRequestId,
          workspace_id: ctx.result.reviewRequest.workspaceId,
          state: ctx.result.reviewRequest.state,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.review_request.recorded',
          targetType: 'ai_review_request',
          targetId: ctx.result.reviewRequest.reviewRequestId,
          afterVersion: ctx.result.reviewRequest.version,
          idempotencyKey: `ai_runtime.review_request.recorded:${ctx.result.reviewRequest.reviewRequestId}`,
          details: { state: ctx.result.reviewRequest.state, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          reviewRequest: serializeReviewRequest(ctx.result.reviewRequest),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/review-requests — list the
  // Workspace's review requests (transition histories included), newest
  // first (any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/review-requests',
    defineQueryRoute<{ workspaceId: string }, readonly ReviewRequestRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.aiRuntime.listReviewRequests(ctx.params.workspaceId, undefined, 500),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          reviewRequests: ctx.result.map(serializeReviewRequest),
        }),
    }),
  );

  // GET /api/ai/review-requests/:reviewRequestId — read one with the
  // append-only transition history (member of the owning agency).
  router.add(
    'GET',
    '/api/ai/review-requests/:reviewRequestId',
    defineQueryRoute<{ reviewRequestId: string }, ReviewRequestRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireReviewRequestAccess(ctx.principal, ctx.params.reviewRequestId);
      },
      execute: async (ctx) => {
        const request = await modules.aiRuntime.getReviewRequest(ctx.params.reviewRequestId);
        if (request === null) {
          throw new NotFoundError('review-request', ctx.params.reviewRequestId);
        }
        return request;
      },
      respond: (ctx) => jsonResponse(200, serializeReviewRequest(ctx.result)),
    }),
  );

  // POST /api/ai/review-requests/:reviewRequestId/decide — record the
  // single review decision (owner|admin). Exactly-once: the transitions
  // fence + the state-guarded update make concurrent decisions
  // deterministic (one wins, the rest 409); decided requests are terminal.
  router.add(
    'POST',
    '/api/ai/review-requests/:reviewRequestId/decide',
    defineMutationRoute<{ reviewRequestId: string }, ReviewRequestRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const request = await modules.aiRuntime.getReviewRequest(params.reviewRequestId);
        if (request === null) {
          throw new NotFoundError('review-request', params.reviewRequestId);
        }
        return {
          kind: 'workspace',
          agencyId: request.agencyId,
          clientId: request.clientId,
          workspaceId: request.workspaceId,
        };
      },
      authorize: async (ctx) => {
        await requireReviewRequestAccess(ctx.principal, ctx.params.reviewRequestId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: REVIEW_REQUEST_DECIDE_AUTHORITY_FIELDS,
          fields: {
            decision: stringField({ pattern: REVIEW_DECISION_PATTERN }),
            note: optionalString({ minLength: 0, maxLength: 2000 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as Record<string, unknown>;
        const correlation = currentCorrelation();
        return modules.aiRuntime.decideReview({
          reviewRequestId: ctx.params.reviewRequestId,
          decision: body['decision'] as ReviewRequestRecord extends never ? never : 'approve' | 'reject' | 'dismiss',
          note: (body['note'] as string | undefined) ?? '',
          correlationId: correlation.correlationId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.review_request.decided', undefined, {
          review_request_id: ctx.result.reviewRequestId,
          state: ctx.result.state,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.review_request.decided',
          targetType: 'ai_review_request',
          targetId: ctx.result.reviewRequestId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.review_request.decided:${ctx.result.reviewRequestId}:${ctx.result.version}`,
          details: { state: ctx.result.state },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeReviewRequest(ctx.result)),
    }),
  );

  // POST /api/workspaces/:workspaceId/ai/routing-policies — register the
  // routing policy (owner|admin). The §8-style idempotency key is REQUIRED.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/routing-policies',
    defineMutationRoute<
      { workspaceId: string },
      { routingPolicy: RoutingPolicyRecord; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: ROUTING_POLICY_FORBIDDEN_INPUT_KEYS,
          fields: {
            policyName: stringField({ minLength: 1, maxLength: 100 }),
            policyContent: recordField({ maxDepthKeys: 64 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        assertActiveBoundaries(ownership, 'creating a routing policy');
        const body = ctx.validated as Record<string, unknown>;
        return modules.aiRuntime.createRoutingPolicy({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          policy: {
            policyName: body['policyName'] as string,
            policyContent: body['policyContent'] as Record<string, unknown>,
          },
          idempotencyKey: body['idempotencyKey'] as string,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.routing_policy.created', undefined, {
          routing_policy_id: ctx.result.routingPolicy.routingPolicyId,
          policy_name: ctx.result.routingPolicy.policyName,
          workspace_id: ctx.result.routingPolicy.workspaceId,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.routing_policy.created',
          targetType: 'ai_routing_policy',
          targetId: ctx.result.routingPolicy.routingPolicyId,
          afterVersion: ctx.result.routingPolicy.version,
          idempotencyKey: `ai_runtime.routing_policy.created:${ctx.result.routingPolicy.routingPolicyId}`,
          details: { policyName: ctx.result.routingPolicy.policyName, replayed: ctx.result.replayed },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          routingPolicy: serializeRoutingPolicy(ctx.result.routingPolicy),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/routing-policies — list the
  // Workspace's routing policies in ALL states (any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/routing-policies',
    defineQueryRoute<{ workspaceId: string }, readonly RoutingPolicyRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.aiRuntime.listRoutingPolicies(ctx.params.workspaceId),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          routingPolicies: ctx.result.map(serializeRoutingPolicy),
        }),
    }),
  );

  // GET /api/ai/routing-policies/:routingPolicyId — read one.
  router.add(
    'GET',
    '/api/ai/routing-policies/:routingPolicyId',
    defineQueryRoute<{ routingPolicyId: string }, RoutingPolicyRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireRoutingPolicyAccess(ctx.principal, ctx.params.routingPolicyId);
      },
      execute: async (ctx) => {
        const policy = await modules.aiRuntime.getRoutingPolicy(ctx.params.routingPolicyId);
        if (policy === null) {
          throw new NotFoundError('routing-policy', ctx.params.routingPolicyId);
        }
        return policy;
      },
      respond: (ctx) => jsonResponse(200, serializeRoutingPolicy(ctx.result)),
    }),
  );

  // POST /api/ai/routing-policies/:routingPolicyId/retire — the single
  // lifecycle edge (active → retired, terminal), CAS (owner|admin).
  router.add(
    'POST',
    '/api/ai/routing-policies/:routingPolicyId/retire',
    defineMutationRoute<{ routingPolicyId: string }, RoutingPolicyRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const policy = await modules.aiRuntime.getRoutingPolicy(params.routingPolicyId);
        if (policy === null) {
          throw new NotFoundError('routing-policy', params.routingPolicyId);
        }
        return {
          kind: 'workspace',
          agencyId: policy.agencyId,
          clientId: policy.clientId,
          workspaceId: policy.workspaceId,
        };
      },
      authorize: async (ctx) => {
        await requireRoutingPolicyAccess(ctx.principal, ctx.params.routingPolicyId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ version: number }>(ctx.request.body, {
          forbiddenKeys: ROUTING_POLICY_RETIRE_AUTHORITY_FIELDS,
          fields: {
            version: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { version: number };
        return modules.aiRuntime.retireRoutingPolicy({
          routingPolicyId: ctx.params.routingPolicyId,
          expectedVersion: body.version,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.routing_policy.retired', undefined, {
          routing_policy_id: ctx.result.routingPolicyId,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.routing_policy.retired',
          targetType: 'ai_routing_policy',
          targetId: ctx.result.routingPolicyId,
          beforeVersion: ctx.result.version - 1,
          afterVersion: ctx.result.version,
          idempotencyKey: `ai_runtime.routing_policy.retired:${ctx.result.routingPolicyId}:${ctx.result.version}`,
          details: { policyName: ctx.result.policyName },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeRoutingPolicy(ctx.result)),
    }),
  );

  // POST /api/workspaces/:workspaceId/ai/routing/preview — preview the
  // routing decision (no cascade, no adapter — just the routing policy
  // applied to the TaskProfile). The §8-style idempotency key is REQUIRED.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/ai/routing/preview',
    defineMutationRoute<{ workspaceId: string }, SelectionDecisionRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<Record<string, unknown>>(ctx.request.body, {
          forbiddenKeys: SELECTION_DECISION_FORBIDDEN_INPUT_KEYS,
          fields: {
            taskProfileId: stringField({ minLength: 36, maxLength: 36 }),
            routingPolicyId: optionalString({ minLength: 36, maxLength: 36 }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const ownership = await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
        const body = ctx.validated as Record<string, unknown>;
        const correlation = currentCorrelation();
        return modules.aiRuntime.previewRouting({
          workspaceId: ctx.params.workspaceId,
          clientId: ownership.scope.clientId,
          agencyId: ownership.scope.agencyId,
          taskProfileId: body['taskProfileId'] as string,
          routingPolicyId: (body['routingPolicyId'] as string | undefined) ?? null,
          idempotencyKey: body['idempotencyKey'] as string,
          correlationId: correlation.correlationId,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('ai_runtime.routing.previewed', undefined, {
          selection_id: ctx.result.selectionId,
          task_profile_id: ctx.result.taskProfileId,
          chosen_model_registry_id: ctx.result.chosenModelRegistryId,
          authoritative: ctx.result.authoritative,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'ai_runtime.routing.previewed',
          targetType: 'ai_selection_decision',
          targetId: ctx.result.selectionId,
          idempotencyKey: `ai_runtime.routing.previewed:${ctx.result.selectionId}`,
          details: {
            taskProfileId: ctx.result.taskProfileId,
            chosenModelRegistryId: ctx.result.chosenModelRegistryId,
            authoritative: ctx.result.authoritative,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeSelectionDecision(ctx.result)),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/selection-decisions — list the
  // Workspace's selection decisions, newest first (any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/selection-decisions',
    defineQueryRoute<{ workspaceId: string }, readonly SelectionDecisionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) =>
        modules.aiRuntime.listSelectionDecisions(ctx.params.workspaceId, 500),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          selectionDecisions: ctx.result.map(serializeSelectionDecision),
        }),
    }),
  );

  // GET /api/ai/selection-decisions/:selectionId — read one.
  router.add(
    'GET',
    '/api/ai/selection-decisions/:selectionId',
    defineQueryRoute<{ selectionId: string }, SelectionDecisionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireSelectionDecisionAccess(ctx.principal, ctx.params.selectionId);
      },
      execute: async (ctx) => {
        const decision = await modules.aiRuntime.getSelectionDecision(ctx.params.selectionId);
        if (decision === null) {
          throw new NotFoundError('selection-decision', ctx.params.selectionId);
        }
        return decision;
      },
      respond: (ctx) => jsonResponse(200, serializeSelectionDecision(ctx.result)),
    }),
  );

  // GET /api/workspaces/:workspaceId/ai/cascade-runs — list the Workspace's
  // cascade runs, newest first (any active member).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/ai/cascade-runs',
    defineQueryRoute<{ workspaceId: string }, readonly CascadeRunRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => modules.aiRuntime.listCascadeRuns(ctx.params.workspaceId, 500),
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          cascadeRuns: ctx.result.map(serializeCascadeRun),
        }),
    }),
  );

  // GET /api/ai/cascade-runs/:cascadeRunId — read one (with steps).
  router.add(
    'GET',
    '/api/ai/cascade-runs/:cascadeRunId',
    defineQueryRoute<{ cascadeRunId: string }, CascadeRunRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireCascadeRunAccess(ctx.principal, ctx.params.cascadeRunId);
      },
      execute: async (ctx) => {
        const run = await modules.aiRuntime.getCascadeRun(ctx.params.cascadeRunId);
        if (run === null) {
          throw new NotFoundError('cascade-run', ctx.params.cascadeRunId);
        }
        return run;
      },
      respond: (ctx) => jsonResponse(200, serializeCascadeRun(ctx.result)),
    }),
  );
}
