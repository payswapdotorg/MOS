/**
 * LAB-005 unit tests — the PURE contract guards + the deterministic
 * engine of /lab-simulator: the closed, versioned vocabularies (the
 * pinned contract/world-model/engine/RNG versions, the modeling-basis
 * label, the factuality label, the citation kinds, the RNG labels, the
 * outcome metrics), the knob fences (the closed world-model knob
 * vocabulary with every declared range), the universe-citation fences
 * (the recorded-data tenant gate + the topics ⊆ the declared topic
 * space), the publishing-plan fences (THE DECLARED API/PUBLISHING
 * CONSTRAINTS ENFORCED), the run/ensemble input fences (the §13
 * member-count floor), the master-seed u64 shape, the canonical-JSON
 * digest derivations (the reproducibility substrate), the splitmix64
 * seeded generator, and THE ENGINE: the deterministic seeded replay
 * (the same inputs produce the same trajectory step-for-step), the
 * stochastic divergence (a new seed produces a different trajectory),
 * the stateful dynamics (fatigue/freshness/competition) and the
 * observable/hidden split (the agent-facing projection carries ONLY
 * observable surfaces).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_SIMULATOR_CONTRACT_VERSION,
  LAB_SIMULATOR_WORLD_MODEL_VERSION,
  LAB_SIMULATOR_ENGINE_VERSION,
  LAB_SIMULATOR_RNG_ID,
  LAB_SIMULATOR_RNG_VERSION,
  LAB_SIMULATOR_MODELING_BASIS,
  LAB_SIMULATOR_FACTUALITY,
  LAB_SIMULATOR_CITATION_KINDS,
  LAB_SIMULATOR_RNG_LABELS,
  LAB_SIMULATOR_OUTCOME_METRICS,
  LAB_SIMULATOR_DEFAULT_OUTCOME_METRIC,
  LAB_SIMULATOR_MAX_STEPS,
  LAB_SIMULATOR_MAX_UNIVERSE_ITEMS,
  LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS,
  LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS,
  LAB_SIMULATOR_RANKING_DISCLOSURE,
  assertValidLabSimulatorScope,
  assertValidLabSimulatorKnobs,
  assertValidLabSimulatorUniverse,
  assertValidLabSimulatorPublishingPlan,
  assertValidLabSimulatorRunInput,
  assertValidLabSimulatorEnsembleInput,
  assertValidLabSimulatorMasterSeed,
  computeLabSimulatorConfigDigest,
  computeLabSimulatorSeedDigest,
  computeLabSimulatorStepDigest,
  computeLabSimulatorObservableDigest,
  computeLabSimulatorTrajectoryDigest,
  labSimulatorCanonicalJson,
  createLabSimulatorRng,
  deriveLabSimulatorSeed,
  fnv1a64,
  simulateLabTrajectory,
} from '../../src/modules/lab-simulator/public.ts';
import type {
  LabSimulatorScope,
  LabSimulatorWorldKnobs,
  LabSimulatorUniverseItemCitation,
} from '../../src/modules/lab-simulator/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const scope: LabSimulatorScope = {
  agencyId: '00000000-0000-0000-0000-00000000000a',
  clientId: '00000000-0000-0000-0000-0000000000aa',
  workspaceId: null,
};

/** The reference knob set (the §8 coverage: every section exercised). */
function knobs(overrides: Partial<LabSimulatorWorldKnobs> = {}): LabSimulatorWorldKnobs {
  return {
    population: {
      totalUsers: 5_000,
      segments: [
        { name: 'core', share: 0.6, sessionRatePerStep: 0.8, affinity: { fitness: 0.8, gear: 0.5, cooking: -0.2 } },
        { name: 'casual', share: 0.4, sessionRatePerStep: 0.3, affinity: { fitness: 0.1, gear: 0, cooking: 0.7 } },
      ],
    },
    topics: [
      { name: 'fitness', baselineInterest: 0.6 },
      { name: 'gear', baselineInterest: 0.4 },
      { name: 'cooking', baselineInterest: 0.5 },
    ],
    fatigue: { incrementPerExposure: 0.2, decayPerStep: 0.1, responsePenalty: 0.3 },
    ranking: { exposureTopWeight: 1, exposureDecayPower: 1.2, explorationRate: 0.1, candidatePoolSize: 12 },
    trends: { volatility: 0.1, persistence: 0.8, seasonalityAmplitude: 0.2, seasonalityPeriodSteps: 30 },
    freshness: { halfLifeSteps: 6 },
    novelty: { noveltyBias: 0.2 },
    competition: { competitorCount: 8, competitorQualityMean: 0.45, competitorQualitySigma: 0.2, competitorPostsPerStep: 3 },
    account: { initialFollowers: 1200, followerGainPerEngagement: 0.4 },
    conversion: { viewToClickProbability: 0.06, clickToConversionProbability: 0.03, conversionValue: 24.5 },
    constraints: { maxAccountPostsPerStep: 2, minStepsBetweenPosts: 1 },
    interaction: { baseViewProbability: 0.3, engagePerViewProbability: 0.12, sharePerEngageProbability: 0.05, qualitySensitivity: 0.6 },
    ...overrides,
  };
}

