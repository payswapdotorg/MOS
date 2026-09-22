/**
 * MKT-062 unit tests — the /content-intelligence frozen vocabularies, the
 * candidate-feature guards, the hypothesis structure discipline, the
 * §6 hypothesis framing disclosure and the DETERMINISTIC niche clustering
 * + candidate ranking (pure functions only — no DB, no network).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-062;
 * spec/architecture-v1.6.md §6):
 *   - VOCABULARY PINNING: the observation kinds + read operation labels,
 *     the twelve content formats, the five length units, the twelve hook
 *     features, the fourteen narrative structures, the audience-fit /
 *     freshness / novelty / reuse vocabularies and the eight hypothesis
 *     kinds are pinned exactly (a vocabulary change is a NEW version
 *     string);
 *   - CANDIDATE FEATURES AS DATA: the guard validates the §6
 *     observed-feature set (closed vocabularies, the length pair, the
 *     bounded observed objects; §21 material-shaped keys rejected at
 *     every nesting level);
 *   - EVIDENCE/HYPOTHESIS SEPARATION (§6): a hypothesis REQUIRES ≥1
 *     evidence reference; the §6 non-claim framing ships on the contract;
 *   - NICHE CLUSTERING (ci-cluster-v1): the deterministic grouping with
 *     feature histograms — same inputs produce the same clusters;
 *   - CANDIDATE RANKING (ci-rank-v1): the deterministic ordering over the
 *     disclosed frozen weight vector — same inputs produce the same
 *     order, ties broken deterministically, and the ranked order is a
 *     recommendation as data (never a mutation, never an outcome claim);
 *   - PROVENANCE: the server-derived provenance guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContentCandidateFeaturesInput,
  ContentCandidateRecord,
} from '../../src/modules/content-intelligence/public.ts';
import {
  CONTENT_INTELLIGENCE_OBSERVATION_KINDS,
  CONTENT_INTELLIGENCE_OBSERVATION_READ_OPERATIONS,
  CONTENT_INTELLIGENCE_FORMATS,
  CONTENT_INTELLIGENCE_LENGTH_UNITS,
  CONTENT_INTELLIGENCE_HOOK_FEATURES,
  CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES,
  CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS,
  CONTENT_INTELLIGENCE_FRESHNESS_STATES,
  CONTENT_INTELLIGENCE_NOVELTY_STATES,
  CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS,
  CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS,
  CONTENT_INTELLIGENCE_INGESTION_STATUSES,
  CONTENT_INTELLIGENCE_VOCABULARY_VERSION,
  CONTENT_INTELLIGENCE_CLUSTERING_VERSION,
  CONTENT_INTELLIGENCE_RANKING_VERSION,
  CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING,
  CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX,
  assertValidContentCandidateFeatures,
  assertValidContentHypothesisInput,
  assertValidContentIntelligenceProvenance,
  clusterContentCandidatesByNiche,
  rankContentCandidates,
} from '../../src/modules/content-intelligence/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Vocabulary pinning (a change is a NEW version string)
// ---------------------------------------------------------------------------

test('MKT-062: the observation kinds + the frozen read operation labels are pinned exactly', () => {
  assert.deepEqual(CONTENT_INTELLIGENCE_OBSERVATION_KINDS, [
    'platform_content',
    'platform_analytics',
  ]);
  // platform_analytics → 'runReport' (the EXISTING generic-analytics
  // adapter label); platform_content → 'content.list' (awaits its
  // adapter — the honest read-error outcome until one exists).
  assert.deepEqual(CONTENT_INTELLIGENCE_OBSERVATION_READ_OPERATIONS, {
    platform_content: 'content.list',
    platform_analytics: 'runReport',
  });
  assert.deepEqual(CONTENT_INTELLIGENCE_INGESTION_STATUSES, [
    'completed',
    'refused',
    'failed',
  ]);
});

test('MKT-062: the §6 observed-feature vocabularies are pinned exactly', () => {
  assert.deepEqual(CONTENT_INTELLIGENCE_FORMATS, [
    'short_video', 'long_video', 'live_stream', 'image_post', 'carousel',
    'text_post', 'thread', 'story', 'article', 'podcast', 'webinar', 'infographic',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_LENGTH_UNITS, [
    'seconds', 'minutes', 'hours', 'words', 'items',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_HOOK_FEATURES, [
    'question', 'bold_claim', 'curiosity_gap', 'numbered_list', 'contrarian',
    'emotional', 'urgency', 'identity_callout', 'pattern_interrupt',
    'offer_or_price', 'testimonial_lead', 'statistic_lead',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_NARRATIVE_STRUCTURES, [
    'problem_solution', 'tutorial', 'listicle', 'story_arc', 'before_after',
    'myth_busting', 'comparison', 'behind_the_scenes', 'interview',
    'commentary', 'reaction', 'case_study', 'news_report', 'entertainment_bit',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_AUDIENCE_FIT_SIGNALS, [
    'strong_fit', 'moderate_fit', 'weak_fit', 'unclear',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_FRESHNESS_STATES, [
    'breaking', 'recent', 'established', 'evergreen', 'dated',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_NOVELTY_STATES, [
    'novel', 'variation', 'common', 'saturated',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_REUSE_RISK_LEVELS, [
    'low', 'medium', 'high', 'unclear',
  ]);
  assert.deepEqual(CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS, [
    'format_hypothesis', 'topic_hypothesis', 'hook_hypothesis',
    'narrative_hypothesis', 'timing_hypothesis', 'length_hypothesis',
    'audience_hypothesis', 'distribution_hypothesis',
  ]);
  assert.equal(CONTENT_INTELLIGENCE_VOCABULARY_VERSION, 'ci-vocab-v1');
  assert.equal(CONTENT_INTELLIGENCE_CLUSTERING_VERSION, 'ci-cluster-v1');
  assert.equal(CONTENT_INTELLIGENCE_RANKING_VERSION, 'ci-rank-v1');
});

test('MKT-062 §6: the HYPOTHESIS FRAMING disclosure is pinned — observed performance does NOT establish causality', () => {
  assert.ok(
    CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING.includes(
      'does not by itself establish causality',
    ),
    'the framing carries §6\'s explicit non-claim',
  );
  assert.ok(
    CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING.includes('input to experiments'),
    'the framing states hypotheses are inputs to /experiments, never conclusions',
  );
});

// ---------------------------------------------------------------------------
// The candidate-feature guard (§6: observed features as data)
// ---------------------------------------------------------------------------

/** A candidate-features fixture accepting loosely-typed overrides (the invalid-value battery needs them). */
function features(
  overrides: Record<string, unknown> = {},
): ContentCandidateFeaturesInput {
  const base: ContentCandidateFeaturesInput = {
    topicEntity: 'Widget unboxing',
    niche: 'widgets',
    subNiche: 'premium widgets',
    contentFormat: 'short_video',
    lengthValue: 45,
    lengthUnit: 'seconds',
    hookFeatures: ['question', 'curiosity_gap'],
    narrativeStructure: 'problem_solution',
    publishedAt: '2026-01-15T09:00:00.000Z',
    observedPerformance: { views: 12000, likes: 900 },
    performanceVelocity: { viewsPerDay: 400 },
    engagement: { likeRate: 0.075 },
    audienceFit: 'strong_fit',
    freshness: 'recent',
    novelty: 'variation',
    reuseRisk: 'low',
  };
  return { ...base, ...overrides } as ContentCandidateFeaturesInput;
}

