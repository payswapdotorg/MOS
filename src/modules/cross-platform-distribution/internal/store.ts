/**
 * /cross-platform-distribution durable store (MKT-065 — the
 * content-rights/content-assets store precedent: thin, parameterized SQL
 * over the migration-055 tables; every critical invariant is
 * DB-enforced, the store adds the CAS guards and the row mappers).
 *
 * The store owns NO decision: the fan-out orchestration (gate
 * composition, capability validation, policy gate, the 056 submit) lives
 * in module.ts; this file persists plans, destinations, publications and
 * the append-only event tail with the disciplined CAS moves.
 */

import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  CrossPlatformDistributionRecordedProvenance,
  DistributionDestinationRecord,
  DistributionDestinationStatus,
  DistributionEventKind,
  DistributionEventRecord,
  DistributionPlanRecord,
  DistributionPlanState,
  DistributionPublicationRecord,
  DistributionTransformationPlan,
} from '../public.ts';
import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { SocialPublishRequest } from '../../social-accounts/public.ts';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PlanRow extends DbRow {
  plan_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  mission_id: string | null;
  source_asset_ref: string;
  source_version_id: string;
  transformation_plan: unknown;
  plan_state: string;
  input_digest: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface DestinationRow extends DbRow {
  destination_id: string;
  plan_id: string;
  client_id: string;
  position: number;
  social_account_id: string;
  platform_id: string;
  asset_ref: string;
  asset_version_id: string;
  target_format: string;
  publish_request: unknown;
  idempotency_key: string;
  destination_status: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface PublicationRow extends DbRow {
  publication_id: string;
  plan_id: string;
  destination_id: string;
  client_id: string;
  social_account_id: string;
  publish_attempt_id: string;
  idempotency_key: string;
  publish_state: string;
  failure_code: string | null;
  provider_publish_id: string | null;
  provider_content_id: string | null;
  published_at: Date | null;
  duplicate: boolean;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface EventRow extends DbRow {
  event_id: string;
  plan_id: string;
  destination_id: string | null;
  client_id: string;
  event_seq: number;
  event_kind: string;
  payload: unknown;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const PLAN_SELECT = `
  SELECT plan_id, agency_id, client_id, workspace_id, mission_id, source_asset_ref,
         source_version_id, transformation_plan, plan_state, input_digest,
         recorded_actor, recorded_via, correlation_id, causation_id, recorded_at,
         version, created_at, updated_at
  FROM distribution_plans
`;

const DESTINATION_SELECT = `
  SELECT destination_id, plan_id, client_id, position, social_account_id, platform_id,
         asset_ref, asset_version_id, target_format, publish_request, idempotency_key,
         destination_status, recorded_actor, recorded_via, correlation_id, causation_id,
         recorded_at, version, created_at, updated_at
  FROM distribution_destinations
`;

const PUBLICATION_SELECT = `
  SELECT publication_id, plan_id, destination_id, client_id, social_account_id,
         publish_attempt_id, idempotency_key, publish_state, failure_code,
         provider_publish_id, provider_content_id, published_at, duplicate,
         recorded_actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM distribution_publications
`;

const EVENT_SELECT = `
  SELECT event_id, plan_id, destination_id, client_id, event_seq, event_kind, payload,
         recorded_actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM distribution_events
`;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function provenanceOf(row: {
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}): CrossPlatformDistributionRecordedProvenance {
  return {
    actor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: toIso(row.recorded_at) ?? '',
  };
}

function toPlanRecord(row: PlanRow): DistributionPlanRecord {
  return {
    planId: row.plan_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    missionId: row.mission_id,
    sourceAssetRef: row.source_asset_ref,
    sourceVersionId: row.source_version_id,
    transformationPlan: (row.transformation_plan ?? {
      description: '',
      outputs: [],
    }) as DistributionTransformationPlan,
    planState: row.plan_state as DistributionPlanState,
    inputDigest: row.input_digest,
    provenance: provenanceOf(row),
    version: Number(row.version),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function toDestinationRecord(row: DestinationRow): DistributionDestinationRecord {
  return {
    destinationId: row.destination_id,
    planId: row.plan_id,
    clientId: row.client_id,
    position: Number(row.position),
    socialAccountId: row.social_account_id,
    platformId: row.platform_id,
    assetRef: row.asset_ref,
    assetVersionId: row.asset_version_id,
    targetFormat: row.target_format,
    publishRequest: (row.publish_request ?? {}) as SocialPublishRequest,
    idempotencyKey: row.idempotency_key,
    destinationStatus: row.destination_status as DistributionDestinationStatus,
    provenance: provenanceOf(row),
    version: Number(row.version),
    createdAt: toIso(row.created_at) ?? '',
    updatedAt: toIso(row.updated_at) ?? '',
  };
}

function toPublicationRecord(row: PublicationRow): DistributionPublicationRecord {
  return {
    publicationId: row.publication_id,
    planId: row.plan_id,
    destinationId: row.destination_id,
    clientId: row.client_id,
    socialAccountId: row.social_account_id,
    publishAttemptId: row.publish_attempt_id,
    idempotencyKey: row.idempotency_key,
    publishState: row.publish_state as DistributionPublicationRecord['publishState'],
    failureCode: row.failure_code,
    providerPublishId: row.provider_publish_id,
    providerContentId: row.provider_content_id,
    publishedAt: toIso(row.published_at),
    duplicate: Boolean(row.duplicate),
    provenance: provenanceOf(row),
  };
}

function toEventRecord(row: EventRow): DistributionEventRecord {
  return {
    eventId: row.event_id,
    planId: row.plan_id,
    destinationId: row.destination_id,
    clientId: row.client_id,
    eventSeq: Number(row.event_seq),
    eventKind: row.event_kind as DistributionEventKind,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    provenance: provenanceOf(row),
  };
}

/** The store's persisted-provenance input (recordedAt is server-derived here). */
export interface StoreProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class CrossPlatformDistributionStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // --- plans ---------------------------------------------------------------

  /** Inserts one plan record (born 'planned') inside a caller transaction. */
  async insertPlanTx(tx: DbTransaction, input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly missionId: string | null;
    readonly sourceAssetRef: string;
    readonly sourceVersionId: string;
    readonly transformationPlan: DistributionTransformationPlan;
    readonly inputDigest: string;
  }, provenance: StoreProvenance): Promise<DistributionPlanRecord> {
    const planId = this.ids.newId();
    const now = this.clock.nowIso();
    const result = await tx.query<PlanRow>(
      `INSERT INTO distribution_plans
         (plan_id, agency_id, client_id, workspace_id, mission_id, source_asset_ref,
          source_version_id, transformation_plan, plan_state, input_digest,
          recorded_actor, recorded_via, correlation_id, causation_id, recorded_at,
          version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'planned', $9, $10, $11, $12, $13, $14, 1, $15, $15)
       RETURNING *`,
      [
        planId,
        input.agencyId,
        input.clientId,
        input.workspaceId,
        input.missionId,
        input.sourceAssetRef,
        input.sourceVersionId,
        JSON.stringify(input.transformationPlan),
        input.inputDigest,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        new Date(now),
        new Date(now),
      ],
    );
    return toPlanRecord(result.rows[0]!);
  }

  /** Inserts one destination variant row (born 'planned') inside a caller transaction. */
  async insertDestinationTx(tx: DbTransaction, input: {
    readonly destinationId: string;
    readonly planId: string;
    readonly clientId: string;
    readonly position: number;
    readonly socialAccountId: string;
    readonly platformId: string;
    readonly assetRef: string;
    readonly assetVersionId: string;
    readonly targetFormat: string;
    readonly publishRequest: SocialPublishRequest;
    readonly idempotencyKey: string;
  }, provenance: StoreProvenance): Promise<DistributionDestinationRecord> {
    const destinationId = input.destinationId;
    const now = this.clock.nowIso();
    const result = await tx.query<DestinationRow>(
      `INSERT INTO distribution_destinations
         (destination_id, plan_id, client_id, position, social_account_id, platform_id,
          asset_ref, asset_version_id, target_format, publish_request, idempotency_key,
          destination_status, recorded_actor, recorded_via, correlation_id, causation_id,
          recorded_at, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'planned',
               $12, $13, $14, $15, $16, 1, $17, $17)
       RETURNING *`,
      [
        destinationId,
        input.planId,
        input.clientId,
        input.position,
        input.socialAccountId,
        input.platformId,
        input.assetRef,
        input.assetVersionId,
        input.targetFormat,
        JSON.stringify(input.publishRequest),
        input.idempotencyKey,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        new Date(now),
        new Date(now),
      ],
    );
    return toDestinationRecord(result.rows[0]!);
  }

  async getPlan(planId: string): Promise<DistributionPlanRecord | null> {
    const result = await this.db.query<PlanRow>(
      `${PLAN_SELECT} WHERE plan_id = $1`,
      [planId],
    );
    return result.rows[0] === undefined ? null : toPlanRecord(result.rows[0]);
  }

  async listPlansForClient(clientId: string, limit = 200): Promise<readonly DistributionPlanRecord[]> {
    const result = await this.db.query<PlanRow>(
      `${PLAN_SELECT} WHERE client_id = $1 ORDER BY created_at DESC, plan_id LIMIT $2`,
      [clientId, limit],
    );
    return result.rows.map(toPlanRecord);
  }

  /**
   * The disciplined plan state move (CAS): SELECT ... FOR UPDATE then the
   * guarded UPDATE. The losing side of a race is the honest
   * ConflictError, never a torn move (the migration-055 disciplined
   * trigger is the backstop).
   */
  async movePlanState(
    planId: string,
    toState: DistributionPlanState,
  ): Promise<DistributionPlanRecord> {
    return this.db.transaction(async (tx) => this.movePlanStateTx(tx, planId, toState));
  }

  async movePlanStateTx(
    tx: DbTransaction,
    planId: string,
    toState: DistributionPlanState,
  ): Promise<DistributionPlanRecord> {
    const locked = await tx.query<PlanRow>(
      `${PLAN_SELECT} WHERE plan_id = $1 FOR UPDATE`,
      [planId],
    );
    const current = locked.rows[0];
    if (current === undefined) {
      throw new NotFoundError('distribution_plan', planId);
    }
    const updated = await tx.query<PlanRow>(
      `UPDATE distribution_plans
         SET plan_state = $2, version = version + 1, updated_at = $3
       WHERE plan_id = $1 AND version = $4
       RETURNING *`,
      [planId, toState, new Date(this.clock.nowIso()), Number(current.version)],
    );
    if (updated.rows[0] === undefined) {
      throw new ConflictError(
        `distribution plan ${planId} state move to '${toState}' lost the CAS race — reload and retry`,
      );
    }
    return toPlanRecord(updated.rows[0]);
  }

  // --- destinations ----------------------------------------------------------

  async listDestinationsOfPlan(
    planId: string,
  ): Promise<readonly DistributionDestinationRecord[]> {
    const result = await this.db.query<DestinationRow>(
      `${DESTINATION_SELECT} WHERE plan_id = $1 ORDER BY position, destination_id`,
      [planId],
    );
    return result.rows.map(toDestinationRecord);
  }

  async getDestination(
    destinationId: string,
  ): Promise<DistributionDestinationRecord | null> {
    const result = await this.db.query<DestinationRow>(
      `${DESTINATION_SELECT} WHERE destination_id = $1`,
      [destinationId],
    );
    return result.rows[0] === undefined ? null : toDestinationRecord(result.rows[0]);
  }

  /**
   * The disciplined destination outcome move (CAS, row-locked): the
   * current-status pointer moves along the recorded outcome; the
   * migration-055 disciplined trigger is the backstop (never back to
   * 'planned'; identity immutable; version advances).
   */
  async moveDestinationStatus(
    destinationId: string,
    toStatus: DistributionDestinationStatus,
  ): Promise<DistributionDestinationRecord> {
    const locked = await this.db.query<DestinationRow>(
      `${DESTINATION_SELECT} WHERE destination_id = $1 FOR UPDATE`,
      [destinationId],
    );
    const current = locked.rows[0];
    if (current === undefined) {
      throw new NotFoundError('distribution_destination', destinationId);
    }
    if (current.destination_status === toStatus) {
      return toDestinationRecord(current); // the idempotent no-move
    }
    const updated = await this.db.query<DestinationRow>(
      `UPDATE distribution_destinations
         SET destination_status = $2, version = version + 1, updated_at = $3
       WHERE destination_id = $1 AND version = $4
       RETURNING *`,
      [destinationId, toStatus, new Date(this.clock.nowIso()), Number(current.version)],
    );
    if (updated.rows[0] === undefined) {
      throw new ConflictError(
        `distribution destination ${destinationId} outcome move to '${toStatus}' lost the CAS race — reload and retry`,
      );
    }
    return toDestinationRecord(updated.rows[0]);
  }

  // --- publications ----------------------------------------------------------

  /**
   * Inserts the per-destination publication link (idempotent by the
   * destination fence — an existing row is returned unchanged, never
   * rewritten; the table is append-only).
   */
  async insertPublication(input: {
    readonly planId: string;
    readonly destinationId: string;
    readonly clientId: string;
    readonly socialAccountId: string;
    readonly publishAttemptId: string;
    readonly idempotencyKey: string;
    readonly publishState: 'submitted' | 'accepted' | 'published' | 'failed' | 'restricted';
    readonly failureCode: string | null;
    readonly providerPublishId: string | null;
    readonly providerContentId: string | null;
    readonly publishedAt: string | null;
    readonly duplicate: boolean;
  }, provenance: StoreProvenance): Promise<DistributionPublicationRecord> {
    const existing = await this.db.query<PublicationRow>(
      `${PUBLICATION_SELECT} WHERE destination_id = $1`,
      [input.destinationId],
    );
    if (existing.rows[0] !== undefined) {
      return toPublicationRecord(existing.rows[0]);
    }
    const publicationId = this.ids.newId();
    const result = await this.db.query<PublicationRow>(
      `INSERT INTO distribution_publications
         (publication_id, plan_id, destination_id, client_id, social_account_id,
          publish_attempt_id, idempotency_key, publish_state, failure_code,
          provider_publish_id, provider_content_id, published_at, duplicate,
          recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16, $17, $18)
       ON CONFLICT (destination_id) DO NOTHING
       RETURNING *`,
      [
        publicationId,
        input.planId,
        input.destinationId,
        input.clientId,
        input.socialAccountId,
        input.publishAttemptId,
        input.idempotencyKey,
        input.publishState,
        input.failureCode,
        input.providerPublishId,
        input.providerContentId,
        input.publishedAt === null ? null : new Date(input.publishedAt),
        input.duplicate,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        new Date(this.clock.nowIso()),
      ],
    );
    if (result.rows[0] === undefined) {
      // The fence fired between the pre-check and the insert — converge.
      const converged = await this.db.query<PublicationRow>(
        `${PUBLICATION_SELECT} WHERE destination_id = $1`,
        [input.destinationId],
      );
      if (converged.rows[0] === undefined) {
        throw new ConflictError(
          `distribution publication for destination ${input.destinationId} could not be recorded`,
        );
      }
      return toPublicationRecord(converged.rows[0]);
    }
    return toPublicationRecord(result.rows[0]);
  }

  async listPublicationsOfPlan(
    planId: string,
  ): Promise<readonly DistributionPublicationRecord[]> {
    const result = await this.db.query<PublicationRow>(
      `${PUBLICATION_SELECT} WHERE plan_id = $1 ORDER BY destination_id`,
      [planId],
    );
    return result.rows.map(toPublicationRecord);
  }

  async getPublicationForDestination(
    destinationId: string,
  ): Promise<DistributionPublicationRecord | null> {
    const result = await this.db.query<PublicationRow>(
      `${PUBLICATION_SELECT} WHERE destination_id = $1`,
      [destinationId],
    );
    return result.rows[0] === undefined ? null : toPublicationRecord(result.rows[0]);
  }

  // --- the append-only event tail --------------------------------------------

  /**
   * Appends ONE event to the lineage tail (the gapless per-plan sequence
   * assigned under the plan row lock — the growth-missions discipline).
   * The append can share a caller transaction with a state move.
   */
  async appendEvent(input: {
    readonly planId: string;
    readonly clientId: string;
    readonly destinationId: string | null;
    readonly eventKind: DistributionEventKind;
    readonly payload: Readonly<Record<string, unknown>>;
  }, provenance: StoreProvenance): Promise<DistributionEventRecord> {
    return this.db.transaction(async (tx) =>
      this.appendEventTx(tx, input, provenance),
    );
  }

  async appendEventTx(
    tx: DbTransaction,
    input: {
      readonly planId: string;
      readonly clientId: string;
      readonly destinationId: string | null;
      readonly eventKind: DistributionEventKind;
      readonly payload: Readonly<Record<string, unknown>>;
    },
    provenance: StoreProvenance,
  ): Promise<DistributionEventRecord> {
    // Lock the plan row, then assign the gapless sequence.
    const locked = await tx.query<PlanRow>(
      `SELECT plan_id FROM distribution_plans WHERE plan_id = $1 FOR UPDATE`,
      [input.planId],
    );
    if (locked.rows[0] === undefined) {
      throw new NotFoundError('distribution_plan', input.planId);
    }
    const next = await tx.query<{ next_seq: string }>(
      `SELECT COALESCE(MAX(event_seq), 0) + 1 AS next_seq FROM distribution_events WHERE plan_id = $1`,
      [input.planId],
    );
    const eventSeq = Number(next.rows[0]!.next_seq);
    const eventId = this.ids.newId();
    const result = await tx.query<EventRow>(
      `INSERT INTO distribution_events
         (event_id, plan_id, destination_id, client_id, event_seq, event_kind, payload,
          recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        eventId,
        input.planId,
        input.destinationId,
        input.clientId,
        eventSeq,
        input.eventKind,
        JSON.stringify(input.payload),
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        new Date(this.clock.nowIso()),
      ],
    );
    return toEventRecord(result.rows[0]!);
  }

  async listEventsOfPlan(planId: string): Promise<readonly DistributionEventRecord[]> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE plan_id = $1 ORDER BY event_seq, event_id`,
      [planId],
    );
    return result.rows.map(toEventRecord);
  }
}