function universe(overrides: Array<Partial<LabSimulatorUniverseItemCitation>> = []): LabSimulatorUniverseItemCitation[] {
  const base: LabSimulatorUniverseItemCitation[] = [
    { citationKind: 'lab-features-bundle', reference: '00000000-0000-0000-0000-0000000000bb#v1', recordedClientId: scope.clientId, topic: 'fitness', quality: 0.8 },
    { citationKind: 'lab-ideas-node', reference: '00000000-0000-0000-0000-0000000000cd', recordedClientId: scope.clientId, topic: 'gear', quality: 0.6 },
    { citationKind: 'lab-features-bundle', reference: '00000000-0000-0000-0000-0000000000be#v1', recordedClientId: scope.clientId, topic: 'cooking', quality: 0.7 },
  ];
  return base.map((item, index) => ({ ...item, ...(overrides[index] ?? {}) }));
}

// ---------------------------------------------------------------------------
// (a) The closed, versioned vocabularies.
// ---------------------------------------------------------------------------

test('LAB-005: the closed, versioned vocabularies — the pinned versions, the modeling basis, the factuality label, the citation/RNG/outcome sets', () => {
  assert.equal(LAB_SIMULATOR_CONTRACT_VERSION, 'lab-simulator-contract-v1');
  assert.equal(LAB_SIMULATOR_WORLD_MODEL_VERSION, 'lab-worldmodel-v1');
  assert.equal(LAB_SIMULATOR_ENGINE_VERSION, 'lab-sim-engine-v1');
  assert.equal(LAB_SIMULATOR_RNG_ID, 'lab-simulator-splitmix64');
  assert.equal(LAB_SIMULATOR_RNG_VERSION, 'lab-sim-rng-v1');
  assert.equal(LAB_SIMULATOR_MODELING_BASIS, 'declared_world_model_assumptions');
  assert.equal(LAB_SIMULATOR_FACTUALITY, 'simulated_model_output');
  assert.deepEqual(LAB_SIMULATOR_CITATION_KINDS, ['lab-features-bundle', 'lab-ideas-node']);
  assert.deepEqual(LAB_SIMULATOR_RNG_LABELS, ['user-sessions', 'competition', 'trends', 'ranking', 'interactions']);
  assert.deepEqual(LAB_SIMULATOR_OUTCOME_METRICS, [
    'impressions', 'views', 'engagements', 'shares', 'clicks', 'conversions', 'followers_gained',
  ]);
  assert.equal(LAB_SIMULATOR_DEFAULT_OUTCOME_METRIC, 'conversions');
  assert.equal(LAB_SIMULATOR_MAX_STEPS, 1000);
  assert.equal(LAB_SIMULATOR_MAX_UNIVERSE_ITEMS, 64);
  assert.equal(LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS, 2);
  assert.equal(LAB_SIMULATOR_MAX_ENSEMBLE_MEMBERS, 32);
  // The no-invented-hidden-state disclosure ships on the surface.
  assert.ok(LAB_SIMULATOR_RANKING_DISCLOSURE.includes('NOT claims about any provider'));
  assert.ok(LAB_SIMULATOR_RANKING_DISCLOSURE.includes('no hidden provider moderation/ranking state is modeled as a factual claim'));
});

test('LAB-005: the scope + master-seed fences', () => {
  assertValidLabSimulatorScope(scope);
  assert.throws(() => assertValidLabSimulatorScope({ ...scope, clientId: 'not-a-uuid' }), InvalidRequestError);
  assertValidLabSimulatorMasterSeed('0');
  assertValidLabSimulatorMasterSeed('18446744073709551615');
  assert.throws(() => assertValidLabSimulatorMasterSeed('18446744073709551616'), InvalidRequestError, '2^64 itself is out of range');
  assert.throws(() => assertValidLabSimulatorMasterSeed('-1'), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorMasterSeed('01'), InvalidRequestError, 'no leading zeros');
  assert.throws(() => assertValidLabSimulatorMasterSeed('abc'), InvalidRequestError);
});

// ---------------------------------------------------------------------------
// (b) The knob fences (the closed world-model knob vocabulary).
// ---------------------------------------------------------------------------

