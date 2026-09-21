/**
 * The deterministic adaptive allocator of /experiment-analysis (MKT-067
 * Part B — 'ea-alloc-v1'). PURE: zero I/O, zero randomness, stable
 * armKey ordering — the same input snapshot ALWAYS produces the same
 * allocation (reproducibility is a frozen, test-proven property).
 *
 * Bounded exploration/exploitation (the §12 rule: "Adaptive allocation
 * may increase exposure to promising strategy variants while retaining
 * explicit exploration"):
 *
 *   share(arm) = (1 − floor) · exploitWeight(arm) + floor / |eligible|
 *
 *   - exploitWeight: proportional to the arm's CONSERVATIVE effect signal
 *     max(0, mean − z·√(variance/n)) — an arm is "promising" when its
 *     one-sided lower bound is positive; arms with non-positive bounds
 *     exploit zero exposure (they stay alive through the exploration
 *     share). When NO eligible arm has a positive bound, exploitation is
 *     uniform (the honest cold-start).
 *   - floor: the recorded exploration floor (DATA with its source —
 *     never a hardcoded magic number), distributed EQUALLY over the
 *     eligible arms: every eligible arm keeps at least floor/|eligible|
 *     of exposure, so exploration is RETAINED no matter how promising a
 *     variant looks.
 *
 * Zero-capacity validity (the human-growth invariant): an arm with
 * capacity 0 — including the human-treatment arm — is EXCLUDED and
 * RECORDED with its reason; allocation continues over the remaining arms
 * unchanged in structure. When EVERY arm has zero capacity the honest
 * all-zero state is recorded (empty shares) — never an error, never a
 * fabricated allocation.
 */

import {
  UNCERTAINTY_LEVEL_Z,
  type ExperimentAllocationArmInput,
  type ExperimentAllocationComputed,
  type HumanTreatmentConsideration,
} from '../public.ts';

/** The frozen allocator strategy version (the determinism pin). */
export const ALLOCATOR_STRATEGY_VERSION = 'ea-alloc-v1';

/** The scoring level of the conservative lower bound (fixed — deterministic). */
const SCORING_LEVEL = 0.95 as const;

/** The arm grammar: ^[a-z][a-z0-9_-]{0,63}$ (validated at the boundary; the allocator trusts it). */

/** The allocator inputs (the observable world, server-derived). */
export interface AdaptiveAllocationInput {
  readonly arms: readonly ExperimentAllocationArmInput[];
  /** The recorded exploration floor (already resolved + source-recorded upstream). */
  readonly explorationFloor: number;
}

/**
 * The conservative effect signal of one arm: the one-sided lower bound of
 * the arm's mean at the fixed scoring level. An arm with no observations
 * (n = 0) scores its raw mean WITHOUT a variance penalty — the honest
 * cold-start prior (an unexplored arm is neither promising nor condemned;
 * its exposure arrives through the exploration share).
 */
function conservativeSignal(arm: ExperimentAllocationArmInput): number {
  if (arm.sampleSize <= 0) return arm.mean;
  const standardError = Math.sqrt(arm.variance / arm.sampleSize);
  return arm.mean - UNCERTAINTY_LEVEL_Z[SCORING_LEVEL] * standardError;
}

/**
 * Computes the bounded exploration/exploitation allocation (PURE,
 * deterministic, versioned). Zero-capacity arms — the human-treatment arm
 * included — are excluded and recorded; the human-arm consideration is
 * ALWAYS recorded (never an absence); every eligible arm retains at least
 * its equal share of the exploration floor.
 */
