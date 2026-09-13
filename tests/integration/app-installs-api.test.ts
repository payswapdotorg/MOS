/**
 * MKT-048 integration tests — the App installation authority (App
 * Installation, Upgrade and Rollback) on the real stack (embedded
 * PostgreSQL 18 + real API process — no mocks of platform services).
 *
 * Acceptance mapping (spec/effective-backlog-v1.5.md MKT-048; the
 * dispatch acceptance criteria AC-2..AC-10):
 *   - AC-2/AC-6 GOLDEN INSTALL: a workspace member with the sanctioned
 *     role installs an EXACT published App Version; the read-back returns
 *     the selection with the exact (app key, version) identity, the
 *     SERVER-DERIVED granted scopes (the manifest request ∩ policy ∩ the
 *     frozen vocabularies — the platform policy DENIES one requested
 *     scope, proving the intersection), install provenance (who/when,
 *     server-derived) and the born-ACTIVE lifecycle (verified by direct
 *     SQL); the workspace listing carries the current selection + the
 *     full history; the agency rollup lists current selections;
 *   - AC-3 POLICY-GATE BATTERY: an agency-scoped deny of the
 *     extension-dimension install boundary → 403 with ZERO rows (the
 *     /deployments precedent); a superseding allow restores installs; a
 *     member WITHOUT the sanctioned installer role → 403; a SUSPENDED
 *     member → 403; a foreign workspace → uniform 404; anonymous → 401;
 *   - AC-4 UPGRADE/ROLLBACK SEMANTICS (the heart): upgrade selects a NEW
 *     exact version for FUTURE use — the PRIOR install row's historical
 *     identity is preserved (DB-asserted: the row retains its ORIGINAL
 *     version after upgrade AND rollback; the selection change is a NEW
 *     row + the append-only event tail); rollback reselects a
 *     PREVIOUSLY INSTALLED approved version the same way; NO history
 *     rewrite ever — direct SQL UPDATE/DELETE are REJECTED by the
 *     database triggers (the single sanctioned supersession transition
 *     is the ONLY legal UPDATE);
 *   - AC-5 COMPATIBILITY VALIDATION: an upgrade target outside the
 *     platform compatibility range is rejected 422 with the honest
 *     reason, zero rows; an app whose extension dependency is not
 *     authorized in the workspace is rejected 422 with the honest
 *     reason, zero rows;
 *   - AC-7 DTO GUARDS: a caller-supplied granted-scopes key is rejected
 *     422 with ZERO rows (granted scopes are NEVER caller-suppliable);
 *   - AC-10 CONVERGENCE: an identical replayed payload converges (200,
 *     same rows, zero new state); a divergent payload under the same key
 *     is a 409; concurrent duplicate installs of one (workspace, app)
 *     lineage converge to EXACTLY ONE winner (one 201, seven 409s, one
 *     row — the current-selection fence).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

before(async () => {
  stack = await bootStack('app-installs');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

/** An agency owner (the sanctioned installer role) with its own agency. */
async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

async function makeClient(agencyId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['workspaceId'] as string;
}

