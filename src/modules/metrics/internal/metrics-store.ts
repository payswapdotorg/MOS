/**
 * /metrics persistence (metric_observations table) — append-only by database
 * backstop (migration 018): UPDATE and DELETE are rejected by triggers, so
 * this store can only INSERT and SELECT. Corrections are NEW rows that
 * carry the same metric identity (e.g. quality='restated') — there is
 * deliberately no supersession graph on the measurement authority
 * (METRIC-001: "immutable rows; corrections are new rows").
 *
 * Provenance columns (recorded_actor, recorded_via, correlation_id,
 * causation_id, recorded_at) are written ONLY from the server-built
 * MetricProvenance argument — there is no other write path, and the append
 * guard refuses to even run with an incomplete provenance. The RETRIEVAL
 * timestamp (retrieved_at — when the platform saw the observation) is
 * stamped from the module clock unless a server-side caller supplied the
 * true retrieval moment; it is NEVER a request-body value.
 *
 * The §21 secret-leak guard (reused from the /evidence public contract —
 * the frozen matrix allows /metrics ──→ /evidence) runs on the dimension
 * payload BEFORE insert: material-shaped keys can never enter a metric
 * observation at any nesting level.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  MetricDimensionValue,
  MetricObservationAppendInput,
  MetricObservationRecord,
  MetricProvenance,
  MetricQualityStatus,
} from '../public.ts';
import { isKnownMetricQuality } from '../public.ts';
// The ONE allowed cross-module import (frozen matrix: /metrics ──→
// /evidence, /integrations): the shared §21 material-key backstop from the
// /evidence public contract — a single source of truth for the forbidden
// key set.
import { containsMaterialKey } from '../../evidence/public.ts';

interface MetricObservationRow extends DbRow {
  observation_id: string;
  client_id: string;
  workspace_id: string | null;
  metric_name: string;
  dimensions: unknown;
  value: string;
  unit: string;
  source_system: string;
  source_ref: string | null;
  observed_at: Date;
  retrieved_at: Date;
  evidence_ref: string | null;
  quality: string;
  aggregation_method: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

const METRIC_SELECT = `
  SELECT m.observation_id, m.client_id, m.workspace_id, m.metric_name, m.dimensions,
         m.value, m.unit, m.source_system, m.source_ref, m.observed_at, m.retrieved_at,
         m.evidence_ref, m.quality, m.aggregation_method, m.recorded_actor, m.recorded_via,
         m.correlation_id, m.causation_id, m.recorded_at
  FROM metric_observations m
`;

/** Max dimension keys per observation (module-side shape bound). */
const MAX_DIMENSION_KEYS = 20;
const MAX_DIMENSION_KEY_LENGTH = 100;
const MAX_DIMENSION_VALUE_LENGTH = 256;

/** Dimension values are scalars by construction (JSON-safe). */
function isScalarDimensionValue(value: unknown): value is MetricDimensionValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  return false;
}

/**
 * Pure append guard at the authority boundary: the module never persists a
 * metric observation that violates the frozen METRIC-001 shapes, whatever
 * the caller did upstream. Mirrors the DB CHECKs and adds the per-field
 * semantics the jsonb CHECKs cannot express (dimension key/value bounds,
 * scalar values, §21 material-key rejection, real timestamps).
 */
