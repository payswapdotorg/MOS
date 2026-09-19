/**
 * /growth-missions persistence (the migration 045 tables — OWN tables only).
 *
 * DB backstops (migration 045 + implementation-contract §3, §25):
 *   - the mission record's identity/scope/provenance columns are IMMUTABLE
 *     (trigger); the CAS version must advance by EXACTLY one per mutation
 *     (trigger); the version-tail pointer only ever ADVANCES and must
 *     reference an EXISTING declared version of the same mission (trigger);
 *     DELETE is rejected outright;
 *   - the VERSION tail + the per-version TARGET METRICS are append-only
 *     (UPDATE and DELETE rejected outright — the declared objective is
 *     immutable; corrections are NEW version records);
 *   - the HISTORY tail is append-only (UPDATE and DELETE rejected) with the
 *     gapless per-mission sequence, the kind-shape CHECKs and the frozen
 *     transition-pair trigger (a block is never silently converted into
 *     success — terminal states have no outgoing pairs);
 *   - the GOAL MAPPING rows are scope-fenced (the mapped goal's Client must
 *     belong to the mission's Agency — trigger), terminal-frozen (mapping
 *     changes on a terminal mission are rejected — trigger), removal-only
 *     mutable (UPDATE may only add the removal triple; DELETE rejected) and
 *     active-unique ((mission, goal) WHERE removed_at IS NULL).
 *
 * The store issues DML against THESE tables only (proven by the static
 * boundary tests); every cross-module read composes the /goals and
 * /agencies public-contract ports.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  GrowthMissionDeclaration,
  GrowthMissionEventDetail,
  GrowthMissionEventKind,
  GrowthMissionEventRecord,
  GrowthMissionGoalMappingRecord,
  GrowthMissionObjectiveFamily,
  GrowthMissionProvenance,
  GrowthMissionRecord,
  GrowthMissionStatus,
  GrowthMissionTargetMetric,
  GrowthMissionVersionRecord,
} from '../public.ts';
import {
  GROWTH_MISSION_METRIC_COMPARATORS,
  GROWTH_MISSION_OBJECTIVE_FAMILIES,
} from '../public.ts';

interface MissionRow extends DbRow {
  mission_id: string;
  agency_id: string;
  status: string;
  current_version_seq: number | string;
  version: number | string;
  created_actor: string;
  created_at: Date;
  updated_at: Date;
}

interface VersionRow extends DbRow {
  mission_version_id: string;
  mission_id: string;
  version_seq: number | string;
  objective: string;
  objective_family: string;
  product_context: unknown;
  market_context: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface MetricRow extends DbRow {
  mission_version_id: string;
  metric: string;
  comparator: string;
  target_value: string | number;
  unit: string | null;
  description: string | null;
  intermediate: boolean;
}

interface EventRow extends DbRow {
  event_id: string;
  mission_id: string;
  event_seq: number | string;
  event_kind: string;
  from_status: string | null;
  to_status: string | null;
  terminal_decision_family: string | null;
  reason: string | null;
  detail: unknown;
  actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface MappingRow extends DbRow {
  mapping_id: string;
  mission_id: string;
  goal_id: string;
  added_at: Date;
  added_by: string;
  removed_at: Date | null;
  removed_by: string | null;
  removal_reason: string | null;
}

const MISSION_SELECT = `
  SELECT mission_id, agency_id, status, current_version_seq, version,
         created_actor, created_at, updated_at
  FROM growth_missions
`;

const VERSION_SELECT = `
  SELECT v.mission_version_id, v.mission_id, v.version_seq, v.objective, v.objective_family,
         v.product_context, v.market_context, v.recorded_actor, v.recorded_via,
         v.correlation_id, v.causation_id, v.created_at
  FROM growth_mission_versions v
`;

const EVENT_SELECT = `
  SELECT event_id, mission_id, event_seq, event_kind, from_status, to_status,
         terminal_decision_family, reason, detail, actor, recorded_via,
         correlation_id, causation_id, recorded_at
  FROM growth_mission_events
`;

const MAPPING_SELECT = `
  SELECT mapping_id, mission_id, goal_id, added_at, added_by, removed_at, removed_by, removal_reason
  FROM growth_mission_goal_mappings
`;

// ---------------------------------------------------------------------------
// Input guards (pure — exported for unit tests and the MKT-054 controller)
// ---------------------------------------------------------------------------

const OBJECTIVE_MAX_LENGTH = 5000;
const REASON_MAX_LENGTH = 2000;
const METRIC_NAME_MAX_LENGTH = 100;
const METRIC_UNIT_MAX_LENGTH = 50;
const METRIC_DESCRIPTION_MAX_LENGTH = 500;
const CONTEXT_FIELD_MAX_LENGTH = 500;
const ACTOR_MAX_LENGTH = 100;

/**
 * Defensive declaration assertion at the authority boundary: the module
 * never persists a declared objective that is not structurally honest — a
 * non-empty VERBATIM objective, a frozen §3 family, bounded contexts and
 * structurally measurable target metrics (each binding a named metric to a
 * numeric target through an explicit comparator, with the intermediate
 * flag explicit).
 */
