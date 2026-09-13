/**
 * MKT-019 EVALUATOR REGRESSION MATRIX — the frozen scenario suite the work
 * item requires ("a frozen scenario suite (unit/integration) that runs a
 * fixed set of evaluator configurations against fixed inputs and asserts
 * stable recorded outcomes — so future evaluator changes that alter
 * outcomes are caught").
 *
 * Each row pins ONE evaluator configuration (the registry entry as data)
 * against ONE fixed input (the output under evaluation) and asserts the
 * FULL recorded outcome: the verdict, the score, every rubric dimension
 * (label + verdict + score + notes) and the recorded evidence refs. Any
 * future change to an evaluator's computation that alters any pinned
 * value fails this suite — outcome-altering evaluator changes must be a
 * deliberate, reviewed decision (a NEW evaluator version/kind), never a
 * silent drift.
 *
 * Scenario families (spec/ai-runtime-and-routing.md §7 + §12 + the frozen
 * UNKNOWN semantics):
 *   A. schema validity         — pass / fail (missing field) / fail (wrong type) / fail (no output) / fail (adapter error)
 *   B. evidence citation       — full coverage / partial coverage (fail at threshold 1) / partial (pass at 0.5) / misconfigured (unknown) / no output (unknown)
 *   C. brand-policy compliance — clean pass / denied-term fail (case-insensitive) / empty denied terms (vacuous pass) / misconfigured (unknown)
 *   D. domain rubric           — all dimensions in bounds / one out of bounds / threshold flip / non-numeric field / misconfigured (unknown)
 *   E. human review            — always unknown (the machine never decides)
 *   F. model-judge engines     — a caller-supplied engine's §12 payload passes through verbatim (advisory evidence, recorded as produced)
 *   G. multi-evaluator run     — the composite evaluation request derived from a TaskProfile's evaluator contract (runEvaluators)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runEvaluators,
  type EvaluationResultPayload,
  type EvaluatorRecord,
  type TaskProfileRecord,
} from '../../src/modules/ai-runtime/public.ts';

// ---------------------------------------------------------------------------
// Frozen fixtures (FIXED — changing these changes the recorded expectations)
// ---------------------------------------------------------------------------

const UUID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const UUID_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const PROFILE: TaskProfileRecord = {
  taskProfileId: UUID_A,
  taskClass: 'copywriting.generate',
  qualityTarget: 'publication-ready',
  riskClass: 'medium',
  contextRequirements: { minInputTokens: 200, maxInputTokens: 8000 },
  latencyTargetMs: 30_000,
  maxCostPerInvocation: 0.25,
  privacyClass: 'internal',
  toolRequirements: ['web-search'],
  outputSchema: {
    type: 'object',
    properties: { headline: { type: 'string' }, wordCount: { type: 'number' } },
    required: ['headline'],
  },
  evaluatorIds: ['schema-validity', 'citation-coverage', 'brand-policy', 'domain-rubric'],
  escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
  workspaceId: UUID_A,
  clientId: UUID_A,
  agencyId: UUID_A,
  status: 'active',
  idempotencyKey: 'matrix-profile-1',
  createFingerprint: 'a'.repeat(64),
  createdBy: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function evaluator(overrides: Partial<EvaluatorRecord>): EvaluatorRecord {
  return {
    evaluatorRegistryId: UUID_B,
    evaluatorKey: 'matrix-evaluator',
    displayName: 'Matrix Evaluator',
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

const SCHEMA_EVALUATOR = evaluator({ kind: 'schema-validity', evaluatorKey: 'schema-validity' });
const CITATION_EVALUATOR = evaluator({
  kind: 'evidence-citation-coverage',
  evaluatorKey: 'citation-coverage',
  config: { expectedEvidenceRefs: [UUID_A, UUID_B], coverageThreshold: 1 },
});
const CITATION_LENIENT = evaluator({
  kind: 'evidence-citation-coverage',
  evaluatorKey: 'citation-coverage-lenient',
  config: { expectedEvidenceRefs: [UUID_A, UUID_B], coverageThreshold: 0.5 },
});
const BRAND_EVALUATOR = evaluator({
  kind: 'brand-policy-compliance',
  evaluatorKey: 'brand-policy',
  config: { deniedTerms: ['competitor-x', 'best-in-class'] },
});
const BRAND_EMPTY_TERMS = evaluator({
  kind: 'brand-policy-compliance',
  evaluatorKey: 'brand-policy-empty',
  config: { deniedTerms: [] },
});
const RUBRIC_EVALUATOR = evaluator({
  kind: 'domain-rubric',
  evaluatorKey: 'domain-rubric',
  config: {
    dimensions: [
      { field: 'wordCount', min: 10, max: 80 },
      { field: 'confidence', min: 0.5, max: 1 },
    ],
    passThreshold: 1,
  },
});
const RUBRIC_LENIENT = evaluator({
  kind: 'domain-rubric',
  evaluatorKey: 'domain-rubric-lenient',
  config: {
    dimensions: [
      { field: 'wordCount', min: 10, max: 80 },
      { field: 'confidence', min: 0.5, max: 1 },
    ],
    passThreshold: 0.5,
  },
});
const HUMAN_EVALUATOR = evaluator({ kind: 'human-review', evaluatorKey: 'human-review' });
const MISCONFIGURED_CITATION = evaluator({ kind: 'evidence-citation-coverage', evaluatorKey: 'citation-broken', config: {} });
const MISCONFIGURED_BRAND = evaluator({ kind: 'brand-policy-compliance', evaluatorKey: 'brand-broken', config: {} });
const MISCONFIGURED_RUBRIC = evaluator({ kind: 'domain-rubric', evaluatorKey: 'rubric-broken', config: {} });

interface MatrixRow {
  readonly name: string;
  readonly evaluator: EvaluatorRecord;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly adapterError: string | null;
  readonly expected: EvaluationResultPayload;
}

/** The matrix: 21 pinned scenarios. */
const matrix: readonly MatrixRow[] = [
  // A. schema validity ------------------------------------------------------
  {
    name: 'A1 schema-validity: conforming output passes',
    evaluator: SCHEMA_EVALUATOR,
    output: { headline: 'Summer Sale', wordCount: 42 },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 1,
      dimensions: [{ dimension: 'schema-validity', verdict: 'pass', score: 1, notes: 'output satisfies the declared output schema' }],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'top-level required-field and type validation only (a JSON Schema subset — deep/nested validation is a refinement, not a frozen contract)',
    },
  },
  {
    name: 'A2 schema-validity: missing required field fails',
    evaluator: SCHEMA_EVALUATOR,
    output: { wordCount: 42 },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0,
      dimensions: [{ dimension: 'schema-validity', verdict: 'fail', score: 0, notes: "output missing required field 'headline'" }],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    },
  },
  {
    name: 'A3 schema-validity: wrong field type fails',
    evaluator: SCHEMA_EVALUATOR,
    output: { headline: 123 },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0,
      dimensions: [{ dimension: 'schema-validity', verdict: 'fail', score: 0, notes: "output field 'headline' must be string" }],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    },
  },
  {
    name: 'A4 schema-validity: no output fails (an output that fails schema validation is never accepted)',
    evaluator: SCHEMA_EVALUATOR,
    output: null,
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0,
      dimensions: [{ dimension: 'schema-validity', verdict: 'fail', score: 0, notes: 'no output to validate' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'schema validity could not be proven: the invocation produced no output',
    },
  },
  {
    name: 'A5 schema-validity: adapter error fails',
    evaluator: SCHEMA_EVALUATOR,
    output: null,
    adapterError: 'provider timeout after 5000ms',
    expected: {
      verdict: 'fail',
      score: 0,
      dimensions: [{ dimension: 'schema-validity', verdict: 'fail', score: 0, notes: 'adapter error: provider timeout after 5000ms' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'schema validity could not be proven: the invocation reported an adapter error',
    },
  },
  // B. evidence citation coverage -------------------------------------------
  {
    name: 'B1 citation-coverage: full coverage passes',
    evaluator: CITATION_EVALUATOR,
    output: { headline: 'x', evidenceRefs: [UUID_A, UUID_B] },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 1,
      dimensions: [{ dimension: 'citation-coverage', verdict: 'pass', score: 1, notes: '2 of 2 expected evidence references cited (threshold 1)' }],
      evidenceRefs: [UUID_A, UUID_B],
      uncertaintyOrLimitations:
        'citation coverage measures WHICH expected references were cited, not the factual grounding of the cited content',
    },
  },
  {
    name: 'B2 citation-coverage: half coverage fails at threshold 1',
    evaluator: CITATION_EVALUATOR,
    output: { headline: 'x', evidenceRefs: [UUID_A] },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0.5,
      dimensions: [{ dimension: 'citation-coverage', verdict: 'fail', score: 0.5, notes: '1 of 2 expected evidence references cited (threshold 1)' }],
      evidenceRefs: [UUID_A],
      uncertaintyOrLimitations:
        'citation coverage measures WHICH expected references were cited, not the factual grounding of the cited content',
    },
  },
  {
    name: 'B3 citation-coverage: half coverage passes at threshold 0.5',
    evaluator: CITATION_LENIENT,
    output: { headline: 'x', evidenceRefs: [UUID_A] },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 0.5,
      dimensions: [{ dimension: 'citation-coverage', verdict: 'pass', score: 0.5, notes: '1 of 2 expected evidence references cited (threshold 0.5)' }],
      evidenceRefs: [UUID_A],
      uncertaintyOrLimitations:
        'citation coverage measures WHICH expected references were cited, not the factual grounding of the cited content',
    },
  },
  {
    name: 'B4 citation-coverage: undeclared expected refs are UNKNOWN (never a fabricated pass)',
    evaluator: MISCONFIGURED_CITATION,
    output: { headline: 'x', evidenceRefs: [UUID_A] },
    adapterError: null,
    expected: {
      verdict: 'unknown',
      score: null,
      dimensions: [{ dimension: 'citation-coverage', verdict: 'unknown', score: null, notes: 'expectedEvidenceRefs not declared in the evaluator config' }],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'citation coverage could not be proven: the evaluator config declares no expected evidence references',
    },
  },
  {
    name: 'B5 citation-coverage: no output is UNKNOWN',
    evaluator: CITATION_EVALUATOR,
    output: null,
    adapterError: null,
    expected: {
      verdict: 'unknown',
      score: null,
      dimensions: [{ dimension: 'citation-coverage', verdict: 'unknown', score: null, notes: 'no output to evaluate' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'citation coverage could not be proven: the invocation produced no output',
    },
  },
  // C. brand-policy compliance ----------------------------------------------
  {
    name: 'C1 brand-policy: clean text passes',
    evaluator: BRAND_EVALUATOR,
    output: { headline: 'Summer Sale — save big', body: 'Shop today' },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 1,
      dimensions: [{ dimension: 'brand-policy-compliance', verdict: 'pass', score: 1, notes: 'no denied term present in the output' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'term matching is literal (substring) — paraphrased or implied policy violations are not detected',
    },
  },
  {
    name: 'C2 brand-policy: denied term (case-insensitive, nested text) fails',
    evaluator: BRAND_EVALUATOR,
    output: { headline: 'Why we are BEST-IN-CLASS', body: 'better than competitor-x everywhere' },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0,
      dimensions: [{ dimension: 'brand-policy-compliance', verdict: 'fail', score: 0, notes: 'denied terms present: competitor-x, best-in-class' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'term matching is literal (substring) — paraphrased or implied policy violations are not detected',
    },
  },
  {
    name: 'C3 brand-policy: empty denied-terms list is a vacuous pass',
    evaluator: BRAND_EMPTY_TERMS,
    output: { headline: 'Anything goes' },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 1,
      dimensions: [{ dimension: 'brand-policy-compliance', verdict: 'pass', score: 1, notes: 'no denied terms declared — compliance is vacuous' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'term matching is literal (substring) — paraphrased or implied policy violations are not detected',
    },
  },
  {
    name: 'C4 brand-policy: undeclared denied-terms list is UNKNOWN',
    evaluator: MISCONFIGURED_BRAND,
    output: { headline: 'x' },
    adapterError: null,
    expected: {
      verdict: 'unknown',
      score: null,
      dimensions: [{ dimension: 'brand-policy-compliance', verdict: 'unknown', score: null, notes: 'deniedTerms not declared in the evaluator config' }],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'brand-policy compliance could not be proven: the evaluator config declares no denied-terms list',
    },
  },
  // D. domain rubric ---------------------------------------------------------
  {
    name: 'D1 domain-rubric: all dimensions in bounds pass',
    evaluator: RUBRIC_EVALUATOR,
    output: { headline: 'x', wordCount: 42, confidence: 0.75 },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 1,
      dimensions: [
        { dimension: 'rubric:wordCount', verdict: 'pass', score: 1, notes: 'value 42 against bounds [10, 80]' },
        { dimension: 'rubric:confidence', verdict: 'pass', score: 1, notes: 'value 0.75 against bounds [0.5, 1]' },
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'numeric bounds checking only — qualitative rubric dimensions are not machine-scored',
    },
  },
  {
    name: 'D2 domain-rubric: one dimension out of bounds fails at threshold 1',
    evaluator: RUBRIC_EVALUATOR,
    output: { headline: 'x', wordCount: 500, confidence: 0.75 },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0.5,
      dimensions: [
        { dimension: 'rubric:wordCount', verdict: 'fail', score: 0, notes: 'value 500 against bounds [10, 80]' },
        { dimension: 'rubric:confidence', verdict: 'pass', score: 1, notes: 'value 0.75 against bounds [0.5, 1]' },
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'numeric bounds checking only — qualitative rubric dimensions are not machine-scored',
    },
  },
  {
    name: 'D3 domain-rubric: half score passes at threshold 0.5',
    evaluator: RUBRIC_LENIENT,
    output: { headline: 'x', wordCount: 500, confidence: 0.75 },
    adapterError: null,
    expected: {
      verdict: 'pass',
      score: 0.5,
      dimensions: [
        { dimension: 'rubric:wordCount', verdict: 'fail', score: 0, notes: 'value 500 against bounds [10, 80]' },
        { dimension: 'rubric:confidence', verdict: 'pass', score: 1, notes: 'value 0.75 against bounds [0.5, 1]' },
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'numeric bounds checking only — qualitative rubric dimensions are not machine-scored',
    },
  },
  {
    name: 'D4 domain-rubric: a non-numeric field is a failing dimension',
    evaluator: RUBRIC_EVALUATOR,
    output: { headline: 'x', wordCount: 'many', confidence: 0.75 },
    adapterError: null,
    expected: {
      verdict: 'fail',
      score: 0.5,
      dimensions: [
        { dimension: 'rubric:wordCount', verdict: 'fail', score: 0, notes: 'field missing or non-numeric' },
        { dimension: 'rubric:confidence', verdict: 'pass', score: 1, notes: 'value 0.75 against bounds [0.5, 1]' },
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'numeric bounds checking only — qualitative rubric dimensions are not machine-scored',
    },
  },
  {
    name: 'D5 domain-rubric: undeclared dimensions are UNKNOWN',
    evaluator: MISCONFIGURED_RUBRIC,
    output: { headline: 'x', wordCount: 42 },
    adapterError: null,
    expected: {
      verdict: 'unknown',
      score: null,
      dimensions: [{ dimension: 'domain-rubric', verdict: 'unknown', score: null, notes: 'dimensions not declared in the evaluator config' }],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'domain rubric could not be proven: the evaluator config declares no numeric rubric dimensions',
    },
  },
  // E. human review ----------------------------------------------------------
  {
    name: 'E1 human-review: the machine never decides — always unknown',
    evaluator: HUMAN_EVALUATOR,
    output: { headline: 'x' },
    adapterError: null,
    expected: {
      verdict: 'unknown',
      score: null,
      dimensions: [{ dimension: 'human-review', verdict: 'unknown', score: null, notes: 'deferred to the human-review hook' }],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'human review pending — the machine cannot decide this evaluation; request a review and record the human outcome',
    },
  },
  // F. model-judge engine (advisory evidence — recorded verbatim) -----------
  {
    name: 'F1 model-judge engine: the §12 payload passes through verbatim',
    evaluator: evaluator({ kind: 'factuality-grounding', evaluatorKey: 'factuality-judge' }),
    output: { headline: 'Claims supported by cited sources' },
    adapterError: null,
    // The engine (below) is a fixed fixture; its payload is pinned here.
    expected: {
      verdict: 'pass',
      score: 0.83,
      dimensions: [
        { dimension: 'claim-grounding', verdict: 'pass', score: 0.83, notes: '5 of 6 claims grounded in the cited evidence' },
        { dimension: 'hallucination-scan', verdict: 'pass', score: null, notes: 'no unsupported factual claim detected' },
      ],
      evidenceRefs: [UUID_A],
      uncertaintyOrLimitations: 'model-judge advisory opinion — not unquestionable truth (implementation-contract §12)',
    },
  },
];

/** The fixed model-judge engine fixture (row F1). */
const FACTUALITY_JUDGE_ENGINE = async (): Promise<EvaluationResultPayload> => ({
  verdict: 'pass',
  score: 0.83,
  dimensions: [
    { dimension: 'claim-grounding', verdict: 'pass', score: 0.83, notes: '5 of 6 claims grounded in the cited evidence' },
    { dimension: 'hallucination-scan', verdict: 'pass', score: null, notes: 'no unsupported factual claim detected' },
  ],
  evidenceRefs: [UUID_A],
  uncertaintyOrLimitations: 'model-judge advisory opinion — not unquestionable truth (implementation-contract §12)',
});

async function runRow(row: MatrixRow): Promise<EvaluationResultPayload> {
  const engines =
    row.evaluator.kind === 'factuality-grounding'
      ? { [row.evaluator.evaluatorKey]: FACTUALITY_JUDGE_ENGINE }
      : undefined;
  const results = await runEvaluators({
    taskProfile: PROFILE,
    evaluators: [row.evaluator],
    output: row.output,
    adapterError: row.adapterError,
    engines,
  });
  assert.equal(results.length, 1);
  return results[0]!.result;
}

// ---------------------------------------------------------------------------
// The pinned matrix runs as table-driven tests
// ---------------------------------------------------------------------------

for (const row of matrix) {
  test(`evaluator regression matrix: ${row.name}`, async () => {
    const actual = await runRow(row);
    assert.equal(actual.verdict, row.expected.verdict, `verdict mismatch (matrix row: ${row.name})`);
    assert.equal(actual.score, row.expected.score, `score mismatch (matrix row: ${row.name})`);
    assert.deepEqual(
      actual.dimensions,
      row.expected.dimensions,
      `dimensions mismatch (matrix row: ${row.name}) — a dimension drift is an outcome-altering evaluator change`,
    );
    assert.deepEqual(
      actual.evidenceRefs,
      row.expected.evidenceRefs,
      `evidenceRefs mismatch (matrix row: ${row.name})`,
    );
    assert.equal(
      actual.uncertaintyOrLimitations,
      row.expected.uncertaintyOrLimitations,
      `uncertaintyOrLimitations mismatch (matrix row: ${row.name}) — the honest-disclosure text is part of the pinned outcome`,
    );
  });
}

// ---------------------------------------------------------------------------
// G. the composite multi-evaluator run (the evaluation request derived from
//    a TaskProfile's evaluator contract)
// ---------------------------------------------------------------------------

test('evaluator regression matrix: G1 the multi-evaluator run records every contract evaluator in order', async () => {
  const results = await runEvaluators({
    taskProfile: PROFILE,
    evaluators: [SCHEMA_EVALUATOR, CITATION_EVALUATOR, BRAND_EVALUATOR, RUBRIC_EVALUATOR],
    output: { headline: 'Summer Sale', wordCount: 42, confidence: 0.75, evidenceRefs: [UUID_A] },
    adapterError: null,
  });
  assert.equal(results.length, 4);
  // The per-evaluator outcomes match the pinned single-evaluator rows:
  // A1 (pass), B2 (fail 0.5), C1 (pass), D1 (pass).
  const [schema, citation, brand, rubric] = results;
  assert.equal(schema!.result.verdict, 'pass');
  assert.equal(schema!.result.score, 1);
  assert.equal(citation!.result.verdict, 'fail');
  assert.equal(citation!.result.score, 0.5);
  assert.equal(brand!.result.verdict, 'pass');
  assert.equal(brand!.result.score, 1);
  assert.equal(rubric!.result.verdict, 'pass');
  assert.equal(rubric!.result.score, 1);
  // The evaluators are the registry entries the contract resolved.
  assert.equal(schema!.evaluator.evaluatorKey, 'schema-validity');
  assert.equal(citation!.evaluator.evaluatorKey, 'citation-coverage');
  assert.equal(brand!.evaluator.evaluatorKey, 'brand-policy');
  assert.equal(rubric!.evaluator.evaluatorKey, 'domain-rubric');
});

test('evaluator regression matrix: G2 an empty evaluator contract records no outcomes', async () => {
  const results = await runEvaluators({
    taskProfile: { ...PROFILE, evaluatorIds: [] },
    evaluators: [],
    output: { headline: 'x' },
    adapterError: null,
  });
  assert.equal(results.length, 0);
});

// ---------------------------------------------------------------------------
// Sanity: the matrix exercises every built-in kind + the frozen verdict
// vocabulary
// ---------------------------------------------------------------------------

test('the evaluator regression matrix exercises every built-in evaluator kind', () => {
  const exercisedKinds = new Set<string>(matrix.map((row) => row.evaluator.kind));
  for (const kind of ['schema-validity', 'evidence-citation-coverage', 'brand-policy-compliance', 'domain-rubric', 'human-review', 'factuality-grounding']) {
    assert.ok(exercisedKinds.has(kind), `the matrix must exercise the '${kind}' evaluator kind`);
  }
});

test('the evaluator regression matrix exercises every frozen verdict (pass, fail, unknown)', () => {
  const exercisedVerdicts = new Set(matrix.map((row) => row.expected.verdict));
  assert.ok(exercisedVerdicts.has('pass'));
  assert.ok(exercisedVerdicts.has('fail'));
  assert.ok(exercisedVerdicts.has('unknown'), 'UNKNOWN (frozen semantics) must be pinned too');
});
