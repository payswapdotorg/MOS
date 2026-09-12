/**
 * MKT-040 static tests — the Marketing Cloud Deployment control plane is
 * structurally correct, authority-bounded and runtime-neutral in the
 * ACTUAL module contract, migration, routes and source tree (pure static
 * analysis, no DB; the extensions-boundary precedent).
 *
 * Acceptance proofs (requirements-v1.4.md DEPLOY-002; spec/
 * marketing-cloud-deployment-v1.4.md; spec/architecture-lock-v1.4.md;
 * AGENTS.md "Deployment may request execution but may not mutate
 * Workflow/Execution lifecycle directly"):
 *
 *   1. DEPLOY-AC-07 (authority boundary): the /deployments module code
 *      imports ONLY platform ports (errors/clock/db/ids) + its own module
 *      — a LITERAL ZERO cross-module import (not even type-only: the
 *      frozen dependency matrix grants /deployments NO module line, so
 *      every consumed public contract arrives as a structural port wired
 *      at the composition root; workflow/execution state is structurally
 *      unreachable from inside the module);
 *
 *   2. DEPLOY-AC-07 (no second engine): the module's public API declares
 *      NO workflow mutation method (no definition status/content changes,
 *      no instance creation/transition), NO execution lifecycle method
 *      (no transition/retry/dispatch/lease/release), NO queue, worker or
 *      backoff surface — the ONLY execution interaction is
 *      createExecution on the REQUEST port (request-execution through
 *      public contracts only; no second retry/orchestration path);
 *
 *   3. DEPLOY-AC-07 (storage): the migration creates ONLY the
 *      deployments + deployment_events tables — NO workflow, instance,
 *      execution, task, evidence, outcome or learning table/column/
 *      trigger; execution_ref is a REFERENCE column, never an execution
 *      lifecycle write;
 *
 *   4. DEPLOY-AC-03 (identity): the migration carries the full frozen
 *      deployment identity column set (scope chain, pinned playbook
 *      version, workflow version references, pack/capability
 *      requirements, policy reference, runtime requirements, trigger
 *      configuration, lifecycle state + CAS version, provenance on the
 *      ledger) with the frozen lifecycle CHECK + transition trigger and
 *      the append-only ledger triggers;
 *
 *   5. DEPLOY-AC-05/06 (frozen machine + history): the DB transition
 *      trigger encodes EXACTLY the module's DEPLOYMENT_TRANSITIONS table;
 *      the selection-change fence permits selection mutation ONLY on the
 *      redeploy/rollback completion edges; the ledger rejects UPDATE and
 *      DELETE;
 *
 *   6. DEPLOY-AC-09 (runtime neutrality): no column or accepted payload
 *      key encodes infrastructure identity — the runtime-requirements
 *      CHECK is the closed one-key runtimeClass shape with the
 *      infrastructure-identity denylist backstop;
 *
 *   7. the API route set is exactly the thirteen frozen MKT-040 routes —
 *      no delete, no dispatch/retry surface; the DTO layer wires the
 *      authority-field rejection contract on every mutation surface;
 *
 *   8. the shared registration files wire the module: application.ts
 *      exposes DeploymentsModuleApi, routes.ts registers the routes, and
 *      the composition root constructs the module with EXACTLY the
 *      structural ports (the real public-contract instances — no direct
 *      module import exists inside src/modules/deployments).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEPLOYMENT_RUNTIME_CLASSES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRANSITIONS,
} from '../../src/modules/deployments/public.ts';

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

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

/** Strips comments so code-token checks never match documentation. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

const deploymentsDir = src('modules', 'deployments');
const moduleFiles = walk(deploymentsDir);
const migration034 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '034_deployments.sql'));
const deploymentsPublic = read(src('modules', 'deployments', 'public.ts'));
const deploymentsModule = read(src('modules', 'deployments', 'internal', 'module.ts'));
const deploymentsStore = read(src('modules', 'deployments', 'internal', 'store.ts'));
const deploymentsRoutes = read(src('api', 'deployments-routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const routesTs = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));

// ---------------------------------------------------------------------------
// 1. DEPLOY-AC-07: ZERO cross-module imports (the structural-port posture)
// ---------------------------------------------------------------------------

test('DEPLOY-AC-07 static: the /deployments module imports ONLY platform ports + its own module', () => {
  assert.ok(moduleFiles.length >= 4, 'public.ts + internal module/store/resolution exist');
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) {
        assert.fail(`non-relative import '${specifier}' in ${file} (only node builtins via platform are allowed)`);
      }
      // Resolve the specifier against the importing file's DIRECTORY.
      const parts = file.split('/');
      parts.pop(); // drop the filename
      for (const segment of specifier.split('/')) {
        if (segment === '..') {
          parts.pop();
        } else if (segment !== '.' && segment !== '') {
          parts.push(segment);
        }
      }
      const resolved = parts.join('/');
      assert.ok(
        resolved.includes('/src/platform/') ||
          resolved.startsWith(`${deploymentsDir}/`) ||
          resolved === deploymentsDir,
        `import '${specifier}' in ${file} must resolve into src/platform or the /deployments module itself (found '${resolved}')`,
      );
    }
  }
});

test('DEPLOY-AC-07 static: no other module imports /deployments internals (public entry only)', () => {
  for (const file of walk(src())) {
    if (file.startsWith(deploymentsDir)) continue;
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('modules/deployments/internal'),
        `${file} imports the deployments internal implementation — only public.ts is importable`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. DEPLOY-AC-07: no workflow/execution mutation, no second engine
// ---------------------------------------------------------------------------

const FORBIDDEN_API_METHODS = [
  // Workflow lifecycle (owned by /workflows only).
  'setWorkflowDefinitionStatus',
  'updateWorkflowDefinitionContent',
  'updateWorkflowProfile',
  'createWorkflowInstance',
  'transitionWorkflowInstance',
  // Execution lifecycle (owned by /executions only).
  'transitionExecution',
  'acquireExecutionSandboxLease',
  'releaseExecutionSandboxLease',
  'provisionSandbox',
  'transitionSandbox',
  // Second-engine surfaces.
  'retryExecution',
  'dispatchExecution',
  'scheduleRetry',
  'orchestrate',
  'enqueue',
  'consumeQueue',
  'runWorker',
];

test('DEPLOY-AC-07 static: the module API declares NO workflow/execution mutation or orchestration method', () => {
  const apiSurface = stripComments(deploymentsPublic);
  for (const method of FORBIDDEN_API_METHODS) {
    assert.ok(
      !apiSurface.includes(method),
      `the /deployments public contract must not declare '${method}' (DEPLOY-AC-07)`,
    );
  }
  // The ONLY execution interaction is the createExecution request port.
  assert.ok(
    apiSurface.includes('createExecution'),
    'the request-execution port (createExecution) is the declared execution interaction',
  );
  assert.ok(
    /The slice of the \/executions public contract \/deployments depends on/.test(deploymentsPublic),
    'the executions port is documented as the narrow request surface',
  );
});

test('DEPLOY-AC-07 static: the module implementation has no retry/dispatch/queue code path', () => {
  const code = stripComments(`${deploymentsModule}\n${deploymentsStore}`);
  for (const token of ['retryOfExecutionId', 'dispatch', 'backoff', 'reconcil', 'claimJob', 'pollQueue', 'workerHost']) {
    assert.ok(!code.includes(token), `the deployments implementation must not contain a '${token}' code path`);
  }
  // The ONLY interaction with the execution authority: createExecution.
  assert.ok(
    code.includes('executions.createExecution'),
    'requestDeploymentExecution delegates to the /executions public contract (request only)',
  );
  const createCalls = code.match(/executions\.createExecution/g) ?? [];
  assert.equal(createCalls.length, 1, 'exactly ONE createExecution call site (the request surface)');
});

test('DEPLOY-AC-07 static: the workflow/executions ports are read-only or request-shaped', () => {
  const portCode = stripComments(deploymentsPublic);
  const workflowsPort = /export interface DeploymentsWorkflowsPort \{([\s\S]*?)\n\}/.exec(portCode)?.[1] ?? '';
  assert.ok(/getWorkflowDefinition/.test(workflowsPort), 'the workflows port declares only reads');
  assert.ok(/getWorkflow\b/.test(workflowsPort));
  assert.ok(!/(transition|update|create|set)[A-Z]/.test(workflowsPort), 'no mutation methods on the workflows port');
  const executionsPort = /export interface DeploymentsExecutionsPort \{([\s\S]*?)\n\}/.exec(portCode)?.[1] ?? '';
  assert.ok(/createExecution/.test(executionsPort), 'the executions port declares only the request');
  assert.ok(!/(transitionExecution|retry|dispatch|lease|release)/.test(executionsPort));
});

// ---------------------------------------------------------------------------
// 3. DEPLOY-AC-07 storage: exactly two tables, no execution state
// ---------------------------------------------------------------------------

test('DEPLOY-AC-07 static: the migration creates ONLY deployments + deployment_events', () => {
  const tables = [...migration034.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(tables, ['deployments', 'deployment_events']);
  // No trigger mutates another module's tables (the FK-scope fences only
  // READ them via SELECT/JOIN; only CREATE TRIGGER targets are mutated).
  const triggerTargets = [...migration034.matchAll(/CREATE TRIGGER [a-z__]+\s*(?:BEFORE|AFTER)[^\n]*? ON ([a-z_]+)/g)].map((m) => m[1]!);
  assert.ok(triggerTargets.length >= 8, 'the migration declares its triggers');
  for (const target of triggerTargets) {
    assert.ok(
      ['deployments', 'deployment_events'].includes(target),
      `a migration trigger fires ON ${target} — only the deployments tables may be mutated`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. DEPLOY-AC-03: the frozen identity column set
// ---------------------------------------------------------------------------

test('DEPLOY-AC-03 static: the deployments table carries the full frozen identity columns', () => {
  for (const column of [
    'deployment_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'playbook_version_id',
    'workflow_definition_ids',
    'required_domain_packs',
    'required_capabilities',
    'policy_reference_id',
    'runtime_requirements',
    'trigger_config',
    'status',
    'version',
    'created_by',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(
      new RegExp(`\\b${column}\\s+`).test(migration034),
      `the deployments table must carry the identity column '${column}'`,
    );
  }
  // Audit/correlation metadata lives on the append-only ledger.
  for (const column of [
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
    'idempotency_key',
  ]) {
    assert.ok(
      new RegExp(`\\b${column}\\s+`).test(migration034),
      `the deployment_events ledger must carry the audit/correlation column '${column}'`,
    );
  }
  // The scope chain is NOT NULL and FK-fenced to the real authorities.
  assert.ok(/workspace_id\s+uuid\s+NOT NULL REFERENCES workspaces/.test(migration034));
  assert.ok(/client_id\s+uuid\s+NOT NULL REFERENCES clients/.test(migration034));
  assert.ok(/agency_id\s+uuid\s+NOT NULL REFERENCES agencies/.test(migration034));
  assert.ok(/playbook_version_id\s+uuid\s+NOT NULL REFERENCES playbook_versions/.test(migration034));
});

// ---------------------------------------------------------------------------
// 5. DEPLOY-AC-05/06: the frozen machine + history immutability at storage
// ---------------------------------------------------------------------------

test('DEPLOY-AC-05 static: the DB transition trigger encodes EXACTLY the frozen module table', () => {
  // The trigger CASE arms.
  assert.ok(/WHEN 'draft'\s+THEN v_legal := ARRAY\['validating'\]/.test(migration034));
  assert.ok(/WHEN 'validating'\s+THEN v_legal := ARRAY\['ready'\]/.test(migration034));
  assert.ok(/WHEN 'ready'\s+THEN v_legal := ARRAY\['active', 'blocked'\]/.test(migration034));
  assert.ok(/WHEN 'active'\s+THEN v_legal := ARRAY\['paused', 'disabled', 'redeploying', 'rolling_back'\]/.test(migration034));
  assert.ok(/WHEN 'paused'\s+THEN v_legal := ARRAY\['active'\]/.test(migration034));
  assert.ok(/WHEN 'redeploying'\s+THEN v_legal := ARRAY\['active'\]/.test(migration034));
  assert.ok(/WHEN 'rolling_back'\s+THEN v_legal := ARRAY\['active'\]/.test(migration034));
  assert.ok(/WHEN 'blocked'\s+THEN v_legal := ARRAY\[\]::text\[\]/.test(migration034));
  assert.ok(/WHEN 'disabled'\s+THEN v_legal := ARRAY\[\]::text\[\]/.test(migration034));
  // The status CHECK is the closed nine-state set.
  assert.ok(/status IN \('draft', 'validating', 'ready', 'active',\s*'paused', 'redeploying', 'rolling_back',\s*'blocked', 'disabled'\)/.test(migration034));
  assert.equal(DEPLOYMENT_STATUSES.length, 9);
  assert.equal(Object.keys(DEPLOYMENT_TRANSITIONS).length, 9);
  // The idempotency fence exists.
  assert.ok(/deployment_events_idempotency_fence/.test(migration034));
});

test('DEPLOY-AC-06 static: the ledger is append-only and selection changes are completion-fenced', () => {
  assert.ok(/deployment_events_append_only_update_trigger/.test(migration034));
  assert.ok(/deployment_events_append_only_delete_trigger/.test(migration034));
  const fence = /CREATE OR REPLACE FUNCTION deployment_selection_change_fenced[\s\S]*?\$\$[\s\S]*?\$\$/.exec(migration034)?.[0] ?? '';
  assert.ok(
    /OLD\.status IN \('redeploying', 'rolling_back'\) AND NEW\.status = 'active'/.test(fence),
    'selection columns mutate ONLY on the redeploy/rollback completion edges',
  );
  // The history rewrite guard covers the whole selection block.
  for (const column of [
    'playbook_version_id',
    'workflow_definition_ids',
    'required_domain_packs',
    'required_capabilities',
    'runtime_requirements',
    'trigger_config',
  ]) {
    assert.ok(fence.includes(`NEW.${column}`), `the selection fence covers ${column}`);
  }
  // Scope chain is immutable outright.
  assert.ok(/deployment % scope chain is immutable/.test(migration034));
});

// ---------------------------------------------------------------------------
// 6. DEPLOY-AC-09: runtime neutrality at storage
// ---------------------------------------------------------------------------

test('DEPLOY-AC-09 static: NO infrastructure identity column or accepted payload key', () => {
  // No column named after infrastructure identity.
  const columns = [...migration034.matchAll(/^\s+([a-z_]+)\s+(?:uuid|text|jsonb|bigint|timestamptz)/gm)].map((m) => m[1]!);
  for (const column of columns) {
    assert.ok(
      !/^(host|hostname|port|region|zone|vm|vmid|instance|instanceid|provider|vendor|cloud|cluster|node|nodeid|machine|machineid|endpoint|url|address|image|container|worker|workerid|runtimeid)$/.test(column),
      `infrastructure-identity column '${column}' is forbidden (DEPLOY-AC-09)`,
    );
  }
  // The runtime-requirements CHECK is the closed one-key shape...
  assert.ok(/deployment_runtime_requirements_valid\(runtime_requirements\)/.test(migration034));
  // ...backed by the infrastructure-identity denylist validator.
  assert.ok(/deployment_requirements_no_infrastructure_identity/.test(migration034));
  const denylist = /CREATE OR REPLACE FUNCTION deployment_requirements_no_infrastructure_identity\(payload jsonb\)\s*RETURNS boolean AS \$\$[\s\S]*?\$\$ LANGUAGE plpgsql IMMUTABLE;/.exec(migration034)?.[0] ?? '';
  assert.ok(denylist.length > 0, 'the denylist validator body is extractable');
  for (const key of ['host', 'region', 'vm', 'instanceId', 'provider', 'endpoint']) {
    assert.ok(denylist.includes(`'${key}'`), `the denylist covers '${key}'`);
  }
  // The closed vocabulary is the four frozen classes.
  for (const runtimeClass of DEPLOYMENT_RUNTIME_CLASSES) {
    assert.ok(migration034.includes(`'${runtimeClass}'`), `the closed runtime vocabulary contains '${runtimeClass}'`);
  }
});

// ---------------------------------------------------------------------------
// 7. The frozen route set + authority-field rejection
// ---------------------------------------------------------------------------

test('DEPLOY-002 static: the route set is exactly the thirteen frozen MKT-040 routes', () => {
  // Seven routes register through the shared transition-route builder
  // (path is a template literal) — count every router.add call site and
  // assert the exact path surface.
  const addCalls = [...deploymentsRoutes.matchAll(/router\.add\(/g)].length;
  const builderInvocations = [...deploymentsRoutes.matchAll(/(?<!function )transitionRoute\(/g)].length;
  assert.equal(
    addCalls + builderInvocations - 1,
    13,
    'thirteen registered routes: six direct router.add sites + the builder (one site) invoked for the seven frozen transitions',
  );
  assert.equal(builderInvocations, 7, 'the seven frozen lifecycle transitions register through the builder');
  const expectedPaths = [
    "'/api/workspaces/:workspaceId/deployments'",
    '`${base}/activate`',
    '`${base}/pause`',
    '`${base}/resume`',
    '`${base}/disable`',
    '`${base}/block`',
    '`${base}/redeploy`',
    '`${base}/rollback`',
    '`${base}/request-execution`',
  ];
  for (const path of expectedPaths) {
    assert.ok(
      deploymentsRoutes.includes(path),
      `the route path ${path} is registered`,
    );
  }
  // The read routes are registered with their literal paths.
  for (const path of [
    "'/api/workspaces/:workspaceId/deployments'",
    "'/api/workspaces/:workspaceId/deployments/:deploymentId'",
    "'/api/workspaces/:workspaceId/deployments/:deploymentId/events'",
    "'/api/workspaces/:workspaceId/deployments/:deploymentId/validate'",
  ]) {
    assert.ok(deploymentsRoutes.includes(path), `the route path ${path} is registered`);
  }
  // No delete route ever.
  assert.ok(!/router\.add\(\s*'DELETE'/.test(deploymentsRoutes));
  // The DTO layer rejects authority + material-shaped fields.
  assert.ok(/DEPLOYMENT_AUTHORITY_FIELDS/.test(deploymentsRoutes));
  for (const field of ['deploymentId', 'status', 'version', 'provenance', 'validationReport', 'secret', 'apiKey']) {
    assert.ok(
      deploymentsRoutes.includes(`'${field}'`),
      `the route authority-field rejection covers '${field}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. The shared registration files wire the module
// ---------------------------------------------------------------------------

test('DEPLOY-002 static: application.ts, routes.ts and the composition root wire the module', () => {
  assert.ok(applicationTs.includes('readonly deployments: DeploymentsModuleApi;'));
  assert.ok(applicationTs.includes("import type { DeploymentsModuleApi } from '../modules/deployments/public.ts'"));
  assert.ok(routesTs.includes("import { registerDeploymentsRoutes } from './deployments-routes.ts'"));
  assert.ok(routesTs.includes('registerDeploymentsRoutes(router, services, modules)'));
  // The composition root constructs the module with the STRUCTURAL PORTS
  // satisfied by the real public-contract instances.
  assert.ok(compositionRoot.includes('const deployments = createDeploymentsModule({'));
  for (const port of ['workspaceOwnership:', 'playbooks,', 'domainPacks:', 'extensions:', 'integrations:', 'policies,', 'credentials,', 'executions:']) {
    assert.ok(
      new RegExp(`\\b${port.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(compositionRoot),
      `the composition root wires the '${port}' port`,
    );
  }
  assert.ok(
    compositionRoot.includes("import { createDeploymentsModule } from './modules/deployments/public.ts'"),
    'the composition root imports ONLY the public entry',
  );
});

test('DEPLOY-002 static: the migration file exists and is registered in the expected list', () => {
  assert.ok(existsSync(join(repoRoot, 'src', 'platform', 'db', 'migrations', '034_deployments.sql')));
  const infraTest = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  assert.ok(infraTest.includes("'034_deployments.sql'"));
  assert.ok(infraTest.includes('MKT-040'));
});
