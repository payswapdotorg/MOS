/**
 * /growth-operator persistence (the migration 050 tables — OWN tables only).
 *
 * DB backstops (migration 050 + implementation-contract §3, §25):
 *   - the controller record's identity/scope/policy/provenance columns are
 *     IMMUTABLE (trigger); the CAS version must advance by EXACTLY one per
 *     mutation (trigger); the blocked-shape fence (blocked ⇒ reason + a
 *     genuine gate kind; unblocked ⇒ both clear) is trigger-enforced;
 *     DELETE is rejected outright; ONE controller per mission (UNIQUE);
 *   - the PLAN STEPS carry the no-double-dispatch fence (UNIQUE
 *     (mission_id, idempotency_key)) and the bounded mutation guard
 *     (identity immutable; the delegation references only ever FILL; the
 *     frozen planned → dispatched | superseded, dispatched → observed
 *     edges; the observation triple fills exactly on observation; DELETE
 *     rejected);
 *   - the DECISION tail and the EVENT tail are APPEND-ONLY (UPDATE and
 *     DELETE rejected outright) with gapless per-mission /
 *     per-controller sequences assigned under the controller row lock;
 *     the frozen transition-pair + current-state-match trigger is the
 *     state-machine backstop.
 *
 * The store issues DML against THESE tables only (proven by the static
 * boundary tests); every cross-module read composes the consumed
 * authorities' public-contract ports.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  GrowthOperatorBudgetPolicy,
  GrowthOperatorControllerRecord,
  GrowthOperatorControllerStatus,
  GrowthOperatorDecisionKind,
  GrowthOperatorDecisionRecord,
  GrowthOperatorEventRecord,
  GrowthOperatorGateKind,
  GrowthOperatorHumanConsideration,
  GrowthOperatorObservedOutcome,
  GrowthOperatorPlanStepRecord,
  GrowthOperatorPlanStepState,
  GrowthOperatorProvenance,
  GrowthOperatorRecordedProvenance,
  GrowthOperatorTerminalCause,
  GrowthOperatorTreatmentFamily,
} from '../public.ts';
import {
  GROWTH_OPERATOR_STRATEGY_VERSION,
  GROWTH_OPERATOR_VOCABULARY_VERSION,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests)
// ---------------------------------------------------------------------------

const REASON_MAX_LENGTH = 2000;
const ACTOR_MAX_LENGTH = 100;

/**
 * The REQUIRED transition/block/terminal reason assertion (the honest
 * record): bounded, non-empty prose — never optional for state
 * transitions.
 */
export function assertValidGrowthOperatorReason(reason: string): void {
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > REASON_MAX_LENGTH
  ) {
    throw new InvalidRequestError('A controller reason is required', [
      `reason: required, non-empty, at most ${REASON_MAX_LENGTH} characters (every controller lifecycle event carries its reason)`,
    ]);
  }
}

/**
 * SERVER-DERIVED provenance validation (the §21-style guard): the actor is
 * a bounded labeled principal, the surface is a bounded label,
 * correlation is present — a provenance block is never caller-invented
 * free-form payload.
 */
