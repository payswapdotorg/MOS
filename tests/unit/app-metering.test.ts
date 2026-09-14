/**
 * MKT-052 unit tests — the App Metering and Commercial Attribution
 * contract as PURE functions (spec/mos-app-ecosystem-v1.5.md "Economics";
 * spec/effective-backlog-v1.5.md MKT-052; spec/architecture-lock-v1.5.md
 * #13 + the financial-authority separation posture).
 *
 * Acceptance mapping (the MKT-052 unit-test scope: the metering
 * vocabulary, the invocation attribution linkage, the aggregation
 * derivations, the input guards and the version discipline):
 *   - THE METERING VOCABULARY (AC-2): the five spec dimensions with
 *     their EXPLICIT per-dimension units (the closed /apps registry set —
 *     there is NO second dimension vocabulary), the versioned vocabulary
 *     and calculation constants (the pi-calc-v1 discipline: versioned,
 *     never silently re-stated) and the disclosed assumption record;
 *   - THE INVOCATION ATTRIBUTION LINKAGE (AC-3): the frozen
 *     dependency-declared current-selection rule — exactly ONE declaring
 *     app attributes; ZERO matches and MULTIPLE matches are DISCLOSED
 *     UNATTRIBUTED (never split, never dropped); the REAL semver range
 *     comparison (1.10.0 > 1.9.0 — never text ordering);
 *   - THE AGGREGATION DERIVATIONS (AC-3/AC-8): the raw per-dimension
 *     totals (the ground truth), the UTC calendar-month period bucketing
 *     on the SOURCE's own occurredAt, the per-app attribution
 *     aggregation with current-selection counts, the per-publisher
 *     rollup and the honest unattributed remainder;
 *   - THE INPUT GUARDS (AC-1): the observation input (the three
 *     ingestible usage dimensions only, bounded quantities, the
 *     per-dimension payload shapes, the reserved 'collect:' prefix
 *     rejection), the collection input and the provenance block — 422s
 *     with zero state touched;
 *   - THE VERSION DISCIPLINE (AC-2/AC-8): the deterministic §8 create
 *     fingerprints + collect keys (divergent on content change), the
 *     replay-or-conflict convergence and the calculation disclosure
 *     composition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_METERING_ASSUMPTIONS,
  APP_METERING_ATTRIBUTION_CALCULATION_VERSION,
  APP_METERING_COLLECT_KEY_PREFIX,
  APP_METERING_INGESTIBLE_DIMENSIONS,
  APP_METERING_SOURCE_KINDS,
  APP_METERING_UNITS,
  APP_METERING_UNIT_MEANINGS,
  APP_METERING_VOCABULARY_VERSION,
  aggregateDimensionTotals,
  aggregatePerAppAttribution,
  aggregatePerPublisher,
  attributeInvocationToApp,
  buildAppAttribution,
  composeAppMeteringCalculationDisclosure,
  groupByPeriod,
  meteringPeriodStartOf,
  unitOfDimension,
  unattributedInvocationsOf,
  type AppMeterEventSlice,
  type AppMeteringDimension,
  type AppMeteringSourceKind,
} from '../../src/modules/app-metering/public.ts';
import {
  APP_METERING_MATERIAL_SHAPED_KEYS,
  appMeterObservationCreateFingerprint,
  assertValidMeteringProvenance,
  assertValidObservationInput,
  assertValidWorkspaceMeteringInput,
  classifyAppMeteringWriteConflict,
  collectInstallSelectionKey,
  collectInvocationKey,
  replayOrConflict,
} from '../../src/modules/app-metering/public.ts';
import { APP_METERING_DIMENSIONS } from '../../src/modules/apps/public.ts';
import { IdempotencyConflictError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// The metering vocabulary (the ONE frozen dimension set — no second
// vocabulary; every dimension carries an EXPLICIT unit)
// ---------------------------------------------------------------------------

test('MKT-052 unit: the dimension vocabulary is exactly the spec\'s five Economics dimensions with explicit units', () => {
  // mos-app-ecosystem-v1.5.md "Economics", verbatim: "MOS may meter
  // installations, invocation count, compute/runtime, data volume and
  // premium capabilities."
  assert.deepEqual(APP_METERING_DIMENSIONS, [
    'installations',
    'invocations',
    'compute-runtime',
    'data-volume',
    'premium-capabilities',
  ]);
  // The per-dimension unit mapping — one canonical unit each, each with
  // an interpretable meaning.
  for (const dimension of APP_METERING_DIMENSIONS) {
    const unit = APP_METERING_UNITS[dimension];
    assert.ok(unit !== undefined, `dimension '${dimension}' has a unit`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(APP_METERING_UNIT_MEANINGS, unit),
      `unit '${unit}' has an interpretable meaning`,
    );
    assert.equal(unitOfDimension(dimension), unit, 'the pure unit lookup agrees');
  }
  // The unit set is exactly five canonical units.
  assert.deepEqual([...new Set(Object.values(APP_METERING_UNITS))].sort(), [
    'bytes',
    'capability-uses',
    'invocations',
    'milliseconds',
    'selections',
  ]);
});

test('MKT-052 unit: the version discipline is pinned — the vocabulary version and the attribution calculation version are frozen constants', () => {
  assert.equal(APP_METERING_VOCABULARY_VERSION, 'am-meter-v1');
  assert.equal(APP_METERING_ATTRIBUTION_CALCULATION_VERSION, 'am-attrib-v1');
  // The ingestible dimensions are exactly the three runtime-usage
  // dimensions (the installations/invocations dimensions are
  // collection-only — they meter the real ledger rows once per source).
  assert.deepEqual(APP_METERING_INGESTIBLE_DIMENSIONS, [
    'compute-runtime',
    'data-volume',
    'premium-capabilities',
  ]);
  // The source-kind vocabulary.
  assert.deepEqual(APP_METERING_SOURCE_KINDS, [
    'app-install-selection',
    'extension-invocation',
    'observed-usage',
  ]);
  // The reserved collection prefix.
  assert.equal(APP_METERING_COLLECT_KEY_PREFIX, 'collect:');
  // The disclosed assumption record: every frozen derivation assumption
  // pinned (changing ANY value is a version bump — never silent).
  assert.deepEqual(APP_METERING_ASSUMPTIONS, {
    installationUnit: 'one-per-selection-row',
    currentInstallationBasis: 'active-selection-rows',
    invocationAppAttribution: 'dependency-declared-current-selection',
    unattributedInvocationPolicy: 'disclosed-unattributed',
    periodBasis: 'source-occurred-at-utc-calendar-month',
    premiumCapabilityBasis: 'manifest-declared-capability-usage-observations',
    usageQuantityBasis: 'runtime-host-reported-observations',
  });
});

// ---------------------------------------------------------------------------
// The invocation attribution linkage (the frozen disclosed assumption)
// ---------------------------------------------------------------------------

const EXTENSION_FACTS = {
  extensionPublisher: 'payswap-labs',
  extensionKey: 'audience-enricher',
  extensionVersion: '1.10.0',
} as const;

function selectionFixture(appKey: string, deps: Array<[string | null, string, string, string]>): {
  readonly appKey: string;
  readonly appVersionId: string;
  readonly version: string;
  readonly dependencies: ReadonlyArray<{
    readonly kind: string;
    readonly publisher: string | null;
    readonly key: string;
    readonly minVersion: string;
    readonly maxVersion: string;
  }>;
} {
  return {
    appKey,
    appVersionId: `version-${appKey}`,
    version: '1.0.0',
    dependencies: deps.map(([publisher, key, minVersion, maxVersion]) => ({
      kind: 'extension',
      publisher,
      key,
      minVersion,
      maxVersion,
    })),
  };
}

test('MKT-052 unit: the linkage attributes an invocation to the ONE current selection whose dependency range matches (REAL semver)', () => {
  const selections = [
    selectionFixture('report-renderer', [['payswap-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
    selectionFixture('crm-sync', [['other-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
  ];
  // 1.10.0 is inside [1.0.0 .. 2.0.0] with REAL semver comparison
  // (1.10.0 > 1.9.0 — text ordering would call 1.10.0 < 1.9.0).
  const verdict = attributeInvocationToApp(EXTENSION_FACTS, selections);
  assert.ok('appKey' in verdict, 'exactly one declaring app attributes');
  assert.equal(verdict.appKey, 'report-renderer');
});

test('MKT-052 unit: zero matches are DISCLOSED UNATTRIBUTED with the honest reason', () => {
  const selections = [
    // Wrong publisher.
    selectionFixture('crm-sync', [['other-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
    // Wrong key.
    selectionFixture('seo-boost', [['payswap-labs', 'keyword-research', '1.0.0', '2.0.0']]),
    // Version outside the range.
    selectionFixture('legacy-portal', [['payswap-labs', 'audience-enricher', '1.0.0', '1.5.0']]),
    // Not an extension dependency.
    selectionFixture('pack-app', [['payswap-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
  ];
  (selections[3]!.dependencies as unknown[])[0] = {
    kind: 'app',
    publisher: 'payswap-labs',
    key: 'audience-enricher',
    minVersion: '1.0.0',
    maxVersion: '2.0.0',
  };
  const verdict = attributeInvocationToApp(EXTENSION_FACTS, selections);
  assert.ok('unattributed' in verdict, 'zero matches → disclosed unattributed');
  assert.ok(verdict.reason.includes('no current app selection'), 'the honest zero-match reason');
});

test('MKT-052 unit: MULTIPLE matches are DISCLOSED UNATTRIBUTED — never split', () => {
  const selections = [
    selectionFixture('report-renderer', [['payswap-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
    selectionFixture('analytics-suite', [['payswap-labs', 'audience-enricher', '1.0.0', '2.0.0']]),
  ];
  const verdict = attributeInvocationToApp(EXTENSION_FACTS, selections);
  assert.ok('unattributed' in verdict, 'multiple matches → disclosed unattributed');
  assert.ok(verdict.reason.includes('multiple current app selections'), 'the honest ambiguity reason');
  assert.ok(
    verdict.reason.includes('analytics-suite') && verdict.reason.includes('report-renderer'),
    'the reason names every ambiguous candidate',
  );
});

// ---------------------------------------------------------------------------
// The aggregation derivations (pure)
// ---------------------------------------------------------------------------

function eventFixture(input: {
  readonly dimension: AppMeteringDimension;
  readonly quantity: number;
  readonly sourceKind: AppMeteringSourceKind;
  readonly sourceId: string;
  readonly appKey: string | null;
  readonly occurredAt: string;
  readonly workspaceId?: string;
}): AppMeterEventSlice {
  return {
    dimension: input.dimension,
    unit: unitOfDimension(input.dimension),
    quantity: input.quantity,
    workspaceId: input.workspaceId ?? 'ws-1',
    appKey: input.appKey,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurredAt: input.occurredAt,
  };
}

test('MKT-052 unit: the RAW per-dimension totals aggregate quantities + event counts (the ground truth shape)', () => {
  const events = [
    eventFixture({ dimension: 'installations', quantity: 1, sourceKind: 'app-install-selection', sourceId: 'i-1', appKey: 'report-renderer', occurredAt: '2026-09-01T10:00:00.000Z' }),
    eventFixture({ dimension: 'installations', quantity: 1, sourceKind: 'app-install-selection', sourceId: 'i-2', appKey: 'report-renderer', occurredAt: '2026-09-02T10:00:00.000Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-1', appKey: null, occurredAt: '2026-09-03T10:00:00.000Z' }),
    eventFixture({ dimension: 'compute-runtime', quantity: 500, sourceKind: 'observed-usage', sourceId: 'v-1', appKey: 'report-renderer', occurredAt: '2026-09-03T10:00:00.000Z' }),
    eventFixture({ dimension: 'data-volume', quantity: 2048, sourceKind: 'observed-usage', sourceId: 'v-1', appKey: 'report-renderer', occurredAt: '2026-09-03T10:00:00.000Z' }),
    eventFixture({ dimension: 'premium-capabilities', quantity: 3, sourceKind: 'observed-usage', sourceId: 'v-1', appKey: 'report-renderer', occurredAt: '2026-09-03T10:00:00.000Z' }),
  ];
  const totals = aggregateDimensionTotals(events);
  assert.deepEqual(totals, [
    { dimension: 'installations', unit: 'selections', quantity: 2, eventCount: 2 },
    { dimension: 'invocations', unit: 'invocations', quantity: 1, eventCount: 1 },
    { dimension: 'compute-runtime', unit: 'milliseconds', quantity: 500, eventCount: 1 },
    { dimension: 'data-volume', unit: 'bytes', quantity: 2048, eventCount: 1 },
    { dimension: 'premium-capabilities', unit: 'capability-uses', quantity: 3, eventCount: 1 },
  ]);
  // The empty slice is the honest empty set.
  assert.deepEqual(aggregateDimensionTotals([]), []);
  // Purity: the input array is untouched.
  assert.equal(events.length, 6);
});

test('MKT-052 unit: period bucketing uses the SOURCE\'s OWN occurredAt in UTC calendar months, oldest first', () => {
  const events = [
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-1', appKey: null, occurredAt: '2026-10-31T23:59:59.999Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-2', appKey: null, occurredAt: '2026-11-01T00:00:00.000Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-3', appKey: null, occurredAt: '2026-11-30T12:00:00.000Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-4', appKey: null, occurredAt: '2026-09-15T00:00:00.000Z' }),
  ];
  const periods = groupByPeriod(events);
  assert.deepEqual(
    periods.map((row) => row.periodStart),
    ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    'three UTC month buckets, oldest first',
  );
  assert.deepEqual(periods[2]!.dimensions, [
    { dimension: 'invocations', unit: 'invocations', quantity: 2, eventCount: 2 },
  ]);
  // The pure bucket function.
  assert.equal(meteringPeriodStartOf('2026-09-30T23:59:59.999Z'), '2026-09-01T00:00:00.000Z');
  assert.equal(meteringPeriodStartOf('2026-12-01T00:00:00.000Z'), '2026-12-01T00:00:00.000Z');
});

test('MKT-052 unit: the per-app attribution aggregates attributed slices with current-selection counts and registry publishers', () => {
  const events = [
    eventFixture({ dimension: 'installations', quantity: 1, sourceKind: 'app-install-selection', sourceId: 'i-1', appKey: 'report-renderer', occurredAt: '2026-09-01T10:00:00.000Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-1', appKey: null, occurredAt: '2026-09-03T10:00:00.000Z' }),
    eventFixture({ dimension: 'invocations', quantity: 1, sourceKind: 'extension-invocation', sourceId: 'v-2', appKey: null, occurredAt: '2026-09-04T10:00:00.000Z' }),
    eventFixture({ dimension: 'compute-runtime', quantity: 750, sourceKind: 'observed-usage', sourceId: 'v-1', appKey: 'report-renderer', occurredAt: '2026-09-03T10:00:00.000Z' }),
    eventFixture({ dimension: 'installations', quantity: 1, sourceKind: 'app-install-selection', sourceId: 'i-9', appKey: 'crm-sync', occurredAt: '2026-09-05T10:00:00.000Z' }),
  ];
  const attributionBySource = new Map<string, string | null>([
    ['app-install-selection:i-1', 'report-renderer'],
    ['extension-invocation:v-1', 'report-renderer'],
    ['extension-invocation:v-2', null], // unattributed — never dropped from raw totals
    ['observed-usage:v-1', 'report-renderer'],
    ['app-install-selection:i-9', 'crm-sync'],
  ]);
  const perApp = aggregatePerAppAttribution({
    events,
    attributionBySource,
    currentSelectionCounts: new Map<string, number>([['report-renderer', 2], ['crm-sync', 1]]),
    publishers: new Map<string, string>([['report-renderer', 'dev:dev-1']]),
  });
  assert.equal(perApp.length, 2, 'the unattributed event belongs to NO app');
  // App-key-lexicographic ordering.
  assert.equal(perApp[0]!.appKey, 'crm-sync');
  assert.equal(perApp[1]!.appKey, 'report-renderer');
  const reporter = perApp[1]!;
  assert.equal(reporter.publisher, 'dev:dev-1');
  assert.equal(reporter.currentSelectionCount, 2);
  assert.deepEqual(reporter.dimensions, [
    { dimension: 'installations', unit: 'selections', quantity: 1, eventCount: 1 },
    { dimension: 'invocations', unit: 'invocations', quantity: 1, eventCount: 1 },
    { dimension: 'compute-runtime', unit: 'milliseconds', quantity: 750, eventCount: 1 },
  ]);
  // The single-app composition helper agrees.
  const direct = buildAppAttribution({
    appKey: 'report-renderer',
    publisher: 'dev:dev-1',
    attributedEvents: events.filter((event) =>
      ['app-install-selection:i-1', 'extension-invocation:v-1', 'observed-usage:v-1'].includes(
        `${event.sourceKind}:${event.sourceId}`,
      ),
    ),
    currentSelectionCount: 2,
  });
  assert.deepEqual(direct.dimensions, reporter.dimensions);
});

test('MKT-052 unit: the unattributed remainder is the honest disclosure (counted, never dropped, never split)', () => {
  const none = unattributedInvocationsOf({
    invocationAttribution: new Map([['v-1', 'report-renderer'], ['v-2', 'crm-sync']]),
  });
  assert.equal(none.count, 0);
  assert.equal(none.policy, 'disclosed-unattributed');
  assert.ok(none.reason.includes('attributed to exactly one'));

  const some = unattributedInvocationsOf({
    invocationAttribution: new Map<string, string | null>([
      ['v-1', 'report-renderer'],
      ['v-2', null],
      ['v-3', null],
    ]),
  });
  assert.equal(some.count, 2);
  assert.ok(some.reason.includes('never dropped, never split'));
});

test('MKT-052 unit: the per-publisher rollup sums the per-app rows, publisher-lexicographic', () => {
  const perApp = [
    {
      appKey: 'report-renderer',
      publisher: 'dev:dev-2',
      dimensions: [
        { dimension: 'installations' as AppMeteringDimension, unit: unitOfDimension('installations'), quantity: 3, eventCount: 3 },
      ],
    },
    {
      appKey: 'analytics-suite',
      publisher: 'dev:dev-2',
      dimensions: [
        { dimension: 'installations' as AppMeteringDimension, unit: unitOfDimension('installations'), quantity: 1, eventCount: 1 },
        { dimension: 'invocations' as AppMeteringDimension, unit: unitOfDimension('invocations'), quantity: 4, eventCount: 4 },
      ],
    },
    {
      appKey: 'crm-sync',
      publisher: null, // unresolvable lineage — excluded from publisher rows
      dimensions: [
        { dimension: 'installations' as AppMeteringDimension, unit: unitOfDimension('installations'), quantity: 1, eventCount: 1 },
      ],
    },
  ];
  const rows = aggregatePerPublisher({ perApp });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.publisher, 'dev:dev-2');
  assert.deepEqual(rows[0]!.appKeys, ['analytics-suite', 'report-renderer']);
  assert.deepEqual(rows[0]!.dimensions, [
    { dimension: 'installations', unit: 'selections', quantity: 4, eventCount: 4 },
    { dimension: 'invocations', unit: 'invocations', quantity: 4, eventCount: 4 },
  ]);
});

// ---------------------------------------------------------------------------
// The input guards (fail-closed 422s with zero state touched)
// ---------------------------------------------------------------------------

const VALID_OBSERVATION = {
  workspaceId: '01234567-89ab-cdef-0123-456789abcdef',
  appKey: 'report-renderer',
  dimension: 'compute-runtime',
  quantity: 500,
  capability: null,
  stateNamespace: null,
  sourceInvocationId: 'fedcba98-7654-3210-fedc-ba9876543210',
  idempotencyKey: 'usage-obs-1',
} as const;

test('MKT-052 unit: the observation input guard accepts the valid usage shapes (all three dimensions)', () => {
  assertValidObservationInput(VALID_OBSERVATION);
  assertValidObservationInput({
    ...VALID_OBSERVATION,
    dimension: 'data-volume',
    quantity: 2048,
    stateNamespace: 'app:report-renderer:docs',
  });
  assertValidObservationInput({
    ...VALID_OBSERVATION,
    dimension: 'premium-capabilities',
    quantity: 3,
    capability: 'render-report',
  });
});

test('MKT-052 unit: the observation input guard rejects the collection-only dimensions, bad quantities and payload-shape violations (422)', () => {
  // The collection-only dimensions are NOT ingestible — a usage
  // observation can never fabricate install/invocation counts.
  for (const dimension of ['installations', 'invocations'] as const) {
    assert.throws(
      () => assertValidObservationInput({ ...VALID_OBSERVATION, dimension }),
      (error: unknown) =>
        error instanceof InvalidRequestError &&
        error.message.includes('collection-only'),
      `dimension '${dimension}' must be rejected`,
    );
  }
  // Malformed identifiers + quantities.
  for (const bad of [
    { ...VALID_OBSERVATION, workspaceId: 'not-a-uuid' },
    { ...VALID_OBSERVATION, appKey: 'Bad_Key' },
    { ...VALID_OBSERVATION, quantity: 0 },
    { ...VALID_OBSERVATION, quantity: -1 },
    { ...VALID_OBSERVATION, quantity: 1.5 },
    { ...VALID_OBSERVATION, quantity: 1_000_000_000_000_000 + 1 },
    { ...VALID_OBSERVATION, sourceInvocationId: 'not-a-uuid' },
    { ...VALID_OBSERVATION, idempotencyKey: '' },
  ]) {
    assert.throws(() => assertValidObservationInput(bad), InvalidRequestError);
  }
  // Payload-shape violations: capability only on premium-capabilities;
  // stateNamespace only on data-volume; the reserved collect: prefix.
  assert.throws(
    () => assertValidObservationInput({ ...VALID_OBSERVATION, capability: 'render-report' }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('only premium-capabilities'),
  );
  assert.throws(
    () =>
      assertValidObservationInput({
        ...VALID_OBSERVATION,
        dimension: 'premium-capabilities',
        capability: null,
      }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('capability: required'),
  );
  assert.throws(
    () =>
      assertValidObservationInput({
        ...VALID_OBSERVATION,
        dimension: 'premium-capabilities',
        quantity: 1,
        capability: 'Bad Capability',
      }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidObservationInput({ ...VALID_OBSERVATION, stateNamespace: 'app:x:docs' }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('only data-volume'),
  );
  assert.throws(
    () =>
      assertValidObservationInput({
        ...VALID_OBSERVATION,
        dimension: 'data-volume',
        quantity: 1,
        stateNamespace: 'not-a-namespace',
      }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('stateNamespace'),
  );
  assert.throws(
    () => assertValidObservationInput({ ...VALID_OBSERVATION, idempotencyKey: 'collect:shadow' }),
    (error: unknown) => error instanceof InvalidRequestError && error.message.includes('reserved'),
  );
});

test('MKT-052 unit: the collection input + provenance guards (the server-derived block discipline)', () => {
  assertValidWorkspaceMeteringInput({ workspaceId: '01234567-89ab-cdef-0123-456789abcdef' });
  assert.throws(
    () => assertValidWorkspaceMeteringInput({ workspaceId: 'workspace-1' }),
    InvalidRequestError,
  );
  const validProvenance = {
    actor: 'service:metering-worker',
    recordedVia: 'module',
    correlationId: 'corr-1',
    causationId: null,
  };
  assertValidMeteringProvenance(validProvenance);
  for (const bad of [
    { ...validProvenance, actor: '' },
    { ...validProvenance, recordedVia: '' },
    { ...validProvenance, correlationId: '' },
    { ...validProvenance, causationId: '' },
  ]) {
    assert.throws(() => assertValidMeteringProvenance(bad), InvalidRequestError);
  }
  // The §21 material-shaped key list is exported (the module boundary's
  // backstop vocabulary).
  assert.ok(APP_METERING_MATERIAL_SHAPED_KEYS.includes('secret'));
  assert.ok(APP_METERING_MATERIAL_SHAPED_KEYS.includes('credentialValue'));
});

// ---------------------------------------------------------------------------
// The version discipline (fingerprints, collect keys, replay convergence)
// ---------------------------------------------------------------------------

test('MKT-052 unit: the §8 observation fingerprint is deterministic and divergent on content change', () => {
  const base = appMeterObservationCreateFingerprint({
    workspaceId: 'ws-1',
    appKey: 'report-renderer',
    dimension: 'compute-runtime',
    quantity: 500,
    capability: null,
    stateNamespace: null,
    sourceInvocationId: 'v-1',
  });
  assert.equal(
    appMeterObservationCreateFingerprint({
      workspaceId: 'ws-1',
      appKey: 'report-renderer',
      dimension: 'compute-runtime',
      quantity: 500,
      capability: null,
      stateNamespace: null,
      sourceInvocationId: 'v-1',
    }),
    base,
    'identical content → identical fingerprint',
  );
  for (const divergent of [
    { quantity: 501 },
    { dimension: 'data-volume' as const },
    { capability: 'render-report' },
    { stateNamespace: 'app:report-renderer:docs' },
    { sourceInvocationId: 'v-2' },
    { appKey: 'crm-sync' },
  ]) {
    assert.notEqual(
      appMeterObservationCreateFingerprint({
        workspaceId: 'ws-1',
        appKey: 'report-renderer',
        dimension: 'compute-runtime',
        quantity: 500,
        capability: null,
        stateNamespace: null,
        sourceInvocationId: 'v-1',
        ...divergent,
      }),
      base,
      `divergent content (${JSON.stringify(divergent)}) → a different fingerprint`,
    );
  }
});

test('MKT-052 unit: the deterministic collect keys use the reserved prefix (at-most-once by construction)', () => {
  assert.equal(collectInstallSelectionKey('i-1'), 'collect:app-install-selection:i-1');
  assert.equal(collectInvocationKey('v-1'), 'collect:extension-invocation:v-1');
});

test('MKT-052 unit: the §8 replay convergence — identical fingerprint converges, divergent reuse conflicts', () => {
  const recorded = {
    createFingerprint: 'fingerprint-a',
    event: 'recorded',
  };
  const converged = replayOrConflict('key-1', recorded, 'fingerprint-a');
  assert.ok(converged.replayed);
  assert.throws(
    () => replayOrConflict('key-1', recorded, 'fingerprint-b'),
    IdempotencyConflictError,
  );
  assert.equal(replayOrConflict('key-1', null, 'fingerprint-a').replayed, false);
});

test('MKT-052 unit: the write-conflict classification maps the database fences to domain conflicts', () => {
  assert.equal(
    classifyAppMeteringWriteConflict({
      code: '23505',
      constraint: 'app_metering_events_idempotency_key_unique',
    }),
    'idempotency-fence',
  );
  assert.equal(
    classifyAppMeteringWriteConflict({
      code: '23505',
      constraint: 'app_metering_events_source_once_fence',
    }),
    'source-once-fence',
  );
  assert.equal(classifyAppMeteringWriteConflict({ code: '23514' }), 'validation-backstop');
  assert.equal(classifyAppMeteringWriteConflict({ code: 'P0001' }), 'validation-backstop');
  assert.equal(classifyAppMeteringWriteConflict({ code: '42P07' }), null);
  assert.equal(classifyAppMeteringWriteConflict(new Error('boom')), null);
});

test('MKT-052 unit: the calculation disclosure composes the frozen versions + the full assumption record', () => {
  const disclosure = composeAppMeteringCalculationDisclosure();
  assert.equal(disclosure.calculationVersion, APP_METERING_ATTRIBUTION_CALCULATION_VERSION);
  assert.equal(disclosure.vocabularyVersion, APP_METERING_VOCABULARY_VERSION);
  assert.deepEqual(disclosure.assumptions, APP_METERING_ASSUMPTIONS);
  assert.equal(disclosure.basis, 'live-derivation-over-own-append-only-tail');
  assert.equal(disclosure.persistence, 'append-only-tail-plus-rebuildable-rollups');
});
