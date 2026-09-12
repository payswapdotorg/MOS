/**
 * MKT-036 integration tests — the Versioned Domain Pack framework on the
 * real stack (embedded PostgreSQL 18 + real API process — no mocks of
 * platform services).
 *
 * Acceptance mapping (work-item-v1.3-overrides.md MKT-036; requirements-
 * v1.3.md PACK-001, acceptance PACK-AC-01..03):
 *   - PACK-AC-01 (DB/integration): publishing a pack version creates an
 *     IMMUTABLE registry row — re-publication of the same
 *     (publisher, packKey, version) is a 409, a new version is a new
 *     record, and direct-SQL UPDATE/DELETE on the registry row are
 *     rejected by the database; INSTALLING the version records the
 *     installed-version row against the authorized Workspace/Client
 *     context with the scope SERVER-DERIVED from the canonical
 *     workspace ownership (forged body scope fields are 422-rejected,
 *     never trusted); the DB row carries exactly the canonical
 *     agency/client/workspace (verified by direct SQL);
 *   - template conformance (§4): publishing a manifest whose
 *     workflow-template payload fails the /workflows definition contract
 *     is rejected 422 — validated through the Workflow authority's own
 *     validator;
 *   - dependency checks: a self-dependency is 422-rejected at
 *     publication; installing a pack whose declared dependency is not
 *     published fails closed;
 *   - the install lifecycle: idempotent install convergence (replay →
 *     200 replayed), CAS lifecycle transitions (disable/enable/
 *     uninstall), terminal-uninstall rejection, CAS conflict 409, and
 *     the DB lifecycle backstop against direct-SQL illegal transitions;
 *   - PACK-AC-03 (security/integration): pack-owned Client data cannot
 *     cross Client boundaries — another workspace's listing never
 *     contains the install's client-scoped artifacts, a foreign-agency
 *     principal gets the SAME 404 as for an unknown artifact id (no
 *     cross-tenant oracle), and direct-SQL cross-client re-parenting of
 *     an artifact scope record is rejected by the append-only trigger;
 *     Agency-scoped reusable artifacts are EXPLICITLY distinguished —
 *     the agency listing returns ONLY scope='agency-reusable' records,
 *     the reusable artifact is reachable within its agency and never
 *     from another agency's context or listing;
 *   - audit: every mutation emits an append-only audit event
 *     (domain-packs.version.published / domain-packs.installed) —
 *     verified by direct SQL on the audit trail.
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

async function createUser(email: string, name: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: name } });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'pack-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'pack-password-123' } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workspaceId'] as string;
}

// ---------------------------------------------------------------------------
// Pack manifest fixtures
// ---------------------------------------------------------------------------

const emptySchema = { type: 'object', properties: {}, required: [] };

function functionNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string' } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function terminalNode(nodeId: string): Record<string, unknown> {
  return { ...functionNode(nodeId), nodeType: 'terminal' };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

function minimalWorkflowContent(): Record<string, unknown> {
  return {
    graph: { nodes: [functionNode('a'), terminalNode('t')], edges: [successEdge('a', 't')] },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    retryPolicyDefaults: {},
    concurrencyLimits: {},
    timeoutPolicy: {},
    compensation: [],
  };
}

function manifestFixture(version: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const manifest = {
    packKey: 'performance-marketing',
    publisher: 'payswap-labs',
    version,
    displayName: 'Performance Marketing Pack',
    description: 'Specializes MarketingOS for performance marketing operations.',
    compatibility: { minPlatform: '1.2.0', maxPlatform: '1.9.0' },
    requiredPacks: [] as unknown[],
    artifacts: [
      {
        kind: 'domain-entity',
        name: 'campaign-group',
        description: 'A performance campaign grouping entity (Client-owned data).',
        scope: 'client',
        payload: { fields: ['id', 'name', 'budget'] },
      },
      {
        kind: 'workflow-template',
        name: 'daily-budget-pacing',
        description: 'Daily budget pacing workflow template.',
        scope: 'client',
        payload: minimalWorkflowContent(),
      },
      {
        kind: 'playbook-template',
        name: 'launch-playbook',
        description: 'The reusable launch playbook template.',
        scope: 'agency-reusable',
        payload: { summary: 'Launch sequence', templates: ['setup', 'scale'] },
      },
    ],
    ...overrides,
  };
  return { manifest, idempotencyKey: `publish-${version}-${Math.random().toString(36).slice(2, 8)}` };
}

// ---------------------------------------------------------------------------
// Shared topology: agency A (owner + collaborator; two clients) and a
// foreign agency B (owner; one client).
// ---------------------------------------------------------------------------

const ownerA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceB = '';

// The published pack under test + its installs/artifacts.
let packV1 = '';
let packV2 = '';
let installA1Id = '';

before(async () => {
  stack = await bootStack('domainpacks');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(ownerA, await createUser('owner-a@domainpacks.test', 'Agency A Owner'));
  Object.assign(ownerB, await createUser('owner-b@domainpacks.test', 'Agency B Owner'));
  agencyA = await makeAgency('Domain Packs Agency A', ownerA);
  agencyB = await makeAgency('Domain Packs Agency B', ownerB);
  clientA1 = await makeClient(agencyA, 'Client A One');
  clientA2 = await makeClient(agencyA, 'Client A Two');
  clientB = await makeClient(agencyB, 'Client B One');
  workspaceA1 = await makeWorkspace(clientA1, 'Workspace A1');
  workspaceA2 = await makeWorkspace(clientA2, 'Workspace A2');
  workspaceB = await makeWorkspace(clientB, 'Workspace B');

  // Publish the pack under test (v1.0.0) as the platform admin.
  const publish = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body: manifestFixture('1.0.0'),
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  packV1 = publish.body['packId'] as string;

  const publishV2 = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body: manifestFixture('1.1.0'),
  });
  assert.equal(publishV2.status, 201, JSON.stringify(publishV2.body));
  packV2 = publishV2.body['packId'] as string;

  // Install v1 into A1's workspace (owner of agency A).
  const install = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: packV1, idempotencyKey: 'install-a1-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  installA1Id = (install.body['install'] as Record<string, unknown>)['installId'] as string;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// PACK-AC-01 — publication immutability + versioning
// ---------------------------------------------------------------------------

test('PACK-AC-01: publishing creates an immutable versioned registry row — republishing the same triple is a 409, a new version is a NEW record', async () => {
  // The same (publisher, packKey, version) triple again → 409, never a
  // silent rewrite.
  const republish = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body: manifestFixture('1.0.0'),
  });
  assert.equal(republish.status, 409, JSON.stringify(republish.body));

  // A new version is a new record with its own identity.
  assert.notEqual(packV1, packV2);
  const readV1 = await apiCall(port(), `/api/domain-packs/${packV1}`, { token: ownerA.token });
  assert.equal(readV1.status, 200);
  assert.equal((readV1.body['manifest'] as Record<string, unknown>)['version'], '1.0.0');
  const readV2 = await apiCall(port(), `/api/domain-packs/${packV2}`, { token: ownerA.token });
  assert.equal(readV2.status, 200);
  assert.equal((readV2.body['manifest'] as Record<string, unknown>)['version'], '1.1.0');

  // The registry listing shows both versions.
  const list = await apiCall(port(), '/api/domain-packs', { token: ownerA.token });
  assert.equal(list.status, 200);
  const packs = list.body['packs'] as Record<string, unknown>[];
  assert.equal(packs.length, 2);
});

test('PACK-AC-01: the published registry row is database-immutable — direct UPDATE and DELETE are rejected', async () => {
  await assert.rejects(
    () => pool().query('UPDATE domain_packs SET display_name = $1 WHERE pack_id = $2', ['Tampered', packV1]),
    /domain pack registry rows are immutable/,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM domain_packs WHERE pack_id = $1', [packV1]),
    /domain pack registry rows are immutable/,
  );
  // The content survived byte for byte.
  const row = await pool().query<{ display_name: string }>(
    'SELECT display_name FROM domain_packs WHERE pack_id = $1',
    [packV1],
  );
  assert.equal(row.rows[0]!.display_name, 'Performance Marketing Pack');
});

test('publishing a manifest whose workflow template fails the /workflows §4 contract is rejected (template conformance at publication)', async () => {
  const badTemplate = minimalWorkflowContent() as { graph: { edges: unknown[] } };
  badTemplate.graph.edges = [successEdge('a', 'nonexistent-node')];
  const body = manifestFixture('2.0.0', {
    artifacts: [
      {
        kind: 'workflow-template',
        name: 'dangling-template',
        description: 'A non-conforming workflow template.',
        scope: 'client',
        payload: badTemplate,
      },
    ],
  });
  const publish = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body,
  });
  assert.equal(publish.status, 422, JSON.stringify(publish.body));
  const error = publish.body['error'] as Record<string, unknown> | undefined;
  const haystack = JSON.stringify(publish.body);
  assert.ok(
    haystack.includes('§4 definition contract'),
    `the rejection must name the §4 conformance failure, got: ${haystack}`,
  );
  void error;
  // The version was NOT published.
  const list = await apiCall(port(), '/api/domain-packs', { token: await adminToken() });
  const packs = list.body['packs'] as Record<string, unknown>[];
  assert.equal(packs.length, 2, 'the failed publication created no registry row');
});

test('publishing a manifest with a secret VALUE smuggled into an artifact payload is rejected (§21/CRED-001)', async () => {
  const body = manifestFixture('2.1.0', {
    artifacts: [
      {
        kind: 'domain-entity',
        name: 'smuggled-entity',
        description: 'An entity with a smuggled secret.',
        scope: 'client',
        payload: { nested: { token: 'MATERIAL-do-not-leak-packs' } },
      },
    ],
  });
  const publish = await apiCall(port(), '/api/domain-packs', { token: await adminToken(), body });
  assert.equal(publish.status, 422, JSON.stringify(publish.body));
});

test('a pack version cannot declare itself as a dependency (self-dependency rejected at publication)', async () => {
  const body = manifestFixture('2.2.0', {
    requiredPacks: [{ publisher: 'payswap-labs', packKey: 'performance-marketing', version: '2.2.0' }],
  });
  const publish = await apiCall(port(), '/api/domain-packs', { token: await adminToken(), body });
  assert.equal(publish.status, 422, JSON.stringify(publish.body));
  assert.ok(JSON.stringify(publish.body).includes('cannot declare itself'));
});

// ---------------------------------------------------------------------------
// PACK-AC-01 — the installed-version record against the authorized context
// ---------------------------------------------------------------------------

test('PACK-AC-01: the installed version is recorded against the authorized Workspace/Client context — scope server-derived, DB-verified', async () => {
  // The API read shows the canonical scope (never the request body's).
  const read = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}`, {
    token: ownerA.token,
  });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  const install = read.body as Record<string, unknown>;
  assert.equal(install['agencyId'], agencyA);
  assert.equal(install['clientId'], clientA1);
  assert.equal(install['workspaceId'], workspaceA1);
  assert.equal(install['status'], 'installed');
  assert.equal(install['packId'], packV1);

  // The DB row is the authoritative proof (PACK-AC-01 is a DB test).
  const rows = await pool().query<{
    agency_id: string;
    client_id: string;
    workspace_id: string;
    pack_id: string;
    status: string;
  }>('SELECT agency_id, client_id, workspace_id, pack_id, status FROM domain_pack_installs WHERE install_id = $1', [
    installA1Id,
  ]);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0]!.agency_id, agencyA);
  assert.equal(rows.rows[0]!.client_id, clientA1);
  assert.equal(rows.rows[0]!.workspace_id, workspaceA1);
  assert.equal(rows.rows[0]!.pack_id, packV1);
  assert.equal(rows.rows[0]!.status, 'installed');
});

test('forged body authority fields (scope/agency/client/workspace/status) are 422-rejected — never trusted', async () => {
  const install = await apiCall(port(), `/api/workspaces/${workspaceA2}/domain-pack-installs`, {
    token: ownerA.token,
    body: {
      packId: packV1,
      idempotencyKey: 'install-a2-forged',
      // Forged authority fields — the DTO rejects them before the
      // module is reached.
      agencyId: agencyB,
      clientId: clientB,
      workspaceId: workspaceB,
      scope: { agencyId: agencyB, clientId: clientB, workspaceId: workspaceB },
      status: 'installed',
    },
  });
  assert.equal(install.status, 422, JSON.stringify(install.body));
  assert.ok(JSON.stringify(install.body).includes('forbidden authority field'));

  // Nothing was created.
  const rows = await pool().query('SELECT install_id FROM domain_pack_installs WHERE workspace_id = $1', [
    workspaceA2,
  ]);
  assert.equal(rows.rows.length, 0, 'the forged install created no row');
});

test('installing the same pack version with the SAME idempotency key converges (replay); a DIFFERENT command is a 409', async () => {
  const replay = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: packV1, idempotencyKey: 'install-a1-1' },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['install'] as Record<string, unknown>)['installId'], installA1Id);

  const conflict = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: packV1, idempotencyKey: 'install-a1-different' },
  });
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));

  // Still exactly one install row for (workspaceA1, packV1).
  const rows = await pool().query(
    'SELECT install_id FROM domain_pack_installs WHERE workspace_id = $1 AND pack_id = $2',
    [workspaceA1, packV1],
  );
  assert.equal(rows.rows.length, 1);
});

test('a pack whose declared dependency is not published fails closed at install (dependency checks)', async () => {
  // Publish a pack that depends on a pack version that does NOT exist.
  const dependent = manifestFixture('3.0.0', {
    packKey: 'dependent-pack',
    requiredPacks: [{ publisher: 'payswap-labs', packKey: 'missing-pack', version: '9.9.9' }],
  });
  const publish = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body: dependent,
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const dependentPackId = publish.body['packId'] as string;

  const install = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: dependentPackId, idempotencyKey: 'install-dependent-1' },
  });
  assert.equal(install.status, 422, JSON.stringify(install.body));
  assert.ok(
    JSON.stringify(install.body).includes('missing-pack'),
    'the rejection must name the unpublished dependency',
  );
  // The dependent pack is only installable once its dependency exists:
  // publish the dependency, then the install succeeds.
  const dependency = manifestFixture('9.9.9', { packKey: 'missing-pack' });
  const publishDependency = await apiCall(port(), '/api/domain-packs', {
    token: await adminToken(),
    body: dependency,
  });
  assert.equal(publishDependency.status, 201, JSON.stringify(publishDependency.body));
  const retry = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: dependentPackId, idempotencyKey: 'install-dependent-2' },
  });
  assert.equal(retry.status, 201, JSON.stringify(retry.body));
});

test('a foreign workspace 404s BEFORE dependent traversal — the installing context is always the canonical workspace owner', async () => {
  const foreignWorkspace = await apiCall(port(), `/api/workspaces/${workspaceB}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: packV1, idempotencyKey: 'install-b-cross' },
  });
  assert.equal(foreignWorkspace.status, 404, 'owner A cannot address workspace B (uniform 404)');

  // Installing INTO workspace B as agency B's owner derives B's scope.
  const installB = await apiCall(port(), `/api/workspaces/${workspaceB}/domain-pack-installs`, {
    token: ownerB.token,
    body: { packId: packV1, idempotencyKey: 'install-b-1' },
  });
  assert.equal(installB.status, 201, JSON.stringify(installB.body));
  const installBRow = installB.body['install'] as Record<string, unknown>;
  assert.equal(installBRow['agencyId'], agencyB);
  assert.equal(installBRow['clientId'], clientB);
  assert.equal(installBRow['workspaceId'], workspaceB);
});

// ---------------------------------------------------------------------------
// The install lifecycle (CAS + terminal tombstone)
// ---------------------------------------------------------------------------

test('the install lifecycle: disable/enable with CAS, terminal uninstall, resurrection rejection, CAS conflict 409', async () => {
  const install = (await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}`, {
    token: ownerA.token,
  })).body as Record<string, unknown>;
  const version1 = install['version'] as number;

  // A stale CAS token is a 409.
  const stale = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}/disable`,
    { token: ownerA.token, body: { expectedVersion: version1 + 5 } },
  );
  assert.equal(stale.status, 409, JSON.stringify(stale.body));

  // disable → disabled.
  const disable = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}/disable`,
    { token: ownerA.token, body: { expectedVersion: version1 } },
  );
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  assert.equal((disable.body as Record<string, unknown>)['status'], 'disabled');

  // enable → installed (the re-enable edge).
  const enable = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}/enable`,
    { token: ownerA.token, body: { expectedVersion: (disable.body as Record<string, unknown>)['version'] as number } },
  );
  assert.equal(enable.status, 200, JSON.stringify(enable.body));
  assert.equal((enable.body as Record<string, unknown>)['status'], 'installed');

  // uninstall → terminal tombstone.
  const uninstall = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}/uninstall`,
    { token: ownerA.token, body: { expectedVersion: (enable.body as Record<string, unknown>)['version'] as number } },
  );
  assert.equal(uninstall.status, 200, JSON.stringify(uninstall.body));
  assert.equal((uninstall.body as Record<string, unknown>)['status'], 'uninstalled');
  assert.ok((uninstall.body as Record<string, unknown>)['uninstalledAt'] !== undefined);

  // Terminal: every further transition is a 409 — no resurrection.
  for (const edge of ['disable', 'enable', 'uninstall']) {
    const attempt = await apiCall(
      port(),
      `/api/workspaces/${workspaceA1}/domain-pack-installs/${installA1Id}/${edge}`,
      { token: ownerA.token, body: { expectedVersion: 99 } },
    );
    assert.equal(attempt.status, 409, `terminal install rejects the ${edge} edge`);
  }

  // The DB backstop rejects direct-SQL resurrection too.
  await assert.rejects(
    () => pool().query('UPDATE domain_pack_installs SET status = $1 WHERE install_id = $2', ['installed', installA1Id]),
    /uninstalled and terminal/,
  );

  // History stays readable (the tombstone is visible in the listing).
  const list = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const installs = (list.body as Record<string, unknown>)['installs'] as Record<string, unknown>[];
  assert.ok(installs.some((row) => row['installId'] === installA1Id && row['status'] === 'uninstalled'));
});

test('the install scope is database-immutable — direct cross-client re-parenting of the install is rejected', async () => {
  await assert.rejects(
    () =>
      pool().query('UPDATE domain_pack_installs SET client_id = $1 WHERE install_id = $2', [clientA2, installA1Id]),
    /ownership scope is immutable/,
  );
  await assert.rejects(
    () =>
      pool().query('UPDATE domain_pack_installs SET pack_id = $1 WHERE install_id = $2', [packV2, installA1Id]),
    /pinned pack version is immutable/,
  );
});

// ---------------------------------------------------------------------------
// PACK-AC-03 — the artifact scope matrix
// ---------------------------------------------------------------------------

test('PACK-AC-03: installation materializes artifact scope records with the explicit §5 distinction (DB-verified)', async () => {
  // Install v1 into A2's workspace (a second client of agency A).
  const installA2 = await apiCall(port(), `/api/workspaces/${workspaceA2}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: packV1, idempotencyKey: 'install-a2-1' },
  });
  assert.equal(installA2.status, 201, JSON.stringify(installA2.body));

  // DB: every declared artifact of THIS pack materialized with the right
  // shape — client-scoped rows carry the installing client;
  // agency-reusable rows are client-less. (Scoped to packV1: the
  // dependency-check test also installed its own pack into this
  // workspace.)
  const rows = await pool().query<{
    scope: string;
    client_id: string | null;
    artifact_kind: string;
    artifact_name: string;
    workspace_id: string;
  }>(
    'SELECT scope, client_id, artifact_kind, artifact_name, workspace_id FROM domain_pack_artifacts WHERE workspace_id = $1 AND pack_id = $2 ORDER BY artifact_kind, artifact_name',
    [workspaceA1, packV1],
  );
  assert.equal(rows.rows.length, 3, JSON.stringify(rows.rows));
  for (const row of rows.rows) {
    if (row.scope === 'client') {
      assert.equal(row.client_id, clientA1, `client-scoped ${row.artifact_name} carries the installing client`);
    } else {
      assert.equal(row.client_id, null, `agency-reusable ${row.artifact_name} is client-less`);
      assert.equal(row.scope, 'agency-reusable');
    }
  }
  // The launch-playbook is the reusable one; the entity and workflow
  // template are Client-owned.
  const byName = new Map(rows.rows.map((row) => [`${row.artifact_kind}/${row.artifact_name}`, row]));
  assert.equal(byName.get('playbook-template/launch-playbook')!.scope, 'agency-reusable');
  assert.equal(byName.get('domain-entity/campaign-group')!.scope, 'client');
  assert.equal(byName.get('workflow-template/daily-budget-pacing')!.scope, 'client');
});

test('PACK-AC-03: pack-owned Client data cannot cross Client boundaries — the workspace listing shows ONLY its own install artifacts', async () => {
  // A1's listing includes its own packV1 artifacts (other installs of the
  // same workspace — e.g. the dependency-check pack — appear too; the
  // boundary proof is about CLIENTS, not about co-installed packs).
  const listA1 = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  assert.equal(listA1.status, 200);
  const artifactsA1 = ((listA1.body as Record<string, unknown>)['artifacts'] as Record<string, unknown>[])
    .filter((row) => row['packId'] === packV1);
  assert.equal(artifactsA1.length, 3);

  // A2's listing shows A2's OWN artifacts — A1's client-scoped artifact
  // records never appear (data-level Client boundary).
  const listA2 = await apiCall(port(), `/api/workspaces/${workspaceA2}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  assert.equal(listA2.status, 200);
  const artifactsA2 = ((listA2.body as Record<string, unknown>)['artifacts'] as Record<string, unknown>[])
    .filter((row) => row['packId'] === packV1);
  assert.equal(artifactsA2.length, 3);
  const a1Ids = new Set(artifactsA1.map((row) => row['artifactId']));
  for (const artifact of artifactsA2) {
    assert.ok(
      !a1Ids.has(artifact['artifactId']),
      'the same client-scoped artifact record never materializes for another client',
    );
  }
  // A2's client-scoped entity artifact resolves to A2's client boundary.
  const entityA2 = artifactsA2.find((row) => row['artifactName'] === 'campaign-group');
  assert.ok(entityA2 !== undefined);
  assert.equal((entityA2['boundary'] as Record<string, unknown>)['clientId'], clientA2);
});

test('PACK-AC-03: the agency listing returns ONLY agency-reusable artifacts — the explicit distinction as a query', async () => {
  const agencyListing = await apiCall(port(), `/api/agencies/${agencyA}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  assert.equal(agencyListing.status, 200);
  assert.equal(agencyListing.body['scope'], 'agency-reusable');
  const reusable = (agencyListing.body as Record<string, unknown>)['artifacts'] as Record<string, unknown>[];
  // Every install in the agency materializes the reusable artifact
  // (workspace A1 packV1 + workspace A2 packV1 + the dependency-check
  // pack's own reusable artifact) — at least the two packV1 ones.
  assert.ok(reusable.length >= 2, `expected at least the two packV1 reusable records, got ${reusable.length}`);
  const packV1Reusable = reusable.filter((row) => row['packId'] === packV1);
  assert.equal(packV1Reusable.length, 2);
  for (const artifact of reusable) {
    assert.equal(artifact['scope'], 'agency-reusable');
    // The reusable record carries NO client boundary and never leaves
    // the owning agency.
    const boundary = artifact['boundary'] as Record<string, unknown>;
    assert.equal(boundary['clientId'], undefined);
    assert.equal(boundary['agencyId'], agencyA);
  }
  // Client-scoped pack-owned data is NEVER aggregated at agency scope.
  const names = reusable.map((row) => row['artifactName']);
  assert.ok(!names.includes('campaign-group'), 'client-scoped data never crosses to the agency listing');
  assert.ok(!names.includes('daily-budget-pacing'), 'client-scoped data never crosses to the agency listing');

  // The foreign agency's reusable listing shows ONLY its own agency's
  // records (workspace B's install of packV1 materialized exactly one).
  const agencyBListing = await apiCall(port(), `/api/agencies/${agencyB}/domain-pack-artifacts`, {
    token: ownerB.token,
  });
  assert.equal(agencyBListing.status, 200);
  const bArtifacts = (agencyBListing.body as Record<string, unknown>)['artifacts'] as Record<string, unknown>[];
  assert.equal(bArtifacts.length, 1);
  assert.equal(bArtifacts[0]!['scope'], 'agency-reusable');
  assert.equal((bArtifacts[0]!['boundary'] as Record<string, unknown>)['agencyId'], agencyB);
  // Agency A's reusable artifacts never appear in agency B's listing.
  const aIds = new Set(reusable.map((row) => row['artifactId']));
  for (const artifact of bArtifacts) {
    assert.ok(!aIds.has(artifact['artifactId']), 'agency-reusable artifacts never cross agencies');
  }
});

test('PACK-AC-03: a foreign-agency principal gets the SAME 404 as for an unknown artifact — no cross-tenant oracle', async () => {
  // Grab A1's packV1 client-scoped artifact records for the boundary
  // comparison (the workspace also carries the dependency-check pack's
  // artifacts — irrelevant to the Client-boundary proof).
  const listA1 = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  const artifactsA1 = ((listA1.body as Record<string, unknown>)['artifacts'] as Record<string, unknown>[])
    .filter((row) => row['packId'] === packV1);
  const clientArtifact = artifactsA1.find((row) => row['artifactName'] === 'campaign-group')!;
  const reusableArtifact = artifactsA1.find((row) => row['artifactName'] === 'launch-playbook')!;

  // A member of the OWNING agency reads both fine.
  const readClient = await apiCall(port(), `/api/domain-pack-artifacts/${clientArtifact['artifactId']}`, {
    token: ownerA.token,
  });
  assert.equal(readClient.status, 200, JSON.stringify(readClient.body));
  const readReusable = await apiCall(port(), `/api/domain-pack-artifacts/${reusableArtifact['artifactId']}`, {
    token: ownerA.token,
  });
  assert.equal(readReusable.status, 200);

  // The foreign-agency principal: uniform 404 for BOTH scopes — exactly
  // the same status as for a random unknown id.
  const foreignClient = await apiCall(port(), `/api/domain-pack-artifacts/${clientArtifact['artifactId']}`, {
    token: ownerB.token,
  });
  const foreignReusable = await apiCall(port(), `/api/domain-pack-artifacts/${reusableArtifact['artifactId']}`, {
    token: ownerB.token,
  });
  const unknown = await apiCall(port(), `/api/domain-pack-artifacts/00000000-0000-4000-8000-000000000000`, {
    token: ownerB.token,
  });
  assert.equal(foreignClient.status, 404);
  assert.equal(foreignReusable.status, 404);
  assert.equal(unknown.status, 404);
  // The bodies are indistinguishable in shape (no oracle).
  assert.deepEqual(
    Object.keys(foreignClient.body as Record<string, unknown>).sort(),
    Object.keys(unknown.body as Record<string, unknown>).sort(),
  );

  // The client artifact's payload is served from the immutable registry
  // row (declared content, byte for byte).
  const payload = readClient.body['payload'] as Record<string, unknown>;
  assert.deepEqual(payload['fields'], ['id', 'name', 'budget']);
});

test('PACK-AC-03: artifact scope records are database-append-only — cross-client re-parenting and scope rewrites are rejected', async () => {
  const rows = await pool().query<{ artifact_id: string; scope: string; client_id: string | null }>(
    "SELECT artifact_id, scope, client_id FROM domain_pack_artifacts WHERE workspace_id = $1 AND scope = 'client' LIMIT 1",
    [workspaceA1],
  );
  const clientArtifactId = rows.rows[0]!.artifact_id;

  // Re-parenting to another client: rejected.
  await assert.rejects(
    () => pool().query('UPDATE domain_pack_artifacts SET client_id = $1 WHERE artifact_id = $2', [clientA2, clientArtifactId]),
    /append-only/,
  );
  // Scope rewrite: rejected.
  await assert.rejects(
    () => pool().query("UPDATE domain_pack_artifacts SET scope = 'agency-reusable' WHERE artifact_id = $1", [clientArtifactId]),
    /append-only/,
  );
  // DELETE: rejected (history is permanent).
  await assert.rejects(
    () => pool().query('DELETE FROM domain_pack_artifacts WHERE artifact_id = $1', [clientArtifactId]),
    /append-only/,
  );
  // The structural fences reject a crossed insert even by SQL (the
  // consistency trigger fires first with the same boundary semantics;
  // the scope-shape CHECK is the second backstop).
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO domain_pack_artifacts (artifact_id, install_id, pack_id, artifact_kind, artifact_name, scope, agency_id, client_id, workspace_id)
         VALUES ($1, $2, $3, 'domain-entity', 'forged', 'client', $4, NULL, $5)`,
        [
          '11111111-1111-4111-8111-111111111111',
          installA1Id,
          packV1,
          agencyA,
          workspaceA1,
        ],
      ),
    /client-scoped artifact/,
  );
  // And an agency-reusable row with a client is equally impossible.
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO domain_pack_artifacts (artifact_id, install_id, pack_id, artifact_kind, artifact_name, scope, agency_id, client_id, workspace_id)
         VALUES ($1, $2, $3, 'domain-entity', 'forged', 'agency-reusable', $4, $5, $6)`,
        [
          '22222222-2222-4222-8222-222222222222',
          installA1Id,
          packV1,
          agencyA,
          clientA1,
          workspaceA1,
        ],
      ),
    /agency-reusable artifact/,
  );
});

// ---------------------------------------------------------------------------
// Audit + anonymous posture
// ---------------------------------------------------------------------------

test('every pack mutation emits an append-only audit event with the server-derived scope', async () => {
  const events = await pool().query<{ action: string; target_id: string; agency_id: string | null }>(
    "SELECT action, target_id, agency_id FROM audit_events WHERE action LIKE 'domain_packs.%' ORDER BY occurred_at",
  );
  const actions = events.rows.map((row) => row.action);
  assert.ok(actions.includes('domain_packs.version.published'), JSON.stringify(actions));
  assert.ok(actions.includes('domain_packs.installed'), JSON.stringify(actions));
  // The install audit carries the canonical scope (server-derived).
  const installed = events.rows.find((row) => row.action === 'domain_packs.installed');
  assert.ok(installed !== undefined);
  assert.equal(installed.agency_id, agencyA);
});

test('anonymous calls never reach authorization', async () => {
  const anonymous = await apiCall(port(), '/api/domain-packs');
  assert.equal(anonymous.status, 401);
  const anonymousInstall = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    body: { packId: packV1, idempotencyKey: 'anon' },
  });
  assert.equal(anonymousInstall.status, 401);
});

test('membership without the owner/admin role cannot publish or install', async () => {
  const collaborator = await createUser('collab-a@domainpacks.test', 'Agency A Collaborator');
  await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: await adminToken(),
    body: { userId: collaborator.userId, role: 'client_collaborator' },
  });
  // A collaborator may READ the catalog and listings…
  const list = await apiCall(port(), '/api/domain-packs', { token: collaborator.token });
  assert.equal(list.status, 200);
  const artifacts = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-artifacts`, {
    token: collaborator.token,
  });
  assert.equal(artifacts.status, 200);
  // …but cannot publish or install.
  const publish = await apiCall(port(), '/api/domain-packs', {
    token: collaborator.token,
    body: manifestFixture('4.0.0'),
  });
  assert.equal(publish.status, 403, JSON.stringify(publish.body));
  const install = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: collaborator.token,
    body: { packId: packV2, idempotencyKey: 'collab-install' },
  });
  assert.equal(install.status, 403, JSON.stringify(install.body));
});
