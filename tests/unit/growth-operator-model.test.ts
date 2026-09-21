/**
 * MKT-054 unit tests — the Growth Operator pure surfaces: the frozen
 * controller state machine, the vocabulary/strategy versions, the
 * deterministic selection core (idempotent replanning), the evidence
 * snapshot digest, the plan-step idempotency key and the input guards.
 *
 * The ZERO-HUMAN battery lives here in its purest form: the
 * human-amplification arm is never eligible at the zero default, is never
 * selected even when funded-with-capacity (the MKT-054 controller cannot
 * delegate human work — the /jobs seam is the later optional
 * MKT-076..078 wave), and the selection ALWAYS continues with a non-human
 * treatment (never a fabricated human result, never an error).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GROWTH_OPERATOR_CONTROLLER_STATUSES,
  GROWTH_OPERATOR_DECISION_KINDS,
  GROWTH_OPERATOR_GATE_KINDS,
  GROWTH_OPERATOR_OBSERVED_OUTCOMES,
  GROWTH_OPERATOR_PLAN_STEP_STATES,
  GROWTH_OPERATOR_STRATEGY_VERSION,
  GROWTH_OPERATOR_TERMINAL_CAUSES,
  GROWTH_OPERATOR_TERMINAL_STATUSES,
  GROWTH_OPERATOR_TREATMENT_FAMILIES,
  GROWTH_OPERATOR_TRANSITIONS,
  GROWTH_OPERATOR_VOCABULARY_VERSION,
  assertValidGrowthOperatorProvenance,
  assertValidGrowthOperatorReason,
  computeEvidenceSnapshotDigest,
  computePlanStepIdempotencyKey,
  EXPLORATION_STEPS_PER_FAMILY,
  GROWTH_OPERATOR_DEFAULT_BUDGET,
  HUMAN_TREATMENT_FAMILY,
  NON_HUMAN_TREATMENT_FAMILIES,
  humanConsiderationOf,
  scoreCandidate,
  isLegalGrowthOperatorTransition,
  isTerminalGrowthOperatorStatus,
  selectNextTreatment,
} from '../../src/modules/growth-operator/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const ZERO_HUMAN_BUDGET = GROWTH_OPERATOR_DEFAULT_BUDGET;

const BASE_SELECTION_INPUT = {
  objectiveFamily: 'audience_growth',
  missionObjective: 'grow the channel to a million qualified views',
  budget: ZERO_HUMAN_BUDGET,
  familyDispatchCounts: {},
  familyLastOutcomes: {},
  dispatchedStepCount: 0,
} as const;

// ---------------------------------------------------------------------------
// 1. The frozen controller state machine (MKT-054, verbatim)
// ---------------------------------------------------------------------------

test('MKT-054: the controller state vocabulary is exactly the work-item machine, verbatim', () => {
  assert.deepEqual(GROWTH_OPERATOR_CONTROLLER_STATUSES, [
    'running',
    'paused',
    'blocked_pending_human_action',
    'achieved',
    'exhausted',
    'terminated_by_policy',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_TERMINAL_STATUSES, [
    'achieved',
    'exhausted',
    'terminated_by_policy',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_GATE_KINDS, ['rights', 'policy', 'capability']);
});

test('MKT-054: the frozen transition table — terminal states have NO outgoing transitions; paused/blocked resume only to running', () => {
  assert.deepEqual(GROWTH_OPERATOR_TRANSITIONS.running, [
    'paused',
    'blocked_pending_human_action',
    'achieved',
    'exhausted',
    'terminated_by_policy',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_TRANSITIONS.paused, ['running', 'terminated_by_policy']);
  assert.deepEqual(GROWTH_OPERATOR_TRANSITIONS.blocked_pending_human_action, [
    'running',
    'terminated_by_policy',
  ]);
  for (const terminal of GROWTH_OPERATOR_TERMINAL_STATUSES) {
    assert.deepEqual(GROWTH_OPERATOR_TRANSITIONS[terminal], []);
    assert.equal(isTerminalGrowthOperatorStatus(terminal), true);
    for (const target of GROWTH_OPERATOR_CONTROLLER_STATUSES) {
      assert.equal(
        isLegalGrowthOperatorTransition(terminal, target),
        false,
        `${terminal} → ${target} must be illegal (terminal states are frozen)`,
      );
    }
  }
  // The honest-state rule: 'achieved' is reachable ONLY from 'running'.
  assert.equal(isLegalGrowthOperatorTransition('running', 'achieved'), true);
  assert.equal(isLegalGrowthOperatorTransition('paused', 'achieved'), false);
  assert.equal(isLegalGrowthOperatorTransition('blocked_pending_human_action', 'achieved'), false);
  // Resume semantics exist for BOTH paused and blocked.
  assert.equal(isLegalGrowthOperatorTransition('paused', 'running'), true);
  assert.equal(isLegalGrowthOperatorTransition('blocked_pending_human_action', 'running'), true);
});

test('MKT-054: the frozen vocabularies ship versioned (go-vocab-v1 / go-strategy-v1)', () => {
  assert.equal(GROWTH_OPERATOR_VOCABULARY_VERSION, 'go-vocab-v1');
  assert.equal(GROWTH_OPERATOR_STRATEGY_VERSION, 'go-strategy-v1');
  assert.deepEqual(GROWTH_OPERATOR_PLAN_STEP_STATES, [
    'planned',
    'dispatched',
    'observed',
    'superseded',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_OBSERVED_OUTCOMES, [
    'delegated_work_succeeded',
    'delegated_work_failed',
    'delegated_work_cancelled',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_DECISION_KINDS, [
    'controller_initialized',
    'replan',
    'delegation',
    'observation',
    'gate_encountered',
    'state_transition',
    'termination',
  ]);
  assert.deepEqual(GROWTH_OPERATOR_TERMINAL_CAUSES, [
    'goal_achieved',
    'delegation_budget_exhausted',
    'mission_already_terminal',
    'no_delegable_treatment',
    'policy_denied_no_alternative',
    'blocked_gate_abandoned',
    'operator_requested_stop',
  ]);
});

test('MKT-054: the bounded treatment-family space is closed — four non-human + the declared optional human arm', () => {
  assert.deepEqual(GROWTH_OPERATOR_TREATMENT_FAMILIES, [
    'owned_channel_publish',
    'content_variant_test',
    'channel_reallocation',
    'measurement_enrichment',
    'human_amplification',
  ]);
  assert.deepEqual(NON_HUMAN_TREATMENT_FAMILIES, [
    'owned_channel_publish',
    'content_variant_test',
    'channel_reallocation',
    'measurement_enrichment',
  ]);
  assert.equal(HUMAN_TREATMENT_FAMILY, 'human_amplification');
});

// ---------------------------------------------------------------------------
// 2. Idempotent replanning — the deterministic selection core (PURE)
// ---------------------------------------------------------------------------

test('MKT-054: idempotent replanning — the same inputs ALWAYS select the same plan (determinism)', () => {
  const first = selectNextTreatment(BASE_SELECTION_INPUT);
  const second = selectNextTreatment(BASE_SELECTION_INPUT);
  const third = selectNextTreatment({ ...BASE_SELECTION_INPUT });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.ok(first.selectedFamily !== HUMAN_TREATMENT_FAMILY);
  assert.ok(first.rationale.length >= 1 && first.rationale.length <= 2000);
  assert.ok(first.candidates.length === 5, 'every family (incl. the human arm) is scored');
});

test('MKT-054: the selection is deterministic across ALL objective families (no randomness, no time factors)', () => {
  const families = [
    'audience_growth',
    'creator_growth',
    'product_marketing',
    'acquisition',
    'lead_generation',
    'revenue',
    'commerce_discovery',
    'hybrid',
  ];
  for (const family of families) {
    const a = selectNextTreatment({ ...BASE_SELECTION_INPUT, objectiveFamily: family });
    const b = selectNextTreatment({ ...BASE_SELECTION_INPUT, objectiveFamily: family });
    assert.deepEqual(b, a, `selection for ${family} must be deterministic`);
    assert.ok(
      NON_HUMAN_TREATMENT_FAMILIES.includes(a.selectedFamily),
      `the selected family for ${family} must be a NON-HUMAN delegable family`,
    );
  }
});

test('MKT-054: the evidence snapshot digest is deterministic and changes exactly when the observable world changes', () => {
  const base = {
    missionVersionSeq: 3,
    goalStatuses: ['active'],
    evidenceIds: ['e-1', 'e-2'],
    learningIds: ['l-1'],
    dispatchedStepCount: 1,
    familyDispatchCounts: { owned_channel_publish: 1 },
    familyLastOutcomes: { owned_channel_publish: 'delegated_work_succeeded' },
    budget: ZERO_HUMAN_BUDGET,
  };
  const first = computeEvidenceSnapshotDigest(base);
  assert.equal(computeEvidenceSnapshotDigest(base), first, 'the same world → the same digest');
  // The version is embedded (a strategy change is a new digest space).
  assert.ok(first.includes('v=go-strategy-v1'));
  // Every observable input change moves the digest.
  for (const changed of [
    { ...base, missionVersionSeq: 4 },
    { ...base, goalStatuses: ['achieved'] },
    { ...base, evidenceIds: ['e-1', 'e-2', 'e-3'] },
    { ...base, learningIds: ['l-1', 'l-2'] },
    { ...base, dispatchedStepCount: 2 },
    { ...base, familyDispatchCounts: { owned_channel_publish: 2 } },
    { ...base, familyLastOutcomes: { owned_channel_publish: 'delegated_work_failed' } },
    { ...base, budget: { ...ZERO_HUMAN_BUDGET, maxDelegatedSteps: 5 } },
  ]) {
    assert.notEqual(
      computeEvidenceSnapshotDigest(changed),
      first,
      'a changed observable input must change the digest',
    );
  }
});

test('MKT-054: the plan-step idempotency key is derived from the digest + sequence and bounded', () => {
  const digest = computeEvidenceSnapshotDigest({
    missionVersionSeq: 1,
    goalStatuses: ['active'],
    evidenceIds: [],
    learningIds: [],
    dispatchedStepCount: 0,
    familyDispatchCounts: {},
    familyLastOutcomes: {},
    budget: ZERO_HUMAN_BUDGET,
  });
  const key = computePlanStepIdempotencyKey(digest, 7);
  assert.ok(key.startsWith('go-plan-'));
  assert.ok(key.endsWith('-s7'));
  assert.ok(key.length <= 200, 'the key must respect the DB fence');
  assert.equal(computePlanStepIdempotencyKey(digest, 7), key, 'deterministic');
  assert.notEqual(computePlanStepIdempotencyKey(digest, 8), key, 'the sequence differentiates');
  // A huge digest still yields a bounded key (the no-double-dispatch fence
  // stays satisfiable).
  const hugeDigest = 'x'.repeat(400);
  assert.ok(computePlanStepIdempotencyKey(hugeDigest, 1).length <= 200);
});

// ---------------------------------------------------------------------------
// 3. THE ZERO-HUMAN BATTERY (pure form — rules 43/44/45)
// ---------------------------------------------------------------------------

test('MKT-054 zero-human: the DEFAULT budget is the zero-human state (budget 0, capacity 0)', () => {
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.humanAmplificationBudget, 0);
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.humanAmplificationEligibleCapacity, 0);
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.maxInFlightSteps, 1);
  assert.equal(GROWTH_OPERATOR_DEFAULT_BUDGET.maxDelegatedSteps, null);
});

test('MKT-054 zero-human: budget 0 + no capacity → the arm is NOT eligible and the operator continues non-human (never an error)', () => {
  const consideration = humanConsiderationOf({ budget: ZERO_HUMAN_BUDGET });
  assert.equal(consideration.eligible, false);
  assert.equal(consideration.budget, 0);
  assert.equal(consideration.eligibleCapacity, 0);
  assert.match(consideration.reason, /zero-human state/);
  assert.match(consideration.reason, /not an error/);

  const selection = selectNextTreatment(BASE_SELECTION_INPUT);
  assert.equal(selection.consideredHuman.eligible, false);
  assert.ok(
    NON_HUMAN_TREATMENT_FAMILIES.includes(selection.selectedFamily),
    'a non-human treatment is ALWAYS selected in the zero-human state',
  );
  assert.equal(selection.reallocatedFromHuman, false);
  // The zero-human state is a RECORDED input, never an absence.
  assert.ok(selection.rationale.includes('human-amplification arm was considered and recorded'));
});

test('MKT-054 zero-human: funded but NO capacity → still not eligible, still continues non-human', () => {
  const budget = { ...ZERO_HUMAN_BUDGET, humanAmplificationBudget: 5000, humanAmplificationEligibleCapacity: 0 };
  const consideration = humanConsiderationOf({ budget });
  assert.equal(consideration.eligible, false);
  assert.match(consideration.reason, /no eligible human-treatment capacity observable/);
  const selection = selectNextTreatment({ ...BASE_SELECTION_INPUT, budget });
  assert.ok(NON_HUMAN_TREATMENT_FAMILIES.includes(selection.selectedFamily));
});

test('MKT-054 zero-human: capacity but UNFUNDED → still not eligible, still continues non-human', () => {
  const budget = { ...ZERO_HUMAN_BUDGET, humanAmplificationBudget: 0, humanAmplificationEligibleCapacity: 50 };
  const consideration = humanConsiderationOf({ budget });
  assert.equal(consideration.eligible, false);
  assert.match(consideration.reason, /unfunded/);
  const selection = selectNextTreatment({ ...BASE_SELECTION_INPUT, budget });
  assert.ok(NON_HUMAN_TREATMENT_FAMILIES.includes(selection.selectedFamily));
});

test('MKT-054 zero-human: funded WITH capacity and the objective favors humans → the arm tops the scoring but is HONESTLY REALLOCATED (never selected, never fabricated)', () => {
  // creator_growth ranks human_amplification FIRST in its affinity list.
  const budget = { ...ZERO_HUMAN_BUDGET, humanAmplificationBudget: 1000, humanAmplificationEligibleCapacity: 25 };
  const selection = selectNextTreatment({
    ...BASE_SELECTION_INPUT,
    objectiveFamily: 'creator_growth',
    budget,
  });
  const consideration = humanConsiderationOf({ budget });
  assert.equal(consideration.eligible, true, 'the arm is considered eligible as a strategy INPUT');
  // ...but the MKT-054 controller CANNOT delegate human work (the /jobs
  // seam is the later optional MKT-076..078 wave) — the honest reallocation:
  assert.equal(selection.reallocatedFromHuman, true);
  assert.ok(
    NON_HUMAN_TREATMENT_FAMILIES.includes(selection.selectedFamily),
    'the selection ALWAYS lands on a non-human delegable family',
  );
  assert.match(
    selection.rationale,
    /human-amplification arm topped the scoring .*reallocating to the best non-human treatment/,
  );
  // The human candidate is present in the scoring trail but marked NOT
  // delegable (the disclosed record — never a fabricated human result).
  const humanCandidate = selection.candidates.find((c) => c.family === HUMAN_TREATMENT_FAMILY)!;
  assert.equal(humanCandidate.delegable, false);
  assert.equal(humanCandidate.score, Math.max(...selection.candidates.map((c) => c.score)));
});

test('MKT-054 zero-human: every objective family continues non-human under EVERY human-budget/capacity combination', () => {
  const families = [
    'audience_growth', 'creator_growth', 'product_marketing', 'acquisition',
    'lead_generation', 'revenue', 'commerce_discovery', 'hybrid',
  ];
  const budgetVariants = [
    ZERO_HUMAN_BUDGET,
    { ...ZERO_HUMAN_BUDGET, humanAmplificationBudget: 1000 },
    { ...ZERO_HUMAN_BUDGET, humanAmplificationEligibleCapacity: 10 },
    { ...ZERO_HUMAN_BUDGET, humanAmplificationBudget: 1000, humanAmplificationEligibleCapacity: 10 },
  ];
  for (const family of families) {
    for (const budget of budgetVariants) {
      const selection = selectNextTreatment({ ...BASE_SELECTION_INPUT, objectiveFamily: family, budget });
      assert.ok(
        NON_HUMAN_TREATMENT_FAMILIES.includes(selection.selectedFamily),
        `${family} @ budget=${budget.humanAmplificationBudget}/capacity=${budget.humanAmplificationEligibleCapacity} must continue non-human`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. The bounded exploration/exploitation scoring (pure, deterministic)
// ---------------------------------------------------------------------------

test('MKT-054: the bounded exploration guarantee — each family gets its exploration window before exploitation dominates', () => {
  const input = { ...BASE_SELECTION_INPUT };
  // With no history, every family gets the exploration bonus.
  for (const family of NON_HUMAN_TREATMENT_FAMILIES) {
    const score = scoreCandidate(family, input);
    assert.ok(score > 0, `${family} scores positive inside the exploration window`);
  }
  // After the exploration window closes, the bonus drops (the count
  // changes the score deterministically).
  const family = 'owned_channel_publish';
  const before = scoreCandidate(family, input);
  const after = scoreCandidate(family, {
    ...input,
    familyDispatchCounts: { owned_channel_publish: EXPLORATION_STEPS_PER_FAMILY },
  });
  assert.ok(after < before, 'the exploration bonus ends after the bounded window');
});

test('MKT-054: the honest outcome memory — a succeeded family is favored, a failed one cools down (deterministically)', () => {
  const input = { ...BASE_SELECTION_INPUT };
  const neutral = scoreCandidate('channel_reallocation', input);
  const succeeded = scoreCandidate('channel_reallocation', {
    ...input,
    familyLastOutcomes: { channel_reallocation: 'delegated_work_succeeded' },
  });
  const failed = scoreCandidate('channel_reallocation', {
    ...input,
    familyLastOutcomes: { channel_reallocation: 'delegated_work_failed' },
  });
  assert.ok(succeeded > neutral);
  assert.ok(failed < neutral);
  assert.ok(succeeded > failed);
});

test('MKT-054: the deterministic tie-break — score DESC then family ASC (no time factors, no randomness)', () => {
  // Equal scores across families (equal affinity rank construction):
  const selection = selectNextTreatment({
    ...BASE_SELECTION_INPUT,
    objectiveFamily: 'hybrid', // content_variant_test is rank 0
    familyDispatchCounts: {}, // every family in its exploration window
  });
  const sorted = [...selection.candidates].sort(
    (a, b) => b.score - a.score || (a.family < b.family ? -1 : 1),
  );
  assert.deepEqual(
    selection.candidates.map((c) => c.family),
    sorted.map((c) => c.family),
    'the candidate trail is the deterministic order itself',
  );
});

// ---------------------------------------------------------------------------
// 5. The input guards (pure)
// ---------------------------------------------------------------------------

test('MKT-054: the provenance guard rejects malformed provenance (server-derived only)', () => {
  assert.throws(
    () => assertValidGrowthOperatorProvenance({ actor: '', recordedVia: 'module', correlationId: 'c', causationId: null }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidGrowthOperatorProvenance({ actor: 'a', recordedVia: '', correlationId: 'c', causationId: null }),
    InvalidRequestError,
  );
  assert.throws(
    () => assertValidGrowthOperatorProvenance({ actor: 'a', recordedVia: 'module', correlationId: '', causationId: null }),
    InvalidRequestError,
  );
  assert.doesNotThrow(() =>
    assertValidGrowthOperatorProvenance({ actor: 'service:growth-operator', recordedVia: 'module', correlationId: 'c-1', causationId: null }),
  );
  assert.doesNotThrow(() =>
    assertValidGrowthOperatorProvenance({ actor: 'worker:tick', recordedVia: 'module', correlationId: 'c-1', causationId: 'job-1' }),
  );
});

test('MKT-054: the reason guard requires bounded non-empty prose (the honest record)', () => {
  assert.doesNotThrow(() => assertValidGrowthOperatorReason('a perfectly honest reason'));
  assert.throws(() => assertValidGrowthOperatorReason(''), InvalidRequestError);
  assert.throws(() => assertValidGrowthOperatorReason('   '), InvalidRequestError);
  assert.throws(() => assertValidGrowthOperatorReason('x'.repeat(2001)), InvalidRequestError);
});