export function assertValidMetricObservationAppend(input: MetricObservationAppendInput): void {
  const problems: string[] = [];

  if (typeof input.metricName !== 'string' || input.metricName.trim() === '') {
    problems.push('metricName: a non-empty metric identity name is required');
  } else if (input.metricName.length > 200) {
    problems.push('metricName: must be at most 200 characters');
  }

  if (
    input.dimensions === null ||
    typeof input.dimensions !== 'object' ||
    Array.isArray(input.dimensions)
  ) {
    problems.push('dimensions: must be a JSON object of dimension key → scalar value');
  } else {
    const entries = Object.entries(input.dimensions);
    if (entries.length > MAX_DIMENSION_KEYS) {
      problems.push(`dimensions: must carry at most ${MAX_DIMENSION_KEYS} dimension keys`);
    }
    for (const [key, value] of entries) {
      if (key.trim() === '' || key.length > MAX_DIMENSION_KEY_LENGTH) {
        problems.push(
          `dimensions: dimension keys must be between 1 and ${MAX_DIMENSION_KEY_LENGTH} characters (found '${key}')`,
        );
      }
      if (!isScalarDimensionValue(value)) {
        problems.push(
          `dimensions.${key}: dimension values must be scalars (string, number or boolean)`,
        );
      } else if (typeof value === 'string' && value.length > MAX_DIMENSION_VALUE_LENGTH) {
        problems.push(
          `dimensions.${key}: string dimension values must be at most ${MAX_DIMENSION_VALUE_LENGTH} characters`,
        );
      }
    }
    // §21 defense in depth: material-shaped keys can never appear in the
    // dimension payload (re-exported single source of truth from /evidence).
    if (containsMaterialKey(input.dimensions)) {
      problems.push(
        'dimensions: material-shaped keys can never appear in metric payloads (implementation-contract §21)',
      );
    }
  }

  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    problems.push('value: must be a finite number');
  }

  if (typeof input.unit !== 'string' || input.unit.trim() === '') {
    problems.push('unit: a non-empty value unit is required');
  } else if (input.unit.length > 64) {
    problems.push('unit: must be at most 64 characters');
  }

  if (typeof input.source.system !== 'string' || input.source.system.trim() === '') {
    problems.push('source.system: a non-empty source system is required (provider label or \'internal\')');
  } else if (input.source.system.length > 100) {
    problems.push('source.system: must be at most 100 characters');
  }
  if (input.source.ref !== null && (input.source.ref.length < 1 || input.source.ref.length > 512)) {
    problems.push('source.ref: must be between 1 and 512 characters when present');
  }

  // The METRIC-001 timestamp pair: OBSERVATION time (when the metric was
  // true) and RETRIEVAL time (when the platform saw it) are both real
  // timestamps, and are stored as SEPARATE columns.
  if (typeof input.observedAt !== 'string' || Number.isNaN(Date.parse(input.observedAt))) {
    problems.push('observedAt: must be a real ISO 8601 timestamp (when the metric was true)');
  }
  if (
    input.retrievedAt !== null &&
    (typeof input.retrievedAt !== 'string' || Number.isNaN(Date.parse(input.retrievedAt)))
  ) {
    problems.push(
      'retrievedAt: must be a real ISO 8601 timestamp when present (when the platform saw it; null → the module stamps its clock)',
    );
  }

  if (input.evidenceRef !== null && input.evidenceRef.trim() === '') {
    problems.push('evidenceRef: must be a non-empty identifier when present');
  }

  if (!isKnownMetricQuality(input.quality)) {
    problems.push(`quality '${input.quality}' must be one of the frozen metric data-quality statuses`);
  }

  if (
    input.aggregationMethod !== null &&
    (input.aggregationMethod.trim() === '' || input.aggregationMethod.length > 100)
  ) {
    problems.push('aggregationMethod: must be between 1 and 100 characters when present');
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('metric observation rejected by the append guard', problems);
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any insert: an
 * incomplete provenance fails closed (the row's authority columns are never
 * defaulted from caller input). Mirrors the /evidence guard exactly.
 */
export function assertValidMetricProvenance(provenance: MetricProvenance): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: metric observations are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'metric observation rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}

/** Distinctive phrase of the migration 018 cross-tenant evidence-linkage trigger. */
const EVIDENCE_REF_CROSS_TENANT_MARKER = 'cross-tenant evidence linkage is rejected';

/**
 * Classifies a postgres error on the metric INSERT into the cross-tenant
 * evidence-linkage race (the module pre-check lost to a concurrent change —
 * the DB trigger won). Anything else propagates untouched.
 */
export function classifyMetricInsertConflict(error: unknown): 'evidence-ref-client' | null {
  const candidate = error as { code?: string; message?: string };
  if (candidate?.message !== undefined && candidate.message.includes(EVIDENCE_REF_CROSS_TENANT_MARKER)) {
    return 'evidence-ref-client';
  }
  return null;
}

export interface MetricObservationInsertRow {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, MetricDimensionValue>>;
  readonly value: number;
  readonly unit: string;
  readonly sourceSystem: string;
  readonly sourceRef: string | null;
  readonly observedAt: string;
  /**
   * Retrieval timestamp from a server-side emitter, or null → the module
   * clock stamps the moment the platform saw the observation.
   */
  readonly retrievedAt: string | null;
  readonly evidenceRef: string | null;
  readonly quality: MetricQualityStatus;
  readonly aggregationMethod: string | null;
}

export class MetricObservationStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Appends one immutable record. The DB triggers are the final backstops
   * (append-only, workspace-within-client, evidence_ref-same-client).
   */
  async insertObservation(
    row: MetricObservationInsertRow,
    provenance: MetricProvenance,
  ): Promise<MetricObservationRecord> {
    const observationId = this.ids.newId();
    // Two DISTINCT server-side stamps: retrieved_at (when the platform saw
    // THIS observation) and the provenance recorded_at (when the row was
    // recorded). The caller-declared observed_at stays a separate column —
    // the METRIC-001 timestamp semantics never collapse.
    const retrievedAt = row.retrievedAt ?? this.clock.nowIso();
    const recordedAt = this.clock.nowIso();
    await this.db.query(
      `INSERT INTO metric_observations (observation_id, client_id, workspace_id, metric_name,
                             dimensions, value, unit, source_system, source_ref, observed_at,
                             retrieved_at, evidence_ref, quality, aggregation_method,
                             recorded_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        observationId,
        row.clientId,
        row.workspaceId,
        row.metricName,
        JSON.stringify(row.dimensions),
        row.value,
        row.unit,
        row.sourceSystem,
        row.sourceRef,
        row.observedAt,
        retrievedAt,
        row.evidenceRef,
        row.quality,
        row.aggregationMethod,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        recordedAt,
      ],
    );
    const created = await this.getObservation(observationId);
    if (created === null) {
      throw new Error(`appended metric observation ${observationId} could not be read back`);
    }
    return created;
  }

  async getObservation(observationId: string): Promise<MetricObservationRecord | null> {
    const result = await this.db.query<MetricObservationRow>(
      `${METRIC_SELECT} WHERE m.observation_id = $1`,
      [observationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toMetricObservationRecord(row);
  }

  /**
   * The Client's observations, newest first by server-recorded time
   * (bounded — the append-only ledger grows without end).
   */
  async listObservationsForClient(
    clientId: string,
    limit = 500,
  ): Promise<readonly MetricObservationRecord[]> {
    const bounded = Math.min(Math.max(limit, 1), 1000);
    const result = await this.db.query<MetricObservationRow>(
      `${METRIC_SELECT} WHERE m.client_id = $1
       ORDER BY m.recorded_at DESC, m.observation_id LIMIT $2`,
      [clientId, bounded],
    );
    return result.rows.map(toMetricObservationRecord);
  }
}

function toMetricObservationRecord(row: MetricObservationRow): MetricObservationRecord {
  return {
    observationId: row.observation_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    metricName: row.metric_name,
    dimensions: (row.dimensions ?? {}) as Record<string, MetricDimensionValue>,
    value: Number(row.value),
    unit: row.unit,
    source: {
      system: row.source_system,
      ref: row.source_ref,
    },
    observedAt: row.observed_at.toISOString(),
    retrievedAt: row.retrieved_at.toISOString(),
    evidenceRef: row.evidence_ref,
    quality: row.quality as MetricQualityStatus,
    aggregationMethod: row.aggregation_method,
    provenance: {
      actor: row.recorded_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: row.recorded_at.toISOString(),
    },
  };
}
