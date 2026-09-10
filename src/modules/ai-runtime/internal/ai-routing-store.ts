/**
 * /ai-runtime ROUTING persistence (MKT-018, AI-002).
 *
 * Tables (migration 020): ai_routing_policies, ai_selection_decisions,
 * ai_cascade_runs, ai_cascade_steps.
 *
 * DB backstops behind this store (implementation-contract §3, §25, mirroring
 * migration 016):
 *   - routing-policy CONTENT is immutable (trigger): identity, the policy
 *     name, the policy content, the idempotency identity, the server-derived
 *     Workspace/Client/Agency scope and the provenance can never be
 *     reassigned — corrections register a NEW policy; `retired` is terminal;
 *   - selection decisions are APPEND-ONLY history (trigger rejects UPDATE
 *     and DELETE) and the (workspace_id, idempotency_key) §8-style fence
 *     makes the logical append command converge (same fingerprint → replay;
 *     different fingerprint → conflict);
 *   - cascade runs hold the overall state (status, final model, escalation
 *     count) with CAS version; the scope-chain trigger backstops tenant
 *     isolation;
 *   - cascade steps are APPEND-ONLY history (trigger rejects UPDATE and
 *     DELETE) — the cascade is a recorded, replayable structure;
 *   - the scope-chain triggers reject any row whose Workspace/Client/Agency
 *     chain is inconsistent, whose TaskProfile belongs to another Workspace,
 *     or whose routing policy reference belongs to another Workspace —
 *     tenant isolation holds even under direct SQL rewrites.
 *
 * This store is INTENTIONALLY SEPARATE from the registry store
 * (ai-runtime-store.ts): the registry store owns TaskProfiles, the model
 * registry, observations and usage telemetry (MKT-017); this store owns
 * routing policies, selection decisions, cascade runs and cascade steps
 * (MKT-018). Both are part of the SAME /ai-runtime module authority
 * (implementation-contract §1) — the module's createAiRuntimeModule
 * composes them.
 */

import { createHash } from 'node:crypto';
import { ConflictError, IdempotencyConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  CascadeRunRecord,
  CascadeRunStatus,
  CascadeStepRecord,
  CascadeStepType,
  EligibilityDecision,
  ModelRegistryRecord,
  RankingScore,
  RoutingPhase,
  RoutingPolicyInput,
  RoutingPolicyRecord,
  RoutingPolicyStatus,
  SelectionDecisionRecord,
  TaskProfileRecord,
  TradeoffScore,
  UsageTelemetryOutcome,
  ValidatorResult,
} from '../public.ts';
import { CASCADE_RUN_STATUSES, CASCADE_STEP_TYPES, VALIDATOR_RESULTS } from '../public.ts';
import type { CascadeStepOutcome } from './routing/cascade.ts';

const SCOPE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface RoutingPolicyRow extends DbRow {
  routing_policy_id: string;
  policy_name: string;
  policy_content: Record<string, unknown>;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  status: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

interface SelectionDecisionRow extends DbRow {
  selection_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  task_profile_id: string;
  routing_policy_id: string | null;
  eligible_set: unknown[];
  ranking: unknown[];
  tradeoff: unknown[];
  chosen_model_registry_id: string;
  cascade_run_id: string | null;
  phase_trace: unknown[];
  authoritative: boolean;
  observed_latency_ms: number | string | null;
  observed_cost_amount: string | null;
  evaluation_ref: string | null;
  correlation_id: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
}

export interface CascadeRunRow extends DbRow {
  cascade_run_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  task_profile_id: string;
  routing_policy_id: string | null;
  status: string;
  final_model_registry_id: string | null;
  escalation_count: number;
  max_escalations: number;
  correlation_id: string;
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  version: number | string;
  created_at: Date;
  updated_at: Date;
}

export interface CascadeStepRow extends DbRow {
  cascade_step_id: string;
  cascade_run_id: string;
  step_index: number;
  model_registry_id: string;
  step_type: string;
  validator_result: string;
  validator_reason: string | null;
  observed_latency_ms: number | string | null;
  observed_cost_amount: string | null;
  evaluation_ref: string | null;
  outcome: string;
  created_at: Date;
}

const ROUTING_POLICY_SELECT = `
  SELECT routing_policy_id, policy_name, policy_content, workspace_id, client_id, agency_id,
         status, idempotency_key, create_fingerprint, created_by, version, created_at, updated_at
  FROM ai_routing_policies
`;

const SELECTION_DECISION_SELECT = `
  SELECT selection_id, workspace_id, client_id, agency_id, task_profile_id, routing_policy_id,
         eligible_set, ranking, tradeoff, chosen_model_registry_id, cascade_run_id, phase_trace,
         authoritative, observed_latency_ms, observed_cost_amount, evaluation_ref, correlation_id,
         idempotency_key, create_fingerprint, created_by, created_at
  FROM ai_selection_decisions
`;

const CASCADE_RUN_SELECT = `
  SELECT cascade_run_id, workspace_id, client_id, agency_id, task_profile_id, routing_policy_id,
         status, final_model_registry_id, escalation_count, max_escalations, correlation_id,
         idempotency_key, create_fingerprint, created_by, version, created_at, updated_at
  FROM ai_cascade_runs
`;

const CASCADE_STEP_SELECT = `
  SELECT cascade_step_id, cascade_run_id, step_index, model_registry_id, step_type, validator_result,
         validator_reason, observed_latency_ms, observed_cost_amount, evaluation_ref, outcome, created_at
  FROM ai_cascade_steps
`;

// ---------------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------------

function fingerprintRoutingPolicyCreate(workspaceId: string, policy: RoutingPolicyInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.routing-policy.create',
        workspaceId,
        policyName: policy.policyName,
        policyContent: policy.policyContent,
      }),
    )
    .digest('hex');
}

