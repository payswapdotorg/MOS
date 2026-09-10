/**
 * MKT-020 static tests — the logical Agent/Capability boundary is
 * structurally correct and PROVIDER-NEUTRAL in the ACTUAL module
 * contract, migration, routes and source tree (pure static analysis, no
 * DB).
 *
 * Acceptance proofs (requirements.md AGENT-001; work-item-matrix.md
 * MKT-020 = "provider-neutral capability tests"; spec/architecture.md
 * §12 "Agent is a logical reusable capability. It does not own tenant
 * data, workflow state, deployment state or infrastructure";
 * spec/adr/ADR-0002 "Agent Is a Logical Capability, Not a VM";
 * spec/module-dependency-matrix.md "/agents ──→ /executions, /ai-runtime,
 * /policies"; spec/tenant-runtime-model.md hard rule 3 "Agent IDs never
 * grant access to Client data"):
 *
 *   1. the logical_agents storage carries EXACTLY the provider-neutral
 *      contract columns (identity triple + capabilities + contract text)
 *      plus identity/scope/lifecycle/provenance — and NO column capable
 *      of holding a provider/model/SDK/credential selection, an
 *      infrastructure reference (sandbox/pool/queue/runtime/deployment)
 *      or a tenant/workflow/execution reference (§12, the AC's
 *      "no client/workspace/goal/workflow/execution tables" storage
 *      half — the table references ONLY agencies, the ownership root);
 *   2. the capability descriptor shape is DB-CHECKed (function-based
 *      CHECK): a stored descriptor is exactly { capabilityKind,
 *      parameters };
 *   3. the registry is append-oriented: §8-style command fences per
 *      scope, ACTIVE declaration fences per scope, content immutability,
 *      retired-terminal (no second retirement) and the append-only
 *      lifecycle history with the once-per-transition fence;
 *   4. the /agents module domain code imports ONLY platform ports and
 *      its own module — NO cross-module imports at all (not even the
 *      matrix-allowed /executions, /ai-runtime, /policies: the logical
 *      capability contract composes none of them), NO provider SDK
 *      references, NO infrastructure coupling (no sandbox/pool/queue/
 *      cache/lock/objects/secrets platform imports), NO 'pg' import and
 *      no application-layer imports;
 *   5. the module API is exactly the registry surface
 *      (registerAgent/getAgent/listAgents/retireAgent/listLifecycleEvents)
 *      — NO execution/invoke/dispatch/deploy methods (no execution
 *      engine, §12);
 *   6. the API DTO layer wires the provider-neutrality forbidden-key
 *      contracts on every /agents mutation surface, and the route set is
 *      exactly the seven frozen MKT-020 routes (register platform /
 *      register agency / list platform / list agency / read / retire /
 *      lifecycle history — no update, no delete, no invocation);
 *   7. the shared registration files wire the module: application.ts
 *      exposes AgentsModuleApi, routes.ts registers the routes, the
 *      composition root constructs the module with platform ports only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOGICAL_AGENT_CONTRACT_FIELDS,
  LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
} from '../../src/modules/agents/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration022 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '022_logical_agents.sql'),
  'utf8',
);
const agentsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'agents', 'public.ts'),
  'utf8',
);
const agentsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'agents', 'internal', 'module.ts'),
  'utf8',
);
const agentsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'agents', 'internal', 'store.ts'),
  'utf8',
);
const agentsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'agents-routes.ts'),
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

// ---------------------------------------------------------------------------
// 1. The provider-neutral storage contract (§12)
// ---------------------------------------------------------------------------

test('the logical_agents table carries EXACTLY the provider-neutral declaration contract — no provider/credential/infra/tenant column (AGENT-001)', () => {
  const block = createTableBlock(migration022, 'logical_agents');
  const columns = columnsOf(block);

  // The storage mirror of LOGICAL_AGENT_CONTRACT_FIELDS.
  const expectedColumns: Readonly<Record<string, string>> = {
    agentKey: 'agent_key',
    displayName: 'display_name',
    versionLabel: 'version_label',
    description: 'description',
    capabilities: 'capabilities',
  };
  assert.deepEqual(
    [...LOGICAL_AGENT_CONTRACT_FIELDS].sort(),
    Object.keys(expectedColumns).sort(),
    'the code contract fields and the storage mirror describe the same MKT-020 surface',
  );
  for (const column of Object.values(expectedColumns)) {
    assert.ok(columns.includes(column), `logical_agents.${column} required (the declaration contract)`);
  }

  // Identity/scope/lifecycle/provenance per implementation-contract §3.
  for (const required of [
    'agent_id',
    'agency_id',
    'status',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'version',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(columns.includes(required), `logical_agents.${required} required`);
  }

  // THE NEUTRALITY PROOF: there is NO column capable of carrying a
  // provider or model selection, an SDK reference, a credential, an
  // infrastructure reference (sandbox/pool/queue/runtime/deployment) or
  // a tenant/workflow/execution reference (architecture.md §12 — the
  // logical Agent owns none of them).
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
    'sandbox',
    'sandbox_id',
    'pool',
    'pool_id',
    'queue',
    'queue_id',
    'runtime',
    'runtime_class',
    'deployment',
    'deployment_id',
    'endpoint',
    'client_id',
    'workspace_id',
    'goal_id',
    'workflow_id',
    'execution_id',
    'task_id',
  ]) {
    assert.ok(
      !columns.includes(forbidden),
      `logical_agents.${forbidden} must NOT exist — the logical Agent owns no tenant data, workflow state, deployment state or infrastructure (architecture.md §12)`,
    );
  }

  // The closed lifecycle vocabulary is DB-CHECKed.
  assert.ok(
    block.includes("CHECK (status IN ('active', 'retired'))"),
    'the registry lifecycle CHECK exists (the single edge active → retired)',
  );
  // The ownership scope: nullable agency_id (NULL = platform scope, set =
  // the owning Agency) referencing agencies ONLY — no client/workspace.
  assert.ok(
    /agency_id\s+uuid\s+REFERENCES agencies\(agency_id\)/.test(block),
    'the ownership scope references agencies only (the ownership root)',
  );
  assert.ok(
    !/REFERENCES\s+(clients|workspaces|goals|workflows|executions|deployments)/.test(migration022),
    'no FK into client/workspace/goal/workflow/execution/deployment tables anywhere in migration 022',
  );
});

test('the capability descriptor shape is DB-CHECKed: every stored descriptor is exactly { capabilityKind, parameters }', () => {
  assert.ok(
    migration022.includes('logical_agents_capabilities_valid'),
    'the descriptor shape validator function exists',
  );
  assert.ok(
    /CHECK \(logical_agents_capabilities_valid\(capabilities\)\)/.test(migration022),
    'the capabilities column carries the shape CHECK',
  );
  // The validator enforces exactly two keys and their types.
  for (const fragment of [
    "key_count <> 2",
    "elem ? 'capabilityKind'",
    "elem ? 'parameters'",
    "jsonb_typeof(elem->'capabilityKind') <> 'string'",
    "jsonb_typeof(elem->'parameters') <> 'object'",
  ]) {
    assert.ok(
      migration022.includes(fragment),
      `the descriptor shape validator guards ${fragment}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Append-oriented registry semantics (fences, immutability, history)
// ---------------------------------------------------------------------------

test('the registry is append-oriented: §8-style command fences + ACTIVE declaration fences + terminal lifecycle (AGENT-001)', () => {
  // The §8-style logical register-command fences, per scope (platform
  // rows carry agency_id NULL; agency rows carry it set).
  assert.ok(
    migration022.includes('logical_agents_platform_command_fence') &&
      /ON logical_agents \(idempotency_key\) WHERE agency_id IS NULL/.test(migration022),
    'the platform-scope (idempotency_key) command fence exists',
  );
  assert.ok(
    migration022.includes('logical_agents_agency_command_fence') &&
      /ON logical_agents \(agency_id, idempotency_key\) WHERE agency_id IS NOT NULL/.test(migration022),
    'the agency-scope (agency_id, idempotency_key) command fence exists',
  );
  // The ACTIVE declaration fences (one active declaration per scope+key).
  assert.ok(
    /logical_agents_platform_active_key_fence[\s\S]*ON logical_agents \(agent_key\) WHERE status = 'active' AND agency_id IS NULL/.test(migration022),
    'the platform-scope ACTIVE declaration fence exists',
  );
  assert.ok(
    /logical_agents_agency_active_key_fence[\s\S]*ON logical_agents \(agency_id, agent_key\) WHERE status = 'active' AND agency_id IS NOT NULL/.test(migration022),
    'the agency-scope ACTIVE declaration fence exists',
  );
  // Content immutability: corrections register NEW declarations.
  assert.ok(
    migration022.includes('logical_agents_content_immutable'),
    'logical Agent declared content is DB-immutable (append-oriented registry)',
  );
  assert.ok(
    migration022.includes('NEW.agency_id IS DISTINCT FROM OLD.agency_id'),
    'the ownership scope is DB-immutable (a declaration never migrates scopes)',
  );
  // Retired is terminal — no second retirement, no resurrection.
  assert.ok(
    migration022.includes('logical_agents_retired_terminal'),
    'the terminal-lifecycle trigger exists (retired is terminal)',
  );
  // The append-only lifecycle history with the once-per-transition fence.
  assert.ok(
    migration022.includes('BEFORE UPDATE OR DELETE ON logical_agent_lifecycle_events') &&
      migration022.includes('logical_agent_lifecycle_events_append_only'),
    'lifecycle events reject UPDATE and DELETE (append-only history)',
  );
  assert.ok(
    migration022.includes('CONSTRAINT logical_agent_lifecycle_events_once_unique UNIQUE (agent_id, transition)'),
    'the once-per-transition fence exists (exactly one registered and at most one retired event)',
  );
  assert.ok(
    migration022.includes('logical_agent_lifecycle_events_legal'),
    'the lifecycle legality/consistency backstop exists',
  );
});

test('migration 022 creates EXACTLY the two logical-agent tables — no sibling-scope tables', () => {
  const created = [...migration022.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created.sort(), [
    'logical_agent_lifecycle_events',
    'logical_agents',
  ]);
  // And NOTHING from the sibling Work Items' scope: no policy engine, no
  // extension registry, no field/human agent identity, no deployment, no
  // execution/workflow state (structural: no CREATE TABLE for any of
  // them — the exact created list above is the primary fence).
  for (const forbidden of [
    'execution_policies',
    'extension_registries',
    'extension_manifests',
    'field_agents',
    'human_agents',
    'deployments',
    'logical_agent_executions',
    'logical_agent_dispatches',
    'logical_agent_sandboxes',
    'logical_agent_policies',
    'logical_agent_extensions',
  ]) {
    assert.ok(
      !migration022.includes(`CREATE TABLE IF NOT EXISTS ${forbidden}`),
      `migration 022 must not create '${forbidden}' — that is sibling Work Item scope (MKT-021/022/025/deployments/executions)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The module boundary: platform ports ONLY (§12, provider neutrality,
//    no infrastructure coupling)
// ---------------------------------------------------------------------------

/** The provider SDK package denylist (mirrors the repo-wide posture). */
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

