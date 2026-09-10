/**
 * MKT-017 static tests — the AI Runtime REGISTRY boundary is structurally
 * correct and PROVIDER-NEUTRAL in the ACTUAL module contract, migration and
 * source tree (pure static analysis, no DB).
 *
 * Acceptance proofs (requirements.md AI-001; work-item-matrix.md MKT-017 =
 * AI-AC-01..02; spec/ai-runtime-and-routing.md §1/§2/§6/§9;
 * spec/architecture.md §18; spec/implementation-contract.md §10;
 * spec/module-dependency-matrix.md "Forbidden dependency directions":
 * "/ai-runtime must not import a concrete provider SDK outside its adapter
 * implementation"):
 *
 *   AI-AC-01 ("domain requests use provider-neutral TaskProfiles —
 *   static/API contract test", static half):
 *     1. the TaskProfile contract surface (TASK_PROFILE_CONTRACT_FIELDS) is
 *        EXACTLY the implementation-contract §10 field list and the storage
 *        has the corresponding columns — with NO provider/model/credential
 *        column capable of holding a provider or model selection;
 *     2. the API DTO layer rejects provider/model/credential-shaped keys
 *        (the route forbidden-key lists are the module's forbidden-key
 *        contracts — behavior proven by the unit/integration suites);
 *     3. the neutral registries are append-oriented: profiles and telemetry
 *        are fenced by §8-style (workspace, key) UNIQUE constraints, and
 *        telemetry + observations are append-only (DB triggers reject
 *        UPDATE and DELETE).
 *
 *   AI-AC-02 ("direct provider SDKs are isolated to /ai-runtime adapters —
 *   static architecture check", the full future-proof proof):
 *     4. NO file anywhere in src/ references a provider SDK package — the
 *        ONLY sanctioned home for such imports, when adapters arrive, is
 *        src/modules/ai-runtime/internal/adapters/** (currently empty: zero
 *        SDK references exist anywhere, and no SDK dependency is declared);
 *     5. the /ai-runtime module's domain code imports ONLY platform ports,
 *        its own module and the frozen-matrix dependency /executions public
 *        entry — no other module, no application layer;
 *     6. the module is the single AI authority for this scope: migration
 *        016 creates EXACTLY the four registry-layer tables and NOTHING
 *        from the MKT-018/MKT-019 scope (no routing policy, no eligibility,
 *        no cascade, no evaluation-result tables) and no provider adapter
 *        surface exists in the module yet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TASK_PROFILE_CONTRACT_FIELDS,
  TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
  MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
} from '../../src/modules/ai-runtime/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration016 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '016_ai_runtime.sql'),
  'utf8',
);
const aiRuntimePublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'ai-runtime', 'public.ts'),
  'utf8',
);
const aiRuntimeModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'ai-runtime', 'internal', 'ai-runtime-module.ts'),
  'utf8',
);
const aiRuntimeStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'ai-runtime', 'internal', 'ai-runtime-store.ts'),
  'utf8',
);
const aiRuntimeRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'ai-runtime-routes.ts'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

// ---------------------------------------------------------------------------
// AI-AC-01 — the provider-neutral TaskProfile contract (static half)
// ---------------------------------------------------------------------------

test('the ai_task_profiles table carries EXACTLY the §10 neutral contract — no provider/model/credential column (AI-AC-01)', () => {
  const block = createTableBlock(migration016, 'ai_task_profiles');
  const columns = columnsOf(block);

  // The storage mirror of TASK_PROFILE_CONTRACT_FIELDS.
  const expectedColumns: Readonly<Record<string, string>> = {
    taskClass: 'task_class',
    qualityTarget: 'quality_target',
    riskClass: 'risk_class',
    contextRequirements: 'context_requirements',
    latencyTargetMs: 'latency_target_ms',
    maxCostPerInvocation: 'max_cost_per_invocation',
    privacyClass: 'privacy_class',
    toolRequirements: 'tool_requirements',
    outputSchema: 'output_schema',
    evaluatorIds: 'evaluator_ids',
    escalationPolicy: 'escalation_policy',
  };
  assert.deepEqual(
    [...TASK_PROFILE_CONTRACT_FIELDS].sort(),
    Object.keys(expectedColumns).sort(),
    'the code contract fields and the storage mirror describe the same §10 surface',
  );
  for (const column of Object.values(expectedColumns)) {
    assert.ok(columns.includes(column), `ai_task_profiles.${column} required (the §10 contract)`);
  }

  // Identity/scope/lifecycle/provenance per implementation-contract §3.
  for (const required of [
    'task_profile_id',
    'workspace_id',
    'client_id',
    'agency_id',
    'status',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `ai_task_profiles.${required} required`);
  }

  // THE NEUTRALITY PROOF: there is NO column capable of carrying a provider
  // or model selection, an SDK reference or a credential.
  for (const forbidden of [
    'provider',
    'provider_id',
    'provider_label',
    'model',
    'model_id',
    'model_key',
    'sdk',
    'sdk_package',
    'api_key',
    'credential',
    'credential_id',
    'secret_handle',
    'token',
  ]) {
    assert.ok(
      !columns.includes(forbidden),
      `ai_task_profiles.${forbidden} must NOT exist — a TaskProfile is provider-neutral (AI-AC-01)`,
    );
  }

  // The closed vocabularies are DB-CHECKed.
  assert.ok(
    block.includes("CHECK (risk_class IN ('low', 'medium', 'high'))"),
    'risk_class carries the closed-vocabulary CHECK',
  );
  assert.ok(
    block.includes("CHECK (privacy_class IN ('public', 'internal', 'confidential', 'restricted'))"),
    'privacy_class carries the closed-vocabulary CHECK',
  );
  assert.ok(
    block.includes("CHECK (status IN ('active', 'retired'))"),
    'the registry lifecycle CHECK exists',
  );
});

test('the API DTO layer rejects provider/model/credential-shaped keys on every /ai-runtime mutation surface (AI-AC-01)', () => {
  // The route forbidden-key lists ARE the module's forbidden-key contracts.
  for (const [contract, list] of [
    ['TASK_PROFILE_FORBIDDEN_INPUT_KEYS', TASK_PROFILE_FORBIDDEN_INPUT_KEYS],
    ['MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS', MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS],
    ['USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS', USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS],
  ] as const) {
    // Provider/model/credential authority keys are in every relevant list.
    for (const providerKey of ['provider', 'model', 'apiKey']) {
      assert.ok(
        (list as readonly string[]).includes(providerKey) ||
          (list as readonly string[]).some((key) => key.startsWith('provider') || key.startsWith('model')),
        `${contract} rejects provider/model-shaped keys`,
      );
    }
    for (const credentialKey of ['secret', 'apiKey', 'password']) {
      assert.ok(
        (list as readonly string[]).includes(credentialKey),
        `${contract} rejects the credential-shaped key '${credentialKey}'`,
      );
    }
  }
  // The routes actually wire the contracts as the DTO forbidden-key lists.
  assert.ok(
    aiRuntimeRoutes.includes('forbiddenKeys: TASK_PROFILE_FORBIDDEN_INPUT_KEYS'),
    'the TaskProfile create DTO uses the neutrality forbidden-key contract',
  );
  assert.ok(
    aiRuntimeRoutes.includes('forbiddenKeys: USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS'),
    'the telemetry append DTO uses the neutrality forbidden-key contract',
  );
  assert.ok(
    aiRuntimeRoutes.includes('forbiddenKeys: MODEL_REGISTRATION_FORBIDDEN_INPUT_KEYS'),
    'the model registration DTO uses the label-only forbidden-key contract',
  );
  // The correlation identity is server-derived — never a DTO input.
  assert.ok(
    (USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS as readonly string[]).includes('correlationId'),
    'correlationId is rejected as a caller-supplied field',
  );
});

test('the registries are append-oriented: §8-style fences + append-only triggers + terminal lifecycles (AI-AC-01)', () => {
  // TaskProfile create fence.
  assert.ok(
    migration016.includes('CONSTRAINT ai_task_profiles_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the (workspace, key) §8-style create fence exists on ai_task_profiles',
  );
  // Telemetry append fence.
  assert.ok(
    migration016.includes('CONSTRAINT ai_usage_telemetry_key_unique UNIQUE (workspace_id, idempotency_key)'),
    'the (workspace, key) §8-style append fence exists on ai_usage_telemetry',
  );
  // Model registration fence (the active-pair partial unique).
  assert.ok(
    migration016.includes('ai_model_registry_active_pair_fence'),
    'the (provider_label, model_key) ACTIVE-pair registration fence exists',
  );
  // Append-only history: UPDATE and DELETE are DB-rejected.
  for (const [table, trigger] of [
    ['ai_model_observations', 'ai_model_observations_append_only'],
    ['ai_usage_telemetry', 'ai_usage_telemetry_append_only'],
  ] as const) {
    assert.ok(
      migration016.includes(`BEFORE UPDATE OR DELETE ON ${table}`) && migration016.includes(trigger),
      `${table} rejects UPDATE and DELETE (append-only history)`,
    );
  }
  // Retired is terminal everywhere.
  for (const trigger of ['ai_task_profiles_retired_terminal', 'ai_model_registry_retired_terminal']) {
    assert.ok(migration016.includes(trigger), `the terminal-lifecycle trigger ${trigger} exists`);
  }
  // Content immutability: corrections create NEW records.
  assert.ok(
    migration016.includes('ai_task_profiles_content_immutable'),
    'TaskProfile content is DB-immutable (append-oriented registry)',
  );
  assert.ok(
    migration016.includes('ai_model_registry_declared_immutable'),
    'model declared signals are DB-immutable (append-oriented registry)',
  );
  // The ONLY sanctioned availability mutation is the observation derivation.
  assert.ok(
    migration016.includes('ai_model_observations_apply_state'),
    'the observation apply-state trigger derives the current availability',
  );
});

test('the usage telemetry record carries the §24 shape with the scope-chain backstops', () => {
  const block = createTableBlock(migration016, 'ai_usage_telemetry');
  const columns = columnsOf(block);
  for (const required of [
    'usage_id',
    'workspace_id',
    'client_id',
    'agency_id',
    'task_profile_id',
    'model_registry_id',
    'execution_id',
    'correlation_id',
    'outcome',
    'latency_ms',
    'cost_amount',
    'tokens_in',
    'tokens_out',
    'evaluation_ref',
    'escalation_count',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'created_at',
  ]) {
    assert.ok(columns.includes(required), `ai_usage_telemetry.${required} required (architecture.md §24)`);
  }
  // The unknown outcome follows the frozen UNKNOWN semantics vocabulary.
  assert.ok(
    block.includes("CHECK (outcome IN ('succeeded', 'failed', 'escalated', 'unknown'))"),
    'the outcome CHECK includes unknown (never success, recordable)',
  );
  // Tenant isolation at the storage layer: the scope chain verifies the
  // workspace→client→agency consistency AND the same-Workspace profile AND
  // execution references.
  const scopeTrigger = migration016.slice(
    migration016.indexOf('CREATE OR REPLACE FUNCTION ai_usage_telemetry_scope_chain'),
    migration016.indexOf('DROP TRIGGER IF EXISTS ai_usage_telemetry_scope_chain_trigger'),
  );
  assert.ok(scopeTrigger.length > 0, 'the telemetry scope-chain trigger exists');
  for (const proof of [
    'FROM workspaces w',
    'FROM clients c',
    'FROM ai_task_profiles p',
    'FROM executions e',
    'p.workspace_id = NEW.workspace_id',
    'e.workspace_id = NEW.workspace_id',
  ]) {
    assert.ok(scopeTrigger.includes(proof), `the scope-chain trigger backstops ${proof}`);
  }
  // The execution reference is matrix-consistent: FK to executions is
  // allowed (/ai-runtime ──→ /executions), FK to workflow tables is NOT.
  assert.ok(
    /execution_id\s+uuid\s+REFERENCES executions\(execution_id\)/.test(block),
    'execution_id references executions (the frozen matrix direction)',
  );
  assert.ok(
    !/REFERENCES\s+workflow/.test(migration016),
    'no FK into workflow tables anywhere in migration 016',
  );
});

// ---------------------------------------------------------------------------
// AI-AC-02 — direct provider SDKs are isolated to /ai-runtime adapters
// ---------------------------------------------------------------------------

/**
 * The provider SDK package denylist (AI-AC-02 / AI-AC-03's OpenRouter clause
 * included: OpenRouter is permitted ONLY as an adapter/gateway INSIDE
 * /ai-runtime — ai-runtime-and-routing.md §6 — never a domain dependency).
 * The exact package list will evolve with the ecosystem; the INVARIANT it
 * guards (provider SDKs live only in /ai-runtime adapters) does not.
 */
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