export function assertValidGrowthMissionDeclaration(
  declaration: GrowthMissionDeclaration,
): void {
  const problems: string[] = [];
  if (
    typeof declaration.objective !== 'string' ||
    declaration.objective.trim().length === 0 ||
    declaration.objective.length > OBJECTIVE_MAX_LENGTH
  ) {
    problems.push(
      `objective: required, non-empty, at most ${OBJECTIVE_MAX_LENGTH} characters (the declared business outcome, verbatim)`,
    );
  }
  if (
    typeof declaration.objectiveFamily !== 'string' ||
    !(GROWTH_MISSION_OBJECTIVE_FAMILIES as readonly string[]).includes(declaration.objectiveFamily)
  ) {
    problems.push(
      `objectiveFamily: must be one of ${GROWTH_MISSION_OBJECTIVE_FAMILIES.join(', ')} (the frozen architecture-v1.6.md §3 vocabulary)`,
    );
  }
  problems.push(...productContextProblems(declaration.productContext, 'productContext'));
  problems.push(...marketContextProblems(declaration.marketContext, 'marketContext'));
  if (!Array.isArray(declaration.targetMetrics)) {
    problems.push('targetMetrics: must be an array (may be empty)');
  } else {
    const names = new Set<string>();
    declaration.targetMetrics.forEach((metric, index) => {
      const prefix = `targetMetrics[${index}]`;
      if (
        typeof metric.metric !== 'string' ||
        metric.metric.trim().length === 0 ||
        metric.metric.length > METRIC_NAME_MAX_LENGTH
      ) {
        problems.push(`${prefix}.metric: a named metric is required (at most ${METRIC_NAME_MAX_LENGTH} characters)`);
        return;
      }
      if (names.has(metric.metric)) {
        problems.push(`${prefix}.metric: '${metric.metric}' is declared more than once`);
      }
      names.add(metric.metric);
      if (
        typeof metric.comparator !== 'string' ||
        !(GROWTH_MISSION_METRIC_COMPARATORS as readonly string[]).includes(metric.comparator)
      ) {
        problems.push(`${prefix}.comparator: must be one of ${GROWTH_MISSION_METRIC_COMPARATORS.join(', ')}`);
      }
      if (typeof metric.targetValue !== 'number' || !Number.isFinite(metric.targetValue)) {
        problems.push(`${prefix}.targetValue: a finite numeric target is required`);
      }
      if (
        metric.unit !== null &&
        (typeof metric.unit !== 'string' || metric.unit.length > METRIC_UNIT_MAX_LENGTH)
      ) {
        problems.push(`${prefix}.unit: at most ${METRIC_UNIT_MAX_LENGTH} characters`);
      }
      if (
        metric.description !== null &&
        (typeof metric.description !== 'string' || metric.description.length > METRIC_DESCRIPTION_MAX_LENGTH)
      ) {
        problems.push(`${prefix}.description: at most ${METRIC_DESCRIPTION_MAX_LENGTH} characters`);
      }
      if (typeof metric.intermediate !== 'boolean') {
        problems.push(`${prefix}.intermediate: the intermediate flag must be explicit (boolean)`);
      }
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('Invalid Growth Mission declaration', problems);
  }
}

function productContextProblems(
  context: GrowthMissionDeclaration['productContext'],
  field: string,
): string[] {
  if (context === null) return [];
  const problems: string[] = [];
  if (typeof context !== 'object' || Array.isArray(context)) {
    return [`${field}: must be an object or null`];
  }
  for (const key of ['name', 'url', 'summary'] as const) {
    const value = context[key];
    if (value !== null && (typeof value !== 'string' || value.length > CONTEXT_FIELD_MAX_LENGTH)) {
      problems.push(`${field}.${key}: at most ${CONTEXT_FIELD_MAX_LENGTH} characters`);
    }
  }
  return problems;
}

function marketContextProblems(
  context: GrowthMissionDeclaration['marketContext'],
  field: string,
): string[] {
  if (context === null) return [];
  const problems: string[] = [];
  if (typeof context !== 'object' || Array.isArray(context)) {
    return [`${field}: must be an object or null`];
  }
  for (const key of ['audience', 'geography', 'summary'] as const) {
    const value = context[key];
    if (value !== null && (typeof value !== 'string' || value.length > CONTEXT_FIELD_MAX_LENGTH)) {
      problems.push(`${field}.${key}: at most ${CONTEXT_FIELD_MAX_LENGTH} characters`);
    }
  }
  return problems;
}

/**
 * The REQUIRED transition/removal reason assertion (the honest record):
 * bounded, non-empty prose — never optional for state transitions.
 */
export function assertValidGrowthMissionReason(reason: string): void {
  if (
    typeof reason !== 'string' ||
    reason.trim().length === 0 ||
    reason.length > REASON_MAX_LENGTH
  ) {
    throw new InvalidRequestError('A transition reason is required', [
      `reason: required, non-empty, at most ${REASON_MAX_LENGTH} characters (every mission lifecycle event carries its reason)`,
    ]);
  }
}

/**
 * SERVER-DERIVED provenance validation (the §21-style guard): the actor is a
 * bounded labeled principal, the surface is a bounded label, correlation is
 * present — a provenance block is never caller-invented free-form payload.
 */
export function assertValidGrowthMissionProvenance(
  provenance: GrowthMissionProvenance,
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
    throw new InvalidRequestError('Invalid Growth Mission provenance', problems);
  }
}

/**
 * Pure composition of the canonical mission owner context from the mission
 * row and the ALREADY-RESOLVED /agencies row (the composeGoalOwnerContext
 * precedent). Purity is asserted by unit tests.
 */
export function composeGrowthMissionOwnerContext(
  mission: GrowthMissionRecord,
  agency: { readonly agencyId: string; readonly status: string },
  resolvedAt: string,
): {
  readonly scope: {
    readonly kind: 'growth-mission';
    readonly agencyId: string;
    readonly missionId: string;
  };
  readonly mission: GrowthMissionRecord;
  readonly agency: { readonly agencyId: string; readonly status: string };
  readonly resolvedAt: string;
} {
  return {
    scope: {
      kind: 'growth-mission',
      agencyId: mission.agencyId,
      missionId: mission.missionId,
    },
    mission,
    agency,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface AppendVersionInput {
  readonly missionId: string;
  readonly versionSeq: number;
  readonly declaration: GrowthMissionDeclaration;
  readonly provenance: GrowthMissionProvenance;
}

export interface AppendEventInput {
  readonly missionId: string;
  readonly eventKind: GrowthMissionEventKind;
  readonly fromStatus: GrowthMissionStatus | null;
  readonly toStatus: GrowthMissionStatus | null;
  readonly terminalDecisionFamily: GrowthMissionObjectiveFamily | null;
  readonly reason: string | null;
  readonly detail: GrowthMissionEventDetail;
  readonly provenance: GrowthMissionProvenance;
}

export class GrowthMissionsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // --- mission record ---

  async insertMission(input: {
    readonly missionId: string;
    readonly agencyId: string;
    readonly createdActor: string;
    readonly now: string;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO growth_missions (mission_id, agency_id, status, current_version_seq, version,
                                    created_actor, created_at, updated_at)
       VALUES ($1, $2, 'draft', 1, 1, $3, $4, $4)`,
      [input.missionId, input.agencyId, input.createdActor, input.now],
    );
  }

  async getMission(missionId: string): Promise<GrowthMissionRecord | null> {
    const result = await this.db.query<MissionRow>(`${MISSION_SELECT} WHERE mission_id = $1`, [
      missionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toMissionRecord(row);
  }

  async listMissionsForAgency(agencyId: string): Promise<readonly GrowthMissionRecord[]> {
    const result = await this.db.query<MissionRow>(
      `${MISSION_SELECT} WHERE agency_id = $1 ORDER BY created_at, mission_id`,
      [agencyId],
    );
    return result.rows.map(toMissionRecord);
  }

  /** Locks the mission row (FOR UPDATE) — every mutation is CAS-serialized. */
  async lockMission(tx: DbTransaction, missionId: string): Promise<GrowthMissionRecord | null> {
    const result = await tx.query<MissionRow>(`${MISSION_SELECT} WHERE mission_id = $1 FOR UPDATE`, [
      missionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toMissionRecord(row);
  }

  /**
   * CAS state mutation on the CALLER'S transaction (the row was locked
   * there): state + version bump. The frozen transition pair was already
   * module-checked; the DB pair trigger is the final backstop.
   */
  async updateMissionStatusRow(
    tx: DbTransaction,
    input: { missionId: string; status: GrowthMissionStatus; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE growth_missions SET status = $1, version = version + 1, updated_at = $2
       WHERE mission_id = $3 AND version = $4`,
      [input.status, now, input.missionId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.missionId);
  }

  /**
   * CAS version-pointer advance on the CALLER'S transaction: the new
   * version row was appended first; the mission record now points at it
   * (the pointer only ever ADVANCES — the DB trigger is the backstop).
   */
  async advanceMissionVersionRow(
    tx: DbTransaction,
    input: { missionId: string; versionSeq: number; expectedVersion: number },
  ): Promise<'ok' | 'not-found' | 'version-conflict'> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE growth_missions SET current_version_seq = $1, version = version + 1, updated_at = $2
       WHERE mission_id = $3 AND version = $4`,
      [input.versionSeq, now, input.missionId, input.expectedVersion],
    );
    if (result.rowCount === 1) return 'ok';
    return await classifyUpdateMiss(tx, input.missionId);
  }

  // --- the append-only version tail ---

  async appendVersion(tx: DbTransaction, input: AppendVersionInput): Promise<string> {
    const missionVersionId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO growth_mission_versions (mission_version_id, mission_id, version_seq, objective,
                                              objective_family, product_context, market_context,
                                              recorded_actor, recorded_via, correlation_id,
                                              causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)`,
      [
        missionVersionId,
        input.missionId,
        input.versionSeq,
        input.declaration.objective,
        input.declaration.objectiveFamily,
        input.declaration.productContext === null
          ? null
          : JSON.stringify(input.declaration.productContext),
        input.declaration.marketContext === null
          ? null
          : JSON.stringify(input.declaration.marketContext),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    for (const metric of input.declaration.targetMetrics) {
      await tx.query(
        `INSERT INTO growth_mission_target_metrics (mission_version_id, metric, comparator,
                                                      target_value, unit, description, intermediate)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          missionVersionId,
          metric.metric,
          metric.comparator,
          metric.targetValue,
          metric.unit,
          metric.description,
          metric.intermediate,
        ],
      );
    }
    return missionVersionId;
  }

  async getVersion(missionId: string, versionSeq: number): Promise<GrowthMissionVersionRecord | null> {
    const versions = await this.listVersions(missionId);
    return versions.find((version) => version.versionSeq === versionSeq) ?? null;
  }

  /**
   * The declared version at an exact sequence, read through the CALLER'S
   * transaction (the mutation paths resolve the terminal-decision family
   * under the row lock).
   */
  async getVersionBySeq(
    tx: DbTransaction,
    missionId: string,
    versionSeq: number,
  ): Promise<GrowthMissionVersionRecord | null> {
    const versions = await tx.query<VersionRow>(
      `${VERSION_SELECT} WHERE v.mission_id = $1 AND v.version_seq = $2`,
      [missionId, versionSeq],
    );
    const row = versions.rows[0];
    if (row === undefined) return null;
    const metrics = await tx.query<MetricRow>(
      `SELECT mission_version_id, metric, comparator, target_value, unit, description, intermediate
       FROM growth_mission_target_metrics
       WHERE mission_version_id = $1
       ORDER BY metric`,
      [row.mission_version_id],
    );
    return toVersionRecord(row, metrics.rows.map(toTargetMetric));
  }

  async listVersions(missionId: string): Promise<readonly GrowthMissionVersionRecord[]> {
    const versions = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE v.mission_id = $1 ORDER BY v.version_seq`,
      [missionId],
    );
    if (versions.rows.length === 0) return [];
    const metrics = await this.db.query<MetricRow>(
      `SELECT m.mission_version_id, m.metric, m.comparator, m.target_value, m.unit, m.description, m.intermediate
       FROM growth_mission_target_metrics m
       JOIN growth_mission_versions v ON v.mission_version_id = m.mission_version_id
       WHERE v.mission_id = $1
       ORDER BY v.version_seq, m.metric`,
      [missionId],
    );
    const metricsByVersion = new Map<string, GrowthMissionTargetMetric[]>();
    for (const row of metrics.rows) {
      const list = metricsByVersion.get(row.mission_version_id) ?? [];
      list.push(toTargetMetric(row));
      metricsByVersion.set(row.mission_version_id, list);
    }
    return versions.rows.map((row) =>
      toVersionRecord(row, metricsByVersion.get(row.mission_version_id) ?? []),
    );
  }

  async countVersions(tx: DbTransaction, missionId: string): Promise<number> {
    const result = await tx.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM growth_mission_versions WHERE mission_id = $1',
      [missionId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  // --- the append-only history tail ---

  /**
   * Appends one history event on the CALLER'S transaction. The event
   * sequence is the gapless per-mission tail position, assigned under the
   * mission row lock the caller already holds.
   */
  async appendEvent(tx: DbTransaction, input: AppendEventInput): Promise<string> {
    const eventId = this.ids.newId();
    const now = this.clock.nowIso();
    const nextSeq = await this.nextEventSeq(tx, input.missionId);
    await tx.query(
      `INSERT INTO growth_mission_events (event_id, mission_id, event_seq, event_kind,
                                            from_status, to_status, terminal_decision_family,
                                            reason, detail, actor, recorded_via, correlation_id,
                                            causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)`,
      [
        eventId,
        input.missionId,
        nextSeq,
        input.eventKind,
        input.fromStatus,
        input.toStatus,
        input.terminalDecisionFamily,
        input.reason,
        input.detail === null ? null : JSON.stringify(input.detail),
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    return eventId;
  }

  private async nextEventSeq(tx: DbTransaction, missionId: string): Promise<number> {
    const result = await tx.query<{ max_seq: number | string | null }>(
      'SELECT max(event_seq) AS max_seq FROM growth_mission_events WHERE mission_id = $1',
      [missionId],
    );
    const current = result.rows[0]?.max_seq;
    return current === null || current === undefined ? 1 : Number(current) + 1;
  }

  async listEvents(missionId: string): Promise<readonly GrowthMissionEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE mission_id = $1 ORDER BY event_seq`,
      [missionId],
    );
    return result.rows.map(toEventRecord);
  }

  // --- the goal mapping ---

  async insertGoalMapping(tx: DbTransaction, input: {
    readonly missionId: string;
    readonly goalId: string;
    readonly addedBy: string;
  }): Promise<string> {
    const mappingId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO growth_mission_goal_mappings (mapping_id, mission_id, goal_id, added_at, added_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [mappingId, input.missionId, input.goalId, now, input.addedBy],
    );
    return mappingId;
  }

  /**
   * The honest removal (the 038 single-supersession precedent): the row
   * keeps its history and gains the removal triple. Never a DELETE.
   */
  async markGoalMappingRemoved(tx: DbTransaction, input: {
    readonly mappingId: string;
    readonly removedBy: string;
    readonly reason: string;
  }): Promise<void> {
    const now = this.clock.nowIso();
    const result = await tx.query(
      `UPDATE growth_mission_goal_mappings
       SET removed_at = $1, removed_by = $2, removal_reason = $3
       WHERE mapping_id = $4 AND removed_at IS NULL`,
      [now, input.removedBy, input.reason, input.mappingId],
    );
    if (result.rowCount !== 1) {
      throw new Error(`mapping ${input.mappingId} could not be marked removed`);
    }
  }

  async listGoalMappings(missionId: string): Promise<readonly GrowthMissionGoalMappingRecord[]> {
    const result = await this.db.query<MappingRow>(
      `${MAPPING_SELECT} WHERE mission_id = $1 ORDER BY added_at, mapping_id`,
      [missionId],
    );
    return result.rows.map(toMappingRecord);
  }

  /** The ACTIVE mapping of a goal (null when none or already removed). */
  async findActiveGoalMapping(
    tx: DbTransaction,
    missionId: string,
    goalId: string,
  ): Promise<GrowthMissionGoalMappingRecord | null> {
    const result = await tx.query<MappingRow>(
      `${MAPPING_SELECT} WHERE mission_id = $1 AND goal_id = $2 AND removed_at IS NULL`,
      [missionId, goalId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMappingRecord(row);
  }

  async countActiveGoalMappings(tx: DbTransaction, missionId: string): Promise<number> {
    const result = await tx.query<{ count: number | string }>(
      'SELECT count(*)::int AS count FROM growth_mission_goal_mappings WHERE mission_id = $1 AND removed_at IS NULL',
      [missionId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

async function classifyUpdateMiss(
  tx: DbTransaction,
  missionId: string,
): Promise<'not-found' | 'version-conflict'> {
  const existing = await tx.query<{ version: number | string }>(
    'SELECT version FROM growth_missions WHERE mission_id = $1',
    [missionId],
  );
  if (existing.rows.length === 0) return 'not-found';
  return 'version-conflict';
}

// ---------------------------------------------------------------------------
// Row mappers (jsonb arrives parsed; shapes were validated at write time)
// ---------------------------------------------------------------------------

function toMissionRecord(row: MissionRow): GrowthMissionRecord {
  return {
    missionId: row.mission_id,
    agencyId: row.agency_id,
    status: row.status as GrowthMissionStatus,
    currentVersionSeq: Number(row.current_version_seq),
    version: Number(row.version),
    createdActor: row.created_actor,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVersionRecord(
  row: VersionRow,
  metrics: readonly GrowthMissionTargetMetric[],
): GrowthMissionVersionRecord {
  return {
    missionVersionId: row.mission_version_id,
    missionId: row.mission_id,
    versionSeq: Number(row.version_seq),
    objective: row.objective,
    objectiveFamily: row.objective_family as GrowthMissionObjectiveFamily,
    productContext: parseProductContext(row.product_context),
    marketContext: parseMarketContext(row.market_context),
    targetMetrics: metrics,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at.toISOString(),
    },
  };
}

function toTargetMetric(row: MetricRow): GrowthMissionTargetMetric {
  return {
    metric: row.metric,
    comparator: row.comparator as GrowthMissionTargetMetric['comparator'],
    targetValue: Number(row.target_value),
    unit: row.unit,
    description: row.description,
    intermediate: row.intermediate,
  };
}

function toEventRecord(row: EventRow): GrowthMissionEventRecord {
  return {
    eventId: row.event_id,
    missionId: row.mission_id,
    eventSeq: Number(row.event_seq),
    eventKind: row.event_kind as GrowthMissionEventKind,
    fromStatus: row.from_status === null ? null : (row.from_status as GrowthMissionStatus),
    toStatus: row.to_status === null ? null : (row.to_status as GrowthMissionStatus),
    terminalDecisionFamily:
      row.terminal_decision_family === null
        ? null
        : (row.terminal_decision_family as GrowthMissionObjectiveFamily),
    reason: row.reason,
    detail: parseEventDetail(row.detail),
    provenance: {
      actor: row.actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}

function toMappingRecord(row: MappingRow): GrowthMissionGoalMappingRecord {
  return {
    mappingId: row.mapping_id,
    missionId: row.mission_id,
    goalId: row.goal_id,
    addedAt: row.added_at.toISOString(),
    addedBy: row.added_by,
    removedAt: row.removed_at === null ? null : row.removed_at.toISOString(),
    removedBy: row.removed_by,
    removalReason: row.removal_reason,
  };
}

function parseEventDetail(raw: unknown): GrowthMissionEventDetail {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record['kind'] === 'goal' && typeof record['goalId'] === 'string') {
    return { kind: 'goal', goalId: record['goalId'] };
  }
  if (record['kind'] === 'version' && typeof record['versionSeq'] === 'number') {
    return { kind: 'version', versionSeq: record['versionSeq'] };
  }
  return null;
}

function parseProductContext(
  raw: unknown,
): GrowthMissionDeclaration['productContext'] {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    name: nullableString(record['name']),
    url: nullableString(record['url']),
    summary: nullableString(record['summary']),
  };
}

function parseMarketContext(
  raw: unknown,
): GrowthMissionDeclaration['marketContext'] {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    audience: nullableString(record['audience']),
    geography: nullableString(record['geography']),
    summary: nullableString(record['summary']),
  };
}

function nullableString(raw: unknown): string | null {
  return raw === undefined || raw === null ? null : String(raw);
}
