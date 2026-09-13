/**
 * MKT-042 unit tests — the frozen Decision Ledger taxonomies, the
 * proposal/disposition/outcome guards, the §8 create fingerprint, the DB
 * conflict classification and the canonical owner-context composer (pure
 * functions, no DB).
 *
 * Proofs (spec/architecture-v1.5.md §4; the primary contract
 * spec/operating-graph-v1.5.md "Decision Ledger"; frozen by
 * spec/architecture-lock-v1.5.md rule #5 and spec/change-request-005.md
 * change #2):
 *   - the DISPOSITION taxonomy is exactly the 4 frozen values (proposed,
 *     accepted, rejected, superseded) — a closed set, with the three
 *     dispositions TERMINAL (a second disposition never rewrites history);
 *   - the disposition COMMAND table encodes exactly the three legal edges
 *     from 'proposed' (accept/reject/supersede) — 'proposed' is the ONLY
 *     source state;
 *   - the impact-direction taxonomy is exactly the 4 frozen directions;
 *   - the create guard enforces the full frozen proposal vocabulary:
 *     non-empty bounded objective/hypothesisSummary (context optional),
 *     uuid-shaped duplicate-free evidenceRefs, a uuid experimentRef, the
 *     structured expectedImpact (required summary + closed-set direction +
 *     bounded magnitude), the SEPARATE uncertainty payload (interval |
 *     distribution | qualitative — each shape validated), bounded
 *     expectedCost, bounded alternatives, a uuid predecessor link and the
 *     §8 idempotency key — with §21 material-key rejection on every
 *     structured payload;
 *   - the disposition-input guard enforces the frozen command vocabulary,
 *     the successor-presence rules (supersede carries it; nothing else
 *     does) and the bounded reason;
 *   - the outcome-input guard enforces the structured observation
 *     (required summary, boolean asExpected, bounded notes), the
 *     AT-MOST-ONE implementation-reference rule (execution XOR deployment)
 *     and the uuid reference shapes;
 *   - the proposer + provenance guards fail closed on incomplete
 *     server-derived values;
 *   - the §8 create fingerprint is deterministic, payload-sensitive on
 *     every caller-visible dimension and INDEPENDENT of the idempotency
 *     key (one key + one payload identifies one logical command);
 *   - classifyDecisionWriteConflict converges the migration 036
 *     trigger/CHECK/fence rejections into their domain conflict classes;
 *   - composeDecisionOwnerContext derives the canonical scope from the
 *     CLIENT OWNERSHIP and the decision record only (never from caller
 *     input) and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_DISPOSITIONS,
  DECISION_DISPOSITION_COMMANDS,
  DECISION_DISPOSITION_TABLE,
  DECISION_IMPACT_DIRECTIONS,
  TERMINAL_DECISION_DISPOSITIONS,
  assertValidDecisionCreate,
  assertValidDecisionDispositionInput,
  assertValidDecisionOutcomeInput,
  assertValidDecisionProposer,
  assertValidDecisionProvenance,
  classifyDecisionWriteConflict,
  composeDecisionOwnerContext,
  fingerprintDecisionCreate,
  isKnownDecisionDisposition,
  isKnownDecisionDispositionCommand,
  isKnownDecisionImpactDirection,
  isTerminalDecisionDisposition,
  type DecisionCreateInput,
  type DecisionDispositionInput,
  type DecisionOwnerContext,
  type DecisionRecord,
  type DecisionsClientOwnershipSnapshot,
  type DecisionsWorkspaceOwnershipSnapshot,
} from '../../src/modules/decisions/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PROVENANCE = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
} as const;

const VALID_PROPOSER = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  role: 'agency_owner',
} as const;

const EVIDENCE_ID = '00000000-0000-4000-8000-0000000000e1';
const EXPERIMENT_ID = '00000000-0000-4000-8000-0000000000e2';
const DECISION_A = '00000000-0000-4000-8000-0000000000aa';
const DECISION_B = '00000000-0000-4000-8000-0000000000bb';

function validCreateInput(): DecisionCreateInput {
  return {
    clientId: '00000000-0000-4000-8000-0000000000c1',
    workspaceId: null,
    objective: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    context: 'Q1 activation numbers are below target; the experiment concluded with a causal lift.',
    hypothesisSummary:
      'A 5-touch onboarding email sequence increases new-account activation versus the 3-touch sequence.',
    experimentRef: EXPERIMENT_ID,
    evidenceRefs: [EVIDENCE_ID],
    expectedImpact: {
      summary: 'New-account activation rate is expected to rise by roughly two points.',
      direction: 'increase',
      magnitude: '+18% relative CVR lift',
    },
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    expectedCost: 'One additional email send per new account (~$0.003/account).',
    alternatives: [
      'Keep the 3-touch sequence (status quo).',
      'Roll out only to standard-tier accounts first.',
    ],
    predecessorDecisionId: null,
    idempotencyKey: 'decision-create-1',
  };
}

/**
 * assert.throws validator matching against the message AND the details
 * list (the guards carry their per-field problems in details).
 */
