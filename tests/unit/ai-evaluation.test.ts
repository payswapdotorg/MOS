/**
 * MKT-019 unit tests — the evaluation-framework contract types, input
 * guards, built-in deterministic evaluators, engine resolution and the
 * §12 result-payload guard (pure, no DB).
 *
 * Proofs:
 *   - the input guards REJECT provider/model/credential-shaped keys (the
 *     provider-neutrality discipline carried from MKT-017/018);
 *   - the input guards REJECT business-outcome-shaped keys (AI-AC-08 —
 *     evaluation is independent of business-outcome measurement);
 *   - the evaluator-selection and outcome fields are FORBIDDEN evaluation
 *     request keys (the request is derived from the TaskProfile contract;
 *     outcomes are evaluator-computed — never caller fabrications);
 *   - the review-request guards reject lifecycle/decision fields on
 *     create (the decision is decideReview's, never the caller's);
 *   - the lifecycle tables (evaluator, review request) encode the frozen
 *     single-edge terminal state machines;
 *   - the built-in evaluators behave deterministically per kind;
 *   - the §12 payload guard rejects invalid verdict/score/dimension/
 *     evidence/uncertainty shapes;
 *   - runEvaluators throws a ConflictError when a TaskProfile's evaluator
 *     contract has no implementation (never a silent partial evaluation).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVALUATION_FORBIDDEN_INPUT_KEYS,
  EVALUATION_VERDICTS,
  EVALUATOR_KINDS,
  EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  EVALUATOR_TRANSITIONS,
  REVIEW_REQUEST_DECISIONS,
  REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS,
  REVIEW_REQUEST_STATES,
  REVIEW_REQUEST_TRANSITIONS,
  assertValidEvaluationInput,
  assertValidEvaluatorRegistrationInput,
  assertValidReviewDecisionInput,
  assertValidReviewRequestInput,
  isLegalEvaluatorTransition,
  isLegalReviewRequestTransition,
  BUILTIN_EVALUATOR_KINDS,
  assertValidEvaluationResultPayload,
  brandPolicyEvaluator,
  citationCoverageEvaluator,
  domainRubricEvaluator,
  humanReviewEvaluator,
  resolveEvaluatorEngine,
  runEvaluators,
  schemaValidityEvaluator,
  type EvaluationResultPayload,
  type EvaluatorRecord,
  type TaskProfileRecord,
} from '../../src/modules/ai-runtime/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';

function makeEvaluator(overrides: Partial<EvaluatorRecord> = {}): EvaluatorRecord {
  return {
    evaluatorRegistryId: UUID_1,
    evaluatorKey: 'brand-voice-rubric',
    displayName: 'Brand Voice Rubric',
    kind: 'domain-rubric',
    evaluatorVersion: 1,
    config: {},
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTaskProfile(overrides: Partial<TaskProfileRecord> = {}): TaskProfileRecord {
  return {
    taskProfileId: UUID_2,
    taskClass: 'copywriting.generate',
    qualityTarget: 'publication-ready',
    riskClass: 'medium',
    contextRequirements: { minInputTokens: 200, maxInputTokens: 8000 },
    latencyTargetMs: 30_000,
    maxCostPerInvocation: 0.25,
    privacyClass: 'internal',
    toolRequirements: ['web-search'],
    outputSchema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
    evaluatorIds: ['brand-voice-rubric'],
    escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
    workspaceId: UUID_2,
    clientId: UUID_2,
    agencyId: UUID_2,
    status: 'active',
    idempotencyKey: 'profile-1',
    createFingerprint: 'a'.repeat(64),
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function assertRejected(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof Error);
}

// ---------------------------------------------------------------------------
// Vocabularies + lifecycle tables
// ---------------------------------------------------------------------------

test('the §7 evaluator-kind vocabulary is closed and covers the frozen list', () => {
  assert.deepEqual([...EVALUATOR_KINDS], [
    'schema-validity',
    'factuality-grounding',
    'evidence-citation-coverage',
    'brand-policy-compliance',
    'domain-rubric',
    'human-review',
    'downstream-task-success',
  ]);
  // The built-ins cover the deterministic §7 kinds + the human-review hook.
  for (const kind of BUILTIN_EVALUATOR_KINDS) {
    assert.ok(EVALUATOR_KINDS.includes(kind as (typeof EVALUATOR_KINDS)[number]));
  }
  // The model-judge kinds deliberately have NO built-in (advisory engines).
  assert.ok(!BUILTIN_EVALUATOR_KINDS.includes('factuality-grounding'));
  assert.ok(!BUILTIN_EVALUATOR_KINDS.includes('downstream-task-success'));
});

test('the evaluator lifecycle is the single terminal edge active → retired', () => {
  assert.deepEqual(EVALUATOR_TRANSITIONS, { active: ['retired'], retired: [] });
  assert.equal(isLegalEvaluatorTransition('active', 'retired'), true);
  assert.equal(isLegalEvaluatorTransition('retired', 'active'), false);
});

test('the review-request lifecycle is pending → approved/rejected/dismissed, all terminal', () => {
  assert.deepEqual(REVIEW_REQUEST_STATES, ['pending', 'approved', 'rejected', 'dismissed']);
  assert.deepEqual(REVIEW_REQUEST_TRANSITIONS, {
    pending: ['approved', 'rejected', 'dismissed'],
    approved: [],
    rejected: [],
    dismissed: [],
  });
  assert.equal(isLegalReviewRequestTransition('pending', 'approved'), true);
  assert.equal(isLegalReviewRequestTransition('pending', 'rejected'), true);
  assert.equal(isLegalReviewRequestTransition('pending', 'dismissed'), true);
  assert.equal(isLegalReviewRequestTransition('approved', 'pending'), false);
  assert.equal(isLegalReviewRequestTransition('rejected', 'approved'), false);
  assert.deepEqual([...REVIEW_REQUEST_DECISIONS], ['approve', 'reject', 'dismiss']);
});

test('the evaluation verdict vocabulary is pass/fail/unknown (frozen UNKNOWN semantics)', () => {
  assert.deepEqual([...EVALUATION_VERDICTS], ['pass', 'fail', 'unknown']);
});

// ---------------------------------------------------------------------------
// Input guards — provider-neutrality + AI-AC-08 business-outcome rejection
// ---------------------------------------------------------------------------

test('the evaluator-registration guard rejects provider/model/credential-shaped keys', () => {
  for (const forbidden of ['provider', 'providerLabel', 'model', 'modelKey', 'sdk', 'apiKey', 'credential', 'token', 'password']) {
    assertRejected(() =>
      assertValidEvaluatorRegistrationInput({
        evaluatorKey: 'brand-voice-rubric',
        displayName: 'Brand Voice Rubric',
        kind: 'domain-rubric',
        evaluatorVersion: 1,
        config: {},
        ...{ [forbidden]: 'x' },
      } as never),
    );
  }
  // A clean registration passes.
  assertValidEvaluatorRegistrationInput({
    evaluatorKey: 'brand-voice-rubric',
    displayName: 'Brand Voice Rubric',
    kind: 'domain-rubric',
    evaluatorVersion: 1,
    config: { dimensions: [{ field: 'wordCount', min: 10, max: 80 }] },
  });
});

test('the evaluator-registration guard rejects business-outcome-shaped keys (AI-AC-08)', () => {
  for (const forbidden of ['metricId', 'kpiId', 'experimentId', 'experimentOutcomeId', 'businessOutcomeId', 'lift']) {
    assert.ok(EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
    assertRejected(() =>
      assertValidEvaluatorRegistrationInput({
        evaluatorKey: 'brand-voice-rubric',
        displayName: 'Brand Voice Rubric',
        kind: 'domain-rubric',
        evaluatorVersion: 1,
        config: {},
        ...{ [forbidden]: 'x' },
      } as never),
    );
  }
});

test('the evaluation-request guard validates references and bounds', () => {
  assertValidEvaluationInput({
    taskProfileId: UUID_1,
    executionId: null,
    usageId: null,
    output: { headline: 'ok' },
    adapterError: null,
    idempotencyKey: 'eval-1',
  });
  assertValidEvaluationInput({
    taskProfileId: UUID_1,
    executionId: UUID_2,
    usageId: UUID_2,
    output: null,
    adapterError: 'adapter failed',
    idempotencyKey: 'eval-2',
  });
  // Non-UUID reference ids are rejected.
  assertRejected(() =>
    assertValidEvaluationInput({
      taskProfileId: 'not-a-uuid',
      executionId: null,
      usageId: null,
      output: null,
      adapterError: null,
      idempotencyKey: 'eval-3',
    }),
  );
  // The idempotency key is bounded.
  assertRejected(() =>
    assertValidEvaluationInput({
      taskProfileId: UUID_1,
      executionId: null,
      usageId: null,
      output: null,
      adapterError: null,
      idempotencyKey: '',
    }),
  );
});

test('the evaluation forbidden-input contract rejects evaluator selection, outcome fabrication, business outcomes and credentials', () => {
  // The request can never select evaluators (derived from the profile).
  for (const forbidden of ['evaluatorIds', 'evaluatorId', 'evaluatorKey', 'evaluatorVersion']) {
    assert.ok(EVALUATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  // The request can never fabricate outcomes.
  for (const forbidden of ['verdict', 'score', 'dimensions', 'evidenceRefs', 'uncertaintyOrLimitations']) {
    assert.ok(EVALUATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  // Business-outcome-shaped keys are rejected (AI-AC-08).
  for (const forbidden of ['metricId', 'kpiId', 'metricObservationId', 'experimentId', 'experimentOutcomeId', 'businessOutcomeId', 'businessOutcome', 'lift', 'conversionRate']) {
    assert.ok(EVALUATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  // Credential-shaped keys are rejected.
  for (const forbidden of ['credential', 'secretHandle', 'apiKey', 'api_key', 'token', 'password']) {
    assert.ok(EVALUATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  // Provenance keys are rejected (server-derived, never caller-supplied).
  for (const forbidden of ['evaluationId', 'workspaceId', 'correlationId', 'createdBy', 'createdAt']) {
    assert.ok(EVALUATION_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
});

test('the review-request guards reject lifecycle/decision/provenance/business-outcome/credential keys', () => {
  // Decision fields can NEVER be create inputs.
  for (const forbidden of ['state', 'decidedBy', 'decidedAt', 'decisionNote']) {
    assert.ok(REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  for (const forbidden of ['metricId', 'kpiId', 'experimentId', 'businessOutcomeId', 'lift', 'apiKey', 'token']) {
    assert.ok(REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS.includes(forbidden as never));
  }
  // Clean create inputs pass.
  assertValidReviewRequestInput({
    executionId: null,
    evaluationId: null,
    reason: 'evaluator reported unknown — human review required',
    idempotencyKey: 'review-1',
  });
  // The reason is required and bounded.
  assertRejected(() =>
    assertValidReviewRequestInput({
      executionId: null,
      evaluationId: null,
      reason: '',
      idempotencyKey: 'review-2',
    }),
  );
  // The decision vocabulary is closed.
  assertValidReviewDecisionInput({ decision: 'approve', note: 'looks good' });
  assertRejected(() => assertValidReviewDecisionInput({ decision: 'escalate', note: '' }));
});

// ---------------------------------------------------------------------------
// Built-in evaluators (deterministic per kind)
// ---------------------------------------------------------------------------

test('schemaValidityEvaluator: a schema-conforming output passes; a missing required field fails; no output fails', async () => {
  const profile = makeTaskProfile();
  const pass = await schemaValidityEvaluator({
    evaluator: makeEvaluator({ kind: 'schema-validity' }),
    taskProfile: profile,
    output: { headline: 'Summer Sale' },
    adapterError: null,
  });
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.score, 1);
  assert.equal(pass.dimensions.length, 1);
  assert.equal(pass.dimensions[0]!.verdict, 'pass');

  const fail = await schemaValidityEvaluator({
    evaluator: makeEvaluator({ kind: 'schema-validity' }),
    taskProfile: profile,
    output: { wrongField: 'x' },
    adapterError: null,
  });
  assert.equal(fail.verdict, 'fail');
  assert.equal(fail.score, 0);
  assert.equal(fail.dimensions[0]!.notes, "output missing required field 'headline'");

  const noOutput = await schemaValidityEvaluator({
    evaluator: makeEvaluator({ kind: 'schema-validity' }),
    taskProfile: profile,
    output: null,
    adapterError: null,
  });
  assert.equal(noOutput.verdict, 'fail');
  assert.equal(noOutput.score, 0);
});

test('citationCoverageEvaluator: coverage is the cited∩expected ratio; missing config is unknown; citations are recorded as evidenceRefs', async () => {
  const evaluator = makeEvaluator({
    kind: 'evidence-citation-coverage',
    evaluatorKey: 'citation-coverage',
    config: { expectedEvidenceRefs: [UUID_1, UUID_2], coverageThreshold: 1 },
  });
  const full = await citationCoverageEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', evidenceRefs: [UUID_1, UUID_2] },
    adapterError: null,
  });
  assert.equal(full.verdict, 'pass');
  assert.equal(full.score, 1);
  assert.deepEqual([...full.evidenceRefs], [UUID_1, UUID_2]);

  const half = await citationCoverageEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', evidenceRefs: [UUID_1] },
    adapterError: null,
  });
  assert.equal(half.verdict, 'fail');
  assert.equal(half.score, 0.5);

  // A threshold below the coverage flips the verdict.
  const lenient = makeEvaluator({
    kind: 'evidence-citation-coverage',
    evaluatorKey: 'citation-coverage',
    config: { expectedEvidenceRefs: [UUID_1, UUID_2], coverageThreshold: 0.5 },
  });
  const halfPass = await citationCoverageEvaluator({
    evaluator: lenient,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', evidenceRefs: [UUID_1] },
    adapterError: null,
  });
  assert.equal(halfPass.verdict, 'pass');
  assert.equal(halfPass.score, 0.5);

  // Misconfiguration (no expected refs declared) is UNKNOWN — never a
  // fabricated pass.
  const misconfigured = makeEvaluator({ kind: 'evidence-citation-coverage', config: {} });
  const unknown = await citationCoverageEvaluator({
    evaluator: misconfigured,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x' },
    adapterError: null,
  });
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.score, null);
  assert.notEqual(unknown.uncertaintyOrLimitations, '');
});

test('brandPolicyEvaluator: denied terms fail; clean text passes; no declared terms list is unknown', async () => {
  const evaluator = makeEvaluator({
    kind: 'brand-policy-compliance',
    config: { deniedTerms: ['competitor-brand', 'superlative-best'] },
  });
  const fail = await brandPolicyEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'better than Competitor-Brand' },
    adapterError: null,
  });
  assert.equal(fail.verdict, 'fail');
  assert.equal(fail.score, 0);
  assert.ok(fail.dimensions[0]!.notes.includes('competitor-brand'));

  const pass = await brandPolicyEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'Summer Sale — save big' },
    adapterError: null,
  });
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.score, 1);

  const misconfigured = makeEvaluator({ kind: 'brand-policy-compliance', config: {} });
  const unknown = await brandPolicyEvaluator({
    evaluator: misconfigured,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x' },
    adapterError: null,
  });
  assert.equal(unknown.verdict, 'unknown');
});

test('domainRubricEvaluator: numeric bounds per dimension; the aggregate score meets the threshold', async () => {
  const evaluator = makeEvaluator({
    kind: 'domain-rubric',
    config: {
      dimensions: [
        { field: 'wordCount', min: 10, max: 80 },
        { field: 'confidence', min: 0.5, max: 1 },
      ],
      passThreshold: 1,
    },
  });
  const pass = await domainRubricEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', wordCount: 42, confidence: 0.9 },
    adapterError: null,
  });
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.score, 1);
  assert.equal(pass.dimensions.length, 2);

  const half = await domainRubricEvaluator({
    evaluator,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', wordCount: 500, confidence: 0.9 },
    adapterError: null,
  });
  assert.equal(half.verdict, 'fail');
  assert.equal(half.score, 0.5);
  assert.equal(half.dimensions[0]!.verdict, 'fail');
  assert.equal(half.dimensions[1]!.verdict, 'pass');

  // A threshold below the score flips the verdict.
  const lenient = makeEvaluator({
    kind: 'domain-rubric',
    config: {
      dimensions: [
        { field: 'wordCount', min: 10, max: 80 },
        { field: 'confidence', min: 0.5, max: 1 },
      ],
      passThreshold: 0.5,
    },
  });
  const halfPass = await domainRubricEvaluator({
    evaluator: lenient,
    taskProfile: makeTaskProfile(),
    output: { headline: 'x', wordCount: 500, confidence: 0.9 },
    adapterError: null,
  });
  assert.equal(halfPass.verdict, 'pass');
});

test('humanReviewEvaluator: the machine never decides — the outcome is unknown (the review hook decides)', async () => {
  const result = await humanReviewEvaluator({
    evaluator: makeEvaluator({ kind: 'human-review' }),
    taskProfile: makeTaskProfile(),
    output: { headline: 'x' },
    adapterError: null,
  });
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.score, null);
  assert.ok(result.uncertaintyOrLimitations.includes('human review pending'));
});

// ---------------------------------------------------------------------------
// Engine resolution + runEvaluators
// ---------------------------------------------------------------------------

test('resolveEvaluatorEngine: caller engine overrides the built-in; the built-in serves its kind; model-judge kinds REQUIRE a caller engine', () => {
  const schemaEvaluator = makeEvaluator({ kind: 'schema-validity' });
  assert.equal(resolveEvaluatorEngine(schemaEvaluator), schemaValidityEvaluator);
  const humanEvaluator = makeEvaluator({ kind: 'human-review' });
  assert.equal(resolveEvaluatorEngine(humanEvaluator), humanReviewEvaluator);
  // Model-judge kinds have NO built-in.
  const judge = makeEvaluator({ kind: 'factuality-grounding', evaluatorKey: 'factuality-judge' });
  assert.equal(resolveEvaluatorEngine(judge), null);
  // A caller engine takes precedence.
  const custom = async (): Promise<EvaluationResultPayload> => ({
    verdict: 'pass',
    score: 1,
    dimensions: [],
    evidenceRefs: [],
    uncertaintyOrLimitations: '',
  });
  assert.equal(resolveEvaluatorEngine(schemaEvaluator, { 'brand-voice-rubric': custom }), custom);
});

test('runEvaluators: a TaskProfile contract with an unimplementable evaluator is a ConflictError (never silent partial evaluation)', async () => {
  const profile = makeTaskProfile({ evaluatorIds: ['factuality-judge'] });
  await assert.rejects(
    runEvaluators({
      taskProfile: profile,
      evaluators: [makeEvaluator({ kind: 'factuality-grounding', evaluatorKey: 'factuality-judge' })],
      output: { headline: 'x' },
      adapterError: null,
    }),
    /no evaluator implementation available/,
  );
});

test('runEvaluators: the caller-supplied engine result is guarded (invalid §12 payloads are rejected)', async () => {
  const profile = makeTaskProfile({ evaluatorIds: ['factuality-judge'] });
  const judge = makeEvaluator({ kind: 'factuality-grounding', evaluatorKey: 'factuality-judge' });
  await assert.rejects(
    runEvaluators({
      taskProfile: profile,
      evaluators: [judge],
      output: { headline: 'x' },
      adapterError: null,
      engines: {
        'factuality-judge': async () =>
          ({
            verdict: 'excellent', // not in the vocabulary
            score: 1,
            dimensions: [],
            evidenceRefs: [],
            uncertaintyOrLimitations: '',
          }) as unknown as EvaluationResultPayload,
      },
    }),
    /verdict/,
  );
  await assert.rejects(
    runEvaluators({
      taskProfile: profile,
      evaluators: [judge],
      output: { headline: 'x' },
      adapterError: null,
      engines: {
        'factuality-judge': async () =>
          ({
            verdict: 'pass',
            score: 1.5, // out of bounds
            dimensions: [],
            evidenceRefs: [],
            uncertaintyOrLimitations: '',
          }) as unknown as EvaluationResultPayload,
      },
    }),
    /score/,
  );
});

// ---------------------------------------------------------------------------
// The §12 result-payload guard
// ---------------------------------------------------------------------------

test('assertValidEvaluationResultPayload accepts the §12 shape and rejects invalid shapes', () => {
  assertValidEvaluationResultPayload({
    verdict: 'pass',
    score: 0.87,
    dimensions: [{ dimension: 'grounding', verdict: 'pass', score: 0.9, notes: 'cited' }],
    evidenceRefs: [UUID_1],
    uncertaintyOrLimitations: 'none material',
  });
  assertValidEvaluationResultPayload({
    verdict: 'unknown',
    score: null,
    dimensions: [],
    evidenceRefs: [],
    uncertaintyOrLimitations: '',
  });
  assertRejected(() =>
    assertValidEvaluationResultPayload({
      verdict: 'maybe' as never,
      score: null,
      dimensions: [],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    }),
  );
  assertRejected(() =>
    assertValidEvaluationResultPayload({
      verdict: 'pass',
      score: -0.1,
      dimensions: [],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    }),
  );
  assertRejected(() =>
    assertValidEvaluationResultPayload({
      verdict: 'pass',
      score: 1,
      dimensions: [{ dimension: 'x', verdict: 'nope' as never, score: null, notes: '' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    }),
  );
  assertRejected(() =>
    assertValidEvaluationResultPayload({
      verdict: 'pass',
      score: 1,
      dimensions: [],
      evidenceRefs: [''],
      uncertaintyOrLimitations: '',
    }),
  );
  assertRejected(() =>
    assertValidEvaluationResultPayload({
      verdict: 'pass',
      score: 1,
      dimensions: [],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'x'.repeat(2001),
    }),
  );
});
