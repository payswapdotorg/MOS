/**
 * /jobs field-execution persistence (job_visits / job_visit_transitions /
 * job_visit_outcomes / job_visit_evidence tables — MKT-027, migration 024).
 *
 * DB backstops (migration 024 + implementation-contract §3/§25):
 *   - a visit belongs to exactly ONE accepted Job: FK to jobs + the
 *     acceptance-window INSERT trigger (jobs.status = 'accepted') + the
 *     scope-chain trigger (the visit scope IS the job scope — inherited,
 *     never caller-provided);
 *   - the visit status machine is trigger-enforced edge-for-edge
 *     (planned → in_progress | cancelled; in_progress → completed |
 *     cancelled); completed/cancelled are TERMINAL frozen rows; identity,
 *     scope, target identity, follow-up link and provenance are immutable;
 *   - the follow-up link is trigger-fenced to a COMPLETED visit of the
 *     SAME relationship (agency + client + target identity);
 *   - every applied transition is APPEND-ONLY history with full
 *     server-derived provenance (job_visit_transitions);
 *   - the structured visit outcome is append-only (UPDATE/DELETE rejected
 *     by trigger), exactly one per visit (UNIQUE fence — insert with ON
 *     CONFLICT DO NOTHING so races converge detectably), with the
 *     same-Client evidence trigger as the DB backstop;
 *   - the evidence-capture link is append-only and same-Client fenced.
 *
 * Concurrency: every visit mutation runs on the CALLER'S transaction after
 * the JOB row was locked FOR UPDATE (the same job-first lock ordering as
 * the MKT-026 store — no deadlock cycles); the visit row is then locked
 * FOR UPDATE before any transition decision; the UNIQUE (job_id,
 * visit_seq) and UNIQUE (visit_id) outcome fences are the race
 * backstops.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  VisitOutcomeRecord,
  VisitEvidenceLinkRecord,
  VisitRecord,
  VisitRecordedProvenance,
  VisitResult,
  VisitStatus,
  VisitTransitionRecord,
} from '../public.ts';

interface VisitRow extends DbRow {
  visit_id: string;
  job_id: string;
  visit_seq: number;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  target_identity: string;
  status: string;
  scheduled_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  follow_up_of_visit_id: string | null;
  created_by: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
  version: number | bigint;
  created_at: Date;
  updated_at: Date;
}

interface VisitTransitionRow extends DbRow {
  transition_id: string;
  visit_id: string;
  from_status: string;
  to_status: string;
  reason: string;
  created_by: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface VisitOutcomeRow extends DbRow {
  visit_outcome_id: string;
  visit_id: string;
  result: string;
  follow_up_required: boolean;
  notes: string;
  observations: unknown;
  evidence_ref: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  submitted_by: string | null;
  submitted_at: Date;
  created_at: Date;
}

interface VisitEvidenceRow extends DbRow {
  visit_id: string;
  evidence_id: string;
  captured_by: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

const VISIT_SELECT = `
  SELECT visit_id, job_id, visit_seq, workspace_id, client_id, agency_id,
         target_identity, status, scheduled_at, started_at, completed_at,
         cancelled_at, follow_up_of_visit_id, created_by, recorded_actor,
         recorded_via, correlation_id, causation_id, created_at AS recorded_at,
         version, created_at, updated_at
  FROM job_visits
`;

const VISIT_TRANSITION_SELECT = `
  SELECT transition_id, visit_id, from_status, to_status, reason, created_by,
         recorded_actor, recorded_via, correlation_id, causation_id, created_at
  FROM job_visit_transitions
`;

const VISIT_OUTCOME_SELECT = `
  SELECT visit_outcome_id, visit_id, result, follow_up_required, notes,
         observations, evidence_ref, recorded_actor, recorded_via,
         correlation_id, causation_id, submitted_by, submitted_at, created_at
  FROM job_visit_outcomes
`;

const VISIT_EVIDENCE_SELECT = `
  SELECT visit_id, evidence_id, captured_by, recorded_actor, recorded_via,
         correlation_id, causation_id, created_at
  FROM job_visit_evidence
`;

export class JobsVisitStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------
  // Visits
  // -------------------------------------------------------------------

  /**
   * Inserts one visit on the CALLER'S transaction (the job row was locked
   * there). The visit_seq is computed under that lock; the UNIQUE
   * (job_id, visit_seq) fence is the race backstop. The scope chain, the
   * acceptance window and the follow-up consistency are DB-trigger
   * backstops — the module resolves them BEFORE any write.
   */
  async insertVisit(
    tx: DbTransaction,
    input: {
      readonly jobId: string;
      readonly visitSeq: number;
      readonly workspaceId: string;
      readonly clientId: string;
      readonly agencyId: string;
      readonly targetIdentity: string;
      readonly scheduledAtIso: string | null;
      readonly followUpOfVisitId: string | null;
      readonly createdBy: string | null;
      readonly provenance: VisitRecordedProvenance;
    },
  ): Promise<VisitRecord> {
    const visitId = this.ids.newId();
    const now = this.clock.nowIso();
    await tx.query(
      `INSERT INTO job_visits
         (visit_id, job_id, visit_seq, workspace_id, client_id, agency_id,
          target_identity, status, scheduled_at, follow_up_of_visit_id,
          created_by, recorded_actor, recorded_via, correlation_id, causation_id,
          version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned', $8, $9, $10, $11, $12, $13, $14, 1, $15, $15)`,
      [
        visitId,
        input.jobId,
        input.visitSeq,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.targetIdentity,
        input.scheduledAtIso,
        input.followUpOfVisitId,
        input.createdBy,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        now,
      ],
    );
    const created = await this.lockVisit(tx, input.jobId, visitId);
    if (created === null) {
      throw new Error(`inserted visit ${visitId} could not be read back`);
    }
    return created;
  }

  async getVisit(jobId: string, visitId: string): Promise<VisitRecord | null> {
    const result = await this.db.query<VisitRow>(
      `${VISIT_SELECT} WHERE job_id = $1 AND visit_id = $2`,
      [jobId, visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVisitRecord(row);
  }

  /** The visit by id alone (continuity/history/outcome lookups). */
  async getVisitById(visitId: string): Promise<VisitRecord | null> {
    const result = await this.db.query<VisitRow>(`${VISIT_SELECT} WHERE visit_id = $1`, [
      visitId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toVisitRecord(row);
  }

  /** Locks the visit row (FOR UPDATE) — after the job row is locked. */
  async lockVisit(tx: DbTransaction, jobId: string, visitId: string): Promise<VisitRecord | null> {
    const result = await tx.query<VisitRow>(
      `${VISIT_SELECT} WHERE job_id = $1 AND visit_id = $2 FOR UPDATE`,
      [jobId, visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVisitRecord(row);
  }

  async listVisitsForJob(jobId: string): Promise<readonly VisitRecord[]> {
    const result = await this.db.query<VisitRow>(
      `${VISIT_SELECT} WHERE job_id = $1 ORDER BY visit_seq, visit_id`,
      [jobId],
    );
    return result.rows.map(toVisitRecord);
  }

  /** The next per-job visit sequence (computed under the job row lock). */
  async nextVisitSeq(tx: DbTransaction, jobId: string): Promise<number> {
    const result = await tx.query<{ max_seq: number | null }>(
      `SELECT max(visit_seq) AS max_seq FROM job_visits WHERE job_id = $1`,
      [jobId],
    );
    const maxSeq = result.rows[0]?.max_seq ?? null;
    return maxSeq === null ? 1 : maxSeq + 1;
  }

  /**
   * Applies planned → in_progress on the caller's transaction (the visit
   * row was locked there and the decision already made). State-guarded;
   * the frozen-state-machine trigger is the final backstop.
   */
  async applyVisitStarted(tx: DbTransaction, visitId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE job_visits
       SET status = 'in_progress', started_at = $1, version = version + 1, updated_at = $2
       WHERE visit_id = $3 AND status = 'planned'`,
      [now, now, visitId],
    );
  }

  /**
   * Applies the cancellation on the caller's transaction (from planned or
   * in_progress). State-guarded.
   */
  async applyVisitCancelled(tx: DbTransaction, visitId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE job_visits
       SET status = 'cancelled', cancelled_at = $1, version = version + 1, updated_at = $2
       WHERE visit_id = $3 AND status IN ('planned', 'in_progress')`,
      [now, now, visitId],
    );
  }

  /**
   * Applies in_progress → completed on the caller's transaction (the
   * outcome row was already inserted in the SAME transaction — the
   * transition and the outcome are atomic).
   */
  async applyVisitCompleted(tx: DbTransaction, visitId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE job_visits
       SET status = 'completed', completed_at = $1, version = version + 1, updated_at = $2
       WHERE visit_id = $3 AND status = 'in_progress'`,
      [now, now, visitId],
    );
  }

  // -------------------------------------------------------------------
  // Transition history (append-only, full provenance)
  // -------------------------------------------------------------------

  /** Records one APPLIED transition (legal-edge-fenced by trigger). */
  async insertTransition(
    tx: DbTransaction,
    input: {
      readonly visitId: string;
      readonly fromStatus: VisitStatus;
      readonly toStatus: VisitStatus;
      readonly reason: string;
      readonly createdBy: string | null;
      readonly provenance: VisitRecordedProvenance;
    },
  ): Promise<void> {
    const transitionId = this.ids.newId();
    await tx.query(
      `INSERT INTO job_visit_transitions
         (transition_id, visit_id, from_status, to_status, reason, created_by,
          recorded_actor, recorded_via, correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        transitionId,
        input.visitId,
        input.fromStatus,
        input.toStatus,
        input.reason,
        input.createdBy,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        input.provenance.recordedAt,
      ],
    );
  }

  async listVisitTransitions(visitId: string): Promise<readonly VisitTransitionRecord[]> {
    const result = await this.db.query<VisitTransitionRow>(
      `${VISIT_TRANSITION_SELECT} WHERE visit_id = $1 ORDER BY created_at, transition_id`,
      [visitId],
    );
    return result.rows.map(toVisitTransitionRecord);
  }

  // -------------------------------------------------------------------
  // Structured visit outcomes (append-only, one per visit)
  // -------------------------------------------------------------------

  /**
   * Insert fenced by the UNIQUE (visit_id) one-outcome-per-visit
   * constraint: 'taken' means an outcome already exists for this visit —
   * the caller converges (same fingerprint → replay) or conflicts. The
   * same-client evidence trigger and the append-only trigger are the DB
   * backstops. Runs on the CALLER'S transaction so the in_progress →
   * completed transition is atomic with the outcome row.
   */
  async insertVisitOutcome(
    tx: DbTransaction,
    input: {
      readonly visitId: string;
      readonly result: VisitResult;
      readonly followUpRequired: boolean;
      readonly notes: string;
      readonly observations: Readonly<Record<string, unknown>>;
      readonly evidenceRef: string;
      readonly provenance: VisitRecordedProvenance & {
        readonly submittedBy: string | null;
        readonly submittedAt: string;
      };
    },
  ): Promise<'ok' | 'taken'> {
    const outcomeId = this.ids.newId();
    const result = await tx.query(
      `INSERT INTO job_visit_outcomes
         (visit_outcome_id, visit_id, result, follow_up_required, notes,
          observations, evidence_ref, recorded_actor, recorded_via, correlation_id,
          causation_id, submitted_by, submitted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $13)
       ON CONFLICT (visit_id) DO NOTHING`,
      [
        outcomeId,
        input.visitId,
        input.result,
        input.followUpRequired,
        input.notes,
        JSON.stringify(input.observations),
        input.evidenceRef,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        input.provenance.submittedBy,
        input.provenance.submittedAt,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    return 'ok';
  }

  async getVisitOutcome(visitId: string): Promise<VisitOutcomeRecord | null> {
    const result = await this.db.query<VisitOutcomeRow>(
      `${VISIT_OUTCOME_SELECT} WHERE visit_id = $1`,
      [visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVisitOutcomeRecord(row);
  }

  /** Outcome read on the caller's transaction (race-safe replay checks). */
  async lockVisitOutcome(tx: DbTransaction, visitId: string): Promise<VisitOutcomeRecord | null> {
    const result = await tx.query<VisitOutcomeRow>(
      `${VISIT_OUTCOME_SELECT} WHERE visit_id = $1 FOR UPDATE`,
      [visitId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVisitOutcomeRecord(row);
  }

  // -------------------------------------------------------------------
  // Evidence-capture links (append-only, same-client fenced)
  // -------------------------------------------------------------------

  /**
   * Links the visit to an evidence record captured through the field
   * surface (the /evidence append itself already happened — through the
   * /evidence public contract — before this link row). ON CONFLICT DO
   * NOTHING: a retried capture of the SAME evidence record converges to
   * the recorded link (the link is a derived attribution index; the
   * evidence row is the authority).
   */
  async insertVisitEvidenceLink(
    input: {
      readonly visitId: string;
      readonly evidenceId: string;
      readonly capturedBy: string | null;
      readonly provenance: VisitRecordedProvenance;
    },
  ): Promise<VisitEvidenceLinkRecord> {
    await this.db.query(
      `INSERT INTO job_visit_evidence
         (visit_id, evidence_id, captured_by, recorded_actor, recorded_via,
          correlation_id, causation_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (visit_id, evidence_id) DO NOTHING`,
      [
        input.visitId,
        input.evidenceId,
        input.capturedBy,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        input.provenance.recordedAt,
      ],
    );
    const created: VisitEvidenceLinkRecord = {
      visitId: input.visitId,
      evidenceId: input.evidenceId,
      capturedBy: input.capturedBy,
      provenance: input.provenance,
    };
    return created;
  }

  async listVisitEvidence(visitId: string): Promise<readonly VisitEvidenceLinkRecord[]> {
    const result = await this.db.query<VisitEvidenceRow>(
      `${VISIT_EVIDENCE_SELECT} WHERE visit_id = $1 ORDER BY created_at, evidence_id`,
      [visitId],
    );
    return result.rows.map(toVisitEvidenceRecord);
  }

  // -------------------------------------------------------------------
  // Continuity (JOB-AC-04 — the DERIVED relationship chain; a READ)
  // -------------------------------------------------------------------

  /**
   * The prior COMPLETED visits of the SAME relationship (agency + client +
   * target identity), oldest first, excluding the given visit. Derived
   * data: computed from durable state, never rewritten.
   */
  async listCompletedVisitsOfRelationship(
    relationship: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly targetIdentity: string;
    },
    excludingVisitId: string,
  ): Promise<readonly VisitRecord[]> {
    const result = await this.db.query<VisitRow>(
      `${VISIT_SELECT}
       WHERE agency_id = $1 AND client_id = $2 AND target_identity = $3
         AND status = 'completed' AND visit_id <> $4
       ORDER BY completed_at, visit_id`,
      [relationship.agencyId, relationship.clientId, relationship.targetIdentity, excludingVisitId],
    );
    return result.rows.map(toVisitRecord);
  }
}

function toVisitRecord(row: VisitRow): VisitRecord {
  return {
    visitId: row.visit_id,
    jobId: row.job_id,
    visitSeq: Number(row.visit_seq),
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    targetIdentity: row.target_identity,
    status: row.status as VisitStatus,
    scheduledAt: row.scheduled_at === null ? null : row.scheduled_at.toISOString(),
    startedAt: row.started_at === null ? null : row.started_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    followUpOfVisitId: row.follow_up_of_visit_id,
    createdBy: row.created_by,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toVisitTransitionRecord(row: VisitTransitionRow): VisitTransitionRecord {
  return {
    transitionId: row.transition_id,
    visitId: row.visit_id,
    fromStatus: row.from_status as VisitStatus,
    toStatus: row.to_status as VisitStatus,
    reason: row.reason,
    createdBy: row.created_by,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
  };
}

function toVisitOutcomeRecord(row: VisitOutcomeRow): VisitOutcomeRecord {
  return {
    visitOutcomeId: row.visit_outcome_id,
    visitId: row.visit_id,
    result: row.result as VisitResult,
    followUpRequired: row.follow_up_required,
    notes: row.notes,
    observations: row.observations as Readonly<Record<string, unknown>>,
    evidenceRef: row.evidence_ref,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at.toISOString(),
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
  };
}

function toVisitEvidenceRecord(row: VisitEvidenceRow): VisitEvidenceLinkRecord {
  return {
    visitId: row.visit_id,
    evidenceId: row.evidence_id,
    capturedBy: row.captured_by,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.created_at.toISOString(),
    },
  };
}
