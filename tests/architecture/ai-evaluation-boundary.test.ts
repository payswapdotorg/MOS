/**
 * MKT-019 static architecture tests — the AI evaluation framework boundary
 * is structurally correct, PROVIDER-NEUTRAL and INDEPENDENT of
 * business-outcome measurement (pure static analysis, no DB).
 *
 * THE AI-AC-08 ACCEPTANCE PROOF (requirements.md: "AI evaluation is
 * separate from business-outcome measurement — architecture/static
 * test"; spec/ai-runtime-and-routing.md §8: "The AI Runtime may record
 * which model/strategy succeeded, but it must not confuse a high
 * evaluator score with business lift. Model evaluations and business
 * outcomes remain separate datasets linked through execution
 * identifiers"):
 *
 *   1. NO file under src/modules/ai-runtime imports a /metrics,
 *      /experiments or /reporting surface (the business-outcome plane —
 *      /reporting is read-side over metrics/experiments/learnings). The
 *      frozen dependency matrix sanctions /executions, /policies,
 *      /credentials and /evidence only; this test asserts the actual
 *      import graph, independently of tools/arch-check;
 *   2. the migration 032 evaluation tables carry NO business-outcome
 *      columns (no metric/KPI reference, no experiment-outcome reference,
 *      no lift/conversion field) — the evaluation record links
 *      task-level context only (TaskProfile, execution, usage, evidence
 *      citations);
 *   3. the evaluation input guards REJECT business-outcome-shaped keys
 *      (metricId, kpiId, experimentId, ...) at every entry (evaluator
 *      registration, evaluation request, review request) — the
 *      machine-checkable module-side separation;
 *   4. the evaluator registry is PROVIDER-NEUTRAL: no provider/model/
 *      SDK/credential-shaped columns in ai_evaluators and no such keys in
 *      the registration input contract (the evaluator is a normalized
 *      kind + config, never an SDK import or credential);
 *   5. the module's evaluation methods are part of the ONE /ai-runtime
 *      authority (public.ts declares evaluateTask/requestReview/... on
 *      AiRuntimeModuleApi — no second evaluation module, no second
 *      authority);
 *   6. migration 032 creates exactly the four evaluation tables with the
 *      §8-style fences, append-only triggers (evaluations + review
 *      transitions), terminal lifecycles and scope-chain backstops;
 *   7. the human-review hook is a HOOK, not an engine: the review tables
 *      carry no assignment/claim/work-distribution columns, and /ai-runtime
 *      imports no /jobs or /field-agents surface (humans act through the
 *      existing authorities).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_FORBIDDEN_INPUT_KEYS,
  EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS,
} from '../../src/modules/ai-runtime/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const aiRuntimeFiles = walk(src('modules', 'ai-runtime'));

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

const migration032 = read(src('platform', 'db', 'migrations', '032_ai_evaluations.sql'));
const aiRuntimePublic = read(src('modules', 'ai-runtime', 'public.ts'));
const aiRuntimeModule = read(src('modules', 'ai-runtime', 'internal', 'ai-runtime-module.ts'));

// ---------------------------------------------------------------------------
// AI-AC-08 (1): the import graph — NO business-outcome surface is imported
// ---------------------------------------------------------------------------

test('AI-AC-08: NO /ai-runtime file imports /metrics, /experiments or /reporting (the business-outcome plane)', () => {
  const BUSINESS_OUTCOME_SURFACES = ['modules/metrics', 'modules/experiments', 'modules/reporting'];
  const violations: string[] = [];
  for (const file of aiRuntimeFiles) {
    for (const specifier of importsOf(file)) {
      for (const surface of BUSINESS_OUTCOME_SURFACES) {
        if (specifier.includes(`/${surface}/`) || specifier.includes(`/${surface}.ts`)) {
          violations.push(`${file} imports '${specifier}'`);
        }
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'the /ai-runtime module (incl. the evaluation layer) must never import a business-outcome surface — AI-AC-08 (model evaluations and business outcomes remain separate datasets)',
  );
});

test('AI-AC-08: the /ai-runtime module imports ONLY the matrix-sanctioned modules (/executions, /evidence)', () => {
  const importedModules = new Set<string>();
  for (const file of aiRuntimeFiles) {
    for (const specifier of importsOf(file)) {
      // Resolve RELATIVE specifiers (the only cross-module form) to their
      // target path and extract the module directory.
      if (!specifier.startsWith('.')) continue;
      const target = join(dirname(file), specifier);
      const match = target.match(/[\\/]modules[\\/]([a-z-]+)[\\/]/);
      if (match !== null) importedModules.add(match[1]!);
    }
  }
  // The frozen matrix sanctions /executions, /policies, /credentials,
  // /evidence for /ai-runtime; the landed slices use exactly
  // /executions (MKT-017) and /evidence (MKT-019 citation validation).
  // (The ai-runtime self-imports are the module's own internal files.)
  const crossModuleImports = [...importedModules].filter((m) => m !== 'ai-runtime');
  assert.deepEqual(crossModuleImports.sort(), ['evidence', 'executions']);
});

test('AI-AC-08: the evaluation core reads task-level context only (no business-outcome identifiers anywhere in the evaluation layer)', () => {
  const evaluationCore = read(src('modules', 'ai-runtime', 'internal', 'evaluation', 'evaluate.ts'));
  const evaluationStore = read(src('modules', 'ai-runtime', 'internal', 'ai-evaluation-store.ts'));
  for (const forbiddenIdentifier of [
    'metrics/public',
    'experiments/public',
    'metricObservation',
    'experimentOutcome',
    'businessLift',
    'conversionRate',
    'kpi',
  ]) {
    assert.ok(
      !evaluationCore.includes(forbiddenIdentifier) && !evaluationStore.includes(forbiddenIdentifier),
      `the evaluation core/store must not reference the business-outcome concept '${forbiddenIdentifier}'`,
    );
  }
  // The evaluation inputs are TaskProfile/output/adapterError — the store's
  // guard validates exactly those references.
  assert.ok(
    evaluationStore.includes('taskProfileId') && evaluationStore.includes('assertValidEvaluationInput'),
    'the evaluation input contract is the task-level context (taskProfileId/executionId/usageId/output)',
  );
});

// ---------------------------------------------------------------------------
// AI-AC-08 (2): the migration carries NO business-outcome columns
// ---------------------------------------------------------------------------

test('AI-AC-08: migration 032 evaluation tables carry NO business-outcome columns (task-level links only)', () => {
  // Extract ONLY the CREATE TABLE blocks — the explanatory comments
  // legitimately NAME the forbidden concepts while prohibiting them.
  const tableBlocks = [...migration032.matchAll(/CREATE TABLE IF NOT EXISTS [a-z_]+ \(([\s\S]*?)\n\);/g)].map(
    (match) => match[1]!,
  );
  assert.ok(tableBlocks.length === 4, 'the four evaluation tables are extracted');
  for (const forbiddenColumn of [
    'metric_id',
    'kpi_id',
    'kpi',
    'metric_ref',
    'experiment_id',
    'experiment_outcome_id',
    'business_outcome',
    'business_outcome_id',
    'lift',
    'conversion_rate',
    'revenue',
  ]) {
    for (const block of tableBlocks) {
      assert.ok(
        !block.includes(forbiddenColumn),
        `the evaluation tables must NOT carry the business-outcome column '${forbiddenColumn}' — evaluation records link task-level context only (AI-AC-08)`,
      );
    }
  }
  // The evaluation record links exactly the task-level context: the
  // TaskProfile, the Execution, the usage telemetry and the evaluator.
  const block = migration032.slice(
    migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_evaluations'),
    migration032.indexOf(');', migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_evaluations')),
  );
  for (const required of [
    'task_profile_id',
    'execution_id',
    'usage_id',
    'evaluator_registry_id',
    'evaluator_key',
    'evaluator_version',
    'verdict',
    'score',
    'dimensions',
    'evidence_refs',
    'uncertainty_or_limitations',
    'correlation_id',
    'idempotency_key',
    'create_fingerprint',
  ]) {
    assert.ok(block.includes(required), `ai_evaluations.${required} required (the §12 evaluation record)`);
  }
});

// ---------------------------------------------------------------------------
// AI-AC-08 (3): the input guards reject business-outcome-shaped keys
// ---------------------------------------------------------------------------

test('AI-AC-08: every evaluation-layer input contract rejects business-outcome-shaped keys', () => {
  const BUSINESS_OUTCOME_KEYS = ['metricId', 'kpiId', 'experimentId', 'experimentOutcomeId', 'businessOutcomeId', 'lift'];
  for (const key of BUSINESS_OUTCOME_KEYS) {
    assert.ok(
      EVALUATION_FORBIDDEN_INPUT_KEYS.includes(key as never),
      `EVALUATION_FORBIDDEN_INPUT_KEYS must reject '${key}'`,
    );
    assert.ok(
      EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS.includes(key as never),
      `EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS must reject '${key}'`,
    );
    assert.ok(
      REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS.includes(key as never),
      `REVIEW_REQUEST_FORBIDDEN_INPUT_KEYS must reject '${key}'`,
    );
  }
  // The evaluation request additionally rejects the KPI observation and
  // conversion surfaces by name.
  for (const key of ['metricObservationId', 'conversionRate', 'businessOutcome']) {
    assert.ok(
      EVALUATION_FORBIDDEN_INPUT_KEYS.includes(key as never),
      `EVALUATION_FORBIDDEN_INPUT_KEYS must reject '${key}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// AI-AC-08 (4): the evaluator registry is provider-neutral
// ---------------------------------------------------------------------------

test('the evaluator registry is provider-neutral: no SDK/provider/credential columns, no such input keys', () => {
  const block = migration032.slice(
    migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_evaluators'),
    migration032.indexOf(');', migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_evaluators')),
  );
  for (const forbiddenColumn of ['sdk', 'provider', 'model_key', 'model_id', 'credential', 'secret', 'api_key', 'token']) {
    assert.ok(
      !block.includes(forbiddenColumn),
      `ai_evaluators must NOT carry the provider/credential column '${forbiddenColumn}' — the evaluator is a normalized kind + config (provider-neutral DATA)`,
    );
  }
  for (const forbiddenKey of ['sdk', 'sdkPackage', 'clientLibrary', 'adapter', 'adapterConfig', 'provider', 'providerLabel', 'model', 'modelKey', 'credential', 'apiKey', 'token', 'password']) {
    assert.ok(
      EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS.includes(forbiddenKey as never),
      `EVALUATOR_REGISTRATION_FORBIDDEN_INPUT_KEYS must reject '${forbiddenKey}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// AI-AC-08 (5): ONE authority — the evaluation methods live on the
// /ai-runtime module (no second evaluation module)
// ---------------------------------------------------------------------------

test('the evaluation authority is the /ai-runtime module itself (no second authority)', () => {
  for (const method of [
    'registerEvaluator(input: {',
    'evaluateTask(input: {',
    'requestReview(input: {',
    'decideReview(input: {',
    'retireEvaluator(input: {',
  ]) {
    assert.ok(aiRuntimePublic.includes(method), `AiRuntimeModuleApi.${method.split('(')[0]} exists — the module owns the evaluation authority`);
  }
  for (const method of ['async evaluateTask(', 'async requestReview(', 'async decideReview(', 'async registerEvaluator(']) {
    assert.ok(aiRuntimeModule.includes(method), `the module implementation provides ${method.split('(')[0]}`);
  }
  // No evaluation-flavored module directory exists besides /ai-runtime.
  const moduleDirs = readdirSync(src('modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const dir of moduleDirs) {
    assert.ok(
      !dir.includes('evaluation') && !dir.includes('evaluator'),
      `src/modules/${dir} would be a second evaluation authority — the frozen authority map assigns evaluation to /ai-runtime`,
    );
  }
});

// ---------------------------------------------------------------------------
// AI-AC-08 (6): the migration's structural backstops
// ---------------------------------------------------------------------------

test('migration 032 creates EXACTLY the four evaluation tables', () => {
  const created = [...migration032.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created.sort(), [
    'ai_evaluations',
    'ai_evaluators',
    'ai_review_request_transitions',
    'ai_review_requests',
  ]);
});

test('migration 032: evaluation records are append-only (UPDATE and DELETE DB-rejected)', () => {
  assert.ok(
    migration032.includes('BEFORE UPDATE OR DELETE ON ai_evaluations') &&
      migration032.includes('ai_evaluations_append_only'),
    'ai_evaluations rejects UPDATE and DELETE — evaluation history is never rewritten (append-only)',
  );
  assert.ok(
    migration032.includes('BEFORE UPDATE OR DELETE ON ai_review_request_transitions') &&
      migration032.includes('ai_review_request_transitions_append_only'),
    'ai_review_request_transitions rejects UPDATE and DELETE — review transitions are append-only history',
  );
});

test('migration 032: the §8-style fences and terminal lifecycles exist', () => {
  // The per-evaluator evaluation fence.
  assert.ok(
    migration032.includes('CONSTRAINT ai_evaluations_key_unique UNIQUE (workspace_id, idempotency_key, evaluator_key)'),
    'the (workspace, key, evaluator) §8-style append fence exists on ai_evaluations',
  );
  // The review-request create fence.
  assert.ok(
    migration032.includes('CONSTRAINT ai_review_requests_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the (workspace, key) §8-style create fence exists on ai_review_requests',
  );
  // The exactly-one-decision fence.
  assert.ok(
    migration032.includes('CONSTRAINT ai_review_request_transitions_request_unique UNIQUE (review_request_id)'),
    'the exactly-one-decision fence exists on the transitions table',
  );
  // The evaluator ACTIVE-key fence.
  assert.ok(
    migration032.includes('ai_evaluators_active_key_fence'),
    'the evaluator_key ACTIVE-pair fence exists',
  );
  // Terminal lifecycles.
  assert.ok(migration032.includes('ai_evaluators_retired_terminal'), 'evaluator retired is terminal');
  assert.ok(
    migration032.includes("pending → approved | rejected | dismissed"),
    'the review-request lifecycle is pending → approved | rejected | dismissed',
  );
  // Content immutability.
  assert.ok(migration032.includes('ai_evaluators_content_immutable'), 'evaluator content is DB-immutable');
  assert.ok(migration032.includes('ai_review_requests_content_immutable'), 'review-request context/reason are DB-immutable');
});

test('migration 032: the scope-chain backstops enforce tenant isolation', () => {
  assert.ok(migration032.includes('ai_evaluations_scope_chain'), 'ai_evaluations scope-chain trigger exists');
  assert.ok(migration032.includes('ai_review_requests_scope_chain'), 'ai_review_requests scope-chain trigger exists');
  // The scope-chain triggers reject foreign TaskProfiles, usage rows,
  // executions and evaluations.
  assert.ok(
    migration032.includes('evaluation % task profile % does not belong to workspace %'),
    'the evaluation scope-chain rejects a foreign TaskProfile',
  );
  assert.ok(
    migration032.includes('evaluation % usage telemetry % does not belong to workspace %'),
    'the evaluation scope-chain rejects a foreign usage row',
  );
  assert.ok(
    migration032.includes('evaluation % execution % does not belong to workspace %'),
    'the evaluation scope-chain rejects a foreign execution',
  );
  assert.ok(
    migration032.includes('review request % evaluation % does not belong to workspace %'),
    'the review-request scope-chain rejects a foreign evaluation',
  );
});

// ---------------------------------------------------------------------------
// AI-AC-08 (7): the human-review hook is a HOOK, not an engine
// ---------------------------------------------------------------------------

test('the human-review hook is a hook, not a second human-execution engine', () => {
  // /ai-runtime imports NO /jobs or /field-agents surface (humans act
  // through the existing authorities — the matrix does not even sanction
  // those directions).
  const violations: string[] = [];
  for (const file of aiRuntimeFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.includes('/modules/jobs/') || specifier.includes('/modules/field-agents/')) {
        violations.push(`${file} imports '${specifier}'`);
      }
    }
  }
  assert.deepEqual(violations, [], '/ai-runtime must never import /jobs or /field-agents — the review hook records intent/outcome only');

  // The review tables carry no work-distribution columns: no assignee,
  // no claim, no offer, no queue position, no deadline.
  const reviewBlock = migration032.slice(
    migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_review_requests'),
    migration032.indexOf(');', migration032.indexOf('CREATE TABLE IF NOT EXISTS ai_review_requests')),
  );
  for (const forbiddenColumn of [
    'assignee',
    'assigned_to',
    'claimed_by',
    'offer',
    'queue',
    'deadline',
    'due_at',
    'job_id',
    'worker',
  ]) {
    assert.ok(
      !reviewBlock.includes(forbiddenColumn),
      `ai_review_requests must NOT carry the work-distribution column '${forbiddenColumn}' — human work distribution belongs to /jobs`,
    );
  }
  // The hook records review intent (reason) + outcome (state/decision).
  for (const required of ['reason', 'state', 'decided_by', 'decided_at', 'decision_note']) {
    assert.ok(reviewBlock.includes(required), `ai_review_requests.${required} required (the intent/outcome record)`);
  }
});

test('the frozen UNKNOWN semantics is carried into the evaluation verdict vocabulary', () => {
  // The migration's verdict CHECK includes unknown — never auto-resolved
  // to pass.
  assert.ok(
    migration032.includes("CHECK (verdict IN ('pass', 'fail', 'unknown'))"),
    "the evaluation verdict CHECK includes 'unknown' (frozen UNKNOWN semantics)",
  );
  assert.ok(
    migration032.includes('auto-resolved to pass'),
    'the unknown verdict is documented as never auto-resolved',
  );
});
