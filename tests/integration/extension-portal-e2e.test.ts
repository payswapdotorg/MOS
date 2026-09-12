/**
 * MKT-032 integration test — THE EXTENSION DEVELOPER PORTAL LIFECYCLE
 * END-TO-END on the real stack (embedded PostgreSQL 18 + real API
 * subprocess — no mocks of platform services).
 *
 * Acceptance mapping (work-items.md MKT-032 = UI-003 "Provide Extension
 * Developer/installation surfaces", acceptance "extension lifecycle E2E"):
 *
 * THE GOLDEN LOOP (the full lifecycle through the surface + authority,
 * asserting at EVERY step that the AUTHORITATIVE state — the extensions
 * tables — matches what the surface reports):
 *
 *   register (publish v1 through the DEVELOPER surface, the frozen
 *   platform_developer role) → permission review (the agency-scoped
 *   reviewer action: a delegated /policies declaration) → install v1 →
 *   configure v1 (config contract + CRED-001 secret binding) → authorize
 *   v1 → the TESTING hook (the authority's invocation path: the
 *   short-lived context recorded in the append-only ledger) → submit
 *   version (publish v2) → permission review of v2 (the MERGE preserves
 *   v1's approval) → UPGRADE (install v2 alongside; the version-management
 *   view reports both pins) → disable v1 → uninstall v1 (terminal
 *   tombstone) → uninstall v2 (the installed→uninstalled edge).
 *
 * NEGATIVE TESTS (permission-gate enforcement, lifecycle forgery
 * rejection, cross-scope rejection — the security evidence):
 *   - PERMISSION-BYPASS: installing a version whose required permissions
 *     were NOT approved fails at the AUTHORITY (403 POLICY_DENIED from
 *     inside installExtension — the workspace OWNER, fully authorized to
 *     install, is still denied: the surface cannot work around the gate
 *     because every install path IS the authority's gate); the upgrade
 *     operation equally fails on an unapproved target; a REJECTED version
 *     is denied even while other versions of the same extension are
 *     approved (deny-overrides at the authority);
 *   - UNAUTHORIZED REVIEWER: an agency operator (non owner/admin) is 403
 *     on the reviewer action; a non-platform-admin is 403 on the
 *     platform-scoped review; a foreign agency owner is 403 on another
 *     agency's review route;
 *   - CROSS-CLIENT INSTALLATION: a foreign agency's owner installing into
 *     another agency's workspace is the uniform 404 (no install row
 *     written); the review view is equally the uniform 404 for the
 *     foreign caller;
 *   - FORGED LIFECYCLE TRANSITIONS: caller-supplied authority fields
 *     (status/scope/identity) are rejected 422 by the DTO contracts;
 *     illegal lifecycle edges (installed → authorized, installed →
 *     disabled, terminal uninstall → anything) are the authority's 409;
 *   - RE-REVIEW CONVERGENCE: rejecting then approving the same version
 *     replaces exactly that version's rule (the review history is
 *     append-oriented: superseded policy versions stay queryable).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SECRET_HANDLE = 'extension-portal-provider-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-portal-3f7d2e1c';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('extension-portal');
  fs.writeFileSync(path.join(stack.env.secretsDir, `${SECRET_HANDLE}.secret`), SECRET_MATERIAL, { mode: 0o600 });
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

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

async function makePrincipal(email: string): Promise<Principal> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string, agencyId };
}

/** A user with NO agency and NO platform role (identity only). */
async function makeBareUser(email: string): Promise<{ userId: string; token: string }> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['workspaceId'] as string;
}

/** The shared §2 manifest fixture (one immutable published version). */
function manifestFixture(extensionKey: string, version: string): Record<string, unknown> {
  return {
    manifest: {
      extensionKey,
      publisher: 'payswap-labs',
      version,
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [
        { category: 'data-source', name: 'enrich-audience' },
        { category: 'research-discovery', name: 'discover-lookalikes' },
      ],
      permissions: [
        { action: 'data:read' },
        { action: 'secret:use' },
      ],
      requiredSecretNames: ['DATA_PROVIDER_KEY'],
      dataScopes: ['client:read', 'client:write', 'workspace:read'],
      networkRequirements: [],
      runtimeClass: 'pooled-worker',
      inputContract: { required: ['audienceId'] },
      outputContract: { required: ['enrichedCount'] },
      eventSubscriptions: [],
      uiSurfaces: [],
      configContract: {
        region: {
          type: 'string',
          required: true,
          description: 'The enrichment region',
          pattern: '^(eu|us)$',
        },
      },
    },
    idempotencyKey: `register-${extensionKey}-${version}`,
  };
}