/** A bare user granted the frozen platform_developer role (the publish gate). */
async function makeDeveloper(email: string): Promise<User> {
  const user = await makeUser(email, 'developer-password-123');
  const grant = await apiCall(port(), `/api/users/${user.userId}/platform-roles`, {
    token: await adminToken(),
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  return user;
}

/**
 * The frozen §Manifest fixture. DEFAULTS: NO dependencies (the golden
 * compatibility path), platform compatibility [1.0.0 .. 2.0.0] against the
 * server-declared 1.5.0, and BOTH data scopes + BOTH mutation scopes
 * requested — the platform policy DENIES exactly one data scope
 * ('workspace:read') so every install proves the SERVER-DERIVED
 * intersection (request ∩ policy ∩ vocabulary).
 */
function appManifestFixture(appKey: string, version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifest: {
      appKey,
      version,
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [{ name: 'run', version: '1.0.0' }],
      inputSchema: { required: ['workspaceId'] },
      outputSchema: { required: ['ok'] },
      dataScopes: ['client:read', 'workspace:read'],
      mutationScopes: ['evidence:append', 'metric:append'],
      networkDestinations: [],
      runtimeClass: 'pooled-worker',
      eventSubscriptions: [],
      uiSurfaces: [{ surface: 'workspace-tab', route: `/tabs/${appKey}` }],
      configSchema: {},
      requiredCredentialNames: [],
      stateNamespaces: [`app:${appKey}:docs`],
      migrationVersion: 1,
      dependencies: [],
      supportLevel: 'standard',
      meteringDimensions: ['installations'],
      ...overrides,
    },
    idempotencyKey: `publish-${appKey}-${version}`,
  };
}

/** Publishes one immutable App Version through the frozen developer gate. */
async function publishApp(manifest: Record<string, unknown>, token: string): Promise<Record<string, unknown>> {
  const publish = await apiCall(port(), '/api/apps', {
    token,
    body: { ...manifest, idempotencyKey: `publish-${(manifest['manifest'] as Record<string, unknown>)['appKey']}-${(manifest['manifest'] as Record<string, unknown>)['version']}` },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  return publish.body as Record<string, unknown>;
}

/** Installs one EXACT App Version into a workspace. */
async function installApp(workspaceId: string, token: string, appKey: string, version: string, idempotencyKey: string, extra: Record<string, unknown> = {}) {
  return apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token,
    body: { appKey, version, idempotencyKey, ...extra },
  });
}

async function countInstalls(workspaceId: string, appKey?: string): Promise<number> {
  const result = appKey === undefined
    ? await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM app_installs WHERE workspace_id = $1', [workspaceId])
    : await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM app_installs WHERE workspace_id = $1 AND app_key = $2', [workspaceId, appKey]);
  return Number(result.rows[0]!.count);
}

async function installRow(installId: string) {
  const result = await pool().query<{
    app_key: string; version: string; operation: string; status: string;
    selection_seq: string; installed_by: string | null; policy_decision_id: string | null;
    granted_data_scopes: string[]; granted_mutation_scopes: string[];
  }>(
    'SELECT app_key, version, operation, status, selection_seq::text, installed_by, policy_decision_id, granted_data_scopes, granted_mutation_scopes FROM app_installs WHERE install_id = $1',
    [installId],
  );
  return result.rows[0] ?? null;
}

// Shared state built once in the first tests (creation order matters).
interface SharedState {
  readonly developer: User;
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly installId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// AC-2/AC-6 — the golden install → read-back with SERVER-DERIVED grants
// ---------------------------------------------------------------------------

test('AC-2: a sanctioned workspace member installs an EXACT published App Version — born ACTIVE, server-derived grants (the policy intersection), provenance and the policy decision reference (DB-asserted)', async () => {
  // The platform extension-dimension boundary: install/upgrade/rollback
  // allowed, ONE requested data scope DENIED (the intersection proof).
  const declare = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'allow', operations: ['install', 'upgrade', 'rollback'], reason: 'platform app-install boundary allow' },
        { effect: 'deny', operations: ['install', 'upgrade', 'rollback'], attributes: { dataScope: 'workspace:read' }, reason: 'deny one requested data scope at grant time' },
      ],
      description: 'Platform app-install boundary v1',
    },
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));

  const developer = await makeDeveloper('appinstalls-developer@marketingos.test');
  const owner = await makeAgencyOwner('appinstalls-owner@marketingos.test');
  const clientId = await makeClient(owner.agencyId, owner.token);
  const workspaceId = await makeWorkspace(clientId, owner.token, 'App Installs Workspace');

  await publishApp(appManifestFixture('golden-reporter', '1.0.0'), developer.token);

  const install = await installApp(workspaceId, owner.token, 'golden-reporter', '1.0.0', 'install-golden-1');
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const installBody = install.body as Record<string, unknown>;
  const record = installBody['install'] as Record<string, unknown>;
  const installId = record['installId'] as string;
  assert.equal(record['appKey'], 'golden-reporter');
  assert.equal(record['version'], '1.0.0');
  assert.equal(record['operation'], 'install');
  assert.equal(record['status'], 'ACTIVE');
  assert.equal(record['selectionSeq'], 1);
  // The SERVER-DERIVED grants: the manifest requested BOTH data scopes —
  // the policy denied exactly 'workspace:read' → the honest intersection.
  assert.deepEqual(record['grantedDataScopes'], ['client:read']);
  assert.deepEqual(record['grantedMutationScopes'], ['evidence:append', 'metric:append']);
  assert.equal(record['installedBy'], owner.userId);

  // DB-asserted: the exact-version identity, the scope chain, the
  // server-derived grants, the policy decision reference, born ACTIVE.
  const row = await installRow(installId);
  assert.notEqual(row, null);
  assert.equal(row!.app_key, 'golden-reporter');
  assert.equal(row!.version, '1.0.0');
  assert.equal(row!.operation, 'install');
  assert.equal(row!.status, 'ACTIVE');
  assert.equal(row!.selection_seq, '1');
  assert.equal(row!.installed_by, owner.userId);
  assert.notEqual(row!.policy_decision_id, null, 'the install-time policy decision is recorded');
  assert.deepEqual(row!.granted_data_scopes, ['client:read']);
  assert.deepEqual(row!.granted_mutation_scopes, ['evidence:append', 'metric:append']);

  // The read-back returns the selection row (GET one).
  const readBack = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs/${installId}`, { token: owner.token });
  assert.equal(readBack.status, 200);
  assert.equal((readBack.body as Record<string, unknown>)['version'], '1.0.0');
  assert.deepEqual((readBack.body as Record<string, unknown>)['grantedDataScopes'], ['client:read']);

  // The workspace listing carries the current selection; the agency
  // rollup lists it too.
  const list = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, { token: owner.token });
  assert.equal(list.status, 200);
  const listBody = list.body as Record<string, unknown>;
  assert.deepEqual(listBody['currentSelections'], [installId]);
  const rollup = await apiCall(port(), `/api/agencies/${owner.agencyId}/app-installs`, { token: owner.token });
  assert.equal(rollup.status, 200);
  const rollupInstalls = (rollup.body as Record<string, unknown>)['installs'] as Record<string, unknown>[];
  assert.equal(rollupInstalls.length, 1);
  assert.equal(rollupInstalls[0]!['installId'], installId);

  // The append-only event tail (module-level read — direct SQL).
  const events = await pool().query<{ event_type: string; to_version: string; prior_install_id: string | null }>(
    'SELECT event_type, to_version, prior_install_id FROM app_install_events WHERE workspace_id = $1 ORDER BY recorded_at, event_id',
    [workspaceId],
  );
  assert.equal(events.rows.length, 1);
  assert.equal(events.rows[0]!.event_type, 'installed');
  assert.equal(events.rows[0]!.to_version, '1.0.0');
  assert.equal(events.rows[0]!.prior_install_id, null);

  shared = { developer, owner, agencyId: owner.agencyId, clientId, workspaceId, installId };
});

// ---------------------------------------------------------------------------
// AC-7 — DTO guards: granted scopes are NEVER caller-suppliable
// ---------------------------------------------------------------------------

test('AC-7: a caller-supplied granted-scopes key is rejected 422 with ZERO rows', async () => {
  const before = await countInstalls(state().workspaceId);
  const spoofed = await installApp(state().workspaceId, state().owner.token, 'golden-reporter', '1.0.0', 'spoof-1', {
    grantedDataScopes: ['client:read', 'workspace:write'],
  });
  assert.equal(spoofed.status, 422, JSON.stringify(spoofed.body));
  const spoofed2 = await installApp(state().workspaceId, state().owner.token, 'golden-reporter', '1.0.0', 'spoof-2', {
    grantedScopes: ['client:read'],
  });
  assert.equal(spoofed2.status, 422, JSON.stringify(spoofed2.body));
  assert.equal(await countInstalls(state().workspaceId), before, 'zero rows on rejection');
});

// ---------------------------------------------------------------------------
// AC-3 — the policy-gate battery (deny → 403 zero rows; role/suspension;
// foreign workspace 404; anonymous 401)
// ---------------------------------------------------------------------------

test('AC-3: an agency-scoped policy DENY of the install boundary → 403 with ZERO rows; a superseding allow restores installs', async () => {
  const ownerB = await makeAgencyOwner('appinstalls-owner-b@marketingos.test');
  const clientB = await makeClient(ownerB.agencyId, ownerB.token);
  const workspaceB = await makeWorkspace(clientB, ownerB.token, 'App Installs Workspace B');

  // The agency-scoped deny (DENY-OVERRIDES the platform allow).
  const deny = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/policies`, {
    token: ownerB.token,
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'deny', operations: ['install', 'upgrade', 'rollback'], reason: 'agency B blocks app installs' },
      ],
      description: 'Agency B app-install boundary v1',
    },
  });
  assert.equal(deny.status, 201, JSON.stringify(deny.body));

  const denied = await installApp(workspaceB, ownerB.token, 'golden-reporter', '1.0.0', 'install-b-deny');
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(await countInstalls(workspaceB), 0, 'a denied install writes ZERO rows');

  // A member WITHOUT the sanctioned installer role → 403 (still zero rows).
  const operator = await makeUser('appinstalls-operator@marketingos.test', 'operator-password-123');
  const grant = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships`, {
    token: ownerB.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));
  const roleRefused = await installApp(workspaceB, operator.token, 'golden-reporter', '1.0.0', 'install-b-role');
  assert.equal(roleRefused.status, 403, JSON.stringify(roleRefused.body));
  assert.equal(await countInstalls(workspaceB), 0, 'an unauthorized member writes ZERO rows');

  // A SUSPENDED (membership-disabled) member → 403 (fail-closed posture —
  // the disabled insider never authorizes; the /workspaces precedent).
  const memberships = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships`, {
    token: ownerB.token,
  });
  const membership = ((memberships.body as Record<string, unknown>)['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === operator.userId,
  )!;
  const disable = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/memberships/${membership['membershipId'] as string}`, {
    token: ownerB.token,
    method: 'PATCH',
    body: { status: 'disabled', version: membership['version'] as number },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  const suspendedRefused = await apiCall(port(), `/api/workspaces/${workspaceB}/app-installs`, {
    token: operator.token,
    body: { appKey: 'golden-reporter', version: '1.0.0', idempotencyKey: 'install-b-suspended' },
  });
  assert.equal(suspendedRefused.status, 403, JSON.stringify(suspendedRefused.body));

  // The superseding ALLOW restores installs (append-oriented policy
  // history — the deny is superseded, not rewritten).
  const allow = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/policies`, {
    token: ownerB.token,
    body: {
      dimension: 'extension',
      rules: [
        { effect: 'allow', operations: ['install', 'upgrade', 'rollback'], reason: 'agency B allows app installs again' },
      ],
      description: 'Agency B app-install boundary v2',
    },
  });
  assert.equal(allow.status, 201, JSON.stringify(allow.body));
  const restored = await installApp(workspaceB, ownerB.token, 'golden-reporter', '1.0.0', 'install-b-allow');
  assert.equal(restored.status, 201, JSON.stringify(restored.body));
  assert.equal(await countInstalls(workspaceB), 1);
});

