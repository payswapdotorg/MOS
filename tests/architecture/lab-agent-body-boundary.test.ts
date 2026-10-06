/**
 * LAB-011 boundary tests — the static architectural proofs of
 * /lab-agent-body (the /apps + /lab-corpus boundary precedent, applied
 * to the v1.7 Agent Body Runtime Contract):
 *
 *   1. NO SECOND MODEL ROUTER (§14 — THE acceptance): the module
 *      source contains ZERO routing vocabulary (no routeTask, no
 *      RoutingPolicy, no previewRouting, no eligibility/ranking/
 *      tradeoff/cascade logic) and imports NO other module — the model
 *      identity is DATA resolved through the /ai-runtime STRUCTURAL
 *      PORT wired at the composition root;
 *   2. the migration-063 discipline: the module owns EXACTLY its four
 *      lab_agent_* tables (no v1.6 authority table, no /ai-runtime
 *      table, no /lab table), CHECK-fenced closed vocabularies, the
 *      append-only/guard triggers, the scope-consistency fences and
 *      NO binary column anywhere;
 *   3. the module structure (public.ts + internal/ only) and the
 *      empty cross-module import set (the /lab family discipline);
 *   4. the registration: the composition root constructs and registers
 *      the module with the REAL /ai-runtime instance as the structural
 *      port; ApplicationModules carries the entry; the disclosed
 *      checker provision is the enforced-set registration pending the
 *      TL spec promotion;
 *   5. the migration tail: 063_lab_agent_body.sql is the tail (062
 *      reserved for the parallel worker).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from '../../tools/arch-check/checker.ts';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string) => readFileSync(path, 'utf8');

const moduleDir = src('modules', 'lab-agent-body');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '063_lab_agent_body.sql'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const checkerTs = read(join(repoRoot, 'tools', 'arch-check', 'checker.ts'));

/** Strips line + block comments (the boundary-test convention). */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Strips SQL comments (line `--` + block) — for the DDL scans. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])--[^\n]*/g, '$1');
}

test('LAB-011 AC-1: NO SECOND MODEL ROUTER — the module source contains ZERO routing vocabulary (the model identity is DATA, never a selection)', () => {
  const code = stripComments(moduleCode);
  // The /ai-runtime routing authority surface is structurally absent.
  for (const forbidden of [
    'routeTask',
    'previewRouting',
    'RoutingPolicy',
    'createRoutingPolicy',
    'eligibleSet',
    'EligibilityDecision',
    'RankingScore',
    'TradeoffScore',
    'CASCADE_STEP_TYPES',
    'cheap-first',
    'fan-out',
    'cascadeRun',
    'chosenModel',
    'appendUsageTelemetry',
  ]) {
    assert.ok(!code.includes(forbidden), `the module must not reference the /ai-runtime routing surface ('${forbidden}' found)`);
  }
  // The ONLY /ai-runtime consumption is the narrow structural port:
  // registry resolution + the append-only availability observation.
  assert.ok(code.includes('LabAgentBodyAiRuntimePort'), 'the /ai-runtime consumption is the declared structural port');
  assert.ok(code.includes('getModel('), 'the port resolves model identities through the registry');
  assert.ok(code.includes('appendModelObservation'), 'the port appends availability observations (the honest telemetry feed)');
  // The model identity is run-input DATA: the run record cites the
  // registry id as a field, and the backend is caller-supplied.
  assert.ok(code.includes('modelRegistryId'), 'the model identity is recorded data');
  assert.ok(code.includes('readonly providerLabel: string;'), 'the backend port declares its single provider (the ProviderAdapter discipline)');
});