async function publishVersion(extensionKey: string, version: string, token: string): Promise<string> {
  const publish = await apiCall(port(), '/api/extension-portal/versions', {
    token,
    body: manifestFixture(extensionKey, version),
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  return publish.body['extensionId'] as string;
}

async function makeExtensionExecution(workspaceId: string, token: string, ref: string): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      externalRequestRef: ref,
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `portal-exec-${ref}`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

// Shared state built in order (tests run sequentially in file order).
interface SharedState {
  developer: { userId: string; token: string };
  ownerA: Principal;
  ownerB: Principal;
  operatorA: { userId: string; token: string };
  clientA: string;
  workspaceA: string;
  clientB: string;
  workspaceB: string;
  extensionV1Id: string;
  extensionV2Id: string;
  extensionV3Id: string;
  installV1Id: string;
  installV2Id: string;
  executionA: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared state not built');
  return shared;
}

function errorCode(body: Record<string, unknown>): string {
  return ((body['error'] as Record<string, unknown> | undefined)?.['code'] as string | undefined) ?? '';
}

// ---------------------------------------------------------------------------
// THE DEVELOPER SURFACE — publication (register)
// ---------------------------------------------------------------------------

test('DEVELOPER: publish v1 through the frozen platform_developer role; the registry row is authoritative and immutable', async () => {
  // The platform developer: a user granted the frozen platform_developer
  // role ("Platform Developer/Extension Publisher — wired by later
  // extension Work Items": THIS Work Item wires it).
  const admin = await adminToken();
  const dev = await makeBareUser('portal-developer@marketingos.test');
  const grant = await apiCall(port(), `/api/users/${dev.userId}/platform-roles`, {
    token: admin,
    body: { role: 'platform_developer' },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  const ownerA = await makePrincipal('portal-owner-a@marketingos.test');
  const ownerB = await makePrincipal('portal-owner-b@marketingos.test');
  const clientA = await makeClient(ownerA.agencyId, ownerA.token);
  const workspaceA = await makeWorkspace(clientA, ownerA.token, 'Portal Workspace A');
  const clientB = await makeClient(ownerB.agencyId, ownerB.token);
  const workspaceB = await makeWorkspace(clientB, ownerB.token, 'Portal Workspace B');

  const extensionV1Id = await publishVersion('audience-enricher', '1.0.0', dev.token);

  // AUTHORITATIVE state: the extensions registry row exists and carries
  // the immutable manifest content.
  const stored = await the().stack.pg.pool.query<{
    extension_key: string;
    publisher: string;
    version: string;
    create_fingerprint: string;
  }>(
    'SELECT extension_key, publisher, version, create_fingerprint FROM extensions WHERE extension_id = $1',
    [extensionV1Id],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.extension_key, 'audience-enricher');
  assert.equal(stored.rows[0]!.publisher, 'payswap-labs');
  assert.equal(stored.rows[0]!.version, '1.0.0');
  assert.ok(stored.rows[0]!.create_fingerprint.length > 0);

  // The surface reports exactly the authoritative row.
  const read = await apiCall(port(), `/api/extension-portal/versions/${extensionV1Id}`, {
    token: ownerA.token,
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['extensionId'], extensionV1Id);
  const manifest = (read.body as Record<string, unknown>)['manifest'] as Record<string, unknown>;
  assert.equal(manifest['extensionKey'], 'audience-enricher');
  assert.deepEqual(manifest['compatibility'], { minPlatform: '1.0.0', maxPlatform: '2.0.0' });

  shared = {
    developer: { userId: dev.userId, token: dev.token },
    ownerA,
    ownerB,
    operatorA: { userId: '', token: '' },
    clientA,
    workspaceA,
    clientB,
    workspaceB,
    extensionV1Id,
    extensionV2Id: '',
    extensionV3Id: '',
    installV1Id: '',
    installV2Id: '',
    executionA: '',
  };
});

test('DEVELOPER: version history + compatibility records + catalog report the authoritative registry; re-registration is the authority 409', async () => {
  const { developer, ownerA, extensionV1Id } = state();

  const history = await apiCall(port(), '/api/extension-portal/extensions/audience-enricher/versions', {
    token: ownerA.token,
  });
  assert.equal(history.status, 200);
  const versions = (history.body as Record<string, unknown>)['versions'] as Record<string, unknown>[];
  assert.equal(versions.length, 1);
  assert.equal(versions[0]!['extensionId'], extensionV1Id);
  assert.equal(versions[0]!['version'], '1.0.0');
  assert.deepEqual(versions[0]!['compatibility'], { minPlatform: '1.0.0', maxPlatform: '2.0.0' });

  const catalog = await apiCall(port(), '/api/extension-portal/catalog', { token: ownerA.token });
  assert.equal(catalog.status, 200);
  const entries = (catalog.body as Record<string, unknown>)['extensions'] as Record<string, unknown>[];
  const entry = entries.find((candidate) => candidate['extensionKey'] === 'audience-enricher');
  assert.ok(entry !== undefined, 'the catalog lists the published extension');
  assert.equal(entry['versionCount'], 1);
  assert.equal(entry['newestVersion'], '1.0.0');
  assert.deepEqual(entry['permissionActions'], ['data:read', 'secret:use']);

  // The immutable-version fence (the AUTHORITY): re-registering the same
  // (publisher, key, version) is a 409, never a rewrite.
  const reRegister = await apiCall(port(), '/api/extension-portal/versions', {
    token: developer.token,
    body: manifestFixture('audience-enricher', '1.0.0'),
  });
  assert.equal(reRegister.status, 409, JSON.stringify(reRegister.body));
});

test('DEVELOPER: an agency owner WITHOUT the developer role cannot publish through the portal (403)', async () => {
  const { ownerA } = state();
  const denied = await apiCall(port(), '/api/extension-portal/versions', {
    token: ownerA.token,
    body: manifestFixture('rogue-extension', '1.0.0'),
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

// ---------------------------------------------------------------------------
// THE PERMISSION REVIEW SURFACE — claims, the fail-closed gate, the action
// ---------------------------------------------------------------------------

test('PERMISSION REVIEW: the view shows the frozen claims with NO approval; installing an unapproved version fails at the AUTHORITY', async () => {
  const { ownerA, workspaceA, extensionV1Id } = state();

  const view = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/versions/${extensionV1Id}/permission-review`,
    { token: ownerA.token },
  );
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const body = view.body as Record<string, unknown>;
  // The FROZEN permission claims under review.
  const claims = body['permissionClaims'] as Record<string, unknown>;
  assert.deepEqual(claims['permissionActions'], ['data:read', 'secret:use']);
  assert.deepEqual(claims['requiredSecretNames'], ['DATA_PROVIDER_KEY']);
  assert.deepEqual(claims['dataScopes'], ['client:read', 'client:write', 'workspace:read']);
  // No approval anywhere in the scope chain.
  const approval = body['approvalState'] as Record<string, Record<string, unknown>>;
  assert.equal(approval['agency']!['declared'], false);
  assert.equal(approval['client']!['declared'], false);
  // The platform policy is honestly marked admin-restricted for a
  // non-admin caller (the platform security-configuration surface).
  assert.equal(approval['platform']!['declared'], null);
  assert.ok(String(approval['platform']!['visibility']).includes('platform-administrator-only'));
  // The surface never derives a verdict of its own.
  assert.ok(String(body['evaluationNote']).includes('recorded decisions only'));

  // PERMISSION-BYPASS REJECTED: the workspace OWNER (fully authorized to
  // install) installs an UNREVIEWED version → the AUTHORITY's fail-closed
  // extension policy gate denies (403 POLICY_DENIED from INSIDE
  // installExtension — the surface cannot work around it).
  const denied = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV1Id,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'portal-install-unreviewed-1',
    },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorCode(denied.body), 'POLICY_DENIED');

  // ZERO partial writes: no install row exists.
  const installs = await the().stack.pg.pool.query(
    'SELECT install_id FROM extension_installs WHERE extension_id = $1',
    [extensionV1Id],
  );
  assert.equal(installs.rows.length, 0);
});

test('PERMISSION REVIEW: an unauthorized reviewer (agency operator) is rejected (403)', async () => {
  const { ownerA, extensionV1Id } = state();
  // Add an agency_operator member to agency A (an active member, but NOT
  // an owner/admin — reviewers are owner|admin|platform admin).
  const operator = await makeBareUser('portal-operator-a@marketingos.test');
  const add = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: ownerA.token,
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  assert.equal(add.status, 201, JSON.stringify(add.body));
  state().operatorA = { userId: operator.userId, token: operator.token };

  const denied = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV1Id}/permission-review`,
    {
      token: operator.token,
      body: { decision: 'approve', reason: 'operator should not be able to review' },
    },
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
});

test('PERMISSION REVIEW: the agency owner APPROVES — the delegated /policies declaration carries the version-scoped allow rule', async () => {
  const { ownerA, workspaceA, extensionV1Id } = state();

  const review = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV1Id}/permission-review`,
    {
      token: ownerA.token,
      body: { decision: 'approve', reason: 'least-privilege claims reviewed and accepted' },
    },
  );
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const reviewBody = review.body as Record<string, unknown>;
  assert.equal((reviewBody['review'] as Record<string, unknown>)['scopeKind'], 'agency');
  assert.ok(String(reviewBody['enforcement']).includes('fail-closed'));

  // AUTHORITATIVE state: the /policies registry holds the active
  // extension-dimension version with EXACTLY the version-scoped rule.
  const policy = reviewBody['policy'] as Record<string, unknown>;
  const rules = policy['rules'] as Record<string, unknown>[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!['effect'], 'allow');
  assert.deepEqual(rules[0]!['operations'], ['install', 'invoke']);
  assert.equal(rules[0]!['resource'], 'audience-enricher');
  const attributes = rules[0]!['attributes'] as Record<string, string>;
  assert.equal(attributes['extensionId'], extensionV1Id);
  assert.equal(attributes['version'], '1.0.0');

  const activePolicy = await the().stack.pg.pool.query<{ rules: Record<string, unknown>[]; status: string }>(
    "SELECT rules, status FROM policies WHERE dimension = 'extension' AND agency_id = $1 AND client_id IS NULL ORDER BY version_seq DESC LIMIT 1",
    [ownerA.agencyId],
  );
  assert.equal(activePolicy.rows.length, 1);
  assert.equal(activePolicy.rows[0]!.status, 'active');

  // The review view now shows the approval + the referencing rule.
  const view = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/versions/${extensionV1Id}/permission-review`,
    { token: ownerA.token },
  );
  assert.equal(view.status, 200);
  const approval = ((view.body as Record<string, unknown>)['approvalState'] as Record<string, Record<string, unknown>>)['agency']!;
  assert.equal(approval['declared'], true);
  assert.deepEqual(approval['rulesReferencingThisVersion'], [0]);
  const history = (view.body as Record<string, unknown>)['reviewHistory'] as unknown[];
  assert.equal(history.length, 1, 'the append-oriented review history keeps the declaration');

  // RE-REVIEW CONVERGENCE: approving the same version again supersedes the
  // policy version but replaces ONLY this version's rule (still exactly 1
  // rule — the merge never duplicates).
  const reReview = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV1Id}/permission-review`,
    {
      token: ownerA.token,
      body: { decision: 'approve', reason: 're-confirmed after claim re-check' },
    },
  );
  assert.equal(reReview.status, 201, JSON.stringify(reReview.body));
  const reRules = ((reReview.body as Record<string, unknown>)['policy'] as Record<string, unknown>)['rules'] as unknown[];
  assert.equal(reRules.length, 1);
});

// ---------------------------------------------------------------------------
// THE INSTALLATION SURFACE — install → configure → authorize
// ---------------------------------------------------------------------------

test('INSTALL: the reviewed version installs through the surface; the authority state matches exactly', async () => {
  const { ownerA, clientA, workspaceA, extensionV1Id } = state();

  const install = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV1Id,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'portal-install-v1',
    },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const record = (install.body as Record<string, unknown>)['install'] as Record<string, unknown>;
  assert.equal(record['status'], 'installed');
  assert.equal(record['agencyId'], ownerA.agencyId);
  assert.equal(record['clientId'], clientA);
  assert.equal(record['workspaceId'], workspaceA);
  assert.deepEqual(record['grantedScopes'], ['client:read', 'workspace:read']);
  state().installV1Id = record['installId'] as string;

  // AUTHORITATIVE state: the extension_installs row matches the surface.
  const row = await the().stack.pg.pool.query<{
    status: string;
    agency_id: string;
    client_id: string;
    workspace_id: string;
    granted_scopes: string[];
    version: number;
  }>(
    'SELECT status, agency_id, client_id, workspace_id, granted_scopes, version FROM extension_installs WHERE install_id = $1',
    [state().installV1Id],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!.status, 'installed');
  assert.equal(row.rows[0]!.agency_id, ownerA.agencyId);
  assert.equal(row.rows[0]!.client_id, clientA);
  assert.equal(row.rows[0]!.workspace_id, workspaceA);
  assert.deepEqual(row.rows[0]!.granted_scopes, ['client:read', 'workspace:read']);
  assert.equal(Number(row.rows[0]!.version), 1);

  // The surface listing reports the same install.
  const list = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const installs = (list.body as Record<string, unknown>)['installs'] as Record<string, unknown>[];
  assert.ok(installs.some((candidate) => candidate['installId'] === state().installV1Id));
});

test('INSTALL: cross-client installation is the uniform 404 (no row, no oracle)', async () => {
  const { ownerB, workspaceA, extensionV1Id } = state();
  const foreign = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerB.token,
    body: {
      extensionId: extensionV1Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'portal-install-foreign-1',
    },
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const installs = await the().stack.pg.pool.query(
    'SELECT install_id FROM extension_installs WHERE extension_id = $1',
    [extensionV1Id],
  );
  assert.equal(installs.rows.length, 1, 'exactly the legitimate install exists');
});

test('INSTALL: caller-forged authority fields are rejected by the DTO (422)', async () => {
  const { ownerA, workspaceA, extensionV1Id } = state();
  const forged = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV1Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'portal-install-forge-1',
      status: 'authorized',
      agencyId: '00000000-0000-0000-0000-000000000001',
    },
  });
  assert.equal(forged.status, 422, JSON.stringify(forged.body));
  assert.ok(JSON.stringify(forged.body).includes('forbidden authority field'));
});

test('LIFECYCLE: forged transitions rejected — installed→authorized is the authority 409; a forged status field is the DTO 422', async () => {
  const { ownerA, workspaceA, installV1Id } = state();
  // installed → authorized is NOT a frozen edge (installed must configure
  // first): the AUTHORITY's transition guard rejects with 409.
  const earlyAuthorize = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/authorize`,
    { token: ownerA.token, body: { expectedVersion: 1 } },
  );
  assert.equal(earlyAuthorize.status, 409, JSON.stringify(earlyAuthorize.body));
  // installed → disabled is equally illegal.
  const earlyDisable = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/disable`,
    { token: ownerA.token, body: { expectedVersion: 1 } },
  );
  assert.equal(earlyDisable.status, 409, JSON.stringify(earlyDisable.body));
  // A caller-supplied status field never reaches the authority (DTO 422).
  const forged = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/authorize`,
    { token: ownerA.token, body: { expectedVersion: 1, status: 'authorized', policyDecisionId: 'forged' } },
  );
  assert.equal(forged.status, 422, JSON.stringify(forged.body));
});

test('CONFIGURE: the manifest config contract + the CRED-001 secret binding (logical name → credential REFERENCE)', async () => {
  const { ownerA, workspaceA, installV1Id } = state();

  // Pattern violation → 422 (the authority's config-contract validation).
  const badRegion = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/configure`,
    { token: ownerA.token, body: { config: { region: 'mars' }, secretBindings: {}, expectedVersion: 1 } },
  );
  assert.equal(badRegion.status, 422, JSON.stringify(badRegion.body));

  // The credential reference is created through the /credentials authority.
  const credential = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/credentials`, {
    token: ownerA.token,
    body: { kind: 'integration_api_key', label: 'portal provider key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const credentialId = credential.body['credentialId'] as string;

  const configure = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/configure`,
    {
      token: ownerA.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { DATA_PROVIDER_KEY: credentialId },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  assert.equal((configure.body as Record<string, unknown>)['status'], 'configured');

  // AUTHORITATIVE state: the row stores the config and the REFERENCE only.
  const row = await the().stack.pg.pool.query<{
    status: string;
    config: Record<string, unknown>;
    secret_bindings: Record<string, string>;
  }>(
    'SELECT status, config, secret_bindings FROM extension_installs WHERE install_id = $1',
    [installV1Id],
  );
  assert.equal(row.rows[0]!.status, 'configured');
  assert.deepEqual(row.rows[0]!.config, { region: 'eu' });
  assert.deepEqual(row.rows[0]!.secret_bindings, { DATA_PROVIDER_KEY: credentialId });
  // NEVER material anywhere.
  assert.ok(!JSON.stringify(row.rows[0]!).includes(SECRET_MATERIAL));
});

test('AUTHORIZE: the authorize (enable) edge; the authority state matches', async () => {
  const { ownerA, workspaceA, installV1Id } = state();
  const authorize = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/authorize`,
    { token: ownerA.token, body: { expectedVersion: 2 } },
  );
  assert.equal(authorize.status, 200, JSON.stringify(authorize.body));
  assert.equal((authorize.body as Record<string, unknown>)['status'], 'authorized');
  const row = await the().stack.pg.pool.query<{ status: string }>(
    'SELECT status FROM extension_installs WHERE install_id = $1',
    [installV1Id],
  );
  assert.equal(row.rows[0]!.status, 'authorized');
});

// ---------------------------------------------------------------------------
// THE TESTING HOOK — the authority's invocation path through the surface
// ---------------------------------------------------------------------------

test('TESTING HOOK: the short-lived invocation context derives from the execution canonical owner and lands in the append-only ledger', async () => {
  const { ownerA, clientA, workspaceA, extensionV1Id, installV1Id } = state();
  const execution = await makeExtensionExecution(workspaceA, ownerA.token, 'portal-test-run-1');
  state().executionA = execution;

  const testInvoke = await apiCall(
    port(),
    `/api/extension-portal/executions/${execution}/extensions/${extensionV1Id}/test`,
    {
      token: ownerA.token,
      body: {
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-portal-1', note: 'portal test invocation' },
      },
    },
  );
  assert.equal(testInvoke.status, 201, JSON.stringify(testInvoke.body));
  const context = testInvoke.body as Record<string, unknown>;

  // The scope is SERVER-DERIVED from the execution's canonical owner.
  const scope = context['scope'] as Record<string, string>;
  assert.equal(scope['kind'], 'extension-invocation');
  assert.equal(scope['agencyId'], ownerA.agencyId);
  assert.equal(scope['clientId'], clientA);
  assert.equal(scope['workspaceId'], workspaceA);

  // The granted capability set + data scopes are bounded by the manifest
  // and the install grant.
  assert.deepEqual(context['grantedCapabilities'], [{ category: 'data-source', name: 'enrich-audience' }]);
  assert.deepEqual(context['grantedDataScopes'], ['client:read', 'workspace:read']);
  assert.equal(context['installId'], installV1Id);
  assert.ok(typeof context['policyDecisionId'] === 'string' && (context['policyDecisionId'] as string).length > 0);
  assert.ok(Date.parse(context['expiresAt'] as string) > Date.parse(context['issuedAt'] as string));
  assert.equal(context['expired'], false);
  // The test hook is honestly labeled a delegated authority path.
  assert.ok(String(context['testingHook']).includes('delegated'));
  // The context carries NO credential-shaped field.
  for (const forbidden of ['secret', 'secretHandle', 'material', 'token', 'apiKey']) {
    assert.ok(!(forbidden in context), `the context must not carry '${forbidden}'`);
  }

  // AUTHORITATIVE state: the append-only invocation ledger row.
  const ledger = await the().stack.pg.pool.query<{
    policy_outcome: string;
    execution_id: string;
    workspace_id: string;
    install_id: string;
  }>(
    'SELECT policy_outcome, execution_id, workspace_id, install_id FROM extension_invocations WHERE invocation_id = $1',
    [context['invocationId'] as string],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]!.policy_outcome, 'allow');
  assert.equal(ledger.rows[0]!.execution_id, execution);
  assert.equal(ledger.rows[0]!.workspace_id, workspaceA);
  assert.equal(ledger.rows[0]!.install_id, installV1Id);

  // The review view's recordedDecisions now includes the AUTHORITATIVE
  // evaluated outcomes (allow from the install gate + allow from the
  // invoke gate).
  const view = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/versions/${extensionV1Id}/permission-review`,
    { token: ownerA.token },
  );
  assert.equal(view.status, 200);
  const decisions = (view.body as Record<string, unknown>)['recordedDecisions'] as Record<string, unknown>[];
  assert.ok(decisions.length >= 2, 'the install + invoke gate decisions are recorded');
  assert.ok(decisions.every((decision) => decision['dimension'] === 'extension'));
  assert.ok(decisions.some((decision) => (decision['action'] as Record<string, unknown>)['resource'] === 'audience-enricher'));
});

test('TESTING HOOK: authority-shaped input keys are rejected (422); a foreign workspace caller is the uniform 404', async () => {
  const { ownerA, ownerB, extensionV1Id, executionA } = state();
  const smuggled = await apiCall(
    port(),
    `/api/extension-portal/executions/${executionA}/extensions/${extensionV1Id}/test`,
    {
      token: ownerA.token,
      body: {
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-x', scope: { agencyId: '00000000-0000-0000-0000-000000000001' } },
      },
    },
  );
  assert.equal(smuggled.status, 422, JSON.stringify(smuggled.body));

  // The foreign caller (agency B) cannot even resolve the execution: the
  // uniform 404 (no cross-tenant oracle).
  const foreign = await apiCall(
    port(),
    `/api/extension-portal/executions/${executionA}/extensions/${extensionV1Id}/test`,
    {
      token: ownerB.token,
      body: { requestedCapabilities: ['enrich-audience'], input: { audienceId: 'aud-x' } },
    },
  );
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
});

// ---------------------------------------------------------------------------
// UPGRADE — submit version (publish v2) → review → install alongside →
// disable → uninstall (the work order's upgrade segment)
// ---------------------------------------------------------------------------

test('UPGRADE: publish v2; the upgrade of an UNREVIEWED target fails at the AUTHORITY (no bypass through the upgrade path)', async () => {
  const { developer, ownerA, workspaceA, extensionV1Id } = state();

  // Submit version: publish 2.0.0 through the DEVELOPER surface.
  const extensionV2Id = await publishVersion('audience-enricher', '2.0.0', developer.token);
  state().extensionV2Id = extensionV2Id;
  assert.notEqual(extensionV2Id, extensionV1Id, 'a new version is a NEW registry row');

  // The version history now reports both, newest first.
  const history = await apiCall(port(), '/api/extension-portal/extensions/audience-enricher/versions', {
    token: ownerA.token,
  });
  const versions = ((history.body as Record<string, unknown>)['versions'] as Record<string, unknown>[]);
  assert.equal(versions.length, 2);
  assert.equal(versions[0]!['version'], '2.0.0');
  assert.equal(versions[1]!['version'], '1.0.0');

  // The TESTING HOOK on the not-yet-installed v2 fails closed at the
  // AUTHORITY (the version is not installed in the execution's workspace —
  // the uniform 404).
  const testV2 = await apiCall(
    port(),
    `/api/extension-portal/executions/${state().executionA}/extensions/${extensionV2Id}/test`,
    {
      token: ownerA.token,
      body: { requestedCapabilities: ['enrich-audience'], input: { audienceId: 'aud-v2' } },
    },
  );
  assert.equal(testV2.status, 404, JSON.stringify(testV2.body));

  // The UPGRADE operation is NOT a bypass: the unreviewed target version
  // is denied at the AUTHORITY's install gate (403 POLICY_DENIED), even
  // though v1 of the same key is approved and installed.
  const deniedUpgrade = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/extensions/audience-enricher/upgrade`,
    {
      token: ownerA.token,
      body: {
        targetExtensionId: extensionV2Id,
        grantedScopes: ['client:read', 'workspace:read'],
        idempotencyKey: 'portal-upgrade-v2-unreviewed',
      },
    },
  );
  assert.equal(deniedUpgrade.status, 403, JSON.stringify(deniedUpgrade.body));
  assert.equal(errorCode(deniedUpgrade.body), 'POLICY_DENIED');
  const installs = await the().stack.pg.pool.query(
    'SELECT install_id FROM extension_installs WHERE extension_id = $1',
    [extensionV2Id],
  );
  assert.equal(installs.rows.length, 0, 'no partial upgrade write');
});

test('UPGRADE: review-approve v2 (the merge preserves v1 approval); the upgrade installs v2 alongside the pinned v1', async () => {
  const { ownerA, clientA, workspaceA, extensionV1Id, extensionV2Id, installV1Id } = state();

  // The reviewer approves v2 — the active policy MERGES: v1's allow rule
  // is PRESERVED, v2's rule is appended.
  const review = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV2Id}/permission-review`,
    {
      token: ownerA.token,
      body: { decision: 'approve', reason: 'v2 claims identical to v1 — approved' },
    },
  );
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const rules = ((review.body as Record<string, unknown>)['policy'] as Record<string, unknown>)['rules'] as Record<string, unknown>[];
  assert.equal(rules.length, 2, 'the merge preserves v1 approval and appends v2');
  const v2Rule = rules.find((rule) => (rule['attributes'] as Record<string, string>)['extensionId'] === extensionV2Id);
  const v1Rule = rules.find((rule) => (rule['attributes'] as Record<string, string>)['extensionId'] === extensionV1Id);
  assert.ok(v1Rule !== undefined && v1Rule['effect'] === 'allow');
  assert.ok(v2Rule !== undefined && v2Rule['effect'] === 'allow');

  // The review view reports BOTH rules referencing their versions.
  const view = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/versions/${extensionV2Id}/permission-review`,
    { token: ownerA.token },
  );
  const approval = ((view.body as Record<string, unknown>)['approvalState'] as Record<string, Record<string, unknown>>)['agency']!;
  assert.equal(approval['declared'], true);
  assert.deepEqual(approval['rulesReferencingThisVersion'], [1]);

  // THE UPGRADE: install v2 alongside v1 (the prior stays pinned+authorized
  // for its own retirement through the lifecycle edges).
  const upgrade = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/extensions/audience-enricher/upgrade`,
    {
      token: ownerA.token,
      body: {
        targetExtensionId: extensionV2Id,
        grantedScopes: ['client:read', 'workspace:read'],
        idempotencyKey: 'portal-upgrade-v2',
      },
    },
  );
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));
  const upgradeBody = (upgrade.body as Record<string, unknown>)['upgrade'] as Record<string, unknown>;
  const targetInstall = upgradeBody['targetInstall'] as Record<string, unknown>;
  assert.equal(targetInstall['status'], 'installed');
  assert.equal(targetInstall['extensionId'], extensionV2Id);
  assert.equal(targetInstall['clientId'], clientA);
  assert.equal(upgradeBody['priorRetired'], false);
  const priorInstall = upgradeBody['priorInstall'] as Record<string, unknown>;
  assert.equal(priorInstall['installId'], installV1Id);
  assert.equal(priorInstall['status'], 'authorized');
  assert.ok(String((upgrade.body as Record<string, unknown>)['orchestrationNote']).includes('non-atomic'));
  state().installV2Id = targetInstall['installId'] as string;

  // AUTHORITATIVE state: BOTH installs exist; the version-management view
  // reports the pinned version per install.
  const rows = await the().stack.pg.pool.query<{ install_id: string; extension_id: string; status: string }>(
    'SELECT install_id, extension_id, status FROM extension_installs WHERE workspace_id = $1 ORDER BY created_at',
    [workspaceA],
  );
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.rows[0]!.extension_id, extensionV1Id);
  assert.equal(rows.rows[0]!.status, 'authorized');
  assert.equal(rows.rows[1]!.extension_id, extensionV2Id);
  assert.equal(rows.rows[1]!.status, 'installed');

  const management = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/extensions/audience-enricher/versions`,
    { token: ownerA.token },
  );
  assert.equal(management.status, 200);
  const managementBody = management.body as Record<string, unknown>;
  const published = managementBody['publishedVersions'] as Record<string, unknown>[];
  const installed = managementBody['installedVersions'] as Record<string, unknown>[];
  assert.equal(published.length, 2);
  assert.equal(installed.length, 2);
  const pinnedV1 = installed.find((candidate) => candidate['extensionId'] === extensionV1Id);
  const pinnedV2 = installed.find((candidate) => candidate['extensionId'] === extensionV2Id);
  assert.equal(pinnedV1!['pinned'], true);
  assert.equal(pinnedV1!['version'], '1.0.0');
  assert.equal(pinnedV1!['status'], 'authorized');
  assert.equal(pinnedV2!['pinned'], true);
  assert.equal(pinnedV2!['version'], '2.0.0');
  assert.equal(pinnedV2!['status'], 'installed');
  assert.ok(String(managementBody['versioningNote']).includes('pinning is structural'));
});

