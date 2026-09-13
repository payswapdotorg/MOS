/**
 * /sales-continuity persistence (sales_continuity_carries +
 * sales_continuity_events tables — migration 040, the MKT-046 pre-assigned
 * number; 038/039 belong to sibling deliveries).
 *
 * Two durable structures (the 035/036 house style):
 *
 *   - `sales_continuity_carries`: ONE row per continuity carry. The
 *     identity columns (scope chain, source references + fingerprint,
 *     carried snapshot, §8 logical create identity, provenance) are
 *     IMMUTABLE after insert — a BEFORE UPDATE trigger rejects any
 *     rewrite of them. Only the FORWARD-ONLY COMPLETION columns may
 *     change, and only along the ladder carrying → carried → deployed:
 *     the playbook completion sets carried_playbook_id +
 *     carried_playbook_version_id + carried_version_number exactly once
 *     (from NULL, with the state move); the deployment completion sets
 *     carried_deployment_id exactly once (from NULL, with the state
 *     move). Backwards moves, repeated rewrites and cross-column
 *     mismatches are rejected by trigger.
 *   - `sales_continuity_events`: the APPEND-ONLY continuity event tail —
 *     UPDATE and DELETE are rejected by triggers (the migration
 *     015/018/019/027/036 pattern). Each row is one immutable event:
 *     the claim (source + snapshot identity), the playbook completion
 *     (ids + numbers) or the deployment completion.
 *
 * The database is the final backstop for every material invariant:
 *   - the closed enums (carry state, event kind) are CHECKs;
 *   - the SOURCE fence is UNIQUE(source_decision_id) — one carry per
 *     proposal version (the disclosed duplicate guard);
 *   - the §8 logical create fence is UNIQUE(client_id, idempotency_key);
 *   - the event fence is UNIQUE(carry_id, idempotency_key);
 *   - the completion columns are one-shot + forward-only (triggers);
 *   - the source decision / carried playbook / carried version / carried
 *     deployment references must belong to the SAME Client (triggers —
 *     cross-tenant rejection, the migration 019/027/036 pattern).
 *
 * The store's SQL touches ONLY the two sales_continuity_* tables: the
 * proposal, playbook and deployment records are reached through their
 * modules' PUBLIC CONTRACTS (never their tables).
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  CarriedProposalStructure,
  SalesContinuityCarryRecord,
  SalesContinuityCarryState,
  SalesContinuityEventKind,
  SalesContinuityEventRecord,
  SalesContinuityProvenance,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface CarryRow extends DbRow {
  carry_id: string;
  client_id: string;
  agency_id: string;
  source_workspace_id: string | null;
  source_decision_id: string;
  source_fingerprint: string;
  carried_playbook_id: string | null;
  carried_playbook_version_id: string | null;
  carried_version_number: number | string | null;
  carried_deployment_id: string | null;
  carry_state: string;
  carried_payload: unknown;
  idempotency_key: string;
  create_fingerprint: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface CarryEventRow extends DbRow {
  event_id: string;
  carry_id: string;
  event_kind: string;
  detail: unknown;
  idempotency_key: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const CARRY_SELECT = `
  SELECT c.carry_id, c.client_id, c.agency_id, c.source_workspace_id,
         c.source_decision_id, c.source_fingerprint,
         c.carried_playbook_id, c.carried_playbook_version_id,
         c.carried_version_number, c.carried_deployment_id, c.carry_state,
         c.carried_payload, c.idempotency_key, c.create_fingerprint,
         c.recorded_actor, c.recorded_via, c.correlation_id, c.causation_id, c.recorded_at
  FROM sales_continuity_carries c
`;

function toCarryRecord(row: CarryRow): SalesContinuityCarryRecord {
  return {
    carryId: row.carry_id,
    clientId: row.client_id,
    agencyId: row.agency_id,
    sourceWorkspaceId: row.source_workspace_id,
    sourceDecisionId: row.source_decision_id,
    sourceFingerprint: row.source_fingerprint,
    carriedPlaybookId: row.carried_playbook_id,
    carriedPlaybookVersionId: row.carried_playbook_version_id,
    carriedVersionNumber:
      row.carried_version_number === null ? null : Number(row.carried_version_number),
    carriedDeploymentId: row.carried_deployment_id,
    carryState: row.carry_state as SalesContinuityCarryState,
    carriedPayload: row.carried_payload as CarriedProposalStructure,
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    },
  };
}

function toEventRecord(row: CarryEventRow): SalesContinuityEventRecord {
  return {
    eventId: row.event_id,
    carryId: row.carry_id,
    eventKind: row.event_kind as SalesContinuityEventKind,
    detail: (row.detail ?? {}) as Readonly<Record<string, string | number | null>>,
    idempotencyKey: row.idempotency_key,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at instanceof Date ? row.recorded_at.toISOString() : String(row.recorded_at),
    },
  };
}

// ---------------------------------------------------------------------------
// The insert shape (module-built; every value server-derived or derived)
// ---------------------------------------------------------------------------

export interface CarryInsertRow {
  readonly clientId: string;
  readonly agencyId: string;
  readonly sourceWorkspaceId: string | null;
  readonly sourceDecisionId: string;
  readonly sourceFingerprint: string;
  readonly carriedPayload: CarriedProposalStructure;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

export class SalesContinuityStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * CLAIMS one carry ('carrying', no carried references yet) — the durable
   * §8 fence mark that precedes the orchestrated playbook creation (the
   * claim-then-complete discipline: the fence fires BEFORE any side
   * effect, so a replay can never create a second playbook).
   *
   * Both fences are DB constraints: UNIQUE(source_decision_id) — one
   * carry per proposal version — and UNIQUE(client_id, idempotency_key)
   * — one logical create per Client. ON CONFLICT DO NOTHING returns
   * false when either fence fired (the caller converges through the
   * read-backs and classifies which fence it was).
   */
  async insertClaim(
    row: CarryInsertRow,
    provenance: SalesContinuityProvenance,
  ): Promise<{ readonly inserted: boolean; readonly eventId: string }> {
    const carryId = this.ids.newId();
    const eventId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const inserted = await this.db.transaction(async (tx) => {
      const result = await tx.query(
        `INSERT INTO sales_continuity_carries (carry_id, client_id, agency_id,
                             source_workspace_id, source_decision_id, source_fingerprint,
                             carried_playbook_id, carried_playbook_version_id,
                             carried_version_number, carried_deployment_id, carry_state,
                             carried_payload, idempotency_key, create_fingerprint,
                             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, NULL, NULL, 'carrying',
                 $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT DO NOTHING`,
        [
          carryId,
          row.clientId,
          row.agencyId,
          row.sourceWorkspaceId,
          row.sourceDecisionId,
          row.sourceFingerprint,
          JSON.stringify(row.carriedPayload),
          row.idempotencyKey,
          row.createFingerprint,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      if (result.rowCount !== 1) {
        return false;
      }
      await tx.query(
        `INSERT INTO sales_continuity_events (event_id, carry_id, event_kind, detail,
                               idempotency_key,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, 'carry-claimed', $3::jsonb, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          carryId,
          JSON.stringify({
            sourceDecisionId: row.sourceDecisionId,
            sourceFingerprint: row.sourceFingerprint,
            derivationVersion: row.carriedPayload.derivationVersion,
          }),
          row.idempotencyKey,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      return true;
    });
    return { inserted, eventId };
  }

  async getCarry(carryId: string): Promise<SalesContinuityCarryRecord | null> {
    const result = await this.db.query<CarryRow>(
      `${CARRY_SELECT} WHERE c.carry_id = $1`,
      [carryId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCarryRecord(row);
  }

  /** The carry claimed from one proposal version (null when none). */
  async findCarryBySource(decisionId: string): Promise<SalesContinuityCarryRecord | null> {
    const result = await this.db.query<CarryRow>(
      `${CARRY_SELECT} WHERE c.source_decision_id = $1`,
      [decisionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCarryRecord(row);
  }

  /** The §8 convergence read: the carry recorded under one Client's logical create key. */
  async findCarryByIdempotencyKey(
    clientId: string,
    idempotencyKey: string,
  ): Promise<SalesContinuityCarryRecord | null> {
    const result = await this.db.query<CarryRow>(
      `${CARRY_SELECT} WHERE c.client_id = $1 AND c.idempotency_key = $2`,
      [clientId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCarryRecord(row);
  }

  /** The carry that produced one carried playbook (the round-trip's other half). */
  async findCarryByCarriedPlaybook(playbookId: string): Promise<SalesContinuityCarryRecord | null> {
    const result = await this.db.query<CarryRow>(
      `${CARRY_SELECT} WHERE c.carried_playbook_id = $1`,
      [playbookId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toCarryRecord(row);
  }

  /** The Client's carries, newest first by server-recorded time (bounded). */
  async listCarriesForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly SalesContinuityCarryRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<CarryRow>(
      `${CARRY_SELECT} WHERE c.client_id = $1
       ORDER BY c.recorded_at DESC, c.carry_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toCarryRecord);
  }

  /**
   * COMPLETES the playbook leg atomically: 'carrying' → 'carried' with the
   * carried references set EXACTLY ONCE (the CAS update — WHERE
   * carry_state = 'carrying' AND carried_playbook_id IS NULL; the DB
   * forward-only trigger is the race backstop), then the append-only
   * 'playbook-carried' event row in the same transaction. Returns null
   * when the CAS lost — the caller converges/classifies.
   */
  async completePlaybookCarry(
    carryId: string,
    carried: {
      readonly playbookId: string;
      readonly playbookVersionId: string;
      readonly versionNumber: number;
    },
    provenance: SalesContinuityProvenance,
  ): Promise<SalesContinuityEventRecord | null> {
    const eventId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const applied = await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE sales_continuity_carries
         SET carried_playbook_id = $2, carried_playbook_version_id = $3,
             carried_version_number = $4, carry_state = 'carried'
         WHERE carry_id = $1 AND carry_state = 'carrying'
           AND carried_playbook_id IS NULL AND carried_playbook_version_id IS NULL
           AND carried_version_number IS NULL`,
        [carryId, carried.playbookId, carried.playbookVersionId, carried.versionNumber],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      await tx.query(
        `INSERT INTO sales_continuity_events (event_id, carry_id, event_kind, detail,
                               idempotency_key,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, 'playbook-carried', $3::jsonb, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          carryId,
          JSON.stringify({
            playbookId: carried.playbookId,
            playbookVersionId: carried.playbookVersionId,
            versionNumber: carried.versionNumber,
          }),
          this.completionEventKey(carryId, 'playbook-carried'),
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      return true;
    });
    if (!applied) return null;
    return this.getEvent(eventId);
  }

  /**
   * COMPLETES the deployment leg atomically: 'carried' → 'deployed' with
   * the deployment reference set EXACTLY ONCE (the same CAS + one-shot
   * discipline), then the append-only 'deployment-carried' event row in
   * the same transaction — carrying the CALLER'S §8 logical command key
   * (the replay pre-check converges through it). Returns null when the
   * CAS lost.
   */
  async completeDeploymentCarry(
    carryId: string,
    deploymentId: string,
    idempotencyKey: string,
    provenance: SalesContinuityProvenance,
  ): Promise<SalesContinuityEventRecord | null> {
    const eventId = this.ids.newId();
    const recordedAt = this.clock.nowIso();
    const applied = await this.db.transaction(async (tx) => {
      const updated = await tx.query(
        `UPDATE sales_continuity_carries
         SET carried_deployment_id = $2, carry_state = 'deployed'
         WHERE carry_id = $1 AND carry_state = 'carried'
           AND carried_deployment_id IS NULL`,
        [carryId, deploymentId],
      );
      if (updated.rowCount !== 1) {
        return false;
      }
      await tx.query(
        `INSERT INTO sales_continuity_events (event_id, carry_id, event_kind, detail,
                               idempotency_key,
                               recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, 'deployment-carried', $3::jsonb, $4, $5, $6, $7, $8, $9)`,
        [
          eventId,
          carryId,
          JSON.stringify({ deploymentId }),
          idempotencyKey,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          recordedAt,
        ],
      );
      return true;
    });
    if (!applied) return null;
    return this.getEvent(eventId);
  }

  async getEvent(eventId: string): Promise<SalesContinuityEventRecord | null> {
    const result = await this.db.query<CarryEventRow>(
      `SELECT e.event_id, e.carry_id, e.event_kind, e.detail, e.idempotency_key,
              e.recorded_actor, e.recorded_via, e.correlation_id, e.causation_id, e.recorded_at
       FROM sales_continuity_events e WHERE e.event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /** The §8 convergence read for the command legs: the event recorded under one key. */
  async findEventByIdempotencyKey(
    carryId: string,
    idempotencyKey: string,
  ): Promise<SalesContinuityEventRecord | null> {
    const result = await this.db.query<CarryEventRow>(
      `SELECT e.event_id, e.carry_id, e.event_kind, e.detail, e.idempotency_key,
              e.recorded_actor, e.recorded_via, e.correlation_id, e.causation_id, e.recorded_at
       FROM sales_continuity_events e
       WHERE e.carry_id = $1 AND e.idempotency_key = $2`,
      [carryId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  /** The append-only continuity tail of one carry, oldest first. */
  async listEventsForCarry(carryId: string): Promise<readonly SalesContinuityEventRecord[]> {
    const result = await this.db.query<CarryEventRow>(
      `SELECT e.event_id, e.carry_id, e.event_kind, e.detail, e.idempotency_key,
              e.recorded_actor, e.recorded_via, e.correlation_id, e.causation_id, e.recorded_at
       FROM sales_continuity_events e
       WHERE e.carry_id = $1
       ORDER BY e.recorded_at, e.event_id`,
      [carryId],
    );
    return result.rows.map(toEventRecord);
  }

  /**
   * The deterministic completion event key: the completion legs are
   * structural (not caller-logical) commands, so their §8 keys are
   * derived from the carry identity + the leg — a duplicate completion
   * attempt converges through findEventByIdempotencyKey with THIS key.
   */
  private completionEventKey(carryId: string, leg: string): string {
    return `${leg}:${carryId}`;
  }
}
