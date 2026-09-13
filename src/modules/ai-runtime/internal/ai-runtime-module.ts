/**
 * /ai-runtime module implementation (MKT-017, AI-001 + MKT-018, AI-002 +
 * MKT-019, AI-003).
 *
 * Implements the AI Runtime authority:
 *   - REGISTRY LAYER (MKT-017): provider-neutral TaskProfiles, the
 *     normalized model registry with its append-only availability/telemetry
 *     observations, and the append-oriented usage telemetry record — the
 *     neutral contracts that routing (MKT-018), evaluation (MKT-019) and
 *     provider adapters consume;
 *   - ROUTING LAYER (MKT-018): hard-eligibility filtering, performance
 *     ranking, cost/latency tradeoff, cheap-first cascade with escalation,
 *     provider-neutral adapter contract, and authoritative selection
 *     telemetry (spec/ai-runtime-and-routing.md §4/§5/§6/§9). The router
 *     is the /ai-runtime module itself (AI-AC-03) — OpenRouter is pluggable
 *     as an ADAPTER behind the provider-neutral contract;
 *   - EVALUATION LAYER (MKT-019): the provider-neutral evaluator registry,
 *     task-level evaluation runs derived from the TaskProfile evaluator
 *     contract (built-in deterministic evaluators + caller-supplied
 *     engines), append-only evaluation outcome records linked to the
 *     Execution and the usage telemetry, and the human-review hook
 *     (review-request records, pending → approved/rejected/dismissed,
 *     append-only transitions — the hook records intent/outcome, humans
 *     act through /jobs) (spec/ai-runtime-and-routing.md §7/§8,
 *     implementation-contract §12, AI-AC-08 independence from
 *     business-outcome measurement).
 *
 * What this implementation deliberately does NOT contain: no provider SDK
 * imports (the OpenRouter adapter uses the platform's HttpCallPort —
 * fetch-based, never an SDK; AI-AC-02), no credentials (routing-time
 * credential resolution is the composition root's job — the adapter takes
 * the API key, never the TaskProfile), no domain-module consumption of
 * routing (that stays via TaskProfiles), NO /metrics or /experiments
 * imports (AI-AC-08 — the evaluation layer reads
 * TaskProfile/execution/usage/evidence-citation context ONLY) and NO
 * human work distribution (the review hook records review state; /jobs
 * owns human execution).
 *
 * The module's cross-module dependencies are the frozen-matrix-sanctioned
 * /executions public API (telemetry + evaluation execution-reference
 * validation) and the /evidence public API (evaluation citation
 * validation — MKT-019); scope chains arrive as server-derived data
 * resolved by the caller (routes resolve canonical ownership BEFORE
 * authorize) and are DB-backstopped by the migration-016/020/032
 * scope-chain triggers.
 *
 * Convergence discipline (§8-style, exactly the MKT-009/MKT-010 pattern):
 * TaskProfile creates, telemetry appends, routing-policy creates,
 * selection-decision appends, cascade-run starts, per-evaluator evaluation
 * appends and review-request creates all carry a LOGICAL idempotency key
 * whose uniqueness the DATABASE enforces — a duplicate of the same
 * command (same create fingerprint) converges to the existing row
 * (replayed=true); a key reused for a different command is a
 * ConflictError. History is append-only: corrections create new records,
 * never overwrites.
 */

