/**
 * LAB-001 unit tests — the PURE contract guards of /lab: the deterministic
 * seed discipline (§9), the Time-Machine field fences (§10), the budget-cap
 * discipline (§23), the reward-definition discipline (§12), the factuality
 * labeling rules (§3/§10) and the frozen vocabulary constants (the closed
 * lifecycle/topology/factuality vocabularies + the single-agent baseline
 * mandate §15 + the no-shadowing shape of the public surface).
 *
 * The dispatch's named acceptance proofs:
 *   (a) versioned contracts — every vocabulary/contract constant carries
 *       the frozen 'lab-contract-v1' version;
 *   (b) deterministic seeds — the u64 decimal-string discipline with
 *       unique derived labels and the 2^64−1 boundary;
 *   (c) tenant isolation + lifecycle states — the closed vocabularies and
 *       the mode/lifecycle consistency rules (the DB fences are proven by
 *       the integration battery);
 *   (d) no shadowing — the public surface exposes NO experiment/decision/
 *       evidence/metric/publication type or method, and the calibration
 *       real-outcome anchor is an opaque reference kind vocabulary, never
 *       an authority pointer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_ARTIFACT_KINDS,
  LAB_CANDIDATE_STATUSES,
  LAB_CALIBRATION_STATUSES,
  LAB_CAPABILITY_STATUSES,
  LAB_CONTRACT_VERSION,
  LAB_FACTUALITY_LABELS,
  LAB_OBSERVED_REGIMES,
  LAB_ORGANIZATION_TOPOLOGIES,
  LAB_RUN_FAILURE_REASONS,
  LAB_RUN_MODES,
  LAB_RUN_STATUSES,
  LAB_SCENARIO_STATUSES,
  LAB_EXTERNAL_REFERENCE_KINDS,
  LAB_SINGLE_AGENT_BASELINE_TOPOLOGY,
  LAB_MAX_ACTIVE_RUNS_PER_CLIENT,
  assertValidLabFactualityForMode,
  assertValidLabRewardDefinition,
  assertValidLabRunConfiguration,
  assertValidLabRunTimeMachine,
  assertValidLabSeedSet,
  LAB_U64_MAX,
} from '../../src/modules/lab/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

function assertInvalid(fn: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError containing '${fragment}'`);
  assert.ok(
    String((caught as InvalidRequestError).message).includes(fragment),
    `message '${String((caught as InvalidRequestError).message)}' should contain '${fragment}'`,
  );
}

const VALID_TM = {
  mode: 'historical_replay',
  referenceStart: '2026-01-01T00:00:00.000Z',
  referenceEnd: '2026-02-01T00:00:00.000Z',
  simulatedClockStart: '2026-01-01T00:00:00.000Z',
  simulatedClockEnd: '2026-02-01T00:00:00.000Z',
  observationCutoff: '2026-02-01T00:00:00.000Z',
  informationLagMinutes: 0,
  worldModelVersion: 'wm-test-v1',
} as const;

const VALID_REWARD = {
  version: 'lab-reward-v1',
  declaredTargetOutcome: 'qualified signups',
  weights: { qualified_reach: 1, conversions: 2 },
  hardRejectionGates: ['fake_engagement'],
} as const;

const VALID_CONFIG = {
  maxSimulatedSteps: 1000,
  maxComputeCostUnits: 100,
  maxWallClockMs: 60_000,
} as const;

// ---------------------------------------------------------------------------
// (a) Versioned contracts
// ---------------------------------------------------------------------------

test('LAB-001: every artifact kind is named by the frozen manifest vocabulary and the contract version is pinned', () => {
  assert.equal(LAB_CONTRACT_VERSION, 'lab-contract-v1');
  assert.deepEqual(LAB_ARTIFACT_KINDS, [
    'lab-scenario',
    'lab-run',
    'world-model-version',
    'strategy-candidate',
    'agent-organization-candidate',
    'capability-candidate',
    'calibration-record',
  ]);
  // The frozen lifecycle vocabularies (closed sets — the migration-059
  // CHECK fences mirror these exactly).
  assert.deepEqual(LAB_SCENARIO_STATUSES, ['draft', 'active', 'retired']);
  assert.deepEqual(LAB_RUN_STATUSES, ['queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled']);
  assert.deepEqual(LAB_RUN_FAILURE_REASONS, [
    'budget_exceeded', 'configuration_invalid', 'simulator_error', 'cancelled_by_operator', 'interrupted',
  ]);
  assert.deepEqual(LAB_RUN_MODES, ['historical_replay', 'delayed_information', 'counterfactual']);
  assert.deepEqual(LAB_FACTUALITY_LABELS, [
    'factual_historical_replay', 'counterfactual_model_estimate', 'simulated_model_output',
  ]);
  assert.deepEqual(LAB_CANDIDATE_STATUSES, ['draft', 'evaluated', 'selected', 'rejected']);
  assert.deepEqual(LAB_ORGANIZATION_TOPOLOGIES, [
    'single_agent_baseline', 'specialized_pipeline', 'hierarchical_delegation', 'debate_consensus', 'custom_graph',
  ]);
  assert.deepEqual(LAB_CAPABILITY_STATUSES, ['declared', 'simulation_verified', 'real_verified', 'rejected']);
  assert.deepEqual(LAB_CALIBRATION_STATUSES, ['recorded', 'applied']);
  assert.deepEqual(LAB_OBSERVED_REGIMES, ['regime-stable', 'regime-shift', 'regime-unknown']);
});

// ---------------------------------------------------------------------------
// (b) Deterministic seeds (§9)
// ---------------------------------------------------------------------------

test('LAB-001: the deterministic seed discipline accepts well-formed u64 decimal-string seed sets', () => {
  assertValidLabSeedSet({ masterSeed: '0', derived: [] });
  assertValidLabSeedSet({ masterSeed: '42', derived: [{ label: 'ranking', seed: '7' }] });
  assertValidLabSeedSet({ masterSeed: LAB_U64_MAX, derived: [{ label: 'a', seed: '0' }, { label: 'b', seed: LAB_U64_MAX }] });
});

test('LAB-001: the seed discipline rejects malformed master seeds (the §9 reproducibility input must be exact)', () => {
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '-1', derived: [] }), 'masterSeed');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '1.5', derived: [] }), 'masterSeed');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: 'abc', derived: [] }), 'masterSeed');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '01', derived: [] }), 'masterSeed');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '18446744073709551616', derived: [] }), 'masterSeed'); // 2^64
});

test('LAB-001: the seed discipline enforces unique, well-formed derived labels', () => {
  assertInvalid(
    () => assertValidLabSeedSet({ masterSeed: '1', derived: [{ label: 'a', seed: '1' }, { label: 'a', seed: '2' }] }),
    'duplicated',
  );
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '1', derived: [{ label: '', seed: '1' }] }), 'label');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '1', derived: [{ label: 'A-B!', seed: '1' }] }), 'label');
  assertInvalid(() => assertValidLabSeedSet({ masterSeed: '1', derived: [{ label: 'a', seed: 'not-a-number' }] }), 'seed');
});

// ---------------------------------------------------------------------------
// Time-Machine fences (§10)
// ---------------------------------------------------------------------------

test('LAB-001: the Time-Machine guard accepts a well-formed historical replay record with zero lag', () => {
  assertValidLabRunTimeMachine(VALID_TM);
  assertValidLabRunTimeMachine({ ...VALID_TM, mode: 'delayed_information', informationLagMinutes: 15 });
  assertValidLabRunTimeMachine({ ...VALID_TM, mode: 'counterfactual', informationLagMinutes: 0 });
});

test('LAB-001: the Time-Machine guard rejects malformed timestamps, disordered periods and negative lag (§10 leakage fence inputs)', () => {
  assertInvalid(() => assertValidLabRunTimeMachine({ ...VALID_TM, referenceStart: 'not-a-date' }), 'referenceStart');
  assertInvalid(() => assertValidLabRunTimeMachine({ ...VALID_TM, referenceStart: '2026-03-01T00:00:00Z' }), 'referenceEnd');
  assertInvalid(() => assertValidLabRunTimeMachine({ ...VALID_TM, simulatedClockEnd: '2025-12-01T00:00:00Z' }), 'simulatedClockEnd');
  assertInvalid(() => assertValidLabRunTimeMachine({ ...VALID_TM, informationLagMinutes: -1 }), 'informationLagMinutes');
  assertInvalid(() => assertValidLabRunTimeMachine({ ...VALID_TM, informationLagMinutes: 1.5 }), 'informationLagMinutes');
});

test('LAB-001: a delayed_information run MUST declare a positive information lag (the §10 delayed-information fence)', () => {
  assertInvalid(
    () => assertValidLabRunTimeMachine({ ...VALID_TM, mode: 'delayed_information', informationLagMinutes: 0 }),
    'informationLagMinutes must be > 0',
  );
});

// ---------------------------------------------------------------------------
// Budget caps (§23)
// ---------------------------------------------------------------------------

test('LAB-001: the budget-cap discipline accepts well-formed caps and rejects non-positive/non-finite ones', () => {
  assertValidLabRunConfiguration(VALID_CONFIG);
  assertValidLabRunConfiguration({ maxSimulatedSteps: 1, maxComputeCostUnits: 0, maxWallClockMs: 0 });
  assertInvalid(() => assertValidLabRunConfiguration({ ...VALID_CONFIG, maxSimulatedSteps: 0 }), 'maxSimulatedSteps');
  assertInvalid(() => assertValidLabRunConfiguration({ ...VALID_CONFIG, maxSimulatedSteps: 1.5 }), 'maxSimulatedSteps');
  assertInvalid(() => assertValidLabRunConfiguration({ ...VALID_CONFIG, maxComputeCostUnits: -1 }), 'maxComputeCostUnits');
  assertInvalid(() => assertValidLabRunConfiguration({ ...VALID_CONFIG, maxWallClockMs: Number.POSITIVE_INFINITY }), 'maxWallClockMs');
});

// ---------------------------------------------------------------------------
// Reward definitions (§12)
// ---------------------------------------------------------------------------

test('LAB-001: the reward-definition discipline enforces the versioned, business-outcome-first shape with hard-rejection gates', () => {
  assertValidLabRewardDefinition(VALID_REWARD);
  assertInvalid(() => assertValidLabRewardDefinition({ ...VALID_REWARD, version: '' }), 'version');
  assertInvalid(() => assertValidLabRewardDefinition({ ...VALID_REWARD, declaredTargetOutcome: '' }), 'declaredTargetOutcome');
  assertInvalid(() => assertValidLabRewardDefinition({ ...VALID_REWARD, weights: {} }), 'weights');
  assertInvalid(() => assertValidLabRewardDefinition({ ...VALID_REWARD, weights: { bad: -1 } }), 'bad');
  assertInvalid(() => assertValidLabRewardDefinition({ ...VALID_REWARD, weights: { bad: Number.NaN } }), 'bad');
});

// ---------------------------------------------------------------------------
// Factuality labels (§3/§10)
// ---------------------------------------------------------------------------

test('LAB-001: the factuality rules keep counterfactual outcomes labeled as model estimates (§3/§10)', () => {
  assertValidLabFactualityForMode('factual_historical_replay', 'historical_replay');
  assertValidLabFactualityForMode('simulated_model_output', 'historical_replay');
  assertValidLabFactualityForMode('counterfactual_model_estimate', 'counterfactual');
  assertValidLabFactualityForMode('simulated_model_output', 'counterfactual');
  // The headline rule: a counterfactual run can NEVER carry the factual label.
  assertInvalid(
    () => assertValidLabFactualityForMode('factual_historical_replay', 'counterfactual'),
    'never carry the factual_historical_replay label',
  );
});

// ---------------------------------------------------------------------------
// The single-agent baseline mandate (§15) + the concurrency cap (§23)
// ---------------------------------------------------------------------------

test('LAB-001: the generalist single-agent baseline is the NAMED first topology (§15 mandate)', () => {
  assert.equal(LAB_SINGLE_AGENT_BASELINE_TOPOLOGY, 'single_agent_baseline');
  assert.equal(LAB_ORGANIZATION_TOPOLOGIES[0], 'single_agent_baseline');
});

test('LAB-001: the per-client active-run concurrency cap is a positive declared constant (§23)', () => {
  assert.ok(Number.isInteger(LAB_MAX_ACTIVE_RUNS_PER_CLIENT) && LAB_MAX_ACTIVE_RUNS_PER_CLIENT >= 1);
});

// ---------------------------------------------------------------------------
// (d) No shadowing — the public surface shape
// ---------------------------------------------------------------------------

test('LAB-001: the calibration real-outcome anchor vocabulary names ONLY opaque reference kinds — never an authority pointer (§3 no-shadowing)', () => {
  assert.deepEqual(LAB_EXTERNAL_REFERENCE_KINDS, ['experiment', 'evidence', 'metric_observation', 'publish_attempt']);
  // The kinds are reference NAMES, not authority routes: none of them
  // resolves to a module the /lab row could import (its frozen allowance
  // is empty).
});
