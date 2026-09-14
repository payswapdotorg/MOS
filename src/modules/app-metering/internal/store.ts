/**
 * /app-metering module store (MKT-052 — the append-only meter event tail
 * + the rebuildable rollup projection, the 038/042 house style).
 *
 * Pure guards + §8-style create fingerprints + the deterministic
 * collection command keys + the SQL store over the migration-044 tables.
 * The meter event tail is APPEND-ONLY: the database triggers reject
 * UPDATE and DELETE outright, and every insert is fenced by the §8
 * idempotency key (one logical metering command per workspace) and — for
 * collected sources — the at-most-once (source_kind, source_id,
 * dimension) partial unique fence. The rollup table is a DERIVED
 * projection replaced atomically by the disclosed recompute.
 */

import { createHash } from 'node:crypto';
import { IdempotencyConflictError, InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { AppMeteringDimension } from '../../apps/public.ts';
import type {
  AppMeterEventRecord,
  AppMeteringSourceKind,
  AppMeteringUnit,
} from '../public.ts';
import { APP_METERING_COLLECT_KEY_PREFIX, APP_METERING_INGESTIBLE_DIMENSIONS } from '../public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const STATE_NAMESPACE_PATTERN = /^app:[a-z][a-z0-9-]{1,62}:[a-z][a-z0-9-]{1,30}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_PROVENANCE_LABEL_LENGTH = 100;
const MAX_QUANTITY = 1_000_000_000_000_000;

/**
 * Material-shaped keys that can never appear in any metering payload
 * (the §21 secret-leak backstop at the module boundary — the migration
 * 044 CHECK columns enforce the identical posture at the storage layer).
 */
export const APP_METERING_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialValue',
  'secretValue',
] as const;

// ---------------------------------------------------------------------------
// Input guards (pure — the single semantic enforcement points)
// ---------------------------------------------------------------------------

/**
 * Validates the collection command input (the frozen shape behind every
 * server-side caller): the well-formed workspace id. Pure.
 */
export function assertValidWorkspaceMeteringInput(input: {
  readonly workspaceId?: unknown;
}): void {
  if (typeof input.workspaceId !== 'string' || !UUID_PATTERN.test(input.workspaceId)) {
    throw new InvalidRequestError('workspaceId: must be a canonical workspace id (uuid)');
  }
}

/**
 * Validates the usage-observation command input (the frozen shape behind
 * the module-level ingestion surface): well-formed workspace/app ids, an
 * INGESTIBLE dimension (the three runtime-usage dimensions — the
 * installations/invocations dimensions are collection-only), the bounded
 * positive integer quantity, the optional premium-capability label and
 * bounded app-state namespace (payload-shape-fenced per dimension), the
 * canonical source invocation reference and the §8 idempotency key
 * WITHOUT the reserved 'collect:' prefix. Pure.
 */
