/**
 * /lab contract guards (LAB-001) — the PURE deterministic validation core.
 *
 * These guards enforce the frozen contract semantics (spec/
 * architecture-v1.7-marketing-lab.md §9/§10/§12/§13/§21/§23;
 * spec/effective-backlog-v1.7.md LAB-001 acceptance: "versioned
 * contracts, tenant isolation, deterministic seeds, lifecycle states, no
 * shadowing of v1.6 authorities"):
 *
 *   - the deterministic seed discipline (§9: u64 decimal-string master +
 *     derived seeds, unique labels — the run record is the COMPLETE
 *     reproducibility input);
 *   - the Time-Machine field fences (§10: ordered periods, ordered
 *     simulated clock, the observation cutoff, the ≥ 0 information lag —
 *     the future-information leakage fence);
 *   - the budget-cap discipline (§23: strictly positive step cap, ≥ 0
 *     cost/wall-clock caps, finite numbers);
 *   - the reward-definition discipline (§12: versioned, declared target,
 *     non-negative finite weights, the hard-rejection gates present);
 *   - the factuality labeling rules (§3/§10: the mode→label mapping —
 *     historical replay is factual ONLY as evidence-backed
 *     reconstruction; counterfactual outcomes are model estimates;
 *     delayed-information replay carries the replay label).
 *
 * Pure functions: no clock, no randomness, no network — the unit battery
 * pins every rule.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import {
  LAB_FACTUALITY_LABELS,
  LAB_RUN_MODES,
  type LabFactualityLabel,
  type LabRewardDefinition,
  type LabRunConfiguration,
  type LabRunMode,
  type LabRunTimeMachine,
  type LabSeedSet,
} from '../public.ts';

/** 2^64 − 1 as a decimal string — the u64 seed ceiling. */
export const LAB_U64_MAX = '18446744073709551615';