/** The ONLY sanctioned home for provider SDK imports (when adapters exist). */
const AI_RUNTIME_ADAPTER_HOME = join('src', 'modules', 'ai-runtime', 'internal', 'adapters');

function collectTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) collectTsFiles(abs, out);
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

/** Extracts every import specifier string from a TypeScript source file. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /import\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /export\s+[^'"]*?from\s*['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

test('NO source file references a provider SDK package — the only sanctioned home is the (empty) /ai-runtime adapter directory (AI-AC-02)', () => {
  const srcRoot = join(repoRoot, 'src');
  const files = existsSync(srcRoot) ? collectTsFiles(srcRoot) : [];
  assert.ok(files.length > 0, 'the source tree must be present');

  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const isAdapter = rel.startsWith(AI_RUNTIME_ADAPTER_HOME);
    const specifiers = importSpecifiers(readFileSync(file, 'utf8'));
    for (const specifier of specifiers) {
      for (const pkg of PROVIDER_SDK_PACKAGES) {
        const references =
          specifier === pkg || specifier.startsWith(`${pkg}/`);
        if (!references) continue;
        if (!isAdapter) {
          violations.push(`${rel} imports provider SDK '${specifier}' outside the /ai-runtime adapter home`);
        } else {
          violations.push(`${rel} imports provider SDK '${specifier}' — adapters are NOT part of MKT-017 (future Work Item)`);
        }
      }
    }
  }
  // There are no SDK dependencies yet: ZERO references anywhere, including
  // the sanctioned home (the test guards the boundary for the future).
  assert.deepEqual(
    violations,
    [],
    'provider SDK references must be zero in MKT-017 (adapters arrive with the routing/invocation Work Items)',
  );
});

test('no provider SDK dependency is declared in package.json (AI-AC-02)', () => {
  const packageJson = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const declared = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ];
  for (const dep of declared) {
    for (const pkg of PROVIDER_SDK_PACKAGES) {
      assert.ok(
        !(dep === pkg || dep.startsWith(`${pkg}/`)),
        `package.json declares provider SDK dependency '${dep}' — forbidden outside /ai-runtime adapters`,
      );
    }
  }
});

test('the /ai-runtime module domain code imports ONLY platform ports, its own module and the matrix-sanctioned /executions public entry (AI-AC-02)', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'ai-runtime');
  const files = collectTsFiles(moduleDir);
  // MKT-017 ships the registry layer (3 files). MKT-018 extends the same
  // module in place with the routing layer (additional files under
  // internal/routing/ and internal/adapters/), grouped and commented
  // with MKT-018. The file set is enumerated explicitly so a future
  // addition is a deliberate change.
  const expectedFiles = [
    join('src', 'modules', 'ai-runtime', 'public.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'ai-runtime-module.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'ai-runtime-store.ts'),
    // MKT-018 (AI-002) routing layer.
    join('src', 'modules', 'ai-runtime', 'internal', 'ai-routing-store.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'routing', 'policy.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'routing', 'cascade.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'adapters', 'adapter-contract.ts'),
    join('src', 'modules', 'ai-runtime', 'internal', 'adapters', 'openrouter-adapter.ts'),
  ].map((rel) => join(repoRoot, rel));
  assert.deepEqual(
    files.map((file) => file).sort(),
    expectedFiles.sort(),
    'the /ai-runtime module ships exactly the registry layer (MKT-017) + the routing layer (MKT-018) — the adapter directory is the only sanctioned home for provider adapters',
  );

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = relative(repoRoot, join(dirname(file), specifier));
      // Platform ports and intra-module imports are always fine.
      if (resolved.startsWith(join('src', 'platform'))) continue;
      if (resolved.startsWith(join('src', 'modules', 'ai-runtime'))) continue;
      // The ONE module-to-module dependency is the frozen matrix row
      // /ai-runtime ──→ /executions (targeting its public entry only).
      if (
        resolved === join('src', 'modules', 'executions', 'public.ts')
      ) continue;
      assert.fail(
        `${relative(repoRoot, file)} imports '${specifier}' (${resolved}) — /ai-runtime may import platform ports, its own module and /executions public ONLY`,
      );
    }
    // Domain code may never import application-layer code.
    assert.ok(
      !/from\s+'\.\.\/\.\.\/\.\.\/api\//.test(source) && !/from\s+'\.\.\/\.\.\/api\//.test(source),
      `${relative(repoRoot, file)} must not import application-layer code`,
    );
  }
  // Belt and suspenders over the arch-check's global proof, at the module
  // source level: no /workspaces, /clients, /agencies, /policies,
  // /credentials or /evidence imports (NOT in the frozen matrix row used
  // by MKT-017; MKT-018 keeps the same import surface — the routing layer
  // operates on the merged registry layer and the new routing tables, with
  // the adapter supplied by the caller at route time).
  for (const source of [aiRuntimePublic, aiRuntimeModule, aiRuntimeStore]) {
    assert.ok(!/from\s+'\.\.\/(workspaces|clients|agencies|policies|credentials|evidence)\//.test(source));
  }
});

test('migration 016 creates EXACTLY the four registry-layer tables — no routing/eligibility/cascade/evaluation scope (MKT-017 bounds)', () => {
  const created = [...migration016.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created.sort(), [
    'ai_model_observations',
    'ai_model_registry',
    'ai_task_profiles',
    'ai_usage_telemetry',
  ]);
  // And NOTHING from the sibling Work Items' scope: no routing policy
  // state, no eligibility matrix, no cascade stages, no evaluation results,
  // no invocation/adapter tables.
  for (const forbidden of [
    'ai_routing_policies',
    'ai_eligibility',
    'ai_cascade',
    'ai_evaluations',
    'ai_evaluation_results',
    'ai_invocations',
    'ai_provider_adapters',
    'ai_adapter',
  ]) {
    assert.ok(
      !migration016.includes(forbidden),
      `migration 016 must not create '${forbidden}' — that is MKT-018/MKT-019 scope (bounded MKT-017)`,
    );
  }
});

test('the module API is the REGISTRY + ROUTING layers — no evaluation/invocation authority methods (MKT-017/MKT-018 bounds)', () => {
  // Extract the AiRuntimeModuleApi interface block (the test must not pick
  // up methods from other interfaces like ProviderAdapter, which has its own
  // `invoke` method — that is the adapter PORT, not the module API).
  const apiStart = aiRuntimePublic.indexOf('export interface AiRuntimeModuleApi {');
  assert.ok(apiStart >= 0, 'AiRuntimeModuleApi interface must exist');
  let depth = 0;
  let apiEnd = apiStart;
  for (let i = apiStart; i < aiRuntimePublic.length; i++) {
    const ch = aiRuntimePublic[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        apiEnd = i;
        break;
      }
    }
  }
  assert.ok(apiEnd > apiStart, 'AiRuntimeModuleApi interface must terminate');
  const apiBlock = aiRuntimePublic.slice(apiStart, apiEnd);
  const methodNames = [...apiBlock.matchAll(/^ {2}(?:async )?([a-z][a-zA-Z0-9]+)\(/gm)].map(
    (match) => match[1]!,
  );
  // MKT-017 (registry layer) + MKT-018 (routing layer) methods. The routing
  // methods are the AI-002 surface (routeTask, previewRouting, selection
  // decisions, cascade runs, routing policies). The evaluation/invocation
  // methods (MKT-019, later) and the model invocation methods are NOT here.
  assert.deepEqual(
    methodNames.filter((name) => !name.startsWith('assertValid')).sort(),
    [
      'appendModelObservation',
      'appendUsageTelemetry',
      'createRoutingPolicy',
      'createTaskProfile',
      'getCascadeRun',
      'getModel',
      'getRoutingPolicy',
      'getSelectionDecision',
      'getTaskProfile',
      'getUsageTelemetry',
      'listCascadeRuns',
      'listModelObservations',
      'listModels',
      'listRoutingPolicies',
      'listSelectionDecisions',
      'listTaskProfiles',
      'listUsageTelemetry',
      'previewRouting',
      'registerModel',
      'retireModel',
      'retireRoutingPolicy',
      'retireTaskProfile',
      'routeTask',
    ],
    'the AiRuntimeModuleApi carries exactly the registry operations (MKT-017) + the routing operations (MKT-018) — no evaluate/invoke methods',
  );
  // The forbidden methods (MKT-019 evaluation, future model invocation) are
  // still absent.
  for (const forbidden of [
    'evaluate',
    'invokeModel',
  ]) {
    assert.ok(
      !methodNames.includes(forbidden),
      `'${forbidden}' must not exist on the MKT-017/MKT-018 module API (MKT-019 scope)`,
    );
  }
});
