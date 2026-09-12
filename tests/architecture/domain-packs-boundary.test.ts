/**
 * MKT-036 static tests — the Domain Pack framework boundary is
 * structurally correct, execution-machinery-free and CRED-001-clean in
 * the ACTUAL module contract, migration, routes and source tree (pure
 * static analysis, no DB).
 *
 * Acceptance proofs (requirements-v1.3.md PACK-001, acceptance
 * PACK-AC-02/AC-03; work-item-matrix-v1.3.md MKT-036 = "PACK-AC-01..03";
 * spec/domain-pack-v1.3.md §3 "A Domain Pack MUST use the platform
 * authorities for: tenant/client authorization; workflow state; execution
 * identity; evidence/provenance; AI routing/evaluation; credentials;
 * audit; extension installation/invocation. A Domain Pack MUST NOT
 * introduce an alternate workflow engine, Job engine, evidence
 * authority, tenant authority, or credential store"; spec/
 * implementation-contract.md §1 authority model, §4 workflow definition
 * contract; spec/module-dependency-v1.3.md "/domain-packs → /agencies,
 * /clients, /workspaces, /goals, /playbooks, /workflows, /executions,
 * /agents, /jobs, /evidence, /metrics, /experiments, /learnings,
 * /extensions, /policies, /audit" and "may not own workflow state,
 * execution state, evidence provenance, credentials, AI routing, or Job
 * assignment"):
 *
 *   1. the domain_packs + domain_pack_installs + domain_pack_artifacts
 *      storage carries the frozen column sets — the closed 14-kind
 *      artifact vocabulary, the closed client|agency-reusable scope
 *      vocabulary, the immutable-version fence, registry immutability,
 *      the install scope-chain fences, the frozen install lifecycle, the
 *      append-only artifact records, the artifact scope CHECK and the
 *      artifact/install consistency fence — and NO column capable of
 *      holding secret material or a secret handle (CRED-001/§21);
 *
 *   2. PACK-AC-02 (static architecture check): the /domain-packs module
 *      domain code imports ONLY platform ports (db/clock/ids/errors) +
 *      the /workflows PUBLIC contract (its PURE §4
 *      validateWorkflowDefinitionContent — pack workflow templates
 *      conform to the Workflow authority's own definition contract);
 *      ZERO imports of any other authority's module — the framework
 *      composes the Execution, Evidence, AI Router, Credential, Policy,
 *      and Audit authorities ONLY at pack-workflow EXECUTION time
 *      through /workflows + /executions, never inside the framework;
 *
 *   3. PACK-AC-02 (API surface): the module API is exactly the registry
 *      + install + artifact-scope surface — NO execution machinery (no
 *      run/start/dispatch/instance), NO workflow-state mutation, NO
 *      execution lifecycle, NO evidence creation, NO credential
 *      anything, NO AI routing, NO Job assignment, NO audit disabling —
 *      the framework cannot become an alternate authority;
 *
 *   4. the route set is exactly the twelve frozen MKT-036 routes — no
 *      update, no delete (registry versions, install history and
 *      artifact scope records are immutable/append-only) — and the DTO
 *      authority-field contracts reject identity/scope/provenance
 *      authority fields and material-shaped keys.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOMAIN_PACK_ARTIFACT_KINDS,
  DOMAIN_PACK_ARTIFACT_SCOPES,
} from '../../src/modules/domain-packs/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration030 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '030_domain_packs.sql'),
  'utf8',
);
const domainPacksPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'domain-packs', 'public.ts'),
  'utf8',
);
const domainPacksModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'domain-packs', 'internal', 'module.ts'),
  'utf8',
);
const domainPacksStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'domain-packs', 'internal', 'store.ts'),
  'utf8',
);
const domainPacksRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'domain-packs-routes.ts'),
  'utf8',
);
const applicationTs = readFileSync(join(repoRoot, 'src', 'api', 'application.ts'), 'utf8');
const routesTs = readFileSync(join(repoRoot, 'src', 'api', 'routes.ts'), 'utf8');
const compositionRoot = readFileSync(join(repoRoot, 'src', 'composition-root.ts'), 'utf8');

/** Extracts the CREATE TABLE block for `table` from a migration SQL text (comment lines stripped). */
function createTableBlock(migration: string, table: string): string {
  // Strip SQL comment lines first: comments can contain ');' which would
  // otherwise cut the block early.
  const source = migration
    .split('\n')
    .map((line) => (line.trim().startsWith('--') ? '' : line))
    .join('\n');
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = source.indexOf(');', start);
  assert.ok(end > start, `${table} block must terminate`);
  return source.slice(start, end);
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
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. Storage: the frozen column sets, fences and the no-material posture
// ---------------------------------------------------------------------------

test('migration 030 exists and creates exactly the three /domain-packs tables', () => {
  assert.ok(migration030.includes('CREATE TABLE IF NOT EXISTS domain_packs ('));
  assert.ok(migration030.includes('CREATE TABLE IF NOT EXISTS domain_pack_installs ('));
  assert.ok(migration030.includes('CREATE TABLE IF NOT EXISTS domain_pack_artifacts ('));
});

test('domain_packs storage: exactly the frozen registry columns — no material- or handle-capable column, no tenant column', () => {
  const columns = columnsOf(createTableBlock(migration030, 'domain_packs'));
  assert.deepEqual(columns, [
    'pack_id',
    'pack_key',
    'publisher',
    'version',
    'display_name',
    'description',
    'compat_min',
    'compat_max',
    'required_packs',
    'artifacts',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'created_at',
    'updated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token', 'agency_id', 'client_id', 'workspace_id']) {
    assert.ok(!columns.includes(forbidden), `domain_packs must not carry a '${forbidden}' column (the registry is global catalog state)`);
  }
});

test('domain_packs storage: the immutable-version fence is a database backstop (domain-pack-v1.3.md §4)', () => {
  // (publisher, pack_key, version) UNIQUE — re-publication of the same
  // version is a constraint violation; a new version is a new row.
  assert.ok(migration030.includes('domain_packs_version_unique'));
  // Published rows reject UPDATE and DELETE outright.
  assert.ok(migration030.includes('domain_packs_registry_immutable_update_trigger'));
  assert.ok(migration030.includes('domain_packs_registry_immutable_delete_trigger'));
});

test('domain_packs storage: the closed vocabulary CHECKs are database backstops (§2 kinds, §5 scopes)', () => {
  for (const kind of DOMAIN_PACK_ARTIFACT_KINDS) {
    assert.ok(migration030.includes(`'${kind}'`), `the artifact-kind CHECK must include '${kind}'`);
  }
  for (const scope of DOMAIN_PACK_ARTIFACT_SCOPES) {
    assert.ok(migration030.includes(`'${scope}'`), `the artifact-scope CHECK must include '${scope}'`);
  }
  // The §5 forbidden scopes are structurally absent.
  assert.ok(!migration030.includes("'cross-client'"));
  assert.ok(!migration030.includes("'all-clients'"));
});

test('domain_packs storage: the §21 material-key CHECK guards every jsonb payload column', () => {
  assert.ok(migration030.includes('domain_packs_payload_has_no_material_keys'));
  const fenced = (migration030.match(/domain_packs_payload_has_no_material_keys\(/g) ?? []).length;
  // required_packs + artifacts (registry) + the recursive validator body
  // + the artifact payload bound: all fenced.
  assert.ok(fenced >= 4, 'every jsonb payload column must be fenced by the material-key validator');
});

test('domain_pack_installs storage: exactly the frozen install columns — the installed-version record (PACK-AC-01)', () => {
  const columns = columnsOf(createTableBlock(migration030, 'domain_pack_installs'));
  assert.deepEqual(columns, [
    'install_id',
    'pack_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'status',
    'idempotency_key',
    'version',
    'created_by',
    'uninstalled_at',
    'created_at',
    'updated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token']) {
    assert.ok(!columns.includes(forbidden), `domain_pack_installs must not carry a '${forbidden}' column`);
  }
});

test('domain_pack_installs storage: the scope-chain, immutability and lifecycle fences are database backstops', () => {
  // Client ∈ agency, workspace ∈ client (the Client boundary cannot be
  // crossed through the install columns, even by direct SQL).
  assert.ok(migration030.includes('domain_pack_installs_scope_legal'));
  // Identity/scope immutability.
  assert.ok(migration030.includes('domain_pack_installs_immutable'));
  // The frozen lifecycle (born installed; uninstalled terminal) + the
  // one-install-per-(workspace, pack version) fence.
  assert.ok(migration030.includes('domain_pack_installs_lifecycle_legal'));
  assert.ok(migration030.includes('domain_pack_installs_workspace_pack_unique'));
  const block = createTableBlock(migration030, 'domain_pack_installs').replace(/\s+/g, ' ');
  assert.ok(
    block.includes("status IN ('installed', 'disabled', 'uninstalled')"),
    'the install status CHECK must be the frozen three-state set',
  );
});

test('domain_pack_artifacts storage: exactly the frozen artifact-scope record columns — the §5 distinction is structural (PACK-AC-03)', () => {
  const columns = columnsOf(createTableBlock(migration030, 'domain_pack_artifacts'));
  assert.deepEqual(columns, [
    'artifact_id',
    'install_id',
    'pack_id',
    'artifact_kind',
    'artifact_name',
    'scope',
    'agency_id',
    'client_id',
    'workspace_id',
    'created_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token', 'payload']) {
    assert.ok(!columns.includes(forbidden), `domain_pack_artifacts must not carry a '${forbidden}' column (content is served from the immutable registry row)`);
  }
  // THE structural fence: client-scoped → client NOT NULL;
  // agency-reusable → client NULL.
  assert.ok(migration030.includes('domain_pack_artifacts_scope_shape'));
  const shape = migration030.replace(/\s+/g, ' ');
  assert.ok(
    shape.includes("(scope = 'client' AND client_id IS NOT NULL) OR (scope = 'agency-reusable' AND client_id IS NULL)"),
    'the artifact scope shape CHECK must structurally distinguish the §5 scopes',
  );
});

test('domain_pack_artifacts storage: append-only + consistency fences are database backstops (PACK-AC-03)', () => {
  // APPEND-ONLY (the 015/018/025/028 pattern): UPDATE and DELETE
  // rejected — cross-client re-parenting is impossible at the storage
  // layer.
  assert.ok(migration030.includes('domain_pack_artifacts_append_only_update_trigger'));
  assert.ok(migration030.includes('domain_pack_artifacts_append_only_delete_trigger'));
  // The artifact is bound to its install's pack/workspace/agency and
  // (for client scope) its client.
  assert.ok(migration030.includes('domain_pack_artifacts_consistent'));
});

test('PACK-AC-02 storage posture: the migration creates NO workflow/execution/evidence/credential/audit/Job table, column or trigger', () => {
  // No CREATE TABLE for any other authority's concern; no mutation of
  // the workflows, workflow_instances, executions, evidence, ai_*,
  // credentials or jobs tables anywhere in the migration.
  assert.ok(!/CREATE TABLE[^(]*(workflow|execution|evidence|credential|audit|job)/i.test(migration030));
  assert.ok(!/(INSERT INTO|UPDATE|DELETE FROM)\s+(workflow|workflow_instances|executions|evidence|ai_|credentials|jobs|audit)/i.test(migration030));
  // No workflow-state or execution-state column anywhere.
  for (const table of ['domain_packs', 'domain_pack_installs', 'domain_pack_artifacts']) {
    const block = createTableBlock(migration030, table);
    assert.ok(!block.includes('workflow_status'), `${table} must not carry workflow state`);
    assert.ok(!block.includes('execution_status'), `${table} must not carry execution state`);
    assert.ok(!/ REFERENCES (workflows|workflow_instances|executions|evidence|jobs)\(/.test(block), `${table} must not reference runtime authority rows`);
  }
});

// ---------------------------------------------------------------------------
// 2. PACK-AC-02 — the module import surface (the frozen matrix posture)
// ---------------------------------------------------------------------------

test('PACK-AC-02: the /domain-packs module imports ONLY platform ports + the /workflows public entry (its PURE §4 validator)', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'domain-packs');
  const files = collectTsFiles(moduleDir);
  assert.ok(files.length >= 3, 'the domain-packs module must exist with public + internal files');
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith('.')) {
        assert.ok(
          specifier.startsWith('node:'),
          `${file}: external import '${specifier}' is forbidden (platform ports only)`,
        );
        continue;
      }
      // Platform port imports are always allowed (db/clock/ids/errors).
      if (/platform\//.test(specifier)) continue;
      // Intra-module imports are fine.
      const fromInternal = file.includes(join('domain-packs', 'internal'));
      const toSelf =
        specifier.startsWith('./') ||
        (fromInternal && specifier.endsWith('../public.ts'));
      if (toSelf) continue;
      // The ONE matrix-allowed cross-module import: the /workflows
      // public contract, from either depth (public.ts imports
      // ../x/public.ts; internal/ imports ../../x/public.ts).
      const allowed = /^(\.\.\/)+((workflows)\/public\.ts)$/.test(specifier);
      assert.ok(
        allowed,
        `${file}: cross-module import '${specifier}' is not allowed (the framework composes authorities only at pack-workflow execution time; the only module-level import is /workflows public for §4 template conformance)`,
      );
    }
  }
});