test('LIFECYCLE: disable the prior authorized install → uninstall (terminal) → uninstall the upgrade target', async () => {
  const { ownerA, workspaceA, installV1Id, installV2Id, extensionV1Id, extensionV2Id } = state();

  // Disable the PRIOR install (authorized → disabled: the frozen edge).
  const disable = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/disable`,
    { token: ownerA.token, body: { expectedVersion: 3 } },
  );
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  assert.equal((disable.body as Record<string, unknown>)['status'], 'disabled');
  let row = await the().stack.pg.pool.query<{ status: string }>(
    'SELECT status FROM extension_installs WHERE install_id = $1',
    [installV1Id],
  );
  assert.equal(row.rows[0]!.status, 'disabled');

  // Uninstall it (disabled → uninstalled: TERMINAL).
  const uninstall = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/uninstall`,
    { token: ownerA.token, body: { expectedVersion: 4 } },
  );
  assert.equal(uninstall.status, 200, JSON.stringify(uninstall.body));
  assert.equal((uninstall.body as Record<string, unknown>)['status'], 'uninstalled');
  row = await the().stack.pg.pool.query<{ status: string }>(
    'SELECT status FROM extension_installs WHERE install_id = $1',
    [installV1Id],
  );
  assert.equal(row.rows[0]!.status, 'uninstalled');

  // The terminal tombstone: NO transition ever revives it (the authority
  // rejects every edge from 'uninstalled' — a forged revival is a 409).
  const revive = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV1Id}/authorize`,
    { token: ownerA.token, body: { expectedVersion: 5 } },
  );
  assert.equal(revive.status, 409, JSON.stringify(revive.body));
  assert.ok(JSON.stringify(revive.body).includes('uninstalled'));

  // Uninstall the upgrade target too (installed → uninstalled: the legal
  // edge — the loop's terminal state leaves the workspace clean).
  const uninstallV2 = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/installs/${installV2Id}/uninstall`,
    { token: ownerA.token, body: { expectedVersion: 1 } },
  );
  assert.equal(uninstallV2.status, 200, JSON.stringify(uninstallV2.body));
  assert.equal((uninstallV2.body as Record<string, unknown>)['status'], 'uninstalled');
  void extensionV1Id;
  void extensionV2Id;
});