test('LAB-011 AC-1: the module imports NO other module — the /lab family discipline (zero cross-module imports; the /ai-runtime boundary is the composition-root-wired port)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The static checker enforces it with zero violations (54 enforced
  // modules: 52 spec-parsed after the 2026-09-29 TL spec promotion +
  // the single /apps provision + the disclosed content-studio worker
  // provision appended by the STUDIO-001 sibling delivery — the
  // LAB-011 worker-delivery precedent, pending the TL spec promotion;
  // the lab-agent-body provision RETIRED, the /lab registration
  // precedent).
  // modules: 53 spec-parsed after the 2026-09-29 TL spec promotion +
  // the LAB-003 /lab-features granted worker spec registration (the
  // MKT-066 platform-health precedent) + the single /apps provision —
  // the disclosed lab-agent-body worker provision RETIRED, the /lab
  // registration precedent).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('lab-agent-body'));
  assert.equal(result.frozenModules.length, 59);
});

test('LAB-011 AC-2: the module owns EXACTLY its four migration-063 tables — no v1.6 authority table, no /ai-runtime table, no /lab table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created.sort(), [
    'lab_agent_body_versions',
    'lab_agent_instance_runs',
    'lab_agent_memory_entries',
    'lab_agent_run_events',
  ]);
  // No write into any table: the migration is pure DDL (the stripped
  // SQL contains no INSERT INTO, no DELETE FROM and no UPDATE outside
  // the BEFORE UPDATE ON trigger clauses).
  const stripped = stripSqlComments(migrationSql);
  assert.ok(!/INSERT INTO/.test(stripped), 'the migration never inserts data');
  assert.ok(!/DELETE FROM/.test(stripped), 'the migration never deletes data');
  assert.ok(!/UPDATE(?! ON)/.test(stripped), 'the migration never mutates a table (the ONLY UPDATE tokens are the BEFORE UPDATE ON trigger clauses)');
  // No FK into a v1.6 authority beyond the tenant anchors (agencies,
  // clients, workspaces) and its own tables.
  for (const reference of [...migrationSql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!)) {
    assert.ok(
      ['agencies', 'clients', 'workspaces', 'lab_agent_body_versions', 'lab_agent_instance_runs'].includes(reference),
      `unexpected FK target '${reference}'`,
    );
  }
});

test('LAB-011 AC-2: the CHECK-fenced closed vocabularies + the append-only/guard triggers + the scope fences exist in migration 063 (and NO binary column anywhere)', () => {
  for (const fence of [
    "CHECK (status IN ('draft', 'active', 'retired'))",
    "CHECK (status IN ('running', 'succeeded', 'failed'))",
    "'input_contract_violation'",
    "'model_unavailable'",
    "'model_invocation_failed'",
    "'permission_refused'",
    "'tool_error'",
    "'budget_exceeded'",
    "'latency_exceeded'",
    "'output_contract_violation'",
    "event_kind          text        NOT NULL\n                        CHECK (event_kind IN ('run_started',",
    "CHECK (kind IN ('run_scoped', 'body_scoped'))",
    "permissions <@ ARRAY['read','analyze','compose','transform','communicate','simulate']::text[]",
    "safety_constraints  text[]      NOT NULL",
    "no_fake_engagement",
    "CHECK (contract_version = 'lab-agent-body-contract-v1')",
  ]) {
    assert.ok(migrationSql.includes(fence), `the migration fence must exist: ${fence.slice(0, 60)}`);
  }
  for (const trigger of [
    'lab_agent_body_guard',
    'lab_agent_body_versions_no_delete',
    'lab_agent_body_chain_scope_check',
    'lab_agent_run_guard',
    'lab_agent_runs_no_delete',
    'lab_agent_run_scope_check',
    'lab_agent_run_events_append_only',
    'lab_agent_event_scope_check',
    'lab_agent_memory_guard',
    'lab_agent_memory_no_delete',
    'lab_agent_memory_scope_check',
  ]) {
    assert.ok(migrationSql.includes(`FUNCTION ${trigger}(`), `the trigger function ${trigger} must exist`);
  }
  // The terminal-shape + kind-shape consistency fences.
  assert.ok(migrationSql.includes('lab_agent_runs_terminal_shape'));
  assert.ok(migrationSql.includes('lab_agent_memory_kind_shape'));
  assert.ok(migrationSql.includes('UNIQUE NULLS NOT DISTINCT'));
  // NO binary column anywhere (no bytea, no media retention surface) —
  // checked over the STRIPPED DDL so the prose fence comments cannot
  // produce false positives.
  assert.ok(!/bytea|blob|binary/.test(stripSqlComments(migrationSql)), 'no binary column may exist');
});