test('PACK-AC-02: workflow-template conformance flows through the /workflows authority validator — never a pack-side reimplementation', () => {
  // The store imports the validator from the /workflows PUBLIC contract.
  assert.ok(
    domainPacksStore.includes("import { validateWorkflowDefinitionContent } from '../../workflows/public.ts'"),
    'the module must validate workflow templates through the /workflows authority validator (PACK-AC-02)',
  );
  assert.ok(domainPacksStore.includes('validateWorkflowDefinitionContent(declaration.payload)'));
  // The framework does NOT reimplement graph validation.
  assert.ok(!domainPacksStore.includes('validateGraph'));
  assert.ok(!domainPacksStore.includes('workflow-graph.ts'));
});

test('PACK-AC-02: ZERO imports of runtime authorities inside the /domain-packs module — no alternate engine is reachable', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'domain-packs');
  for (const file of collectTsFiles(moduleDir)) {
    const source = readFileSync(file, 'utf8');
    // The frozen matrix ALLOWED set minus /workflows (the §4 validator)
    // is deliberately unused: no executions, evidence, ai-runtime,
    // credentials, jobs, metrics, experiments, learnings, agents,
    // extensions, policies, clients, workspaces, agencies, goals,
    // playbooks imports — pack workflows reach those authorities ONLY
    // at execution time through /workflows + /executions.
    for (const authority of [
      'executions',
      'evidence',
      'ai-runtime',
      'credentials',
      'jobs',
      'metrics',
      'experiments',
      'learnings',
      'agents',
      'extensions',
      'policies',
      'clients',
      'workspaces',
      'agencies',
      'goals',
      'playbooks',
    ]) {
      assert.ok(
        !source.includes(`/${authority}/public.ts`),
        `${file}: the domain-packs framework must not import /${authority} (PACK-AC-02 — composition happens at pack-workflow execution time through the existing authorities)`,
      );
    }
  }
  // The composition root wires the module with platform ports only.
  const wiring = /createDomainPacksModule\(\{[^}]+\}\)/.exec(compositionRoot);
  assert.ok(wiring !== null, 'the composition root must construct the domain-packs module');
  assert.deepEqual(
    wiring[0]!.replace(/\s+/g, ''),
    'createDomainPacksModule({db,clock,ids})',
    'the domain-packs module is wired with platform ports only (no authority instance)',
  );
});

