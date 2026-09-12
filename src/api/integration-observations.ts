/**
 * Integration observation delivery — the MKT-024 server-side integration
 * EMITTER (INT-001 + METRIC-001) at the application layer.
 *
 * WHY THIS LIVES HERE (frozen architecture): the dependency matrix allows
 * `/metrics ──→ /evidence, /integrations` but NOT the reverse — the
 * /integrations module can never import /metrics. The /metrics public
 * contract explicitly anticipates this arrangement: "server-side
 * integration emitters may pass the true retrieval moment through the
 * module API" and provenance "later server-side emitters
 * ('integration:<provider>', ...)". The sanctioned composition point that
 * sees BOTH the /integrations and the /metrics+/evidence public contracts
 * is the API route layer (exactly where every other cross-module flow is
 * composed) — this helper is that emitter, consumed by the
 * POST .../connections/:connectionId/sync route.
 *
 * WHAT IT DOES: the provider-specific payload → normalized-record mapping
 * happened INSIDE the boundary (the first-party adapters — provider ids
 * became composite providerRecordIds + dimensions + source references;
 * no raw provider id leaks into a domain record). This helper then maps
 * each NORMALIZED record to the domain observation contracts:
 *
 *   - EVERY record → ONE 'source_fact' /evidence append with /evidence's
 *     OWN provenance model (class/quality/provenance PINNED server-side:
 *     class 'source_fact' — a direct provider observation, never a claim
 *     class; quality 'C' — the defensible machine-recorded observation
 *     grade, the MKT-023 webhook precedent; the connector never
 *     fabricates evidence classes);
 *   - records whose adapter envelope is METRIC-shaped (kind 'metric') →
 *     additionally ONE /metrics observation append (METRIC-001): the
 *     source mapping {system: 'integration:<adapterKey>', ref: the
 *     providerRecordId}, the OBSERVATION timestamp (observedAt — when the
 *     metric was true, from the record's sourceTimestamp) kept DISTINCT
 *     from the RETRIEVAL timestamp (retrievedAt — the server-stamped
 *     moment the platform saw it), the metric identity/value/unit from the
 *     normalized envelope, and evidenceRef linking the observation to its
 *     source fact;
 *   - non-metric records (kind 'record' — campaign/contact/content
 *     metadata) are source facts ONLY: no measured series, no fabricated
 *     metric.
 *
 * FAIL-CLOSED POSTURE: every envelope is validated BEFORE any append (a
 * malformed envelope is a 422 with NOTHING delivered — no partial silent
 * deliveries); delivery failures surface as typed errors; the append-only
 * contracts downstream guarantee replay behavior (a re-run appends fresh
 * immutable rows; history is never rewritten).
 */

import { InvalidRequestError } from '../platform/errors/errors.ts';
import { containsMaterialShapedKey, type NormalizedProviderRecord } from '../modules/integrations/public.ts';
import type {
  EvidenceAppendInput,
  EvidenceProvenance,
} from '../modules/evidence/public.ts';
import type {
  MetricObservationAppendInput,
  MetricProvenance,
  MetricQualityStatus,
} from '../modules/metrics/public.ts';

// ---------------------------------------------------------------------------
// The adapter observation ENVELOPE contract (runtime-validated here)
// ---------------------------------------------------------------------------

/** The closed data-quality vocabulary (mirrors the /metrics frozen set). */
const OBSERVATION_QUALITIES: readonly string[] = ['ok', 'partial', 'estimated', 'restated', 'suspect'];

const MAX_METRIC_NAME_LENGTH = 200;
const MAX_DIMENSIONS_KEYS = 20;
const MAX_UNIT_LENGTH = 64;
const MAX_AGGREGATION_LENGTH = 100;
const MAX_RECORD_TYPE_LENGTH = 200;
const MAX_PROVIDER_RECORD_ID_LENGTH = 512;

/** The metric-shaped envelope a connector emits as record.data. */
export interface ProviderMetricEnvelope {
  readonly kind: 'metric';
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly unit: string;
  readonly quality: MetricQualityStatus;
  readonly aggregationMethod: string | null;
}