export function assertValidGrowthOperatorProvenance(
  provenance: GrowthOperatorProvenance,
): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.actor: a server-derived actor label is required');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > ACTOR_MAX_LENGTH
  ) {
    problems.push('provenance.recordedVia: a server-derived surface label is required');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0) {
    problems.push('provenance.correlationId: required');
  }
  if (
    provenance.causationId !== null &&
    (typeof provenance.causationId !== 'string' || provenance.causationId.length === 0)
  ) {
    problems.push('provenance.causationId: must be null or a non-empty string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid Growth Operator provenance', problems);
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface ControllerRow extends DbRow {
  controller_id: string;
  mission_id: string;
  agency_id: string;
  pursuit_client_id: string;
  pursuit_workspace_id: string;
  pursuit_workflow_id: string | null;
  status: string;
  blocked_reason: string | null;
  blocked_gate_kind: string | null;
  strategy_version: string;
  vocabulary_version: string;
  max_in_flight_steps: number | string;
  max_delegated_steps: number | string | null;
  human_amplification_budget: number | string;
  human_amplification_eligible_capacity: number | string;
  version: number | string;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface PlanStepRow extends DbRow {
  step_id: string;
  controller_id: string;
  mission_id: string;
  step_seq: number | string;
  idempotency_key: string;
  treatment_family: string;
  rationale: string;
  evidence_snapshot_digest: string;
  evidence_refs: unknown;
  considered_human: unknown;
  experiment_id: string | null;
  decision_id: string | null;
  workflow_id: string | null;
  workflow_definition_id: string | null;
  workflow_instance_id: string | null;
  execution_id: string | null;
  observed_outcome: string | null;
  observation_evidence_id: string | null;
  observed_at: Date | null;
  state: string;
  version: number | string;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface DecisionRow extends DbRow {
  decision_id: string;
  controller_id: string;
  mission_id: string;
  decision_seq: number | string;
  decision_kind: string;
  treatment_family: string | null;
  rationale: string;
  evidence_refs: unknown;
  detail: unknown;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  controller_id: string;
  mission_id: string;
  event_seq: number | string;
  from_status: string | null;
  to_status: string;
  terminal_cause: string | null;
  blocked_gate_kind: string | null;
  reason: string;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const CONTROLLER_SELECT = `
  SELECT controller_id, mission_id, agency_id, pursuit_client_id, pursuit_workspace_id,
         pursuit_workflow_id, status, blocked_reason, blocked_gate_kind, strategy_version,
         vocabulary_version, max_in_flight_steps, max_delegated_steps,
         human_amplification_budget, human_amplification_eligible_capacity, version,
         created_actor, created_at, updated_at
  FROM growth_operator_controllers
`;

const PLAN_STEP_SELECT = `
  SELECT step_id, controller_id, mission_id, step_seq, idempotency_key, treatment_family,
         rationale, evidence_snapshot_digest, evidence_refs, considered_human,
         experiment_id, decision_id, workflow_id, workflow_definition_id, workflow_instance_id,
         execution_id, observed_outcome, observation_evidence_id, observed_at, state,
         version, created_actor, created_at, updated_at
  FROM growth_operator_plan_steps
`;

const DECISION_SELECT = `
  SELECT decision_id, controller_id, mission_id, decision_seq, decision_kind, treatment_family,
         rationale, evidence_refs, detail, actor, recorded_via, correlation_id, causation_id,
         recorded_at
  FROM growth_operator_decisions
`;

const EVENT_SELECT = `
  SELECT event_id, controller_id, mission_id, event_seq, from_status, to_status,
         terminal_cause, blocked_gate_kind, reason, actor, recorded_via, correlation_id,
         causation_id, recorded_at
  FROM growth_operator_events
`;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function toControllerRecord(row: ControllerRow): GrowthOperatorControllerRecord {
  return {
    controllerId: row.controller_id,
    missionId: row.mission_id,
    agencyId: row.agency_id,
    pursuitClientId: row.pursuit_client_id,
    pursuitWorkspaceId: row.pursuit_workspace_id,
    pursuitWorkflowId: row.pursuit_workflow_id,
    status: row.status as GrowthOperatorControllerStatus,
    blockedReason: row.blocked_reason,
    blockedGateKind: row.blocked_gate_kind as GrowthOperatorGateKind | null,
    strategyVersion: row.strategy_version,
    vocabularyVersion: row.vocabulary_version,
    budget: {
      maxInFlightSteps: Number(row.max_in_flight_steps),
      maxDelegatedSteps: row.max_delegated_steps === null ? null : Number(row.max_delegated_steps),
      humanAmplificationBudget: Number(row.human_amplification_budget),
      humanAmplificationEligibleCapacity: Number(row.human_amplification_eligible_capacity),
    },
    version: Number(row.version),
    createdActor: row.created_actor,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toPlanStepRecord(row: PlanStepRow): GrowthOperatorPlanStepRecord {
  return {
    stepId: row.step_id,
    controllerId: row.controller_id,
    missionId: row.mission_id,
    stepSeq: Number(row.step_seq),
    idempotencyKey: row.idempotency_key,
    treatmentFamily: row.treatment_family as GrowthOperatorTreatmentFamily,
    rationale: row.rationale,
    evidenceSnapshotDigest: row.evidence_snapshot_digest,
    evidenceRefs: Array.isArray(row.evidence_refs) ? (row.evidence_refs as string[]) : [],
    consideredHuman: (row.considered_human ?? {}) as GrowthOperatorHumanConsideration,
    experimentId: row.experiment_id,
    decisionId: row.decision_id,
    workflowId: row.workflow_id,
    workflowDefinitionId: row.workflow_definition_id,
    workflowInstanceId: row.workflow_instance_id,
    executionId: row.execution_id,
    observedOutcome: row.observed_outcome as GrowthOperatorObservedOutcome | null,
    observationEvidenceId: row.observation_evidence_id,
    observedAt: row.observed_at === null ? null : row.observed_at.toISOString(),
    state: row.state as GrowthOperatorPlanStepState,
    version: Number(row.version),
    createdActor: row.created_actor,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toDecisionRecord(row: DecisionRow): GrowthOperatorDecisionRecord {
  const provenance: GrowthOperatorRecordedProvenance = {
    actor: row.actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
  return {
    decisionId: row.decision_id,
    controllerId: row.controller_id,
    missionId: row.mission_id,
    decisionSeq: Number(row.decision_seq),
    decisionKind: row.decision_kind as GrowthOperatorDecisionKind,
    treatmentFamily: row.treatment_family as GrowthOperatorTreatmentFamily | null,
    rationale: row.rationale,
    evidenceRefs: Array.isArray(row.evidence_refs) ? (row.evidence_refs as string[]) : [],
    detail: (row.detail ?? {}) as Record<string, unknown>,
    provenance,
  };
}

function toEventRecord(row: EventRow): GrowthOperatorEventRecord {
  const provenance: GrowthOperatorRecordedProvenance = {
    actor: row.actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
  return {
    eventId: row.event_id,
    controllerId: row.controller_id,
    missionId: row.mission_id,
    eventSeq: Number(row.event_seq),
    fromStatus: row.from_status as GrowthOperatorControllerStatus | null,
    toStatus: row.to_status as GrowthOperatorControllerStatus,
    terminalCause: row.terminal_cause as GrowthOperatorTerminalCause | null,
    blockedGateKind: row.blocked_gate_kind as GrowthOperatorGateKind | null,
    reason: row.reason,
    provenance,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface AppendDecisionInput {
  readonly controllerId: string;
  readonly missionId: string;
  readonly decisionKind: GrowthOperatorDecisionKind;
  readonly treatmentFamily: GrowthOperatorTreatmentFamily | null;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  readonly detail: Readonly<Record<string, unknown>>;
  readonly provenance: GrowthOperatorProvenance;
}

export interface AppendEventInput {
  readonly controllerId: string;
  readonly missionId: string;
  readonly fromStatus: GrowthOperatorControllerStatus | null;
  readonly toStatus: GrowthOperatorControllerStatus;
  readonly terminalCause: GrowthOperatorTerminalCause | null;
  readonly blockedGateKind: GrowthOperatorGateKind | null;
  readonly reason: string;
  readonly provenance: GrowthOperatorProvenance;
}

export class GrowthOperatorStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // --- the controller record ---

  async insertController(input: {
    readonly controllerId: string;
    readonly missionId: string;
    readonly agencyId: string;
    readonly pursuitClientId: string;
    readonly pursuitWorkspaceId: string;
    readonly budget: GrowthOperatorBudgetPolicy;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO growth_operator_controllers (controller_id, mission_id, agency_id,
                                                  pursuit_client_id, pursuit_workspace_id,
                                                  status, strategy_version, vocabulary_version,
                                                  max_in_flight_steps, max_delegated_steps,
                                                  human_amplification_budget,
                                                  human_amplification_eligible_capacity,
                                                  version, created_actor, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, $8, $9, $10, $11, 1, $12, $13, $13)`,
      [
        input.controllerId,
        input.missionId,
        input.agencyId,
        input.pursuitClientId,
        input.pursuitWorkspaceId,
        GROWTH_OPERATOR_STRATEGY_VERSION,
        GROWTH_OPERATOR_VOCABULARY_VERSION,
        input.budget.maxInFlightSteps,
        input.budget.maxDelegatedSteps,
        input.budget.humanAmplificationBudget,
        input.budget.humanAmplificationEligibleCapacity,
        input.createdActor,
        input.now,
      ],
    );
  }

  async getController(missionId: string): Promise<GrowthOperatorControllerRecord | null> {
    const result = await this.db.query<ControllerRow>(
      `${CONTROLLER_SELECT} WHERE mission_id = $1`,
      [missionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toControllerRecord(row);
  }

  async getControllerById(
    tx: DbTransaction,
    controllerId: string,
  ): Promise<GrowthOperatorControllerRecord | null> {
    const result = await tx.query<ControllerRow>(
      `${CONTROLLER_SELECT} WHERE controller_id = $1`,
      [controllerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toControllerRecord(row);
  }

  /** Locks the controller row (FOR UPDATE) — every mutation is CAS-serialized. */
  async lockController(
    tx: DbTransaction,
    missionId: string,
  ): Promise<GrowthOperatorControllerRecord | null> {
    const result = await tx.query<ControllerRow>(
      `${CONTROLLER_SELECT} WHERE mission_id = $1 FOR UPDATE`,
      [missionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toControllerRecord(row);
  }

  /**
   * CAS state mutation on the CALLER'S transaction (the row was locked
   * there): status + the blocked-shape fills + version bump. The frozen
   * transition pair was already module-checked; the DB pair trigger is the
   * final backstop.
   */
  async updateControllerStatusRow(
    tx: DbTransaction,
    input: {
      readonly controllerId: string;
      readonly status: GrowthOperatorControllerStatus;
      readonly blockedReason: string | null;
      readonly blockedGateKind: GrowthOperatorGateKind | null;
      readonly expectedVersion: number;
    },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE growth_operator_controllers
       SET status = $1, blocked_reason = $2, blocked_gate_kind = $3, version = version + 1,
           updated_at = $4
       WHERE controller_id = $5 AND version = $6`,
      [
        input.status,
        input.blockedReason,
        input.blockedGateKind,
        now,
        input.controllerId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyControllerUpdateMiss(tx, input.controllerId);
  }

  /**
   * Fills the pursuit workflow reference (once — the fill-only fence; the
   * DB trigger backstops the never-change rule). A CAS mutation: the
   * controller version advances by exactly one.
   */
  async fillPursuitWorkflow(
    tx: DbTransaction,
    input: { readonly controllerId: string; readonly workflowId: string },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE growth_operator_controllers
       SET pursuit_workflow_id = $1, version = version + 1, updated_at = $2
       WHERE controller_id = $3 AND pursuit_workflow_id IS NULL`,
      [input.workflowId, now, input.controllerId],
    );
  }

  // --- the plan steps ---

  async insertPlanStep(tx: DbTransaction, input: {
    readonly stepId: string;
    readonly controllerId: string;
    readonly missionId: string;
    readonly stepSeq: number;
    readonly idempotencyKey: string;
    readonly treatmentFamily: GrowthOperatorTreatmentFamily;
    readonly rationale: string;
    readonly evidenceSnapshotDigest: string;
    readonly evidenceRefs: readonly string[];
    readonly consideredHuman: GrowthOperatorHumanConsideration;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await tx.query(
      `INSERT INTO growth_operator_plan_steps (step_id, controller_id, mission_id, step_seq,
                                                idempotency_key, treatment_family, rationale,
                                                evidence_snapshot_digest, evidence_refs,
                                                considered_human, state, version, created_actor,
                                                created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'planned', 1, $11, $12, $12)`,
      [
        input.stepId,
        input.controllerId,
        input.missionId,
        input.stepSeq,
        input.idempotencyKey,
        input.treatmentFamily,
        input.rationale,
        input.evidenceSnapshotDigest,
        JSON.stringify(input.evidenceRefs),
        JSON.stringify(input.consideredHuman),
        input.createdActor,
        input.now,
      ],
    );
  }

  async findPlanStepByIdempotencyKey(
    tx: DbTransaction,
    missionId: string,
    idempotencyKey: string,
  ): Promise<GrowthOperatorPlanStepRecord | null> {
    const result = await tx.query<PlanStepRow>(
      `${PLAN_STEP_SELECT} WHERE mission_id = $1 AND idempotency_key = $2`,
      [missionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toPlanStepRecord(row);
  }

  async listPlanSteps(missionId: string): Promise<readonly GrowthOperatorPlanStepRecord[]> {
    const result = await this.db.query<PlanStepRow>(
      `${PLAN_STEP_SELECT} WHERE mission_id = $1 ORDER BY step_seq`,
      [missionId],
    );
    return result.rows.map(toPlanStepRecord);
  }

  async listPlanStepsForController(
    controllerId: string,
  ): Promise<readonly GrowthOperatorPlanStepRecord[]> {
    const result = await this.db.query<PlanStepRow>(
      `${PLAN_STEP_SELECT} WHERE controller_id = $1 ORDER BY step_seq`,
      [controllerId],
    );
    return result.rows.map(toPlanStepRecord);
  }

  async countPlanSteps(tx: DbTransaction, controllerId: string): Promise<number> {
    const result = await tx.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM growth_operator_plan_steps WHERE controller_id = $1',
      [controllerId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * The bounded delegation-reference fill (only ever null → value). A CAS
   * mutation: the step version advances by exactly one per fill.
   */
  async fillPlanStepDelegationRefs(
    tx: DbTransaction,
    input: {
      readonly stepId: string;
      readonly experimentId?: string | null;
      readonly decisionId?: string | null;
      readonly workflowId?: string | null;
      readonly workflowDefinitionId?: string | null;
      readonly workflowInstanceId?: string | null;
      readonly executionId?: string | null;
    },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE growth_operator_plan_steps
       SET experiment_id = COALESCE($1, experiment_id),
           decision_id = COALESCE($2, decision_id),
           workflow_id = COALESCE($3, workflow_id),
           workflow_definition_id = COALESCE($4, workflow_definition_id),
           workflow_instance_id = COALESCE($5, workflow_instance_id),
           execution_id = COALESCE($6, execution_id),
           version = version + 1,
           updated_at = $7
       WHERE step_id = $8`,
      [
        input.experimentId ?? null,
        input.decisionId ?? null,
        input.workflowId ?? null,
        input.workflowDefinitionId ?? null,
        input.workflowInstanceId ?? null,
        input.executionId ?? null,
        now,
        input.stepId,
      ],
    );
  }

  /** The planned → dispatched transition (CAS; the DB guard is the backstop). */
  async markPlanStepDispatched(tx: DbTransaction, input: {
    readonly stepId: string;
    readonly expectedVersion: number;
  }): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE growth_operator_plan_steps
       SET state = 'dispatched', version = version + 1, updated_at = $1
       WHERE step_id = $2 AND version = $3 AND state = 'planned'`,
      [now, input.stepId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number | string; state: string }>(
      'SELECT version, state FROM growth_operator_plan_steps WHERE step_id = $1',
      [input.stepId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  /** The planned → superseded transition (the recorded deliberate replacement). */
  async markPlanStepSuperseded(tx: DbTransaction, stepId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE growth_operator_plan_steps
       SET state = 'superseded', version = version + 1, updated_at = $1
       WHERE step_id = $2 AND state = 'planned'`,
      [now, stepId],
    );
  }

  /** The dispatched → observed transition with the observation triple (CAS). */
  async markPlanStepObserved(tx: DbTransaction, input: {
    readonly stepId: string;
    readonly observedOutcome: GrowthOperatorObservedOutcome;
    readonly observationEvidenceId: string | null;
    readonly observedAt: string;
    readonly expectedVersion: number;
  }): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const result = await tx.query(
      `UPDATE growth_operator_plan_steps
       SET state = 'observed', observed_outcome = $1, observation_evidence_id = $2,
           observed_at = $3, version = version + 1, updated_at = $3
       WHERE step_id = $4 AND version = $5 AND state = 'dispatched'`,
      [
        input.observedOutcome,
        input.observationEvidenceId,
        input.observedAt,
        input.stepId,
        input.expectedVersion,
      ],
    );
    if (result.rowCount === 1) return 'ok';
    const existing = await tx.query<{ version: number | string; state: string }>(
      'SELECT version, state FROM growth_operator_plan_steps WHERE step_id = $1',
      [input.stepId],
    );
    if (existing.rows.length === 0) return 'not-found';
    return 'version-conflict';
  }

  // --- the append-only decision tail ---

  /**
   * Appends one decision record on the CALLER'S transaction. The decision
   * sequence is the gapless per-mission tail position, assigned under the
   * controller row lock the caller already holds.
   */
  async appendDecision(
    tx: DbTransaction,
    input: AppendDecisionInput,
  ): Promise<GrowthOperatorDecisionRecord> {
    const decisionId = this.ids.newId();
    const now = this.clock.nowIso();
    const nextSeq = await this.nextDecisionSeq(tx, input.missionId);
    await tx.query(
      `INSERT INTO growth_operator_decisions (decision_id, controller_id, mission_id,
                                                decision_seq, decision_kind, treatment_family,
                                                rationale, evidence_refs, detail, actor,
                                                recorded_via, correlation_id, causation_id,
                                                recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)`,
      [
        decisionId,
        input.controllerId,
        input.missionId,
        nextSeq,
        input.decisionKind,
        input.treatmentFamily,
        input.rationale,
        JSON.stringify(input.evidenceRefs),
        JSON.stringify(input.detail),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    return {
      decisionId,
      controllerId: input.controllerId,
      missionId: input.missionId,
      decisionSeq: nextSeq,
      decisionKind: input.decisionKind,
      treatmentFamily: input.treatmentFamily,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs,
      detail: input.detail,
      provenance: { ...input.provenance, recordedAt: now },
    };
  }

  async listDecisions(missionId: string): Promise<readonly GrowthOperatorDecisionRecord[]> {
    const result = await this.db.query<DecisionRow>(
      `${DECISION_SELECT} WHERE mission_id = $1 ORDER BY decision_seq`,
      [missionId],
    );
    return result.rows.map(toDecisionRecord);
  }

  private async nextDecisionSeq(tx: DbTransaction, missionId: string): Promise<number> {
    const result = await tx.query<{ max_seq: number | string | null }>(
      'SELECT max(decision_seq) AS max_seq FROM growth_operator_decisions WHERE mission_id = $1',
      [missionId],
    );
    const current = result.rows[0]?.max_seq;
    return current === null || current === undefined ? 1 : Number(current) + 1;
  }

  // --- the append-only event tail ---

  /**
   * Appends one state-transition event on the CALLER'S transaction (the
   * gapless per-controller sequence assigned under the controller row lock
   * the caller already holds). The DB pair + current-state trigger is the
   * final backstop of the frozen controller machine.
   */
  async appendEvent(tx: DbTransaction, input: AppendEventInput): Promise<GrowthOperatorEventRecord> {
    const eventId = this.ids.newId();
    const now = this.clock.nowIso();
    const nextSeq = await this.nextEventSeq(tx, input.controllerId);
    await tx.query(
      `INSERT INTO growth_operator_events (event_id, controller_id, mission_id, event_seq,
                                             from_status, to_status, terminal_cause,
                                             blocked_gate_kind, reason, actor, recorded_via,
                                             correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        eventId,
        input.controllerId,
        input.missionId,
        nextSeq,
        input.fromStatus,
        input.toStatus,
        input.terminalCause,
        input.blockedGateKind,
        input.reason,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    return {
      eventId,
      controllerId: input.controllerId,
      missionId: input.missionId,
      eventSeq: nextSeq,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      terminalCause: input.terminalCause,
      blockedGateKind: input.blockedGateKind,
      reason: input.reason,
      provenance: { ...input.provenance, recordedAt: now },
    };
  }

  async listEvents(controllerId: string): Promise<readonly GrowthOperatorEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE controller_id = $1 ORDER BY event_seq`,
      [controllerId],
    );
    return result.rows.map(toEventRecord);
  }

  private async nextEventSeq(tx: DbTransaction, controllerId: string): Promise<number> {
    const result = await tx.query<{ max_seq: number | string | null }>(
      'SELECT max(event_seq) AS max_seq FROM growth_operator_events WHERE controller_id = $1',
      [controllerId],
    );
    const current = result.rows[0]?.max_seq;
    return current === null || current === undefined ? 1 : Number(current) + 1;
  }
}

async function classifyControllerUpdateMiss(
  tx: DbTransaction,
  controllerId: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    'SELECT version FROM growth_operator_controllers WHERE controller_id = $1',
    [controllerId],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}