test('the /agents module ships exactly the MKT-020 file set (public entry + module + store)', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'agents');
  const files = existsSync(moduleDir) ? collectTsFiles(moduleDir) : [];
  const expectedFiles = [
    join('src', 'modules', 'agents', 'public.ts'),
    join('src', 'modules', 'agents', 'internal', 'module.ts'),
    join('src', 'modules', 'agents', 'internal', 'store.ts'),
  ].map((rel) => join(repoRoot, rel));
  assert.deepEqual(
    files.map((file) => file).sort(),
    expectedFiles.sort(),
    'the /agents module ships exactly the logical Agent/Capability contracts (MKT-020) — no adapters, no routing, no execution code',
  );
});

test('the /agents module imports ONLY platform ports and its own module — NO cross-module imports, NO provider SDKs, NO infrastructure coupling (AGENT-001)', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'agents');
  const files = collectTsFiles(moduleDir);
  assert.ok(files.length > 0, 'the module source tree must be present');

  for (const file of files) {
    const rel = relative(repoRoot, file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      // Provider SDKs are forbidden anywhere in the module.
      for (const pkg of PROVIDER_SDK_PACKAGES) {
        assert.ok(
          !(specifier === pkg || specifier.startsWith(`${pkg}/`)),
          `${rel} imports provider SDK '${specifier}' — forbidden (provider neutrality)`,
        );
      }
      // The ONE sanctioned infrastructure client is pg, and only inside
      // adapters — the module has no adapters at all.
      assert.ok(specifier !== 'pg', `${rel} must not import 'pg' (persistence goes through the Db port)`);

      if (!specifier.startsWith('.')) continue;
      const resolved = relative(repoRoot, join(dirname(file), specifier));
      // Platform ports and intra-module imports are always fine.
      if (resolved.startsWith(join('src', 'platform'))) continue;
      if (resolved.startsWith(join('src', 'modules', 'agents'))) continue;
      // ANY other module-to-module import is rejected for MKT-020: the
      // frozen matrix allows /executions, /ai-runtime and /policies, but
      // the logical capability contract composes NONE of them (§12: the
      // logical Agent owns no workflow/execution state and no AI routing
      // state) — the import surface is pinned to platform ports only.
      assert.fail(
        `${rel} imports '${specifier}' (${resolved}) — /agents (MKT-020) may import platform ports and its own module ONLY`,
      );
    }
    // Domain code may never import application-layer code.
    assert.ok(
      !/from\s+'\.\.\/\.\.\/\.\.\/api\//.test(source) && !/from\s+'\.\.\/\.\.\/api\//.test(source),
      `${rel} must not import application-layer code`,
    );
  }
});

