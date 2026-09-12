/**
 * MKT-024 unit tests — the server-side integration observation delivery
 * (the provider-neutral METRIC-001 mapping in src/api/integration-observations.ts).
 *
 * The PROVIDER-specific payload mapping lives inside the integration
 * boundary (internal/adapters/** — importable only by the composition
 * root, per the static architecture checker) and is proven end-to-end by
 * the sandbox-provider integration tests. THIS file unit-tests the pure
 * emitter half every connector shares:
 *
 *   - the connector observation ENVELOPE guard (fail closed on any
 *     malformed envelope — kind, metric identity, scalar dimensions,
 *     finite value, unit, the closed quality vocabulary, §21
 *     material-shaped keys);
 *   - the record → 'source_fact' /evidence append mapping (class/quality
 *     PINNED server-side — never inputs; the provider id becomes an
 *     opaque SOURCE REFERENCE; observedAt maps from the record's source
 *     timestamp with the honest fallback);
 *   - the record → /metrics observation mapping (METRIC-001: the
 *     source/timestamp/reference mapping — source.system/ref,
 *     observedAt vs retrievedAt kept distinct, evidenceRef linkage);
 *   - the delivery orchestration: evidence ALWAYS, metrics only for
 *     metric-shaped envelopes, and the fail-closed BEFORE-any-append
 *     posture (a malformed envelope delivers NOTHING — no partial runs).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NormalizedProviderRecord } from '../../src/modules/integrations/public.ts';
import {
  assertValidObservationEnvelope,
  buildEvidenceAppendInput,
  buildMetricObservationAppendInput,
  deliverReadObservations,
  type IntegrationObservationEvidenceSink,
  type IntegrationObservationMetricsSink,
  type ProviderMetricEnvelope,
} from '../../src/api/integration-observations.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const METRIC_RECORD: NormalizedProviderRecord = {
  providerRecordId: 'meta:insights:23840001:2026-01-15:spend',
  data: {
    kind: 'metric',
    metricName: 'meta.ads.spend',
    dimensions: { campaignId: '23840001', campaignName: 'Spring Launch', date: '2026-01-15' },
    value: 128.45,
    unit: 'USD',
    quality: 'ok',
    aggregationMethod: 'sum',
  },
  sourceTimestamp: '2026-01-15T00:00:00.000Z',
  etag: '"meta-insights-23840001-2026-01-15"',
  sourceVersion: null,
};

const RECORD_RECORD: NormalizedProviderRecord = {
  providerRecordId: 'crm:contact:cnt_0021',
  data: {
    kind: 'record',
    recordType: 'crm.contact',
    fields: { id: 'cnt_0021', email: 'ada@example.test', status: 'active' },
  },
  sourceTimestamp: '2026-03-12T08:30:00.000Z',
  etag: null,
  sourceVersion: null,
};

function envelopeOf(record: NormalizedProviderRecord): ProviderMetricEnvelope {
  const envelope = assertValidObservationEnvelope(record);
  if (envelope.kind !== 'metric') throw new Error('expected a metric envelope');
  return envelope;
}

// ---------------------------------------------------------------------------
// The envelope guard (fail closed)
// ---------------------------------------------------------------------------

test('METRIC-001 unit: a well-formed metric envelope passes the guard', () => {
  const envelope = envelopeOf(METRIC_RECORD);
  assert.equal(envelope.metricName, 'meta.ads.spend');
  assert.equal(envelope.value, 128.45);
  assert.equal(envelope.unit, 'USD');
  assert.equal(envelope.quality, 'ok');
  assert.equal(envelope.aggregationMethod, 'sum');
  assert.deepEqual(envelope.dimensions, {
    campaignId: '23840001',
    campaignName: 'Spring Launch',
    date: '2026-01-15',
  });
});

test('METRIC-001 unit: a well-formed source-record envelope passes the guard', () => {
  const envelope = assertValidObservationEnvelope(RECORD_RECORD);
  assert.equal(envelope.kind, 'record');
  if (envelope.kind === 'record') {
    assert.equal(envelope.recordType, 'crm.contact');
    assert.deepEqual(envelope.fields, { id: 'cnt_0021', email: 'ada@example.test', status: 'active' });
  }
});

test('METRIC-001 unit (fail closed): unknown envelope kinds are rejected', () => {
  const bad: NormalizedProviderRecord = {
    ...METRIC_RECORD,
    data: { kind: 'nonsense', metricName: 'x', value: 1, unit: 'count', quality: 'ok' },
  };
  assert.throws(() => assertValidObservationEnvelope(bad), InvalidRequestError);
});

test('METRIC-001 unit (fail closed): non-scalar dimensions, non-finite values, unknown quality and bad units are rejected', () => {
  const cases: Record<string, unknown>[] = [
    { ...METRIC_RECORD.data, dimensions: { campaign: { nested: 'object' } } },
    { ...METRIC_RECORD.data, dimensions: { tags: ['a', 'b'] } },
    { ...METRIC_RECORD.data, value: Number.NaN },
    { ...METRIC_RECORD.data, value: '128.45' },
    { ...METRIC_RECORD.data, quality: 'excellent' },
    { ...METRIC_RECORD.data, unit: '' },
    { ...METRIC_RECORD.data, metricName: '' },
  ];
  for (const data of cases) {
    const bad: NormalizedProviderRecord = { ...METRIC_RECORD, data };
    assert.throws(() => assertValidObservationEnvelope(bad), InvalidRequestError, `expected rejection for ${JSON.stringify(data)}`);
  }
});

test('§21 unit (fail closed): material-shaped keys in an envelope are rejected at every level', () => {
  const cases: Record<string, unknown>[] = [
    { ...METRIC_RECORD.data, dimensions: { apiKey: 'leak' } },
    { kind: 'record', recordType: 'x', fields: { secret: 'leak' } },
    { kind: 'record', recordType: 'x', fields: { nested: { password: 'leak' } } },
  ];
  for (const data of cases) {
    const bad: NormalizedProviderRecord = { ...METRIC_RECORD, data };
    assert.throws(() => assertValidObservationEnvelope(bad), InvalidRequestError, `expected §21 rejection for ${JSON.stringify(data)}`);
  }
});

// ---------------------------------------------------------------------------
// The record → source_fact evidence mapping (pinned, never inputs)
// ---------------------------------------------------------------------------

test('METRIC-001 unit: the source-fact evidence append maps source/reference/timestamp EXACTLY with pinned class/quality', () => {
  const evidence = buildEvidenceAppendInput({
    clientId: 'client-1',
    adapterKey: 'meta-ads',
    operation: 'getInsights',
    record: METRIC_RECORD,
    fallbackObservedAt: '2026-09-11T10:00:00.000Z',
  });
  // PINNED honest values — never caller inputs.
  assert.equal(evidence.class, 'source_fact');
  assert.equal(evidence.quality, 'C');
  assert.equal(evidence.confidence, null);
  assert.equal(evidence.supersedesEvidenceId, null);
  assert.equal(evidence.workspaceId, null);
  assert.equal(evidence.contentRef, null);
  // The METRIC-001 source/reference mapping: the provider id becomes an
  // opaque SOURCE REFERENCE (never a domain identity).
  assert.deepEqual(evidence.source, { system: 'integration:meta-ads', ref: 'meta:insights:23840001:2026-01-15:spend' });
  // The observation timestamp (when the fact was true).
  assert.equal(evidence.observedAt, '2026-01-15T00:00:00.000Z');
  // Traceable content: the envelope plus the source metadata.
  assert.deepEqual(evidence.content, {
    adapterKey: 'meta-ads',
    operation: 'getInsights',
    providerRecordId: 'meta:insights:23840001:2026-01-15:spend',
    envelope: METRIC_RECORD.data,
    sourceTimestamp: '2026-01-15T00:00:00.000Z',
    etag: '"meta-insights-23840001-2026-01-15"',
    sourceVersion: null,
  });
});

test('METRIC-001 unit: a record without a source timestamp falls back to the honest retrieval moment', () => {
  const evidence = buildEvidenceAppendInput({
    clientId: 'client-1',
    adapterKey: 'crm',
    operation: 'listContacts',
    record: { ...RECORD_RECORD, sourceTimestamp: null },
    fallbackObservedAt: '2026-09-11T10:00:00.000Z',
  });
  assert.equal(evidence.observedAt, '2026-09-11T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// The record → metric observation mapping (METRIC-001 core)
// ---------------------------------------------------------------------------

test('METRIC-001 unit: the metric observation append maps source/timestamp/reference EXACTLY', () => {
  const input = buildMetricObservationAppendInput({
    clientId: 'client-1',
    adapterKey: 'meta-ads',
    record: METRIC_RECORD,
    envelope: envelopeOf(METRIC_RECORD),
    retrievedAt: '2026-09-11T10:00:01.000Z',
    fallbackObservedAt: '2026-09-11T10:00:01.000Z',
    evidenceId: 'ev-1',
  });
  // The source mapping: system namespaced by the adapter key, ref = the
  // provider record id (the provider report identity as an opaque
  // reference — never a domain identifier).
  assert.deepEqual(input.source, { system: 'integration:meta-ads', ref: 'meta:insights:23840001:2026-01-15:spend' });
  // The METRIC-001 timestamp pair: OBSERVATION (when true) vs RETRIEVAL
  // (when the platform saw it) kept DISTINCT.
  assert.equal(input.observedAt, '2026-01-15T00:00:00.000Z');
  assert.equal(input.retrievedAt, '2026-09-11T10:00:01.000Z');
  // The reference mapping: the observation cites its source fact.
  assert.equal(input.evidenceRef, 'ev-1');
  // The metric identity/value/unit/quality/aggregation from the envelope.
  assert.equal(input.metricName, 'meta.ads.spend');
  assert.deepEqual(input.dimensions, { campaignId: '23840001', campaignName: 'Spring Launch', date: '2026-01-15' });
  assert.equal(input.value, 128.45);
  assert.equal(input.unit, 'USD');
  assert.equal(input.quality, 'ok');
  assert.equal(input.aggregationMethod, 'sum');
  assert.equal(input.workspaceId, null);
});

// ---------------------------------------------------------------------------
// The delivery orchestration (evidence always; metrics for metric-shaped
// envelopes only; fail closed before any append)
// ---------------------------------------------------------------------------

interface SinkCall {
  readonly input: unknown;
  readonly provenance: unknown;
}

function fakeSinks() {
  const evidenceCalls: SinkCall[] = [];
  const metricCalls: SinkCall[] = [];
  const evidenceSink: IntegrationObservationEvidenceSink = {
    appendEvidence: async (input, provenance) => {
      evidenceCalls.push({ input, provenance });
      return { evidenceId: `ev-${evidenceCalls.length}` };
    },
  };
  const metricsSink: IntegrationObservationMetricsSink = {
    appendMetricObservation: async (input, provenance) => {
      metricCalls.push({ input, provenance });
      return { observationId: `obs-${metricCalls.length}` };
    },
  };
  return { evidenceCalls, metricCalls, evidenceSink, metricsSink };
}

test('MKT-024 unit: delivery appends ONE source fact per record and ONE observation only for metric envelopes', async () => {
  const { evidenceCalls, metricCalls, evidenceSink, metricsSink } = fakeSinks();
  const outcome = await deliverReadObservations({
    clientId: 'client-1',
    adapterKey: 'meta-ads',
    operation: 'getInsights',
    records: [METRIC_RECORD, RECORD_RECORD],
    nowIso: () => '2026-09-11T10:00:00.000Z',
    evidenceSink,
    metricsSink,
    provenance: { actor: 'user:test', correlationId: 'corr-1', causationId: null },
  });
  assert.equal(evidenceCalls.length, 2, 'every record appends exactly one source fact');
  assert.equal(metricCalls.length, 1, 'only the metric-shaped record appends an observation');
  assert.equal(outcome.retrievedAt, '2026-09-11T10:00:00.000Z');
  assert.deepEqual(
    outcome.receipts.map((receipt) => [receipt.providerRecordId, receipt.observationId]),
    [
      ['meta:insights:23840001:2026-01-15:spend', 'obs-1'],
      ['crm:contact:cnt_0021', null],
    ],
  );
  // The recordedVia provenance is PINNED server-side to the integration label.
  assert.equal((evidenceCalls[0]!.provenance as { recordedVia: string }).recordedVia, 'integration:meta-ads');
  assert.equal((metricCalls[0]!.provenance as { recordedVia: string }).recordedVia, 'integration:meta-ads');
  // The metric observation cites the evidence row appended for the SAME record.
  assert.equal((metricCalls[0]!.input as { evidenceRef: string }).evidenceRef, 'ev-1');
});

test('MKT-024 unit (fail closed): a malformed envelope rejects the WHOLE delivery BEFORE any append', async () => {
  const { evidenceCalls, metricCalls, evidenceSink, metricsSink } = fakeSinks();
  const malformed: NormalizedProviderRecord = {
    ...RECORD_RECORD,
    data: { kind: 'metric', metricName: 'broken', value: 'not-a-number', unit: 'count', quality: 'ok' },
  };
  await assert.rejects(
    deliverReadObservations({
      clientId: 'client-1',
      adapterKey: 'meta-ads',
      operation: 'getInsights',
      records: [METRIC_RECORD, malformed],
      nowIso: () => '2026-09-11T10:00:00.000Z',
      evidenceSink,
      metricsSink,
      provenance: { actor: 'user:test', correlationId: 'corr-1', causationId: null },
    }),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  assert.equal(evidenceCalls.length, 0, 'NOTHING may be appended when any envelope is malformed');
  assert.equal(metricCalls.length, 0, 'NOTHING may be appended when any envelope is malformed');
});

test('MKT-024 unit: an empty record list delivers nothing (the honest empty read)', async () => {
  const { evidenceCalls, metricCalls, evidenceSink, metricsSink } = fakeSinks();
  const outcome = await deliverReadObservations({
    clientId: 'client-1',
    adapterKey: 'commerce-cms',
    operation: 'listOrders',
    records: [],
    nowIso: () => '2026-09-11T10:00:00.000Z',
    evidenceSink,
    metricsSink,
    provenance: { actor: 'user:test', correlationId: 'corr-1', causationId: null },
  });
  assert.deepEqual(outcome.receipts, []);
  assert.equal(evidenceCalls.length, 0);
  assert.equal(metricCalls.length, 0);
});
