/**
 * /ai-runtime EVALUATION core (MKT-019, AI-003).
 *
 * The task-level evaluator implementations and the §12 result guard
 * (spec/ai-runtime-and-routing.md §7; implementation-contract §12):
 *
 *   - BUILT-IN DETERMINISTIC EVALUATORS for the §7 kinds that need no
 *     model: schema validity (§11 — "An output that fails schema
 *     validation is never accepted"), evidence citation coverage,
 *     brand-policy compliance and the numeric domain rubric. The
 *     human-review kind records `unknown` — the human decides through the
 *     review hook, never a machine.
 *   - The EVALUATOR ENGINE port (public.ts EvaluatorEngine): caller-
 *     supplied implementations for the model-judge kinds
 *     (factuality-grounding, downstream-task-success) and custom
 *     overrides. Model-judge evaluations are ADVISORY EVIDENCE
 *     (implementation-contract §12) — the module records their outcome,
 *     never treating it as unquestionable truth.
 *   - The §12 result-payload guard: verdict vocabulary, score bounds,
 *     dimension shape, evidence-ref bounds, uncertainty bounds — every
 *     recorded outcome is shape-valid BEFORE persistence.
 *   - runEvaluators: the per-evaluator orchestration used by the module's
 *     evaluateTask (the evaluation request derived from the TaskProfile's
 *     evaluator contract).
 *
 * AI-AC-08 INDEPENDENCE: this core reads the TaskProfile and the output
 * under evaluation ONLY. It never imports /metrics or /experiments
 * surfaces (business-outcome measurement is a separate plane — the static
 * architecture test proves it) and it computes task-level verdicts that
 * are meaningful independent of any business outcome.
 *
 * Determinism: every built-in is a PURE function of (evaluator config,
 * taskProfile, output, adapterError). The evaluator regression matrix
 * (tests/unit/ai-evaluation-regression-matrix.test.ts) pins the recorded
 * outcomes of a fixed scenario suite so future evaluator changes that
 * alter outcomes are caught.
 *
 * Scores are normalized 0..1 and rounded to 5 decimal places (the DB
 * column is numeric(6,5) — the recorded value always equals the asserted
 * value).
 */

import { ConflictError, InvalidRequestError } from '../../../../platform/errors/errors.ts';
import type {
  EvaluationDimension,
  EvaluationResultPayload,
  EvaluationVerdict,
  EvaluatorEngine,
  EvaluatorRecord,
  TaskProfileRecord,
} from '../../public.ts';
import { EVALUATION_VERDICTS } from '../../public.ts';

// ---------------------------------------------------------------------------
// Local validation helpers (the store's problem discipline)
// ---------------------------------------------------------------------------

function problem(message: string, details: ReadonlyArray<string>): never {
  throw new InvalidRequestError(message, details);
}

const MAX_DIMENSIONS = 64;
const MAX_EVIDENCE_REFS = 64;
const MAX_REF_LENGTH = 512;
const MAX_NOTES_LENGTH = 2000;
const MAX_UNCERTAINTY_LENGTH = 2000;
const MAX_DIMENSION_LABEL = 100;

// ---------------------------------------------------------------------------
// The §12 result-payload guard
// ---------------------------------------------------------------------------

/**
 * Guards one evaluator-produced §12 result payload BEFORE persistence:
 * the verdict vocabulary, the 0..1 score bounds, the dimension array shape
 * and bounds, the evidence-ref array shape and bounds, and the
 * uncertainty bound. An engine returning an invalid shape is a contract
 * violation — it is REJECTED (never silently coerced).
 */