export function assertValidObservationInput(input: {
  readonly workspaceId?: unknown;
  readonly appKey?: unknown;
  readonly dimension?: unknown;
  readonly quantity?: unknown;
  readonly capability?: unknown;
  readonly stateNamespace?: unknown;
  readonly sourceInvocationId?: unknown;
  readonly idempotencyKey?: unknown;
}): void {
  if (typeof input.workspaceId !== 'string' || !UUID_PATTERN.test(input.workspaceId)) {
    throw new InvalidRequestError('workspaceId: must be a canonical workspace id (uuid)');
  }
  if (typeof input.appKey !== 'string' || !KEY_PATTERN.test(input.appKey)) {
    throw new InvalidRequestError(
      'appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter',
    );
  }
  if (
    typeof input.dimension !== 'string' ||
    !(APP_METERING_INGESTIBLE_DIMENSIONS as readonly string[]).includes(input.dimension)
  ) {
    throw new InvalidRequestError(
      `dimension: must be one of the ingestible usage dimensions (${APP_METERING_INGESTIBLE_DIMENSIONS.join(', ')}) — the installations/invocations dimensions are collection-only (they meter the real ledger rows exactly once per source)`,
    );
  }
  if (
    typeof input.quantity !== 'number' ||
    !Number.isInteger(input.quantity) ||
    input.quantity < 1 ||
    input.quantity > MAX_QUANTITY
  ) {
    throw new InvalidRequestError(
      `quantity: must be an integer in [1..${MAX_QUANTITY}] (the observed usage amount)`,
    );
  }
  if (input.dimension === 'premium-capabilities') {
    if (typeof input.capability !== 'string' || !CAPABILITY_PATTERN.test(input.capability)) {
      throw new InvalidRequestError(
        'capability: required for premium-capabilities observations — a bounded lowercase capability label',
      );
    }
  } else if (input.capability !== null && input.capability !== undefined) {
    throw new InvalidRequestError(
      'capability: only premium-capabilities observations carry a capability label',
    );
  }
  if (input.stateNamespace !== null && input.stateNamespace !== undefined) {
    if (input.dimension !== 'data-volume') {
      throw new InvalidRequestError(
        'stateNamespace: only data-volume observations may carry a bounded app-state namespace',
      );
    }
    if (typeof input.stateNamespace !== 'string' || !STATE_NAMESPACE_PATTERN.test(input.stateNamespace)) {
      throw new InvalidRequestError(
        'stateNamespace: must match app:<app key>:<local> (a declared bounded app-state namespace)',
      );
    }
  }
  if (
    typeof input.sourceInvocationId !== 'string' ||
    !UUID_PATTERN.test(input.sourceInvocationId)
  ) {
    throw new InvalidRequestError(
      'sourceInvocationId: must be the canonical invocation record id the usage was observed in (uuid)',
    );
  }
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length < 1 ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new InvalidRequestError(
      `idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }
  if (input.idempotencyKey.startsWith(APP_METERING_COLLECT_KEY_PREFIX)) {
    throw new InvalidRequestError(
      `idempotencyKey: the '${APP_METERING_COLLECT_KEY_PREFIX}' prefix is reserved for the server-derived collection command keys`,
    );
  }
}

/**
 * Validates the SERVER-DERIVED provenance block (the /app-installs
 * assertValidAppInstallProvenance precedent — the block arrives as a
 * separate module-API argument so no DTO can feed it structurally).
 * Pure.
 */
export function assertValidMeteringProvenance(provenance: {
  readonly actor?: unknown;
  readonly recordedVia?: unknown;
  readonly correlationId?: unknown;
  readonly causationId?: unknown;
}): void {
  const label = (field: string, value: unknown): void => {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > MAX_PROVENANCE_LABEL_LENGTH
    ) {
      throw new InvalidRequestError(
        `${field}: must be 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
      );
    }
  };
  label('provenance.actor', provenance.actor);
  label('provenance.recordedVia', provenance.recordedVia);
  label('provenance.correlationId', provenance.correlationId);
  if (
    provenance.causationId !== null &&
    provenance.causationId !== undefined &&
    (typeof provenance.causationId !== 'string' ||
      provenance.causationId.length < 1 ||
      provenance.causationId.length > MAX_PROVENANCE_LABEL_LENGTH)
  ) {
    throw new InvalidRequestError(
      `provenance.causationId: must be null or 1-${MAX_PROVENANCE_LABEL_LENGTH} characters`,
    );
  }
}

// ---------------------------------------------------------------------------
// The §8-style create fingerprints + the deterministic collection keys
// ---------------------------------------------------------------------------

/**
 * The §8-style fingerprint of one logical usage-observation command: a
 * deterministic digest of the CANONICAL command content (workspace, app,
 * dimension, quantity, capability, namespace, source invocation) — one
 * idempotency key identifies one observation intent; a key reused for
 * different content is a conflict. Pure.
 */
export function appMeterObservationCreateFingerprint(content: {
  readonly workspaceId: string;
  readonly appKey: string;
  readonly dimension: AppMeteringDimension;
  readonly quantity: number;
  readonly capability: string | null;
  readonly stateNamespace: string | null;
  readonly sourceInvocationId: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        workspaceId: content.workspaceId,
        appKey: content.appKey,
        dimension: content.dimension,
        quantity: content.quantity,
        capability: content.capability,
        stateNamespace: content.stateNamespace,
        sourceInvocationId: content.sourceInvocationId,
      }),
    )
    .update('|mkt-052-meter-observation')
    .digest('hex');
}

/**
 * The DETERMINISTIC §8 command key of one collected install-selection
 * meter event: reserved 'collect:' prefix + the canonical ledger row id.
 * At-most-once by construction (the (source_kind, source_id, dimension)
 * partial unique fence re-fences it). Pure.
 */
