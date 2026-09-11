/**
 * MKT-022 static tests — the extension registry boundary is structurally
 * correct, workflow-mutation-free and CRED-001-clean in the ACTUAL module
 * contract, migration, routes and source tree (pure static analysis, no
 * DB).
 *
 * Acceptance proofs (requirements.md EXT-001; work-item-matrix.md MKT-022
 * = "registry + manifest contract"; spec/architecture.md §2.1 "PostgreSQL
 * is authoritative"; spec/extension-model.md §2 manifest, §3 capability
 * categories, §4 lifecycle, §5 permissions; spec/implementation-contract.md
 * §3 "No externally supplied field may override a server-derived actor,
 * owner, provenance, policy decision, or evidence authority value", §19
 * extension contract, §21 credential contract; spec/
 * module-dependency-matrix.md "/extensions ──→ /executions, /policies,
 * /credentials, /audit" and "/extensions must not mutate /workflows
 * except through an authorized workflow command/port"; spec/
 * security-threat-model.md "Caller-supplied authority fields"):
 *
 *   1. the extensions + extension_installs + extension_invocations
 *      storage carries the frozen column sets — the closed capability
 *      category / permission action / data-scope / runtime-class CHECKs,
 *      the immutable-version fence, registry immutability, the install
 *      scope-chain fences, the frozen install lifecycle, the append-only
 *      invocation triggers, the invocation consistency fence and the TTL
 *      bound — and NO column capable of holding secret material or a
 *      secret handle (CRED-001: required secret names are LOGICAL
 *      labels; §21);
 *
 *   2. EXT-AC-03 (static architecture check): the /extensions module
 *      domain code imports ONLY platform ports (db/clock/ids/errors) +
 *      the three matrix-allowed public contracts (/executions, /policies,
 *      /credentials) + its own module — with a LITERAL ZERO /workflows
 *      import (workflow state is structurally unreachable: the module
 *      exposes no workflow-mutation API, the invocation path cannot
 *      transition workflow state, and the migration creates no workflow
 *      table/column/trigger);
 *
 *   3. the module API is exactly the declared surface — NO workflow
 *      transition/mutation methods, NO evidence creation method, NO
 *      credential creation, NO provenance assertion (EXT-AC-04 static
 *      posture), NO sandbox runtime execution (the /executions authority
 *      owns the runtime) and NO resolveCredentialMaterial (the module
 *      resolves references only);
 *
 *   4. the invocation context type is credential-free (no secret
 *      material, no secret handle, no reusable authorization token) and
 *      short-lived (the TTL bound is DB-fenced in the migration);
 *
 *   5. the API DTO layer wires the authority-field rejection contracts
 *      on every mutation surface (registration/install/configure/status/
 *      invocation — identity, scope, provenance and policy posture are
 *      server-derived) and the invocation input additionally rejects
 *      provenance-fabrication keys; the route set is exactly the thirteen
 *      frozen MKT-022 routes — no update, no delete (registry versions
 *      and invocation history are immutable);
 *
 *   6. the shared registration files wire the module: application.ts
 *      exposes ExtensionsModuleApi, routes.ts registers the routes, and
 *      the composition root constructs the module with EXACTLY the
 *      matrix-allowed dependencies (executions/policies/credentials —
 *      no /workflows, no /evidence, no /clients, no /workspaces).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXTENSION_CAPABILITY_CATEGORIES,
  EXTENSION_DATA_SCOPES,
  EXTENSION_PERMISSION_ACTIONS,
} from '../../src/modules/extensions/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration028 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '028_extensions.sql'),
  'utf8',
);
const extensionsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'extensions', 'public.ts'),
  'utf8',
);
const extensionsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'extensions', 'internal', 'module.ts'),
  'utf8',
);
const extensionsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'extensions', 'internal', 'store.ts'),
  'utf8',
);
const extensionsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'extensions-routes.ts',
  ),
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

test('migration 028 exists and creates exactly the three /extensions tables', () => {
  assert.ok(migration028.includes('CREATE TABLE IF NOT EXISTS extensions ('));
  assert.ok(migration028.includes('CREATE TABLE IF NOT EXISTS extension_installs ('));
  assert.ok(migration028.includes('CREATE TABLE IF NOT EXISTS extension_invocations ('));
});

test('extensions storage: exactly the frozen registry columns — no material- or handle-capable column, no tenant column', () => {
  const columns = columnsOf(createTableBlock(migration028, 'extensions'));
  assert.deepEqual(columns, [
    'extension_id',
    'extension_key',
    'publisher',
    'version',
    'compat_min',
    'compat_max',
    'capabilities',
    'permissions',
    'required_secret_names',
    'data_scopes',
    'network_requirements',
    'runtime_class',
    'input_contract',
    'output_contract',
    'event_subscriptions',
    'ui_surfaces',
    'config_contract',
    'idempotency_key',
    'create_fingerprint',
    'created_by',
    'created_at',
    'updated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token', 'agency_id', 'client_id', 'workspace_id']) {
    assert.ok(!columns.includes(forbidden), `extensions must not carry a '${forbidden}' column (the registry is global catalog state)`);
  }
});

test('extensions storage: the immutable-version fence is a database backstop', () => {
  // (publisher, extension_key, version) UNIQUE — re-registration of the
  // same version is a constraint violation; a new version is a new row.
  assert.ok(migration028.includes('extensions_version_unique'));
  // Published rows reject UPDATE and DELETE outright.
  assert.ok(migration028.includes('extensions_registry_immutable_update_trigger'));
  assert.ok(migration028.includes('extensions_registry_immutable_delete_trigger'));
});

test('extensions storage: the closed vocabulary CHECKs are database backstops (§3 categories, §5 permissions, data scopes, runtime classes)', () => {
  const block = createTableBlock(migration028, 'extensions').replace(/\s+/g, ' ');
  for (const category of EXTENSION_CAPABILITY_CATEGORIES) {
    assert.ok(migration028.includes(`'${category}'`), `the capability category CHECK must include '${category}'`);
  }
  for (const action of EXTENSION_PERMISSION_ACTIONS) {
    assert.ok(migration028.includes(`'${action}'`), `the permission action CHECK must include '${action}'`);
  }
  for (const scope of EXTENSION_DATA_SCOPES) {
    assert.ok(migration028.includes(`'${scope}'`), `the data-scope CHECK must include '${scope}'`);
  }
  for (const runtimeClass of ['pooled-worker', 'ephemeral-sandbox', 'persistent-sandbox', 'dedicated-runtime']) {
    assert.ok(migration028.includes(`'${runtimeClass}'`), `the runtime-class CHECK must include '${runtimeClass}'`);
  }
  // The §5 forbidden powers are structurally absent from the permission
  // vocabulary CHECK.
  assert.ok(!block.includes('workflow'));
  assert.ok(!block.includes('credential'));
  assert.ok(!block.includes('audit'));
});

test('extensions storage: the §21 material-key CHECK guards every jsonb payload column', () => {
  assert.ok(migration028.includes('extensions_payload_has_no_material_keys'));
  const fenced = (migration028.match(/extensions_payload_has_no_material_keys\(/g) ?? []).length;
  // capabilities, permissions, network_requirements, input_contract,
  // output_contract, config_contract (registry) + config (install) +
  // input + granted_capabilities (invocation): all fenced.
  assert.ok(fenced >= 8, 'every jsonb payload column must be fenced by the material-key validator');
});

test('extension_installs storage: exactly the frozen install columns — no material-capable column', () => {
  const columns = columnsOf(createTableBlock(migration028, 'extension_installs'));
  assert.deepEqual(columns, [
    'install_id',
    'extension_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'status',
    'config',
    'secret_bindings',
    'granted_scopes',
    'idempotency_key',
    'version',
    'created_by',
    'uninstalled_at',
    'created_at',
    'updated_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token']) {
    assert.ok(!columns.includes(forbidden), `extension_installs must not carry a '${forbidden}' column`);
  }
});

test('extension_installs storage: the scope-chain, immutability and lifecycle fences are database backstops', () => {
  // Client ∈ agency, workspace ∈ client (the Client boundary cannot be
  // crossed through the install columns, even by direct SQL).
  assert.ok(migration028.includes('extension_installs_scope_legal'));
  // Identity/scope/grant immutability (a wider grant is a new install).
  assert.ok(migration028.includes('extension_installs_immutable'));
  // The frozen lifecycle (born installed; uninstalled terminal) + the
  // one-install-per-(workspace, version) fence.
  assert.ok(migration028.includes('extension_installs_lifecycle_legal'));
  assert.ok(migration028.includes('extension_installs_workspace_extension_unique'));
  const block = createTableBlock(migration028, 'extension_installs').replace(/\s+/g, ' ');
  assert.ok(
    block.includes("status IN ('installed', 'configured', 'authorized', 'disabled', 'uninstalled')"),
    'the install status CHECK must be the frozen five-state set',
  );
});

test('extension_invocations storage: exactly the frozen ledger columns — append-only, consistent and TTL-bounded', () => {
  const columns = columnsOf(createTableBlock(migration028, 'extension_invocations'));
  assert.deepEqual(columns, [
    'invocation_id',
    'extension_id',
    'install_id',
    'execution_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'granted_capabilities',
    'granted_data_scopes',
    'policy_decision_id',
    'policy_outcome',
    'input',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'issued_at',
    'expires_at',
    'recorded_at',
  ]);
  for (const forbidden of ['secret', 'secret_handle', 'material', 'api_key', 'token', 'workflow']) {
    assert.ok(!columns.includes(forbidden), `extension_invocations must not carry a '${forbidden}' column`);
  }
  // APPEND-ONLY (the 015/018/025 pattern): UPDATE and DELETE rejected.
  assert.ok(migration028.includes('extension_invocations_append_only_update_trigger'));
  assert.ok(migration028.includes('extension_invocations_append_only_delete_trigger'));
  // The invocation is bound to its execution's canonical scope and the
  // same-workspace install (crossed rows are impossible even by SQL).
  assert.ok(migration028.includes('extension_invocations_consistent'));
  // The short-lived TTL is DB-fenced.
  const block = migration028.replace(/\s+/g, ' ');
  assert.ok(block.includes("expires_at <= issued_at + interval '1 hour'"), 'the TTL maximum must be DB-fenced');
});

test('EXT-AC-03 storage posture: the migration creates no workflow table, column or trigger (workflow state belongs only to /workflows)', () => {
  // No CREATE TABLE for workflow anything; no mutation of the workflows
  // or workflow_instances tables anywhere in the migration.
  assert.ok(!/CREATE TABLE[^(]*workflow/i.test(migration028));
  assert.ok(!/INSERT INTO\s+(workflow|public\.workflow)/i.test(migration028));
  assert.ok(!/UPDATE\s+(workflow|public\.workflow)/i.test(migration028));
  assert.ok(!/DELETE FROM\s+(workflow|public\.workflow)/i.test(migration028));
});

// ---------------------------------------------------------------------------
// 2. EXT-AC-03 — the module import surface (the frozen matrix posture)
// ---------------------------------------------------------------------------

test('EXT-AC-03: the /extensions module imports ONLY platform ports + /executions + /policies + /credentials public entries + its own module', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'extensions');
  const files = collectTsFiles(moduleDir);
  assert.ok(files.length >= 3, 'the extensions module must exist with public + internal files');
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
      const fromInternal = file.includes(join('extensions', 'internal'));
      const toSelf =
        specifier.startsWith('./') ||
        (fromInternal && specifier.endsWith('../public.ts'));
      if (toSelf) continue;
      // The three matrix-allowed public contracts, from either depth
      // (public.ts imports ../x/public.ts; internal/ imports ../../x/public.ts).
      const allowed =
        /^(\.\.\/)+((executions|policies|credentials)\/public\.ts)$/.test(specifier);
      assert.ok(
        allowed,
        `${file}: cross-module import '${specifier}' is not allowed (matrix: /extensions ──→ /executions, /policies, /credentials only)`,
      );
    }
  }
});

test('EXT-AC-03: ZERO /workflows imports anywhere in the /extensions module — workflow state is structurally unreachable', () => {
  const moduleDir = join(repoRoot, 'src', 'modules', 'extensions');
  for (const file of collectTsFiles(moduleDir)) {
    const source = readFileSync(file, 'utf8');
    assert.ok(
      !source.includes('../workflows/public.ts') && !source.includes("from '../workflows"),
      `${file}: the extensions module must NOT import /workflows (EXT-AC-03 — workflow mutation outside /workflows is forbidden)`,
    );
    assert.ok(!source.includes('workflow-instances-store'), `${file}: no workflow instance internals`);
  }
  // The composition root hands the module no /workflows instance either.
  const wiring = /createExtensionsModule\(\{[^}]+\}\)/.exec(compositionRoot);
  assert.ok(wiring !== null, 'the composition root must construct the extensions module');
  assert.ok(!wiring[0]!.includes('workflows'), 'no /workflows dependency is wired into /extensions');
});

test('the /extensions module domain code has no provider SDK, pg, secrets resolution or sandbox runtime coupling', () => {
  const sources = [extensionsPublic, extensionsModule, extensionsStore].join('\n');
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
  ]) {
    assert.ok(!sources.includes(forbidden), `the extension module must not touch '${forbidden}'`);
  }
});

// ---------------------------------------------------------------------------
// 3. The module API surface
// ---------------------------------------------------------------------------

test('the module API is exactly the declared extension registry surface — no workflow mutation, no evidence creation, no credential creation, no provenance assertion', () => {
  const apiMembers = [
    'registerExtensionVersion',
    'getExtensionVersion',
    'listExtensionVersions',
    'installExtension',
    'getExtensionInstall',
    'listExtensionInstalls',
    'configureExtension',
    'setExtensionInstallStatus',
    'beginExtensionInvocation',
    'getExtensionInvocation',
    'listExtensionInvocations',
  ];
  for (const member of apiMembers) {
    assert.ok(extensionsPublic.includes(`  ${member}(`), `the API must declare ${member}`);
  }
  // The forbidden surfaces: workflow mutation (EXT-AC-03), evidence
  // creation/provenance (EXT-AC-04), credential creation and dispatch
  // into the sandbox runtime (the /executions authority owns it).
  for (const forbidden of [
    'transitionWorkflow',
    'mutateWorkflow',
    'setWorkflowStatus',
    'createEvidence',
    'appendEvidence',
    'createCredential',
    'dispatchExtension',
    'runExtension',
    'executeExtension',
  ]) {
    assert.ok(!extensionsPublic.includes(forbidden), `the module API must not expose '${forbidden}'`);
  }
});

test('CRED-001: the /credentials dependency resolves REFERENCES only — never material, and the extensions module never creates credentials', () => {
  assert.ok(extensionsModule.includes('credentials.getCredentialReference'));
  assert.ok(!extensionsModule.includes('resolveCredentialMaterial'));
  assert.ok(!extensionsModule.includes('createCredentialReference'));
  // The composition root wires the concrete /credentials instance.
  assert.ok(compositionRoot.includes('createExtensionsModule({ db, clock, ids, executions, policies, credentials })'));
});

// ---------------------------------------------------------------------------
// 4. The invocation context type is credential-free + short-lived
// ---------------------------------------------------------------------------

test('the invocation context is NEVER a credential: no material, handle or token field; short-lived by contract', () => {
  const contextShape = /export interface ExtensionInvocationContext \{[\s\S]*?\n\}/.exec(
    extensionsPublic,
  );
  assert.ok(contextShape !== null, 'the invocation context type must exist');
  const body = contextShape[0]!;
  for (const field of [
    'invocationId',
    'extensionId',
    'extensionKey',
    'version',
    'installId',
    'executionId',
    'scope',
    'grantedCapabilities',
    'grantedDataScopes',
    'policyDecisionId',
    'runtimeClass',
    'input',
    'provenance',
    'issuedAt',
    'expiresAt',
  ]) {
    assert.ok(body.includes(`readonly ${field}`), `the context must carry '${field}'`);
  }
  for (const forbidden of ['secretHandle', 'secretMaterial', 'material', 'token', 'credential', 'apiKey']) {
    assert.ok(
      !body.includes(`readonly ${forbidden}`),
      `the invocation context must never carry a '${forbidden}' field`,
    );
  }
  // Short-lived: the TTL constants exist and are bounded.
  assert.ok(extensionsPublic.includes('MAX_INVOCATION_TTL_MS'));
  assert.ok(extensionsPublic.includes('DEFAULT_INVOCATION_TTL_MS'));
  assert.ok(extensionsPublic.includes('isInvocationContextExpired'));
});

// ---------------------------------------------------------------------------
// 5. The route set + DTO authority-field contracts
// ---------------------------------------------------------------------------

test('the route set is exactly the thirteen frozen MKT-022 routes — no update, no delete', () => {
  const routePattern = /router\.add\(\s*'([A-Z]+)',\s*\n?\s*'([^']+)'/g;
  const routes: string[] = [];
  for (const match of extensionsRoutes.matchAll(routePattern)) {
    routes.push(`${match[1]} ${match[2]}`);
  }
  assert.deepEqual(routes, [
    'POST /api/extensions',
    'GET /api/extensions',
    'GET /api/extensions/:extensionId',
    'POST /api/workspaces/:workspaceId/extension-installs',
    'GET /api/workspaces/:workspaceId/extension-installs',
    'GET /api/workspaces/:workspaceId/extension-installs/:installId',
    'POST /api/workspaces/:workspaceId/extension-installs/:installId/configure',
    'POST /api/workspaces/:workspaceId/extension-installs/:installId/authorize',
    'POST /api/workspaces/:workspaceId/extension-installs/:installId/disable',
    'POST /api/workspaces/:workspaceId/extension-installs/:installId/uninstall',
    'POST /api/executions/:executionId/extension-invocations',
    'GET /api/workspaces/:workspaceId/extension-invocations',
    'GET /api/extension-invocations/:invocationId',
  ]);
  assert.ok(
    !routes.some((route) => route.startsWith('PUT ') || route.startsWith('PATCH ') || route.startsWith('DELETE ')),
    'no update/delete routes: registry versions and invocation history are immutable',
  );
});

test('registration DTOs reject identity/provenance authority fields and material-shaped keys', () => {
  for (const forbidden of [
    'extensionId',
    'createFingerprint',
    'createdBy',
    'provenance',
    'correlationId',
    'secret',
    'secretMaterial',
    'material',
    'password',
    'apiKey',
    'secretHandle',
  ]) {
    assert.ok(
      extensionsRoutes.includes(`'${forbidden}',`),
      `the registration authority-field contract must reject '${forbidden}'`,
    );
  }
});

test('invocation DTOs reject every decision/scope/provenance authority field — the context is fully server-derived', () => {
  for (const forbidden of [
    'invocationId',
    'scope',
    'agencyId',
    'clientId',
    'workspaceId',
    'grantedCapabilities',
    'grantedDataScopes',
    'policyDecisionId',
    'policyOutcome',
    'runtimeClass',
    'provenance',
    'actor',
    'correlationId',
    'issuedAt',
    'expiresAt',
  ]) {
    assert.ok(
      extensionsRoutes.includes(`'${forbidden}',`),
      `the invocation authority-field contract must reject '${forbidden}'`,
    );
  }
});

test('EXT-AC-04 DTO posture: the invocation INPUT rejects provenance-fabrication and authority keys', () => {
  // The module guard exports the rejection set; the route DTO applies it
  // to the input payload.
  assert.ok(extensionsStore.includes('INVOCATION_INPUT_AUTHORITY_KEYS'));
  for (const forbidden of [
    'provenance',
    'actor',
    'recordedVia',
    'correlationId',
    'evidenceId',
    'evidenceRef',
    'collectedBy',
    'secret',
    'material',
    'apiKey',
    'secretHandle',
  ]) {
    assert.ok(
      extensionsStore.includes(`'${forbidden}',`) || extensionsRoutes.includes(`'${forbidden}',`),
      `the invocation input must reject the provenance-shaped key '${forbidden}'`,
    );
  }
  // The route wires the module guard's rejection list into the input DTO.
  assert.ok(extensionsRoutes.includes('INVOCATION_INPUT_FORBIDDEN_KEYS'));
});

test('EXT-AC-03 route posture: the extensions routes never call workflow mutation APIs', () => {
  for (const forbidden of [
    'modules.workflows.transition',
    'modules.workflows.set',
    'modules.workflows.update',
    'modules.workflows.create',
    'modules.workflows.mutate',
  ]) {
    assert.ok(!extensionsRoutes.includes(forbidden), `the extensions routes must not call '${forbidden}'`);
  }
  assert.ok(!extensionsRoutes.includes("from '../modules/workflows"), 'the routes file imports no /workflows contract');
});

test('the install route derives the scope from the canonical workspace owner (never the request body)', () => {
  // The scope arrives from ctx.owner (pipeline-resolved BEFORE authorize).
  assert.ok(extensionsRoutes.includes('resolveWorkspaceOwnership'));
  assert.ok(extensionsRoutes.includes('const owner = ctx.owner;'));
  assert.ok(extensionsRoutes.includes('installExtension('));
});

// ---------------------------------------------------------------------------
// 6. Shared registration files
// ---------------------------------------------------------------------------

test('application.ts exposes the ExtensionsModuleApi on ApplicationModules', () => {
  assert.ok(applicationTs.includes("import type { ExtensionsModuleApi } from '../modules/extensions/public.ts'"));
  assert.ok(applicationTs.includes('readonly extensions: ExtensionsModuleApi;'));
});

test('routes.ts registers the extensions routes', () => {
  assert.ok(routesTs.includes("import { registerExtensionsRoutes } from './extensions-routes.ts'"));
  assert.ok(routesTs.includes('registerExtensionsRoutes(router, services, modules)'));
});

test('the composition root constructs the extensions module with the matrix-allowed dependencies only', () => {
  assert.ok(compositionRoot.includes("import { createExtensionsModule } from './modules/extensions/public.ts'"));
  assert.ok(compositionRoot.includes('createExtensionsModule({ db, clock, ids, executions, policies, credentials })'));
  const wiring = /createExtensionsModule\(\{[^}]+\}\)/.exec(compositionRoot);
  assert.ok(wiring !== null);
  for (const forbidden of ['workflows', 'evidence', 'goals', 'playbooks', 'jobs', 'agents', 'aiRuntime', 'clients', 'workspaces', 'agencies']) {
    assert.ok(!wiring[0]!.includes(forbidden), `no '${forbidden}' dependency is wired into /extensions`);
  }
});

// ---------------------------------------------------------------------------
// 7. The vocabulary is shared by the module + routes + migration
// ---------------------------------------------------------------------------

test('the frozen vocabularies appear identically in the module contract and the migration', () => {
  for (const category of EXTENSION_CAPABILITY_CATEGORIES) {
    assert.ok(
      extensionsRoutes.includes(category) || extensionsPublic.includes(category),
      `routes/module must know the capability category '${category}'`,
    );
  }
  for (const action of EXTENSION_PERMISSION_ACTIONS) {
    assert.ok(extensionsRoutes.includes(action), `routes must validate the permission action '${action}' (the closed DTO pattern)`);
  }
  for (const scope of EXTENSION_DATA_SCOPES) {
    assert.ok(extensionsRoutes.includes(scope), `routes must validate the data scope '${scope}'`);
  }
});

test('the module public entry exists with the store re-exports (guard semantics are part of the contract)', () => {
  assert.ok(existsSync(join(repoRoot, 'src', 'modules', 'extensions', 'public.ts')));
  for (const exported of [
    'assertValidExtensionManifest',
    'assertValidExtensionInstallInput',
    'assertValidExtensionConfigureInput',
    'assertValidExtensionInvocationInput',
    'assertValidInvocationProvenance',
    'validateConfigAgainstContract',
    'composeInvocationContext',
  ]) {
    assert.ok(extensionsPublic.includes(exported), `the public entry must export '${exported}'`);
  }
});