export function assertValidEvaluationResultPayload(payload: EvaluationResultPayload): void {
  if (!EVALUATION_VERDICTS.includes(payload.verdict)) {
    problem('evaluation verdict is not a normalized verdict', [
      `verdict: must be one of ${EVALUATION_VERDICTS.join(' | ')}`,
    ]);
  }
  if (payload.score !== null) {
    if (typeof payload.score !== 'number' || !Number.isFinite(payload.score)) {
      problem('evaluation score must be a finite number or null', [
        'score: must be a number in 0..1 or null',
      ]);
    }
    if (payload.score < 0 || payload.score > 1) {
      problem('evaluation score is out of bounds', ['score: must be within 0..1']);
    }
  }
  if (!Array.isArray(payload.dimensions)) {
    problem('evaluation dimensions must be an array', ['dimensions: must be an array']);
  }
  if (payload.dimensions.length > MAX_DIMENSIONS) {
    problem('evaluation dimensions exceed the bound', [
      `dimensions: must contain at most ${MAX_DIMENSIONS} entries`,
    ]);
  }
  for (const dimension of payload.dimensions) {
    const d = dimension as Partial<EvaluationDimension> | null;
    if (d === null || typeof d !== 'object') {
      problem('evaluation dimension must be an object', ['dimensions[]: must be objects']);
    }
    if (typeof d.dimension !== 'string' || d.dimension.length < 1 || d.dimension.length > MAX_DIMENSION_LABEL) {
      problem('evaluation dimension label is out of bounds', [
        `dimensions[].dimension: must be 1..${MAX_DIMENSION_LABEL} characters`,
      ]);
    }
    if (d.verdict === undefined || !EVALUATION_VERDICTS.includes(d.verdict as EvaluationVerdict)) {
      problem('evaluation dimension verdict is not a normalized verdict', [
        `dimensions[].verdict: must be one of ${EVALUATION_VERDICTS.join(' | ')}`,
      ]);
    }
    if (d.score !== null && d.score !== undefined) {
      if (typeof d.score !== 'number' || !Number.isFinite(d.score) || d.score < 0 || d.score > 1) {
        problem('evaluation dimension score is out of bounds', [
          'dimensions[].score: must be a number in 0..1 or null',
        ]);
      }
    }
    if (typeof d.notes !== 'string' || d.notes.length > MAX_NOTES_LENGTH) {
      problem('evaluation dimension notes are out of bounds', [
        `dimensions[].notes: must be at most ${MAX_NOTES_LENGTH} characters`,
      ]);
    }
  }
  if (!Array.isArray(payload.evidenceRefs)) {
    problem('evaluation evidenceRefs must be an array', ['evidenceRefs: must be an array']);
  }
  if (payload.evidenceRefs.length > MAX_EVIDENCE_REFS) {
    problem('evaluation evidenceRefs exceed the bound', [
      `evidenceRefs: must contain at most ${MAX_EVIDENCE_REFS} references`,
    ]);
  }
  for (const ref of payload.evidenceRefs) {
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > MAX_REF_LENGTH) {
      problem('evaluation evidence reference is out of bounds', [
        `evidenceRefs[]: every reference must be 1..${MAX_REF_LENGTH} characters`,
      ]);
    }
  }
  if (typeof payload.uncertaintyOrLimitations !== 'string' || payload.uncertaintyOrLimitations.length > MAX_UNCERTAINTY_LENGTH) {
    problem('evaluation uncertaintyOrLimitations is out of bounds', [
      `uncertaintyOrLimitations: must be at most ${MAX_UNCERTAINTY_LENGTH} characters`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Rounds a score to 5 decimals (the numeric(6,5) column precision). */
function round5(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

function dimension(
  label: string,
  verdict: EvaluationVerdict,
  score: number | null,
  notes: string,
): EvaluationDimension {
  return { dimension: label, verdict, score, notes };
}

/** Reads a bounded array of strings from an unknown value (else []). */
function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length >= 1 && item.length <= MAX_REF_LENGTH) {
      out.push(item);
    }
  }
  return out;
}

/** Collects every string value in the output (recursively, depth-bounded). */
function collectStrings(value: unknown, depth: number, out: string[]): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectStrings(item, depth + 1, out);
  }
}

