/**
 * The observation selection filter of /experiment-analysis (MKT-067):
 * PURE selection of the /metrics observations one analysis consumes.
 *
 * The deterministic consumption rule (documented, total):
 *   - the observation's metric NAME equals the experiment's declared
 *     primary-metric name;
 *   - EVERY declared dimension key/value pair matches (the declared
 *     identity is a SUBSET of the observation's dimensions — experiments
 *     are declared before observations exist, so observations may carry
 *     richer dimensions);
 *   - the observation carries the RESERVED split dimension 'arm' with
 *     value 'treatment' or 'comparison' (the house arm-label convention);
 *     observations missing the split dimension or carrying another arm
 *     value are NOT consumed (they are not this experiment's arms);
 *   - the observation's observedAt lies inside the declared window
 *     [start, end) — inclusive start, exclusive end, both over
 *     observed_at (the METRIC-001 observation timestamp, never the
 *     retrieval or recording stamps).
 *
 * The consumed set is returned CANONICALLY ORDERED by observation id —
 * the snapshot (and therefore the digest and the analysis) never depends
 * on the ledger's read order.
 */

import {
  EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY,
  EXPERIMENT_ANALYSIS_ARM_VALUES,
  type ExperimentAnalysisArmValue,
  type ExperimentAnalysisConsumedObservation,
} from '../public.ts';

/** The minimal structural view of a /metrics observation the selector needs. */
export interface SelectableMetricObservation {
  readonly observationId: string;
  readonly metricName: string;
  readonly dimensions: Readonly<Record<string, string | number | boolean>>;
  readonly value: number;
  readonly observedAt: string;
  readonly unit: string;
  readonly quality: string;
}

/** True when the observation's dimensions satisfy the declared identity (subset match). */
function matchesDeclaredDimensions(
  observation: SelectableMetricObservation,
  declared: Readonly<Record<string, string | number | boolean>>,
): boolean {
  for (const [key, value] of Object.entries(declared)) {
    if (observation.dimensions[key] !== value) return false;
  }
  return true;
}

/**
 * Selects the observations one analysis consumes (PURE): the name +
 * declared-dimensions match, the reserved arm split, and the window
 * [start, end) over observedAt — returned sorted by observation id with
 * the per-arm values split out. The count of observations carrying a
 * non-'ok' quality is returned for the derived-limitations merge.
 */
export function selectObservationsForAnalysis(input: {
  readonly observations: readonly SelectableMetricObservation[];
  readonly metricName: string;
  readonly declaredDimensions: Readonly<Record<string, string | number | boolean>>;
  readonly windowStart: string;
  readonly windowEnd: string;
}): {
  readonly consumed: readonly ExperimentAnalysisConsumedObservation[];
  readonly nonOkQualityCount: number;
} {
  const startMs = Date.parse(input.windowStart);
  const endMs = Date.parse(input.windowEnd);
  const consumed: ExperimentAnalysisConsumedObservation[] = [];
  let nonOkQualityCount = 0;

  for (const observation of input.observations) {
    if (observation.metricName !== input.metricName) continue;
    if (!matchesDeclaredDimensions(observation, input.declaredDimensions)) continue;
    const armValue = observation.dimensions[EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY];
    if (
      armValue !== EXPERIMENT_ANALYSIS_ARM_VALUES[0] &&
      armValue !== EXPERIMENT_ANALYSIS_ARM_VALUES[1]
    ) {
      continue;
    }
    const arm = armValue as ExperimentAnalysisArmValue;
    const observedMs = Date.parse(observation.observedAt);
    if (Number.isNaN(observedMs) || observedMs < startMs || observedMs >= endMs) continue;
    if (observation.quality !== 'ok') nonOkQualityCount += 1;
    consumed.push({
      observationId: observation.observationId,
      arm,
      value: observation.value,
      observedAt: observation.observedAt,
      unit: observation.unit,
      quality: observation.quality,
    });
  }

  // Canonical order: observation id ASC (stable, total — the digest never
  // depends on the ledger's read order).
  consumed.sort((a, b) => (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0));
  return { consumed, nonOkQualityCount };
}

/** Splits the consumed observations into per-arm value lists (deterministic order). */
export function splitByArm(
  consumed: readonly ExperimentAnalysisConsumedObservation[],
): {
  readonly treatmentValues: readonly number[];
  readonly comparisonValues: readonly number[];
} {
  const treatmentValues: number[] = [];
  const comparisonValues: number[] = [];
  for (const observation of consumed) {
    if (observation.arm === 'treatment') treatmentValues.push(observation.value);
    else comparisonValues.push(observation.value);
  }
  return { treatmentValues, comparisonValues };
}
