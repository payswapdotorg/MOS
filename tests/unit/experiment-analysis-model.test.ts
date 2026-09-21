/**
 * MKT-067 unit tests — the model surfaces of /experiment-analysis: the
 * input guards (the authority-boundary validation, computed-outcome
 * fields structurally absent), the canonical snapshot digests (the
 * reproducibility tokens), the observation selection filter (name +
 * declared-dimensions subset match, the reserved arm split, the window)
 * and the owner-context composition purity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY,
  computeAllocationSnapshotDigest,
  computeExperimentAnalysisSnapshotDigest,
  composeAllocationRecommendationOwnerContext,
  composeExperimentAnalysisOwnerContext,
  selectObservationsForAnalysis,
  assertValidExperimentAnalysisCreate,
  assertValidAllocationRecommendationCreate,
  assertValidExperimentAnalysisProvenance,
  type ExperimentAnalysisInputSnapshot,
  type ExperimentAllocationInputSnapshot,
} from '../../src/modules/experiment-analysis/public.ts';

// ---------------------------------------------------------------------------
// The create guards (fail-closed boundary validation)
// ---------------------------------------------------------------------------

const VALID_ANALYSIS_INPUT = {
  clientId: '11111111-1111-4111-8111-111111111111',
  workspaceId: null,
  experimentId: '22222222-2222-4222-8222-222222222222',
  windowStart: '2026-01-01T00:00:00.000Z',
  windowEnd: '2026-02-01T00:00:00.000Z',
  uncertaintyLevel: null,
  minObservationsPerArm: null,
  practicalThreshold: { value: 1, source: 'declared_input' as const, description: null },
  declaredConfounders: ['posting-time overlap'],
  declaredLimitations: [],
  evidenceRefs: [],
};

const NO_DIMENSIONS: Record<string, string | number | boolean> = {};

test('MKT-067: the analysis create guard accepts the valid shape and resolves nothing itself', () => {
  assertValidExperimentAnalysisCreate(VALID_ANALYSIS_INPUT, NO_DIMENSIONS);
  // The level/min fields accept the recorded levels and null (the module
  // resolves the defaults).
  assertValidExperimentAnalysisCreate(
    { ...VALID_ANALYSIS_INPUT, uncertaintyLevel: 0.99, minObservationsPerArm: 5 },
    NO_DIMENSIONS,
  );
});

test('MKT-067: the analysis create guard fails closed on every malformed shape (the complete problem list)', async () => {
  assert.throws(
    () =>
      assertValidExperimentAnalysisCreate(
        {
          ...VALID_ANALYSIS_INPUT,
          windowEnd: '2025-12-01T00:00:00.000Z',
          uncertaintyLevel: 0.8 as unknown as 0.9 | 0.95 | 0.99,
          minObservationsPerArm: 0,
          practicalThreshold: { value: -1, source: 'declared_input', description: '' },
          declaredConfounders: [''],
          evidenceRefs: [''],
        },
        NO_DIMENSIONS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      const problems = (error as InvalidRequestError).details ?? [];
      assert.ok(problems.some((problem) => problem.includes('windowEnd: must be strictly after windowStart')));
      assert.ok(problems.some((problem) => problem.includes('uncertaintyLevel:')));
      assert.ok(problems.some((problem) => problem.includes('minObservationsPerArm:')));
      assert.ok(problems.some((problem) => problem.includes('practicalThreshold:')));
      assert.ok(problems.some((problem) => problem.includes('declaredConfounders:')));
      assert.ok(problems.some((problem) => problem.includes('evidenceRefs:')));
      return true;
    },
  );
});

test('MKT-067: the reserved arm dimension fails closed — an experiment declaring it cannot be two-arm analyzed', async () => {
  assert.throws(
    () =>
      assertValidExperimentAnalysisCreate(
        VALID_ANALYSIS_INPUT,
        { platform: 'tiktok', arm: 'treatment' },
      ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(
        (error as InvalidRequestError).details?.some((problem) =>
          problem.includes(
            `'${EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY}' dimension key is reserved for the analysis arm split`,
          ),
        ),
      );
      return true;
    },
  );
});

const VALID_ALLOCATION_INPUT = {
  clientId: '11111111-1111-4111-8111-111111111111',
  workspaceId: null,
  experimentId: '22222222-2222-4222-8222-222222222222',
  analysisId: null,
  arms: [
    {
      armKey: 'short_form_video',
      kind: 'strategy_variant' as const,
      capacity: 100,
      sampleSize: 40,
      mean: 2.5,
      variance: 3,
    },
    {
      armKey: 'human_ugc',
      kind: 'human_treatment' as const,
      capacity: 0,
      sampleSize: 0,
      mean: 0,
      variance: 0,
    },
  ],
  explorationFloor: null,
};

test('MKT-067: the allocation create guard accepts the valid shape (zero capacity included)', () => {
  assertValidAllocationRecommendationCreate(VALID_ALLOCATION_INPUT);
  assertValidAllocationRecommendationCreate({
    ...VALID_ALLOCATION_INPUT,
    explorationFloor: 0.25,
  });
});

test('MKT-067: the allocation create guard fails closed on the closed vocabularies, grammar and bounds', async () => {
  assert.throws(
    () =>
      assertValidAllocationRecommendationCreate({
        ...VALID_ALLOCATION_INPUT,
        arms: [
          { armKey: 'UPPER', kind: 'robot_arm' as never, capacity: -1, sampleSize: 1.5, mean: Number.NaN, variance: -2 },
        ],
        explorationFloor: 0.9,
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      const problems = (error as InvalidRequestError).details ?? [];
      assert.ok(problems.some((problem) => problem.includes('must match ^[a-z][a-z0-9_-]{0,63}$')));
      assert.ok(problems.some((problem) => problem.includes('frozen arm kinds')));
      assert.ok(problems.some((problem) => problem.includes('capacity')));
      assert.ok(problems.some((problem) => problem.includes('sampleSize')));
      assert.ok(problems.some((problem) => problem.includes('mean')));
      assert.ok(problems.some((problem) => problem.includes('variance')));
      assert.ok(problems.some((problem) => problem.includes('explorationFloor:')));
      return true;
    },
  );

  // Duplicate arm keys fail closed.
  assert.throws(
    () =>
      assertValidAllocationRecommendationCreate({
        ...VALID_ALLOCATION_INPUT,
        arms: [
          VALID_ALLOCATION_INPUT.arms[0]!,
          { ...VALID_ALYSIS_INPUT_PLACEHOLDER },
        ],
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(
        (error as InvalidRequestError).details?.some((problem) =>
          problem.includes('declared more than once'),
        ),
      );
      return true;
    },
  );
});

// A second distinct arm for the duplicate-key proof (typed to satisfy the
// closed kind vocabulary).
const VALID_ALYSIS_INPUT_PLACEHOLDER = {
  armKey: 'short_form_video',
  kind: 'strategy_variant' as const,
  capacity: 1,
  sampleSize: 1,
  mean: 1,
  variance: 1,
};

test('MKT-067: an allocation over ZERO arms fails closed (meaningless), and empty arms array is rejected', async () => {
  assert.throws(
    () => assertValidAllocationRecommendationCreate({ ...VALID_ALLOCATION_INPUT, arms: [] }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(
        (error as InvalidRequestError).details?.some((problem) =>
          problem.includes('at least one declared arm is required'),
        ),
      );
      return true;
    },
  );
});

test('MKT-067: the provenance guard fails closed on incomplete server-derived provenance', async () => {
  assert.throws(
    () =>
      assertValidExperimentAnalysisProvenance({
        actor: '  ',
        recordedVia: '',
        correlationId: '',
        causationId: '',
      }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      const problems = (error as InvalidRequestError).details ?? [];
      assert.equal(problems.length, 4);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// The canonical snapshot digests (the reproducibility tokens)
// ---------------------------------------------------------------------------

const BASE_SNAPSHOT: ExperimentAnalysisInputSnapshot = {
  experiment: {
    experimentId: '22222222-2222-4222-8222-222222222222',
    clientId: '11111111-1111-4111-8111-111111111111',
    treatment: 'short-form video posts',
    comparison: 'image posts',
    primaryMetricName: 'engagement_rate',
    primaryMetricDimensions: { platform: 'tiktok' },
    expectedDirection: 'increase',
    designType: 'randomized',
    status: 'running',
    resultState: 'undecided',
  },
  window: { start: '2026-01-01T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' },
  observations: [
    { observationId: 'obs-1', arm: 'treatment', value: 3.5, observedAt: '2026-01-05T00:00:00.000Z', unit: 'ratio', quality: 'ok' },
    { observationId: 'obs-2', arm: 'comparison', value: 1.2, observedAt: '2026-01-06T00:00:00.000Z', unit: 'ratio', quality: 'ok' },
  ],
  evidenceRefs: ['ev-1'],
  learnings: [{ learningId: 'learn-1', statement: 'posting time matters', confidence: 0.7 }],
  priorAnalysisCount: 0,
  minObservationsPerArm: 30,
  minObservationsPerArmDefaulted: true,
  uncertaintyLevel: 0.95,
  uncertaintyLevelDefaulted: true,
  practicalThreshold: { value: 1, source: 'declared_input', description: null },
  declaredConfounders: ['seasonality'],
  declaredLimitations: [],
  analysisMethod: 'two_sample_means_v1',
  analysisMethodVersion: '1.0.0',
};

test('MKT-067: the analysis snapshot digest is canonical — same snapshot → same digest; every material change changes it', () => {
  const first = computeExperimentAnalysisSnapshotDigest(BASE_SNAPSHOT);
  const again = computeExperimentAnalysisSnapshotDigest(
    JSON.parse(JSON.stringify(BASE_SNAPSHOT)) as ExperimentAnalysisInputSnapshot,
  );
  assert.equal(first, again);

  // Observation ORDER does not matter (canonical sort).
  const reordered = computeExperimentAnalysisSnapshotDigest({
    ...BASE_SNAPSHOT,
    observations: [...BASE_SNAPSHOT.observations].reverse(),
  });
  assert.equal(reordered, first);

  // Every material input changes the digest (the equality token).
  assert.notEqual(
    computeExperimentAnalysisSnapshotDigest({ ...BASE_SNAPSHOT, priorAnalysisCount: 1 }),
    first,
  );
  assert.notEqual(
    computeExperimentAnalysisSnapshotDigest({
      ...BASE_SNAPSHOT,
      observations: [...BASE_SNAPSHOT.observations, {
        observationId: 'obs-3', arm: 'treatment', value: 3.5, observedAt: '2026-01-07T00:00:00.000Z', unit: 'ratio', quality: 'ok',
      }],
    }),
    first,
  );
  assert.notEqual(
    computeExperimentAnalysisSnapshotDigest({ ...BASE_SNAPSHOT, window: { start: '2026-01-02T00:00:00.000Z', end: '2026-02-01T00:00:00.000Z' } }),
    first,
  );
  assert.notEqual(
    computeExperimentAnalysisSnapshotDigest({
      ...BASE_SNAPSHOT,
      practicalThreshold: { ...BASE_SNAPSHOT.practicalThreshold, value: 2 },
    }),
    first,
  );
  assert.notEqual(
    computeExperimentAnalysisSnapshotDigest({ ...BASE_SNAPSHOT, uncertaintyLevel: 0.99, uncertaintyLevelDefaulted: false }),
    first,
  );
});

test('MKT-067: the allocation snapshot digest is canonical — same snapshot → same digest; the arms and floor change it', () => {
  const snapshot: ExperimentAllocationInputSnapshot = {
    experiment: {
      experimentId: '22222222-2222-4222-8222-222222222222',
      clientId: '11111111-1111-4111-8111-111111111111',
      status: 'running',
    },
    analysisId: null,
    arms: [
      { armKey: 'human_ugc', kind: 'human_treatment', capacity: 0, sampleSize: 0, mean: 0, variance: 0 },
      { armKey: 'short_form_video', kind: 'strategy_variant', capacity: 10, sampleSize: 20, mean: 2, variance: 1 },
    ],
    explorationFloor: 0.1,
    explorationFloorSource: 'module_default_v1',
    uncertaintyLevel: 0.95,
    strategyVersion: 'ea-alloc-v1',
  };
  const first = computeAllocationSnapshotDigest(snapshot);
  assert.equal(first, computeAllocationSnapshotDigest(JSON.parse(JSON.stringify(snapshot))));
  // Arm order does not matter (canonical armKey sort inside the digest).
  assert.equal(computeAllocationSnapshotDigest({ ...snapshot, arms: [...snapshot.arms].reverse() }), first);
  // Every material change changes the digest.
  assert.notEqual(computeAllocationSnapshotDigest({ ...snapshot, explorationFloor: 0.2 }), first);
  assert.notEqual(
    computeAllocationSnapshotDigest({
      ...snapshot,
      arms: snapshot.arms.map((arm) =>
        arm.armKey === 'human_ugc' ? { ...arm, capacity: 5 } : arm,
      ),
    }),
    first,
  );
  assert.notEqual(computeAllocationSnapshotDigest({ ...snapshot, analysisId: 'an-1' }), first);
});

// ---------------------------------------------------------------------------
// The observation selection filter
// ---------------------------------------------------------------------------

function observation(
  observationId: string,
  metricName: string,
  dimensions: Record<string, string | number | boolean>,
  value: number,
  observedAt: string,
  quality = 'ok',
) {
  return { observationId, metricName, dimensions, value, observedAt, unit: 'ratio', quality };
}

test('MKT-067: the selection filter consumes name + declared-dimension matches with the arm split inside the window', () => {
  const selected = selectObservationsForAnalysis({
    observations: [
      observation('obs-1', 'engagement_rate', { platform: 'tiktok', arm: 'treatment' }, 3.5, '2026-01-05T00:00:00.000Z'),
      observation('obs-2', 'engagement_rate', { platform: 'tiktok', arm: 'comparison' }, 1.2, '2026-01-06T00:00:00.000Z'),
      // Wrong metric name.
      observation('obs-3', 'follower_count', { platform: 'tiktok', arm: 'treatment' }, 100, '2026-01-05T00:00:00.000Z'),
      // Wrong dimension value.
      observation('obs-4', 'engagement_rate', { platform: 'instagram', arm: 'treatment' }, 9, '2026-01-05T00:00:00.000Z'),
      // Missing arm split.
      observation('obs-5', 'engagement_rate', { platform: 'tiktok' }, 5, '2026-01-05T00:00:00.000Z'),
      // Outside the window (start-inclusive, end-exclusive).
      observation('obs-6', 'engagement_rate', { platform: 'tiktok', arm: 'treatment' }, 4, '2025-12-31T23:59:59.999Z'),
      observation('obs-7', 'engagement_rate', { platform: 'tiktok', arm: 'treatment' }, 4, '2026-02-01T00:00:00.000Z'),
      // On the window boundary: start included.
      observation('obs-8', 'engagement_rate', { platform: 'tiktok', arm: 'treatment' }, 4, '2026-01-01T00:00:00.000Z'),
      // Suspect quality is consumed but counted.
      observation('obs-9', 'engagement_rate', { platform: 'tiktok', arm: 'comparison' }, 2, '2026-01-07T00:00:00.000Z', 'suspect'),
    ],
    metricName: 'engagement_rate',
    declaredDimensions: { platform: 'tiktok' },
    windowStart: '2026-01-01T00:00:00.000Z',
    windowEnd: '2026-02-01T00:00:00.000Z',
  });
  assert.deepEqual(
    selected.consumed.map((entry) => entry.observationId),
    ['obs-1', 'obs-2', 'obs-8', 'obs-9'],
  );
  assert.equal(selected.consumed.find((entry) => entry.observationId === 'obs-1')!.arm, 'treatment');
  assert.equal(selected.consumed.find((entry) => entry.observationId === 'obs-2')!.arm, 'comparison');
  assert.equal(selected.nonOkQualityCount, 1);
});

test('MKT-067: the empty window consumes nothing — the honest empty analysis input', () => {
  const selected = selectObservationsForAnalysis({
    observations: [
      observation('obs-1', 'engagement_rate', { platform: 'tiktok', arm: 'treatment' }, 3.5, '2026-01-05T00:00:00.000Z'),
    ],
    metricName: 'engagement_rate',
    declaredDimensions: { platform: 'tiktok' },
    windowStart: '2026-03-01T00:00:00.000Z',
    windowEnd: '2026-04-01T00:00:00.000Z',
  });
  assert.deepEqual(selected.consumed, []);
  assert.equal(selected.nonOkQualityCount, 0);
});

// ---------------------------------------------------------------------------
// The owner-context composition (purity)
// ---------------------------------------------------------------------------

test('MKT-067: the owner-context compositions are pure — same inputs compose the same context', () => {
  const clientOwnership = {
    scope: { kind: 'client' as const, agencyId: 'agg-1', clientId: 'cli-1' },
    client: { clientId: 'cli-1', agencyId: 'agg-1', status: 'active' },
  };
  const analysis = {
    analysisId: 'an-1',
    clientId: 'cli-1',
    workspaceId: null,
    experimentId: 'exp-1',
    analysisMethod: 'two_sample_means_v1',
    analysisMethodVersion: '1.0.0',
    vocabularyVersion: 'ea-vocab-v1',
    observationWindowStart: '2026-01-01T00:00:00.000Z',
    observationWindowEnd: '2026-02-01T00:00:00.000Z',
    sampleSizes: { treatment: 0, comparison: 0 },
    treatmentMean: null,
    comparisonMean: null,
    effectEstimate: null,
    standardError: null,
    uncertainty: { kind: 'none' as const, reason: 'empty' },
    sequentialState: {
      interimIndex: 1, maxLooks: 5, perLookLevel: 0.99, cumulativeAlphaSpent: 0.01,
      boundaryCrossed: false, continueAllowed: true, note: 'n',
    },
    confounders: [],
    limitations: [],
    practicalThreshold: { value: 0, source: 'module_default_v1', description: null },
    outcome: 'insufficient_observations' as const,
    recommendedNextAllocation: 'hold_balanced' as const,
    inputSnapshot: BASE_SNAPSHOT,
    inputDigest: 'digest',
    evidenceRefs: [],
    metricObservationRefs: [],
    learningRefs: [],
    provenance: {
      actor: 'user:1', recordedVia: 'api', correlationId: 'c', causationId: null, recordedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const context = composeExperimentAnalysisOwnerContext(analysis, clientOwnership, null, '2026-02-01T00:00:00.000Z');
  assert.equal(context.scope.kind, 'experiment_analysis');
  assert.equal(context.scope.agencyId, 'agg-1');
  assert.equal(context.scope.clientId, 'cli-1');
  assert.equal(context.scope.analysisId, 'an-1');
  assert.equal(context.analysis, analysis);
  assert.deepEqual(
    composeExperimentAnalysisOwnerContext(analysis, clientOwnership, null, '2026-02-01T00:00:00.000Z'),
    context,
  );

  const recommendation = {
    recommendationId: 'rec-1',
    clientId: 'cli-1',
    workspaceId: null,
    experimentId: 'exp-1',
    analysisId: null,
    vocabularyVersion: 'ea-vocab-v1',
    arms: [],
    allocation: {
      eligibleArms: [], zeroCapacityArms: [], shares: {}, humanTreatmentConsideration: {
        present: false, capacity: 0, excluded: true, note: 'n',
      }, explorationShare: 0,
    },
    explorationFloor: 0.1,
    explorationFloorSource: 'module_default_v1' as const,
    inputSnapshot: {
      experiment: { experimentId: 'exp-1', clientId: 'cli-1', status: 'running' },
      analysisId: null,
      arms: [],
      explorationFloor: 0.1,
      explorationFloorSource: 'module_default_v1',
      uncertaintyLevel: 0.95,
      strategyVersion: 'ea-alloc-v1',
    },
    inputDigest: 'digest',
    rationale: 'r',
    provenance: analysis.provenance,
  };
  const recommendationContext = composeAllocationRecommendationOwnerContext(
    recommendation,
    clientOwnership,
    null,
    '2026-02-01T00:00:00.000Z',
  );
  assert.equal(recommendationContext.scope.kind, 'experiment_allocation_recommendation');
  assert.equal(recommendationContext.scope.agencyId, 'agg-1');
  assert.equal(recommendationContext.recommendation, recommendation);
});