const U64_DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function isUtcIso(value: string): boolean {
  if (!ISO_UTC_PATTERN.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && !Number.isNaN(new Date(value).getTime());
}

function isU64Decimal(value: string): boolean {
  if (!U64_DECIMAL_PATTERN.test(value)) return false;
  // Reject leading zeros beyond the single '0' and values above 2^64−1.
  if (value.length > 20) return false;
  if (value.length === 20 && value > LAB_U64_MAX) return false;
  return true;
}

/**
 * The deterministic seed discipline (§9/§10/§23): a master u64 seed
 * (decimal string) plus labeled derived seeds (each a u64 decimal
 * string, labels unique and non-empty). The recorded set is the
 * COMPLETE reproducibility input — nothing about seeding may be
 * implicit.
 */
export function assertValidLabSeedSet(seeds: LabSeedSet): void {
  if (seeds === null || typeof seeds !== 'object') {
    throw new InvalidRequestError('seeds must be an object');
  }
  if (!isU64Decimal(String(seeds.masterSeed))) {
    throw new InvalidRequestError('seeds.masterSeed must be an unsigned 64-bit integer decimal string');
  }
  if (!Array.isArray(seeds.derived)) {
    throw new InvalidRequestError('seeds.derived must be an array');
  }
  if (seeds.derived.length > 64) {
    throw new InvalidRequestError('seeds.derived must hold at most 64 entries');
  }
  const seen = new Set<string>();
  for (const entry of seeds.derived) {
    if (entry === null || typeof entry !== 'object') {
      throw new InvalidRequestError('each seeds.derived entry must be an object');
    }
    const label = String(entry.label ?? '');
    if (label.length < 1 || label.length > 64 || !/^[a-z0-9_]+$/.test(label)) {
      throw new InvalidRequestError('each seeds.derived label must be 1-64 chars of [a-z0-9_]');
    }
    if (seen.has(label)) {
      throw new InvalidRequestError(`seeds.derived label '${label}' is duplicated`);
    }
    seen.add(label);
    if (!isU64Decimal(String(entry.seed))) {
      throw new InvalidRequestError(`seeds.derived['${label}'].seed must be an unsigned 64-bit integer decimal string`);
    }
  }
}

/**
 * The Time-Machine field fences (§10): the three ISO-UTC timestamps are
 * well-formed and ordered (referenceStart ≤ referenceEnd,
 * simulatedClockStart ≤ simulatedClockEnd), the observation cutoff is a
 * well-formed ISO-UTC instant, and the information lag is a finite
 * integer ≥ 0. The leakage fence itself (no evidence after the cutoff)
 * is enforced by the simulator modules (LAB-005/007); this guard keeps
 * the RUN RECORD honest so the fence is computable downstream.
 */
export function assertValidLabRunTimeMachine(tm: LabRunTimeMachine): void {
  if (tm === null || typeof tm !== 'object') {
    throw new InvalidRequestError('timeMachine must be an object');
  }
  if (!LAB_RUN_MODES.includes(tm.mode)) {
    throw new InvalidRequestError(`timeMachine.mode must be one of ${LAB_RUN_MODES.join(', ')}`);
  }
  for (const field of [
    'referenceStart',
    'referenceEnd',
    'simulatedClockStart',
    'simulatedClockEnd',
    'observationCutoff',
  ] as const) {
    if (!isUtcIso(String(tm[field]))) {
      throw new InvalidRequestError(`timeMachine.${field} must be an ISO 8601 UTC timestamp`);
    }
  }
  if (Date.parse(tm.referenceEnd) < Date.parse(tm.referenceStart)) {
    throw new InvalidRequestError('timeMachine.referenceEnd must be ≥ referenceStart');
  }
  if (Date.parse(tm.simulatedClockEnd) < Date.parse(tm.simulatedClockStart)) {
    throw new InvalidRequestError('timeMachine.simulatedClockEnd must be ≥ simulatedClockStart');
  }
  const lag = tm.informationLagMinutes;
  if (!Number.isInteger(lag) || lag < 0 || lag > 60 * 24 * 366) {
    throw new InvalidRequestError('timeMachine.informationLagMinutes must be an integer in [0, 527040]');
  }
  if (tm.mode === 'delayed_information' && lag === 0) {
    throw new InvalidRequestError('timeMachine.informationLagMinutes must be > 0 for delayed_information runs');
  }
  if (typeof tm.worldModelVersion !== 'string' || tm.worldModelVersion.length < 1 || tm.worldModelVersion.length > 128) {
    throw new InvalidRequestError('timeMachine.worldModelVersion must be a 1-128 char string');
  }
}

/**
 * The budget-cap discipline (§23): strictly positive integer step cap,
 * ≥ 0 finite cost cap, ≥ 0 finite wall-clock cap.
 */
export function assertValidLabRunConfiguration(configuration: LabRunConfiguration): void {
  if (configuration === null || typeof configuration !== 'object') {
    throw new InvalidRequestError('runConfiguration must be an object');
  }
  if (!Number.isInteger(configuration.maxSimulatedSteps) || configuration.maxSimulatedSteps < 1 || configuration.maxSimulatedSteps > 1_000_000_000) {
    throw new InvalidRequestError('runConfiguration.maxSimulatedSteps must be an integer in [1, 1e9]');
  }
  if (!Number.isFinite(configuration.maxComputeCostUnits) || configuration.maxComputeCostUnits < 0 || configuration.maxComputeCostUnits > 1e12) {
    throw new InvalidRequestError('runConfiguration.maxComputeCostUnits must be a finite number in [0, 1e12]');
  }
  if (!Number.isFinite(configuration.maxWallClockMs) || configuration.maxWallClockMs < 0 || configuration.maxWallClockMs > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRequestError('runConfiguration.maxWallClockMs must be a finite number in [0, MAX_SAFE_INTEGER]');
  }
}

/**
 * The reward-definition discipline (§12): versioned, a non-empty declared
 * target outcome, a non-empty weight vector of finite non-negative
 * weights, and the §21 hard-rejection gates declared (an empty gate list
 * is legal ONLY when explicitly declared via the
 * 'no_hard_rejection_gates_declared' sentinel — the anti-gaming gates
 * are mandatory, and the sentinel makes their absence a visible,
 * auditable declaration rather than a silent omission).
 */
export function assertValidLabRewardDefinition(reward: LabRewardDefinition): void {
  if (reward === null || typeof reward !== 'object') {
    throw new InvalidRequestError('reward must be an object');
  }
  if (typeof reward.version !== 'string' || reward.version.length < 1 || reward.version.length > 64) {
    throw new InvalidRequestError('reward.version must be a 1-64 char string');
  }
  if (typeof reward.declaredTargetOutcome !== 'string' || reward.declaredTargetOutcome.length < 1 || reward.declaredTargetOutcome.length > 512) {
    throw new InvalidRequestError('reward.declaredTargetOutcome must be a 1-512 char string');
  }
  const weightEntries = Object.entries(reward.weights ?? {});
  if (weightEntries.length < 1 || weightEntries.length > 64) {
    throw new InvalidRequestError('reward.weights must hold 1-64 entries');
  }
  for (const [component, weight] of weightEntries) {
    if (component.length < 1 || component.length > 64) {
      throw new InvalidRequestError('reward.weights component names must be 1-64 chars');
    }
    if (!Number.isFinite(weight) || weight < 0 || weight > 1e9) {
      throw new InvalidRequestError(`reward.weights['${component}'] must be a finite number in [0, 1e9]`);
    }
  }
  if (!Array.isArray(reward.hardRejectionGates) || reward.hardRejectionGates.length > 64) {
    throw new InvalidRequestError('reward.hardRejectionGates must be an array of at most 64 entries');
  }
  for (const gate of reward.hardRejectionGates) {
    if (typeof gate !== 'string' || gate.length < 1 || gate.length > 128) {
      throw new InvalidRequestError('reward.hardRejectionGates entries must be 1-128 char strings');
    }
  }
}

/**
 * The factuality labeling rules (§3/§10): the closed label vocabulary and
 * the mode-consistency mapping. A historical_replay or delayed_information
 * run may carry 'factual_historical_replay' or 'simulated_model_output'
 * (a replayed trajectory evaluated by a model is model output about a
 * factual trajectory); a counterfactual run may NEVER carry
 * 'factual_historical_replay' — its outcomes are model estimates by
 * construction (§10: "counterfactual consequences are world-model
 * estimates and MUST be labeled accordingly").
 */
export function assertValidLabFactualityForMode(label: LabFactualityLabel, mode: LabRunMode): void {
  if (!LAB_FACTUALITY_LABELS.includes(label)) {
    throw new InvalidRequestError(`factuality must be one of ${LAB_FACTUALITY_LABELS.join(', ')}`);
  }
  if (mode === 'counterfactual' && label === 'factual_historical_replay') {
    throw new InvalidRequestError('a counterfactual run can never carry the factual_historical_replay label (§10: counterfactual outcomes are model estimates)');
  }
}

/** Derives the default factuality label for a run mode (the honest default; explicit labels are validated by assertValidLabFactualityForMode). */
export function defaultLabFactualityForMode(mode: LabRunMode): LabFactualityLabel {
  if (mode === 'counterfactual') return 'counterfactual_model_estimate';
  return 'simulated_model_output';
}
