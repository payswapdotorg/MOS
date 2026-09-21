/**
 * MKT-055 static tests — the Social Account and OAuth Connection Model is
 * structurally correct in the ACTUAL migration, module contract and
 * route surface (pure static analysis, no DB; the app-metering-boundary
 * precedent).
 *
 * Proofs (spec/architecture-v1.6.md §4; spec/architecture-lock-v1.6.md
 * rules #18 (each platform behind the provider-neutral Integration
 * contract), #19 (capability parity never assumed) and #28 (separate
 * least-privilege grants); spec/effective-backlog-v1.6.md MKT-055):
 *   1. migration 046 (the PRE-ASSIGNED number) creates exactly the four
 *      own tables — social_accounts, social_account_grants,
 *      social_account_events, social_account_grant_scopes — OWN tables
 *      ONLY: NO integration, credential, tenant, workflow, execution,
 *      evidence, policy, product or store table (the authorities stay
 *      sole, consumed READ-ONLY through the public contracts);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the account lifecycle
 *      (connected → disconnected | revoked, both terminal), the grant
 *      lifecycle (pending → authorized → expired/revoked/refreshed/
 *      superseded with the frozen transition-table trigger), the scope
 *      kinds (granted-scope | capability-tag), the event vocabulary with
 *      the operator | external-signal initiation source, the partial
 *      one-connected-binding-per-connection + one-per-client-identity
 *      fences, the single-authorized-grant fence, the unique state
 *      token, the pending-shape payload fence, the append-only
 *      UPDATE/DELETE rejection triggers on the history tail + scope
 *      records, the no-DELETE trigger on grants;
 *   3. THE SECRET SEPARATION BATTERY (AC-3 — the heart): NO token, code,
 *      secret, material or handle column ANYWHERE in migration 046 (the
 *      grants carry credential_reference_id ONLY — the /credentials
 *      vault reference); NO token/material value ever enters the module
 *      code (only the OPAQUE handle passes through to the vault), the
 *      module creates references of its OWN kind
 *      'social_account_oauth' (lock rule 28: its own least-privilege
 *      grant — never shared with product/source/store credentials), and
 *      DML targets ONLY the module's own four tables;
 *   4. THE PROVIDER-NEUTRAL BOUNDARY (AC-7 + lock rule 18): NO
 *      platform-specific strings/logic in the module code — no social
 *      platform name, no platform OAuth endpoint, no platform-specific
 *      branch (the platform identity is the integration connection's
 *      adapter key carried AS DATA; the flow implementations arrive as
 *      DATA and the production registry is EMPTY until MKT-056+);
 *   5. the route surface is EXACTLY the frozen twelve (six flow POSTs +
 *      six reads; the fail-closed getUsableAuthorization is
 *      module-level ONLY — never an HTTP authorization oracle); NO
 *      update or delete routes (recorded authorization facts are
 *      immutable; the history is append-only);
 *   6. the /social-accounts public contract imports ONLY the
 *      matrix-listed module publics (/integrations, /credentials,
 *      /policies) — the /workspaces consumption rides the declared
 *      STRUCTURAL PORT (the real-codebase arch-check run with zero
 *      violations);
 *   7. the DISCLOSED spec registration exists: the §6 line + the §6
 *      registration sentence + the matrix row + the
 *      forbidden-directions bullet; 046_social_accounts.sql holds its
 *      numeric position in the expected-migration list;
 *   8. the FAIL-CLOSED read discipline is encoded: the grant reads
 *      refuse on disconnected/revoked connections (ConflictError), and
 *      getUsableAuthorization is the null-refusal consumer surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  SOCIAL_ACCOUNT_EVENT_TYPES,
  SOCIAL_ACCOUNT_STATUSES,
  SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND,
  SOCIAL_GRANT_SCOPE_KINDS,
  SOCIAL_GRANT_STATES,
} from '../../src/modules/social-accounts/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration046 = read(src('platform', 'db', 'migrations', '046_social_accounts.sql'));
const socialPublic = read(src('modules', 'social-accounts', 'public.ts'));
const socialModule = read(src('modules', 'social-accounts', 'internal', 'module.ts'));
const socialStore = read(src('modules', 'social-accounts', 'internal', 'store.ts'));
const socialValidation = read(src('modules', 'social-accounts', 'internal', 'grant-validation.ts'));
const socialRoutes = read(src('api', 'social-accounts-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

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

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1. Migration 046: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-055: migration 046 creates exactly the four social-account tables — OWN tables ONLY', () => {
  const created = [...migration046.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    ['social_accounts', 'social_account_grants', 'social_account_events', 'social_account_grant_scopes'],
    'own tables ONLY — the binding records, the append-oriented authorization-grant records, the append-only history tail and the scope records; the /integrations (029), /credentials (005) and tenant authorities stay sole, consumed READ-ONLY through the public contracts',
  );

  // The binding's frozen columns: the canonical integration reference,
  // the tenant scope chain, the optional workspace, the platform identity
  // (adapter key carried AS DATA), the external identity (verbatim), the
  // lifecycle and the provenance.
  const accountColumns = columnsOf(createTableBlock(migration046, 'social_accounts'));
  for (const required of [
    'social_account_id', 'integration_connection_id', 'agency_id', 'client_id', 'workspace_id',
    'platform_id', 'external_account_id', 'display_identity', 'verified_at', 'status',
    'created_by_actor', 'created_via', 'correlation_id', 'causation_id',
    'created_at', 'updated_at', 'version',
  ]) {
    assert.ok(accountColumns.includes(required), `social_accounts must carry '${required}'`);
  }

  // The grant's frozen columns: the completion facts are nullable until
  // the single fill; the credential-vault reference is the ONLY
  // token-related column.
  const grantColumns = columnsOf(createTableBlock(migration046, 'social_account_grants'));
  for (const required of [
    'grant_id', 'integration_connection_id', 'agency_id', 'client_id', 'social_account_id',
    'platform_id', 'grant_state', 'state_token', 'requested_scopes',
    'credential_reference_id', 'expires_at', 'successor_grant_id', 'completed_at',
    'started_by_actor', 'started_via', 'started_correlation_id', 'started_causation_id',
    'completed_by_actor', 'completed_via', 'completed_correlation_id', 'completed_causation_id',
    'created_at', 'updated_at', 'version',
  ]) {
    assert.ok(grantColumns.includes(required), `social_account_grants must carry '${required}'`);
  }

  // The scope records + the history tail shapes.
  const scopeColumns = columnsOf(createTableBlock(migration046, 'social_account_grant_scopes'));
  assert.deepEqual(scopeColumns, ['grant_id', 'scope_kind', 'scope_value', 'position']);
  const eventColumns = columnsOf(createTableBlock(migration046, 'social_account_events'));
  for (const required of [
    'event_id', 'social_account_id', 'grant_id', 'event_type', 'initiated_by', 'reason',
    'provider_revoke_outcome', 'recorded_actor', 'recorded_via', 'correlation_id',
    'causation_id', 'recorded_at',
  ]) {
    assert.ok(eventColumns.includes(required), `social_account_events must carry '${required}'`);
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-055 AC-2/AC-5 static: the frozen lifecycle vocabularies are CHECK-fenced with the terminal states', () => {
  // The account lifecycle: connected → disconnected | revoked (terminal).
  assert.ok(
    migration046.includes("CHECK (status IN ('connected', 'disconnected', 'revoked'))"),
    'the account lifecycle vocabulary is CHECK-fenced',
  );
  assert.ok(
    migration046.includes('the binding lifecycle state is terminal and cannot be re-activated in place'),
    'the terminal-state trigger message is explicit',
  );
  // The grant lifecycle vocabulary.
  assert.ok(
    migration046.includes(
      "CHECK (grant_state IN ('pending', 'authorized', 'expired',\n                                                   'revoked', 'refreshed', 'superseded'))",
    ),
    'the grant lifecycle vocabulary is CHECK-fenced',
  );
  // The frozen grant transition table (the trigger backstop).
  for (const transition of [
    "WHEN 'pending'    THEN v_legal := ARRAY['authorized', 'expired', 'revoked'];",
    "WHEN 'authorized' THEN v_legal := ARRAY['expired', 'revoked', 'refreshed', 'superseded'];",
    "WHEN 'expired'    THEN v_legal := ARRAY['refreshed', 'superseded', 'revoked'];",
  ]) {
    assert.ok(migration046.includes(transition), `the frozen grant transition table includes ${transition}`);
  }
  // The scope-kind vocabulary.
  assert.ok(
    migration046.includes("CHECK (scope_kind IN ('granted-scope', 'capability-tag'))"),
    'the two-kind scope-record vocabulary is CHECK-fenced',
  );
  // The event vocabulary + the initiation source.
  assert.ok(
    migration046.includes("CHECK (initiated_by IN ('operator', 'external-signal'))"),
    'the operator | external-signal initiation source is CHECK-fenced',
  );
  for (const eventType of SOCIAL_ACCOUNT_EVENT_TYPES) {
    assert.ok(migration046.includes(`'${eventType}'`), `the event vocabulary names '${eventType}'`);
  }
  // The code-side mirrors agree with the storage fences.
  assert.deepEqual(SOCIAL_ACCOUNT_STATUSES, ['connected', 'disconnected', 'revoked']);
  assert.deepEqual(SOCIAL_GRANT_STATES, [
    'pending', 'authorized', 'expired', 'revoked', 'refreshed', 'superseded',
  ]);
  assert.deepEqual(SOCIAL_GRANT_SCOPE_KINDS, ['granted-scope', 'capability-tag']);
});

test('MKT-055 AC-4/AC-6 static: the binding/idempotency fences and the append-only triggers exist', () => {
  // ONE CONNECTION BINDS ONE PLATFORM IDENTITY: at most one connected
  // binding per connection; at most one per (client, platform, external).
  assert.ok(migration046.includes('social_accounts_connection_active_fence'));
  assert.ok(migration046.includes('social_accounts_identity_active_fence'));
  assert.ok(migration046.includes("WHERE status = 'connected'"));
  // The single active authorization fence + the unique state token.
  assert.ok(migration046.includes('social_account_grants_authorized_fence'));
  assert.ok(migration046.includes("WHERE grant_state = 'authorized' AND social_account_id IS NOT NULL"));
  assert.ok(migration046.includes('social_account_grants_state_token_unique'));
  // THE PENDING-STATE PAYLOAD FENCE (the single completion fill shape).
  assert.ok(migration046.includes('CONSTRAINT social_account_grant_shape CHECK ('));
  assert.ok(migration046.includes('the completion fill runs exactly once'));
  assert.ok(migration046.includes('refresh/reauthorize appends NEW records'));
  // THE APPEND-ONLY TAIL (history events: UPDATE and DELETE rejected).
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_events_append_only()'));
  assert.ok(migration046.includes('social account events are append-only'));
  // THE SCOPE RECORDS: append-only (the verbatim facts never rewrite).
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_grant_scopes_append_only()'));
  assert.ok(migration046.includes('social account grant scopes are append-only'));
  // THE GRANTS: no DELETE (append-oriented history).
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_grants_no_delete()'));
  assert.ok(migration046.includes('social account grants are append-oriented history'));
  // THE IDENTITY-IMMUTABILITY triggers (binding + grant).
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_accounts_identity_immutable()'));
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_grant_row_disciplined()'));
  // THE TENANT FENCE + the canonical integration-reference consistency.
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_scope_chain_consistent()'));
  assert.ok(migration046.includes('CREATE OR REPLACE FUNCTION social_account_integration_consistent()'));
  assert.ok(
    migration046.includes('REFERENCES integration_connections(connection_id)'),
    'the canonical integration reference is FK-anchored (read check-only)',
  );
  assert.ok(
    migration046.includes('REFERENCES credential_references(credential_id)'),
    'the vault reference is FK-anchored',
  );
});

// ---------------------------------------------------------------------------
// 3. THE SECRET SEPARATION BATTERY (AC-3 — the heart)
// ---------------------------------------------------------------------------

test('MKT-055 AC-3 static: NO token/code/secret/material/handle column ANYWHERE in migration 046 (secrets live in the vault by canonical reference)', () => {
  for (const table of [
    'social_accounts',
    'social_account_grants',
    'social_account_events',
    'social_account_grant_scopes',
  ]) {
    const block = createTableBlock(migration046, table);
    const columns = columnsOf(block);
    // Whole-column and suffix matches (the state_token column is the
    // OAuth anti-CSRF state parameter — protocol data, deliberately NOT
    // a secret; it is opaque, server-generated and recorded on the round).
    for (const forbidden of [
      'code', 'secret', 'material', 'handle', 'password', 'apikey',
      'access_token', 'refresh_token', 'authorization_code',
    ]) {
      const offending = columns.filter(
        (column) => column === forbidden || column.endsWith(`_${forbidden}`) || column.startsWith(`${forbidden}_`),
      );
      assert.ok(
        offending.length === 0,
        `${table} must NEVER carry the material-shaped column '${forbidden}' (found: ${offending.join(',')}) — tokens go through the /credentials vault by canonical reference (the model stores the reference + the grant metadata only)`,
      );
    }
    assert.ok(
      !columns.some((column) => column.includes('token') && column !== 'state_token'),
      `${table}: the ONLY token-named column may be state_token (the OAuth anti-CSRF state parameter)`,
    );
    assert.ok(!/jsonb/.test(block) || table === 'social_account_grants', `only the grants table carries a jsonb column (the requested-scopes intent)`);
  }
  // The grants table's jsonb column is the requested-scope INTENT only.
  const grantBlock = createTableBlock(migration046, 'social_account_grants');
  assert.ok(grantBlock.includes('requested_scopes'));
  // The credential reference is the ONLY vault linkage.
  assert.ok(grantBlock.includes('credential_reference_id uuid'));
});

test('MKT-055 AC-3 static: the module code never touches token material — the opaque handle goes straight to the vault; the grant is its OWN least-privilege reference', () => {
  // The module creates references of its own kind only (lock rule 28).
  assert.equal(SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND, 'social_account_oauth');
  assert.ok(socialModule.includes('SOCIAL_ACCOUNT_TOKEN_CREDENTIAL_KIND'));
  assert.ok(socialModule.includes('createCredentialReference'), 'references are created through the /credentials public contract');
  assert.ok(socialModule.includes('setCredentialStatus'), 'replaced grants references are disabled through the vault (no zombie grants)');
  assert.ok(socialModule.includes('resolveCredentialMaterial'), 'material resolves ONLY through the authorized-execution path, in-process');
  // The token-material values exist only in-process: the module code
  // names the material in exactly the sanctioned call shapes.
  assert.ok(socialModule.includes('currentTokenMaterial'), 'the refresh hands the material to the flow IN-PROCESS only');
  // DML-against-own-tables ONLY: the store writes exactly the four own
  // tables and reads no other module's table.
  const storeCode = stripComments(socialStore);
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(insertTables)].sort(), [
    'social_account_events',
    'social_account_grant_scopes',
    'social_account_grants',
    'social_accounts',
  ]);
  const updateTables = [...storeCode.matchAll(/UPDATE ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(updateTables)].sort(), ['social_account_grants', 'social_accounts']);
  const deleteTables = [...storeCode.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(deleteTables, [], 'the store never issues a DELETE');
  const selectTables = [...storeCode.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(selectTables)].sort(),
    ['social_account_events', 'social_account_grant_scopes', 'social_account_grants', 'social_accounts'],
    'the store reads ONLY the own tables — every other read composes a public contract',
  );
  // No material-shaped identifier in the module core/store/public code
  // (grant-validation.ts owns the §21 GUARD that legitimately names the
  // rejected key shapes — it is the backstop, not a consumer).
  for (const file of [socialPublic, socialModule, socialStore]) {
    const code = stripComments(file);
    for (const forbidden of ['access_token', 'refreshToken', 'apiKey', 'password', 'secretMaterial']) {
      assert.ok(
        !code.includes(forbidden),
        `the module code must never contain the material-shaped identifier '${forbidden}'`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 4. THE PROVIDER-NEUTRAL BOUNDARY (AC-7 + lock rule 18)
// ---------------------------------------------------------------------------

test('MKT-055 AC-7 static: NO platform-specific strings/logic in the module code (lock rule 18 — the platform identity is the adapter key carried as data)', () => {
  // The social platforms of the v1.6 MVP adapter set (MKT-057..061) may
  // NEVER be named in the module code — no platform branch, no platform
  // endpoint, no platform-specific constant (they live exclusively in the
  // future adapter subtrees and the test doubles).
  const platformNames = [
    'youtube', 'instagram', 'facebook', 'tiktok', 'twitter', 'x.com',
    'graph.instagram', 'googleapis', 'api.twitter',
  ];
  for (const file of [socialPublic, socialModule, socialStore, socialValidation, socialRoutes]) {
    const code = stripComments(file).toLowerCase();
    for (const platform of platformNames) {
      assert.ok(
        !code.includes(platform),
        `the module code must never contain the platform-specific string '${platform}' — platform-specific knowledge lives exclusively behind the future MKT-056+ adapter contract (the disclosed provider double of the integration tests is TEST code)`,
      );
    }
  }
  // The flow implementations arrive as DATA (the adapter-registry
  // precedent) and the production registry is EMPTY until MKT-056+.
  assert.ok(socialPublic.includes('readonly flows: readonly SocialAccountFlowImplementation[]'), 'flows arrive as data through the module deps');
  assert.ok(
    compositionRoot.includes('flows: options.socialAccountFlows ?? []'),
    'the production composition registers NO flow by default (MKT-056+ wires real flows)',
  );
  assert.ok(
    compositionRoot.includes('socialAccountFlows'),
    'the disclosed composition seam exists (AppOptions.socialAccountFlows)',
  );
  // The platform identity is the adapter key carried as data.
  assert.ok(
    socialModule.includes('ownership.connection.adapterKey'),
    'the platform identity derives from the integration connection record (data), never a provider branch',
  );
});

// ---------------------------------------------------------------------------
// 5. The route surface (GET/POST discipline; the fail-closed consumer read is module-level)
// ---------------------------------------------------------------------------

test('MKT-055 static: the route surface is EXACTLY the frozen twelve — six flow POSTs + six reads; no update/delete; the usable-authorization read is NEVER a route', () => {
  const routes = [...stripComments(socialRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/clients/:clientId/social-accounts',
    'GET /api/clients/:clientId/social-accounts/:accountId',
    'GET /api/clients/:clientId/social-accounts/:accountId/events',
    'GET /api/clients/:clientId/social-accounts/:accountId/grants',
    'GET /api/clients/:clientId/social-accounts/:accountId/grants/:grantId',
    'GET /api/workspaces/:workspaceId/social-accounts',
    'POST /api/clients/:clientId/social-accounts/:accountId/disconnect',
    'POST /api/clients/:clientId/social-accounts/:accountId/external-revocation',
    'POST /api/clients/:clientId/social-accounts/:accountId/reauthorize',
    'POST /api/clients/:clientId/social-accounts/:accountId/refresh',
    'POST /api/clients/:clientId/social-accounts/authorize-start',
    'POST /api/clients/:clientId/social-accounts/complete',
  ]);
  const routesCode = stripComments(socialRoutes);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !routesCode.includes(`'${verb}'`),
      `the route file never registers the verb '${verb}'`,
    );
  }
  // The fail-closed consumer read is module-level ONLY — never an HTTP
  // authorization oracle.
  assert.ok(!routesCode.includes('getUsableAuthorization'), 'getUsableAuthorization is never a route');
  assert.ok(socialModule.includes('getUsableAuthorization'), 'the module-level consumer surface exists');
  // The uniform-404/403 posture helpers + the 409 refusal on dead
  // connections come from the module contract.
  assert.ok(socialRoutes.includes('NotFoundError'), 'the uniform 404 error class');
  assert.ok(socialRoutes.includes('requireClientAccess'), 'the client ownership resolution');
  assert.ok(socialRoutes.includes('requireWorkspaceAccess'), 'the workspace ownership resolution');
  assert.ok(socialModule.includes('every read of a disconnected/revoked connection\'s grant refuses'));
});

// ---------------------------------------------------------------------------
// 6. Zero cross-module internal imports (the real-codebase arch-check run)
// ---------------------------------------------------------------------------

test('MKT-055 static: the real codebase enforces the frozen boundaries with ZERO violations — /social-accounts is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('social-accounts'), 'the enforced set includes /social-accounts');
  // The matrix-listed composition directions are exactly the four.
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['social-accounts'], ['integrations', 'credentials', 'policies', 'workspaces']);
  // The module's public contract imports ONLY the matrix-listed module
  // publics + platform ports (structural typing covers /workspaces at
  // the composition root).
  const imports = [...socialPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(imports)].sort(), ['credentials', 'integrations', 'policies']);
});

// ---------------------------------------------------------------------------
// 7. The disclosed spec registration + the migration list position
// ---------------------------------------------------------------------------

test('MKT-055 static: the disclosed spec registration exists — §6 line + §6 sentence + matrix row + bullet; 046 in numeric position', () => {
  // The §6 module list carries /social-accounts.
  assert.ok(
    /^\/social-accounts$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /social-accounts',
  );
  assert.ok(
    architectureSpec.includes('`/social-accounts` is the v1.6 Social Account and OAuth Connection Model authority'),
    'the §6 registration sentence exists',
  );
  // The matrix row + the forbidden-directions bullet.
  assert.ok(
    matrixSpec.includes('/social-accounts ──→ /integrations, /credentials, /policies, /workspaces'),
    'the matrix dependency row exists',
  );
  assert.ok(
    matrixSpec.includes('- `/social-accounts` is the v1.6 Social Account and OAuth Connection Model authority'),
    'the matrix forbidden-directions bullet exists',
  );
  // 046_social_accounts.sql holds its numeric position (the
  // PRE-ASSIGNED number — 045 is reserved for a sibling delivery; the
  // MKT-071 /integrations commerce extension appends 049 after 046 —
  // 047/048 belong to sibling deliveries).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // The MKT-068 /notification-delivery, MKT-069 /product-intelligence and
  // MKT-071 commerce-capability deliveries append 047, 048 and 049 after
  // 046 (all numbers PRE-ASSIGNED to those sibling Work Items), and the
  // MKT-056 social-adapter-contract delivery appends ITS OWN 050 after
  // 049 (this module's capability-plane extension — the number kept per
  // the dispatch disclosure), and the MKT-063 /content-rights delivery
  // appends 051, so 046 is now sixth-to-last in the ordered tail.
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 7], '046_social_accounts.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 6], '047_notification_delivery.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 5], '048_product_intelligence.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 4], '049_commerce_capabilities.sql');
  // The MKT-056 social-adapter-contract delivery appends ITS OWN 050 and
  // the MKT-063 /content-rights sibling delivery appends 051 (the same
  // additive precedent — this module's positions shift once more).
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 3], '050_social_adapter_contract.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '051_content_rights.sql');
  // The MKT-064 /content-assets sibling delivery appends 053 after 051
  // (052 is deliberately left for the sibling MKT-054's renumber-at-
  // merge — the additive precedent; this module's positions shift once
  // more).
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '053_content_assets.sql');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly socialAccounts: SocialAccountsModuleApi'), 'ApplicationModules.socialAccounts');
  assert.ok(applicationTs.includes("from '../modules/social-accounts/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerSocialAccountsRoutes(router, services, modules)'), 'routes.ts registers the social-account routes');
  assert.ok(routesTs.includes("from './social-accounts-routes.ts'"), 'routes.ts imports the social-account route builder');
  assert.ok(compositionRoot.includes('createSocialAccountsModule'), 'the composition root constructs the social-accounts module');
  assert.ok(
    compositionRoot.includes('workspaceOwnership: workspaces'),
    'the REAL /workspaces public-contract instance satisfies the ownership port',
  );
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'social-accounts', 'public.ts')));
  assert.ok(existsSync(src('modules', 'social-accounts', 'internal', 'module.ts')));
  assert.ok(existsSync(src('modules', 'social-accounts', 'internal', 'store.ts')));
  assert.ok(existsSync(src('modules', 'social-accounts', 'internal', 'grant-validation.ts')));
});
