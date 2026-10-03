/**
 * LAB-013 boundary tests — the static architectural proofs of
 * /lab-capabilities (the lab-features + lab-agent-body boundary
 * precedent, applied to the v1.7 Capability Engine + Arena Adapter):
 *
 *   1. THE NINE OWN FLOW-STAGE TABLES: the migration owns EXACTLY its
 *      nine lab_capability_* tables with the FK anchors EXACTLY the
 *      tenant tables + same-module flow-stage rows — NO foreign key
 *      into /lab, /lab-agent-body, /integrations or ANY other module
 *      (the /lab family by-reference discipline);
 *   2. NO SECOND MARKETPLACE AUTHORITY (the core acceptance —
 *      structural): NO marketplace vocabulary anywhere in the migration
 *      (no price, bid, listing, ranking, escrow or negotiation column)
 *      and no provider-selection logic in the module code (the provider
 *      target is caller-declared DATA; the dispatch flows through the
 *      declared narrow structural port ONLY);
 *   3. THE CLOSED VOCABULARIES + THE GUARDED LIFECYCLES: the CHECK
 *      fences (the §17 actor split on every stage record, the stage
 *      lifecycles, the verdict/outcome/origin/kind vocabularies, the
 *      pinned contract version) and the append-only/immutable guard
 *      triggers (result/verification/simulation/real-test append-only
 *      outright; the guarded status advances; the no-delete discipline
 *      on every table; the scope-consistency triggers);
 *   4. THE UNVERIFIED-NEVER-PRESENTED FENCE: the capability-version
 *      citation trigger rejects anything but a PASSING verification in
 *      the same scope — the verified state is the linked evidence,
 *      never an asserted boolean;
 *   5. THE HUMAN-PLANE BOUNDARY: the human-plane citation is a closed
 *      opaque vocabulary (the canonical plane authorities cited by
 *      reference, never re-modeled — no FK into /field-agents, /jobs or
 *      /executions);
 *   6. the module structure (public.ts + internal/ only) and the empty
 *      cross-module import set (the /lab family discipline);
 *   7. the registration: the granted worker spec append (the §6 line +
 *      the registration paragraph — the LAB-003 precedent), the
 *      composition-root wiring (the Arena structural port over the
 *      REAL /integrations instance + the first-party quality
 *      evaluator) and the ApplicationModules entry;
 *   8. the migration tail: 067_lab_capabilities.sql is the tail (066
 *      held by the in-flight parallel LAB-004 worker — the TL
 *      reconciles at merge);
 *   9. the frozen public surface (the structural ports, the reference
 *      helpers, the pinned contract identity).
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

const moduleDir = src('modules', 'lab-capabilities');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '067_lab_capabilities.sql'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureMd = read(join(repoRoot, 'spec', 'architecture.md'));

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

test('LAB-013 AC: the module owns EXACTLY its nine migration-067 flow-stage tables — no authority table, no /lab table, no /integrations table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...created].sort(),
    [
      'lab_capability_gaps',
      'lab_capability_contracts',
      'lab_capability_value_estimates',
      'lab_capability_requests',
      'lab_capability_results',
      'lab_capability_verifications',
      'lab_capability_versions',
      'lab_capability_simulations',
      'lab_capability_real_tests',
    ].sort(),
  );
  // The FK anchors are EXACTLY the tenant tables + same-module rows.
  const references = [...stripSqlComments(migrationSql).matchAll(/REFERENCES\s+([a-z_]+)/g)].map((match) => match[1]!);
  for (const target of references) {
    assert.ok(
      [
        'agencies',
        'clients',
        'workspaces',
        'lab_capability_gaps',
        'lab_capability_contracts',
        'lab_capability_value_estimates',
        'lab_capability_requests',
        'lab_capability_results',
        'lab_capability_verifications',
        'lab_capability_versions',
      ].includes(target),
      `unexpected FK anchor '${target}' — the FK anchors must be tenant tables + same-module flow-stage rows only`,
    );
  }
  // NO foreign key into any /lab, /lab-agent-body, /integrations or
  // v1.6 authority table (the by-reference discipline).
  for (const forbidden of [
    'REFERENCES lab_scenarios',
    'REFERENCES lab_runs',
    'REFERENCES lab_strategy',
    'REFERENCES lab_organization',
    'REFERENCES lab_capability_candidates',
    'REFERENCES lab_agent_body',
    'REFERENCES integrations',
    'REFERENCES integration_',
    'REFERENCES experiments(',
    'REFERENCES evidence(',
    'REFERENCES jobs(',
    'REFERENCES field_agents',
    'REFERENCES executions(',
    'REFERENCES workflows(',
  ]) {
    assert.ok(!stripSqlComments(migrationSql).includes(forbidden), `the migration must not FK into another module's table ('${forbidden}')`);
  }
});

test('LAB-013 AC: NO SECOND MARKETPLACE AUTHORITY — zero marketplace vocabulary in the schema, zero provider-selection logic in the module', () => {
  const sql = stripSqlComments(migrationSql);
  // No marketplace COLUMN anywhere (the provider target is caller-
  // declared DATA dispatched through the existing provider contracts).
  for (const forbidden of ['price', 'bid_', 'bidding', 'listing', 'ranking', 'escrow', 'negotiat', 'auction', 'vendor_']) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `the migration must not contain marketplace vocabulary ('${forbidden}')`);
  }
  const code = stripComments(moduleCode);
  // No provider-SELECTION logic: the module never chooses an adapter,
  // connection or operation — they arrive as caller-declared data on
  // the governed request record (the only adapter knowledge is the
  // READ-ONLY registry passthrough).
  for (const forbidden of ['selectProvider', 'chooseAdapter', 'bestProvider', 'rankProviders', 'compareProviders']) {
    assert.ok(!code.includes(forbidden), `the module must not contain provider-selection logic ('${forbidden}')`);
  }
  // The declared provider-target DATA columns are exactly the three
  // (adapter key + connection id + operation).
  assert.ok(migrationSql.includes('adapter_key'), 'the provider target carries the adapter key as DATA');
  assert.ok(migrationSql.includes('connection_id'), 'the provider target carries the opaque connection id as DATA');
  assert.ok(migrationSql.includes('operation'), 'the provider target carries the normalized operation as DATA');
  // The ARENA port is the ONLY provider surface: exactly the two
  // methods, no routing/pricing/negotiation surface.
  assert.ok(publicTs.includes('export interface LabCapabilitiesArenaPort'), 'the Arena structural port is declared');
  assert.ok(publicTs.includes('listRegisteredAdapters(): ReadonlyArray<LabCapabilityArenaAdapterInfo>;'), 'the port exposes the READ-ONLY registry read only');
  assert.ok(publicTs.includes('executeMutation('), 'the port exposes the governed mutation only');
});

test('LAB-013 AC: the CHECK-fenced closed vocabularies + the guarded lifecycles (every stage record carries its actor + its closed state)', () => {
  const sql = migrationSql;
  // The §17 actor split is CHECK-fenced on EVERY stage table.
  const actorChecks = [...sql.matchAll(/CHECK \((?:detection_)?actor IN \('autonomous', 'human'\)\)/g)];
  // 9 tables carry an actor column (gap uses detection_actor; the
  // version record carries its insertion actor).
  assert.equal(actorChecks.length, 9, 'every stage table CHECK-fences the autonomous/human vocabulary');
  // The §16 gap action-kind vocabulary.
  for (const actionKind of ["'physical_performance'", "'platform_action_gap'", "'authentic_demonstration'", "'specialized_media_treatment'"]) {
    assert.ok(sql.includes(actionKind), `the §16 action-kind vocabulary is CHECK-fenced (${actionKind})`);
  }
  // The stage lifecycles.
  assert.ok(sql.includes("CHECK (status IN ('open', 'contracted', 'resolved', 'abandoned'))"), 'the gap lifecycle is CHECK-fenced');
  assert.ok(sql.includes("CHECK (status IN ('derived', 'withdrawn'))"), 'the contract lifecycle is CHECK-fenced');
  assert.ok(sql.includes("CHECK (status IN ('recorded', 'superseded'))"), 'the estimate lifecycle is CHECK-fenced');
  assert.ok(sql.includes("CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'))"), 'the request lifecycle is CHECK-fenced');
  assert.ok(sql.includes("CHECK (status IN ('draft', 'active', 'retired'))"), 'the capability-version lifecycle is CHECK-fenced (the LAB-011 precedent)');
  // The closed verdict/outcome/fulfillment vocabularies.
  assert.ok(sql.includes("CHECK (verdict IN ('pass', 'fail', 'inconclusive'))"), 'the verification verdict vocabulary is CHECK-fenced');
  assert.ok(sql.includes("CHECK (outcome IN ('passed', 'failed', 'inconclusive'))"), 'the link outcome vocabulary is CHECK-fenced');
  assert.ok(sql.includes("CHECK (fulfillment_kind IN ('provider', 'human_plane'))"), 'the fulfillment vocabulary is CHECK-fenced');
  // The closed §16 origin + implementation-kind vocabularies.
  assert.ok(sql.includes("CHECK (origin IN ('first_party_declared', 'arena_provider', 'human_contribution'))"), 'the provenance origin vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'simulator', 'real', 'hybrid', 'declared_only'"), 'the implementation-kind vocabulary is CHECK-fenced');
  // The §16 gap action-kind vocabulary.
  assert.ok(sql.includes("'physical_performance',"), 'the §16 action-kind vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'platform_action_gap',"), 'the §16 action-kind vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'authentic_demonstration',"), 'the §16 action-kind vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'specialized_media_treatment'"), 'the §16 action-kind vocabulary is CHECK-fenced');
  // The human-plane + real-test authority vocabularies (the canonical
  // planes cited opaquely).
  assert.ok(sql.includes("human_plane_citation->>'planeAuthority' IN ('field-agents', 'jobs', 'executions')"), 'the human-plane authority vocabulary is CHECK-fenced');
  assert.ok(sql.includes("real_test_citation->>'authority' IN ('experiments', 'executions', 'evidence', 'workflows')"), 'the real-test authority vocabulary is CHECK-fenced');
  // The pinned contract version on every table.
  assert.equal([...sql.matchAll(/CHECK \(contract_version = 'lab-capabilities-contract-v1'\)/g)].length, 9, 'every table pins the contract version');
  // The guarded status advances.
  assert.ok(sql.includes('lab_capability_gap_guard'), 'the gap guard enforces the lifecycle');
  assert.ok(sql.includes('lab_capability_contract_guard'), 'the contract guard enforces the lifecycle');
  assert.ok(sql.includes('lab_capability_estimate_guard'), 'the estimate guard enforces the lifecycle');
  assert.ok(sql.includes('lab_capability_request_guard'), 'the request guard enforces the single dispatch advance + the frozen echo');
  assert.ok(sql.includes('lab_capability_version_guard'), 'the capability-version guard enforces the LAB-011 lifecycle');
  // Append-only outright on the evidence stages.
  for (const trigger of [
    'lab_capability_results_no_update_trigger',
    'lab_capability_results_no_delete_trigger',
    'lab_capability_verifications_no_update_trigger',
    'lab_capability_verifications_no_delete_trigger',
    'lab_capability_simulations_no_update_trigger',
    'lab_capability_simulations_no_delete_trigger',
    'lab_capability_real_tests_no_update_trigger',
    'lab_capability_real_tests_no_delete_trigger',
  ]) {
    assert.ok(sql.includes(trigger), `the append-only trigger exists ('${trigger}')`);
  }
  // NO row of ANY stage table is ever deleted (one no-delete trigger
  // per table — 9 tables).
  assert.equal([...sql.matchAll(/CREATE TRIGGER \w+_no_delete_trigger/g)].length, 9, 'every stage table rejects DELETE');
  // The scope-consistency triggers (the §22 cross-tenant injection fences).
  for (const trigger of [
    'lab_capability_contract_scope_check',
    'lab_capability_estimate_scope_check',
    'lab_capability_request_scope_check',
    'lab_capability_result_scope_check',
    'lab_capability_verification_scope_check',
    'lab_capability_chain_scope_check',
    'lab_capability_simulation_scope_check',
    'lab_capability_real_test_scope_check',
  ]) {
    assert.ok(sql.includes(trigger), `the scope-consistency trigger exists ('${trigger}')`);
  }
});

test('LAB-013 AC: THE UNVERIFIED-NEVER-PRESENTED FENCE — the capability-version citation trigger rejects anything but a PASSING verification', () => {
  const sql = migrationSql;
  assert.ok(sql.includes('lab_capability_verification_citation_check'), 'the citation trigger exists');
  assert.ok(
    sql.includes("RAISE EXCEPTION 'lab capability version may cite only a PASSING verification"),
    'a version citing a failing/inconclusive verification is inexpressible',
  );
  assert.ok(
    sql.includes('cross-tenant citation is rejected'),
    'a version citing a foreign-scope verification is inexpressible',
  );
  // The verified state is NEVER an asserted boolean on the version row:
  // there is no 'verified' column anywhere — the linkage + the verdict
  // on the verification row are the only truth.
  const versionTable = sql.slice(
    sql.indexOf('CREATE TABLE IF NOT EXISTS lab_capability_versions'),
    sql.indexOf('-- ---------------------------------------------------------------------------', sql.indexOf('CREATE TABLE IF NOT EXISTS lab_capability_versions')),
  );
  assert.ok(!/\bverified\b/.test(versionTable), 'the capability-version table carries NO asserted verified boolean');
  assert.ok(versionTable.includes('source_verification_id'), 'the linkage column is the evidence anchor');
});

test('LAB-013 AC: THE HUMAN-PLANE BOUNDARY — the canonical plane is cited OPAQUELY, never re-modeled', () => {
  const sql = stripSqlComments(migrationSql);
  // The human-plane citation is recorded jsonb DATA (plane authority +
  // record reference) — NO FK into the plane tables, NO plane state
  // columns (status, assignee, deadline...) anywhere.
  for (const forbidden of [
    'REFERENCES jobs',
    'REFERENCES field_agents',
    'REFERENCES executions',
    'human_task_status',
    'human_assignee',
    'human_deadline',
  ]) {
    assert.ok(!sql.includes(forbidden), `the human plane must not be re-modeled ('${forbidden}')`);
  }
  const code = stripComments(moduleCode);
  // The module never calls the human-plane authorities: it CITES them.
  for (const forbidden of ['createJobsModule', 'createFieldAgentsModule', 'createExecutionsModule', 'assignTask', 'createTask(', 'submitOutcome']) {
    assert.ok(!code.includes(forbidden), `the module must not drive the human plane ('${forbidden}')`);
  }
  // The grant-rights discipline: the granted rights are recorded DATA
  // (null = nothing granted) — the §17 explicit-contract-rights rule.
  assert.ok(migrationSql.includes('granted_rights'), 'the granted-rights record is carried as DATA');
  assert.ok(publicTs.includes('grants ONLY its explicit contract rights'), 'the contract-rights discipline is declared on the public surface');
});

test('LAB-013 AC: the module imports NO other module — the /lab family discipline (zero cross-module imports; the two structural ports are the composition-root wiring)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The static checker enforces it with zero violations (57 enforced
  // modules: 56 spec-parsed — the granted LAB-013 worker spec
  // registration, the LAB-003 precedent — + the single /apps
  // provision; NO lab-capabilities checker provision exists: the
  // provision mechanism is structurally for spec-pending modules
  // only).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('lab-capabilities'));
  assert.equal(result.frozenModules.length, 59);
});

test('LAB-013 AC: the registration — the granted worker spec append + the composition-root wiring + the ApplicationModules entry', () => {
  // The §6 module list line + the registration paragraph (the LAB-003
  // granted worker registration precedent — the ONE spec exception the
  // Tech Lead granted this delivery; no matrix row: /lab-capabilities
  // consumes NO other module).
  const moduleListMatch = architectureMd.match(/## 6\. Core domain modules\s*```text([\s\S]*?)```/);
  assert.ok(moduleListMatch !== null);
  assert.ok(
    /^\s*\/lab-capabilities\s*$/m.test(moduleListMatch[1]!),
    'spec/architecture.md §6 carries the /lab-capabilities module list line',
  );
  assert.ok(architectureMd.includes('`/lab-capabilities` is the v1.7 Capability Engine + Arena Adapter authority'), 'the §6 registration paragraph is present');
  // NO matrix row was added (the /lab family precedent: platform ports
  // only, empty allowance).
  const matrix = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));
  assert.ok(!/lab-capabilities\s*(?:──)?→/.test(matrix), 'no matrix row was needed (the empty-allowance /lab family posture)');
  // The composition root: the import + the wiring with the two
  // structural ports + the modules-map tail.
  assert.ok(compositionRoot.includes("from './modules/lab-capabilities/public.ts'"), 'the composition root imports the module public entry');
  assert.ok(compositionRoot.includes('const labCapabilities = createLabCapabilitiesModule({'), 'the composition root wires the module');
  assert.ok(compositionRoot.includes('const labCapabilitiesArena: LabCapabilitiesArenaPort = {'), 'the Arena structural port is the disclosed composition-root wrapper');
  assert.ok(compositionRoot.includes('listRegisteredAdapters: () => integrations.listRegisteredAdapters(),'), 'the port delegates the READ-ONLY registry read to the REAL /integrations instance');
  assert.ok(compositionRoot.includes('executeMutation: (input, provenance) => integrations.executeMutation(input, provenance),'), 'the port delegates the governed mutation to the REAL /integrations instance (the fail-closed gates stay there)');
  assert.ok(compositionRoot.includes('evaluator: createFirstPartyLabCapabilityEvaluator(),'), 'the first-party quality evaluator is the wired port');
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, contentStudio, labFeatures, commerceDiscovery, labCapabilities, labIdeas, labSimulator }'), 'the modules map carries the entry');
  // ApplicationModules.
  assert.ok(applicationTs.includes("from '../modules/lab-capabilities/public.ts'"), 'application.ts imports the public contract');
  assert.ok(applicationTs.includes('readonly labCapabilities: LabCapabilitiesModuleApi;'), 'ApplicationModules carries the entry');
});

test('LAB-013 AC: the migration tail — 067_lab_capabilities.sql after the merged 065 (066 is held by the in-flight parallel LAB-004 worker)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrations.includes('067_lab_capabilities.sql'));
  assert.equal(migrations[migrations.length - 4], '067_lab_capabilities.sql');
  assert.equal(migrations[migrations.length - 6], '065_lab_features.sql');
  assert.ok(migrations.some((name) => name.startsWith('066_')), '066 is the merged LAB-004 /lab-ideas delivery (the TL reconciled the numbering at merge: 065 → 066 → 067)');
  // The module boundary is complete.
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const file of moduleFiles) {
    assert.ok(file.endsWith('.ts'), `the internal implementation files are TypeScript ('${file}')`);
  }
});

test('LAB-013 AC: the frozen public surface (the structural ports, the reference helpers, the pinned contract identity)', () => {
  assert.ok(publicTs.includes("LAB_CAPABILITIES_CONTRACT_VERSION = 'lab-capabilities-contract-v1'"), 'the contract identity is pinned');
  assert.ok(publicTs.includes('export interface LabCapabilitiesArenaPort'), 'the Arena structural port is exported');
  assert.ok(publicTs.includes('export interface LabCapabilityQualityEvaluatorPort'), 'the quality-evaluator port is exported');
  assert.ok(publicTs.includes('export interface LabCapabilitiesModuleApi'), 'the module API is exported');
  assert.ok(publicTs.includes('export function labCapabilityVersionReference'), 'the opaque reference formatter is exported');
  assert.ok(publicTs.includes('export function parseLabCapabilityVersionReference'), 'the opaque reference parser is exported');
  assert.ok(publicTs.includes('createLabCapabilitiesModule'), 'the module factory is exported');
  assert.ok(publicTs.includes('createFirstPartyLabCapabilityEvaluator'), 'the first-party evaluator factory is exported');
  // The §17 flow methods are the public surface, in the flow's order.
  const flowOrder = [
    'detectCapabilityGap',
    'deriveCapabilityContract',
    'recordCapabilityValueEstimate',
    'createCapabilityRequest',
    'dispatchCapabilityRequest',
    'recordProviderCapabilityResult',
    'recordHumanPlaneCapabilityResult',
    'verifyCapabilityResult',
    'insertCapabilityVersion',
    'recordCapabilitySimulation',
    'recordCapabilityRealTest',
  ];
  let cursor = -1;
  for (const method of flowOrder) {
    const index = publicTs.indexOf(method);
    assert.ok(index >= 0, `the §17 flow method is on the public surface ('${method}')`);
    assert.ok(index > cursor, `the §17 flow methods are declared in the flow's order ('${method}')`);
    cursor = index;
  }
});