function fingerprintSelectionDecisionAppend(
  workspaceId: string,
  input: {
    readonly taskProfileId: string;
    readonly routingPolicyId: string | null;
    readonly chosenModelRegistryId: string;
    readonly cascadeRunId: string | null;
    readonly authoritative: boolean;
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.selection-decision.append',
        workspaceId,
        taskProfileId: input.taskProfileId,
        routingPolicyId: input.routingPolicyId,
        chosenModelRegistryId: input.chosenModelRegistryId,
        cascadeRunId: input.cascadeRunId,
        authoritative: input.authoritative,
      }),
    )
    .digest('hex');
}

function fingerprintCascadeRunStart(
  workspaceId: string,
  input: {
    readonly taskProfileId: string;
    readonly routingPolicyId: string | null;
    readonly maxEscalations: number;
  },
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        shape: 'ai.cascade-run.start',
        workspaceId,
        taskProfileId: input.taskProfileId,
        routingPolicyId: input.routingPolicyId,
        maxEscalations: input.maxEscalations,
      }),
    )
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class AiRoutingStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // ----- Routing policies ---------------------------------------------------

  /**
   * Insert fenced by the (workspace_id, idempotency_key) §8-style unique
   * constraint AND the (workspace_id, policy_name) partial unique index
   * among ACTIVE entries. 'fence' means the logical create key already
   * exists in this Workspace — the CALLER resolves convergence. 'name-
   * taken' means an ACTIVE policy with the same name already exists in this
   * Workspace — a deterministic ConflictError.
   */
  async insertRoutingPolicy(
    tx: DbTransaction,
    input: {
      readonly policy: RoutingPolicyInput;
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<RoutingPolicyRecord | 'fence' | 'name-taken'> {
    const routingPolicyId = this.ids.newId();
    const now = this.clock.nowIso();
    let result;
    try {
      result = await tx.query(
        `INSERT INTO ai_routing_policies
           (routing_policy_id, policy_name, policy_content, workspace_id, client_id, agency_id,
            status, idempotency_key, create_fingerprint, created_by, version, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'active', $7, $8, $9, 1, $10, $10)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [
          routingPolicyId,
          input.policy.policyName,
          JSON.stringify(input.policy.policyContent),
          input.workspaceId,
          input.clientId,
          input.agencyId,
          input.idempotencyKey,
          input.createFingerprint,
          input.actorId,
          now,
        ],
      );
    } catch (error) {
      // The (workspace_id, policy_name) partial unique fence classifies as
      // 'name-taken'; the (workspace_id, idempotency_key) fence is handled
      // by the ON CONFLICT DO NOTHING.
      const candidate = error as { code?: string; constraint?: string };
      if (candidate?.code === '23505') return 'name-taken';
      throw error;
    }
    if (result.rowCount !== 1) return 'fence';
    const created = await tx.query<RoutingPolicyRow>(
      `${ROUTING_POLICY_SELECT} WHERE routing_policy_id = $1`,
      [routingPolicyId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted routing policy ${routingPolicyId} could not be read back`);
    }
    return toRoutingPolicyRecord(row);
  }

  async getRoutingPolicy(routingPolicyId: string): Promise<RoutingPolicyRecord | null> {
    const result = await this.db.query<RoutingPolicyRow>(
      `${ROUTING_POLICY_SELECT} WHERE routing_policy_id = $1`,
      [routingPolicyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRoutingPolicyRecord(row);
  }

  async findRoutingPolicyByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<RoutingPolicyRecord | null> {
    const result = await tx.query<RoutingPolicyRow>(
      `${ROUTING_POLICY_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRoutingPolicyRecord(row);
  }

  async listRoutingPolicies(workspaceId: string): Promise<readonly RoutingPolicyRecord[]> {
    const result = await this.db.query<RoutingPolicyRow>(
      `${ROUTING_POLICY_SELECT} WHERE workspace_id = $1 ORDER BY created_at, routing_policy_id`,
      [workspaceId],
    );
    return result.rows.map(toRoutingPolicyRecord);
  }

  async lockRoutingPolicy(
    tx: DbTransaction,
    routingPolicyId: string,
  ): Promise<RoutingPolicyRecord | null> {
    const result = await tx.query<RoutingPolicyRow>(
      `${ROUTING_POLICY_SELECT} WHERE routing_policy_id = $1 FOR UPDATE`,
      [routingPolicyId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRoutingPolicyRecord(row);
  }

  async updateRoutingPolicyStatus(
    tx: DbTransaction,
    input: {
      readonly routingPolicyId: string;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE ai_routing_policies
       SET status = 'retired', version = version + 1, updated_at = $1
       WHERE routing_policy_id = $2 AND version = $3`,
      [now, input.routingPolicyId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM ai_routing_policies WHERE routing_policy_id = $1',
      [input.routingPolicyId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Selection decisions (append-only) --------------------------------

  async insertSelectionDecision(
    tx: DbTransaction,
    input: {
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly taskProfileId: string;
      readonly routingPolicyId: string | null;
      readonly eligibleSet: readonly EligibilityDecision[];
      readonly ranking: readonly RankingScore[];
      readonly tradeoff: readonly TradeoffScore[];
      readonly chosenModelRegistryId: string;
      readonly cascadeRunId: string | null;
      readonly phaseTrace: readonly RoutingPhase[];
      readonly authoritative: boolean;
      readonly observedLatencyMs: number | null;
      readonly observedCostAmount: number | null;
      readonly evaluationRef: string | null;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<SelectionDecisionRecord | 'fence'> {
    const selectionId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_selection_decisions
         (selection_id, workspace_id, client_id, agency_id, task_profile_id, routing_policy_id,
          eligible_set, ranking, tradeoff, chosen_model_registry_id, cascade_run_id, phase_trace,
          authoritative, observed_latency_ms, observed_cost_amount, evaluation_ref, correlation_id,
          idempotency_key, create_fingerprint, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb,
               $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        selectionId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.taskProfileId,
        input.routingPolicyId,
        JSON.stringify(input.eligibleSet),
        JSON.stringify(input.ranking),
        JSON.stringify(input.tradeoff),
        input.chosenModelRegistryId,
        input.cascadeRunId,
        JSON.stringify(input.phaseTrace),
        input.authoritative,
        input.observedLatencyMs,
        input.observedCostAmount,
        input.evaluationRef,
        input.correlationId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    const created = await tx.query<SelectionDecisionRow>(
      `${SELECTION_DECISION_SELECT} WHERE selection_id = $1`,
      [selectionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted selection decision ${selectionId} could not be read back`);
    }
    return toSelectionDecisionRecord(row);
  }

  async findSelectionDecisionByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<SelectionDecisionRecord | null> {
    const result = await tx.query<SelectionDecisionRow>(
      `${SELECTION_DECISION_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSelectionDecisionRecord(row);
  }

  async getSelectionDecision(selectionId: string): Promise<SelectionDecisionRecord | null> {
    const result = await this.db.query<SelectionDecisionRow>(
      `${SELECTION_DECISION_SELECT} WHERE selection_id = $1`,
      [selectionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toSelectionDecisionRecord(row);
  }

  async listSelectionDecisions(
    workspaceId: string,
    limit: number,
  ): Promise<readonly SelectionDecisionRecord[]> {
    const result = await this.db.query<SelectionDecisionRow>(
      `${SELECTION_DECISION_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, selection_id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return result.rows.map(toSelectionDecisionRecord);
  }

  // ----- Cascade runs (mutable, with CAS) ---------------------------------

  async insertCascadeRun(
    tx: DbTransaction,
    input: {
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly taskProfileId: string;
      readonly routingPolicyId: string | null;
      readonly maxEscalations: number;
      readonly correlationId: string;
      readonly idempotencyKey: string;
      readonly createFingerprint: string;
      readonly actorId: string | null;
    },
  ): Promise<CascadeRunRecord | 'fence'> {
    const cascadeRunId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO ai_cascade_runs
         (cascade_run_id, workspace_id, client_id, agency_id, task_profile_id, routing_policy_id,
          status, final_model_registry_id, escalation_count, max_escalations, correlation_id,
          idempotency_key, create_fingerprint, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'running', NULL, 0, $7, $8, $9, $10, $11, 1, $12, $12)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
      [
        cascadeRunId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.taskProfileId,
        input.routingPolicyId,
        input.maxEscalations,
        input.correlationId,
        input.idempotencyKey,
        input.createFingerprint,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'fence';
    const created = await tx.query<CascadeRunRow>(
      `${CASCADE_RUN_SELECT} WHERE cascade_run_id = $1`,
      [cascadeRunId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted cascade run ${cascadeRunId} could not be read back`);
    }
    return toCascadeRunRecord(row, []);
  }

  async findCascadeRunByIdempotencyKey(
    tx: DbTransaction,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<CascadeRunRecord | null> {
    const result = await tx.query<CascadeRunRow>(
      `${CASCADE_RUN_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const steps = await this.listCascadeSteps(row.cascade_run_id);
    return toCascadeRunRecord(row, steps);
  }

  async getCascadeRun(cascadeRunId: string): Promise<CascadeRunRecord | null> {
    const result = await this.db.query<CascadeRunRow>(
      `${CASCADE_RUN_SELECT} WHERE cascade_run_id = $1`,
      [cascadeRunId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const steps = await this.listCascadeSteps(row.cascade_run_id);
    return toCascadeRunRecord(row, steps);
  }

  async listCascadeRuns(
    workspaceId: string,
    limit: number,
  ): Promise<readonly CascadeRunRecord[]> {
    const result = await this.db.query<CascadeRunRow>(
      `${CASCADE_RUN_SELECT} WHERE workspace_id = $1 ORDER BY created_at DESC, cascade_run_id DESC LIMIT $2`,
      [workspaceId, limit],
    );
    const runs: CascadeRunRecord[] = [];
    for (const row of result.rows) {
      const steps = await this.listCascadeSteps(row.cascade_run_id);
      runs.push(toCascadeRunRecord(row, steps));
    }
    return runs;
  }

  async lockCascadeRun(
    tx: DbTransaction,
    cascadeRunId: string,
  ): Promise<CascadeRunRecord | null> {
    const result = await tx.query<CascadeRunRow>(
      `${CASCADE_RUN_SELECT} WHERE cascade_run_id = $1 FOR UPDATE`,
      [cascadeRunId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const steps = await this.listCascadeSteps(row.cascade_run_id);
    return toCascadeRunRecord(row, steps);
  }

  /**
   * Updates the cascade-run state (status, final model, escalation count)
   * with CAS on the presented version. The content triggers (the
   * scope-chain trigger is the backstop) reject any scope change.
   */
  async updateCascadeRunStatus(
    tx: DbTransaction,
    input: {
      readonly cascadeRunId: string;
      readonly expectedVersion: number;
      readonly status: CascadeRunStatus;
      readonly finalModelRegistryId: string | null;
      readonly escalationCount: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE ai_cascade_runs
       SET status = $1, final_model_registry_id = $2, escalation_count = $3,
           version = version + 1, updated_at = $4
       WHERE cascade_run_id = $5 AND version = $6`,
      [
        input.status,
        input.finalModelRegistryId,
        input.escalationCount,
        now,
        input.cascadeRunId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number }>(
      'SELECT version FROM ai_cascade_runs WHERE cascade_run_id = $1',
      [input.cascadeRunId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // ----- Cascade steps (append-only) --------------------------------------

  async insertCascadeStep(
    tx: DbTransaction,
    input: {
      readonly cascadeRunId: string;
      readonly step: CascadeStepOutcome;
    },
  ): Promise<CascadeStepRecord> {
    const cascadeStepId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO ai_cascade_steps
         (cascade_step_id, cascade_run_id, step_index, model_registry_id, step_type,
          validator_result, validator_reason, observed_latency_ms, observed_cost_amount,
          evaluation_ref, outcome, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        cascadeStepId,
        input.cascadeRunId,
        input.step.stepIndex,
        input.step.modelRegistryId === '' ? null : input.step.modelRegistryId,
        input.step.stepType,
        input.step.validatorResult,
        input.step.validatorReason,
        input.step.observedLatencyMs,
        input.step.observedCostAmount,
        null, // evaluation_ref — placeholder until MKT-019
        input.step.outcome,
        now,
      ],
    );
    const created = await tx.query<CascadeStepRow>(
      `${CASCADE_STEP_SELECT} WHERE cascade_step_id = $1`,
      [cascadeStepId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted cascade step ${cascadeStepId} could not be read back`);
    }
    return toCascadeStepRecord(row);
  }

  async listCascadeSteps(cascadeRunId: string): Promise<readonly CascadeStepRecord[]> {
    const result = await this.db.query<CascadeStepRow>(
      `${CASCADE_STEP_SELECT} WHERE cascade_run_id = $1 ORDER BY step_index, cascade_step_id`,
      [cascadeRunId],
    );
    return result.rows.map(toCascadeStepRecord);
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toRoutingPolicyRecord(row: RoutingPolicyRow): RoutingPolicyRecord {
  return {
    routingPolicyId: row.routing_policy_id,
    policyName: row.policy_name,
    policyContent: row.policy_content,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    status: row.status as RoutingPolicyStatus,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSelectionDecisionRecord(row: SelectionDecisionRow): SelectionDecisionRecord {
  return {
    selectionId: row.selection_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    taskProfileId: row.task_profile_id,
    routingPolicyId: row.routing_policy_id,
    eligibleSet: (row.eligible_set ?? []) as readonly EligibilityDecision[],
    ranking: (row.ranking ?? []) as readonly RankingScore[],
    tradeoff: (row.tradeoff ?? []) as readonly TradeoffScore[],
    chosenModelRegistryId: row.chosen_model_registry_id,
    cascadeRunId: row.cascade_run_id,
    phaseTrace: (row.phase_trace ?? []) as readonly RoutingPhase[],
    authoritative: row.authoritative,
    observedLatencyMs: row.observed_latency_ms === null ? null : Number(row.observed_latency_ms),
    observedCostAmount: row.observed_cost_amount === null ? null : Number(row.observed_cost_amount),
    evaluationRef: row.evaluation_ref,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function toCascadeRunRecord(row: CascadeRunRow, steps: readonly CascadeStepRecord[]): CascadeRunRecord {
  return {
    cascadeRunId: row.cascade_run_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    taskProfileId: row.task_profile_id,
    routingPolicyId: row.routing_policy_id,
    status: row.status as CascadeRunStatus,
    finalModelRegistryId: row.final_model_registry_id,
    escalationCount: Number(row.escalation_count),
    maxEscalations: Number(row.max_escalations),
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    cascadeSteps: steps,
  };
}

function toCascadeStepRecord(row: CascadeStepRow): CascadeStepRecord {
  return {
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
  };
}

// ---------------------------------------------------------------------------
// Module-side scope-id assertion (shared with the registry module)
// ---------------------------------------------------------------------------

export function assertRoutingScopeIds(scope: {
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

// Re-export the fingerprint helpers for the module to use.
export {
  fingerprintRoutingPolicyCreate,
  fingerprintSelectionDecisionAppend,
  fingerprintCascadeRunStart,
  ConflictError,
  IdempotencyConflictError,
  NotFoundError,
};

// Re-export the constants for the module to validate against.
export { CASCADE_RUN_STATUSES, CASCADE_STEP_TYPES, VALIDATOR_RESULTS };

// Re-export the ModelRegistryRecord type so the module's type signature is clean.
export type { ModelRegistryRecord, TaskProfileRecord };
