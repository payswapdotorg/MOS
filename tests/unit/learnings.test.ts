/**
 * MKT-016 unit tests — the frozen Learning taxonomies, the
 * append/relationship/provenance guards and the canonical owner-context
 * composer (pure functions, no DB).
 *
 * Proofs (LEARN-001; spec/implementation-contract.md §17 "Learning
 * contract"; spec/evidence-and-experimentation.md §8 + the scientific
 * rules; spec/architecture.md §17):
 *   - the Learning STATE taxonomy is exactly the 4 frozen §17 values
 *     (active, superseded, contradicted, retired) — a closed set, with
 *     superseded/retired TERMINAL and contradicted NOT terminal ("Learnings
 *     have scope and may be contradicted by later evidence");
 *   - the relationship-kind taxonomy is exactly the 3 frozen kinds
 *     (contradicts, supersedes, retires) — a closed set, extension is a
 *     code+DB change, never a caller freedom;
 *   - the append guard enforces the §17 required-field set: non-empty
 *     bounded statement, a non-empty object of scalar applicability
 *     conditions (the applicability scope), uuid-shaped duplicate-free
 *     reference arrays (evidence + experiment outcomes), confidence as a
 *     SEPARATE descriptive field strictly within 0..1, and §21
 *     material-key rejection on the applicability payload;
 *   - the relationship-input guard enforces the closed kind taxonomy, the
 *     to-learning presence rules (contradiction/supersession carry the
 *     later learning; retirement carries none) and the no-self-reference
 *     rule (a learning cannot contradict/supersede/retire itself);
 *   - the provenance guard fails closed on incomplete server-derived
 *     provenance;
 *   - classifyLearningWriteConflict converges the DB fence/trigger
 *     rejections (single supersession, single retirement, terminal
 *     target, cross-tenant) into their domain conflict classes;
 *   - composeLearningOwnerContext derives the canonical scope from the
 *     CLIENT OWNERSHIP and the learning record only (never from caller
 *     input) and is pure: identical inputs compose identical outputs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEARNING_RELATIONSHIP_KINDS,
  LEARNING_STATUSES,
  LEARNING_STATUS_PRECEDENCE,
  TERMINAL_LEARNING_STATUSES,
  assertValidLearningCreate,
  assertValidLearningProvenance,
  assertValidLearningRelationshipInput,
  classifyLearningWriteConflict,
  composeLearningOwnerContext,
  isKnownLearningRelationshipKind,
  isKnownLearningStatus,
  isTerminalLearningStatus,
  type LearningCreateInput,
  type LearningOwnerContext,
  type LearningRecord,
  type LearningsClientOwnershipSnapshot,
  type LearningsWorkspaceOwnershipSnapshot,
} from '../../src/modules/learnings/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PROVENANCE = {
  actor: 'user:00000000-0000-4000-8000-000000000001',
  recordedVia: 'api',
  correlationId: 'corr-1',
  causationId: null,
} as const;

const LEARNING_A = '00000000-0000-4000-8000-0000000000aa';
const LEARNING_B = '00000000-0000-4000-8000-0000000000bb';
const EVIDENCE_ID = '00000000-0000-4000-8000-0000000000e1';
const EXPERIMENT_ID = '00000000-0000-4000-8000-0000000000e2';

function validCreateInput(): LearningCreateInput {
  return {
    clientId: '00000000-0000-4000-8000-0000000000c1',
    workspaceId: null,
    statement:
      'A 5-touch onboarding email sequence increases new-account activation versus the 3-touch sequence.',
    applicability: { channel: 'email', cohort: 'new_accounts', region: 'us' },
    evidenceRefs: [EVIDENCE_ID],
    experimentRefs: [EXPERIMENT_ID],
    confidence: 0.82,
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

test('the Learning state taxonomy is exactly the four frozen §17 values (active, superseded, contradicted, retired)', () => {
  assert.deepEqual([...LEARNING_STATUSES].sort(), [
    'active',
    'contradicted',
    'retired',
    'superseded',
  ]);
  for (const status of LEARNING_STATUSES) {
    assert.ok(isKnownLearningStatus(status), `'${status}' must be known`);
  }
  assert.equal(isKnownLearningStatus('draft'), false);
  assert.equal(isKnownLearningStatus(''), false);
  assert.equal(isKnownLearningStatus('SUPERSEDED'), false);
  assert.equal(isKnownLearningStatus('invalidated'), false);
});

test('superseded and retired are TERMINAL; contradicted and active are not', () => {
  assert.deepEqual([...TERMINAL_LEARNING_STATUSES].sort(), ['retired', 'superseded']);
  assert.equal(isTerminalLearningStatus('superseded'), true);
  assert.equal(isTerminalLearningStatus('retired'), true);
  assert.equal(isTerminalLearningStatus('contradicted'), false);
  assert.equal(isTerminalLearningStatus('active'), false);
  // The deterministic precedence covers every status exactly once.
  assert.deepEqual([...LEARNING_STATUS_PRECEDENCE].sort(), [
    'active',
    'contradicted',
    'retired',
    'superseded',
  ]);
});

test('the relationship-kind taxonomy is exactly the three frozen kinds (contradicts, supersedes, retires)', () => {
  assert.deepEqual([...LEARNING_RELATIONSHIP_KINDS].sort(), [
    'contradicts',
    'retires',
    'supersedes',
  ]);
  for (const kind of LEARNING_RELATIONSHIP_KINDS) {
    assert.ok(isKnownLearningRelationshipKind(kind), `'${kind}' must be known`);
  }
  assert.equal(isKnownLearningRelationshipKind('replaces'), false);
  assert.equal(isKnownLearningRelationshipKind(''), false);
  assert.equal(isKnownLearningRelationshipKind('CONTRADICTS'), false);
  assert.equal(isKnownLearningRelationshipKind('superseded'), false);
});

// ---------------------------------------------------------------------------
// The append guard (the §17 Learning contract shapes)
// ---------------------------------------------------------------------------

test('the append guard accepts the canonical Learning payload', () => {
  assert.doesNotThrow(() => assertValidLearningCreate(validCreateInput()));
  // Confidence is OPTIONAL descriptive metadata (null allowed).
  assert.doesNotThrow(() =>
    assertValidLearningCreate({ ...validCreateInput(), confidence: null }),
  );
  // The reference arrays may be empty (nothing cited yet).
  assert.doesNotThrow(() =>
    assertValidLearningCreate({
      ...validCreateInput(),
      evidenceRefs: [],
      experimentRefs: [],
    }),
  );
});

test('the append guard rejects an empty or oversized statement', () => {
  for (const statement of ['', '   ']) {
    assert.throws(
      () => assertValidLearningCreate({ ...validCreateInput(), statement }),
      throwsWith('statement: a non-empty value is required'),
    );
  }
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        statement: 'x'.repeat(2001),
      }),
    throwsWith('statement: must be at most 2000 characters'),
  );
});

test('the append guard rejects empty, non-object and non-scalar applicability conditions', () => {
  // Empty applicability: a Learning without applicability conditions is
  // not a durable scoped conclusion.
  assert.throws(
    () => assertValidLearningCreate({ ...validCreateInput(), applicability: {} }),
    throwsWith('applicability: a non-empty object of applicability conditions is required'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: null as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('applicability: a non-empty object of applicability conditions is required'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: ['channel'] as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('applicability: a non-empty object of applicability conditions is required'),
  );
  // Non-scalar condition values are rejected (the dimension convention).
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: { channel: { nested: true } } as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('applicability.channel: condition values must be scalars'),
  );
  // Nested arrays are rejected too.
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: { channel: ['email'] } as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('applicability.channel: condition values must be scalars'),
  );
});

test('the append guard rejects §21 material-shaped keys in the applicability payload', () => {
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: { channel: 'email', secret: 'abc' } as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('material-shaped keys can never appear in learning payloads'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        applicability: { channel: 'email', password: 'hunter2' } as unknown as LearningCreateInput['applicability'],
      }),
    throwsWith('material-shaped keys can never appear in learning payloads'),
  );
});

test('the append guard rejects malformed, duplicate and oversized reference arrays', () => {
  assert.throws(
    () => assertValidLearningCreate({ ...validCreateInput(), evidenceRefs: null as unknown as [] }),
    throwsWith('evidenceRefs: required'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({ ...validCreateInput(), evidenceRefs: ['not-a-uuid'] }),
    throwsWith('evidenceRefs[0]: must be a record id (uuid)'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({ ...validCreateInput(), evidenceRefs: [EVIDENCE_ID, EVIDENCE_ID] }),
    throwsWith('duplicate reference'),
  );
  assert.throws(
    () =>
      assertValidLearningCreate({
        ...validCreateInput(),
        experimentRefs: Array.from({ length: 51 }, () => EXPERIMENT_ID).map(
          (_value, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ),
      }),
    throwsWith('experimentRefs: at most 50 records may be cited'),
  );
});

test('confidence is a separate descriptive field: out-of-range and non-finite values are rejected', () => {
  for (const confidence of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => assertValidLearningCreate({ ...validCreateInput(), confidence }),
      throwsWith('confidence'),
    );
  }
  assert.doesNotThrow(() => assertValidLearningCreate({ ...validCreateInput(), confidence: 0 }));
  assert.doesNotThrow(() => assertValidLearningCreate({ ...validCreateInput(), confidence: 1 }));
});

// ---------------------------------------------------------------------------
// The relationship-input guard
// ---------------------------------------------------------------------------

test('the relationship guard accepts the three legal shapes and rejects unknown kinds', () => {
  assert.doesNotThrow(() =>
    assertValidLearningRelationshipInput(LEARNING_A, { kind: 'contradicts', toLearningId: LEARNING_B }),
  );
  assert.doesNotThrow(() =>
    assertValidLearningRelationshipInput(LEARNING_A, { kind: 'supersedes', toLearningId: LEARNING_B }),
  );
  assert.doesNotThrow(() =>
    assertValidLearningRelationshipInput(LEARNING_A, { kind: 'retires', toLearningId: null }),
  );
  assert.throws(
    () =>
      assertValidLearningRelationshipInput(LEARNING_A, {
        kind: 'replaces' as unknown as 'contradicts',
        toLearningId: LEARNING_B,
      }),
    throwsWith('unknown relationship kind'),
  );
});

test('contradiction/supersession REQUIRE the later learning; retirement FORBIDS it', () => {
  for (const kind of ['contradicts', 'supersedes'] as const) {
    assert.throws(
      () => assertValidLearningRelationshipInput(LEARNING_A, { kind, toLearningId: null }),
      throwsWith('toLearningId: required for a contradiction or supersession'),
    );
    assert.throws(
      () =>
        assertValidLearningRelationshipInput(LEARNING_A, {
          kind,
          toLearningId: 'not-a-uuid',
        }),
      throwsWith('toLearningId: must be a learning id (uuid)'),
    );
  }
  assert.throws(
    () =>
      assertValidLearningRelationshipInput(LEARNING_A, {
        kind: 'retires',
        toLearningId: LEARNING_B,
      }),
    throwsWith('toLearningId: must be absent for a retirement'),
  );
});

test('a learning cannot contradict, supersede or retire itself', () => {
  for (const kind of ['contradicts', 'supersedes'] as const) {
    assert.throws(
      () => assertValidLearningRelationshipInput(LEARNING_A, { kind, toLearningId: LEARNING_A }),
      throwsWith('a learning cannot contradict, supersede or retire itself'),
    );
  }
});

// ---------------------------------------------------------------------------
// The provenance guard (server-derived, fail closed)
// ---------------------------------------------------------------------------

test('the provenance guard fails closed on incomplete server-derived provenance', () => {
  for (const patch of [
    { actor: '' },
    { recordedVia: '' },
    { recordedVia: 'x'.repeat(101) },
    { correlationId: '' },
    { causationId: '' },
  ] as const) {
    assert.throws(
      () => assertValidLearningProvenance({ ...VALID_PROVENANCE, ...patch }),
      throwsWith('provenance'),
    );
  }
  assert.doesNotThrow(() => assertValidLearningProvenance(VALID_PROVENANCE));
  assert.doesNotThrow(() =>
    assertValidLearningProvenance({ ...VALID_PROVENANCE, causationId: 'job:42' }),
  );
});

// ---------------------------------------------------------------------------
// DB fence/trigger classification
// ---------------------------------------------------------------------------

test('classifyLearningWriteConflict converges the migration 027 fences and triggers to domain classes', () => {
  // The unique-violation fence shape (pg attaches the constraint name).
  assert.equal(
    classifyLearningWriteConflict({
      code: '23505',
      constraint: 'learning_supersession_fence',
      message: 'duplicate key value violates unique constraint "learning_supersession_fence"',
    }),
    'supersession-fence',
  );
  assert.equal(
    classifyLearningWriteConflict({
      code: '23505',
      constraint: 'learning_retirement_fence',
      message: 'duplicate key value violates unique constraint "learning_retirement_fence"',
    }),
    'retirement-fence',
  );
  // The trigger shapes (message fragments).
  assert.equal(
    classifyLearningWriteConflict(new Error('learning X is already superseded — its history is terminal')),
    'relationship-terminal',
  );
  assert.equal(
    classifyLearningWriteConflict(
      new Error('learning X of another client cannot be linked — cross-tenant learning relationships are rejected'),
    ),
    'relationship-cross-tenant',
  );
  assert.equal(
    classifyLearningWriteConflict(new Error('cross-tenant evidence linkage is rejected')),
    'refs-cross-tenant',
  );
  assert.equal(
    classifyLearningWriteConflict(new Error('cross-tenant experiment linkage is rejected')),
    'refs-cross-tenant',
  );
  assert.equal(
    classifyLearningWriteConflict(new Error('the workspace scope cannot cross the Client boundary')),
    'workspace-scope',
  );
  // Unrelated errors propagate untouched.
  assert.equal(classifyLearningWriteConflict(new Error('something else')), null);
  assert.equal(classifyLearningWriteConflict(undefined), null);
  // A fence violation WITHOUT the unique code is not a fence (never
  // over-classify).
  assert.equal(
    classifyLearningWriteConflict(new Error('learning_supersession_fence')),
    null,
  );
});

// ---------------------------------------------------------------------------
// The canonical owner-context composer
// ---------------------------------------------------------------------------

function learningFixture(): LearningRecord {
  return {
    learningId: LEARNING_A,
    clientId: '00000000-0000-4000-8000-0000000000c1',
    workspaceId: null,
    statement: 'A 5-touch onboarding email sequence increases activation.',
    applicability: { channel: 'email', cohort: 'new_accounts' },
    evidenceRefs: [EVIDENCE_ID],
    experimentRefs: [EXPERIMENT_ID],
    confidence: 0.82,
    status: 'active',
    supersededBy: null,
    provenance: {
      actor: VALID_PROVENANCE.actor,
      recordedVia: 'api',
      correlationId: 'corr-1',
      causationId: null,
      recordedAt: '2026-03-01T10:00:00.000Z',
    },
  };
}

const CLIENT_OWNERSHIP: LearningsClientOwnershipSnapshot = {
  scope: {
    kind: 'client',
    agencyId: '00000000-0000-4000-8000-0000000000g1',
    clientId: '00000000-0000-4000-8000-0000000000c1',
  },
  client: {
    clientId: '00000000-0000-4000-8000-0000000000c1',
    agencyId: '00000000-0000-4000-8000-0000000000g1',
    status: 'active',
  },
};

const WORKSPACE_OWNERSHIP: LearningsWorkspaceOwnershipSnapshot = {
  workspace: {
    workspaceId: '00000000-0000-4000-8000-0000000000w1',
    clientId: '00000000-0000-4000-8000-0000000000c1',
    status: 'active',
  },
};

test('composeLearningOwnerContext derives the scope from CLIENT OWNERSHIP and the record only — never caller input', () => {
  const context = composeLearningOwnerContext(
    learningFixture(),
    CLIENT_OWNERSHIP,
    null,
    '2026-03-01T11:00:00.000Z',
  );
  assert.equal(context.scope.kind, 'learning');
  assert.equal(context.scope.agencyId, CLIENT_OWNERSHIP.scope.agencyId);
  assert.equal(context.scope.clientId, learningFixture().clientId);
  assert.equal(context.scope.workspaceId, null);
  assert.equal(context.scope.learningId, learningFixture().learningId);
  assert.deepEqual(context.learning, learningFixture());
  assert.deepEqual(context.clientOwnership, CLIENT_OWNERSHIP);
  assert.equal(context.workspace, null);
  assert.equal(context.resolvedAt, '2026-03-01T11:00:00.000Z');
});

test('composeLearningOwnerContext carries the Workspace snapshot for workspace-scoped learnings', () => {
  const scoped: LearningRecord = {
    ...learningFixture(),
    workspaceId: WORKSPACE_OWNERSHIP.workspace.workspaceId,
  };
  const context = composeLearningOwnerContext(
    scoped,
    CLIENT_OWNERSHIP,
    WORKSPACE_OWNERSHIP,
    '2026-03-01T11:00:00.000Z',
  );
  assert.equal(context.scope.workspaceId, WORKSPACE_OWNERSHIP.workspace.workspaceId);
  assert.deepEqual(context.workspace, WORKSPACE_OWNERSHIP);
});

test('composeLearningOwnerContext is pure: identical inputs compose identical outputs', () => {
  const first: LearningOwnerContext = composeLearningOwnerContext(
    learningFixture(),
    CLIENT_OWNERSHIP,
    null,
    '2026-03-01T11:00:00.000Z',
  );
  const second: LearningOwnerContext = composeLearningOwnerContext(
    learningFixture(),
    CLIENT_OWNERSHIP,
    null,
    '2026-03-01T11:00:00.000Z',
  );
  assert.deepEqual(first, second);
});