/** The source-record-shaped envelope a connector emits as record.data. */
export interface ProviderRecordEnvelope {
  readonly kind: 'record';
  readonly recordType: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type ProviderObservationEnvelope = ProviderMetricEnvelope | ProviderRecordEnvelope;

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Validates one normalized record's envelope against the connector
 * observation contract — the runtime half of the adapter↔emitter
 * agreement (the source-mapping tests prove the exact shapes). Throws
 * InvalidRequestError on any violation: malformed envelopes NEVER reach
 * /metrics or /evidence (fail closed before any append).
 */
export function assertValidObservationEnvelope(record: NormalizedProviderRecord): ProviderObservationEnvelope {
  const problems: string[] = [];
  const label = `record '${record.providerRecordId}'`;
  if (
    typeof record.providerRecordId !== 'string' ||
    record.providerRecordId.trim() === '' ||
    record.providerRecordId.length > MAX_PROVIDER_RECORD_ID_LENGTH
  ) {
    problems.push(`${label}: providerRecordId must be 1..${MAX_PROVIDER_RECORD_ID_LENGTH} characters`);
  }
  if (record.data === null || typeof record.data !== 'object' || Array.isArray(record.data)) {
    throw new InvalidRequestError('Malformed connector observation envelope', [
      `${label}: data must be an object`,
    ]);
  }
  if (containsMaterialShapedKey(record.data)) {
    problems.push(`${label}: material-shaped keys are forbidden at every nesting level (§21)`);
  }
  const kind = record.data['kind'];
  if (kind === 'metric') {
    const metricName = record.data['metricName'];
    if (typeof metricName !== 'string' || metricName.trim() === '' || metricName.length > MAX_METRIC_NAME_LENGTH) {
      problems.push(`${label}.metricName: must be 1..${MAX_METRIC_NAME_LENGTH} characters`);
    }
    const dimensions = record.data['dimensions'];
    if (dimensions === null || typeof dimensions !== 'object' || Array.isArray(dimensions)) {
      problems.push(`${label}.dimensions: must be an object of scalar values`);
    } else {
      const entries = Object.entries(dimensions as Record<string, unknown>);
      if (entries.length > MAX_DIMENSIONS_KEYS) {
        problems.push(`${label}.dimensions: at most ${MAX_DIMENSIONS_KEYS} dimension keys`);
      }
      for (const [key, value] of entries) {
        if (!isScalar(value)) {
          problems.push(`${label}.dimensions.${key}: dimension values must be scalars`);
        }
      }
    }
    const value = record.data['value'];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push(`${label}.value: must be a finite number`);
    }
    const unit = record.data['unit'];
    if (typeof unit !== 'string' || unit.trim() === '' || unit.length > MAX_UNIT_LENGTH) {
      problems.push(`${label}.unit: must be 1..${MAX_UNIT_LENGTH} characters`);
    }
    const quality = record.data['quality'];
    if (typeof quality !== 'string' || !OBSERVATION_QUALITIES.includes(quality)) {
      problems.push(`${label}.quality: must be one of ${OBSERVATION_QUALITIES.join('/')}`);
    }
    const aggregationMethod = record.data['aggregationMethod'];
    if (
      aggregationMethod !== undefined &&
      aggregationMethod !== null &&
      (typeof aggregationMethod !== 'string' || aggregationMethod.length > MAX_AGGREGATION_LENGTH)
    ) {
      problems.push(`${label}.aggregationMethod: must be null or at most ${MAX_AGGREGATION_LENGTH} characters`);
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('Malformed connector observation envelope', problems);
    }
    return {
      kind: 'metric',
      metricName: metricName as string,
      dimensions: dimensions as Record<string, string | number | boolean>,
      value: value as number,
      unit: unit as string,
      quality: quality as MetricQualityStatus,
      aggregationMethod:
        aggregationMethod === undefined || aggregationMethod === null ? null : (aggregationMethod as string),
    };
  }
  if (kind === 'record') {
    const recordType = record.data['recordType'];
    if (typeof recordType !== 'string' || recordType.trim() === '' || recordType.length > MAX_RECORD_TYPE_LENGTH) {
      problems.push(`${label}.recordType: must be 1..${MAX_RECORD_TYPE_LENGTH} characters`);
    }
    const fields = record.data['fields'];
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      problems.push(`${label}.fields: must be an object`);
    }
    if (problems.length > 0) {
      throw new InvalidRequestError('Malformed connector observation envelope', problems);
    }
    return {
      kind: 'record',
      recordType: recordType as string,
      fields: (fields ?? {}) as Record<string, unknown>,
    };
  }
  throw new InvalidRequestError('Malformed connector observation envelope', [
    `${label}.kind: must be 'metric' or 'record' (found ${JSON.stringify(kind)})`,
  ]);
}