// ---------------------------------------------------------------------------
// PERMISSION REVIEW — reject semantics (deny-overrides at the authority)
// ---------------------------------------------------------------------------

test('PERMISSION REVIEW: a REJECTED version is denied at the AUTHORITY even while sibling versions are approved; re-review converges', async () => {
  const { developer, ownerA, workspaceA } = state();

  // Publish v3 and REJECT it.
  const extensionV3Id = await publishVersion('audience-enricher', '3.0.0', developer.token);
  state().extensionV3Id = extensionV3Id;
  const reject = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV3Id}/permission-review`,
    {
      token: ownerA.token,
      body: { decision: 'reject', reason: 'the v3 claim set adds an undeclared egress surface' },
    },
  );
  assert.equal(reject.status, 201, JSON.stringify(reject.body));
  const rules = ((reject.body as Record<string, unknown>)['policy'] as Record<string, unknown>)['rules'] as Record<string, unknown>[];
  const v3Rule = rules.find((rule) => (rule['attributes'] as Record<string, string>)['extensionId'] === extensionV3Id);
  assert.ok(v3Rule !== undefined);
  assert.equal(v3Rule['effect'], 'deny');

  // Installing the rejected version is denied at the AUTHORITY — v1/v2
  // approvals stand, but deny-overrides wins for v3.
  const denied = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV3Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'portal-install-v3-rejected',
    },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorCode(denied.body), 'POLICY_DENIED');
  const installs = await the().stack.pg.pool.query(
    'SELECT install_id FROM extension_installs WHERE extension_id = $1',
    [extensionV3Id],
  );
  assert.equal(installs.rows.length, 0, 'no partial write for the rejected version');

  // RE-REVIEW CONVERGENCE: approving v3 REPLACES exactly the v3 rule (the
  // sibling rules are untouched) — then the install succeeds.
  const approve = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${extensionV3Id}/permission-review`,
    {
      token: ownerA.token,
      body: { decision: 'approve', reason: 'the egress concern was resolved by a new manifest review' },
    },
  );
  assert.equal(approve.status, 201, JSON.stringify(approve.body));
  const merged = ((approve.body as Record<string, unknown>)['policy'] as Record<string, unknown>)['rules'] as Record<string, unknown>[];
  assert.equal(merged.length, rules.length, 're-review replaces only the same version rule');
  const v3Merged = merged.find((rule) => (rule['attributes'] as Record<string, string>)['extensionId'] === extensionV3Id);
  assert.equal(v3Merged!['effect'], 'allow');

  const install = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceA}/installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV3Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'portal-install-v3',
    },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));

  // The review history is append-oriented: every superseded declaration
  // stays queryable (the review audit trail).
  const view = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceA}/versions/${extensionV3Id}/permission-review`,
    { token: ownerA.token },
  );
  const history = (view.body as Record<string, unknown>)['reviewHistory'] as Record<string, unknown>[];
  assert.ok(history.length >= 4, 'every review declaration stays in the append-oriented history');
});

// ---------------------------------------------------------------------------
// PLATFORM + CLIENT scoped reviews, cross-scope rejection, the retiring
// upgrade, and the audit trail
// ---------------------------------------------------------------------------

test('PLATFORM/CLIENT REVIEW: the platform approval composes across agencies; a client-scoped review unblocks the client; cross-scope reviewers are rejected', async () => {
  const { developer, ownerA, ownerB, clientB, workspaceB } = state();
  const admin = await adminToken();

  // Publish market-scraper v1 + v2.
  const scraperV1Id = await publishVersion('market-scraper', '1.0.0', developer.token);
  const scraperV2Id = await publishVersion('market-scraper', '2.0.0', developer.token);

  // A NON-admin cannot perform the platform-scoped review (403).
  const nonAdmin = await apiCall(
    port(),
    `/api/extension-portal/versions/${scraperV1Id}/permission-review`,
    { token: ownerA.token, body: { decision: 'approve', reason: 'not a platform admin' } },
  );
  assert.equal(nonAdmin.status, 403, JSON.stringify(nonAdmin.body));

  // The PLATFORM ADMINISTRATOR reviews + approves v1 at platform scope —
  // a delegated declaration through the /policies authority.
  const platformReview = await apiCall(
    port(),
    `/api/extension-portal/versions/${scraperV1Id}/permission-review`,
    { token: admin, body: { decision: 'approve', reason: 'platform-wide approval of market-scraper v1' } },
  );
  assert.equal(platformReview.status, 201, JSON.stringify(platformReview.body));
  assert.equal(
    ((platformReview.body as Record<string, unknown>)['review'] as Record<string, unknown>)['scopeKind'],
    'platform',
  );

  // The platform approval composes across the scope chain: agency B (with
  // NO agency extension policy of its own) can now install v1.
  const installB = await apiCall(port(), `/api/extension-portal/workspaces/${workspaceB}/installs`, {
    token: ownerB.token,
    body: {
      extensionId: scraperV1Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'portal-install-scraper-v1-b',
    },
  });
  assert.equal(installB.status, 201, JSON.stringify(installB.body));
  const scraperV1InstallId = ((installB.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;

  // A CLIENT-SCOPED review (ownerB reviews at the client B scope) approves
  // v2 — the client-level boundary composes with the platform rule for v1.
  const clientReview = await apiCall(
    port(),
    `/api/extension-portal/clients/${clientB}/versions/${scraperV2Id}/permission-review`,
    { token: ownerB.token, body: { decision: 'approve', reason: 'client-scoped approval of v2' } },
  );
  assert.equal(clientReview.status, 201, JSON.stringify(clientReview.body));
  assert.equal(
    ((clientReview.body as Record<string, unknown>)['review'] as Record<string, unknown>)['scopeKind'],
    'client',
  );

  // CROSS-SCOPE REVIEWER REJECTED: ownerB (agency B) cannot review at
  // agency A's scope (403 — no membership there).
  const foreignReview = await apiCall(
    port(),
    `/api/extension-portal/agencies/${ownerA.agencyId}/versions/${scraperV2Id}/permission-review`,
    { token: ownerB.token, body: { decision: 'approve', reason: 'foreign agency review attempt' } },
  );
  assert.equal(foreignReview.status, 403, JSON.stringify(foreignReview.body));

  // The foreign caller also cannot read another agency's review view
  // (uniform 404 — no cross-tenant oracle).
  const foreignView = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceB}/versions/${scraperV2Id}/permission-review`,
    { token: ownerA.token },
  );
  assert.equal(foreignView.status, 404, JSON.stringify(foreignView.body));

  // THE RETIRING UPGRADE: upgrade workspace B to v2 with
  // retirePriorVersion — TWO delegated authority operations: the target
  // install (client-scoped approval) + the prior uninstall.
  const upgrade = await apiCall(
    port(),
    `/api/extension-portal/workspaces/${workspaceB}/extensions/market-scraper/upgrade`,
    {
      token: ownerB.token,
      body: {
        targetExtensionId: scraperV2Id,
        grantedScopes: ['client:read'],
        idempotencyKey: 'portal-upgrade-scraper-v2-retire',
        retirePriorVersion: 'true',
      },
    },
  );
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));
  const upgradeBody = (upgrade.body as Record<string, unknown>)['upgrade'] as Record<string, unknown>;
  assert.equal((upgradeBody['targetInstall'] as Record<string, unknown>)['status'], 'installed');
  assert.equal(upgradeBody['priorRetired'], true);
  assert.equal((upgradeBody['priorInstall'] as Record<string, unknown>)['installId'], scraperV1InstallId);

  // AUTHORITATIVE state: the prior install is the terminal tombstone; the
  // target is installed.
  const rows = await the().stack.pg.pool.query<{ install_id: string; status: string }>(
    'SELECT install_id, status FROM extension_installs WHERE workspace_id = $1',
    [workspaceB],
  );
  assert.equal(rows.rows.length, 2);
  const priorRow = rows.rows.find((row) => row.install_id === scraperV1InstallId);
  const targetRow = rows.rows.find((row) => row.install_id !== scraperV1InstallId);
  assert.equal(priorRow!.status, 'uninstalled');
  assert.equal(targetRow!.status, 'installed');
});

test('AUDIT: every portal material mutation emitted an audit event with the portal action vocabulary', async () => {
  const audited = await the().stack.pg.pool.query<{ action: string }>(
    "SELECT DISTINCT action FROM audit_events WHERE action LIKE 'extension_portal.%'",
  );
  const actions = new Set(audited.rows.map((row) => row.action));
  for (const expected of [
    'extension_portal.version.published',
    'extension_portal.permission_reviewed',
    'extension_portal.installed',
    'extension_portal.configured',
    'extension_portal.install.authorized',
    'extension_portal.install.disabled',
    'extension_portal.install.uninstalled',
    'extension_portal.version.tested',
    'extension_portal.upgraded',
  ]) {
    assert.ok(actions.has(expected), `the audit trail must contain ${expected} (found: ${[...actions].join(', ')})`);
  }
});
