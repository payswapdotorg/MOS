/**
 * The deterministic two-sample statistics core of /experiment-analysis
 * (MKT-067 — 'two_sample_means_v1'). PURE: zero I/O, zero randomness,
 * zero clock reads, fixed z constants — the same inputs ALWAYS produce
 * the same outputs (the frozen determinism rule; the module's matrix row
 * lists no /ai-runtime dependency and none is used).
 *
 * The computed set is exactly the §12 list that is statistical:
 * treatment/comparison effects (per-arm means + the difference with its
 * Welch standard error), uncertainty (the normal-approximation interval
 * at the declared level), sample sizes, the sequential-analysis state
 * (Bonferroni over the recorded look budget) and the outcome
 * classification against the recorded practical effect threshold.
 * Confounders/limitations merging and the recommended next allocation
 * guidance also live here (pure derivations over the computed effect).
 */

import {
  EXPERIMENT_ANALYSIS_DEFAULT_MAX_LOOKS,
  UNCERTAINTY_LEVEL_Z,
  type ExperimentAnalysisUncertainty,
  type ExperimentAnalysisUncertaintyLevel,
  type ExperimentAnalysisOutcome,
  type ExperimentSequentialAnalysisState,
  type RecommendedAllocationDirection,
} from '../public.ts';

/** The inputs of the two-sample effect computation (per-arm raw values). */
export interface TwoArmEffectInput {
  readonly treatmentValues: readonly number[];
  readonly comparisonValues: readonly number[];
  readonly level: ExperimentAnalysisUncertaintyLevel;
}

/** The computed two-sample effect (the §12 "treatment/comparison effects"). */
export interface TwoArmEffect {
  readonly nTreatment: number;
  readonly nComparison: number;
  readonly treatmentMean: number | null;
  readonly comparisonMean: number | null;
  readonly effectEstimate: number | null;
  readonly standardError: number | null;
  readonly uncertainty: ExperimentAnalysisUncertainty;
}

/** Mean of a finite-number sample (null when empty — never a fabricated zero). */
function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** Sample variance of a finite-number sample (null when fewer than 2). */
function varianceOf(values: readonly number[], mean: number): number | null {
  if (values.length < 2) return null;
  let accumulator = 0;
  for (const value of values) {
    const delta = value - mean;
    accumulator += delta * delta;
  }
  return accumulator / (values.length - 1);
}

/**
 * Computes the two-sample effect deterministically: per-arm means, the
 * effect estimate (treatment mean − comparison mean), the Welch standard
 * error sqrt(s_t²/n_t + s_c²/n_c) and the normal-approximation interval
 * at the declared level. An arm with ZERO observations yields null means
 * and the honest 'none' uncertainty — never a fabricated zero effect.
 */
export function computeTwoArmEffect(input: TwoArmEffectInput): TwoArmEffect {
  const { treatmentValues, comparisonValues, level } = input;
  const nTreatment = treatmentValues.length;
  const nComparison = comparisonValues.length;
  const treatmentMean = meanOf(treatmentValues);
  const comparisonMean = meanOf(comparisonValues);

  if (nTreatment === 0 || nComparison === 0) {
    return {
      nTreatment,
      nComparison,
      treatmentMean,
      comparisonMean,
      effectEstimate: null,
      standardError: null,
      uncertainty: {
        kind: 'none',
        reason:
          nTreatment === 0 && nComparison === 0
            ? 'neither arm has observations inside the declared window'
            : nTreatment === 0
              ? 'the treatment arm has no observations inside the declared window'
              : 'the comparison arm has no observations inside the declared window',
      },
    };
  }

  // Both arms observed: the effect is the mean difference with its Welch
  // standard error. A single-observation arm contributes a zero variance
  // term (the honest degenerate case — deterministic).
  const treatmentVariance = varianceOf(treatmentValues, treatmentMean!);
  const comparisonVariance = varianceOf(comparisonValues, comparisonMean!);
  const treatmentTerm = treatmentVariance === null ? 0 : treatmentVariance / nTreatment;
  const comparisonTerm = comparisonVariance === null ? 0 : comparisonVariance / nComparison;
  const standardError = Math.sqrt(treatmentTerm + comparisonTerm);
  const effectEstimate = treatmentMean! - comparisonMean!;
  const z = UNCERTAINTY_LEVEL_Z[level];
  return {
    nTreatment,
    nComparison,
    treatmentMean,
    comparisonMean,
    effectEstimate,
    standardError,
    uncertainty: {
      kind: 'interval',
      level,
      lower: effectEstimate - z * standardError,
      upper: effectEstimate + z * standardError,
    },
  };
}

/**
 * Classifies the computed effect against the recorded practical threshold
 * (§12 "practical effect thresholds"). PURE and total: every interval
 * state maps to exactly one outcome of the frozen vocabulary —
 *   - interval entirely above +t          → effect_positive
 *   - interval entirely below −t          → effect_negative
 *   - interval bounded within [−t, +t]   → effect_negligible (a precise null)
 *   - interval straddling any boundary    → inconclusive (the honest unknown)
 *   - either arm below the minimum sample → insufficient_observations
 * A NEGATIVE or INCONCLUSIVE result is a valid scientific outcome,
 * returned exactly as computed — never coerced to a success.
 */