/** The config as a plain record (defensive — the registry guard pre-validates). */
function configOf(evaluator: EvaluatorRecord): Record<string, unknown> {
  const config = evaluator.config as unknown;
  if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    return config as Record<string, unknown>;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Built-in: schema validity (§7/§11 — reuses the MKT-018 defaultValidator
// semantics: an output that fails schema validation is never accepted)
// ---------------------------------------------------------------------------

function validateOutputSchema(
  taskProfile: TaskProfileRecord,
  output: Readonly<Record<string, unknown>>,
): string | null {
  const schema = taskProfile.outputSchema as Record<string, unknown>;
  const required = schema['required'];
  const properties = schema['properties'];
  if (Array.isArray(required) && typeof properties === 'object' && properties !== null) {
    const propMap = properties as Record<string, unknown>;
    for (const field of required) {
      if (typeof field !== 'string') continue;
      const value = output[field];
      if (value === undefined) {
        return `output missing required field '${field}'`;
      }
      const fieldSchema = propMap[field] as Record<string, unknown> | undefined;
      if (fieldSchema === undefined) continue;
      const expectedType = fieldSchema['type'];
      if (typeof expectedType !== 'string') continue;
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (expectedType === 'object' && actualType !== 'object') {
        return `output field '${field}' must be ${expectedType}`;
      }
      if (expectedType === 'array' && actualType !== 'array') {
        return `output field '${field}' must be ${expectedType}`;
      }
      if (
        expectedType !== 'object' &&
        expectedType !== 'array' &&
        expectedType !== 'null' &&
        actualType !== expectedType
      ) {
        return `output field '${field}' must be ${expectedType}`;
      }
    }
  }
  return null;
}

/**
 * The schema-validity evaluator: checks the output against the
 * TaskProfile's outputSchema (top-level required fields + types — the
 * same contract subset as the routing default validator). A null output
 * or adapter error FAILS (an output that fails schema validation is never
 * accepted — there is no output to accept).
 */
export const schemaValidityEvaluator: EvaluatorEngine = async (input): Promise<EvaluationResultPayload> => {
  if (input.adapterError !== null) {
    return {
      verdict: 'fail',
      score: 0,
      dimensions: [
        dimension('schema-validity', 'fail', 0, `adapter error: ${input.adapterError.slice(0, 400)}`),
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'schema validity could not be proven: the invocation reported an adapter error',
    };
  }
  if (input.output === null) {
    return {
      verdict: 'fail',
      score: 0,
      dimensions: [dimension('schema-validity', 'fail', 0, 'no output to validate')],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'schema validity could not be proven: the invocation produced no output',
    };
  }
  const reason = validateOutputSchema(input.taskProfile, input.output);
  if (reason !== null) {
    return {
      verdict: 'fail',
      score: 0,
      dimensions: [dimension('schema-validity', 'fail', 0, reason)],
      evidenceRefs: [],
      uncertaintyOrLimitations: '',
    };
  }
  return {
    verdict: 'pass',
    score: 1,
    dimensions: [dimension('schema-validity', 'pass', 1, 'output satisfies the declared output schema')],
    evidenceRefs: [],
    uncertaintyOrLimitations:
      'top-level required-field and type validation only (a JSON Schema subset — deep/nested validation is a refinement, not a frozen contract)',
  };
};

// ---------------------------------------------------------------------------
// Built-in: evidence citation coverage (§7)
// ---------------------------------------------------------------------------

/**
 * The evidence-citation-coverage evaluator: measures which of the
 * config-declared expected evidence references the output actually cited
 * (the output's citations field, config-declared, default
 * `evidenceRefs`). Coverage = cited ∩ expected / expected; the verdict
 * passes when coverage meets the config threshold (default 1.0). The
 * recorded evidenceRefs are the output's citations — the module validates
 * each through the /evidence authority.
 */
export const citationCoverageEvaluator: EvaluatorEngine = async (input): Promise<EvaluationResultPayload> => {
  const config = configOf(input.evaluator);
  if (input.output === null) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [dimension('citation-coverage', 'unknown', null, 'no output to evaluate')],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'citation coverage could not be proven: the invocation produced no output',
    };
  }
  const expected = stringArray(config['expectedEvidenceRefs']);
  if (expected.length === 0) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [
        dimension('citation-coverage', 'unknown', null, 'expectedEvidenceRefs not declared in the evaluator config'),
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'citation coverage could not be proven: the evaluator config declares no expected evidence references',
    };
  }
  const citationsField = typeof config['citationsField'] === 'string' && config['citationsField'].length >= 1
    ? config['citationsField']
    : 'evidenceRefs';
  const cited = stringArray(input.output[citationsField]);
  const expectedSet = new Set(expected);
  const matched = cited.filter((ref) => expectedSet.has(ref));
  const coverage = round5(matched.length / expected.length);
  const rawThreshold = config['coverageThreshold'];
  const threshold =
    typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 1
      ? rawThreshold
      : 1;
  const verdict: EvaluationVerdict = coverage >= threshold ? 'pass' : 'fail';
  return {
    verdict,
    score: coverage,
    dimensions: [
      dimension(
        'citation-coverage',
        verdict,
        coverage,
        `${matched.length} of ${expected.length} expected evidence references cited (threshold ${threshold})`,
      ),
    ],
    evidenceRefs: cited,
    uncertaintyOrLimitations:
      'citation coverage measures WHICH expected references were cited, not the factual grounding of the cited content',
  };
};

// ---------------------------------------------------------------------------
// Built-in: brand-policy compliance (§7)
// ---------------------------------------------------------------------------

/**
 * The brand-policy-compliance evaluator: scans every string value in the
 * output (recursively, depth-bounded) for the config-declared denied
 * terms (substring match, case-insensitive unless the config declares
 * caseSensitive). Pass when no denied term is present.
 */
