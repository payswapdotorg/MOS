/**
 * /content-assets persistence (the migration-053 tables).
 *
 * DB backstops (migration 053):
 *   - the asset-identity rows are append-oriented (no-DELETE; the
 *     version sequence fence hangs off them);
 *   - the version rows are immutable except the ONE sanctioned
 *     lifecycle state move (draft → materialized — the disciplined
 *     trigger advances the CAS version and rejects every other
 *     mutation); DELETE is rejected outright;
 *   - the lifecycle-event, quality-observation and ingredient tails are
 *     FULLY append-only (UPDATE/DELETE rejected outright);
 *   - the transformation rows admit exactly the terminal state moves
 *     (requested → completed with the output link; requested → failed
 *     with the bounded reason) — the disciplined trigger;
 *   - the tenant scope chains are trigger-fenced (asset: client ∈
 *     agency, workspace ∈ client; version: scope equals the asset's;
 *     transformation: client ∈ agency, workspace ∈ client) and every
 *     /evidence link is FK-anchored + same-Client trigger-fenced
 *     (cross-tenant evidence linkage is rejected by the database
 *     itself — surfaced here as the honest uniform NotFoundError);
 *   - every ingredient link's input version must belong to the SAME
 *     Client as the transformation (the migration-051 lineage posture).
 *
 * Every mutation that composes multiple facts takes the transaction
 * RUNNER as its first argument where composition matters (the
 * credentials-store pattern): a version registration (asset row +
 * version row + birth event) is ONE transaction; the materialization
 * move (state move + event) is ONE transaction; a transformation
 * completion (output asset + output version + derivation event +
 * observations + output link) is ONE transaction.
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  ContentAssetIdentityRecord,
  ContentAssetLifecycleEventRecord,
  ContentAssetLifecycleState,
  ContentAssetVersionRecord,
  ContentAssetsProvenance,
  ContentAssetsRecordedProvenance,
  ContentMediaKind,
  ContentQualityMetric,
  ContentQualityObservationRecord,
  ContentTransformationIngredientRecord,
  ContentTransformationRecord,
  ContentTransformationStatus,
  TransformationKind,
} from '../public.ts';

interface AssetRow extends DbRow {
  asset_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

interface VersionRow extends DbRow {
  version_id: string;
  asset_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  version: string | number;
  asset_ref: string;
  media_kind: string;
  display_name: string;
  content_type: string;
  lifecycle_state: string;
  object_key: string | null;
  object_digest: string | null;
  object_size: string | number | null;
  source_evidence_ref: string | null;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
  version_cas: string | number;
}

interface LifecycleEventRow extends DbRow {
  event_id: string;
  version_id: string;
  event_kind: string;
  from_state: string | null;
  to_state: string;
  reason: string;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface QualityObservationRow extends DbRow {
  observation_id: string;
  version_id: string;
  metric: string;
  metric_value_numeric: string | number | null;
  metric_value_text: string | null;
  observed_at: Date;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
}

interface TransformationRow extends DbRow {
  transformation_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string;
  transformation_kind: string;
  engine_id: string;
  status: string;
  execution_ref: string;
  parameters: Record<string, unknown>;
  output_spec: Record<string, unknown>;
  output_version_id: string | null;
  completed_at: Date | null;
  failure_reason: string | null;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
  version_cas: string | number;
}

interface IngredientRow extends DbRow {
  ingredient_id: string;
  transformation_id: string;
  input_version_id: string;
  input_asset_ref: string;
  position: number;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
}

const ASSET_SELECT = `
  SELECT asset_id, agency_id, client_id, workspace_id, created_by_actor,
         created_via, correlation_id, causation_id, created_at
  FROM content_assets
`;

const VERSION_SELECT = `
  SELECT version_id, asset_id, agency_id, client_id, workspace_id, version,
         asset_ref, media_kind, display_name, content_type, lifecycle_state,
         object_key, object_digest, object_size, source_evidence_ref,
         created_by_actor, created_via, correlation_id, causation_id,
         created_at, updated_at, version_cas
  FROM content_asset_versions
`;

const LIFECYCLE_EVENT_SELECT = `
  SELECT event_id, version_id, event_kind, from_state, to_state, reason,
         recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at
  FROM content_asset_lifecycle_events
`;

const QUALITY_OBSERVATION_SELECT = `
  SELECT observation_id, version_id, metric, metric_value_numeric, metric_value_text,
         observed_at, recorded_by_actor, recorded_via, correlation_id, causation_id
  FROM content_asset_quality_observations
`;

const TRANSFORMATION_SELECT = `
  SELECT transformation_id, agency_id, client_id, workspace_id, transformation_kind,
         engine_id, status, execution_ref, parameters, output_spec, output_version_id,
         completed_at, failure_reason, created_by_actor, created_via, correlation_id,
         causation_id, created_at, updated_at, version_cas
  FROM content_transformations
`;

const INGREDIENT_SELECT = `
  SELECT i.ingredient_id, i.transformation_id, i.input_version_id, i.input_asset_ref,
         i.position, i.recorded_by_actor, i.recorded_via, i.correlation_id,
         i.causation_id, i.created_at, v.version AS input_version_number
    FROM content_transformation_ingredients i
    JOIN content_asset_versions v ON v.version_id = i.input_version_id
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function recordedProvenance(
  actor: string,
  via: string,
  correlationId: string,
  causationId: string | null,
  recordedAt: Date,
): ContentAssetsRecordedProvenance {
  return {
    actor,
    recordedVia: via,
    correlationId,
    causationId,
    recordedAt: toIso(recordedAt),
  };
}

function toAssetIdentity(row: AssetRow): ContentAssetIdentityRecord {
  return {
    assetId: row.asset_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    provenance: recordedProvenance(
      row.created_by_actor, row.created_via, row.correlation_id, row.causation_id, row.created_at,
    ),
  };
}

function toVersionRecord(row: VersionRow): ContentAssetVersionRecord {
  return {
    versionId: row.version_id,
    assetId: row.asset_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    version: Number(row.version),
    assetRef: row.asset_ref,
    mediaKind: row.media_kind as ContentMediaKind,
    displayName: row.display_name,
    contentType: row.content_type,
    lifecycleState: row.lifecycle_state as ContentAssetLifecycleState,
    objectKey: row.object_key,
    objectDigest: row.object_digest,
    objectSize: row.object_size === null ? null : Number(row.object_size),
    sourceEvidenceRef: row.source_evidence_ref,
    provenance: recordedProvenance(
      row.created_by_actor, row.created_via, row.correlation_id, row.causation_id, row.created_at,
    ),
    versionCas: Number(row.version_cas),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toLifecycleEvent(row: LifecycleEventRow): ContentAssetLifecycleEventRecord {
  return {
    eventId: row.event_id,
    versionId: row.version_id,
    eventKind: row.event_kind as ContentAssetLifecycleEventRecord['eventKind'],
    fromState: row.from_state === null ? null : (row.from_state as ContentAssetLifecycleState),
    toState: row.to_state as ContentAssetLifecycleState,
    reason: row.reason,
    provenance: recordedProvenance(
      row.recorded_by_actor, row.recorded_via, row.correlation_id, row.causation_id, row.recorded_at,
    ),
  };
}

function toQualityObservation(row: QualityObservationRow): ContentQualityObservationRecord {
  return {
    observationId: row.observation_id,
    versionId: row.version_id,
    metric: row.metric as ContentQualityMetric,
    metricValueNumeric:
      row.metric_value_numeric === null ? null : Number(row.metric_value_numeric),
    metricValueText: row.metric_value_text,
    observedAt: toIso(row.observed_at),
    provenance: recordedProvenance(
      row.recorded_by_actor, row.recorded_via, row.correlation_id, row.causation_id, row.observed_at,
    ),
  };
}

function toTransformation(row: TransformationRow): ContentTransformationRecord {
  return {
    transformationId: row.transformation_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    transformationKind: row.transformation_kind as TransformationKind,
    engineId: row.engine_id,
    status: row.status as ContentTransformationStatus,
    executionRef: row.execution_ref,
    parameters: row.parameters,
    outputSpec: row.output_spec,
    outputVersionId: row.output_version_id,
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    failureReason: row.failure_reason,
    provenance: recordedProvenance(
      row.created_by_actor, row.created_via, row.correlation_id, row.causation_id, row.created_at,
    ),
    versionCas: Number(row.version_cas),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIngredient(row: IngredientRow, inputVersionNumber: number): ContentTransformationIngredientRecord {
  return {
    ingredientId: row.ingredient_id,
    transformationId: row.transformation_id,
    inputVersionId: row.input_version_id,
    inputAssetRef: row.input_asset_ref,
    inputVersionNumber,
    position: Number(row.position),
    provenance: recordedProvenance(
      row.recorded_by_actor, row.recorded_via, row.correlation_id, row.causation_id, row.created_at,
    ),
  };
}

/**
 * Classifies a PostgreSQL error as the migration-053 evidence
 * same-Client/FK rejection (the /evidence id-seam backstop firing) —
 * surfaced as the honest uniform NotFoundError, never a raw driver
 * error (no cross-tenant oracle).
 */
function isEvidenceBackstopViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content asset version') &&
    (message.includes('unknown source evidence') || message.includes('another client'))
  );
}

/**
 * Classifies a PostgreSQL error as a migration-053 CHECK/trigger
 * rejection on the version tables (the race backstop firing) —
 * surfaced as the honest ConflictError.
 */
function isVersionBackstopViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content_asset_versions_disciplined') ||
    message.includes('content_asset_versions_ref_fence') ||
    message.includes('content_asset_versions_asset_version_fence') ||
    message.includes('content_asset_version_materialization_shape') ||
    message.includes('content_asset_version_provenance_shape') ||
    message.includes('content_asset_versions_scope') ||
    message.includes('content_asset_versions_no_delete')
  );
}

/**
 * Classifies a PostgreSQL error as a migration-053 CHECK/trigger
 * rejection on the transformation tables.
 */
function isTransformationBackstopViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('content_transformations_disciplined') ||
    message.includes('content_transformations_execution_fence') ||
    message.includes('content_transformation_status_shape') ||
    message.includes('content_transformation_ingredients_pair_fence') ||
    message.includes('content_transformation_ingredients_position_fence') ||
    message.includes('content_transformation_ingredients_same_client') ||
    message.includes('content_transformations_scope') ||
    message.includes('content_transformations_no_delete')
  );
}