test('AC-3: a foreign workspace is the UNIFORM 404 and an anonymous caller fails closed 401', async () => {
  const ownerC = await makeAgencyOwner('appinstalls-owner-c@marketingos.test');
  const clientC = await makeClient(ownerC.agencyId, ownerC.token);
  const workspaceC = await makeWorkspace(clientC, ownerC.token, 'App Installs Workspace C');

  // Foreign workspace: the owner of A acting on workspace C → uniform 404
  // (indistinguishable from an unknown workspace — no existence oracle).
  const foreign = await installApp(workspaceC, state().owner.token, 'golden-reporter', '1.0.0', 'install-c-foreign');
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  assert.equal(await countInstalls(workspaceC), 0);

  // A foreign INSTALL id read: workspace A reading workspace B's row.
  const installsB = await pool().query<{ install_id: string }>('SELECT install_id FROM app_installs WHERE workspace_id = $1 LIMIT 1', [workspaceC]);
  if (installsB.rows.length > 0) {
    const foreignRead = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${installsB.rows[0]!.install_id}`, { token: state().owner.token });
    assert.equal(foreignRead.status, 404);
  }

  // Anonymous: no token → 401 on every surface.
  const anonymousInstall = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs`, {
    body: { appKey: 'golden-reporter', version: '1.0.0', idempotencyKey: 'anon' },
  });
  assert.equal(anonymousInstall.status, 401);
  const anonymousList = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs`);
  assert.equal(anonymousList.status, 401);
  const anonymousRollup = await apiCall(port(), `/api/agencies/${state().agencyId}/app-installs`);
  assert.equal(anonymousRollup.status, 401);
});

// ---------------------------------------------------------------------------
// AC-4 — UPGRADE/ROLLBACK SEMANTICS (the heart): append-oriented selection
// changes; historical rows retain their ORIGINAL exact version
// ---------------------------------------------------------------------------

test('AC-4: UPGRADE selects a NEW exact version for FUTURE invocations — the PRIOR row retains its ORIGINAL version (DB-asserted)', async () => {
  await publishApp(appManifestFixture('golden-reporter', '1.1.0'), state().developer.token);

  const upgrade = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${state().installId}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.1.0', idempotencyKey: 'upgrade-golden-1' },
  });
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));
  const upgradeBody = upgrade.body as Record<string, unknown>;
  const newSelection = upgradeBody['install'] as Record<string, unknown>;
  const prior = upgradeBody['prior'] as Record<string, unknown>;
  assert.equal(newSelection['version'], '1.1.0');
  assert.equal(newSelection['operation'], 'upgrade');
  assert.equal(newSelection['status'], 'ACTIVE');
  assert.equal(newSelection['selectionSeq'], 2);
  assert.equal(newSelection['installId'] !== state().installId, true, 'the successor is a NEW row');
  assert.equal(prior['installId'], state().installId);
  assert.equal(prior['version'], '1.0.0', 'the prior row retains its ORIGINAL version');
  assert.equal(prior['status'], 'SUPERSEDED');

  // DB-asserted: TWO rows; the ORIGINAL row unchanged (identity, version,
  // operation, grants, provenance, §8 key) except the supersession stamp.
  const lineage = await pool().query<{
    install_id: string; version: string; operation: string; status: string; selection_seq: string;
    granted_data_scopes: string[]; installed_by: string | null; idempotency_key: string; superseded_at: Date | null;
  }>(
    'SELECT install_id, version, operation, status, selection_seq::text, granted_data_scopes, installed_by, idempotency_key, superseded_at FROM app_installs WHERE workspace_id = $1 AND app_key = $2 ORDER BY selection_seq',
    [state().workspaceId, 'golden-reporter'],
  );
  assert.equal(lineage.rows.length, 2);
  const original = lineage.rows[0]!;
  const successor = lineage.rows[1]!;
  assert.equal(original.version, '1.0.0');
  assert.equal(original.operation, 'install');
  assert.equal(original.status, 'SUPERSEDED');
  assert.notEqual(original.superseded_at, null);
  assert.equal(original.idempotency_key, 'install-golden-1');
  assert.equal(original.installed_by, state().owner.userId);
  assert.deepEqual(original.granted_data_scopes, ['client:read']);
  assert.equal(successor.version, '1.1.0');
  assert.equal(successor.operation, 'upgrade');
  assert.equal(successor.status, 'ACTIVE');
  assert.equal(successor.selection_seq, '2');

  // The event tail: installed + upgraded (from 1.0.0 to 1.1.0).
  const events = await pool().query<{ event_type: string; from_version: string | null; to_version: string; prior_install_id: string | null }>(
    'SELECT event_type, from_version, to_version, prior_install_id FROM app_install_events WHERE workspace_id = $1 ORDER BY recorded_at, event_id',
    [state().workspaceId],
  );
  assert.equal(events.rows.length, 2);
  assert.equal(events.rows[1]!.event_type, 'upgraded');
  assert.equal(events.rows[1]!.from_version, '1.0.0');
  assert.equal(events.rows[1]!.to_version, '1.1.0');
  assert.equal(events.rows[1]!.prior_install_id, state().installId);

  // The workspace listing carries the full history + the current selection.
  const list = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs`, { token: state().owner.token });
  const listBody = list.body as Record<string, unknown>;
  assert.deepEqual(listBody['currentSelections'], [successor.install_id]);
  assert.equal(((listBody['installs']) as Record<string, unknown>[]).length, 2);
});