test('the /agents module has NO infrastructure coupling: no sandbox/pool/queue/cache/lock/object/secret platform imports (ADR-0002, §12)', () => {
  for (const source of [agentsPublic, agentsModule, agentsStore]) {
    for (const forbiddenArea of [
      '/sandboxes/',
      '/queue/',
      '/cache/',
      '/locking/',
      '/objects/',
      '/secrets/',
      '/http/',
    ]) {
      assert.ok(
        !source.includes(`platform${forbiddenArea}`) && !source.includes(`..${forbiddenArea}`),
        `the /agents module must not import the infrastructure area '${forbiddenArea}'`,
      );
    }
  }
  // The Db port is the only persistence surface.
  assert.ok(agentsStore.includes('platform/db/contract.ts'), 'the store depends on the Db port');
});

test('the module API is exactly the registry surface — NO execution/invoke/dispatch methods (§12)', () => {
  const apiStart = agentsPublic.indexOf('export interface AgentsModuleApi {');
  assert.ok(apiStart >= 0, 'AgentsModuleApi interface must exist');
  let depth = 0;
  let apiEnd = apiStart;
  for (let i = apiStart; i < agentsPublic.length; i++) {
    const ch = agentsPublic[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        apiEnd = i;
        break;
      }
    }
  }
  assert.ok(apiEnd > apiStart, 'AgentsModuleApi interface must terminate');
  const apiBlock = agentsPublic.slice(apiStart, apiEnd);
  const methodNames = [...apiBlock.matchAll(/^ {2}(?:async )?([a-z][a-zA-Z0-9]+)\(/gm)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    methodNames.filter((name) => !name.startsWith('assertValid')).sort(),
    ['getAgent', 'listAgents', 'listLifecycleEvents', 'registerAgent', 'retireAgent'],
    'the AgentsModuleApi carries exactly the registry operations — the logical Agent is a declaration, never a run',
  );
  // The forbidden methods (execution engine, dispatch, invocation,
  // deployment, human/field agents) are absent.
  for (const forbidden of [
    'execute',
    'invoke',
    'dispatch',
    'run',
    'deploy',
    'assignJob',
    'createFieldAgent',
  ]) {
    assert.ok(
      !methodNames.includes(forbidden),
      `'${forbidden}' must not exist on the MKT-020 module API (execution/human-agent scope)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. The API DTO layer: forbidden-key contracts + the exact route set
// ---------------------------------------------------------------------------

test('the API DTO layer wires the provider-neutrality forbidden-key contracts on every /agents mutation surface (AGENT-001)', () => {
  assert.ok(
    agentsRoutes.includes('forbiddenKeys: LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS'),
    'the register DTOs use the neutrality forbidden-key contract',
  );
  assert.ok(
    agentsRoutes.includes('forbiddenKeys: AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS'),
    'the capability descriptor DTO uses the descriptor forbidden-key contract',
  );
  // The contracts themselves reject the provider/credential/infra shapes
  // (behavior proven by the unit suite; here the wiring is the proof).
  for (const contract of [
    LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
    AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
  ] as const) {
    for (const providerKey of ['provider', 'model', 'apiKey']) {
      assert.ok(
        (contract as readonly string[]).includes(providerKey),
        `the contract rejects the provider/credential-shaped key '${providerKey}'`,
      );
    }
    for (const infraKey of ['sandboxId', 'queueId', 'runtimeClass']) {
      assert.ok(
        (contract as readonly string[]).includes(infraKey),
        `the contract rejects the infrastructure-shaped key '${infraKey}'`,
      );
    }
  }
  // The scope is server-derived — never a DTO input.
  assert.ok(
    (LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS as readonly string[]).includes('scopeKind') &&
      (LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS as readonly string[]).includes('agencyId'),
    'the ownership scope is rejected as a caller-supplied field',
  );
});

test('the /agents route set is EXACTLY the seven frozen MKT-020 routes — no update, no delete, no invocation', () => {
  const routeMatches = [...agentsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routeMatches.sort(), [
    'GET /api/agencies/:agencyId/agents',
    'GET /api/agents',
    'GET /api/agents/:agentId',
    'GET /api/agents/:agentId/lifecycle-events',
    'POST /api/agencies/:agencyId/agents',
    'POST /api/agents',
    'POST /api/agents/:agentId/retire',
  ]);
  // No update/delete/invocation path exists anywhere in the route file.
  for (const forbidden of [
    '/api/agents/:agentId/execute',
    '/api/agents/:agentId/invoke',
    'DELETE /api/agents',
    'PATCH /api/agents',
    'PUT /api/agents',
  ]) {
    assert.ok(!agentsRoutes.includes(forbidden), `no '${forbidden}' surface exists`);
  }
});

// ---------------------------------------------------------------------------
// 7. Shared registration wiring
// ---------------------------------------------------------------------------

test('the shared registration files wire the /agents module (application modules + routes + composition root)', () => {
  const application = readFileSync(join(repoRoot, 'src', 'api', 'application.ts'), 'utf8');
  assert.ok(
    application.includes("import type { AgentsModuleApi } from '../modules/agents/public.ts'"),
    'application.ts exposes the AgentsModuleApi contract',
  );
  assert.ok(
    /readonly agents: AgentsModuleApi;/.test(application),
    'ApplicationModules carries the agents module',
  );

  const routes = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
  assert.ok(
    routes.includes("import { registerAgentsRoutes } from './agents-routes.ts'"),
    'routes.ts imports the agents route builder',
  );
  assert.ok(
    routes.includes('registerAgentsRoutes(router, services, modules)'),
    'routes.ts registers the agents routes',
  );

  const root = readFileSync(join(repoRoot, 'src', 'composition-root.ts'), 'utf8');
  assert.ok(
    root.includes("import { createAgentsModule } from './modules/agents/public.ts'"),
    'the composition root constructs the /agents module',
  );
  assert.ok(
    /createAgentsModule\(\{ db, clock, ids \}\)/.test(root),
    'the /agents module is wired with PLATFORM PORTS ONLY (db/clock/ids)',
  );
  assert.ok(
    /aiRuntime, agents \}/.test(root),
    'the agents module is part of the application modules wiring',
  );
});