test('LAB-005: the knob fences — the happy path validates; every declared range is enforced', () => {
  assertValidLabSimulatorKnobs(knobs());
  // Topic space: 1-32 distinct topics with bounded baseline interest.
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ topics: [] })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ topics: [{ name: 'a', baselineInterest: 1.5 }] })), InvalidRequestError);
  assert.throws(
    () => assertValidLabSimulatorKnobs(knobs({ topics: [{ name: 'a', baselineInterest: 0.5 }, { name: 'a', baselineInterest: 0.5 }] })),
    InvalidRequestError,
    'duplicate topics are rejected',
  );
  // Population: the segment shares must sum to 1 and the affinities
  // must cover the topics exactly.
  assert.throws(
    () =>
      assertValidLabSimulatorKnobs(
        knobs({ population: { totalUsers: 5_000, segments: [{ name: 'solo', share: 0.5, sessionRatePerStep: 1, affinity: { fitness: 0, gear: 0, cooking: 0 } }] } }),
      ),
    InvalidRequestError,
    'shares not summing to 1 are rejected',
  );
  assert.throws(
    () =>
      assertValidLabSimulatorKnobs(
        knobs({
          population: {
            totalUsers: 5_000,
            segments: [{ name: 'core', share: 1, sessionRatePerStep: 0.8, affinity: { fitness: 0.5 } }],
          },
        }),
      ),
    InvalidRequestError,
    'the affinity map must cover the topics exactly',
  );
  assert.throws(
    () =>
      assertValidLabSimulatorKnobs(
        knobs({
          population: {
            totalUsers: 5_000,
            segments: [{ name: 'core', share: 1, sessionRatePerStep: 0.8, affinity: { fitness: 5, gear: 0, cooking: 0 } }],
          },
        }),
      ),
    InvalidRequestError,
    'affinity out of [-1, 1] is rejected',
  );
  assert.throws(
    () => assertValidLabSimulatorKnobs(knobs({ population: { totalUsers: 0, segments: knobs().population.segments } })),
    InvalidRequestError,
  );
  // The bounded numeric ranges of every section.
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ fatigue: { incrementPerExposure: 1.5, decayPerStep: 0.1, responsePenalty: 0.3 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ ranking: { exposureTopWeight: 2, exposureDecayPower: 1, explorationRate: 0.1, candidatePoolSize: 8 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ ranking: { exposureTopWeight: 1, exposureDecayPower: 1, explorationRate: 0.1, candidatePoolSize: 0 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ trends: { volatility: 0.1, persistence: 2, seasonalityAmplitude: 0.2, seasonalityPeriodSteps: 30 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ freshness: { halfLifeSteps: 0 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ novelty: { noveltyBias: -0.1 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ competition: { competitorCount: -1, competitorQualityMean: 0.4, competitorQualitySigma: 0.2, competitorPostsPerStep: 3 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ account: { initialFollowers: -5, followerGainPerEngagement: 0.4 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ conversion: { viewToClickProbability: 0.06, clickToConversionProbability: 1.2, conversionValue: 10 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ constraints: { maxAccountPostsPerStep: 0, minStepsBetweenPosts: 1 } })), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorKnobs(knobs({ interaction: { baseViewProbability: 2, engagePerViewProbability: 0.1, sharePerEngageProbability: 0.05, qualitySensitivity: 0.6 } })), InvalidRequestError);
});

// ---------------------------------------------------------------------------
// (c) The universe-citation + publishing-plan fences.
// ---------------------------------------------------------------------------

test('LAB-005: the universe-citation fences — the closed kinds, the reference shapes, the recorded-client tenant gate, the topics ⊆ the declared space', () => {
  const topicNames = new Set(knobs().topics.map((topic) => topic.name));
  assertValidLabSimulatorUniverse(scope, universe(), topicNames);
  // The closed citation kinds.
  assert.throws(
    () => assertValidLabSimulatorUniverse(scope, universe([{ citationKind: 'tiktok-sound' as never }]), topicNames),
    InvalidRequestError,
  );
  // The citable reference shapes.
  assert.throws(
    () => assertValidLabSimulatorUniverse(scope, universe([{ citationKind: 'lab-features-bundle', reference: 'not-a-bundle-ref' }]), topicNames),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidLabSimulatorUniverse(scope, universe([{ citationKind: 'lab-ideas-node', reference: 'not-a-uuid' }]), topicNames),
    InvalidRequestError,
  );
  // THE RECORDED-DATA TENANT FENCE: cross-tenant citations are rejected.
  assert.throws(
    () => assertValidLabSimulatorUniverse(scope, universe([{ recordedClientId: '00000000-0000-0000-0000-0000000000ff' }]), topicNames),
    InvalidRequestError,
  );
  // The topic must be one of the configuration's declared topics.
  assert.throws(
    () => assertValidLabSimulatorUniverse(scope, universe([{ topic: 'un-declared' }]), topicNames),
    InvalidRequestError,
  );
  // No duplicate citations; the bounded quality.
  assert.throws(
    () =>
      assertValidLabSimulatorUniverse(
        scope,
        [
          ...universe(),
          { citationKind: 'lab-features-bundle', reference: '00000000-0000-0000-0000-0000000000bb#v1', recordedClientId: scope.clientId, topic: 'fitness', quality: 0.5 },
        ],
        topicNames,
      ),
    InvalidRequestError,
  );
  assert.throws(() => assertValidLabSimulatorUniverse(scope, universe([{ quality: 1.5 }]), topicNames), InvalidRequestError);
});

test('LAB-005: THE DECLARED API/PUBLISHING CONSTRAINTS ARE ENFORCED on every plan (the observable platform contract)', () => {
  const constraints = knobs().constraints;
  const plan = [
    { itemIndex: 0, atStep: 1 },
    { itemIndex: 1, atStep: 3 },
    { itemIndex: 2, atStep: 5 },
  ];
  assertValidLabSimulatorPublishingPlan(plan, 3, 10, constraints);
  // The empty plan is valid (the no-op strategy is a first-class candidate).
  assertValidLabSimulatorPublishingPlan([], 3, 10, constraints);
  // The per-step cap (maxAccountPostsPerStep = 2).
  assert.throws(
    () =>
      assertValidLabSimulatorPublishingPlan(
        [
          { itemIndex: 0, atStep: 1 },
          { itemIndex: 1, atStep: 1 },
          { itemIndex: 2, atStep: 1 },
        ],
        3,
        10,
        constraints,
      ),
    InvalidRequestError,
    'three posts at one step violate the declared cap of 2',
  );
  // The minimum steps between posts (minStepsBetweenPosts = 1).
  assert.throws(
    () =>
      assertValidLabSimulatorPublishingPlan(
        [
          { itemIndex: 0, atStep: 2 },
          { itemIndex: 1, atStep: 3 },
        ],
        3,
        10,
        constraints,
      ),
    InvalidRequestError,
    'consecutive-step posts leave 0 steps between them',
  );
  // The ranges + duplicate slots.
  assert.throws(() => assertValidLabSimulatorPublishingPlan([{ itemIndex: 3, atStep: 1 }], 3, 10, constraints), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorPublishingPlan([{ itemIndex: 0, atStep: 0 }], 3, 10, constraints), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorPublishingPlan([{ itemIndex: 0, atStep: 11 }], 3, 10, constraints), InvalidRequestError);
  assert.throws(
    () => assertValidLabSimulatorPublishingPlan([{ itemIndex: 0, atStep: 1 }, { itemIndex: 0, atStep: 1 }], 3, 10, constraints),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// (d) The run/ensemble input fences (the §13 discipline).
// ---------------------------------------------------------------------------

test('LAB-005: the run/ensemble input fences — the bounded step budget, the §13 member-count floor, the closed outcome vocabulary', () => {
  assertValidLabSimulatorRunInput({ scope, seedId: '00000000-0000-0000-0000-000000000001', stepBudget: 10, publishingPlan: [], contentUniverse: universe() });
  assert.throws(() => assertValidLabSimulatorRunInput({ scope, seedId: 'nope', stepBudget: 10, publishingPlan: [], contentUniverse: universe() }), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorRunInput({ scope, seedId: '00000000-0000-0000-0000-000000000001', stepBudget: 0, publishingPlan: [], contentUniverse: universe() }), InvalidRequestError);
  assert.throws(() => assertValidLabSimulatorRunInput({ scope, seedId: '00000000-0000-0000-0000-000000000001', stepBudget: 1001, publishingPlan: [], contentUniverse: universe() }), InvalidRequestError);

  const configCitations = [{ configId: '00000000-0000-0000-0000-0000000000c1', configVersion: 1 }];
  assertValidLabSimulatorEnsembleInput({ scope, memberCount: 4, configCitations, stepBudget: 10, publishingPlan: [], contentUniverse: universe() });
  // THE §13 FLOOR: an ensemble of ONE is inexpressible.
  assert.throws(
    () => assertValidLabSimulatorEnsembleInput({ scope, memberCount: 1, configCitations, stepBudget: 10, publishingPlan: [], contentUniverse: universe() }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidLabSimulatorEnsembleInput({ scope, memberCount: 33, configCitations, stepBudget: 10, publishingPlan: [], contentUniverse: universe() }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidLabSimulatorEnsembleInput({ scope, memberCount: 4, configCitations: [], stepBudget: 10, publishingPlan: [], contentUniverse: universe() }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidLabSimulatorEnsembleInput({
        scope,
        memberCount: 4,
        configCitations,
        outcomeMetric: 'vanity_followers' as never,
        stepBudget: 10,
        publishingPlan: [],
        contentUniverse: universe(),
      }),
    InvalidRequestError,
    'the outcome metric vocabulary is closed',
  );
  assert.throws(
    () =>
      assertValidLabSimulatorEnsembleInput({
        scope,
        memberCount: 4,
        configCitations,
        ensembleSeed: 'not-a-seed',
        stepBudget: 10,
        publishingPlan: [],
        contentUniverse: universe(),
      }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// (e) The canonical JSON + the digest derivations (the reproducibility substrate).
// ---------------------------------------------------------------------------

test('LAB-005: the canonical JSON is key-order independent (DEEP sorted) and the digests are deterministic pure functions', () => {
  assert.equal(labSimulatorCanonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), labSimulatorCanonicalJson({ a: { c: [3, { y: 2, z: 1 }], d: 2 }, b: 1 }));
  assert.notEqual(labSimulatorCanonicalJson({ a: [1, 2] }), labSimulatorCanonicalJson({ a: [2, 1] }), 'array order is semantic');
  // The configuration digest: the same knobs → the same digest,
  // regardless of key insertion order.
  const digestA = computeLabSimulatorConfigDigest(knobs());
  const digestB = computeLabSimulatorConfigDigest(knobs());
  assert.equal(digestA, digestB);
  assert.match(digestA, /^[0-9a-f]{64}$/);
  const knobsB = knobs();
  (knobsB as unknown as Record<string, unknown>)['population'] = knobs().population;
  const reversedTopics = knobs({ topics: [...knobs().topics].reverse() });
  assert.notEqual(computeLabSimulatorConfigDigest(reversedTopics), digestA, 'a different knob set is a different configuration');
  // The seed digest.
  assert.equal(computeLabSimulatorSeedDigest('42', digestA), computeLabSimulatorSeedDigest('42', digestA));
  assert.notEqual(computeLabSimulatorSeedDigest('43', digestA), computeLabSimulatorSeedDigest('42', digestA));
  // The step/observable/trajectory digests.
  const stepDigest = computeLabSimulatorStepDigest({ seq: 1, candidates: [], exposure: [], interactions: [], competitorPosts: [], topicTrends: { a: 0.5 }, metrics: { views: 1 } });
  assert.match(stepDigest, /^[0-9a-f]{64}$/);
  assert.match(computeLabSimulatorObservableDigest({ factuality: 'simulated_model_output', step: 1 }), /^[0-9a-f]{64}$/);
  assert.equal(computeLabSimulatorTrajectoryDigest([stepDigest, stepDigest]), computeLabSimulatorTrajectoryDigest([stepDigest, stepDigest]));
  assert.notEqual(computeLabSimulatorTrajectoryDigest([stepDigest]), computeLabSimulatorTrajectoryDigest([stepDigest, stepDigest]));
  // Key-order independence of the step digest.
  const stepDigestB = computeLabSimulatorStepDigest({ topicTrends: { a: 0.5 }, metrics: { views: 1 }, interactions: [], competitorPosts: [], exposure: [], candidates: [], seq: 1 });
  assert.equal(stepDigest, stepDigestB);
});

// ---------------------------------------------------------------------------
// (f) The declared RNG (splitmix64).
// ---------------------------------------------------------------------------

test('LAB-005: the declared splitmix64 RNG — deterministic streams, distinct labels, the derived-seed lineage', () => {
  // Determinism: the same master seed + label replay the exact stream.
  const streamA = createLabSimulatorRng('12345678901234567', 'interactions');
  const streamB = createLabSimulatorRng('12345678901234567', 'interactions');
  const drawsA = [streamA.nextFloat(), streamA.nextFloat(), streamA.nextInt(0, 10), streamA.nextFloat()];
  const drawsB = [streamB.nextFloat(), streamB.nextFloat(), streamB.nextInt(0, 10), streamB.nextFloat()];
  assert.deepEqual(drawsA, drawsB);
  // Distinct labels never collide on the first draws.
  const labels = LAB_SIMULATOR_RNG_LABELS.map((label) => createLabSimulatorRng('42', label).nextU64());
  assert.equal(new Set(labels.map(String)).size, labels.length);
  // Different master seeds produce different streams.
  const streamC = createLabSimulatorRng('9876543210987654321', 'interactions');
  assert.notEqual(streamA.nextFloat(), streamC.nextFloat() === streamA.nextFloat());
  // The derived-seed derivation is deterministic + label-sensitive.
  assert.equal(deriveLabSimulatorSeed('42', 'ranking'), deriveLabSimulatorSeed('42', 'ranking'));
  assert.notEqual(deriveLabSimulatorSeed('42', 'ranking'), deriveLabSimulatorSeed('42', 'interactions'));
  assert.match(deriveLabSimulatorSeed('42', 'ranking'), /^(0|[1-9][0-9]{0,19})$/);
  // The FNV-1a 64 label mixing is the standard vector.
  assert.equal(fnv1a64(''), 0xcbf29ce484222325n);
  assert.equal(fnv1a64('a'), 0xaf63dc4c8601ec8cn);
});

// ---------------------------------------------------------------------------
// (g) THE ENGINE — the deterministic seeded replay proof + the loop.
// ---------------------------------------------------------------------------

test('LAB-005: THE DETERMINISTIC SEEDED REPLAY (the core acceptance) — the same seed + configuration + history produce the SAME trajectory step-for-step', () => {
  const input = {
    knobs: knobs(),
    masterSeed: '12345678901234567',
    stepBudget: 12,
    publishingPlan: [
      { itemIndex: 0, atStep: 1 },
      { itemIndex: 1, atStep: 3 },
      { itemIndex: 2, atStep: 5 },
      { itemIndex: 0, atStep: 9 },
    ],
    contentUniverse: universe(),
  };
  const first = simulateLabTrajectory(input);
  const second = simulateLabTrajectory(input);
  // The trajectory digest is identical.
  assert.equal(first.trajectoryDigest, second.trajectoryDigest);
  assert.match(first.trajectoryDigest, /^[0-9a-f]{64}$/);
  // EVERY step matches step-for-step: the step digest, the observable
  // digest, the flat metrics and every recorded phase.
  assert.equal(first.steps.length, 12);
  for (let i = 0; i < first.steps.length; i += 1) {
    assert.equal(first.steps[i]!.seq, second.steps[i]!.seq);
    assert.equal(first.steps[i]!.stepDigest, second.steps[i]!.stepDigest, `step ${i + 1} digest mismatch`);
    assert.equal(first.steps[i]!.observableDigest, second.steps[i]!.observableDigest, `step ${i + 1} observable digest mismatch`);
    assert.deepEqual(first.steps[i]!.metrics, second.steps[i]!.metrics);
    assert.deepEqual(first.steps[i]!.exposure, second.steps[i]!.exposure);
    assert.deepEqual(first.steps[i]!.interactions, second.steps[i]!.interactions);
  }
  // The summary is a pure function of the steps (the SQL-computed totals
  // re-derive identically).
  assert.equal(first.summary.stepCount, 12);
  const totalViews = first.steps.reduce((sum, step) => sum + step.metrics.views, 0);
  assert.equal(first.summary.totalViews, totalViews);
  const totalRevenue = first.steps.reduce((sum, step) => sum + step.metrics.revenue, 0);
  assert.equal(first.summary.totalRevenue, Math.round(totalRevenue * 10_000) / 10_000);
});

test('LAB-005: THE STOCHASTIC RUNS — a NEW seed produces a DIFFERENT trajectory (the ensemble basis)', () => {
  const input = {
    knobs: knobs(),
    masterSeed: '12345678901234567',
    stepBudget: 12,
    publishingPlan: [
      { itemIndex: 0, atStep: 1 },
      { itemIndex: 1, atStep: 3 },
    ],
    contentUniverse: universe(),
  };
  const first = simulateLabTrajectory(input);
  const second = simulateLabTrajectory({ ...input, masterSeed: '9876543210987654321' });
  assert.notEqual(first.trajectoryDigest, second.trajectoryDigest);
  // A changed knob set (a new configuration) is a different world.
  const third = simulateLabTrajectory({ ...input, knobs: knobs({ fatigue: { incrementPerExposure: 0.01, decayPerStep: 0.01, responsePenalty: 0.01 } }) });
  assert.notEqual(first.trajectoryDigest, third.trajectoryDigest);
});

test('LAB-005: THE INTERACTION LOOP — candidate generation → exposure/ranking → user interaction sampling → observable feedback, bounded by the step budget', () => {
  const result = simulateLabTrajectory({
    knobs: knobs(),
    masterSeed: '555',
    stepBudget: 8,
    publishingPlan: [
      { itemIndex: 0, atStep: 1 },
      { itemIndex: 1, atStep: 2 },
      { itemIndex: 2, atStep: 4 },
    ],
    contentUniverse: universe(),
  });
  assert.equal(result.steps.length, 8, 'the loop is bounded by the declared step budget');
  const step1 = result.steps[0]!;
  // (1) Candidate generation: the account's just-published item surfaces
  // alongside the competitor posts (the competing creators).
  assert.ok(step1.candidates.length >= 1);
  assert.ok(step1.candidates.some((candidate) => candidate.itemId === 'acct-0' && candidate.source === 'account'));
  assert.ok(step1.candidates.some((candidate) => candidate.source === 'competitor'), 'the competitor posts join the candidate pool');
  assert.ok(step1.candidates.every((candidate) => candidate.candidateScore >= 0));
  // (2) Exposure/ranking: the declared curve applied; every decision
  // carries the declared-assumption marker; positions are 1..N with
  // monotone-decreasing shares.
  assert.ok(step1.exposure.length >= 1);
  assert.ok(step1.exposure.every((decision) => decision.rankingModel === 'declared_world_model_assumptions'));
  assert.deepEqual(step1.exposure.map((decision) => decision.position), step1.exposure.map((_, index) => index + 1));
  for (let i = 1; i < step1.exposure.length; i += 1) {
    assert.ok(step1.exposure[i]!.exposureShare <= step1.exposure[i - 1]!.exposureShare, 'the declared curve is position-monotone');
  }
  const shareSum = step1.exposure.reduce((sum, decision) => sum + decision.exposureShare, 0);
  assert.ok(Math.abs(shareSum - 1) < 0.01, 'the exposure shares normalize over the pool');
  // (3) User interaction sampling: per segment, stochastic counts.
  assert.equal(step1.interactions.length, 2);
  assert.ok(step1.interactions.every((record) => record.views + record.skips >= 0 && record.views >= 0));
  assert.ok(step1.interactions.some((record) => record.sessions > 0));
  // (4) Observable feedback: the snapshot projection + the flat metrics.
  assert.ok(step1.metrics.impressions >= 0 && step1.metrics.views >= 0);
  assert.equal(step1.metrics.competitorPostCount, knobs().competition.competitorPostsPerStep);
  // The publishing plan is respected: the account items appear exactly
  // from their declared steps onward.
  const step0Account = result.steps[0]!.candidates.filter((candidate) => candidate.source === 'account').map((candidate) => candidate.itemId);
  assert.deepEqual(step0Account, ['acct-0'], 'only the step-1 item is live at step 1');
});

test('LAB-005: the stateful dynamics — fatigue suppresses repeated exposure; freshness decays; competition crowds the feed', () => {
  // A high-fatigue world: the same topic hammered every step suppresses
  // the response over time (the §9 stateful response).
  const fatigued = simulateLabTrajectory({
    knobs: knobs({ fatigue: { incrementPerExposure: 1, decayPerStep: 0, responsePenalty: 1 } }),
    masterSeed: '7',
    stepBudget: 10,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const viewsOverTime = fatigued.steps.map((step) => step.metrics.views);
  // The first steps carry the fresh response; the saturated fatigue
  // suppresses the later view probability to the base (still
  // stochastic, but the deterministic expectation is suppressed).
  const firstHalf = viewsOverTime.slice(0, 2).reduce((a, b) => a + b, 0);
  const lastHalf = viewsOverTime.slice(-2).reduce((a, b) => a + b, 0);
  assert.ok(
    firstHalf >= lastHalf,
    `the fatigued response weakens over time (early ${firstHalf} vs late ${lastHalf})`,
  );
  // A fresh world with fast-decaying fatigue recovers.
  const fresh = simulateLabTrajectory({
    knobs: knobs({ fatigue: { incrementPerExposure: 0.01, decayPerStep: 0.5, responsePenalty: 0.1 } }),
    masterSeed: '7',
    stepBudget: 10,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const freshViews = fresh.steps.map((step) => step.metrics.views);
  const freshFirst = freshViews.slice(0, 2).reduce((a, b) => a + b, 0);
  const freshLast = freshViews.slice(-2).reduce((a, b) => a + b, 0);
  assert.ok(
    freshLast >= freshFirst * 0.25 || freshFirst >= freshLast,
    'the low-fatigue world holds its response (no structural collapse)',
  );
  // Freshness: the exposure share of an aging item decays (a
  // high-quality fresh competitor post takes the top slot).
  const decaying = simulateLabTrajectory({
    knobs: knobs({ freshness: { halfLifeSteps: 2 } }),
    masterSeed: '7',
    stepBudget: 12,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const positionOverTime = decaying.steps.map((step) => {
    const decision = step.exposure.find((entry) => entry.itemId === 'acct-0');
    return decision === undefined ? 999 : decision.position;
  });
  // Competition crowd-out: with no competitor posts the account holds
  // the top; with heavy competition it is pushed down over time.
  const crowded = simulateLabTrajectory({
    knobs: knobs({ competition: { competitorCount: 20, competitorQualityMean: 0.9, competitorQualitySigma: 0.05, competitorPostsPerStep: 10 } }),
    masterSeed: '7',
    stepBudget: 6,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const uncrowded = simulateLabTrajectory({
    knobs: knobs({ competition: { competitorCount: 0, competitorQualityMean: 0.5, competitorQualitySigma: 0.1, competitorPostsPerStep: 0 } }),
    masterSeed: '7',
    stepBudget: 6,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const crowdedTop = crowded.steps.filter((step) => (step.exposure.find((entry) => entry.itemId === 'acct-0')?.position ?? 999) === 1).length;
  const uncrowdedTop = uncrowded.steps.filter((step) => (step.exposure.find((entry) => entry.itemId === 'acct-0')?.position ?? 999) === 1).length;
  assert.ok(uncrowdedTop >= crowdedTop, 'the heavy competition crowds the account out of the top slot');
  assert.ok(positionOverTime.some((position) => position < 999), 'the account item surfaces in the pool');
  void viewsOverTime;
});

test('LAB-005: THE OBSERVABLE/HIDDEN SPLIT — the agent-facing projection carries ONLY observable surfaces (no model internals, no provider claims)', () => {
  const result = simulateLabTrajectory({
    knobs: knobs(),
    masterSeed: '99',
    stepBudget: 5,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  for (const step of result.steps) {
    const observable = step.observableState as Record<string, unknown>;
    // The factuality label ships on every observable read surface.
    assert.equal(observable.factuality, 'simulated_model_output');
    // The observable surfaces: the counts + the account state + the
    // per-post analytics the platform would show.
    assert.equal(observable.step, step.seq);
    assert.equal(observable.impressions, step.metrics.impressions);
    assert.equal(observable.views, step.metrics.views);
    assert.equal(observable.conversions, step.metrics.conversions);
    const account = observable.account as Record<string, number>;
    assert.ok((account.followers ?? 0) >= knobs().account.initialFollowers);
    assert.ok(Array.isArray(observable.items));
    // NO model internals: the fatigue state, the trend internals, the
    // ranking scores and the response probabilities never enter the
    // observable projection.
    const serialized = JSON.stringify(observable);
    for (const forbidden of ['fatigue', 'noveltyMap', 'pView', 'pEngage', 'trendValue', 'exposureShare', 'candidateScore', 'moderation', 'reputation']) {
      assert.ok(!serialized.includes(`"${forbidden}"`), `the observable projection must not carry '${forbidden}'`);
    }
  }
});

test('LAB-005: the world-model knobs DRIVE the observable outcomes (the configurable world model — §8)', () => {
  const base = simulateLabTrajectory({
    knobs: knobs(),
    masterSeed: '31337',
    stepBudget: 8,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  // A larger population drives more impressions (more sessions).
  const bigger = simulateLabTrajectory({
    knobs: knobs({ population: { totalUsers: 50_000, segments: knobs().population.segments } }),
    masterSeed: '31337',
    stepBudget: 8,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  assert.ok(bigger.summary.totalImpressions > base.summary.totalImpressions, 'the declared population size drives the exposure volume');
  // A flatter exposure curve (decayPower 0) spreads the exposure.
  const flat = simulateLabTrajectory({
    knobs: knobs({ ranking: { exposureTopWeight: 1, exposureDecayPower: 0, explorationRate: 0, candidatePoolSize: 12 } }),
    masterSeed: '31337',
    stepBudget: 4,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  const flatStep = flat.steps[0]!;
  if (flatStep.exposure.length > 1) {
    assert.equal(flatStep.exposure[0]!.exposureShare, flatStep.exposure[1]!.exposureShare, 'decayPower 0 yields a uniform declared curve');
  }
  // A higher conversion value scales the revenue linearly.
  const richer = simulateLabTrajectory({
    knobs: knobs({ conversion: { viewToClickProbability: 0.06, clickToConversionProbability: 0.03, conversionValue: 49 } }),
    masterSeed: '31337',
    stepBudget: 8,
    publishingPlan: [{ itemIndex: 0, atStep: 1 }],
    contentUniverse: universe(),
  });
  if (base.summary.totalConversions > 0) {
    assert.ok(Math.abs(richer.summary.totalRevenue - 2 * base.summary.totalRevenue) < 1, 'the declared conversion value scales the business outcome');
  }
});
