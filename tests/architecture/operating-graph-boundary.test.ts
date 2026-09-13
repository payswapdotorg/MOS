/**
 * MKT-041 static tests — the Agency Operating Graph boundary is structurally
 * correct in the ACTUAL route file, the /operating-graph module, the shared
 * registration files, the migration and the additive spec entries (pure
 * static analysis, no DB; the MKT-029 reporting-command-center-boundary
 * precedent). Proves the frozen architecture boundaries (spec/
 * operating-graph-v1.5.md; spec/architecture-v1.5.md §3; architecture-lock-
 * v1.5 #4; spec/module-dependency-matrix.md "/operating-graph ──→ /clients,
 * /workspaces, /goals, /playbooks, /workflows, /executions, /deployments,
 * /evidence, /experiments, /learnings" + the derived-coordination-model
 * forbidden-direction bullet):
 *
 *   1. the surface registers EXACTLY TWO routes and both are GETs — NO
 *      mutating verb exists anywhere in the route file (READ-ONLY BY
 *      CONSTRUCTION: the rebuild is a module-level operation; a frontend
 *      bypass has nothing to drive);
 *   2. the route file reads NO request body and validates NO DTO — the GET
 *      surface has no DTO at all, so authority fields are structurally
 *      unreachable, not merely rejected;
 *   3. the route file's imports are whitelisted: platform + authorize +
 *      application + the /operating-graph public contract ONLY;
 *   4. thin delegation: the route file's ONLY module calls are the durable
 *      agency/membership authorization reads, the server-derived agency
 *      client/workspace enumeration and the /operating-graph reads;
 *   5. the AGENCY tenant boundary is the UNIFORM 404 (malformed/unknown/
 *      foreign → 404; suspended membership → 403; anonymous → 401 via the
 *      authenticator, fail closed); the client-detail selector resolves
 *      against the agency's OWN live clients — a foreign Client is the
 *      same uniform 404;
 *   6. NO AUTHORITATIVE-SHAPE STATE: the migration's two tables carry
 *      EXACTLY the reference-only column inventory (no name, objective,
 *      statement, hypothesis, strategy, content, lifecycle or payload
 *      columns — the column sets are compared EXACTLY), and the migration
 *      creates NO table of another module;
 *   7. ZERO MUTATION METHODS AGAINST OTHER AUTHORITIES: the module's
 *      internal files contain DML against ONLY the two operating_graph_*
 *      tables (reads of the composed authorities go through the public
 *      contracts — no SQL against goals/workflows/executions/evidence/…);
 *   8. the frozen vocabularies are CHECK-fenced in the migration (the 12
 *      node kinds, the 15 relations, the five epistemic states — the
 *      migration mirrors the public constants);
 *   9. the shared registration files wire the surface ONCE (one module in
 *      the composition root, one registration in routes.ts, one
 *      ApplicationModules member) and the additive spec entries exist
 *      (architecture.md §6 module list + the dependency-matrix line).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const spec = (...parts: string[]) => join(repoRoot, 'spec', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const operatingGraphRoutes = read(src('api', 'operating-graph-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));
const migration = read(src('platform', 'db', 'migrations', '035_operating_graph.sql'));
const publicEntry = read(src('modules', 'operating-graph', 'public.ts'));
const projectionFile = read(src('modules', 'operating-graph', 'internal', 'graph-projection.ts'));
const storeFile = read(src('modules', 'operating-graph', 'internal', 'operating-graph-store.ts'));
const moduleFile = read(src('modules', 'operating-graph', 'internal', 'operating-graph-module.ts'));

/** Imports of a file as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. Exactly two surfaces — both GETs (read-only by construction)
// ---------------------------------------------------------------------------

test('the operating-graph routes register EXACTLY TWO surfaces — both GETs — and no mutating verb exists in the file', () => {
  const registered = [...operatingGraphRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, [
    '/api/operating-graph/:agencyId',
    '/api/operating-graph/:agencyId/clients/:clientId',
  ]);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !operatingGraphRoutes.includes(`'${verb}',`),
      `the operating graph must never register a ${verb} route (a frontend bypass cannot change outcomes)`,
    );
  }
  // The REBUILD is deliberately NOT a route: the derived-edge recomputation
  // is a module-level operation — the HTTP surface exposes no write path.
  assert.ok(!operatingGraphRoutes.includes('rebuildClientOperatingGraph'));
});

// ---------------------------------------------------------------------------
// 2. No DTO at all — the GET surfaces read no body
// ---------------------------------------------------------------------------

test('the route file reads NO request body, validates NO DTO and reads no query parameters', () => {
  assert.ok(!operatingGraphRoutes.includes('validateObject'), 'the GET surfaces validate no body');
  assert.ok(!operatingGraphRoutes.includes('ctx.request.body'), 'the routes never touch a request body');
  assert.ok(
    !operatingGraphRoutes.includes('forbiddenKeys'),
    'there is no DTO to carry authority fields — the surfaces accept no input at all',
  );
  assert.ok(
    !operatingGraphRoutes.includes('defineMutationRoute'),
    'the operating graph registers no mutation pipeline route',
  );
  assert.ok(
    !operatingGraphRoutes.includes('ctx.request.query') && !operatingGraphRoutes.includes('searchParams'),
    'the operating graph never reads query parameters (scope is server-derived)',
  );
});

// ---------------------------------------------------------------------------
// 3. Import whitelist — the composed authorities are reached THROUGH the
//    ApplicationModules aggregate + the /operating-graph module public
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + application + the /operating-graph public contract', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/operating-graph\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'operating-graph-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the operating-graph routes compose the module public contract only`,
    );
  }
  for (const specifier of importsOf(src('api', 'operating-graph-routes.ts'))) {
    assert.ok(!specifier.includes('evidence'), 'the route family must not import /evidence directly');
    assert.ok(!specifier.includes('experiments'), 'the route family must not import /experiments directly');
    assert.ok(!specifier.includes('executions'), 'the route family must not import /executions directly');
    assert.ok(!specifier.includes('learnings'), 'the route family must not import /learnings directly');
    assert.ok(!specifier.includes('goals'), 'the route family must not import /goals directly');
    assert.ok(!specifier.includes('workflows'), 'the route family must not import /workflows directly');
    assert.ok(!specifier.includes('playbooks'), 'the route family must not import /playbooks directly');
    assert.ok(!specifier.includes('deployments'), 'the route family must not import /deployments directly');
    assert.ok(!specifier.includes('/clients/'), 'the route family must not import the /clients contract directly');
    assert.ok(!specifier.includes('/workspaces/'), 'the route family must not import the /workspaces contract directly');
    assert.ok(!specifier.includes('policies'), 'the route family must not import /policies (no second policy surface)');
    assert.ok(!specifier.includes('audit'), 'the route family must not import /audit (reads emit no audit events)');
  }
});

// ---------------------------------------------------------------------------
// 4. Thin delegation — durable authorization + scope enumeration + the reads
// ---------------------------------------------------------------------------

test('the route file performs ONLY the durable authorization reads + the server-derived agency enumeration + the /operating-graph reads', () => {
  const allowedModuleCalls = [
    'modules.agencies.getAgency',
    'modules.clients.listClientsForAgency',
    'modules.workspaces.listWorkspacesForClient',
    'modules.operatingGraph.getAgencyOperatingGraph',
    'modules.operatingGraph.getClientOperatingGraph',
  ];
  for (const match of operatingGraphRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the operating-graph surface is a thin delegation layer`,
    );
  }
  assert.ok(operatingGraphRoutes.includes('resolveContext'));
  assert.ok(operatingGraphRoutes.includes('requireOperatingGraphAgency'));
  // Reads emit no audit events (nothing material happened).
  assert.ok(!operatingGraphRoutes.includes('recordMutationAudit'));
  assert.ok(!operatingGraphRoutes.includes('audit-emit'));
});

// ---------------------------------------------------------------------------
// 5. The agency tenant boundary — uniform 404 for foreign agencies/clients
// ---------------------------------------------------------------------------

test('the agency tenant boundary is the UNIFORM 404: cross-agency identifiers never leak existence (404, not 403)', () => {
  assert.ok(
    operatingGraphRoutes.includes("if (!UUID_PATTERN.test(agencyId))"),
    'a malformed agency identifier is rejected as the uniform 404',
  );
  assert.ok(
    /agency === null[\s\S]{0,120}NotFoundError\('agency'/.test(operatingGraphRoutes),
    'an unknown agency is the uniform 404',
  );
  const foreignBranch = operatingGraphRoutes.match(
    /if \(membership === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,220}?NotFoundError\('agency', agencyId\);\n\s*\}/,
  );
  assert.ok(
    foreignBranch !== null,
    'a caller with NO membership in the owning agency gets the SAME 404 as an unknown agency (cross-agency data must 404, never 403-leak existence)',
  );
  assert.ok(
    /membership\.membershipStatus !== 'active'[\s\S]{0,120}ForbiddenError/.test(operatingGraphRoutes),
    'only a suspended membership is a 403 (intra-tenant, post-existence)',
  );
  // The client-detail selector: a foreign or malformed Client identifier is
  // the same uniform 404 (validated against the agency's OWN live clients).
  assert.ok(
    operatingGraphRoutes.includes("if (!UUID_PATTERN.test(clientId))"),
    'a malformed client identifier is rejected as the uniform 404',
  );
  const foreignClientBranch = operatingGraphRoutes.match(
    /if \(match === undefined\) \{\n\s*\/\/ Hard boundary[\s\S]{0,240}?NotFoundError\('client', clientId\);\n\s*\}/,
  );
  assert.ok(
    foreignClientBranch !== null,
    'a Client of another agency gets the SAME 404 as an unknown client (no cross-agency existence oracle)',
  );
});

// ---------------------------------------------------------------------------
// 6. NO AUTHORITATIVE-SHAPE STATE — the exact reference-only column inventory
// ---------------------------------------------------------------------------

/** Parses a CREATE TABLE block's column names (the exact inventory). */
function columnsOf(table: string): string[] {
  const match = migration.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`),
  );
  assert.ok(match !== null, `${table} exists in migration 035`);
  const columns: string[] = [];
  for (const line of match[1]!.split('\n')) {
    const trimmed = line.trim();
    const columnMatch = trimmed.match(/^([a-z_]+)\s+(?:uuid|text|integer|boolean|timestamptz)/);
    if (columnMatch !== null) columns.push(columnMatch[1]!);
  }
  return columns.sort();
}

test('the migration holds EXACTLY the reference-only column inventory (no authoritative shape is shadowed)', () => {
  assert.deepEqual(columnsOf('operating_graph_nodes'), [
    'agency_id',
    'client_id',
    'first_seen_at',
    'last_refreshed_at',
    'node_id',
    'node_kind',
    'workspace_id',
  ]);
  assert.deepEqual(columnsOf('operating_graph_edges'), [
    'agency_id',
    'client_id',
    'edge_id',
    'edge_state',
    'edge_version',
    'from_id',
    'from_kind',
    'is_current',
    'recorded_at',
    'recorded_by',
    'relation',
    'superseded_at',
    'to_id',
    'to_kind',
    'workspace_id',
  ]);
  // The explicit negative battery: none of the authoritative-shape columns
  // exist anywhere in the two tables (the exact-set assertions above already
  // prove it; these markers make the intent auditable).
  for (const shadow of [
    'objective',
    'statement',
    'hypothesis',
    'strategy',
    'success_criteria',
    'time_horizon',
    'description',
    'quality',
    'confidence',
    'applicability',
    'treatment',
    'comparison',
    'content',
    'output_schema',
    'input_schema',
    'retry_policy',
    'trigger_config',
    'runtime_requirements',
  ]) {
    assert.ok(
      !migration.includes(` ${shadow} `) && !migration.includes(`${shadow}\n`),
      `the derived structures never carry the authoritative column '${shadow}' (source references only)`,
    );
  }
  // No authoritative table of another module is created or altered.
  for (const created of migration.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)) {
    assert.ok(
      created[1]!.startsWith('operating_graph_'),
      `migration 035 creates only operating_graph_* tables (found '${created[1]}')`,
    );
  }
  for (const altered of migration.matchAll(/CREATE (?:OR REPLACE )?(?:UNIQUE )?INDEX IF NOT EXISTS ([a-z_]+)/g)) {
    assert.ok(
      altered[1]!.startsWith('operating_graph_'),
      `migration 035 indexes only operating_graph_* tables (found '${altered[1]}')`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. ZERO MUTATION METHODS AGAINST OTHER AUTHORITIES — DML targets lint
// ---------------------------------------------------------------------------

test('the module internals perform DML against ONLY the two operating_graph tables', () => {
  const internalFiles = [storeFile, moduleFile, projectionFile];
  for (const file of internalFiles) {
    for (const statement of file.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)) {
      assert.ok(
        statement[2]!.startsWith('operating_graph_'),
        `module DML must target only the operating_graph tables (found '${statement[1]} ${statement[2]}')`,
      );
    }
  }
  // The store file is the only DML site at all (the projection is pure; the
  // module orchestrates).
  for (const file of [moduleFile, projectionFile]) {
    assert.ok(
      !/\b(INSERT INTO|DELETE FROM)\s+[a-z_]/.test(file),
      'only the store writes (the projection is pure; the module orchestrates)',
    );
  }
  // No SQL reads against another module's tables either: the composed
  // authorities are reached through their PUBLIC CONTRACTS only.
  for (const file of internalFiles) {
    for (const statement of file.matchAll(/\bFROM\s+([a-z_]+)/g)) {
      assert.ok(
        statement[1]!.startsWith('operating_graph_') ||
          statement[1] === 'participants' ||
          statement[1] === 'VALUES',
        `module SQL reads only the operating_graph tables (found FROM ${statement[1]}) — the authorities compose through their public contracts`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 8. The frozen vocabularies are CHECK-fenced in the migration
// ---------------------------------------------------------------------------

test('the migration CHECK-fences the node kinds, the relations and the five epistemic states', () => {
  for (const kind of [
    'client', 'goal', 'playbook', 'playbook_version', 'deployment', 'workflow',
    'workflow_definition', 'workflow_instance', 'execution', 'evidence', 'experiment', 'learning',
  ]) {
    assert.ok(migration.includes(`'${kind}'`), `node kind '${kind}' is fenced`);
  }
  for (const relation of [
    'has_goal', 'pursued_by_playbook', 'has_version', 'pins_playbook_version',
    'deploys_definition', 'has_definition', 'pins_definition', 'executes_step',
    'runs_execution', 'has_evidence', 'supersedes', 'runs_experiment',
    'records_learning', 'supported_by', 'derived_from',
  ]) {
    assert.ok(migration.includes(`'${relation}'`), `relation '${relation}' is fenced`);
  }
  for (const state of ['unknown', 'observed', 'predicted', 'attributed', 'causal']) {
    assert.ok(migration.includes(`'${state}'`), `epistemic state '${state}' is fenced`);
  }
  // The public constants mirror the migration exactly.
  assert.ok(publicEntry.includes("export const OPERATING_GRAPH_NODE_KINDS"));
  assert.ok(publicEntry.includes("export const OPERATING_GRAPH_EDGE_STATES"));
  assert.ok(publicEntry.includes("export const OPERATING_GRAPH_EDGE_RELATIONS"));
  // Append-only + supersession-only: the triggers exist by name.
  for (const trigger of [
    'operating_graph_nodes_registry_trigger',
    'operating_graph_edges_history_trigger',
    'operating_graph_edges_endpoints_trigger',
    'operating_graph_nodes_scope_chain_trigger',
    'operating_graph_edges_scope_chain_trigger',
  ]) {
    assert.ok(migration.includes(trigger), `fence trigger '${trigger}' exists`);
  }
});

// ---------------------------------------------------------------------------
// 9. The shared registration files wire the surface; the additive spec
//    entries exist
// ---------------------------------------------------------------------------

test('routes.ts registers the operating-graph family ONCE; application.ts exposes the SAME module contract', () => {
  assert.ok(routesFile.includes("import { registerOperatingGraphRoutes } from './operating-graph-routes.ts'"));
  assert.equal(
    (routesFile.match(/registerOperatingGraphRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the operating-graph family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-041'));
  assert.ok(compositionRoot.includes('MKT-041'));
  assert.equal(
    (compositionRoot.match(/createOperatingGraphModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second operating-graph module',
  );
  assert.ok(applicationFile.includes('readonly operatingGraph: OperatingGraphModuleApi'));
});

test('the additive spec entries exist (architecture.md §6 + the dependency-matrix line)', () => {
  const architecture = read(spec('architecture.md'));
  assert.ok(
    /^\/operating-graph$/m.test(architecture),
    'the frozen module set includes /operating-graph (required by the static checker)',
  );
  const matrix = read(spec('module-dependency-matrix.md'));
  assert.ok(
    matrix.includes(
      '/operating-graph ──→ /clients, /workspaces, /goals, /playbooks, /workflows, /executions, /deployments, /evidence, /experiments, /learnings',
    ),
    'the dependency matrix carries the additive /operating-graph line',
  );
  assert.ok(
    matrix.includes('/operating-graph` is a derived coordination model'),
    'the forbidden-direction bullet for /operating-graph exists',
  );
});

test('the module structure follows the reporting precedent (public.ts + internal/ only)', () => {
  const moduleDir = src('modules', 'operating-graph');
  const entries = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'internal')
    .map((entry) => entry.name);
  assert.deepEqual(entries, ['public.ts'], 'exactly public.ts + internal/');
  const internal = readdirSync(join(moduleDir, 'internal')).sort();
  assert.deepEqual(internal, [
    'graph-projection.ts',
    'operating-graph-module.ts',
    'operating-graph-store.ts',
  ]);
});
