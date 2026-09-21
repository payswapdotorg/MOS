/**
 * MKT-067 unit tests — the deterministic two-sample statistics core of
 * /experiment-analysis: the frozen vocabularies, the effect computation
 * (per-arm means, Welch standard error, fixed-z intervals), the outcome
 * classification against the recorded practical threshold, the
 * sequential-analysis state (Bonferroni over the recorded look budget),
 * the recommended-allocation guidance, the confounder/limitation merges —
 * and the DETERMINISM proofs (same inputs → same outputs, negative and
 * inconclusive results preserved as first-class values).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPERIMENT_ANALYSIS_OUTCOMES,
  NON_POSITIVE_ANALYSIS_OUTCOMES,
  RECOMMENDED_ALLOCATION_DIRECTIONS,
  EXPERIMENT_ANALYSIS_METHOD,
  EXPERIMENT_ANALYSIS_METHOD_VERSION,
  UNCERTAINTY_LEVEL_Z,
  classifyAnalysisOutcome,
  computeSequentialState,
  computeTwoArmEffect,
  recommendedAllocationForOutcome,
  mergeConfounders,
  mergeLimitations,
} from '../../src/modules/experiment-analysis/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies
// ---------------------------------------------------------------------------

test('MKT-067: the analysis outcome vocabulary is the frozen §12 set — negative and inconclusive are first-class', () => {
  assert.deepEqual(EXPERIMENT_ANALYSIS_OUTCOMES, [
    'effect_positive',
    'effect_negative',
    'effect_negligible',
    'inconclusive',
    'insufficient_observations',
  ]);
  // A negative or inconclusive result is a VALID SCIENTIFIC OUTCOME — the
  // vocabulary carries it as first-class values, never as errors.
  assert.ok(NON_POSITIVE_ANALYSIS_OUTCOMES.includes('effect_negative'));
  assert.ok(NON_POSITIVE_ANALYSIS_OUTCOMES.includes('inconclusive'));
  assert.equal(NON_POSITIVE_ANALYSIS_OUTCOMES.length, 4);
});

test('MKT-067: the recommended-allocation vocabulary and the method identity are frozen', () => {
  assert.deepEqual(RECOMMENDED_ALLOCATION_DIRECTIONS, [
    'shift_toward_treatment',
    'shift_toward_comparison',
    'hold_balanced',
    'conclude_and_adopt',
  ]);
  assert.equal(EXPERIMENT_ANALYSIS_METHOD, 'two_sample_means_v1');
  assert.equal(EXPERIMENT_ANALYSIS_METHOD_VERSION, '1.0.0');
  // The fixed z table (determinism pin).
  assert.equal(UNCERTAINTY_LEVEL_Z[0.95], 1.959963984540054);
});

// ---------------------------------------------------------------------------
// The two-sample effect computation
// ---------------------------------------------------------------------------

test('MKT-067: the two-sample effect computes means, the difference and the Welch interval deterministically', () => {
  const treatmentValues = [12, 14, 16, 18, 20, 22]; // mean 17
  const comparisonValues = [10, 10, 12, 12, 14, 14]; // mean 12
  const effect = computeTwoArmEffect({ treatmentValues, comparisonValues, level: 0.95 });
  assert.equal(effect.nTreatment, 6);
  assert.equal(effect.nComparison, 6);
  assert.equal(effect.treatmentMean, 17);
  assert.equal(effect.comparisonMean, 12);
  assert.equal(effect.effectEstimate, 5);
  if (effect.uncertainty.kind === 'interval') {
    assert.equal(effect.uncertainty.level, 0.95);
    assert.ok(effect.uncertainty.lower < 5 && effect.uncertainty.upper > 5);
    assert.ok(Math.abs((effect.uncertainty.lower + effect.uncertainty.upper) / 2 - 5) < 1e-9);
  } else {
    assert.fail('both arms observed — the interval must be present');
  }
  assert.ok(effect.standardError !== null && effect.standardError > 0);

  // DETERMINISM: the same inputs produce byte-identical outputs.
  const again = computeTwoArmEffect({ treatmentValues, comparisonValues, level: 0.95 });
  assert.deepEqual(again, effect);
});

test('MKT-067: a zero-observation arm yields the honest null — never a fabricated zero effect', () => {
  const effect = computeTwoArmEffect({
    treatmentValues: [],
    comparisonValues: [1, 2, 3],
    level: 0.99,
  });
  assert.equal(effect.nTreatment, 0);
  assert.equal(effect.nComparison, 3);
  assert.equal(effect.treatmentMean, null);
  assert.equal(effect.effectEstimate, null);
  assert.equal(effect.standardError, null);
  assert.equal(effect.uncertainty.kind, 'none');
  if (effect.uncertainty.kind === 'none') {
    assert.match(effect.uncertainty.reason, /treatment arm has no observations/);
  }
});

// ---------------------------------------------------------------------------
// The outcome classification (the practical threshold semantics)
// ---------------------------------------------------------------------------

test('MKT-067: classification against the recorded practical threshold — every interval state maps to exactly one outcome', () => {
  const make = (lower: number, upper: number, nT = 50, nC = 50) =>
    classifyAnalysisOutcome({
      effect: {
        nTreatment: nT,
        nComparison: nC,
        treatmentMean: 0,
        comparisonMean: 0,
        effectEstimate: (lower + upper) / 2,
        standardError: (upper - lower) / 2,
        uncertainty: { kind: 'interval' as const, level: 0.95, lower, upper },
      },
      practicalThreshold: 1,
      minObservationsPerArm: 10,
    });

  // Entirely above +1 → effect_positive.
  assert.equal(make(1.5, 3.5), 'effect_positive');
  // Entirely below −1 → effect_negative (the honest negative result).
  assert.equal(make(-3.5, -1.5), 'effect_negative');
  // Bounded within [−1, +1] → effect_negligible (a precise null).
  assert.equal(make(-0.4, 0.6), 'effect_negligible');
  assert.equal(make(-1, 1), 'effect_negligible');
  // Straddling a boundary → inconclusive (the honest unknown).
  assert.equal(make(0.5, 1.5), 'inconclusive');
  assert.equal(make(-1.5, 0.5), 'inconclusive');
  assert.equal(make(-2, 2), 'inconclusive');
});

test('MKT-067: below-minimum samples classify insufficient_observations whatever the interval says', () => {
  const effect = computeTwoArmEffect({
    treatmentValues: [10, 12, 14, 16, 18, 20, 22, 24, 26, 28],
    comparisonValues: [1, 2, 3],
    level: 0.95,
  });
  const outcome = classifyAnalysisOutcome({
    effect,
    practicalThreshold: 0,
    minObservationsPerArm: 10,
  });
  assert.equal(outcome, 'insufficient_observations');
});

// ---------------------------------------------------------------------------
// The sequential-analysis state (§12 "sequential-analysis state")
// ---------------------------------------------------------------------------

test('MKT-067: the sequential state advances with the analysis tail — Bonferroni per-look level, cumulative alpha, boundary', () => {
  const effect = computeTwoArmEffect({
    treatmentValues: Array.from({ length: 40 }, (_, i) => 20 + i * 0.01),
    comparisonValues: Array.from({ length: 40 }, () => 10),
    level: 0.95,
  });
  const first = computeSequentialState({
    priorAnalysisCount: 0,
    level: 0.95,
    effect,
    practicalThreshold: 0,
    outcome: 'effect_positive',
  });
  assert.equal(first.interimIndex, 1);
  assert.equal(first.maxLooks, 5);
  // Bonferroni: per-look level 1 − 0.05/5 = 0.99.
  assert.ok(Math.abs(first.perLookLevel - 0.99) < 1e-12);
  assert.ok(Math.abs(first.cumulativeAlphaSpent - 0.01) < 1e-12);
  assert.equal(first.continueAllowed, true);

  const fourth = computeSequentialState({
    priorAnalysisCount: 3,
    level: 0.95,
    effect,
    practicalThreshold: 0,
    outcome: 'effect_positive',
  });
  assert.equal(fourth.interimIndex, 4);
  assert.ok(Math.abs(fourth.cumulativeAlphaSpent - 0.04) < 1e-12);
  assert.equal(fourth.continueAllowed, true);

  const final = computeSequentialState({
    priorAnalysisCount: 4,
    level: 0.95,
    effect,
    practicalThreshold: 0,
    outcome: 'effect_positive',
  });
  assert.equal(final.interimIndex, 5);
  assert.equal(final.continueAllowed, false);
  assert.match(final.note, /closes the recorded 5-look budget/);

  const exhausted = computeSequentialState({
    priorAnalysisCount: 5,
    level: 0.95,
    effect,
    practicalThreshold: 0,
    outcome: 'effect_positive',
  });
  assert.equal(exhausted.interimIndex, 6);
  assert.equal(exhausted.continueAllowed, false);
  assert.match(exhausted.note, /exceeds the recorded sequential budget/);

  // A strong effect crosses the per-look boundary; a weak one does not.
  assert.equal(first.boundaryCrossed, true);
  const weak = computeSequentialState({
    priorAnalysisCount: 0,
    level: 0.95,
    effect: {
      ...effect,
      effectEstimate: 0.05,
      standardError: 0.5,
      uncertainty: { kind: 'interval' as const, level: 0.95, lower: -0.93, upper: 1.03 },
    },
    practicalThreshold: 0,
    outcome: 'inconclusive',
  });
  assert.equal(weak.boundaryCrossed, false);

  // DETERMINISM.
  assert.deepEqual(
    computeSequentialState({ priorAnalysisCount: 3, level: 0.95, effect, practicalThreshold: 0, outcome: 'effect_positive' }),
    fourth,
  );
});

// ---------------------------------------------------------------------------
// The recommended next allocation (the §12 two-arm guidance)
// ---------------------------------------------------------------------------

test('MKT-067: the recommended-allocation guidance maps every outcome exactly once (the total mapping)', () => {
  assert.equal(recommendedAllocationForOutcome('effect_positive'), 'shift_toward_treatment');
  assert.equal(recommendedAllocationForOutcome('effect_negative'), 'shift_toward_comparison');
  assert.equal(recommendedAllocationForOutcome('effect_negligible'), 'conclude_and_adopt');
  assert.equal(recommendedAllocationForOutcome('inconclusive'), 'hold_balanced');
  assert.equal(recommendedAllocationForOutcome('insufficient_observations'), 'hold_balanced');
});

// ---------------------------------------------------------------------------
// The confounder/limitation merges (declared inputs retained verbatim)
// ---------------------------------------------------------------------------

test('MKT-067: declared confounders/limitations are retained verbatim FIRST; derived entries append deterministically', () => {
  const confounders = mergeConfounders({
    declared: ['posting-time overlap', 'seasonality'],
    nTreatment: 100,
    nComparison: 40,
    nonOkQualityCount: 3,
  });
  assert.deepEqual(confounders.slice(0, 2), ['posting-time overlap', 'seasonality']);
  assert.ok(confounders.some((entry) => entry.startsWith('derived:arm_sample_imbalance')));
  assert.ok(confounders.some((entry) => entry.startsWith('derived:consumed_3_non_ok_quality_observations')));

  // Balanced arms and clean quality derive nothing.
  const clean = mergeConfounders({
    declared: [],
    nTreatment: 50,
    nComparison: 50,
    nonOkQualityCount: 0,
  });
  assert.deepEqual(clean, []);

  const limitations = mergeLimitations({
    declared: ['short window'],
    nTreatment: 0,
    nComparison: 8,
    minObservationsPerArm: 30,
    observationReadTruncated: false,
    sequentialBudgetExhausted: true,
  });
  assert.equal(limitations[0], 'short window');
  assert.ok(limitations.includes('derived:treatment_arm_has_zero_observations_in_window'));
  assert.ok(limitations.some((entry) => entry.startsWith('derived:comparison_sample_below_declared_minimum')));
  assert.ok(limitations.some((entry) => entry.startsWith('derived:sequential_look_budget_exhausted')));
});

// ---------------------------------------------------------------------------
// The honest-negative spine (the §12 closing rule, end-to-end on the pure core)
// ---------------------------------------------------------------------------

test('MKT-067: a NEGATIVE result is computed, classified and preserved exactly — never coerced to success', () => {
  // The treatment arm performs measurably WORSE than the comparison.
  const effect = computeTwoArmEffect({
    treatmentValues: Array.from({ length: 60 }, () => 4),
    comparisonValues: Array.from({ length: 60 }, () => 10),
    level: 0.95,
  });
  assert.equal(effect.effectEstimate, -6);
  const outcome = classifyAnalysisOutcome({
    effect,
    practicalThreshold: 1,
    minObservationsPerArm: 30,
  });
  assert.equal(outcome, 'effect_negative');
  assert.equal(recommendedAllocationForOutcome(outcome), 'shift_toward_comparison');
});

test('MKT-067: an INCONCLUSIVE result is computed and preserved exactly — the honest unknown', () => {
  const effect = computeTwoArmEffect({
    treatmentValues: [10, 14, 11, 13, 12, 15, 9, 16, 12, 13],
    comparisonValues: [12, 12, 13, 11, 12, 14, 12, 13, 12, 12],
    level: 0.95,
  });
  const outcome = classifyAnalysisOutcome({
    effect,
    practicalThreshold: 0,
    minObservationsPerArm: 5,
  });
  assert.equal(outcome, 'inconclusive');
  assert.equal(recommendedAllocationForOutcome(outcome), 'hold_balanced');
});
