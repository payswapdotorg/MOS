/**
 * MKT-067 unit tests — the deterministic adaptive allocator of
 * /experiment-analysis (Part B): the bounded exploration/exploitation
 * shares, the recorded exploration floor, the REPRODUCIBILITY proof
 * (same input snapshot → the same decision), the ZERO-CAPACITY validity
 * (including the human-treatment arm — the human-growth invariant), the
 * honest all-zero state and the cold-start posture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExperimentAllocationArmInput } from '../../src/modules/experiment-analysis/public.ts';
import { computeAdaptiveAllocation } from '../../src/modules/experiment-analysis/public.ts';

function arm(
  armKey: string,
  kind: ExperimentAllocationArmInput['kind'],
  capacity: number,
  sampleSize: number,
  mean: number,
  variance: number,
): ExperimentAllocationArmInput {
  return { armKey, kind, capacity, sampleSize, mean, variance };
}

const STRATEGY_ARMS: readonly ExperimentAllocationArmInput[] = [
  arm('short_form_video', 'strategy_variant', 100, 50, 3.2, 4),
  arm('carousel_post', 'strategy_variant', 100, 50, 1.1, 4),
  arm('text_post', 'strategy_variant', 100, 50, 0.4, 4),
];

// ---------------------------------------------------------------------------
// Bounded exploration/exploitation (the §12 rule)
// ---------------------------------------------------------------------------

test('MKT-067: the allocator increases exposure to promising variants while RETAINING explicit exploration', () => {
  const computed = computeAdaptiveAllocation({ arms: STRATEGY_ARMS, explorationFloor: 0.1 });
  assert.deepEqual(computed.eligibleArms, ['carousel_post', 'short_form_video', 'text_post']);
  assert.deepEqual(computed.zeroCapacityArms, []);

  const shares = Object.values(computed.shares);
  const sum = shares.reduce((total, share) => total + share, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `the eligible shares sum to 1 (got ${sum})`);

  // Exploitation: the strongest conservative signal takes the largest
  // share; the non-positive-signal arm takes the smallest.
  assert.ok(computed.shares['short_form_video']! > computed.shares['carousel_post']!);
  assert.ok(computed.shares['carousel_post']! >= computed.shares['text_post']!);

  // RETAINED EXPLORATION: every eligible arm keeps AT LEAST its equal
  // share of the exploration floor (0.1 / 3 ≈ 0.0333) — no arm is ever
  // starved to zero, however promising another variant looks.
  const explorationSharePerArm = 0.1 / 3;
  for (const key of computed.eligibleArms) {
    assert.ok(
      computed.shares[key]! >= explorationSharePerArm - 1e-12,
      `arm '${key}' retains its exploration share (${computed.shares[key]})`,
    );
  }
  assert.ok(computed.shares['text_post']! >= explorationSharePerArm - 1e-12);
  assert.equal(computed.explorationShare, 0.1);
});

test('MKT-067: the cold start — no arm with a positive conservative signal exploits uniformly (the honest unknown)', () => {
  const computed = computeAdaptiveAllocation({
    arms: [
      arm('variant_a', 'strategy_variant', 10, 20, -1, 4),
      arm('variant_b', 'strategy_variant', 10, 20, -2, 4),
      arm('variant_c', 'strategy_variant', 10, 0, 0, 0),
    ],
    explorationFloor: 0.2,
  });
  const shares = Object.values(computed.shares);
  assert.ok(Math.abs(shares.reduce((t, s) => t + s, 0) - 1) < 1e-9);
  // Exploitation is uniform over the three arms: (1 − 0.2)/3 + 0.2/3.
  for (const key of computed.eligibleArms) {
    assert.ok(Math.abs(computed.shares[key]! - 1 / 3) < 1e-9);
  }
});

// ---------------------------------------------------------------------------
// The recorded exploration floor (data, never a magic number)
// ---------------------------------------------------------------------------

test('MKT-067: the exploration floor is an input, not a hardcoded constant — the shares follow it', () => {
  const withSmallFloor = computeAdaptiveAllocation({ arms: STRATEGY_ARMS, explorationFloor: 0.05 });
  const withLargeFloor = computeAdaptiveAllocation({ arms: STRATEGY_ARMS, explorationFloor: 0.5 });
  assert.equal(withSmallFloor.explorationShare, 0.05);
  assert.equal(withLargeFloor.explorationShare, 0.5);

  // A larger floor compresses the gap between the best and worst arm
  // (more exploration, bounded exploitation).
  const spread = (computed: ReturnType<typeof computeAdaptiveAllocation>): number => {
    const values = Object.values(computed.shares);
    return Math.max(...values) - Math.min(...values);
  };
  assert.ok(spread(withLargeFloor) < spread(withSmallFloor));

  // Both remain valid allocations (sum to 1, every arm ≥ floor share).
  for (const computed of [withSmallFloor, withLargeFloor]) {
    const values = Object.values(computed.shares);
    assert.ok(Math.abs(values.reduce((t, s) => t + s, 0) - 1) < 1e-9);
    for (const key of computed.eligibleArms) {
      assert.ok(computed.shares[key]! >= computed.explorationShare / computed.eligibleArms.length - 1e-12);
    }
  }
});

// ---------------------------------------------------------------------------
// REPRODUCIBILITY (the dispatch's named test, pure-core half)
// ---------------------------------------------------------------------------

test('MKT-067: allocation reproducibility — the same input snapshot produces the same decision', () => {
  const input = {
    arms: [
      ...STRATEGY_ARMS,
      arm('human_ugc', 'human_treatment', 5, 10, 2.0, 3),
    ],
    explorationFloor: 0.15,
  };
  const first = computeAdaptiveAllocation(input);
  const second = computeAdaptiveAllocation(input);
  const third = computeAdaptiveAllocation(
    JSON.parse(JSON.stringify(input)) as typeof input,
  );
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);

  // Declaration ORDER never influences the result (canonical armKey
  // ordering — the stable-tie rule).
  const shuffled = computeAdaptiveAllocation({
    arms: [...input.arms].reverse(),
    explorationFloor: 0.15,
  });
  assert.deepEqual(shuffled, first);

  // A DIFFERENT input produces a DIFFERENT decision (the digest is an
  // equality token, not a constant).
  const different = computeAdaptiveAllocation({
    arms: input.arms.map((one) => (one.armKey === 'text_post' ? { ...one, mean: 9 } : one)),
    explorationFloor: 0.15,
  });
  assert.notDeepEqual(different.shares, first.shares);
});

// ---------------------------------------------------------------------------
// ZERO-CAPACITY VALIDITY — the human-growth invariant (the dispatch's named
// test, pure-core half)
// ---------------------------------------------------------------------------

test('MKT-067: the allocator stays valid at ZERO human-treatment capacity — non-human allocation continues', () => {
  const withHumanCapacity = computeAdaptiveAllocation({
    arms: [
      ...STRATEGY_ARMS,
      arm('human_ugc', 'human_treatment', 20, 10, 3.0, 3),
    ],
    explorationFloor: 0.1,
  });
  const withZeroHumanCapacity = computeAdaptiveAllocation({
    arms: [
      ...STRATEGY_ARMS,
      arm('human_ugc', 'human_treatment', 0, 10, 3.0, 3),
    ],
    explorationFloor: 0.1,
  });

  // The zero-capacity human arm NEVER blocks, crashes or invalidates the
  // allocation: the decision is produced, valid and recorded.
  assert.deepEqual(withZeroHumanCapacity.eligibleArms, [
    'carousel_post',
    'short_form_video',
    'text_post',
  ]);
  const shares = Object.values(withZeroHumanCapacity.shares);
  assert.ok(Math.abs(shares.reduce((t, s) => t + s, 0) - 1) < 1e-9);
  assert.equal(withZeroHumanCapacity.zeroCapacityArms.length, 1);
  assert.equal(withZeroHumanCapacity.zeroCapacityArms[0]!.armKey, 'human_ugc');
  assert.equal(withZeroHumanCapacity.zeroCapacityArms[0]!.kind, 'human_treatment');
  assert.match(
    withZeroHumanCapacity.zeroCapacityArms[0]!.reason,
    /human-treatment arm 'human_ugc' has zero observable capacity/,
  );

  // The human-arm consideration is RECORDED (never an absence), with the
  // invariant note.
  assert.equal(withZeroHumanCapacity.humanTreatmentConsideration.present, true);
  assert.equal(withZeroHumanCapacity.humanTreatmentConsideration.excluded, true);
  assert.match(
    withZeroHumanCapacity.humanTreatmentConsideration.note,
    /never blocks, crashes or invalidates non-human allocation/,
  );

  // The remaining non-human arms receive exactly the allocation they
  // would have received had the human arm never been declared.
  const withoutHumanAtAll = computeAdaptiveAllocation({
    arms: STRATEGY_ARMS,
    explorationFloor: 0.1,
  });
  assert.deepEqual(withZeroHumanCapacity.shares, withoutHumanAtAll.shares);

  // And when the human arm HAS capacity it competes on its signal like
  // every other arm (the optional-treatment posture, rule 43).
  assert.ok(withHumanCapacity.eligibleArms.includes('human_ugc'));
  assert.equal(withHumanCapacity.humanTreatmentConsideration.excluded, false);
  assert.ok(
    (withHumanCapacity.shares['human_ugc'] ?? 0) > (withZeroHumanCapacity.shares['human_ugc'] ?? 0),
  );
});

test('MKT-067: a zero-capacity NON-human arm is excluded and recorded the same honest way', () => {
  const computed = computeAdaptiveAllocation({
    arms: [
      arm('short_form_video', 'strategy_variant', 100, 50, 3.2, 4),
      arm('paused_variant', 'strategy_variant', 0, 50, 9.9, 1),
    ],
    explorationFloor: 0.1,
  });
  assert.deepEqual(computed.eligibleArms, ['short_form_video']);
  assert.equal(computed.zeroCapacityArms[0]!.armKey, 'paused_variant');
  assert.match(
    computed.zeroCapacityArms[0]!.reason,
    /zero observable capacity — excluded from allocation \(a valid state, never an error/,
  );
  // The single eligible arm takes the whole exposure.
  assert.ok(Math.abs(computed.shares['short_form_video']! - 1) < 1e-9);
});

test('MKT-067: the honest all-zero state — every arm (human and non-human) at zero capacity records an EMPTY allocation, never an error', () => {
  const computed = computeAdaptiveAllocation({
    arms: [
      arm('short_form_video', 'strategy_variant', 0, 50, 3.2, 4),
      arm('human_ugc', 'human_treatment', 0, 10, 3.0, 3),
    ],
    explorationFloor: 0.1,
  });
  assert.deepEqual(computed.eligibleArms, []);
  assert.deepEqual(computed.shares, {});
  assert.equal(computed.zeroCapacityArms.length, 2);
  assert.equal(computed.explorationShare, 0);
  assert.equal(computed.humanTreatmentConsideration.present, true);
  assert.equal(computed.humanTreatmentConsideration.excluded, true);
});

test('MKT-067: no human arm declared — the absent optional treatment is a valid non-human state, never an error', () => {
  const computed = computeAdaptiveAllocation({
    arms: STRATEGY_ARMS,
    explorationFloor: 0.1,
  });
  assert.equal(computed.humanTreatmentConsideration.present, false);
  assert.equal(computed.humanTreatmentConsideration.capacity, 0);
  assert.equal(computed.humanTreatmentConsideration.excluded, true);
  assert.match(
    computed.humanTreatmentConsideration.note,
    /absent by declaration \(a valid non-human state, never an error\)/,
  );
  // The allocation proceeds normally over the declared arms.
  assert.equal(computed.eligibleArms.length, 3);
});

// ---------------------------------------------------------------------------
// Conservative-signal scoring (the deterministic promising-variant rule)
// ---------------------------------------------------------------------------

test('MKT-067: an unexplored arm (n = 0) scores its raw mean without a variance penalty — the cold-start prior', () => {
  const computed = computeAdaptiveAllocation({
    arms: [
      arm('established', 'strategy_variant', 10, 100, 2.0, 1),
      arm('brand_new', 'strategy_variant', 10, 0, 1.5, 0),
    ],
    explorationFloor: 0.1,
  });
  // established: 2 − 1.96·√(1/100) = 2 − 0.196 = 1.804
  // brand_new: 1.5 (no penalty) — both positive; established still leads.
  assert.ok(computed.shares['established']! > computed.shares['brand_new']!);
  assert.ok(computed.shares['brand_new']! > 0.1 / 2 - 1e-12);
});
