/**
 * /jobs persistence (jobs / job_offers / job_outcomes tables — MKT-026).
 *
 * DB backstops (migration 023 + implementation-contract §3/§25):
 *   - a Job references exactly ONE governed Task occurrence: FK to
 *     workflow_instances + UNIQUE (workflow_instance_id, node_id) — a
 *     second projection of the same Task is rejected by the database
 *     itself (ON CONFLICT DO NOTHING → ConflictError upstream; JOB-AC-01);
 *   - the task-reference trigger (human_task node of a RUNNING instance),
 *     the scope-chain trigger (the Job scope IS the instance scope,
 *     workspace within client, client within agency) and the identity
 *     immutability trigger are the DB end of the projection contract;
 *   - the Job status machine is trigger-enforced edge-for-edge; terminal
 *     rows are frozen;
 *   - the EXACTLY-ONE-WINNER partial unique index (one accepted offer per
 *     job) is the acceptance race backstop; one OPEN offer per
 *     (job, candidate) is fenced; the candidate user denormalization is
 *     trigger-verified against the human_agents identity link;
 *   - offers: terminal states frozen with an explicit terminal_reason;
 *     identity/candidate/expiry immutable;
 *   - outcomes: append-only (UPDATE/DELETE rejected by trigger), exactly
 *     one per job (UNIQUE fence — insert with ON CONFLICT DO NOTHING so
 *     races converge detectably), evidence_ref FK-fenced to the SAME
 *     Client (trigger).
 *
 * Concurrency: every claim/decline/settlement mutation runs on the CALLER'S
 * transaction after the JOB row was locked FOR UPDATE (job-first lock
 * ordering across all paths — no deadlock cycles); acceptance is a
 * state-guarded UPDATE (… WHERE status = 'open') with the partial unique
 * index as the final backstop.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  JobEligibilitySpec,
} from '../../field-agents/public.ts';
import type {
  JobOutcomeRecord,
  JobOutcomeRecordedProvenance,
  JobRecord,
  JobStatus,
  JobOfferRecord,
  OfferStatus,
  OfferTerminalReason,
} from '../public.ts';

interface JobRow extends DbRow {
  job_id: string;
  workflow_instance_id: string;
  node_id: string;
  workspace_id: string;
  client_id: string;
  agency_id: string;
  title: string;
  description: string;
  eligibility: unknown;
  status: string;
  accepted_agent_id: string | null;
  accepted_user_id: string | null;
  accepted_offer_id: string | null;
  accepted_at: Date | null;
  created_by: string | null;
  version: number | bigint;
  created_at: Date;
  updated_at: Date;
}

interface JobOfferRow extends DbRow {
  job_offer_id: string;
  job_id: string;
  candidate_agent_id: string;
  candidate_user_id: string;
  status: string;
  terminal_reason: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  created_by: string | null;
  version: number | bigint;
  created_at: Date;
  updated_at: Date;
}

interface JobOutcomeRow extends DbRow {
  job_outcome_id: string;
  job_id: string;
  outcome: string;
  payload_ref: string | null;
  evidence_ref: string;
  reported_instance_status: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  submitted_by: string | null;
  submitted_at: Date;
  created_at: Date;
}

const JOB_SELECT = `
  SELECT job_id, workflow_instance_id, node_id, workspace_id, client_id, agency_id,
         title, description, eligibility, status, accepted_agent_id, accepted_user_id,
         accepted_offer_id, accepted_at, created_by, version, created_at, updated_at
  FROM jobs
`;

const OFFER_SELECT = `
  SELECT job_offer_id, job_id, candidate_agent_id, candidate_user_id, status,
         terminal_reason, expires_at, accepted_at, created_by, version, created_at, updated_at
  FROM job_offers
`;

const OUTCOME_SELECT = `
  SELECT job_outcome_id, job_id, outcome, payload_ref, evidence_ref, reported_instance_status,
         recorded_actor, recorded_via, correlation_id, causation_id, submitted_by,
         submitted_at, created_at
  FROM job_outcomes
`;

export class JobsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------

  /**
   * Insert fenced by the UNIQUE (workflow_instance_id, node_id) task key:
   * 'task-taken' means this Task occurrence is already projected — the
   * caller surfaces a ConflictError (a second assignment identity for one
   * Task can never exist; JOB-AC-01).
   */
  async insertJob(input: {
    readonly workflowInstanceId: string;
    readonly nodeId: string;
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly title: string;
    readonly description: string;
    readonly eligibility: JobEligibilitySpec;
    readonly actorId: string | null;
  }): Promise<JobRecord | 'task-taken'> {
    const jobId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await this.db.query(
      `INSERT INTO jobs
         (job_id, workflow_instance_id, node_id, workspace_id, client_id, agency_id,
          title, description, eligibility, status, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'projected', $10, 1, $11, $11)
       ON CONFLICT (workflow_instance_id, node_id) DO NOTHING`,
      [
        jobId,
        input.workflowInstanceId,
        input.nodeId,
        input.workspaceId,
        input.clientId,
        input.agencyId,
        input.title,
        input.description,
        JSON.stringify(input.eligibility),
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'task-taken';
    const created = await this.getJob(jobId);
    if (created === null) {
      throw new Error(`inserted job ${jobId} could not be read back`);
    }
    return created;
  }

  async getJob(jobId: string): Promise<JobRecord | null> {
    const result = await this.db.query<JobRow>(`${JOB_SELECT} WHERE job_id = $1`, [jobId]);
    const row = result.rows[0];
    return row === undefined ? null : toJobRecord(row);
  }

  /** Locks the job row (FOR UPDATE) — the claim serialization point. */
  async lockJob(tx: DbTransaction, jobId: string): Promise<JobRecord | null> {
    const result = await tx.query<JobRow>(`${JOB_SELECT} WHERE job_id = $1 FOR UPDATE`, [jobId]);
    const row = result.rows[0];
    return row === undefined ? null : toJobRecord(row);
  }

  /** The open-round jobs (projected/offered) — the marketplace scan surface. */
  async listOfferableJobs(): Promise<readonly JobRecord[]> {
    const result = await this.db.query<JobRow>(
      `${JOB_SELECT} WHERE status IN ('projected', 'offered') ORDER BY created_at, job_id`,
    );
    return result.rows.map(toJobRecord);
  }

  /**
   * Moves projected → offered (the first offer) on the caller's transaction
   * (the job row was locked there). State-guarded; the trigger is the
   * final backstop.
   */
  async markJobOffered(tx: DbTransaction, jobId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE jobs SET status = 'offered', version = version + 1, updated_at = $1
       WHERE job_id = $2 AND status = 'projected'`,
      [now, jobId],
    );
  }

  /**
   * Applies the winning acceptance to the job row on the caller's
   * transaction (the job row was locked there and the decision already
   * made): status offered → accepted with the claim fields.
   */
  async applyJobAccepted(
    tx: DbTransaction,
    input: {
      readonly jobId: string;
      readonly acceptedAgentId: string;
      readonly acceptedUserId: string;
      readonly acceptedOfferId: string;
      readonly acceptedAtIso: string;
    },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE jobs
       SET status = 'accepted', accepted_agent_id = $1, accepted_user_id = $2,
           accepted_offer_id = $3, accepted_at = $4, version = version + 1, updated_at = $5
       WHERE job_id = $6 AND status = 'offered'`,
      [
        input.acceptedAgentId,
        input.acceptedUserId,
        input.acceptedOfferId,
        input.acceptedAtIso,
        now,
        input.jobId,
      ],
    );
  }

  /**
   * Closes the round on the caller's transaction: offered → declined |
   * expired (the settlement rule already computed the target). Terminal.
   */
  async applyJobRoundClosed(
    tx: DbTransaction,
    input: { readonly jobId: string; readonly to: 'declined' | 'expired' },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE jobs SET status = $1, version = version + 1, updated_at = $2
       WHERE job_id = $3 AND status = 'offered'`,
      [input.to, now, input.jobId],
    );
  }

  /**
   * Applies accepted → outcome_submitted on the caller's transaction (the
   * job row was locked there; the outcome row was already inserted).
   */
  async markJobOutcomeSubmitted(tx: DbTransaction, jobId: string): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE jobs SET status = 'outcome_submitted', version = version + 1, updated_at = $1
       WHERE job_id = $2 AND status = 'accepted'`,
      [now, jobId],
    );
  }

  // -------------------------------------------------------------------
  // Offers
  // -------------------------------------------------------------------

  /**
   * Insert fenced by the one-open-offer-per-(job, candidate) partial
   * unique index: 'open-taken' means this candidate already holds an OPEN
   * offer for this job (ConflictError upstream — the database itself
   * rejects the duplicate open offer). Runs on the CALLER'S transaction
   * (job-first lock ordering; the projection → offered transition in the
   * same transaction keeps the round state atomic with the offer row).
   */
  async insertOffer(
    tx: DbTransaction,
    input: {
      readonly jobId: string;
      readonly candidateAgentId: string;
      readonly candidateUserId: string;
      readonly expiresAtIso: string;
      readonly actorId: string | null;
    },
  ): Promise<'ok' | 'open-taken'> {
    const offerId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query(
      `INSERT INTO job_offers
         (job_offer_id, job_id, candidate_agent_id, candidate_user_id, status,
          terminal_reason, expires_at, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', NULL, $5, $6, 1, $7, $7)
       ON CONFLICT DO NOTHING`,
      [
        offerId,
        input.jobId,
        input.candidateAgentId,
        input.candidateUserId,
        input.expiresAtIso,
        input.actorId,
        now,
      ],
    );
    if (result.rowCount !== 1) return 'open-taken';
    return 'ok';
  }

  async getOffer(jobId: string, offerId: string): Promise<JobOfferRecord | null> {
    const result = await this.db.query<JobOfferRow>(
      `${OFFER_SELECT} WHERE job_id = $1 AND job_offer_id = $2`,
      [jobId, offerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOfferRecord(row);
  }

  /** Locks the offer row (FOR UPDATE) — called AFTER the job row is locked. */
  async lockOffer(tx: DbTransaction, jobId: string, offerId: string): Promise<JobOfferRecord | null> {
    const result = await tx.query<JobOfferRow>(
      `${OFFER_SELECT} WHERE job_id = $1 AND job_offer_id = $2 FOR UPDATE`,
      [jobId, offerId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toOfferRecord(row);
  }

  async listOffersForJob(jobId: string): Promise<readonly JobOfferRecord[]> {
    const result = await this.db.query<JobOfferRow>(
      `${OFFER_SELECT} WHERE job_id = $1 ORDER BY created_at, job_offer_id`,
      [jobId],
    );
    return result.rows.map(toOfferRecord);
  }

  /** Offers of one job read on the CALLER'S transaction (uncommitted visibility). */
  async listOffersTx(tx: DbTransaction, jobId: string): Promise<readonly JobOfferRecord[]> {
    const result = await tx.query<JobOfferRow>(
      `${OFFER_SELECT} WHERE job_id = $1 ORDER BY created_at, job_offer_id`,
      [jobId],
    );
    return result.rows.map(toOfferRecord);
  }

  async listOffersForCandidateAgent(candidateAgentId: string): Promise<readonly JobOfferRecord[]> {
    const result = await this.db.query<JobOfferRow>(
      `${OFFER_SELECT} WHERE candidate_agent_id = $1 ORDER BY created_at DESC, job_offer_id`,
      [candidateAgentId],
    );
    return result.rows.map(toOfferRecord);
  }

  /**
   * The winning claim on the caller's transaction: open → accepted with
   * the reason 'claimed'. State-guarded double check (… WHERE status =
   * 'open') — under the job row lock this cannot lose, and the partial
   * unique index is the final backstop even if it somehow did.
   */
  async applyOfferAccepted(
    tx: DbTransaction,
    input: { readonly offerId: string; readonly acceptedAtIso: string },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE job_offers
       SET status = 'accepted', terminal_reason = 'claimed', accepted_at = $1,
           version = version + 1, updated_at = $2
       WHERE job_offer_id = $3 AND status = 'open'`,
      [input.acceptedAtIso, now, input.offerId],
    );
  }

  /**
   * A per-offer terminal transition on the caller's transaction (declined
   * or expired) with its explicit reason. State-guarded.
   */
  async applyOfferTerminal(
    tx: DbTransaction,
    input: {
      readonly offerId: string;
      readonly to: OfferStatus;
      readonly reason: OfferTerminalReason;
    },
  ): Promise<void> {
    const now = this.clock.nowIso();
    await tx.query(
      `UPDATE job_offers
       SET status = $1, terminal_reason = $2, version = version + 1, updated_at = $3
       WHERE job_offer_id = $4 AND status = 'open'`,
      [input.to, input.reason, now, input.offerId],
    );
  }

  /**
   * Expires the sibling OPEN offers of a claimed job (the losing offers —
   * "losing offers transition to EXPIRED … and cannot later claim the
   * Job"). Runs inside the winning acceptance transaction.
   */
  async expireSiblingOpenOffers(
    tx: DbTransaction,
    input: { readonly jobId: string; readonly exceptOfferId: string; readonly nowIso: string },
  ): Promise<void> {
    await tx.query(
      `UPDATE job_offers
       SET status = 'expired', terminal_reason = 'lost', version = version + 1,
           updated_at = $1
       WHERE job_id = $2 AND status = 'open' AND job_offer_id <> $3`,
      [input.nowIso, input.jobId, input.exceptOfferId],
    );
  }

  /**
   * Offer status counts for the settlement rule (the caller's transaction,
   * after the offer mutations were applied).
   */
  async offerStatusCounts(
    tx: DbTransaction,
    jobId: string,
  ): Promise<{
    open: number;
    accepted: number;
    declined: number;
    expired: number;
    withdrawn: number;
  }> {
    const result = await tx.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM job_offers WHERE job_id = $1 GROUP BY status`,
      [jobId],
    );
    const counts = { open: 0, accepted: 0, declined: 0, expired: 0, withdrawn: 0 };
    for (const row of result.rows) {
      const key = row.status as keyof typeof counts;
      counts[key] = Number(row.count);
    }
    return counts;
  }

  // -------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------

  /**
   * Insert fenced by the UNIQUE (job_id) one-outcome-per-job constraint:
   * 'taken' means an outcome already exists for this job — the caller
   * converges (same fingerprint → replay) or conflicts. The same-client
   * evidence trigger and the append-only trigger are the DB backstops.
   * Runs on the CALLER'S transaction so the accepted → outcome_submitted
   * job transition is atomic with the outcome row.
   */
  async insertOutcome(
    tx: DbTransaction,
    input: {
      readonly jobId: string;
      readonly outcome: 'succeeded' | 'failed';
      readonly payloadRef: string | null;
      readonly evidenceRef: string;
      readonly reportedInstanceStatus: string;
      readonly provenance: JobOutcomeRecordedProvenance;
    },
  ): Promise<'ok' | 'taken'> {
    const outcomeId = this.ids.newId();
    const result = await tx.query(
      `INSERT INTO job_outcomes
         (job_outcome_id, job_id, outcome, payload_ref, evidence_ref,
          reported_instance_status, recorded_actor, recorded_via, correlation_id,
          causation_id, submitted_by, submitted_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (job_id) DO NOTHING`,
      [
        outcomeId,
        input.jobId,
        input.outcome,
        input.payloadRef,
        input.evidenceRef,
        input.reportedInstanceStatus,
        input.provenance.actor,
        input.provenance.recordedVia,
        input.provenance.correlationId,
        input.provenance.causationId,
        input.provenance.submittedBy,
        input.provenance.submittedAt,
        input.provenance.submittedAt,
      ],
    );
    if (result.rowCount !== 1) return 'taken';
    return 'ok';
  }

  async getJobOutcome(jobId: string): Promise<JobOutcomeRecord | null> {
    const result = await this.db.query<JobOutcomeRow>(`${OUTCOME_SELECT} WHERE job_id = $1`, [jobId]);
    const row = result.rows[0];
    return row === undefined ? null : toOutcomeRecord(row);
  }

  /** Outcome read on the caller's transaction (race-safe replay checks). */
  async lockJobOutcome(tx: DbTransaction, jobId: string): Promise<JobOutcomeRecord | null> {
    const result = await tx.query<JobOutcomeRow>(`${OUTCOME_SELECT} WHERE job_id = $1 FOR UPDATE`, [
      jobId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : toOutcomeRecord(row);
  }
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    workflowInstanceId: row.workflow_instance_id,
    nodeId: row.node_id,
    workspaceId: row.workspace_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    title: row.title,
    description: row.description,
    eligibility: row.eligibility as JobRecord['eligibility'],
    status: row.status as JobStatus,
    acceptedAgentId: row.accepted_agent_id,
    acceptedUserId: row.accepted_user_id,
    acceptedOfferId: row.accepted_offer_id,
    acceptedAt: row.accepted_at === null ? null : row.accepted_at.toISOString(),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toOfferRecord(row: JobOfferRow): JobOfferRecord {
  return {
    jobOfferId: row.job_offer_id,
    jobId: row.job_id,
    candidateAgentId: row.candidate_agent_id,
    candidateUserId: row.candidate_user_id,
    status: row.status as OfferStatus,
    terminalReason: row.terminal_reason as OfferTerminalReason | null,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at === null ? null : row.accepted_at.toISOString(),
    createdBy: row.created_by,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toOutcomeRecord(row: JobOutcomeRow): JobOutcomeRecord {
  return {
    jobOutcomeId: row.job_outcome_id,
    jobId: row.job_id,
    outcome: row.outcome as 'succeeded' | 'failed',
    payloadRef: row.payload_ref,
    evidenceRef: row.evidence_ref,
    reportedInstanceStatus: row.reported_instance_status as JobOutcomeRecord['reportedInstanceStatus'],
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at.toISOString(),
    },
    createdAt: row.created_at.toISOString(),
  };
}