// ---------------------------------------------------------------------------
// The delivery mapping (pure — unit-tested)
// ---------------------------------------------------------------------------

/**
 * The server-derived provenance shared by the delivery appends. Actor and
 * correlation come from the authenticated principal and the ambient
 * correlation context; `recordedVia` is pinned server-side to
 * 'integration:<adapterKey>' on every append (never request-suppliable).
 */
export interface IntegrationObservationProvenance {
  readonly actor: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/**
 * Pure mapping: ONE normalized record → the 'source_fact' /evidence append
 * input. Class, quality and the observation content are PINNED honest
 * values (class 'source_fact' — a direct provider observation, never a
 * claim class; quality 'C' — the machine-recorded observation grade, the
 * MKT-023 webhook precedent); the source maps to
 * {system: 'integration:<adapterKey>', ref: providerRecordId} — the
 * provider identifier becomes an opaque SOURCE REFERENCE (never a domain
 * identity); observedAt maps from the record's sourceTimestamp (the
 * provider-observed moment) with the retrieval moment as the honest
 * fallback; the content embeds the envelope plus the source metadata
 * (ETag/version) for traceability.
 */
export function buildEvidenceAppendInput(args: {
  readonly clientId: string;
  readonly adapterKey: string;
  readonly operation: string;
  readonly record: NormalizedProviderRecord;
  readonly fallbackObservedAt: string;
}): EvidenceAppendInput {
  return {
    clientId: args.clientId,
    workspaceId: null,
    class: 'source_fact',
    source: {
      system: `integration:${args.adapterKey}`,
      ref: args.record.providerRecordId,
    },
    observedAt: args.record.sourceTimestamp ?? args.fallbackObservedAt,
    content: {
      adapterKey: args.adapterKey,
      operation: args.operation,
      providerRecordId: args.record.providerRecordId,
      envelope: args.record.data,
      sourceTimestamp: args.record.sourceTimestamp,
      etag: args.record.etag,
      sourceVersion: args.record.sourceVersion,
    },
    contentRef: null,
    quality: 'C',
    confidence: null,
    supersedesEvidenceId: null,
  };
}

/**
 * Pure mapping: ONE metric-shaped record → the /metrics observation append
 * input (METRIC-001). The SOURCE mapping: system
 * 'integration:<adapterKey>', ref = providerRecordId (the provider report
 * identity — an opaque source reference). The TIMESTAMP pair: observedAt
 * (when the metric was true — the record's sourceTimestamp) kept DISTINCT
 * from retrievedAt (the server-stamped retrieval moment — the
 * server-side-emitter path of the /metrics contract). The REFERENCE
 * mapping: evidenceRef = the source_fact appended for the same record
 * (same Client — enforced by /metrics). Metric identity (name +
 * dimensions), value, unit, quality and aggregation method come from the
 * validated envelope.
 */
export function buildMetricObservationAppendInput(args: {
  readonly clientId: string;
  readonly adapterKey: string;
  readonly record: NormalizedProviderRecord;
  readonly envelope: ProviderMetricEnvelope;
  readonly retrievedAt: string;
  readonly fallbackObservedAt: string;
  readonly evidenceId: string;
}): MetricObservationAppendInput {
  return {
    clientId: args.clientId,
    workspaceId: null,
    metricName: args.envelope.metricName,
    dimensions: args.envelope.dimensions,
    value: args.envelope.value,
    unit: args.envelope.unit,
    source: {
      system: `integration:${args.adapterKey}`,
      ref: args.record.providerRecordId,
    },
    observedAt: args.record.sourceTimestamp ?? args.fallbackObservedAt,
    retrievedAt: args.retrievedAt,
    evidenceRef: args.evidenceId,
    quality: args.envelope.quality,
    aggregationMethod: args.envelope.aggregationMethod,
  };
}

// ---------------------------------------------------------------------------
// The delivery orchestration (structural sinks — the real module APIs)
// ---------------------------------------------------------------------------

/**
 * Narrow structural view of the /evidence public contract this emitter
 * depends on. Satisfied structurally by EvidenceModuleApi (appendEvidence
 * returns the evidence id); /evidence remains the ONLY evidence authority.
 */
export interface IntegrationObservationEvidenceSink {
  appendEvidence(
    input: EvidenceAppendInput,
    provenance: EvidenceProvenance,
  ): Promise<{ readonly evidenceId: string }>;
}

/**
 * Narrow structural view of the /metrics public contract this emitter
 * depends on. Satisfied structurally by MetricsModuleApi; /metrics
 * remains the ONLY measurement authority.
 */
export interface IntegrationObservationMetricsSink {
  appendMetricObservation(
    input: MetricObservationAppendInput,
    provenance: MetricProvenance,
  ): Promise<{ readonly observationId: string }>;
}

/** The delivery receipt for one normalized record. */
export interface RecordDeliveryReceipt {
  readonly providerRecordId: string;
  readonly evidenceId: string;
  /** Present only for metric-shaped envelopes (null for source-record-only). */
  readonly observationId: string | null;
}

/** The whole-delivery outcome. */
export interface ObservationDeliveryOutcome {
  readonly retrievedAt: string;
  readonly receipts: readonly RecordDeliveryReceipt[];
}

/**
 * Delivers the normalized records of one completed read to /evidence and
 * /metrics through their public contracts (the server-side integration
 * emitter). ALL envelopes are validated FIRST (fail closed — a malformed
 * envelope is a 422 with nothing delivered); then each record's source
 * fact is appended, and metric-shaped records additionally append the
 * metric observation referencing it. Appends are append-only immutable
 * rows downstream: a re-run appends fresh rows (replay is idempotent in
 * the append-only sense — history is never rewritten).
 */
export async function deliverReadObservations(input: {
  readonly clientId: string;
  readonly adapterKey: string;
  readonly operation: string;
  readonly records: readonly NormalizedProviderRecord[];
  readonly nowIso: () => string;
  readonly evidenceSink: IntegrationObservationEvidenceSink;
  readonly metricsSink: IntegrationObservationMetricsSink;
  readonly provenance: IntegrationObservationProvenance;
}): Promise<ObservationDeliveryOutcome> {
  // Fail closed BEFORE any append: every envelope must be well-formed.
  const envelopes = input.records.map((record) => assertValidObservationEnvelope(record));

  const retrievedAt = input.nowIso();
  const fallbackObservedAt = retrievedAt;
  const recordedVia = `integration:${input.adapterKey}`;
  const receipts: RecordDeliveryReceipt[] = [];

  for (const [index, record] of input.records.entries()) {
    const evidence = await input.evidenceSink.appendEvidence(
      buildEvidenceAppendInput({
        clientId: input.clientId,
        adapterKey: input.adapterKey,
        operation: input.operation,
        record,
        fallbackObservedAt,
      }),
      {
        actor: input.provenance.actor,
        recordedVia,
        correlationId: input.provenance.correlationId,
        causationId: input.provenance.causationId,
      },
    );
    const envelope = envelopes[index]!;
    let observationId: string | null = null;
    if (envelope.kind === 'metric') {
      const observation = await input.metricsSink.appendMetricObservation(
        buildMetricObservationAppendInput({
          clientId: input.clientId,
          adapterKey: input.adapterKey,
          record,
          envelope,
          retrievedAt,
          fallbackObservedAt,
          evidenceId: evidence.evidenceId,
        }),
        {
          actor: input.provenance.actor,
          recordedVia,
          correlationId: input.provenance.correlationId,
          causationId: input.provenance.causationId,
        },
      );
      observationId = observation.observationId;
    }
    receipts.push({ providerRecordId: record.providerRecordId, evidenceId: evidence.evidenceId, observationId });
  }

  return { retrievedAt, receipts };
}