export function collectInstallSelectionKey(installId: string): string {
  return `${APP_METERING_COLLECT_KEY_PREFIX}app-install-selection:${installId}`;
}

/**
 * The DETERMINISTIC §8 command key of one collected invocation meter
 * event: reserved 'collect:' prefix + the canonical invocation record id.
 * Pure.
 */
export function collectInvocationKey(invocationId: string): string {
  return `${APP_METERING_COLLECT_KEY_PREFIX}extension-invocation:${invocationId}`;
}

// ---------------------------------------------------------------------------
// Write-conflict classification (the /app-marketplace
// classifyMarketplaceWriteConflict precedent)
// ---------------------------------------------------------------------------

/**
 * Classifies a postgres error on metering writes into the domain conflict
 * it represents (§8 idempotency fence vs at-most-once source fence vs
 * validation backstop). Anything else propagates untouched.
 */
export function classifyAppMeteringWriteConflict(
  error: unknown,
): 'idempotency-fence' | 'source-once-fence' | 'validation-backstop' | null {
  const candidate = error as { code?: string; constraint?: string; message?: string };
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'app_metering_events_idempotency_key_unique') {
      return 'idempotency-fence';
    }
    if (candidate.constraint === 'app_metering_events_source_once_fence') {
      return 'source-once-fence';
    }
    return 'idempotency-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'validation-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// Row shapes + serialization
// ---------------------------------------------------------------------------

interface AppMeterEventRow extends DbRow {
  readonly event_id: string;
  readonly dimension: string;
  readonly unit: string;
  readonly quantity: string | number;
  readonly agency_id: string;
  readonly client_id: string;
  readonly workspace_id: string;
  readonly app_key: string | null;
  readonly app_version_id: string | null;
  readonly version: string | null;
  readonly extension_id: string | null;
  readonly extension_key: string | null;
  readonly extension_publisher: string | null;
  readonly extension_version: string | null;
  readonly capability: string | null;
  readonly state_namespace: string | null;
  readonly source_kind: string;
  readonly source_id: string;
  readonly source_link_id: string | null;
  readonly occurred_at: Date;
  readonly recorded_actor: string;
  readonly recorded_via: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly recorded_at: Date;
  readonly idempotency_key: string;
  readonly create_fingerprint: string;
}

const APP_METER_EVENT_SELECT = `
  SELECT event_id, dimension, unit, quantity, agency_id, client_id, workspace_id,
         app_key, app_version_id, version, extension_id, extension_key,
         extension_publisher, extension_version, capability, state_namespace,
         source_kind, source_id, source_link_id, occurred_at, recorded_actor,
         recorded_via, correlation_id, causation_id, recorded_at, idempotency_key,
         create_fingerprint
  FROM app_metering_events
`;

function toAppMeterEventRecord(row: AppMeterEventRow): AppMeterEventRecord {
  return {
    eventId: row.event_id,
    dimension: row.dimension as AppMeteringDimension,
    unit: row.unit as AppMeteringUnit,
    quantity: Number(row.quantity),
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    appKey: row.app_key,
    appVersionId: row.app_version_id,
    version: row.version,
    extensionId: row.extension_id,
    extensionKey: row.extension_key,
    extensionPublisher: row.extension_publisher,
    extensionVersion: row.extension_version,
    capability: row.capability,
    stateNamespace: row.state_namespace,
    sourceKind: row.source_kind as AppMeteringSourceKind,
    sourceId: row.source_id,
    sourceLinkId: row.source_link_id,
    occurredAt: row.occurred_at.toISOString(),
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
  };
}