test('MKT-062: the candidate-feature guard accepts the honest §6 shape and rejects every mismatch', () => {
  assert.doesNotThrow(() => assertValidContentCandidateFeatures(features()));
  // Unknown closed-vocabulary values are rejected.
  for (const bad of [
    features({ contentFormat: 'hologram' }),
    features({ lengthUnit: 'parsecs' }),
    features({ narrativeStructure: 'stream_of_consciousness' }),
    features({ audienceFit: 'vibes' }),
    features({ freshness: 'crisp' }),
    features({ novelty: 'unicorn' }),
    features({ reuseRisk: 'spicy' }),
  ]) {
    assert.throws(() => assertValidContentCandidateFeatures(bad), InvalidRequestError);
  }
  // The length pair must be supplied together or both null.
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ lengthValue: null })),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ lengthUnit: null })),
    InvalidRequestError,
  );
  assert.doesNotThrow(() =>
    assertValidContentCandidateFeatures(features({ lengthValue: null, lengthUnit: null })),
  );
  // Hook features: closed vocabulary, no duplicates, ≤8.
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ hookFeatures: ['question', 'question'] })),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ hookFeatures: ['suspense'] })),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidContentCandidateFeatures(
        features({ hookFeatures: ['question', 'bold_claim', 'curiosity_gap', 'numbered_list', 'contrarian', 'emotional', 'urgency', 'identity_callout', 'pattern_interrupt'] }),
      ),
    InvalidRequestError,
  );
  // The observed objects: required performance, §21-guarded payloads.
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ observedPerformance: {} })),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidContentCandidateFeatures(
        features({ observedPerformance: { views: 1, nested: { password: 'leak' } } }),
      ),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ engagement: { secret: 'x' } })),
    InvalidRequestError,
  );
  // Niche bounds.
  assert.throws(
    () => assertValidContentCandidateFeatures(features({ niche: 'x'.repeat(201) })),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// The hypothesis structure discipline (evidence/hypothesis separation)
// ---------------------------------------------------------------------------

test('MKT-062 §6: a hypothesis REQUIRES ≥1 evidence reference — evidence/hypothesis separation', () => {
  assert.doesNotThrow(() =>
    assertValidContentHypothesisInput({
      hypothesisKind: 'format_hypothesis',
      statement: { summary: 'Short-form unboxing videos may outperform long ones for this audience.' },
      evidenceIds: ['11111111-1111-1111-1111-111111111111'],
      candidateIds: [],
      researchInsightIds: [],
    }),
  );
  // Zero evidence references are rejected (a hypothesis cites the evidence
  // it was generated from).
  assert.throws(
    () =>
      assertValidContentHypothesisInput({
        hypothesisKind: 'format_hypothesis',
        statement: { summary: 'ok' },
        evidenceIds: [],
        candidateIds: [],
        researchInsightIds: [],
      }),
    InvalidRequestError,
  );
  // The statement discipline: required bounded summary + §21 guard.
  assert.throws(
    () =>
      assertValidContentHypothesisInput({
        hypothesisKind: 'format_hypothesis',
        statement: { summary: 'x'.repeat(CONTENT_INTELLIGENCE_STATEMENT_SUMMARY_MAX + 1) },
        evidenceIds: ['11111111-1111-1111-1111-111111111111'],
        candidateIds: [],
        researchInsightIds: [],
      }),
    InvalidRequestError,
  );
  assert.throws(
    () =>
      assertValidContentHypothesisInput({
        hypothesisKind: 'format_hypothesis',
        statement: { summary: 'ok', nested: { secret: 'leak' } },
        evidenceIds: ['11111111-1111-1111-1111-111111111111'],
        candidateIds: [],
        researchInsightIds: [],
      }),
    InvalidRequestError,
  );
  // Unknown hypothesis kinds are rejected.
  assert.throws(
    () =>
      assertValidContentHypothesisInput({
        hypothesisKind: 'vibe_hypothesis',
        statement: { summary: 'ok' },
        evidenceIds: ['11111111-1111-1111-1111-111111111111'],
        candidateIds: [],
        researchInsightIds: [],
      }),
    InvalidRequestError,
  );
});

test('MKT-062: the server-derived provenance guard rejects caller-invented blocks', () => {
  assert.doesNotThrow(() =>
    assertValidContentIntelligenceProvenance({
      actor: 'user:11111111-1111-1111-1111-111111111111',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
    }),
  );
  assert.throws(
    () =>
      assertValidContentIntelligenceProvenance({
        actor: '',
        recordedVia: 'api',
        correlationId: 'c',
        causationId: null,
      }),
    InvalidRequestError,
  );
});

// ---------------------------------------------------------------------------
// The deterministic clustering + ranking (ci-cluster-v1 / ci-rank-v1)
// ---------------------------------------------------------------------------

function candidate(
  id: string,
  overrides: Partial<ContentCandidateRecord> = {},
): ContentCandidateRecord {
  return {
    contentCandidateId: id,
    clientId: '22222222-2222-2222-2222-222222222222',
    workspaceId: null,
    topicEntity: 'Widget unboxing',
    niche: 'widgets',
    subNiche: null,
    contentFormat: 'short_video',
    lengthValue: 45,
    lengthUnit: 'seconds',
    hookFeatures: ['question'],
    narrativeStructure: 'problem_solution',
    publishedAt: null,
    observedPerformance: { views: 1000 },
    performanceVelocity: null,
    engagement: null,
    audienceFit: 'moderate_fit',
    freshness: 'recent',
    novelty: 'variation',
    reuseRisk: 'medium',
    evidenceIds: ['11111111-1111-1111-1111-111111111111'],
    metricObservationIds: [],
    provenance: {
      actor: 'user:x',
      recordedVia: 'api',
      correlationId: 'c',
      causationId: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

test('MKT-062 ci-cluster-v1: the niche clustering is DETERMINISTIC with feature histograms', () => {
  const candidates = [
    candidate('a', { niche: 'widgets', subNiche: 'premium' }),
    candidate('b', { niche: 'widgets', subNiche: 'premium', contentFormat: 'article' }),
    candidate('c', { niche: 'widgets', subNiche: null, hookFeatures: ['question', 'urgency'] }),
    candidate('d', { niche: 'gadgets', subNiche: null }),
  ];
  const first = clusterContentCandidatesByNiche(candidates);
  const second = clusterContentCandidatesByNiche(candidates);
  assert.deepEqual(first, second, 'same inputs produce the same clusters');
  assert.deepEqual(
    first.map((cluster) => cluster.key),
    ['gadgets', 'widgets', 'widgets > premium'],
    'clusters are sorted by key',
  );
  const premium = first.find((cluster) => cluster.key === 'widgets > premium')!;
  assert.deepEqual(premium.candidateIds, ['a', 'b']);
  assert.deepEqual(premium.formatCounts, { short_video: 1, article: 1 });
  assert.deepEqual(premium.narrativeCounts, { problem_solution: 2 });
  const widgets = first.find((cluster) => cluster.key === 'widgets')!;
  assert.deepEqual(widgets.hookFeatures, ['question', 'urgency'], 'hook features are deduplicated and sorted');
  // Empty input clusters to nothing.
  assert.deepEqual(clusterContentCandidatesByNiche([]), []);
});

test('MKT-062 ci-rank-v1: the candidate ranking is DETERMINISTIC with the disclosed weights and a total tiebreak', () => {
  const top = candidate('top', {
    audienceFit: 'strong_fit',
    freshness: 'breaking',
    novelty: 'novel',
    reuseRisk: 'low',
  });
  const mid = candidate('mid', {
    audienceFit: 'moderate_fit',
    freshness: 'recent',
    novelty: 'variation',
    reuseRisk: 'medium',
  });
  const low = candidate('low', {
    audienceFit: 'weak_fit',
    freshness: 'dated',
    novelty: 'saturated',
    reuseRisk: 'high',
  });
  const tied1 = candidate('tied-1');
  const tied2 = candidate('tied-2');
  const candidates = [low, tied2, mid, tied1, top];
  const first = rankContentCandidates(candidates);
  const second = rankContentCandidates(candidates);
  assert.deepEqual(first, second, 'same inputs produce the same order');
  assert.deepEqual(
    first.map((entry) => entry.contentCandidateId),
    ['top', 'mid', 'tied-1', 'tied-2', 'low'],
    'score descending with the candidate-id tiebreak (a deterministic total order — never a coin flip)',
  );
  const topEntry = first[0]!;
  assert.equal(topEntry.score, 3 + 4 + 3 + 3);
  assert.deepEqual(topEntry.breakdown, {
    audienceFit: 3,
    freshness: 4,
    novelty: 3,
    reuseRisk: 3,
  });
  // The ranked order is a RECOMMENDATION as data — the input records are
  // never mutated.
  assert.equal(low.audienceFit, 'weak_fit');
  assert.equal(candidates.length, 5);
  assert.deepEqual(rankContentCandidates([]), []);
});
