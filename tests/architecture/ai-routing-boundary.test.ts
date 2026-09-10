/**
 * MKT-018 static architecture tests — the AI Runtime ROUTING boundary is
 * structurally correct and PROVIDER-INDEPENDENT in the ACTUAL module contract,
 * migration and source tree (pure static analysis, no DB).
 *
 * Acceptance proofs (requirements.md AI-002; work-items.md MKT-018 =
 * AI-AC-03..07; spec/ai-runtime-and-routing.md §4/§5/§6/§9):
 *
 *   AI-AC-03 ("OpenRouter is not the routing authority — static
 *   architecture check"):
 *     1. the routing authority is the /ai-runtime module itself — the
 *        module's public.ts exports the routing types and the module's
 *        createAiRuntimeModule function implements the routing methods
 *        (routeTask, previewRouting, etc.);
 *     2. OpenRouter appears ONLY as an adapter implementation behind the
 *        provider-neutral contract — the OpenRouterAdapter class lives in
 *        the sanctioned adapter home (src/modules/ai-runtime/internal/
 *        adapters/) and implements the ProviderAdapter contract (the PORT
 *        defined in public.ts);
 *     3. NO domain module imports the OpenRouter adapter (or any adapter
 *        implementation) — the routing core depends on the adapter
 *        CONTRACT (ports), not implementations;
 *     4. NO file anywhere in src/ imports a provider SDK package — the
 *        OpenRouter adapter uses the platform's HttpCallPort (fetch-based),
 *        never an SDK;
 *     5. the OpenRouter adapter is NOT imported by the /ai-runtime module
 *        code (it would create a hard dependency on a specific provider);
 *        the adapter is supplied by the caller at route time (the
 *        composition root wires it; the integration test supplies a fake).
 *
 *   AI-AC-07 ("model capability is not artificially clipped merely for
 *   benchmark normalization — static/unit test"):
 *     6. the routing policy code (policy.ts) does NOT mutate the registry
 *        record's `capabilities`, `toolFeatures`, or `qualitySignals`
 *        fields — the ranking math normalizes the quality signal to a
 *        0..1 score for comparison, but the registry record is read-only
 *        (the function signatures take `readonly` inputs and return new
 *        RankingScore objects, not mutations);
 *     7. the migration 020 routing tables do NOT carry capability-clipping
 *        columns — the routing policy content is a bounded JSON object
 *        (interpreted by the routing core), not a clipped capability
 *        matrix.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const allSrcFiles = walk(src());

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

const migration020 = read(src('platform', 'db', 'migrations', '020_ai_routing.sql'));
const aiRuntimePublic = read(src('modules', 'ai-runtime', 'public.ts'));
const aiRuntimeModule = read(src('modules', 'ai-runtime', 'internal', 'ai-runtime-module.ts'));
const routingPolicy = read(src('modules', 'ai-runtime', 'internal', 'routing', 'policy.ts'));
const cascade = read(src('modules', 'ai-runtime', 'internal', 'routing', 'cascade.ts'));
const openrouterAdapter = read(src('modules', 'ai-runtime', 'internal', 'adapters', 'openrouter-adapter.ts'));
const adapterContract = read(src('modules', 'ai-runtime', 'internal', 'adapters', 'adapter-contract.ts'));

// ---------------------------------------------------------------------------
// AI-AC-03 — OpenRouter is NOT the routing authority
// ---------------------------------------------------------------------------

test('AI-AC-03: the routing authority is the /ai-runtime module — routeTask and previewRouting are methods on AiRuntimeModuleApi', () => {
  // The public.ts declares the routing methods on the AiRuntimeModuleApi.
  assert.ok(
    aiRuntimePublic.includes('routeTask(input: {'),
    'AiRuntimeModuleApi.routeTask exists — the module owns the routing authority',
  );
  assert.ok(
    aiRuntimePublic.includes('previewRouting(input: {'),
    'AiRuntimeModuleApi.previewRouting exists — the module owns the routing preview authority',
  );
  assert.ok(
    aiRuntimePublic.includes('createRoutingPolicy(input: {'),
    'AiRuntimeModuleApi.createRoutingPolicy exists — the module owns the routing policy authority',
  );
  // The module implementation implements these methods.
  assert.ok(
    aiRuntimeModule.includes('async routeTask(') || aiRuntimeModule.includes('routeTask(input)'),
    'the module implementation provides routeTask',
  );
  assert.ok(
    aiRuntimeModule.includes('async previewRouting(') || aiRuntimeModule.includes('previewRouting(input)'),
    'the module implementation provides previewRouting',
  );
});

test('AI-AC-03: OpenRouter appears ONLY as an adapter implementation behind the provider-neutral contract', () => {
  // The OpenRouterAdapter class lives in the sanctioned adapter home.
  assert.ok(
    existsSync(src('modules', 'ai-runtime', 'internal', 'adapters', 'openrouter-adapter.ts')),
    'the OpenRouter adapter lives in the sanctioned adapter home',
  );
  // The OpenRouter adapter implements the ProviderAdapter contract.
  assert.ok(
    openrouterAdapter.includes('class OpenRouterAdapter implements ProviderAdapter'),
    'the OpenRouter adapter implements the ProviderAdapter contract (the PORT)',
  );
  // The adapter contract (the PORT) is the provider-neutral surface.
  assert.ok(
    adapterContract.includes('ProviderAdapter') && adapterContract.includes('AdapterRequest') && adapterContract.includes('AdapterResponse'),
    'the adapter contract exposes the provider-neutral PORT',
  );
});

test('AI-AC-03: NO domain module imports the OpenRouter adapter (or any adapter implementation)', () => {
  // The OpenRouter adapter is imported ONLY by the composition root (and
  // tests). Domain modules never import it.
  const adapterPath = join('src', 'modules', 'ai-runtime', 'internal', 'adapters', 'openrouter-adapter.ts');
  const importers = allSrcFiles.filter((f) =>
    importsOf(f).some((s) => s.includes('openrouter-adapter')),
  );
  // The composition root is allowed to import the adapter (wiring).
  // Tests are allowed (in tests/).
  // No domain module (src/modules/**) and no api/ route file imports the adapter.
  for (const importer of importers) {
    const rel = relative(repoRoot, importer);
    const isCompositionRoot = rel === join('src', 'composition-root.ts');
    const isTest = rel.startsWith(join('tests') + sep());
    const isAdapterItself = rel === adapterPath;
    assert.ok(
      isCompositionRoot || isTest || isAdapterItself,
      `${rel}: the OpenRouter adapter must be imported ONLY by the composition root or tests (AI-AC-03)`,
    );
  }
  // Explicit: the /ai-runtime module code does NOT import the OpenRouter adapter.
  for (const file of [
    aiRuntimePublic,
    aiRuntimeModule,
    routingPolicy,
    cascade,
    read(src('modules', 'ai-runtime', 'internal', 'ai-runtime-store.ts')),
    read(src('modules', 'ai-runtime', 'internal', 'ai-routing-store.ts')),
  ]) {
    assert.ok(
      !file.includes('openrouter-adapter') && !file.includes('OpenRouterAdapter'),
      'the /ai-runtime module code (public.ts, module.ts, store.ts, routing/, ai-routing-store.ts) does NOT import the OpenRouter adapter — the adapter is supplied by the caller at route time',
    );
  }
});

test('AI-AC-03: NO file anywhere in src/ imports a provider SDK package — the OpenRouter adapter uses the platform HttpCallPort', () => {
  const PROVIDER_SDK_PACKAGES: ReadonlyArray<string> = [
    'openai',
    '@openai/openai',
    '@azure/openai',
    'anthropic',
    '@anthropic-ai/sdk',
    '@google/generativeai',
    '@google-cloud/vertexai',
    '@google-cloud/aiplatform',
    '@google/genai',
    'cohere',
    'cohere-ai',
    '@mistralai/sdk',
    'replicate',
    'groq',
    'deepseek',
    'perplexity',
    'openrouter',
    '@openrouter/openrouter',
    'together',
    'together-ai',
    'ollama',
    '@aws-sdk/client-bedrock',
    '@aws-sdk/client-bedrock-runtime',
  ];
  const violations: string[] = [];
  for (const file of allSrcFiles) {
    const specifiers = importsOf(file);
    for (const specifier of specifiers) {
      for (const pkg of PROVIDER_SDK_PACKAGES) {
        if (specifier === pkg || specifier.startsWith(`${pkg}/`)) {
          violations.push(`${relative(repoRoot, file)} imports provider SDK '${specifier}'`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], 'no provider SDK is imported anywhere in src/ (AI-AC-03 + AI-AC-02)');
});

test('AI-AC-03: the OpenRouter adapter uses the platform HttpCallPort (fetch-based, no SDK)', () => {
  // The adapter imports the platform HttpCallPort contract.
  assert.ok(
    openrouterAdapter.includes("from '../../../../platform/http/outbound.ts'"),
    'the OpenRouter adapter imports the platform HttpCallPort contract (fetch-based, no SDK)',
  );
  // The adapter does NOT import any external package (other than node builtins).
  for (const specifier of importsOf(src('modules', 'ai-runtime', 'internal', 'adapters', 'openrouter-adapter.ts'))) {
    if (specifier.startsWith('node:')) continue;
    assert.ok(
      specifier.startsWith('.') || specifier.startsWith('../'),
      `the OpenRouter adapter imports non-relative module '${specifier}' — provider SDKs are forbidden (AI-AC-03)`,
    );
  }
});

test('AI-AC-03: the routing core depends on the adapter CONTRACT (ports), not implementations', () => {
  // The cascade executor imports the ProviderAdapter type from the public
  // entry (the PORT), not the OpenRouterAdapter implementation.
  assert.ok(
    cascade.includes('ProviderAdapter') && !cascade.includes('OpenRouterAdapter'),
    'the cascade executor depends on the ProviderAdapter PORT, not the OpenRouter implementation',
  );
  // The ai-runtime-module.ts (the routing core) does NOT import the adapter
  // implementation directory.
  assert.ok(
    !aiRuntimeModule.includes('adapters/'),
    'the routing core does not import the adapter directory — the adapter is supplied by the caller',
  );
});

// ---------------------------------------------------------------------------
// AI-AC-07 — capability non-clipping (static half)
// ---------------------------------------------------------------------------

test('AI-AC-07: the routing policy code does NOT mutate the registry record (readonly inputs, new output objects)', () => {
  // The computeEligibility, computeRanking, computeTradeoff, selectModel
  // function signatures take readonly inputs.
  assert.ok(
    routingPolicy.includes('readonly taskProfile: TaskProfileRecord') &&
      routingPolicy.includes('readonly models: readonly ModelRegistryRecord[]') &&
      routingPolicy.includes('readonly eligibleModels: readonly ModelRegistryRecord[]'),
    'the routing policy functions take readonly inputs (the registry record is read-only)',
  );
  // The functions return new RankingScore/TradeoffScore/EligibilityDecision
  // objects — they do not mutate the input models.
  assert.ok(
    routingPolicy.includes('satisfies RankingScore') || routingPolicy.includes('satisfies TradeoffScore'),
    'the routing functions return new score objects (satisfies RankingScore / TradeoffScore)',
  );
  // The code does NOT contain assignments to model.capabilities, model.toolFeatures, or model.qualitySignals.
  assert.ok(
    !/model\.(capabilities|toolFeatures|qualitySignals)\s*=/.test(routingPolicy),
    'the routing code never assigns to model.capabilities, model.toolFeatures, or model.qualitySignals (AI-AC-07)',
  );
});

test('AI-AC-07: the migration 020 routing tables do NOT carry capability-clipping columns', () => {
  // The routing policy content is a bounded JSON object (interpreted by the
  // routing core), not a clipped capability matrix.
  const block = migration020.slice(
    migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_routing_policies'),
    migration020.indexOf(');', migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_routing_policies')),
  );
  assert.ok(/policy_content\s+jsonb/.test(block), 'the routing policy content is a bounded JSON object');
  // No capability-clipping columns.
  for (const forbidden of ['clipped_capabilities', 'normalized_capabilities', 'clipped_quality_signals']) {
    assert.ok(
      !migration020.includes(forbidden),
      `migration 020 must NOT carry capability-clipping column '${forbidden}' (AI-AC-07)`,
    );
  }
});

test('AI-AC-07: the migration 020 creates the routing tables with the §8 fences + append-only triggers', () => {
  // The (workspace_id, idempotency_key) §8-style fence on routing policies.
  assert.ok(
    migration020.includes('CONSTRAINT ai_routing_policies_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the (workspace, key) §8-style create fence exists on ai_routing_policies',
  );
  // The (workspace_id, policy_name) partial unique index among ACTIVE entries.
  assert.ok(
    migration020.includes('ai_routing_policies_active_name_fence'),
    'the (workspace, policy_name) ACTIVE-pair fence exists',
  );
  // Selection decisions are append-only (UPDATE and DELETE rejected).
  assert.ok(
    migration020.includes('BEFORE UPDATE OR DELETE ON ai_selection_decisions') &&
      migration020.includes('ai_selection_decisions_append_only'),
    'ai_selection_decisions rejects UPDATE and DELETE (append-only history — AI-AC-06)',
  );
  // Cascade steps are append-only.
  assert.ok(
    migration020.includes('BEFORE UPDATE OR DELETE ON ai_cascade_steps') &&
      migration020.includes('ai_cascade_steps_append_only'),
    'ai_cascade_steps rejects UPDATE and DELETE (append-only history — §5 replayable cascade)',
  );
  // Routing policy content is immutable.
  assert.ok(
    migration020.includes('ai_routing_policies_content_immutable'),
    'routing policy content is DB-immutable (append-oriented registry)',
  );
  // Retired is terminal.
  assert.ok(
    migration020.includes('ai_routing_policies_retired_terminal'),
    'routing policy retired is terminal',
  );
  // Scope-chain triggers.
  assert.ok(
    migration020.includes('ai_routing_policies_scope_chain') &&
      migration020.includes('ai_selection_decisions_scope_chain') &&
      migration020.includes('ai_cascade_runs_scope_chain'),
    'the scope-chain triggers exist on routing policies, selection decisions, and cascade runs',
  );
});

test('AI-AC-03: migration 020 creates EXACTLY the four routing tables — no evaluation/invocation scope (MKT-018 bounds)', () => {
  const created = [...migration020.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created.sort(), [
    'ai_cascade_runs',
    'ai_cascade_steps',
    'ai_routing_policies',
    'ai_selection_decisions',
  ]);
  // And NOTHING from the sibling Work Items' scope: no evaluation result
  // tables (MKT-019), no invocation/adapter tables, no provider-state tables.
  for (const forbidden of [
    'ai_evaluations',
    'ai_evaluation_results',
    'ai_invocations',
    'ai_provider_state',
    'ai_provider_credentials',
  ]) {
    assert.ok(
      !migration020.includes(forbidden),
      `migration 020 must not create '${forbidden}' — that is MKT-019 scope or out of bounds`,
    );
  }
});

test('AI-AC-06: the selection-decision record carries the §24 telemetry payload (eligible set, ranking, tradeoff, chosen model, phase trace)', () => {
  const block = migration020.slice(
    migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_selection_decisions'),
    migration020.indexOf(');', migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_selection_decisions')),
  );
  for (const required of [
    'selection_id',
    'workspace_id',
    'client_id',
    'agency_id',
    'task_profile_id',
    'routing_policy_id',
    'eligible_set',
    'ranking',
    'tradeoff',
    'chosen_model_registry_id',
    'cascade_run_id',
    'phase_trace',
    'authoritative',
    'observed_latency_ms',
    'observed_cost_amount',
    'evaluation_ref',
    'correlation_id',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'created_at',
  ]) {
    assert.ok(block.includes(required), `ai_selection_decisions.${required} required (AI-AC-06 telemetry payload)`);
  }
  // The authoritative flag records whether the decision was AUTHORITATIVE
  // (the cascade invoked models and observed cost/latency) or SPECULATIVE.
  assert.ok(/authoritative\s+boolean/.test(block), 'the authoritative flag exists (AI-AC-06)');
});

test('AI-AC-05: the cascade run + cascade step tables carry the replayable cascade structure', () => {
  const runBlock = migration020.slice(
    migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_cascade_runs'),
    migration020.indexOf(');', migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_cascade_runs')),
  );
  for (const required of [
    'cascade_run_id',
    'workspace_id',
    'task_profile_id',
    'routing_policy_id',
    'status',
    'final_model_registry_id',
    'escalation_count',
    'max_escalations',
    'correlation_id',
    'idempotency_key',
    'version',
  ]) {
    assert.ok(runBlock.includes(required), `ai_cascade_runs.${required} required (AI-AC-05 replayable cascade)`);
  }
  // The cascade status vocabulary.
  assert.ok(
    runBlock.includes("CHECK (status IN ('running', 'completed', 'escalated', 'failed', 'unknown'))"),
    'the cascade status CHECK includes unknown (frozen UNKNOWN semantics)',
  );
  // The cascade steps table.
  const stepBlock = migration020.slice(
    migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_cascade_steps'),
    migration020.indexOf(');', migration020.indexOf('CREATE TABLE IF NOT EXISTS ai_cascade_steps')),
  );
  for (const required of [
    'cascade_step_id',
    'cascade_run_id',
    'step_index',
    'model_registry_id',
    'step_type',
    'validator_result',
    'validator_reason',
    'observed_latency_ms',
    'observed_cost_amount',
    'outcome',
  ]) {
    assert.ok(stepBlock.includes(required), `ai_cascade_steps.${required} required (AI-AC-05 cascade step record)`);
  }
  // The step type vocabulary (§5: cheap-first, fan-out, escalate, frontier, human).
  assert.ok(
    stepBlock.includes("CHECK (step_type IN ('cheap-first', 'fan-out', 'escalate', 'frontier', 'human'))"),
    'the cascade step type CHECK enumerates the §5 vocabulary',
  );
  // The validator result vocabulary.
  assert.ok(
    stepBlock.includes("CHECK (validator_result IN ('pending', 'passed', 'failed', 'unknown'))"),
    'the validator result CHECK includes unknown (frozen UNKNOWN semantics)',
  );
});

// ---------------------------------------------------------------------------
// Helper for the cross-platform path separator
// ---------------------------------------------------------------------------

const sep = () => (process.platform === 'win32' ? '\\' : '/');