/** The canonical insert shape of one meter event row. */
export interface AppMeterEventInsert {
  readonly dimension: AppMeteringDimension;
  readonly unit: AppMeteringUnit;
  readonly quantity: number;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly appKey: string | null;
  readonly appVersionId: string | null;
  readonly version: string | null;
  readonly extensionId: string | null;
  readonly extensionKey: string | null;
  readonly extensionPublisher: string | null;
  readonly extensionVersion: string | null;
  readonly capability: string | null;
  readonly stateNamespace: string | null;
  readonly sourceKind: AppMeteringSourceKind;
  readonly sourceId: string;
  readonly sourceLinkId: string | null;
  readonly occurredAt: string;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly idempotencyKey: string;
  readonly createFingerprint: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class AppMeteringStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /** The recorded meter event for a §8 idempotency key (null when absent). */
  async findMeterEventByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<AppMeterEventRecord | null> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAppMeterEventRecord(row);
  }

  /** Raw meter event row by id (append-only history is always readable). */
  async getAppMeterEvent(eventId: string): Promise<AppMeterEventRecord | null> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE event_id = $1`,
      [eventId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAppMeterEventRecord(row);
  }

  /** The workspace's append-only meter event tail (oldest first). */
  async listWorkspaceMeterEvents(workspaceId: string): Promise<readonly AppMeterEventRecord[]> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE workspace_id = $1 ORDER BY occurred_at, event_id`,
      [workspaceId],
    );
    return result.rows.map(toAppMeterEventRecord);
  }

  /** The agency's meter event slice (oldest first — the agency view basis). */
  async listAgencyMeterEvents(agencyId: string): Promise<readonly AppMeterEventRecord[]> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE agency_id = $1 ORDER BY occurred_at, event_id`,
      [agencyId],
    );
    return result.rows.map(toAppMeterEventRecord);
  }

  /** The whole tail (the recompute's aggregation basis). */
  async listAllMeterEvents(): Promise<readonly AppMeterEventRecord[]> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} ORDER BY occurred_at, event_id`,
    );
    return result.rows.map(toAppMeterEventRecord);
  }

  /**
   * The meter events of a SET of app keys (the publisher view basis —
   * attributed app facts only; invocation events are resolved separately
   * for the linkage derivation).
   */
  async listMeterEventsForAppKeys(appKeys: readonly string[]): Promise<readonly AppMeterEventRecord[]> {
    if (appKeys.length === 0) return [];
    const placeholders = appKeys.map((_, index) => `$${index + 1}`).join(', ');
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE app_key IN (${placeholders}) ORDER BY occurred_at, event_id`,
      [...appKeys],
    );
    return result.rows.map(toAppMeterEventRecord);
  }

  /**
   * ALL invocation meter events (the publisher view's linkage-derivation
   * basis — bounded by the total invocations metered; the per-workspace
   * current-selection contexts resolve the attribution). V1 disclosure:
   * the platform-scope publisher view scans the invocation slice of the
   * tail; a future Work Item may add a scoped index.
   */
  async listInvocationMeterEvents(): Promise<readonly AppMeterEventRecord[]> {
    const result = await this.db.query<AppMeterEventRow>(
      `${APP_METER_EVENT_SELECT} WHERE source_kind = 'extension-invocation' ORDER BY occurred_at, event_id`,
    );
    return result.rows.map(toAppMeterEventRecord);
  }

  /**
   * The ALREADY-METERED source ids of one workspace for the COLLECTED
   * source kinds (the collection's idempotent-skip set — the at-most-once
   * fence re-fences it under concurrency).
   */
  async listMeteredSourceIds(
    workspaceId: string,
  ): Promise<ReadonlyMap<AppMeteringSourceKind, ReadonlySet<string>>> {
    const result = await this.db.query<{ source_kind: string; source_id: string }>(
      `SELECT source_kind, source_id FROM app_metering_events
        WHERE workspace_id = $1 AND source_kind IN ('app-install-selection', 'extension-invocation')`,
      [workspaceId],
    );
    const byKind = new Map<AppMeteringSourceKind, Set<string>>();
    for (const row of result.rows) {
      const kind = row.source_kind as AppMeteringSourceKind;
      const existing = byKind.get(kind) ?? new Set<string>();
      existing.add(row.source_id);
      byKind.set(kind, existing);
    }
    return byKind;
  }

  /**
   * The total meter event count (the recompute disclosure input).
   */
  async countMeterEvents(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app_metering_events',
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Appends ONE meter event (ON CONFLICT (workspace_id, idempotency_key)
   * DO NOTHING — 'taken' means the logical command already converged; the
   * migration-044 fences re-fence every write: the §8 idempotency key,
   * the at-most-once source fence, the payload shape, the scope chain
   * and the canonical identity re-verification triggers).
   */
  async insertMeterEvent(
    row: AppMeterEventInsert,
  ): Promise<AppMeterEventRecord | 'taken'> {
    const eventId = this.ids.newId();
    const now = this.clock.nowIso();
    try {
      const inserted = await this.db.query(
        `INSERT INTO app_metering_events
           (event_id, dimension, unit, quantity, agency_id, client_id, workspace_id,
            app_key, app_version_id, version, extension_id, extension_key,
            extension_publisher, extension_version, capability, state_namespace,
            source_kind, source_id, source_link_id, occurred_at, recorded_actor,
            recorded_via, correlation_id, causation_id, recorded_at, idempotency_key,
            create_fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING`,
        [
          eventId,
          row.dimension,
          row.unit,
          row.quantity,
          row.agencyId,
          row.clientId,
          row.workspaceId,
          row.appKey,
          row.appVersionId,
          row.version,
          row.extensionId,
          row.extensionKey,
          row.extensionPublisher,
          row.extensionVersion,
          row.capability,
          row.stateNamespace,
          row.sourceKind,
          row.sourceId,
          row.sourceLinkId,
          row.occurredAt,
          row.recordedActor,
          row.recordedVia,
          row.correlationId,
          row.causationId,
          now,
          row.idempotencyKey,
          row.createFingerprint,
        ],
      );
      if (inserted.rowCount !== 1) {
        return 'taken' as const;
      }
    } catch (error) {
      const conflict = classifyAppMeteringWriteConflict(error);
      if (conflict === 'idempotency-fence' || conflict === 'source-once-fence') {
        return 'taken' as const;
      }
      if (conflict === 'validation-backstop') {
        throw new InvalidRequestError(
          `meter event was rejected by the metering validation backstop: ${(error as { message?: string }).message ?? 'constraint violation'}`,
        );
      }
      throw error;
    }
    const created = await this.findMeterEventByIdempotencyKey(row.workspaceId, row.idempotencyKey);
    if (created === null) {
      throw new Error(
        `recorded meter event under key '${row.idempotencyKey}' could not be read back`,
      );
    }
    return created;
  }

  /**
   * RECOMPUTES the rollup projection from the append-only tail (the
   * DISCLOSED rebuild path — AC-5): ONE transaction replaces the whole
   * app_metering_rollups table with the deterministic (workspace,
   * app-or-unattributed, dimension, month) GROUP BY aggregates. The
   * aggregate columns are pure functions of the tail; rebuilt_at is the
   * only non-deterministic column (the generation stamp).
   */
  async recomputeRollups(): Promise<{ readonly rollupRows: number; readonly rebuiltAt: string }> {
    const rebuiltAt = this.clock.nowIso();
    const outcome = await this.db.transaction(async (tx) => {
      await tx.query('DELETE FROM app_metering_rollups');
      const inserted = await tx.query(
        `INSERT INTO app_metering_rollups
             (agency_id, client_id, workspace_id, app_key, dimension, unit,
              period_start, quantity_sum, event_count, rebuilt_at)
           SELECT agency_id, client_id, workspace_id, COALESCE(app_key, ''),
                  dimension, unit, date_trunc('month', occurred_at),
                  SUM(quantity), COUNT(*), $1
             FROM app_metering_events
             GROUP BY agency_id, client_id, workspace_id, COALESCE(app_key, ''), dimension, unit,
                      date_trunc('month', occurred_at)`,
        [rebuiltAt],
      );
      return Number(inserted.rowCount ?? 0);
    });
    return { rollupRows: outcome, rebuiltAt };
  }
}

// ---------------------------------------------------------------------------
// The §8 replay convergence (the /app-marketplace replayOrConflict
// precedent)
// ---------------------------------------------------------------------------

/**
 * The §8 replay convergence for a recorded idempotency key: an identical
 * fingerprint converges to the recorded record (replayed: true, zero
 * state change); a divergent reuse of the key is an
 * IdempotencyConflictError.
 */
export function replayOrConflict<T extends { readonly createFingerprint: string }>(
  idempotencyKey: string,
  recorded: T | null,
  fingerprint: string,
): { readonly replayed: true; readonly record: T } | { readonly replayed: false } {
  if (recorded === null) return { replayed: false };
  if (recorded.createFingerprint !== fingerprint) {
    throw new IdempotencyConflictError(idempotencyKey);
  }
  return { replayed: true, record: recorded };
}