function throwsWith(fragment: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof Error, `expected an Error, got: ${String(error)}`);
    const details = (error as { details?: ReadonlyArray<string> }).details ?? [];
    const haystack = `${error.message} ${details.join(' ')}`;
    assert.ok(
      haystack.includes(fragment),
      `expected '${fragment}' in: ${haystack}`,
    );
    return true;
  };
}

// ---------------------------------------------------------------------------
// The frozen taxonomies
// ---------------------------------------------------------------------------

test('the disposition taxonomy is exactly the four frozen values (proposed, accepted, rejected, superseded)', () => {
  assert.deepEqual([...DECISION_DISPOSITIONS].sort(), [
    'accepted',
    'proposed',
    'rejected',
    'superseded',
  ]);
  for (const disposition of DECISION_DISPOSITIONS) {
    assert.ok(isKnownDecisionDisposition(disposition), `'${disposition}' must be known`);
  }
  assert.equal(isKnownDecisionDisposition('draft'), false);
  assert.equal(isKnownDecisionDisposition(''), false);
  assert.equal(isKnownDecisionDisposition('ACCEPTED'), false);
  assert.equal(isKnownDecisionDisposition('withdrawn'), false);
});

test('accepted, rejected and superseded are TERMINAL; proposed is not', () => {
  assert.deepEqual([...TERMINAL_DECISION_DISPOSITIONS].sort(), [
    'accepted',
    'rejected',
    'superseded',
  ]);
  assert.equal(isTerminalDecisionDisposition('accepted'), true);
  assert.equal(isTerminalDecisionDisposition('rejected'), true);
  assert.equal(isTerminalDecisionDisposition('superseded'), true);
  assert.equal(isTerminalDecisionDisposition('proposed'), false);
});

test('the disposition command table encodes exactly the three legal edges from proposed', () => {
  assert.deepEqual([...DECISION_DISPOSITION_COMMANDS].sort(), [
    'accept',
    'reject',
    'supersede',
  ]);
  for (const command of DECISION_DISPOSITION_COMMANDS) {
    assert.ok(isKnownDecisionDispositionCommand(command), `'${command}' must be known`);
  }
  assert.equal(isKnownDecisionDispositionCommand('propose'), false);
  assert.equal(isKnownDecisionDispositionCommand('withdraw'), false);
  assert.equal(isKnownDecisionDispositionCommand(''), false);
  // Every edge starts at proposed; the three targets are exactly the
  // terminal set and are all distinct.
  for (const command of DECISION_DISPOSITION_COMMANDS) {
    assert.equal(DECISION_DISPOSITION_TABLE[command].from, 'proposed');
    assert.ok(isTerminalDecisionDisposition(DECISION_DISPOSITION_TABLE[command].to));
  }
  assert.deepEqual(
    [...DECISION_DISPOSITION_COMMANDS].map((command) => DECISION_DISPOSITION_TABLE[command].to),
    ['accepted', 'rejected', 'superseded'],
  );
});

test('the impact-direction taxonomy is exactly the four frozen directions', () => {
  assert.deepEqual([...DECISION_IMPACT_DIRECTIONS].sort(), [
    'any',
    'decrease',
    'increase',
    'no_change',
  ]);
  for (const direction of DECISION_IMPACT_DIRECTIONS) {
    assert.ok(isKnownDecisionImpactDirection(direction), `'${direction}' must be known`);
  }
  assert.equal(isKnownDecisionImpactDirection('up'), false);
  assert.equal(isKnownDecisionImpactDirection(''), false);
  assert.equal(isKnownDecisionImpactDirection('INCREASE'), false);
});

// ---------------------------------------------------------------------------
// The create guard (the frozen proposal vocabulary)
// ---------------------------------------------------------------------------

