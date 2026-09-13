/**
 * MKT-048 static tests — the App Installation domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB).
 *
 * Proofs (spec/mos-app-ecosystem-v1.5.md "Install and invoke", "Bounded
 * app state", "Upgrade and rollback" — the primary contract; frozen by
 * spec/architecture-lock-v1.5.md rules #10/#11; frozen matrix registration
 * /app-installs ──→ /apps, /policies, /workspaces, /extensions):
 *   1. migration 038 (the PRE-ASSIGNED number) creates exactly
 *      `app_installs` + `app_install_events` with the full frozen record
 *      vocabulary: immutable opaque id, the SERVER-DERIVED scope chain
 *      (agency/client/workspace FKs, workspace-within-client trigger),
 *      the EXACT (app key, app_version_id, version) identity with the
 *      registry-match trigger, the operation enum, the SERVER-DERIVED
 *      granted-scope columns with the closed frozen vocabularies and the
 *      least-privilege subset trigger, the policy decision reference, the
 *      selection-sequence + lifecycle CHECKs, install provenance, and the
 *      §8 (workspace_id, idempotency_key) create fence; the current-
 *      selection partial unique fence; the event tail carries the
 *      installed/upgraded/rolled_back payloads with the payload-shape
 *      CHECK and the (workspace_id, idempotency_key) fence;
 *   2. install ownership is EXACTLY the scope chain — no owner/role/user
 *      columns beyond provenance, no provider state, no registry
 *      machinery (the module composes the /apps registry READ-ONLY);
 *   3. the ledger is APPEND-ORIENTED (the heart of AC-4): DELETE is
 *      rejected outright; an UPDATE may ONLY perform the single
 *      sanctioned supersession transition (ACTIVE → SUPERSEDED with
 *      superseded_at set); every recorded column is immutable; the event
 *      tail rejects UPDATE and DELETE outright;
 *   4. the /app-installs public contract imports ONLY the /apps and
 *      /policies publics (the matrix-listed directions consumed DIRECTLY)
 *      and declares the /workspaces + /extensions structural ports — NO
 *      other module imports, NO provider SDKs;
 *   5. the store's ONLY mutation surface is the single transactional
 *      selection append: INSERT on the two own tables + exactly ONE
 *      UPDATE statement (the guarded supersession) touching ONLY the
 *      status/superseded_at columns — NO DELETE anywhere;
 *   6. the route surface is POST/GET only and exactly the six frozen
 *      surfaces (install/list/read/upgrade/rollback/agency rollup);
 *   7. the DTO discipline is structural: the forbidden authority-field
 *      list includes every granted-scope-shaped, identity-shaped,
 *      lifecycle-shaped, provenance-shaped and material key — granted
 *      scopes are NEVER caller-suppliable;
 *   8. the disclosed spec registration exists: /app-installs in
 *      spec/architecture.md §6 + the matrix row in
 *      spec/module-dependency-matrix.md.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_INSTALL_OPERATIONS,
  APP_INSTALL_STATUSES,
  APP_INSTALL_TRANSITIONS,
  APP_DATA_SCOPES,
  APP_MUTATION_SCOPES,
} from '../../src/modules/app-installs/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration038 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '038_app_installs.sql'),
  'utf8',
);
const migration002 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '002_identity_agencies.sql'),
  'utf8',
);
const migration003 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '003_clients.sql'),
  'utf8',
);
const migration004 = readFileSync(
  join(repoRoot, 'src', 'platform', 'db', 'migrations', '004_workspaces.sql'),
  'utf8',
);
const appInstallsPublic = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'public.ts'),
  'utf8',
);
const appInstallsModule = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'internal', 'module.ts'),
  'utf8',
);
const appInstallsStore = readFileSync(
  join(repoRoot, 'src', 'modules', 'app-installs', 'internal', 'store.ts'),
  'utf8',
);
const appInstallsRoutes = readFileSync(
  join(repoRoot, 'src', 'api', 'app-installs-routes.ts'),
  'utf8',
);
const architectureSpec = readFileSync(
  join(repoRoot, 'spec', 'architecture.md'),
  'utf8',
);
const matrixSpec = readFileSync(
  join(repoRoot, 'spec', 'module-dependency-matrix.md'),
  'utf8',
);

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf('\n);', start);
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

test('migration 038 creates exactly the two app-installs tables with the frozen record vocabulary', () => {
  // Exactly the OWN tables (the install ledger + the event tail).
  const created = [...migration038.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created, ['app_installs', 'app_install_events'], 'own tables ONLY');

  const block = createTableBlock(migration038, 'app_installs');
  const columns = columnsOf(block);
  for (const required of [
    'install_id', // immutable opaque identifier (server-generated)
    'agency_id', // the canonical scope chain (server-derived, immutable)
    'client_id',
    'workspace_id',
    'app_key', // the EXACT App Version identity (registry-pinned)
    'app_version_id',
    'version',
    'operation', // install | upgrade | rollback (closed enum)
    'granted_data_scopes', // SERVER-DERIVED (closed frozen vocabulary)
    'granted_mutation_scopes', // SERVER-DERIVED (closed frozen vocabulary)
    'policy_decision_id', // the recorded allow decision reference
    'selection_seq', // the monotonic lineage sequence
    'status', // ACTIVE | SUPERSEDED (born ACTIVE)
    'superseded_at', // the single sanctioned transition stamp
    'installed_by', // install provenance (server-derived who)
    'installed_at', // install provenance (server-derived when)
    'idempotency_key', // the §8 logical command key
    'create_fingerprint', // the §8 convergence proof
  ]) {
    assert.ok(columns.includes(required), `app_installs.${required} required`);
  }
  // The scope chain is FK-fenced (workspace within client within agency —
  // the trigger re-fences it at every write).
  assert.ok(
    /workspace_id\s+uuid\s+NOT NULL REFERENCES workspaces\(workspace_id\)/.test(block),
    'workspace scope must be a NOT NULL FK to workspaces',
  );
  assert.ok(
    /client_id\s+uuid\s+NOT NULL REFERENCES clients\(client_id\)/.test(block),
    'client scope must be a NOT NULL FK to clients',
  );
  // The closed enums are DB CHECKs (never caller freedoms).
  for (const operation of APP_INSTALL_OPERATIONS) {
    assert.ok(block.includes(`'${operation}'`), `the operation CHECK must enumerate '${operation}'`);
  }
  for (const status of APP_INSTALL_STATUSES) {
    assert.ok(block.includes(`'${status}'`), `the status CHECK must enumerate '${status}'`);
  }
  assert.ok(!block.includes("'DISABLED'"), 'no free-string lifecycle states');
  // The lifecycle shape CHECKs (multiline constraint declarations).
  assert.ok(/CONSTRAINT app_installs_operation_seq_shape\s+CHECK/.test(block));
  assert.ok(/CONSTRAINT app_installs_status_shape\s+CHECK/.test(block));
  assert.ok(/CONSTRAINT app_installs_seq_unique/.test(block), 'per-lineage sequence uniqueness');
  // THE CURRENT-SELECTION FENCE: at most one ACTIVE row per lineage.
  assert.ok(
    /app_installs_current_fence\s*\n?\s*ON app_installs \(workspace_id, app_key\) WHERE status = 'ACTIVE'/.test(
      migration038.replace(/\r/g, ''),
    ),
    'the current-selection partial unique fence exists',
  );
  // The §8 command fence.
  assert.ok(
    /app_installs_idempotency_key_unique\s*\n?\s*ON app_installs \(workspace_id, idempotency_key\)/.test(
      migration038.replace(/\r/g, ''),
    ),
    'the §8 (workspace_id, idempotency_key) fence exists',
  );
});

test('the event tail carries the frozen transition vocabulary with the payload-shape and command fences', () => {
  const block = createTableBlock(migration038, 'app_install_events');
  const columns = columnsOf(block);
  for (const required of [
    'event_id',
    'install_id',
    'agency_id',
    'client_id',
    'workspace_id',
    'app_key',
    'event_type', // installed | upgraded | rolled_back (closed enum)
    'prior_install_id', // the superseded selection (null only on install)
    'from_version',
    'to_version',
    'policy_decision_id',
    'idempotency_key',
    'recorded_actor', // SERVER-DERIVED provenance (never a request field)
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ]) {
    assert.ok(columns.includes(required), `app_install_events.${required} required`);
  }
  for (const eventType of ['installed', 'upgraded', 'rolled_back']) {
    assert.ok(block.includes(`'${eventType}'`), `the event_type CHECK must enumerate '${eventType}'`);
  }
  // An install carries no predecessor; an upgrade/rollback carries BOTH.
  assert.ok(/CONSTRAINT app_install_event_payload CHECK/.test(block));
  // The §8 event fence converges with the ledger row fence.
  assert.ok(
    /app_install_events_idempotency_key_unique\s*\n?\s*ON app_install_events \(workspace_id, idempotency_key\)/.test(
      migration038.replace(/\r/g, ''),
    ),
    'the event (workspace_id, idempotency_key) fence exists',
  );
});

test('install ownership is exactly the scope chain — no owner/role/user columns beyond provenance, no registry machinery', () => {
  const installColumns = columnsOf(createTableBlock(migration038, 'app_installs'));
  for (const column of installColumns) {
    if (column === 'installed_by') continue; // provenance (server-derived)
    assert.ok(
      !/owner|role|permission|grantee/.test(column),
      `app_installs must not carry ownership/role columns (found '${column}')`,
    );
  }
  for (const column of installColumns) {
    assert.ok(
      !/provider|sdk|retry|credential|secret|token|certification/.test(column),
      `app_installs must not carry machinery/material columns (found '${column}')`,
    );
  }
  // NO redefinition of any frozen table (own tables ONLY).
  for (const [migration, table] of [
    [migration002, 'agencies'],
    [migration002, 'users'],
    [migration003, 'clients'],
    [migration004, 'workspaces'],
  ] as const) {
    assert.ok(
      !migration038.includes(`CREATE TABLE IF NOT EXISTS ${table} (`),
      `038 must not redefine the frozen ${table} table`,
    );
  }
  // The frozen scope vocabularies are CHECK-fenced with the identical sets.
  for (const scope of APP_DATA_SCOPES) {
    assert.ok(migration038.includes(`'${scope}'`), `the data-scope CHECK must enumerate '${scope}'`);
  }
  for (const scope of APP_MUTATION_SCOPES) {
    assert.ok(migration038.includes(`'${scope}'`), `the mutation-scope CHECK must enumerate '${scope}'`);
  }
  assert.ok(migration038.includes('app_installs_data_scopes_valid'));
  assert.ok(migration038.includes('app_installs_mutation_scopes_valid'));
});

test('the ledger is APPEND-ORIENTED: DELETE rejected, the single sanctioned supersession UPDATE only, events immutable', () => {
  // The history-preserving trigger: DELETE rejected outright; an UPDATE
  // may ONLY perform the ACTIVE → SUPERSEDED supersession transition.
  assert.ok(/CREATE OR REPLACE FUNCTION app_installs_history_preserved\(\)/.test(migration038));
  assert.ok(/app_installs_history_trigger\s*\n?\s*BEFORE UPDATE OR DELETE ON app_installs/.test(migration038.replace(/\r/g, '')));
  assert.ok(migration038.includes('app install ledger rows are append-only: DELETE is rejected'));
  assert.ok(
    migration038.includes('permits only the supersession transition (ACTIVE → SUPERSEDED with superseded_at set)'),
  );
  // Every recorded column is fenced immutable by the same trigger.
  for (const column of ['app_key', 'app_version_id', 'version', 'operation', 'granted_data_scopes']) {
    assert.ok(
      new RegExp(`NEW\\.${column} (IS DISTINCT FROM|<>) OLD\\.${column}`).test(migration038),
      `the ${column} immutability fence exists`,
    );
  }
  // The event tail rejects UPDATE and DELETE outright.
  assert.ok(/CREATE OR REPLACE FUNCTION app_install_events_append_only\(\)/.test(migration038));
  assert.ok(/app_install_events_append_only_update_trigger\s*\n?\s*BEFORE UPDATE ON app_install_events/.test(migration038.replace(/\r/g, '')));
  assert.ok(/app_install_events_append_only_delete_trigger\s*\n?\s*BEFORE DELETE ON app_install_events/.test(migration038.replace(/\r/g, '')));
  // The scope-chain + exact-version identity/grants triggers exist.
  assert.ok(/app_installs_scope_chain_trigger/.test(migration038));
  assert.ok(/app_installs_identity_grants_trigger/.test(migration038));
  assert.ok(migration038.includes('the tenant scope chain cannot be crossed'));
  assert.ok(migration038.includes('grants data scopes beyond the manifest request'));
  assert.ok(migration038.includes('grants mutation scopes beyond the manifest request'));
  // The frozen lifecycle machine: born ACTIVE; the ONLY transition is the
  // supersession (the operating-graph posture).
  assert.deepEqual(APP_INSTALL_TRANSITIONS['ACTIVE'], ['SUPERSEDED']);
  assert.deepEqual(APP_INSTALL_TRANSITIONS['SUPERSEDED'], []);
});

test('the public contract imports ONLY the /apps and /policies publics; /workspaces and /extensions arrive as structural ports', () => {
  const imports = [...appInstallsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    [...new Set(imports)].sort(),
    ['apps', 'policies'],
    'public.ts imports exactly the two matrix-listed direct directions',
  );
  for (const source of [appInstallsPublic, appInstallsModule, appInstallsStore]) {
    assert.ok(!/from '\.\.\/(\w|-)+(\/internal)?\/internal\//.test(source), 'no module-internal cross imports');
    for (const forbidden of [
      'workspaces', 'clients', 'agencies', 'auth', 'users', 'workflows',
      'executions', 'evidence', 'metrics', 'integrations', 'domain-packs',
      'ai-runtime', 'jobs', 'agents', 'audit', 'decisions', 'operating-graph',
      'deployments', 'goals', 'playbooks', 'notifications', 'reporting',
    ]) {
      assert.ok(
        !source.includes(`from '../../${forbidden}/`) && !source.includes(`from '../${forbidden}/`),
        `the module must not import the /${forbidden} module (structural ports only)`,
      );
    }
    assert.ok(!/from 'openai|anthropic|google|@ai-sdk|LangChain/i.test(source), 'no provider SDK imports');
  }
  // The declared structural ports exist by name.
  assert.ok(appInstallsPublic.includes('AppInstallsWorkspaceOwnershipPort'));
  assert.ok(appInstallsPublic.includes('AppInstallsExtensionsPort'));
});

test('the store’s only mutation surface is the single transactional selection append (no DELETE, one guarded UPDATE)', () => {
  // NO DELETE anywhere — history is never erased through the store.
  assert.equal([...appInstallsStore.matchAll(/DELETE FROM app_install?s?\b/g)].length, 0, 'no DELETE statements');
  // The single sanctioned UPDATE: the guarded supersession touching ONLY
  // the status + superseded_at columns.
  const updates = [...appInstallsStore.matchAll(/UPDATE app_installs\s+SET ([^W]*)/g)].map(
    (match) => match[1]!.replace(/\s+/g, ' ').trim(),
  );
  assert.equal(updates.length, 1, `exactly one UPDATE statement (found ${updates.length})`);
  assert.equal(
    updates[0]!.replace(/\s+/g, ''),
    "status='SUPERSEDED',superseded_at=$2",
    'the ONLY UPDATE is the single sanctioned supersession transition',
  );
  // DML targets ONLY the own tables (scanned on the comment-stripped
  // source — prose mentioning UPDATE/DELETE must not confuse the scan).
  const storeCode = appInstallsStore
    .split('\n')
    .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
    .join('\n');
  for (const statement of [...storeCode.matchAll(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)]) {
    assert.ok(
      ['app_installs', 'app_install_events'].includes(statement[2]!),
      `DML must target the own tables only (found '${statement[1]} ${statement[2]}')`,
    );
  }
  // The registry/policy/workspaces/extensions tables are never written.
  for (const foreign of ['app_versions', 'apps', 'policy_decisions', 'policy_versions', 'workspaces', 'clients', 'agencies', 'extension']) {
    assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${foreign}\\b`).test(appInstallsStore), `never writes ${foreign}`);
    assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${foreign}\\b`).test(appInstallsModule), `module never writes ${foreign}`);
  }
});

test('the route surface is POST/GET registrations only, and exactly the six frozen surfaces', () => {
  const registrations = [
    ...appInstallsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g),
  ].map((match) => [match[1]!, match[2]!] as const);
  assert.deepEqual(
    registrations,
    [
      ['POST', '/api/workspaces/:workspaceId/app-installs'],
      ['GET', '/api/workspaces/:workspaceId/app-installs'],
      ['GET', '/api/workspaces/:workspaceId/app-installs/:installId'],
      ['POST', '/api/workspaces/:workspaceId/app-installs/:installId/upgrade'],
      ['POST', '/api/workspaces/:workspaceId/app-installs/:installId/rollback'],
      ['GET', '/api/agencies/:agencyId/app-installs'],
    ],
    'the app-installs surface is exactly install/list/read/upgrade/rollback/agency-rollup',
  );
  for (const [method] of registrations) {
    assert.ok(
      method === 'POST' || method === 'GET',
      `no mutation verb other than the selection commands (found ${method})`,
    );
  }
  // NO PATCH/PUT/DELETE anywhere: there is no rewrite and no erase path —
  // upgrade/rollback append NEW rows; the single sanctioned supersession
  // happens inside the module's transaction.
  assert.ok(!/'(PATCH|PUT|DELETE)'/.test(appInstallsRoutes), 'no PATCH/PUT/DELETE routes');
  // No second permission/role engine in the routes (authorization composes
  // the /agencies membership + platform role authorities).
  assert.ok(
    !/role.*engine|permissionTable|canAccess|hasPermission/.test(appInstallsRoutes),
    'no alternate permission authority in the routes',
  );
});

test('the DTO guard rejects every authority-shaped and material-shaped key (granted scopes are NEVER caller-suppliable)', () => {
  // The route-level forbidden list covers every granted-scope-shaped,
  // identity-shaped, lifecycle-shaped, provenance-shaped and material key.
  const forbiddenListMatch = appInstallsRoutes.match(/const SELECTION_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/);
  assert.ok(forbiddenListMatch !== null, 'the forbidden authority-field list exists');
  const forbiddenFields = forbiddenListMatch![1]!;
  for (const required of [
    'grantedScopes', 'grantedDataScopes', 'grantedMutationScopes',
    'appVersionId', 'policyDecisionId', 'status', 'selectionSeq',
    'supersededAt', 'installedBy', 'installedAt', 'createFingerprint',
    'provenance', 'actor', 'correlationId', 'causationId', 'certificationState',
  ]) {
    assert.ok(
      forbiddenFields.includes(`'${required}'`),
      `the DTO guard must reject the authority-shaped key '${required}'`,
    );
  }
  // The material-shaped keys arrive through the shared spread.
  assert.ok(
    forbiddenFields.includes('...MATERIAL_KEYS'),
    'the DTO guard spreads the material-shaped key list',
  );
  const materialListMatch = appInstallsRoutes.match(/const MATERIAL_KEYS = \[([\s\S]*?)\] as const;/);
  assert.ok(materialListMatch !== null, 'the material-shaped key list exists');
  for (const required of ['secret', 'password', 'token', 'apiKey', 'credentialValue']) {
    assert.ok(
      materialListMatch![1]!.includes(`'${required}'`),
      `the DTO guard must reject the material-shaped key '${required}'`,
    );
  }
  // The route DTO has NO scopes field at all — granted scopes arrive ONLY
  // from the module's server-side derivation.
  const installBodyMatch = appInstallsRoutes.match(/validateObject<ValidatedInstall>\([\s\S]*?fields: \{([\s\S]*?)\},/);
  assert.ok(installBodyMatch !== null);
  assert.ok(!/scope/i.test(installBodyMatch![1]!), 'the install DTO carries no scope field');
  // The module-level guard holds the identical contract behind the DTO.
  assert.ok(appInstallsStore.includes('SELECTION_AUTHORITY_SHAPED_KEYS'));
  assert.ok(appInstallsStore.includes('APP_INSTALLS_MATERIAL_SHAPED_KEYS'));
  assert.ok(
    appInstallsStore.includes('never caller-suppliable'),
    'the module guard documents the server-derived contract',
  );
});

test('the disclosed spec registration exists (architecture.md §6 + the dependency-matrix row)', () => {
  assert.ok(
    /^\/app-installs$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /app-installs',
  );
  assert.ok(
    architectureSpec.includes('`/app-installs` is the v1.5 App installation authority'),
    'the §6 paragraph names the registration',
  );
  assert.ok(
    /^\/app-installs ──→ \/apps, \/policies, \/workspaces, \/extensions$/m.test(matrixSpec),
    'the dependency-matrix row names the sanctioned composition directions',
  );
  assert.ok(
    matrixSpec.includes('`/app-installs` is the v1.5 App installation authority'),
    'the matrix bullet documents the composition posture',
  );
});