test('LAB-011 AC-3: the module structure is public.ts + internal/ only (the frozen boundary shape)', () => {
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const name of readdirSync(moduleDir)) {
    assert.ok(name === 'public.ts' || name === 'internal', `unexpected module entry '${name}'`);
  }
  const internal = readdirSync(join(moduleDir, 'internal'));
  assert.deepEqual(internal.sort(), ['agent-body-module.ts', 'agent-body-store.ts', 'agent-instance.ts', 'validation.ts']);
});

test('LAB-011 AC-4: the registration — the composition root wires the REAL /ai-runtime instance as the structural port and registers the module; the TL spec promotion registered it in the spec files (the provision retired)', () => {
  assert.ok(compositionRoot.includes("import { createLabAgentBodyModule } from './modules/lab-agent-body/public.ts'"));
  assert.ok(compositionRoot.includes('const labAgentBody = createLabAgentBodyModule({ db, clock, ids, aiRuntime });'));
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, contentStudio, labFeatures, commerceDiscovery, labCapabilities, labIdeas, labSimulator },'));
  assert.ok(applicationTs.includes("import type { LabAgentBodyModuleApi } from '../modules/lab-agent-body/public.ts'"));
  assert.ok(applicationTs.includes('readonly labAgentBody: LabAgentBodyModuleApi'));
  // The provision is RETIRED (the 2026-09-29 TL spec promotion — the
  // LAB-002 precedent): the module registers through the spec files.
  // The STUDIO-001 sibling delivery appends its own disclosed worker
  // provision (the LAB-011 worker-delivery precedent — the array now
  // carries /apps + /content-studio pending the TL spec promotion).
  const provision = stripComments(checkerTs).match(/v15CompositionModules[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(provision !== null);
  const entries = [...provision[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
  // (2026-10-03: the STUDIO-001 provision RETIRED at its TL spec promotion —
  // the provision array is back to the single /apps entry.)
  assert.deepEqual(entries, ['apps']);
  // The spec-parsed set NOW includes the module (the TL promotion —
  // the /lab registration precedent; never a worker edit).
  const specModules = /## 6\. Core domain modules\s*```text([\s\S]*?)```/.exec(read(join(repoRoot, 'spec', 'architecture.md')))![1]!;
  assert.ok(/^\/lab-agent-body$/m.test(specModules), 'the TL spec promotion registered /lab-agent-body in the frozen list');
});

test('LAB-011 AC-5: 063_lab_agent_body.sql appends the migration tail (062 reserved for the parallel worker; 064 appended by the STUDIO-001 sibling delivery — the disclosed re-pin precedent); the header cites the §14 authority', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations[migrations.length - 9], '063_lab_agent_body.sql');
  assert.equal(migrations[migrations.length - 8], '064_content_studio_runtime.sql');
  assert.equal(migrations[migrations.length - 7], '065_lab_features.sql');
  assert.equal(migrations[migrations.length - 6], '066_lab_ideas.sql');
  assert.ok(!migrations.includes('062_agent_capability_candidates.sql'), '062 is reserved for the parallel worker (the TL reconciles numbering at merge)');
  // The header cites the spec authority verbatim (the house pattern).
  assert.ok(migrationSql.includes('LAB-011 (Agent Body Runtime Contract)'));
  assert.ok(migrationSql.includes('second model router'), 'the migration header cites the no-second-router acceptance verbatim');
  assert.ok(publicTs.includes('§14 "Agent Body"'));
  // The header cites the §14 no-second-router rule verbatim (the
  // phrase wraps across comment lines — assert the pieces).
  assert.ok(publicTs.includes('The Lab MUST NOT'));
  assert.ok(publicTs.includes('create a second model-routing authority'));
  assert.ok(publicTs.includes('§22 multi-tenancy'));
});
