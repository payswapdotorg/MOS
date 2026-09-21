/**
 * The pure input/provenance guards of /experiment-analysis (MKT-067) —
 * the authority-boundary validation (the metrics/experiments guard
 * discipline): every module input is validated BEFORE any ownership
 * resolution or write, and an invalid input fails closed with the
 * complete problem list (InvalidRequestError 422). Computed-outcome
 * authority fields (outcome, effect estimates, uncertainty, sequential
 * state, shares, digests, rationale) have NO input surface at all —
 * they are never caller-suppliable, structurally.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY,
  EXPERIMENT_ANALYSIS_UNCERTAINTY_LEVELS,
  isKnownExperimentAllocationArmKind,
  isKnownUncertaintyLevel,
  type AllocationRecommendationCreateInput,
  type ExperimentAnalysisCreateInput,
  type ExperimentAnalysisProvenance,
} from '../public.ts';

/** The arm-key grammar: ^[a-z][a-z0-9_-]{0,63}$ (the platform neutral-key convention). */
const ARM_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The declared-string bounds (confounders/limitations/evidence refs). */
const MAX_DECLARED_ENTRIES = 50;
const MAX_DECLARED_ENTRY_LENGTH = 500;
const MAX_EVIDENCE_REFS = 50;
const MAX_ARMS = 16;

function isRealTimestamp(value: string): boolean {
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Pure create guard for one analysis (the full frozen input shape). The
 * declared-dimension reservation is enforced here: the 'arm' dimension
 * key belongs to the analysis split — an experiment whose declared
 * primary-metric dimensions contain it cannot be analyzed by the
 * two-arm method (fail closed with the explicit reason).
 */
export function assertValidExperimentAnalysisCreate(
  input: ExperimentAnalysisCreateInput,
  declaredDimensions: Readonly<Record<string, string | number | boolean>>,
): void {
  const problems: string[] = [];

  if (typeof input.clientId !== 'string' || input.clientId.trim() === '') {
    problems.push('clientId: a non-empty Client identifier is required');
  }
  if (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '')) {
    problems.push('workspaceId: must be a non-empty identifier when present');
  }
  if (typeof input.experimentId !== 'string' || input.experimentId.trim() === '') {
    problems.push('experimentId: a non-empty Experiment identifier is required');
  }

  if (!isRealTimestamp(input.windowStart)) {
    problems.push('windowStart: must be a real ISO 8601 timestamp (inclusive window start)');
  }
  if (!isRealTimestamp(input.windowEnd)) {
    problems.push('windowEnd: must be a real ISO 8601 timestamp (exclusive window end)');
  }
  if (isRealTimestamp(input.windowStart) && isRealTimestamp(input.windowEnd)) {
    if (Date.parse(input.windowEnd) <= Date.parse(input.windowStart)) {
      problems.push('windowEnd: must be strictly after windowStart (a real observation window)');
    }
  }

  if (input.uncertaintyLevel !== null && !isKnownUncertaintyLevel(input.uncertaintyLevel)) {
    problems.push(
      `uncertaintyLevel: must be one of the frozen levels ${EXPERIMENT_ANALYSIS_UNCERTAINTY_LEVELS.join(' | ')} (or null for the recorded default)`,
    );
  }

  if (input.minObservationsPerArm !== null) {
    if (
      !Number.isInteger(input.minObservationsPerArm) ||
      input.minObservationsPerArm < 1 ||
      input.minObservationsPerArm > 10000
    ) {
      problems.push(
        'minObservationsPerArm: must be an integer between 1 and 10000 when present (null → the recorded default)',
      );
    }
  }

  if (
    input.practicalThreshold === null ||
    typeof input.practicalThreshold !== 'object' ||
    !isFiniteNumber(input.practicalThreshold.value) ||
    input.practicalThreshold.value < 0
  ) {
    problems.push('practicalThreshold: a non-negative finite threshold value is required');
  } else if (input.practicalThreshold.source !== 'declared_input' && input.practicalThreshold.source !== 'module_default_v1') {
    problems.push("practicalThreshold.source: must be 'declared_input' or 'module_default_v1'");
  } else if (
    input.practicalThreshold.description !== null &&
    (typeof input.practicalThreshold.description !== 'string' ||
      input.practicalThreshold.description.length < 1 ||
      input.practicalThreshold.description.length > 500)
  ) {
    problems.push('practicalThreshold.description: must be between 1 and 500 characters when present');
  }

  for (const [field, entries] of [
    ['declaredConfounders', input.declaredConfounders],
    ['declaredLimitations', input.declaredLimitations],
  ] as const) {
    if (!Array.isArray(entries)) {
      problems.push(`${field}: must be an array of declared strings`);
    } else {
      if (entries.length > MAX_DECLARED_ENTRIES) {
        problems.push(`${field}: at most ${MAX_DECLARED_ENTRIES} declared entries`);
      }
      for (const entry of entries) {
        if (typeof entry !== 'string' || entry.trim() === '' || entry.length > MAX_DECLARED_ENTRY_LENGTH) {
          problems.push(
            `${field}: every entry must be a non-empty string of at most ${MAX_DECLARED_ENTRY_LENGTH} characters`,
          );
          break;
        }
      }
    }
  }

  if (!Array.isArray(input.evidenceRefs)) {
    problems.push('evidenceRefs: must be an array of /evidence record identifiers');
  } else if (input.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    problems.push(`evidenceRefs: at most ${MAX_EVIDENCE_REFS} evidence citations per analysis`);
  } else {
    for (const ref of input.evidenceRefs) {
      if (typeof ref !== 'string' || ref.trim() === '') {
        problems.push('evidenceRefs: every entry must be a non-empty /evidence record identifier');
        break;
      }
    }
  }

  // The reserved split dimension: an experiment whose declared
  // primary-metric dimensions contain 'arm' cannot be analyzed by the
  // two-arm method (the split would collide with the declared identity).
  if (Object.prototype.hasOwnProperty.call(declaredDimensions, EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY)) {
    problems.push(
      `declaredDimensions: the '${EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY}' dimension key is reserved for the analysis arm split — an experiment declaring it in its primary-metric identity cannot be analyzed by the two-sample means method`,
    );
  }

  if (problems.length > 0) {
    throw new InvalidRequestError('experiment analysis rejected by the create guard', problems);
  }
}