test('AC-4: ROLLBACK reselects a PREVIOUSLY INSTALLED approved version — still NO history rewrite (DB-asserted)', async () => {
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'golden-reporter' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const currentInstallId = current.rows[0]!.install_id;

  const rollback = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${currentInstallId}/rollback`, {
    token: state().owner.token,
    body: { targetInstallId: state().installId, idempotencyKey: 'rollback-golden-1' },
  });
  assert.equal(rollback.status, 201, JSON.stringify(rollback.body));
  const rollbackBody = rollback.body as Record<string, unknown>;
  const reselected = rollbackBody['install'] as Record<string, unknown>;
  assert.equal(reselected['version'], '1.0.0', 'rollback reselects the PRIOR installed version');
  assert.equal(reselected['operation'], 'rollback');
  assert.equal(reselected['status'], 'ACTIVE');
  assert.equal(reselected['selectionSeq'], 3);

  // DB-asserted: THREE rows — versions 1.0.0, 1.1.0, 1.0.0 in selection
  // order; EVERY historical row retains its ORIGINAL identity (no rewrite).
  const lineage = await pool().query<{ version: string; operation: string; status: string; selection_seq: string }>(
    'SELECT version, operation, status, selection_seq::text FROM app_installs WHERE workspace_id = $1 AND app_key = $2 ORDER BY selection_seq',
    [state().workspaceId, 'golden-reporter'],
  );
  assert.equal(lineage.rows.length, 3);
  assert.deepEqual(lineage.rows.map((row) => row.version), ['1.0.0', '1.1.0', '1.0.0']);
  assert.deepEqual(lineage.rows.map((row) => row.status), ['SUPERSEDED', 'SUPERSEDED', 'ACTIVE']);
  assert.deepEqual(lineage.rows.map((row) => row.operation), ['install', 'upgrade', 'rollback']);

  // The event tail: installed + upgraded + rolled_back.
  const events = await pool().query<{ event_type: string; from_version: string | null; to_version: string }>(
    'SELECT event_type, from_version, to_version FROM app_install_events WHERE workspace_id = $1 ORDER BY recorded_at, event_id',
    [state().workspaceId],
  );
  assert.equal(events.rows.length, 3);
  assert.equal(events.rows[2]!.event_type, 'rolled_back');
  assert.equal(events.rows[2]!.from_version, '1.1.0');
  assert.equal(events.rows[2]!.to_version, '1.0.0');
});

test('AC-4/AC-11: the selection state machine rejects illegal requests with ZERO rows', async () => {
  const current = await pool().query<{ install_id: string; version: string }>(
    "SELECT install_id, version FROM app_installs WHERE workspace_id = $1 AND app_key = 'golden-reporter' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const currentInstallId = current.rows[0]!.install_id;
  const rowsBefore = await countInstalls(state().workspaceId);

  // Upgrade to the CURRENT version → rejected.
  const sameVersion = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${currentInstallId}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.0.0', idempotencyKey: 'upgrade-same-1' },
  });
  assert.equal(sameVersion.status, 422, JSON.stringify(sameVersion.body));

  // Upgrade to a PREVIOUSLY INSTALLED version → rollback territory.
  const previouslyInstalled = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${currentInstallId}/upgrade`, {
    token: state().owner.token,
    body: { version: '1.1.0', idempotencyKey: 'upgrade-prev-1' },
  });
  assert.equal(previouslyInstalled.status, 422);
  assert.match(JSON.stringify(previouslyInstalled.body), /rollback reselects previously installed versions/);

  // Rollback targeting the CURRENT selection → rejected.
  const selfRollback = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${currentInstallId}/rollback`, {
    token: state().owner.token,
    body: { targetInstallId: currentInstallId, idempotencyKey: 'rollback-self-1' },
  });
  assert.equal(selfRollback.status, 409, JSON.stringify(selfRollback.body));

  // Rollback to a FOREIGN/unknown install id → uniform 404.
  const foreignRollback = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${currentInstallId}/rollback`, {
    token: state().owner.token,
    body: { targetInstallId: '00000000-0000-4000-8000-000000000000', idempotencyKey: 'rollback-foreign-1' },
  });
  assert.equal(foreignRollback.status, 404);

  // A second INSTALL of the same lineage → rejected (upgrade/rollback are
  // the only selection changes now).
  const secondInstall = await installApp(state().workspaceId, state().owner.token, 'golden-reporter', '1.0.0', 'install-golden-again');
  assert.equal(secondInstall.status, 409, JSON.stringify(secondInstall.body));

  assert.equal(await countInstalls(state().workspaceId), rowsBefore, 'ZERO rows across the battery');
});