test('the create guard accepts the canonical decision payload', () => {
  assert.doesNotThrow(() => assertValidDecisionCreate(validCreateInput()));
  // Every optional dimension may be absent (null/empty).
  assert.doesNotThrow(() =>
    assertValidDecisionCreate({
      ...validCreateInput(),
      workspaceId: null,
      context: null,
      experimentRef: null,
      evidenceRefs: [],
      uncertainty: null,
      expectedCost: null,
      alternatives: [],
      predecessorDecisionId: null,
    }),
  );
  // Every uncertainty shape is legal in isolation.
  assert.doesNotThrow(() =>
    assertValidDecisionCreate({
      ...validCreateInput(),
      uncertainty: { kind: 'distribution', descriptor: 'normal(mean=0.02, sd=0.008)' },
    }),
  );
  assert.doesNotThrow(() =>
    assertValidDecisionCreate({
      ...validCreateInput(),
      uncertainty: { kind: 'qualitative', description: 'Strong causal evidence; delivery risk low.' },
    }),
  );
});

test('the create guard rejects empty or oversized core text fields', () => {
  for (const field of ['objective', 'hypothesisSummary'] as const) {
    for (const value of ['', '   ']) {
      assert.throws(
        () => assertValidDecisionCreate({ ...validCreateInput(), [field]: value }),
        throwsWith(`${field}: a non-empty value is required`),
      );
    }
    assert.throws(
      () => assertValidDecisionCreate({ ...validCreateInput(), [field]: 'x'.repeat(2001) }),
      throwsWith(`${field}: must be at most 2000 characters`),
    );
  }
  // Optional context/expectedCost stay bounded when present.
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), context: 'x'.repeat(2001) }),
    throwsWith('context: must be at most 2000 characters'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), expectedCost: 'x'.repeat(2001) }),
    throwsWith('expectedCost: must be at most 2000 characters'),
  );
});

test('the create guard rejects malformed reference shapes', () => {
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), experimentRef: 'not-a-uuid' }),
    throwsWith('experimentRef: must be a canonical record id (uuid)'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), predecessorDecisionId: 'nope' }),
    throwsWith('predecessorDecisionId: must be a canonical record id (uuid)'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), evidenceRefs: ['not-a-uuid'] }),
    throwsWith('evidenceRefs[0]: must be an evidence record id (uuid)'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        evidenceRefs: [EVIDENCE_ID, EVIDENCE_ID],
      }),
    throwsWith('duplicate evidence reference'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        evidenceRefs: Array.from({ length: 51 }, () => EVIDENCE_ID.replace(/e1$/, 'aa')),
      }),
    throwsWith('at most 50 evidence records'),
  );
  // The evidence refs array is REQUIRED (empty allowed, absent not).
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        evidenceRefs: undefined as unknown as readonly string[],
      }),
    throwsWith('evidenceRefs: required'),
  );
});

test('the create guard rejects malformed expected impact payloads', () => {
  // Missing entirely.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        expectedImpact: null as unknown as DecisionCreateInput['expectedImpact'],
      }),
    throwsWith('expectedImpact: a structured expected impact'),
  );
  // Missing summary.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        expectedImpact: { direction: 'increase' } as unknown as DecisionCreateInput['expectedImpact'],
      }),
    throwsWith('expectedImpact.summary: a non-empty value is required'),
  );
  // Free-string direction.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        expectedImpact: { summary: 'A summary.', direction: 'skyward' } as unknown as DecisionCreateInput['expectedImpact'],
      }),
    throwsWith('expectedImpact.direction: must be one of the frozen impact directions'),
  );
  // Oversized magnitude.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        expectedImpact: { summary: 'A summary.', magnitude: 'x'.repeat(201) } as unknown as DecisionCreateInput['expectedImpact'],
      }),
    throwsWith('expectedImpact.magnitude: must be at most 200 characters'),
  );
  // §21: material-shaped keys never ride the structured payload.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        expectedImpact: { summary: 'A summary.', secret: 'x' } as unknown as DecisionCreateInput['expectedImpact'],
      }),
    throwsWith('material-shaped keys can never appear in decision payloads'),
  );
});

