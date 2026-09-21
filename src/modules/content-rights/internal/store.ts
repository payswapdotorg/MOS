/**
 * /content-rights persistence (the migration-051 tables).
 *
 * DB backstops (migration 051):
 *   - the rights-record rows are append-oriented with a disciplined
 *     current-state pointer: the ONLY sanctioned UPDATE moves `state`
 *     along the CHECK-fenced frozen transition table (and advances
 *     updated_at + the CAS version in the same statement); every other
 *     column is immutable and DELETE is rejected outright;
 *   - the transition-event tail is FULLY append-only (UPDATE/DELETE
 *     rejected outright — history is never rewritten in place) with the
 *     (from_state, to_state, event_kind) triple CHECK-fenced to the
 *     frozen transition table and clearance_id REQUIRED exactly for
 *     human_clearance rows;
 *   - the clearance rows are FULLY append-only;
 *   - the permission-scope rows are FULLY append-only (the newest row
 *     per (rights record, platform) is the effective permission — scope
 *     changes are NEW rows, the tail stays auditable);
 *   - the lineage links are FULLY append-only (immutable composition
 *     facts) with the unique (client, composite, ingredient) fence and
 *     the no-self-link CHECK;
 *   - the tenant scope chain is trigger-fenced on every insert/update
 *     (the client must belong to the agency; the workspace to the
 *     client) and every /evidence link is FK-anchored + same-Client
 *     trigger-fenced (cross-tenant evidence linkage is rejected by the
 *     database itself — the migration-023 job_outcomes pattern).
 *
 * Every mutation that composes multiple facts takes the transaction
 * RUNNER as its first argument where composition matters (the
 * credentials-store pattern): the transition (event row + state move +
 * clearance row) is ONE transaction, all-or-nothing.
 */

import { ConflictError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ContentRightsAssetKind,
  ContentRightsClearanceRecord,
  ContentRightsEventKind,
  ContentRightsEventRecord,
  ContentRightsLineageRecord,
  ContentRightsPermission,
  ContentRightsPermissionRecord,
  ContentRightsProvenance,
  ContentRightsRecord,
  ContentRightsState,
} from '../public.ts';