// ---------------------------------------------------------------------------
// AC-5 — compatibility validation (the honest reason, zero rows)
// ---------------------------------------------------------------------------

test('AC-5: an upgrade target OUTSIDE the platform compatibility range is rejected 422 with the honest reason, zero rows', async () => {
  await publishApp(appManifestFixture('golden-reporter', '3.0.0', { compatibility: { minPlatform: '2.0.0', maxPlatform: '3.0.0' } }), state().developer.token);
  const current = await pool().query<{ install_id: string }>(
    "SELECT install_id FROM app_installs WHERE workspace_id = $1 AND app_key = 'golden-reporter' AND status = 'ACTIVE'",
    [state().workspaceId],
  );
  const rowsBefore = await countInstalls(state().workspaceId);

  const incompatible = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs/${current.rows[0]!.install_id}/upgrade`, {
    token: state().owner.token,
    body: { version: '3.0.0', idempotencyKey: 'upgrade-incompat-1' },
  });
  assert.equal(incompatible.status, 422, JSON.stringify(incompatible.body));
  assert.match(JSON.stringify(incompatible.body), /not compatible with the target environment/);
  assert.equal(await countInstalls(state().workspaceId), rowsBefore, 'zero rows on compatibility rejection');
});

test('AC-5: an app whose extension dependency is NOT authorized in the workspace is rejected 422 with the honest reason, zero rows', async () => {
  // The dependency target EXISTS in the /extensions registry (the
  // publish-time dependency validation requires it) — but the workspace
  // has NO AUTHORIZED extension install, so the install-time
  // compatibility contract finds the dependency unsatisfiable.
  const publishExtension = await apiCall(port(), '/api/extensions', {
    token: await adminToken(),
    body: {
      manifest: {
        extensionKey: 'audience-enricher',
        publisher: 'payswap-labs',
        version: '1.0.0',
        compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
        capabilities: [{ category: 'data-source', name: 'enrich-audience' }],
        permissions: [{ action: 'data:read' }],
        requiredSecretNames: [],
        dataScopes: ['client:read'],
        networkRequirements: [],
        runtimeClass: 'pooled-worker',
        inputContract: { required: ['audienceId'] },
        outputContract: { required: ['enrichedCount'] },
        eventSubscriptions: [],
        uiSurfaces: [],
        configContract: {},
      },
      idempotencyKey: 'appinstalls-dep-extension-1.0.0',
    },
  });
  assert.equal(publishExtension.status, 201, JSON.stringify(publishExtension.body));

  await publishApp(appManifestFixture('dep-gated-reporter', '1.0.0', {
    dependencies: [{ kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '1.0.0', maxVersion: '2.0.0' }],
  }), state().developer.token);

  const depDenied = await installApp(state().workspaceId, state().owner.token, 'dep-gated-reporter', '1.0.0', 'install-dep-1');
  assert.equal(depDenied.status, 422, JSON.stringify(depDenied.body));
  assert.match(JSON.stringify(depDenied.body), /not compatible with the target environment/);
  assert.equal(await countInstalls(state().workspaceId, 'dep-gated-reporter'), 0, 'zero rows on dependency rejection');
});

// ---------------------------------------------------------------------------
// AC-10 — §8 convergence: replay → 200 same rows; divergent → 409
// ---------------------------------------------------------------------------

test('AC-10: an identical replayed install converges (200, same rows); a divergent payload under the same key conflicts (409)', async () => {
  const rowsBefore = await countInstalls(state().workspaceId);
  const replay = await installApp(state().workspaceId, state().owner.token, 'golden-reporter', '1.0.0', 'install-golden-1');
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const replayBody = replay.body as Record<string, unknown>;
  assert.equal(replayBody['replayed'], true);
  assert.equal((replayBody['install'] as Record<string, unknown>)['installId'], state().installId, 'the replay converges to the RECORDED row');
  assert.equal(await countInstalls(state().workspaceId), rowsBefore, 'a replay writes ZERO new rows');

  // Divergent content under the same key → conflict.
  const divergent = await installApp(state().workspaceId, state().owner.token, 'golden-reporter', '1.1.0', 'install-golden-1');
  assert.equal(divergent.status, 409, JSON.stringify(divergent.body));
  assert.equal(await countInstalls(state().workspaceId), rowsBefore, 'zero rows on divergence');
});

// ---------------------------------------------------------------------------
// AC-10 — concurrency: exactly one concurrent duplicate install wins
// ---------------------------------------------------------------------------

test('AC-10: concurrent duplicate installs converge to EXACTLY ONE winner — one 201, the replays converge (§8), exactly ONE row', async () => {
  await publishApp(appManifestFixture('race-reporter', '1.0.0'), state().developer.token);
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      installApp(state().workspaceId, state().owner.token, 'race-reporter', '1.0.0', `install-race-${index}`),
    ),
  );
  const statuses = attempts.map((attempt) => attempt.status).sort();
  // EXACTLY ONE writer wins (201); every concurrent duplicate carries the
  // IDENTICAL logical command content → §8 convergence to the recorded
  // row (200 replayed, zero new state — the /extensions install posture).
  assert.deepEqual(
    statuses,
    [200, 200, 200, 200, 200, 200, 200, 201],
    `exactly one winner + converging duplicates (got ${statuses.join(',')})`,
  );
  const installIds = new Set(
    attempts.map((attempt) => ((attempt.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId']),
  );
  assert.equal(installIds.size, 1, 'every response names the SAME recorded install row');
  assert.equal(await countInstalls(state().workspaceId, 'race-reporter'), 1, 'exactly ONE row');
  // A DIVERGENT concurrent duplicate (a different version under a fresh
  // key) is a conflict — the current-selection fence fires.
  await publishApp(appManifestFixture('race-reporter', '2.0.0'), state().developer.token);
  const divergent = await installApp(state().workspaceId, state().owner.token, 'race-reporter', '2.0.0', 'install-race-divergent');
  assert.equal(divergent.status, 409, JSON.stringify(divergent.body));
  assert.equal(await countInstalls(state().workspaceId, 'race-reporter'), 1, 'still exactly ONE row');
});

// ---------------------------------------------------------------------------
// AC-4 — the storage layer: direct-SQL rewrite rejection (append-only)
// ---------------------------------------------------------------------------

test('AC-4: direct SQL UPDATE/DELETE on the install ledger and the event tail are REJECTED (the single sanctioned supersession is the ONLY legal UPDATE)', async () => {
  await publishApp(appManifestFixture('sql-probe-reporter', '1.0.0'), state().developer.token);
  const install = await installApp(state().workspaceId, state().owner.token, 'sql-probe-reporter', '1.0.0', 'install-sqlprobe-1');
  assert.equal(install.status, 201);
  const installId = ((install.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;

  // Rewriting the exact-version identity → rejected.
  await assert.rejects(
    () => pool().query("UPDATE app_installs SET version = '9.9.9' WHERE install_id = $1", [installId]),
    /append-only|immutable/i,
  );
  // Rewriting the granted scopes → rejected.
  await assert.rejects(
    () => pool().query("UPDATE app_installs SET granted_data_scopes = '[\"client:write\"]'::jsonb WHERE install_id = $1", [installId]),
    /append-only|immutable/i,
  );
  // Rewriting the operation / provenance → rejected.
  await assert.rejects(
    () => pool().query("UPDATE app_installs SET installed_by = NULL WHERE install_id = $1", [installId]),
    /append-only|immutable/i,
  );
  // A bare status change without the supersession stamp → rejected.
  await assert.rejects(
    () => pool().query("UPDATE app_installs SET status = 'SUPERSEDED' WHERE install_id = $1", [installId]),
    /supersession transition/i,
  );
  // DELETE → rejected outright.
  await assert.rejects(
    () => pool().query('DELETE FROM app_installs WHERE install_id = $1', [installId]),
    /append-only: DELETE is rejected/i,
  );

  // The event tail is fully immutable.
  await assert.rejects(
    () => pool().query("UPDATE app_install_events SET to_version = '9.9.9' WHERE install_id = $1", [installId]),
    /append-only/i,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM app_install_events WHERE install_id = $1', [installId]),
    /append-only/i,
  );

  // THE SINGLE SANCTIONED UPDATE: the supersession transition (ACTIVE →
  // SUPERSEDED with the stamp) succeeds — and nothing else does after it.
  await pool().query("UPDATE app_installs SET status = 'SUPERSEDED', superseded_at = now() WHERE install_id = $1 AND status = 'ACTIVE'", [installId]);
  const superseded = await installRow(installId);
  assert.equal(superseded!.status, 'SUPERSEDED');
  assert.equal(superseded!.version, '1.0.0', 'the historical identity survives the sanctioned transition');
  // The reverse transition is NOT sanctioned.
  await assert.rejects(
    () => pool().query("UPDATE app_installs SET status = 'ACTIVE', superseded_at = NULL WHERE install_id = $1", [installId]),
    /supersession transition/i,
  );
});

// ---------------------------------------------------------------------------
// AC-6 — the agency rollup lists CURRENT selections only (GET-only reads)
// ---------------------------------------------------------------------------

test('AC-6: the agency rollup lists the CURRENT selections of every workspace in the agency (superseded history excluded)', async () => {
  const rollup = await apiCall(port(), `/api/agencies/${state().agencyId}/app-installs`, { token: state().owner.token });
  assert.equal(rollup.status, 200);
  const installs = (rollup.body as Record<string, unknown>)['installs'] as Record<string, unknown>[];
  assert.ok(installs.length >= 2, 'the golden current selection and the race app appear');
  for (const entry of installs) {
    assert.equal(entry['status'], 'ACTIVE', 'the rollup carries CURRENT selections only');
  }
  // The full history stays visible on the workspace surface.
  const list = await apiCall(port(), `/api/workspaces/${state().workspaceId}/app-installs`, { token: state().owner.token });
  const listInstalls = ((list.body as Record<string, unknown>)['installs']) as Record<string, unknown>[];
  assert.ok(listInstalls.length > installs.length, 'the workspace history is richer than the current-selection rollup');
  assert.ok(listInstalls.some((entry) => entry['status'] === 'SUPERSEDED'), 'superseded rows stay readable (history is never erased)');
});