export function classifyAnalysisOutcome(input: {
  readonly effect: TwoArmEffect;
  readonly practicalThreshold: number;
  readonly minObservationsPerArm: number;
}): ExperimentAnalysisOutcome {
  const { effect, practicalThreshold: threshold, minObservationsPerArm } = input;
  if (
    effect.nTreatment < minObservationsPerArm ||
    effect.nComparison < minObservationsPerArm
  ) {
    return 'insufficient_observations';
  }
  if (effect.uncertainty.kind !== 'interval') {
    // Both arms observed (guarded above) but no interval cannot happen;
    // the honest fallback is inconclusive, never a fabricated direction.
    return 'inconclusive';
  }
  const { lower, upper } = effect.uncertainty;
  if (lower > threshold && upper > threshold) return 'effect_positive';
  if (lower < -threshold && upper < -threshold) return 'effect_negative';
  if (lower >= -threshold && upper <= threshold) return 'effect_negligible';
  return 'inconclusive';
}

/**
 * Computes the sequential-analysis state (§12 "sequential-analysis
 * state") from the prior-analysis count: this analysis is the
 * (priorCount + 1)-th interim LOOK inside the recorded Bonferroni look
 * budget. The per-look interval level is 1 − (1 − level)/maxLooks
 * (Bonferroni across the budget); cumulativeAlphaSpent is the alpha
 * consumed by the looks so far INCLUDING this one; boundaryCrossed states
 * whether the nominal-level directional conclusion would ALSO hold at
 * the stricter per-look level. Deterministic: the same prior count,
 * level and budget always produce the same state.
 */
export function computeSequentialState(input: {
  readonly priorAnalysisCount: number;
  readonly level: ExperimentAnalysisUncertaintyLevel;
  readonly effect: TwoArmEffect;
  readonly practicalThreshold: number;
  readonly outcome: ExperimentAnalysisOutcome;
  readonly maxLooks?: number;
}): ExperimentSequentialAnalysisState {
  const maxLooks = input.maxLooks ?? EXPERIMENT_ANALYSIS_DEFAULT_MAX_LOOKS;
  const interimIndex = input.priorAnalysisCount + 1;
  const alpha = 1 - input.level;
  const perLookLevel = 1 - alpha / maxLooks;
  const cumulativeAlphaSpent = (Math.min(interimIndex, maxLooks) * alpha) / maxLooks;

  // Boundary crossing: the nominal-level directional conclusion (positive
  // or negative — both directions are equally scientific) would also
  // hold at the stricter per-look level. Requires both arms observed.
  let boundaryCrossed = false;
  if (input.effect.uncertainty.kind === 'interval' && input.outcome !== 'insufficient_observations') {
    const zPerLook = quantileForLevel(perLookLevel);
    if (zPerLook !== null && input.effect.effectEstimate !== null && input.effect.standardError !== null) {
      const perLookLower = input.effect.effectEstimate - zPerLook * input.effect.standardError;
      const perLookUpper = input.effect.effectEstimate + zPerLook * input.effect.standardError;
      const t = input.practicalThreshold;
      if (input.outcome === 'effect_positive') {
        boundaryCrossed = perLookLower > t;
      } else if (input.outcome === 'effect_negative') {
        boundaryCrossed = perLookUpper < -t;
      }
    }
  }

  const continueAllowed = interimIndex < maxLooks;
  const note =
    interimIndex > maxLooks
      ? `look ${interimIndex} exceeds the recorded sequential budget of ${maxLooks} interim analyses — the alpha budget is exhausted; further looks carry no fresh evidential weight (a NEW experiment through the /experiments authority is the honest path)`
      : continueAllowed
        ? `interim look ${interimIndex} of the recorded ${maxLooks}-look budget; per-look level ${perLookLevel.toFixed(4)} (Bonferroni); cumulative alpha spent ${cumulativeAlphaSpent.toFixed(4)}`
        : `interim look ${interimIndex} closes the recorded ${maxLooks}-look budget; cumulative alpha spent ${cumulativeAlphaSpent.toFixed(4)}`;

  return {
    interimIndex,
    maxLooks,
    perLookLevel,
    cumulativeAlphaSpent,
    boundaryCrossed,
    continueAllowed,
    note,
  };
}