import { createHash } from 'node:crypto';
import { ConflictError, IdempotencyConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  AiRuntimeModuleApi,
  AiRuntimeModuleDeps,
  RoutingOutcome,
  SelectionDecisionRecord,
  TaskProfileInput,
  UsageTelemetryInput,
} from '../public.ts';
import type {
  EvaluationRecord,
  EvaluatorRecord,
  ReviewRequestDecision,
  ReviewRequestState,
} from '../public.ts';
import {
  assertValidIdempotencyKey,
  assertValidModelObservationInput,
  assertValidModelRegistrationInput,
  assertValidRoutingPolicyInput,
  assertValidTaskProfileInput,
  assertValidUsageTelemetryInput,
  AiRuntimeStore,
} from './ai-runtime-store.ts';
import {
  AiRoutingStore,
  assertRoutingScopeIds,
  fingerprintRoutingPolicyCreate,
  fingerprintSelectionDecisionAppend,
  fingerprintCascadeRunStart,
} from './ai-routing-store.ts';
import {
  AiEvaluationStore,
  assertValidEvaluationInput,
  assertValidEvaluatorRegistrationInput,
  assertValidReviewDecisionInput,
  assertValidReviewRequestInput,
  fingerprintEvaluationAppend,
  fingerprintReviewRequestCreate,
} from './ai-evaluation-store.ts';
import { runEvaluators } from './evaluation/evaluate.ts';
import type { CascadeRunRow, CascadeStepRow } from './ai-routing-store.ts';
import {
  interpretPolicy,
  selectModel,
} from './routing/policy.ts';
import { runCascade } from './routing/cascade.ts';
import type {
  CascadeRunRecord,
  CascadeRunStatus,
  CascadeStepRecord,
  CascadeStepType,
  UsageTelemetryOutcome,
  ValidatorResult,
} from '../public.ts';

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
  // MKT-018: the routing store (selection decisions, cascade runs/steps,
  // routing policies). Same module authority, deeper scope.
  const routingStore = new AiRoutingStore(deps.db, deps.clock, deps.ids);
  // MKT-019: the evaluation store (evaluator registry, evaluation outcome
  // records, review requests + transitions). Same module authority,
  // deeper scope.
  const evaluationStore = new AiEvaluationStore(deps.db, deps.clock, deps.ids);
  const { executions, evidence } = deps;

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
      //     (the frozen matrix direction /ai-runtime ──→ /executions);
      //   - MKT-019 WIRING: the evaluationRef, when present, must reference
      //     a REAL evaluation outcome record of the SAME Workspace (the
      //     MKT-017 placeholder is now a validated reference — usage
      //     telemetry's evaluator-outcome link is populated by real
      //     evaluation results, never fabricated strings). A foreign or
      //     unknown reference is a uniform NotFoundError.
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
      if (input.usage.evaluationRef !== null && input.usage.evaluationRef !== undefined && input.usage.evaluationRef !== '') {
        const evaluation = await evaluationStore.getEvaluation(input.usage.evaluationRef);
        if (evaluation === null || evaluation.workspaceId !== input.workspaceId) {
          throw new NotFoundError('evaluation', input.usage.evaluationRef);
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

    // ----- Routing policies (MKT-018, AI-002) -----------------------------

    async createRoutingPolicy(input) {
      assertValidRoutingPolicyInput(input.policy);
      assertValidIdempotencyKey(input.idempotencyKey);
      assertRoutingScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });

      const createFingerprint = fingerprintRoutingPolicyCreate(input.workspaceId, input.policy);

      return deps.db.transaction(async (tx) => {
        const inserted = await routingStore.insertRoutingPolicy(tx, {
          policy: input.policy,
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
          actorId: input.actorId,
        });
        if (inserted === 'name-taken') {
          throw new ConflictError(
            `an ACTIVE routing policy named '${input.policy.policyName}' already exists in this Workspace`,
          );
        }
        if (inserted !== 'fence') {
          return { routingPolicy: inserted, replayed: false };
        }
        // The §8-style fence fired: converge on the recorded command or
        // reject the key reuse.
        const existing = await routingStore.findRoutingPolicyByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (existing === null) {
          throw new ConflictError(
            `routing policy idempotency key '${input.idempotencyKey}' fence fired but no record resolved`,
          );
        }
        if (existing.createFingerprint !== createFingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { routingPolicy: existing, replayed: true };
      });
    },

    async getRoutingPolicy(routingPolicyId) {
      return routingStore.getRoutingPolicy(routingPolicyId);
    },

    async listRoutingPolicies(workspaceId) {
      return routingStore.listRoutingPolicies(workspaceId);
    },

    async retireRoutingPolicy(input) {
      return deps.db.transaction(async (tx) => {
        const current = await routingStore.lockRoutingPolicy(tx, input.routingPolicyId);
        if (current === null) {
          throw new NotFoundError('routing-policy', input.routingPolicyId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(
            `routing policy version mismatch: current version is ${current.version}`,
          );
        }
        if (current.status === 'retired') {
          throw new ConflictError(
            `routing policy ${input.routingPolicyId} is retired and terminal — corrections register a NEW policy`,
          );
        }
        const outcome = await routingStore.updateRoutingPolicyStatus(tx, {
          routingPolicyId: input.routingPolicyId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('routing policy retire lost the version race');
        }
        const updated = await routingStore.lockRoutingPolicy(tx, input.routingPolicyId);
        if (updated === null) {
          throw new Error(`retired routing policy ${input.routingPolicyId} could not be read back`);
        }
        return updated;
      });
    },

    // ----- Routing decision (selection + cascade) -------------------------

    async routeTask(input) {
      assertValidIdempotencyKey(input.idempotencyKey);
      assertRoutingScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      // REFERENCE pre-checks (clean uniform errors; the migration-020
      // scope-chain trigger is the backstop):
      //   - the TaskProfile must exist AND belong to the SAME Workspace;
      //   - the routing policy, when present, must exist AND belong to the
      //     SAME Workspace.
      const profile = await store.getTaskProfile(input.taskProfileId);
      if (profile === null || profile.workspaceId !== input.workspaceId) {
        throw new NotFoundError('task-profile', input.taskProfileId);
      }
      let policyRecord = null;
      if (input.routingPolicyId !== null) {
        policyRecord = await routingStore.getRoutingPolicy(input.routingPolicyId);
        if (policyRecord === null || policyRecord.workspaceId !== input.workspaceId) {
          throw new NotFoundError('routing-policy', input.routingPolicyId);
        }
      }

      // Load the registry models (the routing operates on the ACTIVE
      // registry entries — retired entries are tombstones, not candidates).
      const models = await store.listModels();

      // Apply the routing policy (§4: eligibility → ranking → tradeoff →
      // selection). The policy is interpreted from the declarative JSON
      // content; the routing core depends on the PURE functions in
      // routing/policy.ts — no provider SDK is imported.
      const interpreted = interpretPolicy(policyRecord);
      const selection = selectModel({
        taskProfile: profile,
        models,
        policy: interpreted,
      });

      // The eligible models (the routing-decision eligible set).
      const eligibleModels = models.filter((m) =>
        selection.eligibleSet.some(
          (d) => d.modelRegistryId === m.modelRegistryId && d.eligible,
        ),
      );

      // Run the cheap-first cascade with the supplied adapter + validator
      // (§5). The cascade is the AI-AC-05 proof — validator failure
      // escalates to the stronger model.
      const cascadeRunFingerprint = fingerprintCascadeRunStart(input.workspaceId, {
        taskProfileId: input.taskProfileId,
        routingPolicyId: input.routingPolicyId,
        maxEscalations: interpreted.maxEscalations,
      });

      return deps.db.transaction(async (tx) => {
        // Start the cascade run (fenced by the §8-style key).
        let cascadeRun = await routingStore.insertCascadeRun(tx, {
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          taskProfileId: input.taskProfileId,
          routingPolicyId: input.routingPolicyId,
          maxEscalations: interpreted.maxEscalations,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          createFingerprint: cascadeRunFingerprint,
          actorId: input.actorId,
        });
        let replayed = false;
        if (cascadeRun === 'fence') {
          // The §8-style fence fired: converge on the recorded cascade run.
          const existing = await routingStore.findCascadeRunByIdempotencyKey(
            tx,
            input.workspaceId,
            input.idempotencyKey,
          );
          if (existing === null) {
            throw new ConflictError(
              `cascade run idempotency key '${input.idempotencyKey}' fence fired but no record resolved`,
            );
          }
          if (existing.createFingerprint !== cascadeRunFingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          // Replay: return the existing cascade run + the recorded
          // selection decision (if any).
          cascadeRun = existing;
          replayed = true;
          const existingSelection = await routingStore.findSelectionDecisionByIdempotencyKey(
            tx,
            input.workspaceId,
            `cascade:${input.idempotencyKey}`,
          );
          if (existingSelection !== null) {
            return {
              selection: existingSelection,
              cascadeRun: cascadeRun,
              finalOutput: null,
            } satisfies RoutingOutcome;
          }
          // The fence fired but no selection decision was recorded —
          // fall through to record a fresh selection decision (the cascade
          // run was started but the routing decision was not persisted
          // before the failure; this is a recovery path).
        }

        // Run the cascade (the AI-AC-05 proof).
        const cascadeResult = await runCascade({
          taskProfile: profile,
          policy: interpreted,
          eligibleModels,
          selection,
          adapter: input.adapter,
          validator: input.validator,
          invocationInput: input.invocationInput,
        });

        // Persist the cascade steps (append-only history) and collect the
        // inserted records (the store uses the transaction connection, so
        // the read-back must share the transaction — we collect the inserted
        // records here rather than re-reading through this.db, which would
        // not see the uncommitted changes).
        for (const step of cascadeResult.steps) {
          await routingStore.insertCascadeStep(tx, {
            cascadeRunId: cascadeRun.cascadeRunId,
            step,
          });
        }
        // Re-read the cascade steps through the transaction so the final
        // record includes the just-inserted rows (the store's listCascadeSteps
        // uses this.db; we need a tx-aware read here).
        const finalSteps = await tx.query<CascadeStepRow>(
          `SELECT cascade_step_id, cascade_run_id, step_index, model_registry_id, step_type,
                  validator_result, validator_reason, observed_latency_ms, observed_cost_amount,
                  evaluation_ref, outcome, created_at
           FROM ai_cascade_steps WHERE cascade_run_id = $1 ORDER BY step_index, cascade_step_id`,
          [cascadeRun.cascadeRunId],
        );
        const cascadeStepRecords: CascadeStepRecord[] = finalSteps.rows.map((row) => ({
          cascadeStepId: row.cascade_step_id,
          cascadeRunId: row.cascade_run_id,
          stepIndex: Number(row.step_index),
          modelRegistryId: row.model_registry_id ?? '',
          stepType: row.step_type as CascadeStepType,
          validatorResult: row.validator_result as ValidatorResult,
          validatorReason: row.validator_reason,
          observedLatencyMs: row.observed_latency_ms === null ? null : Number(row.observed_latency_ms),
          observedCostAmount: row.observed_cost_amount === null ? null : Number(row.observed_cost_amount),
          evaluationRef: row.evaluation_ref,
          outcome: row.outcome as UsageTelemetryOutcome,
          createdAt: row.created_at.toISOString(),
        }));

        // Update the cascade run state (CAS on the version).
        const updateOutcome = await routingStore.updateCascadeRunStatus(tx, {
          cascadeRunId: cascadeRun.cascadeRunId,
          expectedVersion: cascadeRun.version,
          status: cascadeResult.status,
          finalModelRegistryId: cascadeResult.finalModelRegistryId,
          escalationCount: cascadeResult.escalationCount,
        });
        if (updateOutcome !== 'ok') {
          throw new ConflictError('cascade run state update lost the version race');
        }

        // Re-read the cascade run row through the transaction (the run row
        // was just updated; we need the updated version and updated_at).
        const finalRunRow = await tx.query<CascadeRunRow>(
          `SELECT cascade_run_id, workspace_id, client_id, agency_id, task_profile_id, routing_policy_id,
                  status, final_model_registry_id, escalation_count, max_escalations, correlation_id,
                  idempotency_key, create_fingerprint, created_by, version, created_at, updated_at
           FROM ai_cascade_runs WHERE cascade_run_id = $1`,
          [cascadeRun.cascadeRunId],
        );
        const finalRunRowData = finalRunRow.rows[0];
        if (finalRunRowData === undefined) {
          throw new Error(`cascade run ${cascadeRun.cascadeRunId} could not be read back after update`);
        }
        const finalCascadeRun: CascadeRunRecord = {
          cascadeRunId: finalRunRowData.cascade_run_id,
          workspaceId: finalRunRowData.workspace_id,
          clientId: finalRunRowData.client_id,
          agencyId: finalRunRowData.agency_id,
          taskProfileId: finalRunRowData.task_profile_id,
          routingPolicyId: finalRunRowData.routing_policy_id,
          status: finalRunRowData.status as CascadeRunStatus,
          finalModelRegistryId: finalRunRowData.final_model_registry_id,
          escalationCount: Number(finalRunRowData.escalation_count),
          maxEscalations: Number(finalRunRowData.max_escalations),
          correlationId: finalRunRowData.correlation_id,
          idempotencyKey: finalRunRowData.idempotency_key,
          createFingerprint: finalRunRowData.create_fingerprint,
          createdBy: finalRunRowData.created_by,
          version: Number(finalRunRowData.version),
          createdAt: finalRunRowData.created_at.toISOString(),
          updatedAt: finalRunRowData.updated_at.toISOString(),
          cascadeSteps: cascadeStepRecords,
        };

        // Compute the authoritative observed cost/latency telemetry from
        // the cascade steps (the AI-AC-06 telemetry payload).
        const observedLatencyMs = cascadeResult.steps.reduce(
          (sum, s) => sum + (s.observedLatencyMs ?? 0),
          0,
        );
        const observedCostAmount = cascadeResult.steps.reduce(
          (sum, s) => sum + (s.observedCostAmount ?? 0),
          0,
        );

        // Persist the selection decision (AUTHORITATIVE — the cascade
        // invoked models and observed cost/latency). The idempotency key
        // is namespaced with 'cascade:' to keep the decision fence
        // separate from the cascade-run fence.
        const selectionFingerprint = fingerprintSelectionDecisionAppend(input.workspaceId, {
          taskProfileId: input.taskProfileId,
          routingPolicyId: input.routingPolicyId,
          chosenModelRegistryId: selection.chosenModelRegistryId,
          cascadeRunId: cascadeRun.cascadeRunId,
          authoritative: true,
        });
        const selectionIdempotencyKey = `cascade:${input.idempotencyKey}`;
        const insertedSelection = await routingStore.insertSelectionDecision(tx, {
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          taskProfileId: input.taskProfileId,
          routingPolicyId: input.routingPolicyId,
          eligibleSet: selection.eligibleSet,
          ranking: selection.ranking,
          tradeoff: selection.tradeoff,
          chosenModelRegistryId: selection.chosenModelRegistryId,
          cascadeRunId: cascadeRun.cascadeRunId,
          phaseTrace: selection.phaseTrace,
          authoritative: true,
          observedLatencyMs,
          observedCostAmount,
          evaluationRef: null, // placeholder until MKT-019
          correlationId: input.correlationId,
          idempotencyKey: selectionIdempotencyKey,
          createFingerprint: selectionFingerprint,
          actorId: input.actorId,
        });
        let finalSelection: SelectionDecisionRecord;
        if (insertedSelection !== 'fence') {
          finalSelection = insertedSelection;
        } else {
          // The selection-decision fence fired: converge on the recorded
          // decision (the cascade run was a replay, and the decision was
          // already recorded).
          const existing = await routingStore.findSelectionDecisionByIdempotencyKey(
            tx,
            input.workspaceId,
            selectionIdempotencyKey,
          );
          if (existing === null) {
            throw new ConflictError(
              `selection decision idempotency key '${selectionIdempotencyKey}' fence fired but no record resolved`,
            );
          }
          if (existing.createFingerprint !== selectionFingerprint) {
            throw new IdempotencyConflictError(selectionIdempotencyKey);
          }
          finalSelection = existing;
        }

        // Re-read the cascade run to get the updated state (with steps).
        // (Already constructed as finalCascadeRun above — no re-read needed.)

        void replayed; // the replayed flag is implicit in the persisted records

        return {
          selection: finalSelection,
          cascadeRun: finalCascadeRun,
          finalOutput: cascadeResult.finalOutput,
        } satisfies RoutingOutcome;
      });
    },

    async previewRouting(input) {
      assertValidIdempotencyKey(input.idempotencyKey);
      assertRoutingScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      // REFERENCE pre-checks (same posture as routeTask).
      const profile = await store.getTaskProfile(input.taskProfileId);
      if (profile === null || profile.workspaceId !== input.workspaceId) {
        throw new NotFoundError('task-profile', input.taskProfileId);
      }
      let policyRecord = null;
      if (input.routingPolicyId !== null) {
        policyRecord = await routingStore.getRoutingPolicy(input.routingPolicyId);
        if (policyRecord === null || policyRecord.workspaceId !== input.workspaceId) {
          throw new NotFoundError('routing-policy', input.routingPolicyId);
        }
      }

      const models = await store.listModels();
      const interpreted = interpretPolicy(policyRecord);
      const selection = selectModel({
        taskProfile: profile,
        models,
        policy: interpreted,
      });

      const selectionFingerprint = fingerprintSelectionDecisionAppend(input.workspaceId, {
        taskProfileId: input.taskProfileId,
        routingPolicyId: input.routingPolicyId,
        chosenModelRegistryId: selection.chosenModelRegistryId,
        cascadeRunId: null,
        authoritative: false,
      });
      const selectionIdempotencyKey = `preview:${input.idempotencyKey}`;

      return deps.db.transaction(async (tx) => {
        const inserted = await routingStore.insertSelectionDecision(tx, {
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          taskProfileId: input.taskProfileId,
          routingPolicyId: input.routingPolicyId,
          eligibleSet: selection.eligibleSet,
          ranking: selection.ranking,
          tradeoff: selection.tradeoff,
          chosenModelRegistryId: selection.chosenModelRegistryId,
          cascadeRunId: null,
          phaseTrace: selection.phaseTrace,
          authoritative: false,
          observedLatencyMs: null,
          observedCostAmount: null,
          evaluationRef: null,
          correlationId: input.correlationId,
          idempotencyKey: selectionIdempotencyKey,
          createFingerprint: selectionFingerprint,
          actorId: input.actorId,
        });
        if (inserted !== 'fence') {
          return inserted;
        }
        const existing = await routingStore.findSelectionDecisionByIdempotencyKey(
          tx,
          input.workspaceId,
          selectionIdempotencyKey,
        );
        if (existing === null) {
          throw new ConflictError(
            `selection decision idempotency key '${selectionIdempotencyKey}' fence fired but no record resolved`,
          );
        }
        if (existing.createFingerprint !== selectionFingerprint) {
          throw new IdempotencyConflictError(selectionIdempotencyKey);
        }
        return existing;
      });
    },

    async getSelectionDecision(selectionId) {
      return routingStore.getSelectionDecision(selectionId);
    },

    async listSelectionDecisions(workspaceId, limit) {
      const bounded = limit === undefined ? 500 : Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return routingStore.listSelectionDecisions(workspaceId, bounded);
    },

    async getCascadeRun(cascadeRunId) {
      return routingStore.getCascadeRun(cascadeRunId);
    },

    async listCascadeRuns(workspaceId, limit) {
      const bounded = limit === undefined ? 500 : Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return routingStore.listCascadeRuns(workspaceId, bounded);
    },

    // ----- Evaluation framework (MKT-019, AI-003) --------------------------

    async registerEvaluator(input) {
      assertValidEvaluatorRegistrationInput(input.evaluator);
      const inserted = await evaluationStore.insertEvaluator({
        evaluator: input.evaluator,
        actorId: input.actorId,
      });
      if (inserted === 'key-taken') {
        throw new ConflictError(
          `an ACTIVE evaluator with key '${input.evaluator.evaluatorKey}' already exists (a retired key may be re-registered as a NEW identity)`,
        );
      }
      return inserted;
    },

    async getEvaluator(evaluatorRegistryId) {
      return evaluationStore.getEvaluator(evaluatorRegistryId);
    },

    async listEvaluators() {
      return evaluationStore.listEvaluators();
    },

    async retireEvaluator(input) {
      return deps.db.transaction(async (tx) => {
        const current = await evaluationStore.lockEvaluator(tx, input.evaluatorRegistryId);
        if (current === null) {
          throw new NotFoundError('evaluator', input.evaluatorRegistryId);
        }
        if (current.version !== input.expectedVersion) {
          throw new ConflictError(`evaluator version mismatch: current version is ${current.version}`);
        }
        if (current.status === 'retired') {
          throw new ConflictError(
            `evaluator ${input.evaluatorRegistryId} is retired and terminal — corrections register a NEW evaluator`,
          );
        }
        const outcome = await evaluationStore.updateEvaluatorStatus(tx, {
          evaluatorRegistryId: input.evaluatorRegistryId,
          expectedVersion: input.expectedVersion,
        });
        if (outcome !== 'ok') {
          throw new ConflictError('evaluator retire lost the version race');
        }
        const updated = await evaluationStore.lockEvaluator(tx, input.evaluatorRegistryId);
        if (updated === null) {
          throw new Error(`retired evaluator ${input.evaluatorRegistryId} could not be read back`);
        }
        return updated;
      });
    },

    async evaluateTask(input) {
      assertValidEvaluationInput({
        taskProfileId: input.taskProfileId,
        executionId: input.executionId,
        usageId: input.usageId,
        output: input.output,
        adapterError: input.adapterError,
        idempotencyKey: input.idempotencyKey,
      });
      assertValidIdempotencyKey(input.idempotencyKey);
      assertScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      // REFERENCE pre-checks (clean uniform errors; the migration-032
      // scope-chain trigger is the backstop behind every one of them):
      //   - the TaskProfile must exist AND belong to the SAME Workspace
      //     (the evaluation request is derived from ITS evaluator contract);
      //   - the usage-telemetry reference, when present, must belong to the
      //     SAME Workspace (the §24 evaluator-outcome link);
      //   - the execution reference, when present, is validated through the
      //     /executions public API and must belong to the SAME Workspace
      //     (server-proven execution linkage — never caller-controlled).
      const profile = await store.getTaskProfile(input.taskProfileId);
      if (profile === null || profile.workspaceId !== input.workspaceId) {
        throw new NotFoundError('task-profile', input.taskProfileId);
      }
      if (input.usageId !== null) {
        const usage = await store.getUsageTelemetry(input.usageId);
        if (usage === null || usage.workspaceId !== input.workspaceId) {
          throw new NotFoundError('usage-telemetry', input.usageId);
        }
      }
      if (input.executionId !== null) {
        const execution = await executions.getExecution(input.executionId);
        if (execution === null || execution.workspaceId !== input.workspaceId) {
          throw new NotFoundError('execution', input.executionId);
        }
      }

      // DERIVE the evaluation request from the TaskProfile's evaluator
      // contract (evaluatorIds are LABELS, never caller-selected here):
      // every key must resolve to its ACTIVE registry entry — an
      // unknown/unsatisfiable key is a uniform NotFoundError.
      const evaluatorRecords: EvaluatorRecord[] = [];
      for (const evaluatorKey of profile.evaluatorIds) {
        const evaluator = await evaluationStore.findActiveEvaluatorByKey(evaluatorKey);
        if (evaluator === null) {
          throw new NotFoundError('evaluator', evaluatorKey);
        }
        evaluatorRecords.push(evaluator);
      }

      // RUN the evaluators (built-ins and/or caller-supplied engines; a
      // missing implementation is a ConflictError — the contract is never
      // silently half-evaluated). The §12 payloads are guarded inside.
      const runResults = await runEvaluators({
        taskProfile: profile,
        evaluators: evaluatorRecords,
        output: input.output,
        adapterError: input.adapterError,
        engines: input.engines,
      });

      // VALIDATE the evidence citations through the /evidence public API
      // (matrix direction /ai-runtime ──→ /evidence): every citation must
      // exist and belong to the SAME Client — a fabricated or foreign
      // citation is a uniform NotFoundError. This module NEVER becomes a
      // second evidence authority: it records references it cannot honor.
      for (const runResult of runResults) {
        for (const evidenceRef of runResult.result.evidenceRefs) {
          // A non-UUID citation is indistinguishable from an unknown one
          // (uniform NotFoundError — never a syntax error surfaced as a
          // 500 from the uuid column).
          if (!SCOPE_ID_PATTERN.test(evidenceRef)) {
            throw new NotFoundError('evidence', evidenceRef);
          }
          const evidenceRecord = await evidence.getEvidence(evidenceRef);
          if (evidenceRecord === null || evidenceRecord.clientId !== input.clientId) {
            throw new NotFoundError('evidence', evidenceRef);
          }
        }
      }

      // RECORD the append-only outcome rows (one per evaluator, fenced by
      // (workspace, key, evaluatorKey)); a fence firing converges the
      // per-evaluator slice of this logical evaluation command.
      return deps.db.transaction(async (tx) => {
        const evaluations: EvaluationRecord[] = [];
        let replayed = false;
        for (const runResult of runResults) {
          const createFingerprint = fingerprintEvaluationAppend({
            workspaceId: input.workspaceId,
            taskProfileId: input.taskProfileId,
            executionId: input.executionId,
            usageId: input.usageId,
            evaluatorKey: runResult.evaluator.evaluatorKey,
            evaluatorVersion: runResult.evaluator.evaluatorVersion,
            result: runResult.result,
          });
          const inserted = await evaluationStore.insertEvaluation(tx, {
            workspaceId: input.workspaceId,
            clientId: input.clientId,
            agencyId: input.agencyId,
            taskProfileId: input.taskProfileId,
            executionId: input.executionId,
            usageId: input.usageId,
            evaluatorRegistryId: runResult.evaluator.evaluatorRegistryId,
            evaluatorKey: runResult.evaluator.evaluatorKey,
            evaluatorVersion: runResult.evaluator.evaluatorVersion,
            result: runResult.result,
            correlationId: input.correlationId,
            idempotencyKey: input.idempotencyKey,
            createFingerprint,
            actorId: input.actorId,
          });
          if (inserted !== 'fence') {
            evaluations.push(inserted);
            continue;
          }
          // The §8-style fence fired: converge on the recorded command or
          // reject the key reuse — never a silent rewrite of history.
          const existing = await evaluationStore.findEvaluationByIdempotencyKey(
            tx,
            input.workspaceId,
            input.idempotencyKey,
            runResult.evaluator.evaluatorKey,
          );
          if (existing === null) {
            throw new ConflictError(
              `evaluation idempotency key '${input.idempotencyKey}' fence fired but no record resolved for evaluator '${runResult.evaluator.evaluatorKey}'`,
            );
          }
          if (existing.createFingerprint !== createFingerprint) {
            throw new IdempotencyConflictError(input.idempotencyKey);
          }
          evaluations.push(existing);
          replayed = true;
        }
        return { evaluations, replayed };
      });
    },

    async getEvaluation(evaluationId) {
      return evaluationStore.getEvaluation(evaluationId);
    },

    async listEvaluations(workspaceId, limit) {
      const bounded = limit === undefined ? 500 : Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return evaluationStore.listEvaluations(workspaceId, bounded);
    },

    // ----- Human-review hook (records intent/outcome — never executes) ------

    async requestReview(input) {
      assertValidReviewRequestInput({
        executionId: input.executionId,
        evaluationId: input.evaluationId,
        reason: input.reason,
        idempotencyKey: input.idempotencyKey,
      });
      assertValidIdempotencyKey(input.idempotencyKey);
      assertScopeIds({
        workspaceId: input.workspaceId,
        clientId: input.clientId,
        agencyId: input.agencyId,
      });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      // REFERENCE pre-checks (uniform NotFoundError; the migration-032
      // scope-chain trigger is the backstop): the execution reference,
      // when present, is validated through the /executions public API
      // (same-Workspace); the evaluation reference, when present, must
      // belong to the SAME Workspace.
      if (input.executionId !== null) {
        const execution = await executions.getExecution(input.executionId);
        if (execution === null || execution.workspaceId !== input.workspaceId) {
          throw new NotFoundError('execution', input.executionId);
        }
      }
      if (input.evaluationId !== null) {
        const evaluation = await evaluationStore.getEvaluation(input.evaluationId);
        if (evaluation === null || evaluation.workspaceId !== input.workspaceId) {
          throw new NotFoundError('evaluation', input.evaluationId);
        }
      }

      const createFingerprint = fingerprintReviewRequestCreate({
        workspaceId: input.workspaceId,
        executionId: input.executionId,
        evaluationId: input.evaluationId,
        reason: input.reason,
      });

      return deps.db.transaction(async (tx) => {
        const inserted = await evaluationStore.insertReviewRequest(tx, {
          workspaceId: input.workspaceId,
          clientId: input.clientId,
          agencyId: input.agencyId,
          executionId: input.executionId,
          evaluationId: input.evaluationId,
          reason: input.reason,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          createFingerprint,
          actorId: input.actorId,
        });
        if (inserted !== 'fence') {
          return { reviewRequest: inserted, replayed: false };
        }
        // The §8-style fence fired: converge on the recorded command or
        // reject the key reuse.
        const existing = await evaluationStore.findReviewRequestByIdempotencyKey(
          tx,
          input.workspaceId,
          input.idempotencyKey,
        );
        if (existing === null) {
          throw new ConflictError(
            `review request idempotency key '${input.idempotencyKey}' fence fired but no record resolved`,
          );
        }
        if (existing.createFingerprint !== createFingerprint) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        const withTransitions = await evaluationStore.getReviewRequest(existing.reviewRequestId);
        return { reviewRequest: withTransitions ?? existing, replayed: true };
      });
    },

    async decideReview(input) {
      assertValidReviewDecisionInput({ decision: input.decision, note: input.note });
      if (typeof input.correlationId !== 'string' || input.correlationId.length < 1 || input.correlationId.length > 128) {
        throw new ConflictError('correlationId must be the server-derived ambient correlation identity');
      }

      const TO_STATE: Record<ReviewRequestDecision, ReviewRequestState> = {
        approve: 'approved',
        reject: 'rejected',
        dismiss: 'dismissed',
      };
      const toState = TO_STATE[input.decision];

      return deps.db.transaction(async (tx) => {
        // Lock the request row (uniform NotFoundError for unknown ids — a
        // foreign review request id is indistinguishable from an unknown
        // one; the ROUTE layer additionally authorizes scope BEFORE this).
        const current = await evaluationStore.lockReviewRequest(tx, input.reviewRequestId);
        if (current === null) {
          throw new NotFoundError('review-request', input.reviewRequestId);
        }
        if (current.state !== 'pending') {
          throw new ConflictError(
            `review request ${input.reviewRequestId} is ${current.state} and terminal — the decision is append-only history`,
          );
        }
        const updated = await evaluationStore.applyReviewDecision(tx, {
          reviewRequestId: input.reviewRequestId,
          fromState: 'pending',
          toState,
          decidedBy: input.actorId,
          note: input.note,
        });
        if (updated === null) {
          throw new ConflictError('review request decision lost the state race (exactly-one decision fence)');
        }
        return updated;
      });
    },

    async getReviewRequest(reviewRequestId) {
      return evaluationStore.getReviewRequest(reviewRequestId);
    },

    async listReviewRequests(workspaceId, state, limit) {
      const bounded = limit === undefined ? 500 : Math.min(Math.max(Math.trunc(limit), 1), 1000);
      return evaluationStore.listReviewRequests(workspaceId, state, bounded);
    },
  };
}