test('the create guard rejects malformed uncertainty payloads (the SEPARATE column)', () => {
  // Unknown kind.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'gut_feel' } as unknown as DecisionCreateInput['uncertainty'],
      }),
    throwsWith('uncertainty.kind: must be one of interval, distribution, qualitative'),
  );
  // Interval: missing bounds / inverted bounds / out-of-range level.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'interval', lower: 0.01, upper: 0.02 } as unknown as DecisionCreateInput['uncertainty'],
      }),
    throwsWith('uncertainty.level: a coverage level strictly between 0 and 1 is required'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'interval', lower: 0.05, upper: 0.02, level: 0.95 },
      }),
    throwsWith('lower must not exceed upper'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'interval', lower: Number.NaN, upper: 0.02, level: 0.95 },
      }),
    throwsWith('uncertainty.lower: a finite number is required'),
  );
  // Distribution: empty/oversized descriptor.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'distribution', descriptor: '' },
      }),
    throwsWith('uncertainty.descriptor: a non-empty distribution descriptor is required'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'distribution', descriptor: 'x'.repeat(501) },
      }),
    throwsWith('uncertainty.descriptor: must be at most 500 characters'),
  );
  // Qualitative: empty/oversized description.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'qualitative', description: '   ' },
      }),
    throwsWith('uncertainty.description: a non-empty qualitative description is required'),
  );
  // §21 on the uncertainty payload.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        uncertainty: { kind: 'distribution', descriptor: 'normal(0,1)', password: 'x' } as unknown as DecisionCreateInput['uncertainty'],
      }),
    throwsWith('material-shaped keys can never appear in decision payloads'),
  );
});

test('the create guard rejects malformed alternatives and idempotency keys', () => {
  // Alternatives: required array, bounded entries, bounded count.
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        alternatives: undefined as unknown as readonly string[],
      }),
    throwsWith('alternatives: required'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), alternatives: [''] }),
    throwsWith('alternatives[0]: non-empty strings only'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), alternatives: ['x'.repeat(1001)] }),
    throwsWith('alternatives[0]: must be at most 1000 characters'),
  );
  assert.throws(
    () =>
      assertValidDecisionCreate({
        ...validCreateInput(),
        alternatives: Array.from({ length: 21 }, (_, index) => `alternative-${index}`),
      }),
    throwsWith('at most 20 considered alternatives'),
  );
  // The §8 key: non-empty, bounded.
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), idempotencyKey: '' }),
    throwsWith('idempotencyKey: a non-empty logical command key is required'),
  );
  assert.throws(
    () => assertValidDecisionCreate({ ...validCreateInput(), idempotencyKey: 'x'.repeat(201) }),
    throwsWith('idempotencyKey: must be at most 200 characters'),
  );
});

// ---------------------------------------------------------------------------
// The disposition-input guard
// ---------------------------------------------------------------------------

test('the disposition guard accepts the canonical command payloads and rejects unknowns', () => {
  assert.doesNotThrow(() =>
    assertValidDecisionDispositionInput({
      command: 'accept',
      reason: 'Rolling out to all new clients.',
      successorDecisionId: null,
      idempotencyKey: 'disposition-1',
    }),
  );
  assert.doesNotThrow(() =>
    assertValidDecisionDispositionInput({
      command: 'reject',
      reason: null,
      successorDecisionId: null,
      idempotencyKey: 'disposition-2',
    }),
  );
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'withdraw',
        reason: null,
        successorDecisionId: null,
        idempotencyKey: 'disposition-3',
      } as unknown as DecisionDispositionInput),
    throwsWith('must be one of the frozen disposition commands (accept, reject, supersede)'),
  );
});

test('the successor rides EXACTLY the supersede command', () => {
  assert.doesNotThrow(() =>
    assertValidDecisionDispositionInput({
      command: 'supersede',
      reason: 'Better-informed correction recorded.',
      successorDecisionId: DECISION_B,
      idempotencyKey: 'disposition-4',
    }),
  );
  // Supersede without a successor.
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'supersede',
        reason: null,
        successorDecisionId: null,
        idempotencyKey: 'disposition-5',
      }),
    throwsWith('successorDecisionId: required for the supersede command'),
  );
  // Non-supersede WITH a successor.
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'accept',
        reason: null,
        successorDecisionId: DECISION_B,
        idempotencyKey: 'disposition-6',
      }),
    throwsWith('only the supersede command carries a successor'),
  );
  // Malformed successor id.
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'supersede',
        reason: null,
        successorDecisionId: 'not-a-uuid',
        idempotencyKey: 'disposition-7',
      }),
    throwsWith('successorDecisionId: must be a decision id (uuid)'),
  );
  // Oversized reason / bad key.
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'accept',
        reason: 'x'.repeat(2001),
        successorDecisionId: null,
        idempotencyKey: 'disposition-8',
      }),
    throwsWith('reason: must be at most 2000 characters'),
  );
  assert.throws(
    () =>
      assertValidDecisionDispositionInput({
        command: 'accept',
        reason: null,
        successorDecisionId: null,
        idempotencyKey: '',
      }),
    throwsWith('idempotencyKey: a non-empty logical command key is required'),
  );
});