/**
 * Pure create guard for one allocation recommendation (the full frozen
 * input shape): closed arm-kind vocabulary, grammar-fenced unique arm
 * keys, non-negative integer capacity/sample, finite mean and
 * non-negative variance, and the bounded exploration floor.
 */
export function assertValidAllocationRecommendationCreate(
  input: AllocationRecommendationCreateInput,
): void {
  const problems: string[] = [];

  if (typeof input.clientId !== 'string' || input.clientId.trim() === '') {
    problems.push('clientId: a non-empty Client identifier is required');
  }
  if (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || input.workspaceId.trim() === '')) {
    problems.push('workspaceId: must be a non-empty identifier when present');
  }
  if (typeof input.experimentId !== 'string' || input.experimentId.trim() === '') {
    problems.push('experimentId: a non-empty Experiment identifier is required');
  }
  if (input.analysisId !== null && (typeof input.analysisId !== 'string' || input.analysisId.trim() === '')) {
    problems.push('analysisId: must be a non-empty identifier when present');
  }

  if (input.explorationFloor !== null) {
    if (!isFiniteNumber(input.explorationFloor) || input.explorationFloor <= 0 || input.explorationFloor > 0.5) {
      problems.push(
        'explorationFloor: must be a finite number in (0, 0.5] when present (null → the recorded module default)',
      );
    }
  }

  if (!Array.isArray(input.arms) || input.arms.length === 0) {
    problems.push('arms: at least one declared arm is required (an allocation over zero arms is meaningless)');
  } else {
    if (input.arms.length > MAX_ARMS) {
      problems.push(`arms: at most ${MAX_ARMS} declared arms per recommendation`);
    }
    const seenKeys = new Set<string>();
    for (const arm of input.arms) {
      if (arm === null || typeof arm !== 'object') {
        problems.push('arms: every entry must be an arm object');
        break;
      }
      if (typeof arm.armKey !== 'string' || !ARM_KEY_PATTERN.test(arm.armKey)) {
        problems.push(`arms.armKey '${String(arm.armKey)}': must match ^[a-z][a-z0-9_-]{0,63}$`);
      } else if (seenKeys.has(arm.armKey)) {
        problems.push(`arms.armKey '${arm.armKey}': declared more than once (arm keys are unique per recommendation)`);
      } else {
        seenKeys.add(arm.armKey);
      }
      if (!isKnownExperimentAllocationArmKind(arm.kind)) {
        problems.push(
          `arms.kind '${String(arm.kind)}': must be one of the frozen arm kinds (treatment | comparison | strategy_variant | human_treatment)`,
        );
      }
      if (!Number.isInteger(arm.capacity) || arm.capacity < 0) {
        problems.push(`arms.capacity '${arm.armKey}': must be an integer ≥ 0 (zero capacity is a valid state)`);
      }
      if (!Number.isInteger(arm.sampleSize) || arm.sampleSize < 0) {
        problems.push(`arms.sampleSize '${arm.armKey}': must be an integer ≥ 0`);
      }
      if (!isFiniteNumber(arm.mean)) {
        problems.push(`arms.mean '${arm.armKey}': must be a finite number`);
      }
      if (!isFiniteNumber(arm.variance) || arm.variance < 0) {
        problems.push(`arms.variance '${arm.armKey}': must be a finite number ≥ 0`);
      }
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError(
      'experiment allocation recommendation rejected by the create guard',
      problems,
    );
  }
}

/**
 * Provenance is server-derived and must be COMPLETE before any insert:
 * an incomplete provenance fails closed (the metrics/experiments guard,
 * verbatim discipline).
 */
export function assertValidExperimentAnalysisProvenance(
  provenance: ExperimentAnalysisProvenance,
): void {
  const problems: string[] = [];
  if (provenance.actor.trim() === '') {
    problems.push('provenance.actor: a non-empty server-derived principal label is required');
  }
  if (provenance.recordedVia.trim() === '' || provenance.recordedVia.length > 100) {
    problems.push('provenance.recordedVia: a non-empty server-derived system label is required');
  }
  if (provenance.correlationId.trim() === '') {
    problems.push('provenance.correlationId: analyses are correlation-linked');
  }
  if (provenance.causationId !== null && provenance.causationId.trim() === '') {
    problems.push('provenance.causationId: must be a non-empty identifier when present');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      'experiment analysis rejected: provenance is server-derived and must be complete',
      problems,
    );
  }
}
