/**
 * /ai-runtime module implementation (MKT-017, AI-001).
 *
 * Implements the REGISTRY LAYER of the AI Runtime authority:
 * provider-neutral TaskProfiles, the normalized model registry with its
 * append-only availability/telemetry observations, and the append-oriented
 * usage telemetry record — the neutral contracts that routing (MKT-018),
 * evaluation (MKT-019) and provider adapters (later Work Items) consume.
 *
 * What this implementation deliberately does NOT contain (MKT-017 scope
 * bounds, asserted by architecture tests): no routing/eligibility/cascade
 * policy, no evaluation execution, no provider SDK imports, no model
 * invocation, no credentials. The module's ONLY cross-module dependency is
 * the frozen-matrix-sanctioned /executions public API (telemetry execution
 * reference validation); scope chains arrive as server-derived data resolved
 * by the caller (routes resolve canonical ownership BEFORE authorize) and
 * are DB-backstopped by the migration-016 scope-chain triggers.
 *
 * Convergence discipline (§8-style, exactly the MKT-009/MKT-010 pattern):
 * TaskProfile creates and telemetry appends carry a LOGICAL idempotency key
 * whose uniqueness the DATABASE enforces — a duplicate of the same command
 * (same create fingerprint) converges to the existing row (replayed=true);
 * a key reused for a different command is a ConflictError. History is
 * append-only: corrections create new records, never overwrites.
 */

import { createHash } from 'node:crypto';
import { ConflictError, IdempotencyConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  AiRuntimeModuleApi,
  AiRuntimeModuleDeps,
  TaskProfileInput,
  UsageTelemetryInput,
} from '../public.ts';
import {
  assertValidIdempotencyKey,
  assertValidModelObservationInput,
  assertValidModelRegistrationInput,
  assertValidTaskProfileInput,
  assertValidUsageTelemetryInput,
  AiRuntimeStore,
} from './ai-runtime-store.ts';

const SCOPE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server-derived scope ids must be server-generated identifiers. */
function assertScopeIds(scope: {
  readonly workspaceId: string;
  readonly clientId: string;
  readonly agencyId: string;
}): void {
  for (const [field, value] of Object.entries(scope)) {
    if (typeof value !== 'string' || !SCOPE_ID_PATTERN.test(value)) {
      throw new ConflictError(`${field} '${String(value)}' is not a canonical server-derived scope id`);
    }
  }
}

/**
 * The §8-style fingerprint of one logical TaskProfile create command: a
 * deterministic digest of WHAT the command registers (the full neutral
 * contract + the workspace scope). A replayed key must present the SAME
 * fingerprint — one key identifies one logical command, so a key reused for
 * a different command is a conflict while duplicate delivery of the same
 * command converges.
 */
function fingerprintTaskProfileCreate(workspaceId: string, profile: TaskProfileInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.task-profile.create',
        workspaceId,
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
      }),
    )
    .digest('hex');
}

/**
 * The §8-style fingerprint of one logical telemetry append command: a
 * deterministic digest of WHAT the command records. The correlation identity
 * and the actor are deliberately EXCLUDED — they are ambient/server-derived
 * per request (a retry after a network failure legitimately carries a fresh
 * correlation/actor and must still converge on the SAME logical command).
 */
function fingerprintUsageTelemetryAppend(workspaceId: string, usage: UsageTelemetryInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.usage-telemetry.append',
        workspaceId,
        taskProfileId: usage.taskProfileId,
        modelRegistryId: usage.modelRegistryId,
        executionId: usage.executionId,
        outcome: usage.outcome,
        latencyMs: usage.latencyMs,
        costAmount: usage.costAmount,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        evaluationRef: usage.evaluationRef,
        escalationCount: usage.escalationCount,
      }),
    )
    .digest('hex');
}