test('the /domain-packs module domain code has no provider SDK, pg, secrets resolution or sandbox runtime coupling', () => {
  const sources = [domainPacksPublic, domainPacksModule, domainPacksStore].join('\n');
  assert.ok(!/from\s+['"]pg['"]/.test(sources), 'no pg import inside the module');
  assert.ok(!sources.includes('node-postgres'), 'no node-postgres reference');
  for (const forbidden of [
    'SecretStore',
    'resolveCredentialMaterial',
    'secrets/adapters',
    'SandboxDriver',
    'sandboxDriver',
    'provisionSandbox',
    'transitionExecution',
    'openai',
    'anthropic',
  ]) {
    assert.ok(!sources.includes(forbidden), `the domain-packs module must not touch '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 3. PACK-AC-02 — the module API surface (no execution machinery)
// ---------------------------------------------------------------------------

test('PACK-AC-02: the module API is exactly the declared registry + install + artifact-scope surface', () => {
  const apiMembers = [
    'publishDomainPackVersion',
    'getDomainPackVersion',
    'listDomainPackVersions',
    'installDomainPack',
    'getDomainPackInstall',
    'listDomainPackInstalls',
    'setDomainPackInstallStatus',
    'getDomainPackArtifact',
    'listDomainPackArtifactsForWorkspace',
    'listDomainPackArtifactsForAgency',
  ];
  for (const member of apiMembers) {
    assert.ok(domainPacksPublic.includes(`  ${member}(`), `the API must declare ${member}`);
  }
});

test('PACK-AC-02: the module API exports NO execution machinery — the framework cannot become an alternate authority (domain-pack-v1.3.md §3)', () => {
  // Workflow state belongs only to /workflows; execution identity only
  // to /executions; evidence only to /evidence; credentials only to
  // /credentials; AI routing only to /ai-runtime; Jobs only to /jobs.
  for (const forbidden of [
    'createWorkflowInstance',
    'transitionWorkflow',
    'mutateWorkflow',
    'setWorkflowStatus',
    'startWorkflow',
    'runWorkflow',
    'dispatchNode',
    'createExecution',
    'startExecution',
    'transitionExecution',
    'appendEvidence',
    'createEvidence',
    'createCredential',
    'resolveCredentialMaterial',
    'routeModel',
    'invokeModel',
    'assignJob',
    'createJob',
    'evaluatePolicy',
    'appendAuditEvent',
    'disableAudit',
  ]) {
    assert.ok(!domainPacksPublic.includes(forbidden), `the module API must not expose '${forbidden}'`);
  }
  // The routes must not expose execution machinery either.
  for (const forbidden of ['createWorkflowInstance', 'startWorkflow', 'runWorkflow', 'dispatch', 'createExecution', 'startExecution', 'appendEvidence', 'createCredential']) {
    assert.ok(!domainPacksRoutes.includes(forbidden), `the routes must not expose '${forbidden}'`);
  }
});

test('CRED-001: the pack framework never touches secret material — the §21 walker is part of the contract', () => {
  assert.ok(domainPacksStore.includes('DOMAIN_PACK_MATERIAL_SHAPED_KEYS'));
  assert.ok(domainPacksStore.includes('payloadHasNoDomainPackMaterialKeys'));
  assert.ok(domainPacksPublic.includes('payloadHasNoDomainPackMaterialKeys'));
  assert.ok(!domainPacksPublic.includes('resolveCredentialMaterial'));
});

// ---------------------------------------------------------------------------
// 4. The route set + DTO authority-field contracts
// ---------------------------------------------------------------------------

test('the route set is exactly the twelve frozen MKT-036 routes — no update, no delete', () => {
  const routePattern = /router\.add\(\s*'([A-Z]+)',\s*\n?\s*'([^']+)'/g;
  const routes: string[] = [];
  for (const match of domainPacksRoutes.matchAll(routePattern)) {
    routes.push(`${match[1]} ${match[2]}`);
  }
  assert.deepEqual(routes, [
    'POST /api/domain-packs',
    'GET /api/domain-packs',
    'GET /api/domain-packs/:packId',
    'POST /api/workspaces/:workspaceId/domain-pack-installs',
    'GET /api/workspaces/:workspaceId/domain-pack-installs',
    'GET /api/workspaces/:workspaceId/domain-pack-installs/:installId',
    'POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/disable',
    'POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/enable',
    'POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/uninstall',
    'GET /api/workspaces/:workspaceId/domain-pack-artifacts',
    'GET /api/agencies/:agencyId/domain-pack-artifacts',
    'GET /api/domain-pack-artifacts/:artifactId',
  ]);
  assert.ok(
    !routes.some((route) => route.startsWith('PUT ') || route.startsWith('PATCH ') || route.startsWith('DELETE ')),
    'no update/delete routes: registry versions, install history and artifact scope records are immutable/append-only',
  );
});

test('publication and install DTOs reject identity/provenance/scope authority fields and material-shaped keys', () => {
  for (const forbidden of [
    'packId',
    'createFingerprint',
    'createdBy',
    'provenance',
    'correlationId',
    'scope',
    'agencyId',
    'clientId',
    'workspaceId',
    'status',
    'secret',
    'secretMaterial',
    'material',
    'password',
    'apiKey',
    'secretHandle',
  ]) {
    assert.ok(
      domainPacksRoutes.includes(`'${forbidden}',`),
      `the authority-field contract must reject '${forbidden}'`,
    );
  }
});

test('the agency artifact listing returns ONLY agency-reusable records — the §5 explicit distinction as a query (PACK-AC-03)', () => {
  // The module contract pins the distinction; the store query filters
  // on it; the route labels the response.
  assert.ok(domainPacksPublic.includes("(the agency listing returns ONLY 'agency-reusable' records)"));
  assert.ok(domainPacksStore.includes("a.scope = 'agency-reusable'"));
  assert.ok(domainPacksRoutes.includes("scope: 'agency-reusable'"));
  // The workspace listing carries the explicit scope on every record.
  assert.ok(domainPacksRoutes.includes('scope: record.scope'));
});

// ---------------------------------------------------------------------------
// 5. Wiring: application modules, routes and composition root
// ---------------------------------------------------------------------------

test('the domain-packs module is wired into the application modules, the router and the composition root', () => {
  assert.ok(applicationTs.includes('readonly domainPacks: DomainPacksModuleApi'));
  assert.ok(applicationTs.includes("import type { DomainPacksModuleApi } from '../modules/domain-packs/public.ts'"));
  assert.ok(routesTs.includes("import { registerDomainPacksRoutes } from './domain-packs-routes.ts'"));
  assert.ok(routesTs.includes('registerDomainPacksRoutes(router, services, modules)'));
  assert.ok(compositionRoot.includes("import { createDomainPacksModule } from './modules/domain-packs/public.ts'"));
  assert.ok(compositionRoot.includes('domainPacks'));
});