// ---------------------------------------------------------------------------
// The outcome-input guard
// ---------------------------------------------------------------------------

function validOutcomeInput() {
  return {
    observedOutcome: {
      summary: 'Activation rose 2.1 points, in line with the expected interval.',
      asExpected: true,
      notes: 'Delivery was stable; no unsubscribes spike.',
    },
    executionRef: '00000000-0000-4000-8000-0000000000f1',
    deploymentRef: null,
    learningRef: '00000000-0000-4000-8000-0000000000f2',
    idempotencyKey: 'outcome-1',
  };
}

type OutcomeInput = Parameters<typeof assertValidDecisionOutcomeInput>[0];

test('the outcome guard accepts the canonical observation payloads', () => {
  assert.doesNotThrow(() => assertValidDecisionOutcomeInput(validOutcomeInput()));
  // The minimal observation (summary only).
  assert.doesNotThrow(() =>
    assertValidDecisionOutcomeInput({
      ...validOutcomeInput(),
      observedOutcome: { summary: 'Observed.' } as unknown as OutcomeInput['observedOutcome'],
    }),
  );
  // No implementation reference at all is legal (neither supplied).
  assert.doesNotThrow(() =>
    assertValidDecisionOutcomeInput({
      ...validOutcomeInput(),
      executionRef: null,
      deploymentRef: null,
      learningRef: null,
    }),
  );
});

test('the outcome guard rejects malformed observations', () => {
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        observedOutcome: null as unknown as OutcomeInput['observedOutcome'],
      }),
    throwsWith('observedOutcome: a structured observed outcome'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        observedOutcome: { asExpected: true } as unknown as OutcomeInput['observedOutcome'],
      }),
    throwsWith('observedOutcome.summary: a non-empty value is required'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        observedOutcome: { summary: 'Observed.', asExpected: 'yes' } as unknown as OutcomeInput['observedOutcome'],
      }),
    throwsWith('observedOutcome.asExpected: must be a boolean when present'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        observedOutcome: { summary: 'Observed.', notes: 'x'.repeat(2001) } as unknown as OutcomeInput['observedOutcome'],
      }),
    throwsWith('observedOutcome.notes: must be at most 2000 characters'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        observedOutcome: { summary: 'Observed.', token: 'x' } as unknown as OutcomeInput['observedOutcome'],
      }),
    throwsWith('material-shaped keys can never appear in decision payloads'),
  );
});

test('the outcome guard enforces AT MOST ONE implementation reference (execution XOR deployment)', () => {
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        executionRef: '00000000-0000-4000-8000-0000000000f1',
        deploymentRef: '00000000-0000-4000-8000-0000000000f3',
      }),
    throwsWith('at most ONE implementation reference'),
  );
  // Malformed reference shapes.
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        executionRef: 'not-a-uuid',
      }),
    throwsWith('executionRef: must be a canonical record id (uuid)'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        deploymentRef: 'not-a-uuid',
      }),
    throwsWith('deploymentRef: must be a canonical record id (uuid)'),
  );
  assert.throws(
    () =>
      assertValidDecisionOutcomeInput({
        ...validOutcomeInput(),
        learningRef: 'not-a-uuid',
      }),
    throwsWith('learningRef: must be a canonical record id (uuid)'),
  );
  assert.throws(
    () => assertValidDecisionOutcomeInput({ ...validOutcomeInput(), idempotencyKey: '' }),
    throwsWith('idempotencyKey: a non-empty logical command key is required'),
  );
});

// ---------------------------------------------------------------------------
// The proposer + provenance guards (server-derived dimensions)
// ---------------------------------------------------------------------------

test('the proposer guard fails closed on incomplete server-derived proposers', () => {
  assert.doesNotThrow(() => assertValidDecisionProposer(VALID_PROPOSER));
  assert.throws(
    () => assertValidDecisionProposer({ ...VALID_PROPOSER, actor: '' }),
    throwsWith('proposer.actor: a non-empty server-derived proposer identity is required'),
  );
  assert.throws(
    () => assertValidDecisionProposer({ ...VALID_PROPOSER, role: ' ' }),
    throwsWith('proposer.role: a non-empty server-derived proposer role is required'),
  );
});