interface RightsRow extends DbRow {
  rights_record_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  content_asset_ref: string;
  asset_kind: string;
  state: string;
  source_evidence_ref: string;
  licence_label: string | null;
  licence_evidence_ref: string | null;
  valid_until: Date | null;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

interface EventRow extends DbRow {
  event_id: string;
  rights_record_id: string;
  from_state: string;
  to_state: string;
  event_kind: string;
  reason: string;
  clearance_id: string | null;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface ClearanceRow extends DbRow {
  clearance_id: string;
  rights_record_id: string;
  cleared_by_actor: string;
  cleared_via: string;
  rationale: string;
  evidence_ref: string | null;
  correlation_id: string;
  causation_id: string | null;
  cleared_at: Date;
}

interface PermissionRow extends DbRow {
  permission_id: string;
  rights_record_id: string;
  platform_key: string;
  permission: string;
  evidence_ref: string;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface LineageRow extends DbRow {
  lineage_link_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  composite_asset_ref: string;
  ingredient_asset_ref: string;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

const RIGHTS_SELECT = `
  SELECT rights_record_id, agency_id, client_id, workspace_id, content_asset_ref,
         asset_kind, state, source_evidence_ref, licence_label, licence_evidence_ref,
         valid_until, created_by_actor, created_via, correlation_id, causation_id,
         created_at, updated_at, version
  FROM content_rights_records
`;

const EVENT_SELECT = `
  SELECT event_id, rights_record_id, from_state, to_state, event_kind, reason,
         clearance_id, recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM content_rights_events
`;

const PERMISSION_SELECT = `
  SELECT permission_id, rights_record_id, platform_key, permission, evidence_ref,
         recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM content_rights_permissions
`;

const LINEAGE_SELECT = `
  SELECT lineage_link_id, agency_id, client_id, workspace_id, composite_asset_ref,
         ingredient_asset_ref, recorded_by_actor, recorded_via, correlation_id,
         causation_id, created_at
  FROM content_rights_lineage_links
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toRightsRecord(row: RightsRow): ContentRightsRecord {
  return {
    rightsRecordId: row.rights_record_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    contentAssetRef: row.content_asset_ref,
    assetKind: row.asset_kind as ContentRightsAssetKind,
    state: row.state as ContentRightsState,
    sourceEvidenceRef: row.source_evidence_ref,
    licenceLabel: row.licence_label,
    licenceEvidenceRef: row.licence_evidence_ref,
    validUntil: row.valid_until === null ? null : toIso(row.valid_until),
    provenance: {
      actor: row.created_by_actor,
      recordedVia: row.created_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.created_at),
    },
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toEventRecord(row: EventRow): ContentRightsEventRecord {
  return {
    eventId: row.event_id,
    rightsRecordId: row.rights_record_id,
    fromState: row.from_state as ContentRightsState,
    toState: row.to_state as ContentRightsState,
    eventKind: row.event_kind as ContentRightsEventKind,
    reason: row.reason,
    clearanceId: row.clearance_id,
    provenance: {
      actor: row.recorded_by_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

function toClearanceRecord(row: ClearanceRow): ContentRightsClearanceRecord {
  return {
    clearanceId: row.clearance_id,
    rightsRecordId: row.rights_record_id,
    clearedByActor: row.cleared_by_actor,
    clearedVia: row.cleared_via,
    rationale: row.rationale,
    evidenceRef: row.evidence_ref,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    clearedAt: toIso(row.cleared_at),
  };
}

function toPermissionRecord(row: PermissionRow): ContentRightsPermissionRecord {
  return {
    permissionId: row.permission_id,
    rightsRecordId: row.rights_record_id,
    platformKey: row.platform_key,
    permission: row.permission as ContentRightsPermission,
    evidenceRef: row.evidence_ref,
    provenance: {
      actor: row.recorded_by_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

function toLineageRecord(row: LineageRow): ContentRightsLineageRecord {
  return {
    lineageLinkId: row.lineage_link_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    compositeAssetRef: row.composite_asset_ref,
    ingredientAssetRef: row.ingredient_asset_ref,
    provenance: {
      actor: row.recorded_by_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.created_at),
    },
  };
}

/**
 * Classifies a PostgreSQL error as the (client, asset ref) UNIQUE fence
 * hit — the duplicate-registration detection seam.
 */
function isRightsFenceViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content_rights_records_asset_fence') ||
    (message.includes('duplicate key value violates unique constraint') &&
      message.includes('content_rights_records'))
  );
}

/**
 * Classifies a PostgreSQL error as the lineage (client, composite,
 * ingredient) UNIQUE fence hit — the duplicate-link detection seam.
 */
function isLineageFenceViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content_rights_lineage_links_pair_fence') ||
    (message.includes('duplicate key value violates unique constraint') &&
      message.includes('content_rights_lineage_links'))
  );
}

export class ContentRightsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------------
  // The rights records
  // -------------------------------------------------------------------------

  /** Inserts one rights record (born 'unknown'). The unique (client, asset ref) fence backstops idempotency. */
  async insertRightsRecord(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly contentAssetRef: string;
      readonly assetKind: ContentRightsAssetKind;
      readonly sourceEvidenceRef: string;
      readonly licenceLabel: string | null;
      readonly licenceEvidenceRef: string | null;
      readonly validUntil: string | null;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsRecord> {
    const rightsRecordId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await this.db.query(
        `INSERT INTO content_rights_records
           (rights_record_id, agency_id, client_id, workspace_id, content_asset_ref,
            asset_kind, state, source_evidence_ref, licence_label, licence_evidence_ref,
            valid_until, created_by_actor, created_via, correlation_id, causation_id,
            created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, 'unknown', $7, $8, $9, $10,
                 $11, $12, $13, $14, $15, $15, 1)`,
        [
          rightsRecordId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.contentAssetRef,
          input.assetKind,
          input.sourceEvidenceRef,
          input.licenceLabel,
          input.licenceEvidenceRef,
          input.validUntil === null ? null : new Date(input.validUntil),
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      if (isRightsFenceViolation(error)) {
        throw new ConflictError(
          `a rights record already exists for content asset '${input.contentAssetRef}' in this client — one record per asset reference (a re-registered asset is a NEW asset version, which is a NEW reference)`,
        );
      }
      throw error;
    }
    const created = await this.getRightsRecord(rightsRecordId);
    if (created === null) {
      throw new Error(`inserted rights record ${rightsRecordId} could not be read back`);
    }
    return created;
  }

  async getRightsRecord(rightsRecordId: string): Promise<ContentRightsRecord | null> {
    const result = await this.db.query<RightsRow>(
      `${RIGHTS_SELECT} WHERE rights_record_id = $1`,
      [rightsRecordId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRightsRecord(row);
  }

  async getRightsRecordForAsset(
    clientId: string,
    contentAssetRef: string,
  ): Promise<ContentRightsRecord | null> {
    const result = await this.db.query<RightsRow>(
      `${RIGHTS_SELECT} WHERE client_id = $1 AND content_asset_ref = $2`,
      [clientId, contentAssetRef],
    );
    const row = result.rows[0];
    return row === undefined ? null : toRightsRecord(row);
  }

  async listRightsRecordsForClient(clientId: string): Promise<readonly ContentRightsRecord[]> {
    const result = await this.db.query<RightsRow>(
      `${RIGHTS_SELECT} WHERE client_id = $1
       ORDER BY created_at DESC, rights_record_id DESC`,
      [clientId],
    );
    return result.rows.map(toRightsRecord);
  }

  // -------------------------------------------------------------------------
  // The transition (event row + state move + clearance row — ONE transaction)
  // -------------------------------------------------------------------------

  /**
   * Records the transition atomically: SELECT ... FOR UPDATE the record
   * (the CAS seam), append the event row, create the clearance row when
   * human_clearance, and move the state column — all-or-nothing. The
   * caller has ALREADY validated the (from, to, kind) triple against the
   * frozen table; the migration-051 CHECKs are the race backstop.
   * Returns kind 'missing' when the record does not exist (the module
   * surfaces the uniform NotFoundError).
   */
  async recordTransition(
    input: {
      readonly rightsRecordId: string;
      readonly eventKind: ContentRightsEventKind;
      readonly toState: ContentRightsState;
      readonly reason: string;
      readonly clearance: {
        readonly rationale: string;
        readonly evidenceRef: string | null;
      } | null;
    },
    provenance: ContentRightsProvenance,
  ): Promise<
    | { readonly kind: 'missing' }
    | {
        readonly kind: 'ok';
        readonly record: ContentRightsRecord;
        readonly event: ContentRightsEventRecord;
        readonly clearance: ContentRightsClearanceRecord | null;
      }
  > {
    const eventId = this.ids.newId();
    const now = new Date(this.clock.nowIso());

    const locked = await this.db.transaction(async (tx) => {
      // THE CAS SEAM: lock the record row and read the live state. The
      // losing side of a concurrent transition surfaces the honest
      // ConflictError — history can never tear.
      const lock = await tx.query<RightsRow>(
        `${RIGHTS_SELECT} WHERE rights_record_id = $1 FOR UPDATE`,
        [input.rightsRecordId],
      );
      const lockedRow = lock.rows[0];
      if (lockedRow === undefined) {
        return null;
      }
      const current = toRightsRecord(lockedRow);
      const expectedFrom = current.state;

      let clearanceId: string | null = null;
      if (input.eventKind === 'human_clearance' && input.clearance !== null) {
        clearanceId = this.ids.newId();
        await tx.query(
          `INSERT INTO content_rights_clearances
             (clearance_id, rights_record_id, cleared_by_actor, cleared_via, rationale,
              evidence_ref, correlation_id, causation_id, cleared_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            clearanceId,
            input.rightsRecordId,
            provenance.actor,
            provenance.recordedVia,
            input.clearance.rationale,
            input.clearance.evidenceRef,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
      }

      await tx.query(
        `INSERT INTO content_rights_events
           (event_id, rights_record_id, from_state, to_state, event_kind, reason,
            clearance_id, recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          eventId,
          input.rightsRecordId,
          expectedFrom,
          input.toState,
          input.eventKind,
          input.reason,
          clearanceId,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );

      await tx.query(
        `UPDATE content_rights_records
         SET state = $1, updated_at = $2, version = version + 1
         WHERE rights_record_id = $3 AND state = $4`,
        [input.toState, now, input.rightsRecordId, expectedFrom],
      );

      return { eventId, clearanceId };
    });

    if (locked === null) {
      return { kind: 'missing' };
    }

    const record = await this.getRightsRecord(input.rightsRecordId);
    if (record === null) {
      throw new Error(`rights record ${input.rightsRecordId} could not be read back after its transition`);
    }
    const event = await this.getEvent(locked.eventId);
    if (event === null) {
      throw new Error(`transition event ${locked.eventId} could not be read back`);
    }
    const clearance =
      locked.clearanceId === null ? null : await this.getClearance(locked.clearanceId);
    return { kind: 'ok', record, event, clearance };
  }

  private async getEvent(eventId: string): Promise<ContentRightsEventRecord | null> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toEventRecord(row);
  }

  async listRightsEvents(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsEventRecord[] | null> {
    const exists = await this.getRightsRecord(rightsRecordId);
    if (exists === null) return null;
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE rights_record_id = $1
       ORDER BY recorded_at, event_id`,
      [rightsRecordId],
    );
    return result.rows.map(toEventRecord);
  }