/** The fixed z table extended to arbitrary levels via the same constants (null when unresolvable). */
function quantileForLevel(level: number): number | null {
  // The supported per-look levels resolve from the fixed table: for the
  // supported nominal levels and the default look budgets, the derived
  // per-look level is interpolated deterministically from the same
  // normal-quantile table (piecewise-linear over the fixed support
  // points — a bounded, documented approximation, deterministic by
  // construction).
  const support: ReadonlyArray<readonly [number, number]> = [
    [0.9, 1.6448536269514722],
    [0.95, 1.959963984540054],
    [0.99, 2.5758293035489004],
    [0.995, 2.807033768340534],
    [0.999, 3.2905267314919255],
    [0.9999, 3.890591886330818],
  ];
  if (level < support[0]![0] || level > support[support.length - 1]![0]) return null;
  for (let index = 0; index < support.length; index++) {
    const [levelAt, zAt] = support[index]!;
    if (level === levelAt) return zAt;
  }
  // Piecewise-linear interpolation between the bracketing support points.
  for (let index = 0; index < support.length - 1; index++) {
    const [levelLow, zLow] = support[index]!;
    const [levelHigh, zHigh] = support[index + 1]!;
    if (level > levelLow && level < levelHigh) {
      const fraction = (level - levelLow) / (levelHigh - levelLow);
      return zLow + fraction * (zHigh - zLow);
    }
  }
  return null;
}

/**
 * The §12 two-arm guidance derived from the outcome (recorded as DATA —
 * a recommendation, never an exposure mutation):
 *   - effect_positive      → shift_toward_treatment
 *   - effect_negative      → shift_toward_comparison
 *   - effect_negligible    → conclude_and_adopt (the difference is
 *                            precisely practical null — concluding is the
 *                            data recommendation; the /experiments
 *                            authority still owns the conclude transition)
 *   - inconclusive /
 *     insufficient_observations → hold_balanced (keep exploring ~50/50)
 */
export function recommendedAllocationForOutcome(
  outcome: ExperimentAnalysisOutcome,
): RecommendedAllocationDirection {
  switch (outcome) {
    case 'effect_positive':
      return 'shift_toward_treatment';
    case 'effect_negative':
      return 'shift_toward_comparison';
    case 'effect_negligible':
      return 'conclude_and_adopt';
    case 'inconclusive':
    case 'insufficient_observations':
      return 'hold_balanced';
  }
}

/**
 * Merges the declared confounders with the deterministic derived entries
 * (the §12 "confounders"): arm sample imbalance beyond a 20% relative
 * gap, and any non-'ok' observation qualities consumed. Declared entries
 * are retained verbatim FIRST (caller honesty), derived entries appended
 * with a stable order — the merge is deterministic and total.
 */
export function mergeConfounders(input: {
  readonly declared: readonly string[];
  readonly nTreatment: number;
  readonly nComparison: number;
  readonly nonOkQualityCount: number;
}): readonly string[] {
  const merged: string[] = [...input.declared];
  const largest = Math.max(input.nTreatment, input.nComparison);
  if (largest > 0) {
    const gap = Math.abs(input.nTreatment - input.nComparison) / largest;
    if (gap > 0.2) {
      merged.push(
        `derived:arm_sample_imbalance (treatment n=${input.nTreatment} vs comparison n=${input.nComparison}; relative gap ${(gap * 100).toFixed(1)}%)`,
      );
    }
  }
  if (input.nonOkQualityCount > 0) {
    merged.push(
      `derived:consumed_${input.nonOkQualityCount}_non_ok_quality_observations (data-quality caveat on the consumed window)`,
    );
  }
  return merged;
}

/**
 * Merges the declared limitations with the deterministic derived entries
 * (the §12 "limitations"): zero-sample arms, below-minimum samples, the
 * bounded /metrics read (the house ledger is bounded — long windows may
 * exceed the read limit), and an exhausted sequential budget. Declared
 * entries are retained verbatim FIRST; derived entries appended in a
 * stable order — deterministic and total.
 */
export function mergeLimitations(input: {
  readonly declared: readonly string[];
  readonly nTreatment: number;
  readonly nComparison: number;
  readonly minObservationsPerArm: number;
  readonly observationReadTruncated: boolean;
  readonly sequentialBudgetExhausted: boolean;
}): readonly string[] {
  const merged: string[] = [...input.declared];
  if (input.nTreatment === 0) {
    merged.push('derived:treatment_arm_has_zero_observations_in_window');
  }
  if (input.nComparison === 0) {
    merged.push('derived:comparison_arm_has_zero_observations_in_window');
  }
  if (input.nTreatment > 0 && input.nTreatment < input.minObservationsPerArm) {
    merged.push(
      `derived:treatment_sample_below_declared_minimum (${input.nTreatment} < ${input.minObservationsPerArm})`,
    );
  }
  if (input.nComparison > 0 && input.nComparison < input.minObservationsPerArm) {
    merged.push(
      `derived:comparison_sample_below_declared_minimum (${input.nComparison} < ${input.minObservationsPerArm})`,
    );
  }
  if (input.observationReadTruncated) {
    merged.push(
      'derived:observation_read_truncated (the /metrics client ledger read is bounded; the window may extend past the read limit — narrow the window or raise the observation cadence)',
    );
  }
  if (input.sequentialBudgetExhausted) {
    merged.push(
      'derived:sequential_look_budget_exhausted (the recorded interim-analysis budget is spent; further looks carry no fresh evidential weight)',
    );
  }
  return merged;
}
