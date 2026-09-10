/**
 * MKT-027 unit tests — the frozen field-execution model as PURE functions
 * (spec/work-items.md MKT-027; spec/human-agent-v1.3.md §3/§5; requirements
 * JOB-001 field subset + EVID-001 field subset; the MKT-027 Work Order's
 * visit lifecycle).
 *
 * Proofs:
 *   - VISIT_STATUSES/VISIT_TRANSITIONS are exactly the frozen MKT-027
 *     visit lifecycle: planned → in_progress | cancelled; in_progress →
 *     completed | cancelled; completed/cancelled TERMINAL (no
 *     re-opening, no back-edges, no skip-edges like planned → completed);
 *   - VISIT_RESULTS is the frozen field-result vocabulary;
 *   - evaluateVisitTransition is the idempotent-transition decision:
 *     replay for the already-target state, apply for legal edges,
 *     terminal for frozen terminal rows, illegal for non-edges — and it
 *     is PURE (identical inputs → identical outputs);
 *   - validateVisitOpen accepts a complete open and rejects every
 *     malformed variant (target identity shape, scheduledAt, followUp);
 *   - validateVisitOutcome accepts a complete structured outcome and
 *     rejects every malformed variant (result vocabulary, followUp
 *     boolean, notes bound, observations non-empty object, evidenceRef
 *     required);
 *   - isSameVisitOutcomeSubmission: the outcome replay fingerprint
 *     (result + followUp + notes + observations + evidence + actor;
 *     provenance bookkeeping excluded);
 *   - visitContinuityExposedToAgent: the JOB-AC-04 POLICY CHECKPOINT over
 *     the frozen /field-agents profile relationship-continuity block —
 *     fails closed on absent policy data, false for prefersRepeatClients
 *     = false, false for continuity 'any', true for 'preferred' and
 *     'required' — and it is PURE (the single swap point for the future
 *     /policies authority).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VISIT_NOTES_LENGTH,
  MAX_VISIT_REASON_LENGTH,
  TARGET_IDENTITY_PATTERN,
  VISIT_RESULTS,
  VISIT_STATUSES,
  VISIT_TERMINAL_STATUSES,
  VISIT_TRANSITIONS,
  evaluateVisitTransition,
  isLegalVisitTransition,
  isSameVisitOutcomeSubmission,
  isTerminalVisitStatus,
  validateVisitOpen,
  validateVisitOutcome,
  visitContinuityExposedToAgent,
} from '../../src/modules/jobs/public.ts';
import type { VisitResult } from '../../src/modules/jobs/public.ts';
import type { RelationshipContinuity } from '../../src/modules/field-agents/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_OPEN = {
  targetIdentity: 'venue:osu-branch-42',
  scheduledAtIso: null as string | null,
  followUpOfVisitId: null as string | null,
};

const VALID_OUTCOME: {
  result: VisitResult;
  followUpRequired: boolean;
  notes: string;
  observations: Record<string, unknown>;
  evidenceRef: string;
} = {
  result: 'succeeded',
  followUpRequired: false,
  notes: 'Contact signed the feedback form.',
  observations: { forms_signed: 5, footfall_estimate: 42 },
  evidenceRef: '0d5d0f6c-4a0d-4f5b-9b1e-000000000001',
};

function continuityPolicy(overrides: {
  prefersRepeatClients?: boolean;
  continuity?: 'any' | 'preferred' | 'required';
  maxConcurrentClientRelationships?: number | null;
}): RelationshipContinuity {
  return {
    prefersRepeatClients: overrides.prefersRepeatClients ?? true,
    continuity: overrides.continuity ?? 'preferred',
    maxConcurrentClientRelationships:
      overrides.maxConcurrentClientRelationships === undefined
        ? 4
        : overrides.maxConcurrentClientRelationships,
  };
}

// ---------------------------------------------------------------------------
// Visit status machine (the frozen MKT-027 lifecycle)
// ---------------------------------------------------------------------------

test('VISIT_STATUSES is exactly the frozen four-state visit lifecycle', () => {
  assert.deepEqual([...VISIT_STATUSES].sort(), ['cancelled', 'completed', 'in_progress', 'planned']);
});

test('VISIT_TRANSITIONS is edge-for-edge the frozen MKT-027 machine', () => {
  assert.deepEqual(VISIT_TRANSITIONS, {
    planned: ['in_progress', 'cancelled'],
    in_progress: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  });
});

test('terminal visit statuses are completed and cancelled (immutable history)', () => {
  assert.deepEqual([...VISIT_TERMINAL_STATUSES].sort(), ['cancelled', 'completed']);
  for (const status of VISIT_STATUSES) {
    assert.equal(isTerminalVisitStatus(status), VISIT_TERMINAL_STATUSES.includes(status));
  }
});

test('isLegalVisitTransition: every frozen edge legal, every non-edge illegal', () => {
  const legal: Array<[string, string]> = [
    ['planned', 'in_progress'],
    ['planned', 'cancelled'],
    ['in_progress', 'completed'],
    ['in_progress', 'cancelled'],
  ];
  for (const [from, to] of legal) {
    assert.ok(
      isLegalVisitTransition(from as never, to as never),
      `${from} → ${to} must be legal`,
    );
  }
  const illegal: Array<[string, string]> = [
    ['planned', 'completed'], // no skip-edge: completion requires execution
    ['completed', 'planned'], // terminal frozen
    ['completed', 'cancelled'], // terminal frozen — the outcome stands
    ['cancelled', 'planned'], // terminal frozen
    ['cancelled', 'in_progress'], // terminal frozen
    ['in_progress', 'planned'], // no back-edge
    ['planned', 'planned'], // no self-loop
    ['in_progress', 'in_progress'], // no self-loop
  ];
  for (const [from, to] of illegal) {
    assert.ok(
      !isLegalVisitTransition(from as never, to as never),
      `${from} → ${to} must be ILLEGAL`,
    );
  }
});

test('VISIT_RESULTS is the frozen field-result vocabulary', () => {
  assert.deepEqual([...VISIT_RESULTS].sort(), ['failed', 'no_contact', 'partial', 'succeeded']);
});

// ---------------------------------------------------------------------------
// evaluateVisitTransition (the idempotent transition decision)
// ---------------------------------------------------------------------------

test('evaluateVisitTransition: apply for every legal edge', () => {
  assert.deepEqual(evaluateVisitTransition('planned', 'in_progress'), { kind: 'apply' });
  assert.deepEqual(evaluateVisitTransition('planned', 'cancelled'), { kind: 'apply' });
  assert.deepEqual(evaluateVisitTransition('in_progress', 'completed'), { kind: 'apply' });
  assert.deepEqual(evaluateVisitTransition('in_progress', 'cancelled'), { kind: 'apply' });
});

test('evaluateVisitTransition: replay when already in the target state', () => {
  // The SAME agent re-starting an in_progress visit / re-cancelling a
  // cancelled visit / re-completing a completed visit: converge to the
  // recorded state (idempotent, no state change).
  assert.deepEqual(evaluateVisitTransition('in_progress', 'in_progress'), { kind: 'replay' });
  assert.deepEqual(evaluateVisitTransition('cancelled', 'cancelled'), { kind: 'replay' });
  assert.deepEqual(evaluateVisitTransition('completed', 'completed'), { kind: 'replay' });
});

test('evaluateVisitTransition: terminal rows are frozen history', () => {
  assert.deepEqual(evaluateVisitTransition('completed', 'cancelled'), {
    kind: 'terminal',
    status: 'completed',
  });
  assert.deepEqual(evaluateVisitTransition('cancelled', 'in_progress'), {
    kind: 'terminal',
    status: 'cancelled',
  });
});

test('evaluateVisitTransition: non-edges are illegal (never a partial state)', () => {
  assert.deepEqual(evaluateVisitTransition('planned', 'completed'), {
    kind: 'illegal',
    from: 'planned',
    to: 'completed',
  });
  assert.deepEqual(evaluateVisitTransition('in_progress', 'planned'), {
    kind: 'illegal',
    from: 'in_progress',
    to: 'planned',
  });
});

test('evaluateVisitTransition is PURE: identical inputs → identical outputs', () => {
  for (const from of VISIT_STATUSES) {
    for (const to of VISIT_STATUSES) {
      const first = evaluateVisitTransition(from, to);
      const second = evaluateVisitTransition(from, to);
      assert.deepEqual(first, second, `${from} → ${to} must be deterministic`);
    }
  }
});

// ---------------------------------------------------------------------------
// validateVisitOpen (the DTO shape guard)
// ---------------------------------------------------------------------------

test('validateVisitOpen: accepts a complete valid open', () => {
  assert.deepEqual(validateVisitOpen(VALID_OPEN), []);
  assert.deepEqual(
    validateVisitOpen({
      targetIdentity: 'venue:osu-branch-42',
      scheduledAtIso: '2026-03-02T09:00:00.000Z',
      followUpOfVisitId: '0d5d0f6c-4a0d-4f5b-9b1e-000000000002',
    }),
    [],
  );
});

test('validateVisitOpen: rejects malformed target identities', () => {
  for (const bad of ['', '   ', 'x'.repeat(201), '#hash-start', 'tab\tchar', null, 42]) {
    const problems = validateVisitOpen({
      targetIdentity: bad as string,
      scheduledAtIso: null,
      followUpOfVisitId: null,
    });
    assert.ok(problems.length >= 1, `targetIdentity ${JSON.stringify(bad)} must be rejected`);
    assert.ok(problems[0]!.startsWith('targetIdentity:'));
  }
});

test('validateVisitOpen: rejects malformed scheduledAt and followUp values', () => {
  const badSchedule = validateVisitOpen({
    targetIdentity: 'venue:osu-branch-42',
    scheduledAtIso: 'not-a-timestamp',
    followUpOfVisitId: null,
  });
  assert.equal(badSchedule.length, 1);
  assert.ok(badSchedule[0]!.startsWith('scheduledAt:'));

  const badFollowUp = validateVisitOpen({
    targetIdentity: 'venue:osu-branch-42',
    scheduledAtIso: null,
    followUpOfVisitId: '',
  });
  assert.equal(badFollowUp.length, 1);
  assert.ok(badFollowUp[0]!.startsWith('followUpOfVisitId:'));
});

test('TARGET_IDENTITY_PATTERN: bounded printable identifier shape', () => {
  assert.ok(TARGET_IDENTITY_PATTERN.test('venue:osu-branch-42'));
  assert.ok(TARGET_IDENTITY_PATTERN.test('person/ama-mensah'));
  assert.ok(TARGET_IDENTITY_PATTERN.test('postal_area GA-183'));
  assert.ok(TARGET_IDENTITY_PATTERN.test('a'));
  assert.ok(!TARGET_IDENTITY_PATTERN.test(''));
  assert.ok(!TARGET_IDENTITY_PATTERN.test(' leading space'));
  assert.ok(!TARGET_IDENTITY_PATTERN.test('x'.repeat(201)));
  assert.ok(!TARGET_IDENTITY_PATTERN.test('unicode-é'));
});

// ---------------------------------------------------------------------------
// validateVisitOutcome (the structured outcome shape guard)
// ---------------------------------------------------------------------------

test('validateVisitOutcome: accepts a complete structured outcome', () => {
  assert.deepEqual(validateVisitOutcome(VALID_OUTCOME), []);
  assert.deepEqual(
    validateVisitOutcome({ ...VALID_OUTCOME, result: 'no_contact', followUpRequired: true, notes: '' }),
    [],
  );
});

test('validateVisitOutcome: rejects every malformed variant', () => {
  // result vocabulary
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, result: 'completed' }).some((p) =>
      p.startsWith('result:'),
    ),
  );
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, result: 'succeeded ' }).some((p) =>
      p.startsWith('result:'),
    ),
  );
  // followUpRequired boolean
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, followUpRequired: 'yes' as unknown as boolean }).some(
      (p) => p.startsWith('followUpRequired:'),
    ),
  );
  // notes bound
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, notes: 'x'.repeat(MAX_VISIT_NOTES_LENGTH + 1) }).some(
      (p) => p.startsWith('notes:'),
    ),
  );
  // observations non-empty object
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, observations: {} }).some((p) =>
      p.startsWith('observations:'),
    ),
  );
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, observations: [1, 2, 3] as unknown }).some((p) =>
      p.startsWith('observations:'),
    ),
  );
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, observations: null }).some((p) =>
      p.startsWith('observations:'),
    ),
  );
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, observations: 'text' as unknown }).some((p) =>
      p.startsWith('observations:'),
    ),
  );
  // evidenceRef required
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, evidenceRef: '' }).some((p) =>
      p.startsWith('evidenceRef:'),
    ),
  );
  assert.ok(
    validateVisitOutcome({ ...VALID_OUTCOME, evidenceRef: null as unknown as string }).some((p) =>
      p.startsWith('evidenceRef:'),
    ),
  );
});

test('MAX_VISIT_REASON_LENGTH is bounded (the cancel reason guard)', () => {
  assert.ok(MAX_VISIT_REASON_LENGTH > 0 && MAX_VISIT_REASON_LENGTH <= 2000);
});

// ---------------------------------------------------------------------------
// isSameVisitOutcomeSubmission (the replay fingerprint)
// ---------------------------------------------------------------------------

test('isSameVisitOutcomeSubmission: identical logical commands converge', () => {
  const candidate = { ...VALID_OUTCOME, submittedBy: 'user-1' };
  assert.ok(isSameVisitOutcomeSubmission({ ...VALID_OUTCOME, submittedBy: 'user-1' }, candidate));
});

test('isSameVisitOutcomeSubmission: every material difference conflicts', () => {
  const base = { ...VALID_OUTCOME, submittedBy: 'user-1' };
  assert.ok(!isSameVisitOutcomeSubmission(base, { ...base, result: 'partial' }));
  assert.ok(!isSameVisitOutcomeSubmission(base, { ...base, followUpRequired: true }));
  assert.ok(!isSameVisitOutcomeSubmission(base, { ...base, notes: 'different' }));
  assert.ok(!isSameVisitOutcomeSubmission(base, { ...base, submittedBy: 'user-2' }));
  assert.ok(
    !isSameVisitOutcomeSubmission(base, {
      ...base,
      evidenceRef: '0d5d0f6c-4a0d-4f5b-9b1e-000000000009',
    }),
  );
  assert.ok(
    !isSameVisitOutcomeSubmission(base, {
      ...base,
      observations: { forms_signed: 5, footfall_estimate: 43 },
    }),
  );
});

test('isSameVisitOutcomeSubmission: observation key ORDER does not matter (JSON semantic equality)', () => {
  const base = { ...VALID_OUTCOME, submittedBy: 'user-1' };
  assert.ok(
    isSameVisitOutcomeSubmission(base, {
      ...base,
      observations: { footfall_estimate: 42, forms_signed: 5 },
    }),
  );
});

// ---------------------------------------------------------------------------
// visitContinuityExposedToAgent (the JOB-AC-04 policy checkpoint)
// ---------------------------------------------------------------------------

test('JOB-AC-04 policy checkpoint: fails closed on absent policy data', () => {
  assert.equal(visitContinuityExposedToAgent(null), false);
});

test('JOB-AC-04 policy checkpoint: requires prefersRepeatClients AND continuity beyond any', () => {
  // Opted-in agents see the chain.
  assert.equal(visitContinuityExposedToAgent(continuityPolicy({ continuity: 'preferred' })), true);
  assert.equal(visitContinuityExposedToAgent(continuityPolicy({ continuity: 'required' })), true);
  // Opted-out / no-preference agents do not.
  assert.equal(visitContinuityExposedToAgent(continuityPolicy({ continuity: 'any' })), false);
  assert.equal(
    visitContinuityExposedToAgent(continuityPolicy({ prefersRepeatClients: false })),
    false,
  );
  assert.equal(
    visitContinuityExposedToAgent(
      continuityPolicy({ prefersRepeatClients: false, continuity: 'required' }),
    ),
    false,
  );
});

test('JOB-AC-04 policy checkpoint is PURE: identical inputs → identical outputs', () => {
  for (const prefers of [true, false]) {
    for (const mode of ['any', 'preferred', 'required'] as const) {
      const policy = continuityPolicy({ prefersRepeatClients: prefers, continuity: mode });
      assert.equal(
        visitContinuityExposedToAgent(policy),
        visitContinuityExposedToAgent(policy),
        `${prefers}/${mode} must be deterministic`,
      );
    }
  }
});