export const brandPolicyEvaluator: EvaluatorEngine = async (input): Promise<EvaluationResultPayload> => {
  const config = configOf(input.evaluator);
  if (input.output === null) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [dimension('brand-policy-compliance', 'unknown', null, 'no output to evaluate')],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'brand-policy compliance could not be proven: the invocation produced no output',
    };
  }
  if (!Array.isArray(config['deniedTerms'])) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [
        dimension('brand-policy-compliance', 'unknown', null, 'deniedTerms not declared in the evaluator config'),
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'brand-policy compliance could not be proven: the evaluator config declares no denied-terms list',
    };
  }
  const deniedTerms = stringArray(config['deniedTerms']);
  const caseSensitive = config['caseSensitive'] === true;
  const haystacks: string[] = [];
  collectStrings(input.output, 0, haystacks);
  const violations: string[] = [];
  for (const term of deniedTerms) {
    const found = haystacks.some((text) =>
      caseSensitive ? text.includes(term) : text.toLowerCase().includes(term.toLowerCase()),
    );
    if (found) violations.push(term);
  }
  const verdict: EvaluationVerdict = violations.length === 0 ? 'pass' : 'fail';
  const notes =
    violations.length === 0
      ? deniedTerms.length === 0
        ? 'no denied terms declared — compliance is vacuous'
        : 'no denied term present in the output'
      : `denied terms present: ${violations.slice(0, 10).join(', ')}`;
  return {
    verdict,
    score: violations.length === 0 ? 1 : 0,
    dimensions: [dimension('brand-policy-compliance', verdict, violations.length === 0 ? 1 : 0, notes)],
    evidenceRefs: [],
    uncertaintyOrLimitations:
      'term matching is literal (substring) — paraphrased or implied policy violations are not detected',
  };
};

// ---------------------------------------------------------------------------
// Built-in: domain rubric (§7)
// ---------------------------------------------------------------------------

interface RubricDimension {
  readonly field: string;
  readonly min: number;
  readonly max: number;
}

function rubricOf(config: Record<string, unknown>): readonly RubricDimension[] | null {
  const raw = config['dimensions'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: RubricDimension[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate['field'] !== 'string' ||
      candidate['field'].length < 1 ||
      candidate['field'].length > MAX_DIMENSION_LABEL ||
      typeof candidate['min'] !== 'number' ||
      !Number.isFinite(candidate['min']) ||
      typeof candidate['max'] !== 'number' ||
      !Number.isFinite(candidate['max']) ||
      candidate['min'] > candidate['max']
    ) {
      continue;
    }
    out.push({ field: candidate['field'], min: candidate['min'], max: candidate['max'] });
  }
  return out.length === 0 ? null : out;
}

/**
 * The domain-rubric evaluator: the config declares numeric rubric
 * dimensions ({ field, min, max }); each output field is scored 1 when
 * its numeric value is within bounds, 0 otherwise; the overall score is
 * the fraction of dimensions met and the verdict passes when it meets the
 * config passThreshold (default 1.0).
 */
export const domainRubricEvaluator: EvaluatorEngine = async (input): Promise<EvaluationResultPayload> => {
  const config = configOf(input.evaluator);
  if (input.output === null) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [dimension('domain-rubric', 'unknown', null, 'no output to evaluate')],
      evidenceRefs: [],
      uncertaintyOrLimitations: 'domain rubric could not be proven: the invocation produced no output',
    };
  }
  const rubric = rubricOf(config);
  if (rubric === null) {
    return {
      verdict: 'unknown',
      score: null,
      dimensions: [
        dimension('domain-rubric', 'unknown', null, 'dimensions not declared in the evaluator config'),
      ],
      evidenceRefs: [],
      uncertaintyOrLimitations:
        'domain rubric could not be proven: the evaluator config declares no numeric rubric dimensions',
    };
  }
  const rawThreshold = config['passThreshold'];
  const threshold =
    typeof rawThreshold === 'number' && Number.isFinite(rawThreshold) && rawThreshold >= 0 && rawThreshold <= 1
      ? rawThreshold
      : 1;
  const dimensions: EvaluationDimension[] = [];
  let met = 0;
  for (const rubricDimension of rubric) {
    const value = input.output[rubricDimension.field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      dimensions.push(
        dimension(`rubric:${rubricDimension.field}`, 'fail', 0, 'field missing or non-numeric'),
      );
      continue;
    }
    const inBounds = value >= rubricDimension.min && value <= rubricDimension.max;
    if (inBounds) met += 1;
    dimensions.push(
      dimension(
        `rubric:${rubricDimension.field}`,
        inBounds ? 'pass' : 'fail',
        inBounds ? 1 : 0,
        `value ${value} against bounds [${rubricDimension.min}, ${rubricDimension.max}]`,
      ),
    );
  }
  const score = round5(met / rubric.length);
  const verdict: EvaluationVerdict = score >= threshold ? 'pass' : 'fail';
  return {
    verdict,
    score,
    dimensions,
    evidenceRefs: [],
    uncertaintyOrLimitations: 'numeric bounds checking only — qualitative rubric dimensions are not machine-scored',
  };
};