export function createAiRuntimeModule(deps: AiRuntimeModuleDeps): AiRuntimeModuleApi {
  const store = new AiRuntimeStore(deps.db, deps.clock, deps.ids);
  const { executions } = deps;

  return {
    // ----- TaskProfiles ---------------------------------------------------

    async createTaskProfile(input) {
      assertValidTaskProfileInput(input.profile);
      assertValidIdempotencyKey(input.idempotencyKey);
      assertScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });

      const createFingerprint = fingerprintTaskProfileCreate(input.workspaceId, input.profile);

      return deps.db.transaction(async (tx) => {
        const inserted = await store.insertTaskProfile(tx, {
          profile: input.profile,
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
          actorId: input.actorId,
        });
        if (inserted !== 'fence') {
          return { taskProfile: inserted, replayed: false };
        }
        // The §8-style fence fired: converge on the recorded command or
        // reject the key reuse — never a silent overwrite.
        const existing = await store.findTaskProfileByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (existing === null) {
          throw new ConflictError(
            `task profile idempotency key '${input.idempotencyKey}' fence fired but no record resolved`,
          );
        }
        if (existing.createFingerprint !== createFingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { taskProfile: existing, replayed: true };
      });
    },

    async getTaskProfile(taskProfileId) {
      return store.getTaskProfile(taskProfileId);
    },

    async listTaskProfiles(workspaceId) {
      return store.listTaskProfiles(workspaceId);
    },

    async retireTaskProfile(input) {
      return deps.db.transaction(async (tx) => {
        // CAS-serialized: row lock + explicit version check + the single
        // lifecycle edge (active → retired, terminal — the DB triggers are
        // the final backstops).
        const current = await store.lockTaskProfile(tx, input.taskProfileId);
        if (current === null) {
          throw new NotFoundError('task-profile', input.taskProfileId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `task profile version mismatch: current version is ${current.version}`,
          );
        }
        if (current.status === 'retired') {
          // Terminal tombstone: replaying stale identifiers cannot resurrect.
          throw new ConflictError(
            `task profile ${input.taskProfileId} is retired and terminal — corrections register a NEW profile`,
          );
        }
        const outcome = await store.updateTaskProfileStatus(tx, {
          taskProfileId: input.taskProfileId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('task profile retire lost the version race');
        }
        const updated = await store.lockTaskProfile(tx, input.taskProfileId);
        if (updated === null) {
          throw new Error(`retired task profile ${input.taskProfileId} could not be read back`);
        }
        return updated;
      });
    },

    // ----- Model registry ---------------------------------------------------

    async registerModel(input) {
      assertValidModelRegistrationInput(input.model);

      const inserted = await store.insertModel({
        model: input.model,
        actorId: input.actorId,
      });
      if (inserted === 'pair-taken') {
        throw new ConflictError(
          `an ACTIVE registry entry already exists for provider '${input.model.providerLabel}' model '${input.model.modelKey}'`,
        );
      }
      return inserted;
    },

    async getModel(modelRegistryId) {
      return store.getModel(modelRegistryId);
    },

    async listModels() {
      return store.listModels();
    },

    async appendModelObservation(input) {
      assertValidModelObservationInput({
        availabilityState: input.availabilityState,
        observedLatencyP50Ms: input.observedLatencyP50Ms,
        observedLatencyP95Ms: input.observedLatencyP95Ms,
        source: input.source,
        notes: input.notes,
      });
      if (typeof input.modelRegistryId !== 'string' || !SCOPE_ID_PATTERN.test(input.modelRegistryId)) {
        throw new NotFoundError('model', String(input.modelRegistryId));
      }

      // The model must exist (any lifecycle state — observations on a retired
      // entry still record history; the apply-state trigger never mutates a
      // tombstone). Uniform NotFoundError otherwise.
      const model = await store.getModel(input.modelRegistryId);
      if (model === null) {
        throw new NotFoundError('model', input.modelRegistryId);
      }

      // The append-only row is written once; the AFTER INSERT trigger
      // derives the registry row's current availability_state (the ONLY
      // sanctioned mutation path for that column).
      const observation = await store.insertModelObservation({
        modelRegistryId: input.modelRegistryId,
        availabilityState: input.availabilityState,
        observedLatencyP50Ms: input.observedLatencyP50Ms,
        observedLatencyP95Ms: input.observedLatencyP95Ms,
        source: input.source,
        notes: input.notes,
        actorId: input.actorId,
      });
      const after = await store.getModel(input.modelRegistryId);
      if (after === null) {
        throw new Error(`model ${input.modelRegistryId} could not be read back after observation`);
      }
      return { observation, model: after };
    },

    async listModelObservations(modelRegistryId) {
      return store.listModelObservations(modelRegistryId);
    },

    async retireModel(input) {
      return deps.db.transaction(async (tx) => {
        const current = await store.lockModel(tx, input.modelRegistryId);
        if (current === null) {
          throw new NotFoundError('model', input.modelRegistryId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(`model version mismatch: current version is ${current.version}`);
        }
        if (current.status === 'retired') {
          throw new ConflictError(
            `model ${input.modelRegistryId} is retired and terminal — corrections register a NEW entry`,
          );
        }
        const outcome = await store.updateModelStatus(tx, {
          modelRegistryId: input.modelRegistryId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('model retire lost the version race');
        }
        const updated = await store.lockModel(tx, input.modelRegistryId);
        if (updated === null) {
          throw new Error(`retired model ${input.modelRegistryId} could not be read back`);
        }
        return updated;
      });
    },

    // ----- Usage telemetry (append-only) ------------------------------------

    async appendUsageTelemetry(input) {
      assertValidUsageTelemetryInput(input.usage);
      assertScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      // REFERENCE pre-checks (clean uniform errors; the migration-016
      // scope-chain trigger is the backstop behind every one of them):
      //   - the TaskProfile must exist AND belong to the SAME Workspace — a
      //     foreign profile id is indistinguishable from an unknown one (no
      //     cross-tenant oracle);
      //   - the registry model must exist (any lifecycle state: history
      //     records invocations that HAPPENED — retiring a candidate never
      //     rewrites history);
      //   - the execution reference, when present, is validated through the
      //     /executions public API and must belong to the SAME Workspace
      //     (the frozen matrix direction /ai-runtime ──→ /executions).
      const profile = await store.getTaskProfile(input.usage.taskProfileId);
      if (profile === null || profile.workspaceId !== input.workspaceId) {
        throw new NotFoundError('task-profile', input.usage.taskProfileId);
      }
      const model = await store.getModel(input.usage.modelRegistryId);
      if (model === null) {
        throw new NotFoundError('model', input.usage.modelRegistryId);
      }
      if (input.usage.executionId !== null) {
        const execution = await executions.getExecution(input.usage.executionId);
        if (execution === null || execution.workspaceId !== input.workspaceId) {
          throw new NotFoundError('execution', input.usage.executionId);
        }
      }

      const createFingerprint = fingerprintUsageTelemetryAppend(input.workspaceId, input.usage);

      return deps.db.transaction(async (tx) => {
        const inserted = await store.insertUsageTelemetry(tx, {
          usage: input.usage,
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          correlationId: input.correlationId,
          createFingerprint,
          actorId: input.actorId,
        });
        if (inserted !== 'fence') {
          return { record: inserted, replayed: false };
        }
        // The §8-style fence fired: converge on the recorded command or
        // reject the key reuse — never a silent overwrite of history.
        const existing = await store.findUsageTelemetryByIdempotencyKey(
          tx,
          input.workspaceId,
          input.usage.idempotencyKey,
        );
        if (existing === null) {
          throw new ConflictError(
            `usage telemetry idempotency key '${input.usage.idempotencyKey}' fence fired but no record resolved`,
          );
        }
        if (existing.createFingerprint !== createFingerprint) {
          throw new IdempotencyConflictError(input.usage.idempotencyKey);
        }
        return { record: existing, replayed: true };
      });
    },

    async getUsageTelemetry(usageId) {
      return store.getUsageTelemetry(usageId);
    },

    async listUsageTelemetry(workspaceId, limit) {
      const bounded = limit === undefined ? 500 : Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return store.listUsageTelemetry(workspaceId, bounded);
    },
  };
}