  // -------------------------------------------------------------------------
  // The permission-scope tail
  // -------------------------------------------------------------------------

  async insertPermission(
    input: {
      readonly rightsRecordId: string;
      readonly platformKey: string;
      readonly permission: ContentRightsPermission;
      readonly evidenceRef: string;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsPermissionRecord> {
    const permissionId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    await this.db.query(
      `INSERT INTO content_rights_permissions
         (permission_id, rights_record_id, platform_key, permission, evidence_ref,
          recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        permissionId,
        input.rightsRecordId,
        input.platformKey,
        input.permission,
        input.evidenceRef,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        now,
      ],
    );
    const created = await this.db.query<PermissionRow>(
      `${PERMISSION_SELECT} WHERE permission_id = $1`,
      [permissionId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted permission row ${permissionId} could not be read back`);
    }
    return toPermissionRecord(row);
  }

  async listPlatformPermissions(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsPermissionRecord[] | null> {
    const exists = await this.getRightsRecord(rightsRecordId);
    if (exists === null) return null;
    const result = await this.db.query<PermissionRow>(
      `${PERMISSION_SELECT} WHERE rights_record_id = $1
       ORDER BY recorded_at, permission_id`,
      [rightsRecordId],
    );
    return result.rows.map(toPermissionRecord);
  }

  /**
   * The EFFECTIVE permission for one (record, destination platform):
   * the NEWEST row (scope changes are NEW rows — append-oriented
   * revision, the full tail stays auditable). Null when no row exists
   * (the gate's `unspecified` fail-closed posture).
   */
  async getEffectivePermission(
    rightsRecordId: string,
    platformKey: string,
  ): Promise<ContentRightsPermission | null> {
    const result = await this.db.query<PermissionRow>(
      `${PERMISSION_SELECT}
       WHERE rights_record_id = $1 AND platform_key = $2
       ORDER BY recorded_at DESC, permission_id DESC
       LIMIT 1`,
      [rightsRecordId, platformKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : (row.permission as ContentRightsPermission);
  }

  // -------------------------------------------------------------------------
  // The lineage links
  // -------------------------------------------------------------------------

  async insertLineageLink(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly compositeAssetRef: string;
      readonly ingredientAssetRef: string;
    },
    provenance: ContentRightsProvenance,
  ): Promise<ContentRightsLineageRecord> {
    const lineageLinkId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await this.db.query(
        `INSERT INTO content_rights_lineage_links
           (lineage_link_id, agency_id, client_id, workspace_id, composite_asset_ref,
            ingredient_asset_ref, recorded_by_actor, recorded_via, correlation_id,
            causation_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          lineageLinkId,
          input.agencyId,
          input.clientId,
          input.workspaceId,
          input.compositeAssetRef,
          input.ingredientAssetRef,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      if (isLineageFenceViolation(error)) {
        throw new ConflictError(
          `the lineage link ${input.compositeAssetRef} -> ${input.ingredientAssetRef} already exists in this client — composition facts are immutable (one link per (composite, ingredient) pair)`,
        );
      }
      throw error;
    }
    const created = await this.db.query<LineageRow>(
      `${LINEAGE_SELECT} WHERE lineage_link_id = $1`,
      [lineageLinkId],
    );
    const row = created.rows[0];
    if (row === undefined) {
      throw new Error(`inserted lineage link ${lineageLinkId} could not be read back`);
    }
    return toLineageRecord(row);
  }

  async listLineageLinks(
    clientId: string,
    compositeAssetRef: string,
  ): Promise<readonly ContentRightsLineageRecord[]> {
    const result = await this.db.query<LineageRow>(
      `${LINEAGE_SELECT} WHERE client_id = $1 AND composite_asset_ref = $2
       ORDER BY created_at, lineage_link_id`,
      [clientId, compositeAssetRef],
    );
    return result.rows.map(toLineageRecord);
  }

  // -------------------------------------------------------------------------
  // The clearance tail
  // -------------------------------------------------------------------------

  private async getClearance(clearanceId: string): Promise<ContentRightsClearanceRecord | null> {
    const result = await this.db.query<ClearanceRow>(
      `SELECT clearance_id, rights_record_id, cleared_by_actor, cleared_via, rationale,
              evidence_ref, correlation_id, causation_id, cleared_at
       FROM content_rights_clearances WHERE clearance_id = $1`,
      [clearanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toClearanceRecord(row);
  }

  async listClearances(
    rightsRecordId: string,
  ): Promise<readonly ContentRightsClearanceRecord[] | null> {
    const exists = await this.getRightsRecord(rightsRecordId);
    if (exists === null) return null;
    const result = await this.db.query<ClearanceRow>(
      `SELECT clearance_id, rights_record_id, cleared_by_actor, cleared_via, rationale,
              evidence_ref, correlation_id, causation_id, cleared_at
       FROM content_rights_clearances WHERE rights_record_id = $1
       ORDER BY cleared_at, clearance_id`,
      [rightsRecordId],
    );
    return result.rows.map(toClearanceRecord);
  }
}