export interface RegisterVersionInput {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly assetId: string | null;
  readonly mediaKind: ContentMediaKind;
  readonly displayName: string;
  readonly contentType: string;
  readonly sourceEvidenceRef: string;
}

export interface DerivedVersionInput {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly mediaKind: ContentMediaKind;
  readonly displayName: string;
  readonly contentType: string;
  readonly objectKey: string;
  readonly objectDigest: string;
  readonly objectSize: number;
  readonly derivationReason: string;
}

export interface RequestTransformationRowInput {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly transformationKind: TransformationKind;
  readonly engineId: string;
  readonly executionRef: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSpec: Readonly<Record<string, unknown>>;
}

export interface CompleteTransformationInput {
  readonly transformationId: string;
  /** The PRE-MINTED output version id (the identity the /content-rights lineage links were recorded against). */
  readonly outputVersionId: string;
  readonly output: DerivedVersionInput;
}

export class ContentAssetsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------------
  // The asset identities + version records
  // -------------------------------------------------------------------------

  /** Resolves one logical asset identity (null when unknown). */
  async getAssetIdentity(assetId: string): Promise<ContentAssetIdentityRecord | null> {
    const result = await this.db.query<AssetRow>(
      `${ASSET_SELECT} WHERE asset_id = $1`,
      [assetId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAssetIdentity(row);
  }

  /**
   * Registers ONE asset version: the asset identity (created when the
   * input carries no assetId — the version-sequence fence locks the
   * asset row FOR UPDATE so concurrent registrations serialize), the
   * immutable version row (born 'draft', the minted ref) and the birth
   * event — ONE transaction, all-or-nothing.
   */
  async insertAssetVersion(
    input: RegisterVersionInput,
    provenance: ContentAssetsProvenance,
  ): Promise<ContentAssetVersionRecord> {
    const versionId = this.ids.newId();
    const assetRef = `ca:${versionId}`;
    const now = new Date(this.clock.nowIso());

    try {
      const insertedVersionId = await this.db.transaction(async (tx) => {
        let assetId = input.assetId;
        if (assetId === null) {
          assetId = this.ids.newId();
          await tx.query(
            `INSERT INTO content_assets
               (asset_id, agency_id, client_id, workspace_id, created_by_actor,
                created_via, correlation_id, causation_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              assetId,
              input.agencyId,
              input.clientId,
              input.workspaceId,
              provenance.actor,
              provenance.recordedVia,
              provenance.correlationId,
              provenance.causationId,
              now,
            ],
          );
        } else {
          // The version-sequence fence: lock the asset row so a
          // concurrent registration of the SAME asset serializes (the
          // (asset, version) UNIQUE fence is the backstop).
          const lock = await tx.query<AssetRow>(
            `${ASSET_SELECT} WHERE asset_id = $1 FOR UPDATE`,
            [assetId],
          );
          const assetRow = lock.rows[0];
          if (assetRow === undefined) {
            throw new NotFoundError('content_asset', assetId);
          }
          if (assetRow.client_id !== input.clientId || assetRow.agency_id !== input.agencyId) {
            // A foreign asset id is the same uniform 404 as an unknown
            // one (no cross-tenant oracle).
            throw new NotFoundError('content_asset', assetId);
          }
        }

        const nextVersion = await this.nextVersionNumber(tx, assetId);

        await tx.query(
          `INSERT INTO content_asset_versions
             (version_id, asset_id, agency_id, client_id, workspace_id, version,
              asset_ref, media_kind, display_name, content_type, lifecycle_state,
              object_key, object_digest, object_size, source_evidence_ref,
              created_by_actor, created_via, correlation_id, causation_id,
              created_at, updated_at, version_cas)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft',
                   NULL, NULL, NULL, $11, $12, $13, $14, $15, $16, $16, 1)`,
          [
            versionId,
            assetId,
            input.agencyId,
            input.clientId,
            input.workspaceId,
            nextVersion,
            assetRef,
            input.mediaKind,
            input.displayName,
            input.contentType,
            input.sourceEvidenceRef,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );

        await tx.query(
          `INSERT INTO content_asset_lifecycle_events
             (event_id, version_id, event_kind, from_state, to_state, reason,
              recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
           VALUES ($1, $2, 'registration', NULL, 'draft', $3, $4, $5, $6, $7, $8)`,
          [
            this.ids.newId(),
            versionId,
            `source version registered (asset ${assetId}, version ${nextVersion}, media ${input.mediaKind})`,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        return versionId;
      });

      const record = await this.getAssetVersion(insertedVersionId);
      if (record === null) {
        throw new Error(`content asset version ${insertedVersionId} could not be read back after registration`);
      }
      return record;
    } catch (error) {
      // The /evidence id-seam backstop: unknown/foreign evidence is the
      // uniform NotFoundError (no cross-tenant oracle).
      if (isEvidenceBackstopViolation(error)) {
        throw new NotFoundError('evidence', input.sourceEvidenceRef);
      }
      if (error instanceof NotFoundError || error instanceof ConflictError) throw error;
      if (isVersionBackstopViolation(error)) {
        throw new ConflictError(
          `the asset version registration was rejected by the frozen version discipline (the migration-053 CHECKs) — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  /** The next explicit version number of one asset (max + 1, under the caller's lock). */
  private async nextVersionNumber(
    tx: { query<T extends DbRow = DbRow>(text: string, params?: ReadonlyArray<unknown>): Promise<{ readonly rows: ReadonlyArray<T> }> },
    assetId: string,
  ): Promise<number> {
    const result = await tx.query<{ max_version: string | number | null }>(
      'SELECT COALESCE(MAX(version), 0) AS max_version FROM content_asset_versions WHERE asset_id = $1',
      [assetId],
    );
    const current = result.rows[0]?.max_version;
    return (current === null || current === undefined ? 0 : Number(current)) + 1;
  }

  /** Raw version by id (null when unknown). */
  async getAssetVersion(versionId: string): Promise<ContentAssetVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE version_id = $1`,
      [versionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }

  /** The version for one (client, ref) — null when unknown/foreign (the seam resolution). */
  async resolveAssetRef(clientId: string, assetRef: string): Promise<ContentAssetVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE asset_ref = $1 AND client_id = $2`,
      [assetRef, clientId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }

  /** The version for one explicit (asset, version) pair — null when unknown/foreign. */
  async getAssetVersionByNumber(
    clientId: string,
    assetId: string,
    version: number,
  ): Promise<ContentAssetVersionRecord | null> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE asset_id = $1 AND version = $2 AND client_id = $3`,
      [assetId, version, clientId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toVersionRecord(row);
  }

  /** The client's asset versions, newest first (bounded, server-chosen limit). */
  async listAssetVersionsForClient(clientId: string): Promise<readonly ContentAssetVersionRecord[]> {
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE client_id = $1 ORDER BY created_at DESC, version_id DESC LIMIT 200`,
      [clientId],
    );
    return result.rows.map(toVersionRecord);
  }

  /** The versions of one logical asset (explicit order, oldest first). Null when the asset is unknown. */
  async listVersionsOfAsset(assetId: string): Promise<readonly ContentAssetVersionRecord[] | null> {
    const identity = await this.getAssetIdentity(assetId);
    if (identity === null) return null;
    const result = await this.db.query<VersionRow>(
      `${VERSION_SELECT} WHERE asset_id = $1 ORDER BY version ASC`,
      [assetId],
    );
    return result.rows.map(toVersionRecord);
  }

  /**
   * THE MATERIALIZATION MOVE (draft → materialized): lock the version
   * row FOR UPDATE (the CAS seam — the losing side of a concurrent
   * materialization is the honest ConflictError), set the object
   * reference trio, advance the CAS version, and append the
   * materialization event — ONE transaction, all-or-nothing.
   */
  async materializeVersion(
    input: {
      readonly versionId: string;
      readonly objectKey: string;
      readonly objectDigest: string;
      readonly objectSize: number;
      readonly reason: string;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<
    | { readonly kind: 'missing' }
    | {
        readonly kind: 'ok';
        readonly record: ContentAssetVersionRecord;
        readonly event: ContentAssetLifecycleEventRecord;
      }
  > {
    const eventId = this.ids.newId();
    const now = new Date(this.clock.nowIso());

    try {
      const outcome = await this.db.transaction(async (tx) => {
        const lock = await tx.query<VersionRow>(
          `${VERSION_SELECT} WHERE version_id = $1 FOR UPDATE`,
          [input.versionId],
        );
        const lockedRow = lock.rows[0];
        if (lockedRow === undefined) {
          return null;
        }
        const current = toVersionRecord(lockedRow);
        if (current.lifecycleState !== 'draft') {
          throw new ConflictError(
            `content asset version ${input.versionId} is '${current.lifecycleState}' — only a DRAFT can be materialized (the immutable version discipline: a materialized or derived version never re-materializes)`,
          );
        }
        await tx.query(
          `UPDATE content_asset_versions
           SET lifecycle_state = 'materialized', object_key = $1, object_digest = $2,
               object_size = $3, updated_at = $4, version_cas = version_cas + 1
           WHERE version_id = $5 AND lifecycle_state = 'draft'`,
          [input.objectKey, input.objectDigest, input.objectSize, now, input.versionId],
        );
        await tx.query(
          `INSERT INTO content_asset_lifecycle_events
             (event_id, version_id, event_kind, from_state, to_state, reason,
              recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
           VALUES ($1, $2, 'materialization', 'draft', 'materialized', $3,
                   $4, $5, $6, $7, $8)`,
          [
            eventId,
            input.versionId,
            input.reason,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        return true;
      });
      if (outcome === null) {
        return { kind: 'missing' };
      }
      const record = await this.getAssetVersion(input.versionId);
      const event = await this.getLifecycleEvent(eventId);
      if (record === null || event === null) {
        throw new Error(`the materialization of version ${input.versionId} could not be read back`);
      }
      return { kind: 'ok', record, event };
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) throw error;
      if (isVersionBackstopViolation(error)) {
        throw new ConflictError(
          'the materialization was rejected by the frozen lifecycle discipline (the version changed concurrently or is not a draft) — no state was written',
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // The lifecycle event tail
  // -------------------------------------------------------------------------

  private async getLifecycleEvent(eventId: string): Promise<ContentAssetLifecycleEventRecord | null> {
    const result = await this.db.query<LifecycleEventRow>(
      `${LIFECYCLE_EVENT_SELECT} WHERE event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toLifecycleEvent(row);
  }

  /** The append-only lifecycle tail of one version (oldest first). Null when the version is unknown. */
  async listLifecycleEvents(versionId: string): Promise<readonly ContentAssetLifecycleEventRecord[] | null> {
    const version = await this.getAssetVersion(versionId);
    if (version === null) return null;
    const result = await this.db.query<LifecycleEventRow>(
      `${LIFECYCLE_EVENT_SELECT} WHERE version_id = $1 ORDER BY recorded_at ASC, event_id ASC`,
      [versionId],
    );
    return result.rows.map(toLifecycleEvent);
  }

  // -------------------------------------------------------------------------
  // The quality observations
  // -------------------------------------------------------------------------

  /** Appends ONE immutable quality observation. */
  async insertQualityObservation(
    input: {
      readonly versionId: string;
      readonly metric: ContentQualityMetric;
      readonly numericValue: number | null;
      readonly textValue: string | null;
    },
    provenance: ContentAssetsProvenance,
  ): Promise<ContentQualityObservationRecord> {
    const observationId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await this.db.query(
        `INSERT INTO content_asset_quality_observations
           (observation_id, version_id, metric, metric_value_numeric, metric_value_text,
            observed_at, recorded_by_actor, recorded_via, correlation_id, causation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          observationId,
          input.versionId,
          input.metric,
          input.numericValue,
          input.textValue,
          now,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('content_asset_quality_observations') && message.includes('foreign key')) {
        throw new NotFoundError('content_asset_version', input.versionId);
      }
      throw error;
    }
    const record = await this.getQualityObservation(observationId);
    if (record === null) {
      throw new Error(`quality observation ${observationId} could not be read back`);
    }
    return record;
  }

  private async getQualityObservation(
    observationId: string,
  ): Promise<ContentQualityObservationRecord | null> {
    const result = await this.db.query<QualityObservationRow>(
      `${QUALITY_OBSERVATION_SELECT} WHERE observation_id = $1`,
      [observationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toQualityObservation(row);
  }

  /** The append-only observation tail of one version (oldest first). Null when the version is unknown. */
  async listQualityObservations(
    versionId: string,
  ): Promise<readonly ContentQualityObservationRecord[] | null> {
    const version = await this.getAssetVersion(versionId);
    if (version === null) return null;
    const result = await this.db.query<QualityObservationRow>(
      `${QUALITY_OBSERVATION_SELECT} WHERE version_id = $1 ORDER BY observed_at ASC, observation_id ASC`,
      [versionId],
    );
    return result.rows.map(toQualityObservation);
  }

  // -------------------------------------------------------------------------
  // The transformation records + ingredient links
  // -------------------------------------------------------------------------

  /** Inserts one transformation row (born 'requested') + its immutable ingredient links. */
  async insertTransformation(
    input: RequestTransformationRowInput,
    ingredients: readonly {
      readonly version: ContentAssetVersionRecord;
    }[],
    provenance: ContentAssetsProvenance,
  ): Promise<ContentTransformationRecord> {
    const transformationId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO content_transformations
             (transformation_id, agency_id, client_id, workspace_id, transformation_kind,
              engine_id, status, execution_ref, parameters, output_spec,
              created_by_actor, created_via, correlation_id, causation_id,
              created_at, updated_at, version_cas)
           VALUES ($1, $2, $3, $4, $5, $6, 'requested', $7, $8::jsonb, $9::jsonb,
                   $10, $11, $12, $13, $14, $14, 1)`,
          [
            transformationId,
            input.agencyId,
            input.clientId,
            input.workspaceId,
            input.transformationKind,
            input.engineId,
            input.executionRef,
            JSON.stringify(input.parameters),
            JSON.stringify(input.outputSpec),
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        for (const [position, ingredient] of ingredients.entries()) {
          await tx.query(
            `INSERT INTO content_transformation_ingredients
               (ingredient_id, transformation_id, input_version_id, input_asset_ref,
                position, recorded_by_actor, recorded_via, correlation_id, causation_id, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              this.ids.newId(),
              transformationId,
              ingredient.version.versionId,
              ingredient.version.assetRef,
              position,
              provenance.actor,
              provenance.recordedVia,
              provenance.correlationId,
              provenance.causationId,
              now,
            ],
          );
        }
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) throw error;
      if (isTransformationBackstopViolation(error)) {
        throw new ConflictError(
          'the transformation request was rejected by the frozen transformation discipline (the migration-053 CHECKs)',
        );
      }
      throw error;
    }
    const record = await this.getTransformation(transformationId);
    if (record === null) {
      throw new Error(`transformation ${transformationId} could not be read back`);
    }
    return record;
  }

  /** Raw transformation by id (null when unknown). */
  async getTransformation(transformationId: string): Promise<ContentTransformationRecord | null> {
    const result = await this.db.query<TransformationRow>(
      `${TRANSFORMATION_SELECT} WHERE transformation_id = $1`,
      [transformationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toTransformation(row);
  }

  /** The client's transformations, newest first (bounded, server-chosen limit). */
  async listTransformationsForClient(
    clientId: string,
  ): Promise<readonly ContentTransformationRecord[]> {
    const result = await this.db.query<TransformationRow>(
      `${TRANSFORMATION_SELECT} WHERE client_id = $1 ORDER BY created_at DESC, transformation_id DESC LIMIT 200`,
      [clientId],
    );
    return result.rows.map(toTransformation);
  }

  /** The immutable ingredient links of one transformation (position order). Null when unknown. */
  async listTransformationIngredients(
    transformationId: string,
  ): Promise<readonly ContentTransformationIngredientRecord[] | null> {
    const transformation = await this.getTransformation(transformationId);
    if (transformation === null) return null;
    const result = await this.db.query<IngredientRow & { input_version_number: string | number }>(
      `${INGREDIENT_SELECT} WHERE i.transformation_id = $1 ORDER BY i.position ASC`,
      [transformationId],
    );
    return result.rows.map((row) => toIngredient(row, Number(row.input_version_number)));
  }

  /**
   * COMPLETES one transformation: the output asset identity + the output
   * version row (born 'derived', WITH its object reference and its
   * provenance shape), the derivation event, the engine's measured
   * output quality observations + the module's byte_size observation,
   * and the transformation's terminal state move (requested →
   * completed, the output version link set ONCE) — ONE transaction,
   * all-or-nothing. The caller has ALREADY stored the object bytes and
   * recorded the /content-rights lineage links (both idempotent /
   * convergent on replay).
   */
  async completeTransformation(
    input: CompleteTransformationInput,
    engineObservations: readonly {
      readonly metric: ContentQualityMetric;
      readonly numericValue: number | null;
      readonly textValue: string | null;
    }[],
    provenance: ContentAssetsProvenance,
  ): Promise<
    | { readonly kind: 'missing' }
    | {
        readonly kind: 'ok';
        readonly transformation: ContentTransformationRecord;
        readonly output: ContentAssetVersionRecord;
      }
  > {
    const now = new Date(this.clock.nowIso());
    try {
      const outcome = await this.db.transaction(async (tx) => {
        const lock = await tx.query<TransformationRow>(
          `${TRANSFORMATION_SELECT} WHERE transformation_id = $1 FOR UPDATE`,
          [input.transformationId],
        );
        const lockedRow = lock.rows[0];
        if (lockedRow === undefined) {
          return null;
        }
        const current = toTransformation(lockedRow);
        if (current.status !== 'requested') {
          throw new ConflictError(
            `transformation ${input.transformationId} is '${current.status}' — only a REQUESTED transformation can complete (terminal rows never reopen; a retry is a NEW transformation)`,
          );
        }

        // The output asset identity + the derived version row (the
        // PRE-MINTED output version id keeps the /content-rights
        // lineage links and this row the same identity even across a
        // retried completion).
        const outputAssetId = this.ids.newId();
        await tx.query(
          `INSERT INTO content_assets
             (asset_id, agency_id, client_id, workspace_id, created_by_actor,
              created_via, correlation_id, causation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            outputAssetId,
            input.output.agencyId,
            input.output.clientId,
            input.output.workspaceId,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        const outputVersionId = input.outputVersionId;
        await tx.query(
          `INSERT INTO content_asset_versions
             (version_id, asset_id, agency_id, client_id, workspace_id, version,
              asset_ref, media_kind, display_name, content_type, lifecycle_state,
              object_key, object_digest, object_size, source_evidence_ref,
              created_by_actor, created_via, correlation_id, causation_id,
              created_at, updated_at, version_cas)
           VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, 'derived',
                   $10, $11, $12, NULL, $13, $14, $15, $16, $17, $17, 1)`,
          [
            outputVersionId,
            outputAssetId,
            input.output.agencyId,
            input.output.clientId,
            input.output.workspaceId,
            `ca:${outputVersionId}`,
            input.output.mediaKind,
            input.output.displayName,
            input.output.contentType,
            input.output.objectKey,
            input.output.objectDigest,
            input.output.objectSize,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        await tx.query(
          `INSERT INTO content_asset_lifecycle_events
             (event_id, version_id, event_kind, from_state, to_state, reason,
              recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
           VALUES ($1, $2, 'derivation', NULL, 'derived', $3, $4, $5, $6, $7, $8)`,
          [
            this.ids.newId(),
            outputVersionId,
            input.output.derivationReason,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );

        // The output quality observations: the engine's measured facts
        // + the module's own byte_size observation (the object size IS
        // measurable by the module).
        const observations = [
          ...engineObservations,
          { metric: 'byte_size' as const, numericValue: input.output.objectSize, textValue: null },
        ];
        for (const observation of observations) {
          await tx.query(
            `INSERT INTO content_asset_quality_observations
               (observation_id, version_id, metric, metric_value_numeric, metric_value_text,
                observed_at, recorded_by_actor, recorded_via, correlation_id, causation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              this.ids.newId(),
              outputVersionId,
              observation.metric,
              observation.numericValue,
              observation.textValue,
              now,
              provenance.actor,
              provenance.recordedVia,
              provenance.correlationId,
              provenance.causationId,
            ],
          );
        }

        // The terminal state move: requested → completed, the output
        // version link set ONCE.
        await tx.query(
          `UPDATE content_transformations
           SET status = 'completed', output_version_id = $1, completed_at = $2,
               updated_at = $2, version_cas = version_cas + 1
           WHERE transformation_id = $3 AND status = 'requested'`,
          [outputVersionId, now, input.transformationId],
        );
        return { outputVersionId };
      });
      if (outcome === null) {
        return { kind: 'missing' };
      }
      const transformation = await this.getTransformation(input.transformationId);
      const output = await this.getAssetVersion(outcome.outputVersionId);
      if (transformation === null || output === null) {
        throw new Error(`the completion of transformation ${input.transformationId} could not be read back`);
      }
      return { kind: 'ok', transformation, output };
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) throw error;
      if (isTransformationBackstopViolation(error) || isVersionBackstopViolation(error)) {
        throw new ConflictError(
          'the transformation completion was rejected by the frozen discipline (the transformation changed concurrently or is not requested) — the completion is retriable',
        );
      }
      throw error;
    }
  }

  /**
   * FAILS one transformation (requested → failed, the bounded reason —
   * the honest terminal record; a retry is a NEW transformation).
   */
  async failTransformation(
    input: {
      readonly transformationId: string;
      readonly failureReason: string;
      readonly failedByActor: string;
      readonly failedVia: string;
      readonly correlationId: string;
      readonly causationId: string | null;
    },
  ): Promise<
    | { readonly kind: 'missing' }
    | { readonly kind: 'ok'; readonly transformation: ContentTransformationRecord }
    | { readonly kind: 'settled'; readonly transformation: ContentTransformationRecord }
  > {
    const now = new Date(this.clock.nowIso());
    try {
      const outcome = await this.db.transaction(async (tx) => {
        const lock = await tx.query<TransformationRow>(
          `${TRANSFORMATION_SELECT} WHERE transformation_id = $1 FOR UPDATE`,
          [input.transformationId],
        );
        const lockedRow = lock.rows[0];
        if (lockedRow === undefined) {
          return null;
        }
        const current = toTransformation(lockedRow);
        if (current.status !== 'requested') {
          return { settled: current };
        }
        await tx.query(
          `UPDATE content_transformations
           SET status = 'failed', failure_reason = $1, updated_at = $2,
               version_cas = version_cas + 1
           WHERE transformation_id = $3 AND status = 'requested'`,
          [input.failureReason, now, input.transformationId],
        );
        return { settled: null as ContentTransformationRecord | null };
      });
      if (outcome === null) {
        return { kind: 'missing' };
      }
      if (outcome.settled !== null) {
        return { kind: 'settled', transformation: outcome.settled };
      }
      const transformation = await this.getTransformation(input.transformationId);
      if (transformation === null) {
        throw new Error(`the failure record of transformation ${input.transformationId} could not be read back`);
      }
      return { kind: 'ok', transformation };
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof ConflictError) throw error;
      if (isTransformationBackstopViolation(error)) {
        throw new ConflictError(
          'the transformation failure was rejected by the frozen discipline — the record changed concurrently',
        );
      }
      throw error;
    }
  }
}
