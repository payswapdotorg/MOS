/**
 * The canonical deterministic snapshot digests of /experiment-analysis
 * (MKT-067 — the growth-operator evidence-snapshot precedent): canonical,
 * order-stable, BOUNDED strings over the full input snapshots. Same
 * snapshot → same digest — the equality token that makes every analysis
 * and every allocation decision reproducible and auditable (the FULL
 * snapshots ride the rows as jsonb; the digest is the comparison token).
 *
 * PURE: zero I/O, zero clock reads, fixed-width component rendering.
 */

import {
  EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
  type ExperimentAnalysisInputSnapshot,
  type ExperimentAllocationInputSnapshot,
} from '../public.ts';

/**
 * The stable bounded hash of a string list (FNV-1a 32-bit over the
 * comma-joined items): deterministic, fixed-width. The FULL lists stay
 * in the row's input snapshot — the digest is an equality token, and the
 * long id lists are hashed so the token never outgrows the storage
 * fence (the growth-operator precedent, verbatim discipline).
 */
function stableListHash(items: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = items.join(',');
  for (let index = 0; index < joined.length; index++) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Canonical bounded rendering of one number (deterministic, no locale). */
function canonicalNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'NaN';
}

/**
 * Computes the deterministic ANALYSIS input-snapshot digest: the
 * experiment anchor, the window, the consumed observations (count +
 * fixed-width hash of their canonical tuples), the evidence links, the
 * consumed learnings, the prior-analysis count, the resolved
 * minimum/level/threshold, the declared confounders/limitations and the
 * method identity. Same snapshot → same digest → same analysis.
 */
export function computeExperimentAnalysisSnapshotDigest(
  snapshot: ExperimentAnalysisInputSnapshot,
): string {
  // CANONICAL ORDER: the observation tuples are hashed in observation-id
  // order (the snapshot builder sorts too — the digest is canonical
  // regardless of the incoming array order, so the equality token never
  // depends on a read order).
  const observationPart = `${snapshot.observations.length}:${stableListHash(
    [...snapshot.observations]
      .sort((a, b) => (a.observationId < b.observationId ? -1 : a.observationId > b.observationId ? 1 : 0))
      .map(
        (observation) =>
          `${observation.observationId}|${observation.arm}|${canonicalNumber(observation.value)}|${observation.observedAt}|${observation.unit}|${observation.quality}`,
      ),
  )}`;
  const learningPart = `${snapshot.learnings.length}:${stableListHash(
    [...snapshot.learnings]
      .sort((a, b) => (a.learningId < b.learningId ? -1 : a.learningId > b.learningId ? 1 : 0))
      .map(
        (learning) => `${learning.learningId}|${learning.confidence === null ? '' : canonicalNumber(learning.confidence)}`,
      ),
  )}`;
  const evidencePart = `${snapshot.evidenceRefs.length}:${stableListHash(snapshot.evidenceRefs)}`;
  const confounderPart = stableListHash(snapshot.declaredConfounders);
  const limitationPart = stableListHash(snapshot.declaredLimitations);
  const dimensionPart = Object.keys(snapshot.experiment.primaryMetricDimensions)
    .sort()
    .map(
      (key) =>
        `${key}=${String(snapshot.experiment.primaryMetricDimensions[key] ?? '')}`,
    )
    .join(',');
  return [
    `v=${EXPERIMENT_ANALYSIS_VOCABULARY_VERSION}`,
    `m=${snapshot.analysisMethod}/${snapshot.analysisMethodVersion}`,
    `e=${snapshot.experiment.experimentId}/${snapshot.experiment.status}/${snapshot.experiment.resultState}`,
    `metric=${snapshot.experiment.primaryMetricName}|[${dimensionPart}]`,
    `w=${snapshot.window.start}/${snapshot.window.end}`,
    `o=${observationPart}`,
    `ev=${evidencePart}`,
    `l=${learningPart}`,
    `p=${snapshot.priorAnalysisCount}`,
    `min=${snapshot.minObservationsPerArm}${snapshot.minObservationsPerArmDefaulted ? '*' : ''}`,
    `lvl=${snapshot.uncertaintyLevel}${snapshot.uncertaintyLevelDefaulted ? '*' : ''}`,
    `t=${canonicalNumber(snapshot.practicalThreshold.value)}/${snapshot.practicalThreshold.source}`,
    `c=${confounderPart}`,
    `lim=${limitationPart}`,
  ].join('|');
}

/**
 * Computes the deterministic ALLOCATION input-snapshot digest (the
 * reproducibility anchor of every allocation decision): the experiment
 * anchor, the optional analysis linkage, the declared arms (sorted by
 * armKey with their capacity/sample/mean/variance), the exploration
 * floor + source, and the allocator strategy version. Same snapshot →
 * same digest → same decision.
 */
export function computeAllocationSnapshotDigest(
  snapshot: ExperimentAllocationInputSnapshot,
): string {
  const armsPart = `${snapshot.arms.length}:${stableListHash(
    [...snapshot.arms]
      .sort((a, b) => (a.armKey < b.armKey ? -1 : a.armKey > b.armKey ? 1 : 0))
      .map(
        (arm) =>
          `${arm.armKey}|${arm.kind}|${arm.capacity}|${arm.sampleSize}|${canonicalNumber(arm.mean)}|${canonicalNumber(arm.variance)}`,
      ),
  )}`;
  return [
    `v=${EXPERIMENT_ANALYSIS_VOCABULARY_VERSION}`,
    `s=${snapshot.strategyVersion}`,
    `e=${snapshot.experiment.experimentId}/${snapshot.experiment.status}`,
    `a=${snapshot.analysisId ?? 'none'}`,
    `arms=${armsPart}`,
    `f=${canonicalNumber(snapshot.explorationFloor)}/${snapshot.explorationFloorSource}`,
    `lvl=${canonicalNumber(snapshot.uncertaintyLevel)}`,
  ].join('|');
}