// ---------------------------------------------------------------------------
// Built-in: human review (§7 "human review where needed")
// ---------------------------------------------------------------------------

/**
 * The human-review evaluator: the machine CANNOT decide — the outcome is
 * `unknown` (frozen UNKNOWN semantics: never auto-resolved) and the
 * caller composes requestReview to record the human-review intent;
 * humans act through the existing Job/Task/Execution authorities. A
 * follow-up evaluation (with an engine that records the human's verdict)
 * or the review-request decision records the outcome.
 */
export const humanReviewEvaluator: EvaluatorEngine = async (): Promise<EvaluationResultPayload> => {
  return {
    verdict: 'unknown',
    score: null,
    dimensions: [
      dimension('human-review', 'unknown', null, 'deferred to the human-review hook'),
    ],
    evidenceRefs: [],
    uncertaintyOrLimitations:
      'human review pending — the machine cannot decide this evaluation; request a review and record the human outcome',
  };
};

// ---------------------------------------------------------------------------
// Engine resolution + the per-evaluator orchestration
// ---------------------------------------------------------------------------

/** A built-in evaluator implementation (satisfies the EvaluatorEngine port). */
export type BuiltInEvaluator = EvaluatorEngine;

const BUILTINS_BY_KIND: Readonly<Record<string, EvaluatorEngine>> = {
  'schema-validity': schemaValidityEvaluator,
  'evidence-citation-coverage': citationCoverageEvaluator,
  'brand-policy-compliance': brandPolicyEvaluator,
  'domain-rubric': domainRubricEvaluator,
  'human-review': humanReviewEvaluator,
};

/** The §7 kinds with a built-in deterministic evaluator implementation. */
export const BUILTIN_EVALUATOR_KINDS: readonly string[] = Object.keys(BUILTINS_BY_KIND);

/**
 * Resolves the evaluator implementation for one registry entry: a
 * caller-supplied engine keyed by the evaluator KEY takes precedence,
 * then the built-in for the KIND, else null (the caller MUST supply an
 * engine — factuality-grounding model judges and downstream-task-success
 * recorders are caller-supplied, never built in).
 */
export function resolveEvaluatorEngine(
  evaluator: EvaluatorRecord,
  engines?: Readonly<Record<string, EvaluatorEngine>>,
): EvaluatorEngine | null {
  const engine = engines?.[evaluator.evaluatorKey];
  if (engine !== undefined) return engine;
  return BUILTINS_BY_KIND[evaluator.kind] ?? null;
}

/** One evaluator's computed outcome (pre-persistence). */
export interface EvaluatorRunResult {
  readonly evaluator: EvaluatorRecord;
  readonly result: EvaluationResultPayload;
}

/**
 * Runs every evaluator against the output: resolves each implementation
 * (engine override → built-in → ConflictError when neither exists — the
 * TaskProfile's evaluator contract is never silently half-evaluated),
 * runs it and guards the §12 result payload. PURE orchestration —
 * persistence belongs to the module/store.
 */
export async function runEvaluators(input: {
  readonly taskProfile: TaskProfileRecord;
  readonly evaluators: readonly EvaluatorRecord[];
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly adapterError: string | null;
  readonly engines?: Readonly<Record<string, EvaluatorEngine>> | undefined;
}): Promise<readonly EvaluatorRunResult[]> {
  const results: EvaluatorRunResult[] = [];
  for (const evaluator of input.evaluators) {
    const engine = resolveEvaluatorEngine(evaluator, input.engines);
    if (engine === null) {
      throw new ConflictError(
        `no evaluator implementation available for evaluator '${evaluator.evaluatorKey}' (kind '${evaluator.kind}' has no built-in and no engine was supplied) — the TaskProfile evaluator contract cannot be silently half-evaluated`,
      );
    }
    const result = await engine({
      evaluator,
      taskProfile: input.taskProfile,
      output: input.output,
      adapterError: input.adapterError,
    });
    assertValidEvaluationResultPayload(result);
    results.push({ evaluator, result });
  }
  return results;
}
