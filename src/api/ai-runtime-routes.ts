/**
 * /ai-runtime API routes (MKT-017 — AI task profile and model registry:
 * AI-001, acceptance AI-AC-01..02).
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
 * NO routing/eligibility/cascade/escalation logic and NO model invocation
 * exist here (AI-002/MKT-018, AI-003/MKT-019): these routes manage the
 * REGISTRY LAYER ONLY — profiles, registry entries, observations and usage
 * telemetry records. Boundary policy (new-use gating) is enforced at the
 * route layer because the frozen dependency matrix gives /ai-runtime no
 * /workspaces dependency: the module takes the server-derived scope chain
 * as data and the migration-016 scope-chain trigger is the backstop.
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
  ModelObservationRecord,
  ModelRegistryRecord,
  TaskProfileRecord,
  UsageTelemetryRecord,
} from '../modules/ai-runtime/public.ts';
import {
  MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
  USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
} from '../modules/ai-runtime/public.ts';

const RISK_CLASS_PATTERN = /^(low|medium|high)$/;
const PRIVACY_CLASS_PATTERN = /^(public|internal|confidential|restricted)$/;
const AVAILABILITY_STATE_PATTERN = /^(available|degraded|unavailable)$/;
const USAGE_OUTCOME_PATTERN = /^(succeeded|failed|escalated|unknown)$/;

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
}