export function computeAdaptiveAllocation(
  input: AdaptiveAllocationInput,
): ExperimentAllocationComputed {
  // Deterministic ordering: arms are processed by armKey ASC (stable —
  // the caller's declaration order never influences the result).
  const arms = [...input.arms].sort((a, b) => (a.armKey < b.armKey ? -1 : a.armKey > b.armKey ? 1 : 0));
  const floor = input.explorationFloor;

  const zeroCapacityArms: Array<{
    armKey: string;
    kind: ExperimentAllocationComputed['zeroCapacityArms'][number]['kind'];
    reason: string;
  }> = [];
  const eligible: ExperimentAllocationArmInput[] = [];
  let humanPresent = false;
  let humanCapacity = 0;
  let humanExcluded = false;

  for (const arm of arms) {
    if (arm.capacity <= 0) {
      const isHuman = arm.kind === 'human_treatment';
      zeroCapacityArms.push({
        armKey: arm.armKey,
        kind: arm.kind,
        reason: isHuman
          ? `human-treatment arm '${arm.armKey}' has zero observable capacity — excluded from allocation; allocation continues over the remaining arms (the human-growth invariant: absence of human capacity never blocks, crashes or invalidates non-human allocation)`
          : `arm '${arm.armKey}' has zero observable capacity — excluded from allocation (a valid state, never an error; allocation continues over the remaining arms)`,
      });
      if (isHuman) {
        humanPresent = true;
        humanExcluded = true;
      }
      continue;
    }
    eligible.push(arm);
    if (arm.kind === 'human_treatment') {
      humanPresent = true;
      humanCapacity = arm.capacity;
    }
  }

  const humanTreatmentConsideration: HumanTreatmentConsideration = humanPresent
    ? {
        present: true,
        capacity: humanCapacity,
        excluded: humanExcluded,
        note: humanExcluded
          ? 'the human-treatment arm was considered and excluded for zero observable capacity — a valid optional-treatment state (architecture-lock-v1.6 rules 43/44); absence of human capacity never blocks, crashes or invalidates non-human allocation: the non-human allocation proceeds normally'
          : 'the human-treatment arm was considered and is eligible with observable capacity; it competes on its recorded signal like every other arm',
      }
    : {
        present: false,
        capacity: 0,
        excluded: true,
        note: 'no human-treatment arm was declared in this allocation input — the optional human arm is absent by declaration (a valid non-human state, never an error); allocation proceeds over the declared arms',
      };

  // The honest all-zero state: every arm (human and non-human alike) has
  // zero capacity. Recorded as an empty allocation — never an error,
  // never a fabricated uniform split.
  if (eligible.length === 0) {
    return {
      eligibleArms: [],
      zeroCapacityArms,
      shares: {},
      humanTreatmentConsideration,
      explorationShare: 0,
    };
  }

  // Exploitation weights: proportional to the positive part of the
  // conservative signal (deterministic; stable by armKey order).
  const signals = new Map<string, number>();
  let positiveSignalTotal = 0;
  for (const arm of eligible) {
    const signal = Math.max(0, conservativeSignal(arm));
    signals.set(arm.armKey, signal);
    positiveSignalTotal += signal;
  }

  const shares: Record<string, number> = {};
  const explorationSharePerArm = floor / eligible.length;
  const exploitationBudget = 1 - floor;
  if (positiveSignalTotal <= 0) {
    // No arm shows a positive conservative signal: exploitation is uniform
    // (the honest cold-start — exploration plus a uniform split).
    for (const arm of eligible) {
      shares[arm.armKey] = explorationSharePerArm + exploitationBudget / eligible.length;
    }
  } else {
    for (const arm of eligible) {
      const exploitWeight = (signals.get(arm.armKey) ?? 0) / positiveSignalTotal;
      shares[arm.armKey] = explorationSharePerArm + exploitationBudget * exploitWeight;
    }
  }

  return {
    eligibleArms: eligible.map((arm) => arm.armKey),
    zeroCapacityArms,
    shares,
    humanTreatmentConsideration,
    explorationShare: floor,
  };
}

/**
 * The deterministic recommendation rationale (explicit, honest, bounded —
 * the audit trail a human operator reads). Pure composition over the
 * computed allocation; the same allocation always renders the same
 * rationale.
 */
export function renderAllocationRationale(input: {
  readonly computed: ExperimentAllocationComputed;
  readonly explorationFloorSource: string;
  readonly strategyVersion: string;
}): string {
  const { computed } = input;
  const eligibleList = computed.eligibleArms.join(', ');
  const zeroList = computed.zeroCapacityArms.map((arm) => `${arm.armKey} (${arm.kind})`).join(', ');
  const shareList = Object.entries(computed.shares)
    .map(([armKey, share]) => `${armKey}:${(share * 100).toFixed(2)}%`)
    .join(' ');
  const head =
    computed.eligibleArms.length === 0
      ? `Strategy ${input.strategyVersion}: every declared arm has zero observable capacity — the honest all-zero state is recorded (no allocation fabricated; this is a valid non-human state, not an error).`
      : `Strategy ${input.strategyVersion} allocated exposure over the eligible arms [${eligibleList}] with a retained exploration floor of ${(computed.explorationShare * 100).toFixed(1)}% (${input.explorationFloorSource}) distributed equally; conservative-signal exploitation takes the remainder: ${shareList}.`;
  const tail =
    computed.zeroCapacityArms.length > 0
      ? ` Zero-capacity arms excluded and recorded: [${zeroList}]. ${computed.humanTreatmentConsideration.note}`
      : ` ${computed.humanTreatmentConsideration.note}`;
  return `${head}${tail}`.slice(0, 4000);
}