test('the provenance guard fails closed on incomplete server-derived provenance', () => {
  assert.doesNotThrow(() => assertValidDecisionProvenance(VALID_PROVENANCE));
  assert.throws(
    () => assertValidDecisionProvenance({ ...VALID_PROVENANCE, actor: '' }),
    throwsWith('provenance.actor: a non-empty server-derived principal label is required'),
  );
  assert.throws(
    () => assertValidDecisionProvenance({ ...VALID_PROVENANCE, recordedVia: '' }),
    throwsWith('provenance.recordedVia: a non-empty server-derived system label is required'),
  );
  assert.throws(
    () => assertValidDecisionProvenance({ ...VALID_PROVENANCE, recordedVia: 'x'.repeat(101) }),
    throwsWith('provenance.recordedVia: a non-empty server-derived system label is required'),
  );
  assert.throws(
    () => assertValidDecisionProvenance({ ...VALID_PROVENANCE, correlationId: '' }),
    throwsWith('provenance.correlationId: decision mutations are correlation-linked'),
  );
  assert.throws(
    () => assertValidDecisionProvenance({ ...VALID_PROVENANCE, causationId: '' }),
    throwsWith('provenance.causationId: must be a non-empty identifier when present'),
  );
});

// ---------------------------------------------------------------------------
// The §8 create fingerprint (the convergence proof)
// ---------------------------------------------------------------------------

test('the §8 create fingerprint is deterministic and key-independent', () => {
  const first = fingerprintDecisionCreate(validCreateInput());
  assert.equal(fingerprintDecisionCreate(validCreateInput()), first, 'identical inputs → identical digests');
  // The idempotency key is NOT part of the caller-visible payload: one key
  // + one payload identifies one logical command, and the SAME payload
  // under a different key is still the same logical command shape.
  assert.equal(
    fingerprintDecisionCreate({ ...validCreateInput(), idempotencyKey: 'other-key' }),
    first,
  );
});

test('the §8 create fingerprint is payload-sensitive on every caller-visible dimension', () => {
  const first = fingerprintDecisionCreate(validCreateInput());
  for (const [label, override] of [
    ['workspace scope', { workspaceId: '00000000-0000-4000-8000-0000000000d1' }],
    ['objective', { objective: 'A different objective.' }],
    ['context', { context: null }],
    ['hypothesis summary', { hypothesisSummary: 'A different hypothesis.' }],
    ['experiment link', { experimentRef: null }],
    ['evidence refs', { evidenceRefs: [] }],
    ['expected impact', { expectedImpact: { summary: 'A different impact.' } }],
    ['uncertainty', { uncertainty: null }],
    ['expected cost', { expectedCost: null }],
    ['alternatives', { alternatives: [] }],
    ['predecessor link', { predecessorDecisionId: DECISION_A }],
  ] as ReadonlyArray<[string, Partial<DecisionCreateInput>]>) {
    assert.notEqual(
      fingerprintDecisionCreate({ ...validCreateInput(), ...override }),
      first,
      `the fingerprint must change with the ${label}`,
    );
  }
});

// ---------------------------------------------------------------------------
// DB conflict classification (the migration 036 backstop markers)
// ---------------------------------------------------------------------------

test('classifyDecisionWriteConflict converges every migration 036 marker to its domain class', () => {
  const cases = [
    ['illegal decision disposition transition: proposed → accepted is rejected', 'disposition-transition'],
    ['the decision proposal payload is immutable: rewriting decision 1 proposal/audit columns is rejected', 'proposal-immutable'],
    ['supersede requires a live correction successor: decision 1 must name its successor', 'successor-illegal'],
    ['decision 1 cites evidence 2 of another client — cross-tenant evidence linkage is rejected', 'evidence-refs-client'],
    ['decision 1 links experiment 2 of another client — cross-tenant experiment linkage is rejected', 'experiment-ref-client'],
    ['cross-tenant decision outcome references are rejected on decision 1', 'outcome-refs-client'],
    ['decision 1 predecessor 2 is already superseded — correct its successor instead', 'predecessor-illegal'],
    ['duplicate key value violates unique constraint "decisions_idempotency_key_unique"', 'idempotency-fence'],
  ] as const;
  for (const [message, expected] of cases) {
    assert.equal(
      classifyDecisionWriteConflict(new Error(message)),
      expected,
      `'${message.slice(0, 40)}…' must classify as ${expected}`,
    );
  }
  // The postgres unique-violation code classifies as the idempotency fence.
  assert.equal(
    classifyDecisionWriteConflict(
      Object.assign(new Error('some driver text'), { code: '23505' }),
    ),
    'idempotency-fence',
  );
  // Unknown errors pass through untouched.
  assert.equal(classifyDecisionWriteConflict(new Error('connection refused')), null);
  assert.equal(classifyDecisionWriteConflict('not an error'), null);
});

