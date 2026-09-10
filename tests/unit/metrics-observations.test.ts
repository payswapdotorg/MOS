/**
 * MKT-014 unit tests — the frozen metric data-quality taxonomy, the append
 * guards (validation + timestamp semantics), the provenance guard and the
 * canonical owner-context composer (pure functions, no DB).
 *
 * Proofs (METRIC-001 "source/timestamp/reference mapping";
 * spec/implementation-contract.md §15):
 *   - the data-quality taxonomy is exactly the 5 frozen statuses, every
 *     status carries an interpretable meaning (traceability) and
 *     isKnownMetricQuality rejects everything outside the closed set
 *     (extension is a code+DB change, never a caller freedom);
 *   - the append guard enforces the frozen metric-observation shapes at the
 *     authority boundary: non-empty bounded metric identity, scalar-only
 *     bounded dimensions, finite value, non-empty bounded unit, bounded
 *     source descriptor, real observedAt/retrievedAt timestamps, §21
 *     material-key rejection on dimension keys, closed quality set and
 *     bounded aggregation method;
 *   - the METRIC-001 timestamp pair is SEMANTICALLY distinct: observedAt
 *     (caller-declared, when the metric was true) and retrievedAt (null →
 *     server-stamped, when the platform saw it) are separate input/output
 *     dimensions, and the record keeps both distinct from the provenance
 *     recordedAt — three timestamps, three meanings;
 *   - the provenance guard fails closed on incomplete server-derived
 *     provenance (provenance is never defaulted from caller input);
 *   - the insert-conflict classifier recognizes ONLY the cross-tenant
 *     evidence-linkage trigger failure;
 *   - composeMetricOwnerContext derives the canonical scope from the CLIENT
 *     OWNERSHIP and the observation record only (never from caller input)
 *     and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRIC_QUALITY_MEANINGS,
  METRIC_QUALITY_STATUSES,
  assertValidMetricObservationAppend,
  assertValidMetricProvenance,
  classifyMetricInsertConflict,
  composeMetricOwnerContext,
  isKnownMetricQuality,
  type MetricObservationAppendInput,
  type MetricObservationRecord,
  type MetricsClientOwnershipSnapshot,
  type MetricsWorkspaceOwnershipSnapshot,
} from '../../src/modules/metrics/public.ts';

test('the data-quality taxonomy is exactly the 5 frozen statuses with interpretable meanings', () => {
  assert.deepEqual([...METRIC_QUALITY_STATUSES], ['ok', 'partial', 'estimated', 'restated', 'suspect']);
  for (const status of METRIC_QUALITY_STATUSES) {
    const meaning = METRIC_QUALITY_MEANINGS[status];
    assert.equal(typeof meaning, 'string', `status ${status} must carry a meaning`);
    assert.ok(meaning.length > 0, `status ${status} meaning must be non-empty (interpretable)`);
    assert.equal(isKnownMetricQuality(status), true);
  }
  // The set is closed: extension is a code + DB migration change, never a
  // caller freedom.
  for (const foreign of ['OK', 'unknown', 'good', '', 'restated ', 'partial-2', 'a', 'S']) {
    assert.equal(isKnownMetricQuality(foreign), false, `'${foreign}' must be rejected`);
  }
});

const validAppend: MetricObservationAppendInput = {
  clientId: 'client-1',
  workspaceId: null,
  metricName: 'ad_spend',
  dimensions: { channel: 'meta', country: 'GH' },
  value: 123.45,
  unit: 'USD',
  source: { system: 'meta-ads', ref: 'report/2026-01-15' },
  observedAt: '2026-01-15T10:30:00.000Z',
  retrievedAt: null,
  evidenceRef: null,
  quality: 'ok',
  aggregationMethod: null,
};

test('the append guard accepts a well-formed observation for every quality status', () => {
  for (const status of METRIC_QUALITY_STATUSES) {
    assert.doesNotThrow(
      () => assertValidMetricObservationAppend({ ...validAppend, quality: status }),
      `quality ${status}`,
    );
  }
  // Dimensionless totals, boolean/number dimension values, internal source
  // with an evidence reference and a server-supplied retrieval moment are
  // all well-formed inputs.
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({ ...validAppend, dimensions: {} }),
  );
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({
      ...validAppend,
      dimensions: { enabled: true, rank: 3, label: 'q1' },
    }),
  );
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({
      ...validAppend,
      source: { system: 'internal', ref: null },
      evidenceRef: '0192aaaa-bbbb-4ccc-8ddd-eeeeffff0001',
      retrievedAt: '2026-01-15T11:00:00.000Z',
    }),
  );
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({ ...validAppend, aggregationMethod: 'daily_sum' }),
  );
});

test('the append guard rejects every malformed shape (fail closed)', () => {
  const rejects = (input: MetricObservationAppendInput, needle: string): void => {
    assert.throws(
      () => assertValidMetricObservationAppend(input),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const rendered = [
          error.message,
          ...(('details' in error ? (error.details ?? []) : []) as string[]),
        ].join('\n');
        assert.ok(rendered.includes(needle), `expected '${rendered}' to mention '${needle}'`);
        return true;
      },
    );
  };
  rejects({ ...validAppend, metricName: '' }, 'metricName');
  rejects({ ...validAppend, metricName: 'x'.repeat(201) }, 'metricName');
  rejects(
    { ...validAppend, dimensions: 'not-an-object' as unknown as Record<string, never> },
    'dimensions: must be a JSON object',
  );
  rejects(
    { ...validAppend, dimensions: ['a', 'b'] as unknown as Record<string, never> },
    'dimensions: must be a JSON object',
  );
  rejects(
    {
      ...validAppend,
      dimensions: { channel: { nested: 'objects are not dimension values' } } as unknown as Record<
        string,
        never
      >,
    },
    'dimension values must be scalars',
  );
  rejects(
    {
      ...validAppend,
      dimensions: { channel: ['list', 'values'] } as unknown as Record<string, never>,
    },
    'dimension values must be scalars',
  );
  const tooManyKeys: Record<string, string> = {};
  for (let i = 0; i < 21; i += 1) tooManyKeys[`dim_${i}`] = 'v';
  rejects({ ...validAppend, dimensions: tooManyKeys }, 'at most 20 dimension keys');
  rejects(
    { ...validAppend, dimensions: { ['x'.repeat(101)]: 'v' } },
    'dimension keys must be between 1 and 100',
  );
  rejects(
    { ...validAppend, dimensions: { channel: 'x'.repeat(257) } },
    'string dimension values must be at most 256',
  );
  rejects({ ...validAppend, value: Number.NaN }, 'value: must be a finite number');
  rejects(
    { ...validAppend, value: Number.POSITIVE_INFINITY },
    'value: must be a finite number',
  );
  rejects(
    { ...validAppend, value: '12.5' as unknown as number },
    'value: must be a finite number',
  );
  rejects({ ...validAppend, unit: '' }, 'unit');
  rejects({ ...validAppend, unit: 'x'.repeat(65) }, 'unit');
  rejects({ ...validAppend, source: { system: '', ref: null } }, 'source.system');
  rejects({ ...validAppend, source: { system: 'x'.repeat(101), ref: null } }, 'source.system');
  rejects({ ...validAppend, source: { system: 'meta-ads', ref: '' } }, 'source.ref');
  rejects({ ...validAppend, observedAt: 'not-a-timestamp' }, 'observedAt');
  rejects(
    { ...validAppend, retrievedAt: 'not-a-timestamp' },
    'retrievedAt: must be a real ISO 8601 timestamp',
  );
  rejects({ ...validAppend, evidenceRef: '' }, 'evidenceRef');
  rejects(
    { ...validAppend, quality: 'great' as unknown as MetricObservationAppendInput['quality'] },
    'frozen metric data-quality statuses',
  );
  rejects({ ...validAppend, aggregationMethod: '' }, 'aggregationMethod');
  rejects({ ...validAppend, aggregationMethod: 'x'.repeat(101) }, 'aggregationMethod');
});

test('the §21 material-key backstop rejects secret-shaped dimension keys (single shared guard from /evidence)', () => {
  const rejects = (dimensions: Record<string, unknown>): void => {
    assert.throws(
      () =>
        assertValidMetricObservationAppend({
          ...validAppend,
          dimensions: dimensions as Record<string, string | number | boolean>,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const rendered = [
          error.message,
          ...(('details' in error ? (error.details ?? []) : []) as string[]),
        ].join('\n');
        assert.ok(rendered.includes('§21'), `expected '${rendered}' to mention '§21'`);
        return true;
      },
    );
  };
  rejects({ secret: 'x' });
  // The shared guard is case-insensitive on keys and checks every key.
  rejects({ channel: 'meta', apiKey: 'never-in-metrics' });
  rejects({ Password: 'x' });
  rejects({ nested: { token: 'deep' } } as unknown as Record<string, unknown>);
});

test('the METRIC-001 timestamp pair is semantically distinct (observation time vs retrieval time vs recording time)', () => {
  // observedAt (caller-declared, when the metric was true) ...
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({ ...validAppend, observedAt: '2026-01-15T10:30:00.000Z' }),
  );
  // ... is validated INDEPENDENTLY from retrievedAt (server-side emitters
  // may pass the platform-saw moment; the HTTP path passes null and the
  // module stamps its clock).
  assert.doesNotThrow(() =>
    assertValidMetricObservationAppend({
      ...validAppend,
      observedAt: '2026-01-15T10:30:00.000Z',
      retrievedAt: '2026-01-16T08:00:00.000Z',
    }),
  );
  // Both must be REAL timestamps — a malformed value in either is rejected
  // by its own field name (distinct validations, never collapsed).
  const observedBroken = assertThrowsDetails(() =>
    assertValidMetricObservationAppend({ ...validAppend, observedAt: 'junk' }),
  );
  assert.ok(observedBroken.some((detail) => detail.startsWith('observedAt:')));
  assert.ok(!observedBroken.some((detail) => detail.startsWith('retrievedAt:')));
  const retrievedBroken = assertThrowsDetails(() =>
    assertValidMetricObservationAppend({ ...validAppend, retrievedAt: 'junk' }),
  );
  assert.ok(retrievedBroken.some((detail) => detail.startsWith('retrievedAt:')));
  assert.ok(!retrievedBroken.some((detail) => detail.startsWith('observedAt:')));

  // The RECORD shape carries all three timestamps as SEPARATE fields with
  // separate meanings: observedAt (source truth), retrievedAt (platform
  // ingestion), provenance.recordedAt (row recording) — the owner-context
  // composition below preserves all three without collapsing any pair.
  const record = metricRecordFixture();
  assert.notEqual(record.observedAt, record.retrievedAt);
  assert.notEqual(record.retrievedAt, record.provenance.recordedAt);
  assert.notEqual(record.observedAt, record.provenance.recordedAt);
  const context = composeMetricOwnerContext(record, clientOwnership, null, '2026-01-20');
  assert.equal(context.observation.observedAt, record.observedAt);
  assert.equal(context.observation.retrievedAt, record.retrievedAt);
  assert.equal(context.observation.provenance.recordedAt, record.provenance.recordedAt);
});

test('the provenance guard fails closed on incomplete server-derived provenance', () => {
  const complete = {
    actor: 'user:0192-uuid',
    recordedVia: 'api',
    correlationId: 'corr-1',
    causationId: null,
  };
  assert.doesNotThrow(() => assertValidMetricProvenance(complete));
  assert.doesNotThrow(() => assertValidMetricProvenance({ ...complete, causationId: 'job-9' }));

  for (const broken of [
    { ...complete, actor: '' },
    { ...complete, recordedVia: '' },
    { ...complete, recordedVia: 'x'.repeat(101) },
    { ...complete, correlationId: '' },
    { ...complete, causationId: '' },
  ]) {
    assert.throws(
      () => assertValidMetricProvenance(broken),
      /provenance is server-derived and must be complete/,
    );
  }
});

test('the insert-conflict classifier recognizes only the cross-tenant evidence-linkage trigger', () => {
  assert.equal(classifyMetricInsertConflict(null), null);
  assert.equal(classifyMetricInsertConflict(new Error('unrelated')), null);
  assert.equal(
    classifyMetricInsertConflict({ code: '23505', constraint: 'other_fence' }),
    null,
  );
  assert.equal(
    classifyMetricInsertConflict({
      code: 'P0001',
      message: 'metric observation x evidence_ref y belongs to another client — cross-tenant evidence linkage is rejected',
    }),
    'evidence-ref-client',
  );
  assert.equal(
    classifyMetricInsertConflict({
      code: '23505',
      message: 'duplicate key value violates unique constraint',
    }),
    null,
  );
});

const clientOwnership: MetricsClientOwnershipSnapshot = {
  scope: { kind: 'client', agencyId: 'agency-1', clientId: 'client-1' },
  client: {
    clientId: 'client-1',
    agencyId: 'agency-1',
    status: 'active',
  },
};

const scopedWorkspace: MetricsWorkspaceOwnershipSnapshot = {
  workspace: {
    workspaceId: 'workspace-1',
    clientId: 'client-1',
    status: 'active',
  },
};

function metricRecordFixture(): MetricObservationRecord {
  return {
    observationId: 'observation-1',
    clientId: 'client-1',
    workspaceId: null,
    metricName: 'ad_spend',
    dimensions: { channel: 'meta' },
    value: 123.45,
    unit: 'USD',
    source: { system: 'meta-ads', ref: 'report/2026-01-15' },
    observedAt: '2026-01-15T10:30:00.000Z',
    retrievedAt: '2026-01-16T08:00:00.000Z',
    evidenceRef: null,
    quality: 'ok',
    aggregationMethod: null,
    provenance: {
      actor: 'user:user-9',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
      recordedAt: '2026-01-16T08:00:01.000Z',
    },
  };
}

test('composeMetricOwnerContext derives the canonical scope from durable ownership only', () => {
  const record = metricRecordFixture();
  const context = composeMetricOwnerContext(record, clientOwnership, null, '2026-01-17');
  assert.deepEqual(context.scope, {
    kind: 'metric',
    agencyId: 'agency-1',
    clientId: 'client-1',
    workspaceId: null,
    observationId: 'observation-1',
  });
  assert.equal(context.clientOwnership, clientOwnership);
  assert.equal(context.workspace, null);
  assert.equal(context.observation, record);

  // Workspace-scoped observation: the workspace ownership snapshot rides
  // along.
  const scoped = composeMetricOwnerContext(
    { ...record, workspaceId: 'workspace-1' },
    clientOwnership,
    scopedWorkspace,
    '2026-01-17',
  );
  assert.equal(scoped.scope.workspaceId, 'workspace-1');
  assert.equal(scoped.workspace, scopedWorkspace);

  // The scope is derived from the CLIENT OWNERSHIP agency and the record's
  // own ownership fields — a caller-supplied agency id appears nowhere in
  // the composition inputs.
  assert.equal(scoped.scope.agencyId, clientOwnership.scope.agencyId);
});

test('composeMetricOwnerContext is pure — identical inputs compose identical outputs', () => {
  const record = metricRecordFixture();
  const first = composeMetricOwnerContext(record, clientOwnership, null, 't');
  const second = composeMetricOwnerContext(record, clientOwnership, null, 't');
  assert.deepEqual(first, second);
});

/** Captures the typed error details of a guard rejection. */
function assertThrowsDetails(action: () => void): string[] {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof Error);
    return (('details' in error ? (error.details ?? []) : []) as string[]).slice();
  }
  assert.fail('expected the guard to reject');
  return [];
}