// ---------------------------------------------------------------------------
// The canonical owner-context composer
// ---------------------------------------------------------------------------

function decisionRecordFixture(): DecisionRecord {
  return {
    decisionId: DECISION_A,
    clientId: '00000000-0000-4000-8000-0000000000c1',
    workspaceId: null,
    agencyId: '00000000-0000-4000-8000-0000000000a1',
    objective: 'Objective.',
    context: null,
    hypothesisSummary: 'Hypothesis.',
    experimentRef: null,
    evidenceRefs: [],
    expectedImpact: { summary: 'Impact.', direction: null, magnitude: null },
    uncertainty: null,
    expectedCost: null,
    alternatives: [],
    predecessorDecisionId: null,
    proposer: { actor: 'user:1', role: 'agency_owner' },
    disposition: 'proposed',
    successorDecisionId: null,
    dispositionAt: null,
    observedOutcome: null,
    executionRef: null,
    deploymentRef: null,
    learningRef: null,
    outcomeAt: null,
    idempotencyKey: 'key-1',
    createFingerprint: 'dc1:abc:10',
    provenance: {
      actor: 'user:1',
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
      recordedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function clientOwnershipFixture(): DecisionsClientOwnershipSnapshot {
  return {
    scope: {
      kind: 'client',
      agencyId: '00000000-0000-4000-8000-0000000000a2',
      clientId: '00000000-0000-4000-8000-0000000000c1',
    },
    client: {
      clientId: '00000000-0000-4000-8000-0000000000c1',
      agencyId: '00000000-0000-4000-8000-0000000000a2',
      status: 'active',
    },
  };
}

test('composeDecisionOwnerContext derives the canonical scope from the CLIENT ownership only', () => {
  const decision = decisionRecordFixture();
  const ownership = clientOwnershipFixture();
  const workspace: DecisionsWorkspaceOwnershipSnapshot | null = null;
  const context: DecisionOwnerContext = composeDecisionOwnerContext(
    decision,
    ownership,
    workspace,
    '2026-06-01T00:00:00.000Z',
  );
  // The scope agency comes from the /clients canonical resolution — NOT
  // from the decision row's recorded agency (the client chain is the only
  // ownership authority) and never from caller input.
  assert.equal(context.scope.agencyId, ownership.scope.agencyId);
  assert.equal(context.scope.clientId, decision.clientId);
  assert.equal(context.scope.workspaceId, null);
  assert.equal(context.scope.decisionId, decision.decisionId);
  assert.equal(context.scope.kind, 'decision');
  assert.equal(context.decision, decision);
  assert.equal(context.clientOwnership, ownership);
  assert.equal(context.workspace, null);
});

test('composeDecisionOwnerContext is pure: identical inputs compose identical outputs', () => {
  const decision = decisionRecordFixture();
  const ownership = clientOwnershipFixture();
  const first = composeDecisionOwnerContext(decision, ownership, null, 't1');
  const second = composeDecisionOwnerContext(decision, ownership, null, 't1');
  assert.deepEqual(first, second);
  // A workspace-scoped decision composes the workspace snapshot through.
  const scoped = { ...decision, workspaceId: '00000000-0000-4000-8000-0000000000d1' };
  const workspaceSnapshot: DecisionsWorkspaceOwnershipSnapshot = {
    workspace: {
      workspaceId: '00000000-0000-4000-8000-0000000000d1',
      clientId: scoped.clientId,
      status: 'active',
    },
  };
  const scopedContext = composeDecisionOwnerContext(scoped, ownership, workspaceSnapshot, 't2');
  assert.equal(scopedContext.scope.workspaceId, '00000000-0000-4000-8000-0000000000d1');
  assert.equal(scopedContext.workspace, workspaceSnapshot);
});
