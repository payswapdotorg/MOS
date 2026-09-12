/**
 * MKT-022 integration tests — the extension registry and manifest contract
 * on the real stack (embedded PostgreSQL 18 + real API process — no mocks
 * of platform services).
 *
 * Acceptance mapping (work-items.md MKT-022; requirements.md EXT-001,
 * acceptance EXT-AC-01..04):
 *   - EXT-AC-01 (contract, at the API): a fully-declared §2 manifest
 *     publishes an immutable version; re-registration of the same
 *     (publisher, key, version) is a 409; a new version is a new record;
 *     manifests failing shape/permission declaration (non-least-privilege
 *     permission action, secret VALUES) are rejected 422;
 *   - the INSTALL LIFECYCLE: fail-closed policy gate (no declared
 *     extension policy → 403), least-privilege granted scopes, replayed
 *     idempotent install convergence, the configure/authorize/disable/
 *     uninstall state machine with CAS, config-contract validation and
 *     CRED-001 secret bindings (logical name → credential REFERENCE);
 *   - EXT-AC-02 (integration/security): the invocation context is scoped
 *     to the EXECUTION's canonical Client/Workspace (never
 *     caller-supplied); ungranted scopes fail closed; foreign-tenant data
 *     is a uniform 404 (no cross-tenant oracle); authority-field
 *     smuggling and undeclared-capability invocations are rejected;
 *   - EXT-AC-04 (integration): extension invocations cannot fabricate
 *     evidence provenance — the invocation input rejects
 *     provenance-shaped keys, the ledger's provenance is server-derived,
 *     and evidence creation through the ONLY sanctioned path (/evidence)
 *     rejects caller-supplied actor/provenance and derives provenance
 *     server-side;
 *   - DB BACKSTOPS: registry immutability, the append-only invocation
 *     ledger (UPDATE/DELETE rejected), the frozen install lifecycle, the
 *     scope-chain fences and the invocation consistency fence.
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
const SECRET_HANDLE = 'extension-test-provider-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-extensions-9f8a7b6c';

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
  stack = await bootStack('extensions');
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
function manifestFixture(version: string): Record<string, unknown> {
  return {
    manifest: {
      extensionKey: 'audience-enricher',
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
    idempotencyKey: `register-${version}`,
  };
}

async function declarePlatformExtensionPolicy(): Promise<void> {
  const declare = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension: 'extension',
      rules: [
        {
          effect: 'allow',
          operations: ['install', 'invoke'],
          reason: 'platform default allows extension install and invoke',
        },
      ],
      description: 'Platform extension boundary v1',
    },
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));
}

async function makeExtensionExecution(workspaceId: string, token: string, ref: string): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      externalRequestRef: ref,
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `ext-exec-${ref}`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

// Shared state built once in the first test (creation order matters).
interface SharedState {
  ownerA: Principal;
  ownerB: Principal;
  clientA: string;
  clientB: string;
  workspaceA: string;
  workspaceB: string;
  extensionId: string;
  extensionV11Id: string;
  installId: string;
  executionA: string;
  invocationId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

// ---------------------------------------------------------------------------
// EXT-AC-01 — the manifest contract at the registration surface
// ---------------------------------------------------------------------------

test('EXT-AC-01: a fully-declared manifest publishes an immutable version; re-registration of the same version is 409; a new version is a new record', async () => {
  const admin = await adminToken();

  const publish = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: manifestFixture('1.0.0'),
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const extension = publish.body as Record<string, unknown>;
  const manifest = extension['manifest'] as Record<string, unknown>;
  assert.equal(manifest['extensionKey'], 'audience-enricher');
  assert.equal(manifest['version'], '1.0.0');
  assert.deepEqual(manifest['requiredSecretNames'], ['DATA_PROVIDER_KEY']);
  assert.deepEqual(manifest['dataScopes'], ['client:read', 'client:write', 'workspace:read']);
  // The manifest round-trips through the API and the database unchanged.
  const stored = await the().stack.pg.pool.query<{ version: string; capabilities: unknown }>(
    'SELECT version, capabilities FROM extensions WHERE extension_id = $1',
    [extension['extensionId'] as string],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.version, '1.0.0');
  assert.deepEqual(
    stored.rows[0]!.capabilities,
    (manifest['capabilities'] as unknown[]),
  );

  // Re-registration of the SAME (publisher, key, version) → 409 (immutable).
  const reRegister = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: manifestFixture('1.0.0'),
  });
  assert.equal(reRegister.status, 409, JSON.stringify(reRegister.body));

  // A NEW version is a NEW record.
  const next = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: manifestFixture('1.1.0'),
  });
  assert.equal(next.status, 201, JSON.stringify(next.body));
  assert.notEqual(
    (next.body as Record<string, unknown>)['extensionId'],
    extension['extensionId'],
  );

  // The registry lists and reads back.
  const list = await apiCall(port(), '/api/extensions', { token: admin });
  assert.equal(list.status, 200);
  const extensions = list.body['extensions'] as Record<string, unknown>[];
  assert.ok(extensions.some((entry) => entry['extensionId'] === extension['extensionId']));
  const read = await apiCall(port(), `/api/extensions/${extension['extensionId']}`, { token: admin });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['extensionId'], extension['extensionId']);

  // Build the shared tenant fixtures for the rest of the suite.
  const ownerA = await makePrincipal('extensions-owner-a@marketingos.test');
  const ownerB = await makePrincipal('extensions-owner-b@marketingos.test');
  const clientA = await makeClient(ownerA.agencyId, ownerA.token);
  const clientB = await makeClient(ownerB.agencyId, ownerB.token);
  const workspaceA = await makeWorkspace(clientA, ownerA.token, 'Extensions Workspace A');
  const workspaceB = await makeWorkspace(clientB, ownerB.token, 'Extensions Workspace B');

  shared = {
    ownerA,
    ownerB,
    clientA,
    clientB,
    workspaceA,
    workspaceB,
    extensionId: extension['extensionId'] as string,
    extensionV11Id: (next.body as Record<string, unknown>)['extensionId'] as string,
    installId: '',
    executionA: '',
    invocationId: '',
  };
});

test('EXT-AC-01: manifests failing shape/permission declaration are rejected — non-least-privilege permissions and secret VALUES', async () => {
  const admin = await adminToken();

  // A permission claiming workflow mutation is NOT declarable (§5) — the
  // route DTO's closed action pattern AND the module guard both reject.
  const workflowMutation = manifestFixture('2.0.0');
  (workflowMutation['manifest'] as Record<string, unknown>)['permissions'] = [
    { action: 'workflow:write' },
  ];
  const rejectedPermission = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: workflowMutation,
  });
  assert.equal(rejectedPermission.status, 422, JSON.stringify(rejectedPermission.body));
  assert.ok(JSON.stringify(rejectedPermission.body).includes('action'));

  // A secret VALUE inside the input contract (§21).
  const smuggled = manifestFixture('2.1.0');
  ((smuggled['manifest'] as Record<string, unknown>)['inputContract'] as Record<string, unknown>)['apiKey'] =
    'sk-live-1234567890';
  const rejectedSecret = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: smuggled,
  });
  assert.equal(rejectedSecret.status, 422, JSON.stringify(rejectedSecret.body));
  assert.ok(JSON.stringify(rejectedSecret.body).includes('material-shaped'));

  // An unknown capability category.
  const badCategory = manifestFixture('2.2.0');
  (badCategory['manifest'] as Record<string, unknown>)['capabilities'] = [
    { category: 'teleportation', name: 'x' },
  ];
  const rejectedCategory = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: badCategory,
  });
  assert.equal(rejectedCategory.status, 422);

  // Registration authority fields are never request-suppliable.
  const withAuthority = manifestFixture('2.3.0');
  (withAuthority as Record<string, unknown>)['extensionId'] = '00000000-0000-0000-0000-000000000000';
  const rejectedAuthority = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: withAuthority,
  });
  assert.equal(rejectedAuthority.status, 422);
  assert.ok(JSON.stringify(rejectedAuthority.body).includes('forbidden authority field'));

  // A principal with NO agency membership cannot publish.
  const loner = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'extensions-loner@marketingos.test', displayName: 'loner' },
  });
  assert.equal(loner.status, 201);
  const lonerId = loner.body['userId'] as string;
  await apiCall(port(), `/api/users/${lonerId}/credential`, {
    token: admin,
    body: { password: 'a-very-long-password-123' },
  });
  const lonerLogin = await apiCall(port(), '/api/auth/login', {
    body: { email: 'extensions-loner@marketingos.test', password: 'a-very-long-password-123' },
  });
  assert.equal(lonerLogin.status, 200);
  const notAuthorized = await apiCall(port(), '/api/extensions', {
    token: lonerLogin.body['token'] as string,
    body: manifestFixture('3.0.0'),
  });
  assert.equal(notAuthorized.status, 403, JSON.stringify(notAuthorized.body));
});

// ---------------------------------------------------------------------------
// The install lifecycle (policy gate, least-privilege, replay, configure)
// ---------------------------------------------------------------------------

test('install: fail-closed policy gate — no declared extension policy denies the install (403); a platform allow permits it', async () => {
  const { ownerA, workspaceA, extensionId } = state();

  // BEFORE any extension policy: the decision is 'unknown' → deny.
  const denied = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'install-a-1',
    },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(
    ((denied.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    'POLICY_DENIED',
  );

  // Declare the platform extension boundary.
  await declarePlatformExtensionPolicy();

  const install = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'install-a-1',
    },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const installBody = install.body as Record<string, unknown>;
  const record = installBody['install'] as Record<string, unknown>;
  assert.equal(record['status'], 'installed');
  assert.equal(record['agencyId'], ownerA.agencyId);
  assert.equal(record['clientId'], state().clientA);
  assert.equal(record['workspaceId'], workspaceA);
  assert.deepEqual(record['grantedScopes'], ['client:read', 'workspace:read']);
  state().installId = record['installId'] as string;
});

test('install: granted scopes exceeding the manifest declaration are rejected (least-privilege)', async () => {
  const { ownerA, workspaceA, extensionId } = state();
  // 'workspace:write' is NOT in the manifest's declared data scopes.
  const rejected = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId,
      grantedScopes: ['workspace:write'],
      idempotencyKey: 'install-a-2',
    },
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  assert.ok(JSON.stringify(rejected.body).includes("exceeds the manifest's declared data scopes"));
});

test('install: a duplicate of the SAME logical install command converges (replayed)', async () => {
  const { ownerA, workspaceA, extensionId } = state();
  const replay = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'install-a-1',
    },
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal((replay.body as Record<string, unknown>)['replayed'], true);
  assert.equal(
    ((replay.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'],
    state().installId,
  );
});

test('install: cross-tenant workspace is a uniform 404 (the Client boundary cannot be crossed)', async () => {
  const { ownerB, workspaceA, extensionId } = state();
  // ownerB (agency B) installs into workspace A (owned by agency A).
  const foreign = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerB.token,
    body: {
      extensionId,
      grantedScopes: ['client:read'],
      idempotencyKey: 'install-b-1',
    },
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
});

test('configure: the manifest config contract + the CRED-001 secret binding (logical name → credential REFERENCE)', async () => {
  const { ownerA, ownerB, workspaceA, installId } = state();

  // Pattern violation → 422.
  const badRegion = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/configure`,
    {
      token: ownerA.token,
      body: {
        config: { region: 'mars' },
        secretBindings: {},
        expectedVersion: 1,
      },
    },
  );
  assert.equal(badRegion.status, 422, JSON.stringify(badRegion.body));

  // Missing the required secret binding → 422.
  const missingBinding = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/configure`,
    {
      token: ownerA.token,
      body: {
        config: { region: 'eu' },
        secretBindings: {},
        expectedVersion: 1,
      },
    },
  );
  assert.equal(missingBinding.status, 422, JSON.stringify(missingBinding.body));
  assert.ok(JSON.stringify(missingBinding.body).includes('DATA_PROVIDER_KEY'));

  // Create the credential references: one in the owning agency, one in
  // the foreign agency (for the cross-tenant binding rejection).
  const ownCredential = await apiCall(port(), `/api/agencies/${state().ownerA.agencyId}/credentials`, {
    token: ownerA.token,
    body: { kind: 'integration_api_key', label: 'provider key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(ownCredential.status, 201, JSON.stringify(ownCredential.body));
  const foreignCredential = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/credentials`, {
    token: ownerB.token,
    body: { kind: 'integration_api_key', label: 'foreign key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(foreignCredential.status, 201);
  const foreignCredentialId = (foreignCredential.body as Record<string, unknown>)['credentialId'] as string;

  // A FOREIGN credential reference is rejected (no traversal oracle).
  const foreignBinding = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/configure`,
    {
      token: ownerA.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { DATA_PROVIDER_KEY: foreignCredentialId },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(foreignBinding.status, 404, JSON.stringify(foreignBinding.body));

  // The owning-agency binding configures the install.
  const configure = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/configure`,
    {
      token: ownerA.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { DATA_PROVIDER_KEY: (ownCredential.body as Record<string, unknown>)['credentialId'] as string },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  const configured = configure.body as Record<string, unknown>;
  assert.equal(configured['status'], 'configured');
  assert.deepEqual(configured['secretBindings'], {
    DATA_PROVIDER_KEY: (ownCredential.body as Record<string, unknown>)['credentialId'],
  });
  // The install row stores ONLY the reference id — never material.
  const stored = await the().stack.pg.pool.query<{ secret_bindings: Record<string, string> }>(
    'SELECT secret_bindings FROM extension_installs WHERE install_id = $1',
    [installId],
  );
  assert.equal(stored.rows.length, 1);
  for (const value of Object.values(stored.rows[0]!.secret_bindings)) {
    assert.ok(!value.includes(SECRET_MATERIAL), 'the install row must never contain secret material');
  }

  // CAS: authorize with a stale version → 409.
  const stale = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/authorize`,
    {
      token: ownerA.token,
      body: { expectedVersion: 1 },
    },
  );
  assert.equal(stale.status, 409);

  // Authorization completes the lifecycle edge.
  const authorize = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/authorize`,
    {
      token: ownerA.token,
      body: { expectedVersion: 2 },
    },
  );
  assert.equal(authorize.status, 200, JSON.stringify(authorize.body));
  assert.equal((authorize.body as Record<string, unknown>)['status'], 'authorized');
});

// ---------------------------------------------------------------------------
// EXT-AC-02 — the invocation contract (integration/security)
// ---------------------------------------------------------------------------

test('EXT-AC-02: invocation BEFORE authorization fails closed (409) — only authorized installs are invocable', async () => {
  const { ownerA, workspaceA, extensionV11Id } = state();
  const execution = await makeExtensionExecution(workspaceA, ownerA.token, 'pre-auth-1');
  // A SECOND install of the OTHER published version (born 'installed',
  // never configured): the not-yet-authorized state fails closed.
  const install = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV11Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'install-a-v11',
    },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const v11InstallId = ((install.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;
  const notAuthorized = await apiCall(
    port(),
    `/api/executions/${execution}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId: extensionV11Id,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(notAuthorized.status, 409, JSON.stringify(notAuthorized.body));
  assert.ok(JSON.stringify(notAuthorized.body).includes('authorized'));
  void v11InstallId;
});

test('EXT-AC-02: the invocation context is scoped to the EXECUTION canonical owner with the granted subset only', async () => {
  const { ownerA, ownerB, clientA, workspaceA, workspaceB, extensionId, installId } = state();
  const execution = await makeExtensionExecution(workspaceA, ownerA.token, 'ext-run-1');
  state().executionA = execution;

  const invoke = await apiCall(
    port(),
    `/api/executions/${execution}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-123', note: 'enrich this audience' },
      },
    },
  );
  assert.equal(invoke.status, 201, JSON.stringify(invoke.body));
  const context = invoke.body as Record<string, unknown>;

  // The scope is SERVER-DERIVED from the execution's canonical owner —
  // the request body carries no scope fields at all.
  const scope = context['scope'] as Record<string, string>;
  assert.equal(scope['kind'], 'extension-invocation');
  assert.equal(scope['agencyId'], ownerA.agencyId);
  assert.equal(scope['clientId'], clientA);
  assert.equal(scope['workspaceId'], workspaceA);

  // The granted data scopes are the INSTALL grant (client:read +
  // workspace:read) — the manifest's 'client:write' is declared but NOT
  // granted: ungranted scopes fail closed.
  assert.deepEqual(context['grantedDataScopes'], ['client:read', 'workspace:read']);
  assert.ok(!(context['grantedDataScopes'] as string[]).includes('client:write'));

  // The granted capability set is bounded by the manifest.
  assert.deepEqual(context['grantedCapabilities'], [
    { category: 'data-source', name: 'enrich-audience' },
  ]);

  // The policy posture: an explicit recorded allow.
  assert.ok(typeof context['policyDecisionId'] === 'string' && (context['policyDecisionId'] as string).length > 0);
  assert.equal(context['policyOutcome'], 'allow');

  // Short-lived.
  assert.ok(Date.parse(context['expiresAt'] as string) > Date.parse(context['issuedAt'] as string));
  assert.equal(context['expired'], false);

  // The context carries NO credential-shaped field (never a platform
  // credential — extensions cannot create credentials for themselves).
  for (const forbidden of ['secret', 'secretHandle', 'material', 'token', 'apiKey']) {
    assert.ok(!(`${forbidden}` in context), `the context must not carry '${forbidden}'`);
  }

  // The append-only ledger row: provenance is SERVER-DERIVED (the actor
  // is the authenticated principal, recordedVia 'api').
  const invocationId = context['invocationId'] as string;
  state().invocationId = invocationId;
  const ledger = await apiCall(port(), `/api/extension-invocations/${invocationId}`, {
    token: ownerA.token,
  });
  assert.equal(ledger.status, 200);
  const ledgerBody = ledger.body as Record<string, unknown>;
  const provenance = ledgerBody['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(ledgerBody['executionId'], execution);
  assert.equal(ledgerBody['installId'], installId);

  // The /policies decision ledger records the explicit invoke allow.
  const decision = await the().stack.pg.pool.query<{ outcome: string; operation: unknown; reason_code: string }>(
    `SELECT outcome, action->>'operation' AS operation, reason_code FROM policy_decisions
     WHERE decision_id = $1`,
    [context['policyDecisionId']],
  );
  assert.equal(decision.rows.length, 1);
  assert.equal(decision.rows[0]!.outcome, 'allow');
  assert.equal((decision.rows[0]!.operation as string), 'invoke');

  // The workspace ledger lists the invocation (Observe).
  const list = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-invocations`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  assert.ok(
    (list.body['invocations'] as Record<string, unknown>[]).some(
      (entry) => entry['invocationId'] === invocationId,
    ),
  );

  // A FOREIGN execution resolves a foreign install → uniform 404 (the
  // extension is not installed in that workspace; no cross-tenant oracle).
  const foreignExecution = await makeExtensionExecution(workspaceB, ownerB.token, 'ext-run-b-1');
  const foreignInvoke = await apiCall(
    port(),
    `/api/executions/${foreignExecution}/extension-invocations`,
    {
      token: ownerB.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-999' },
      },
    },
  );
  assert.equal(foreignInvoke.status, 404, JSON.stringify(foreignInvoke.body));
});

test('EXT-AC-02: a principal of ANOTHER agency invoking on a foreign execution gets the same uniform 404', async () => {
  const { ownerB, executionA, extensionId } = state();
  const foreign = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerB.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
});

test('EXT-AC-02: foreign invocation records are a uniform 404 (no cross-tenant read oracle)', async () => {
  const { ownerB, invocationId } = state();
  const foreignRead = await apiCall(port(), `/api/extension-invocations/${invocationId}`, {
    token: ownerB.token,
  });
  assert.equal(foreignRead.status, 404, JSON.stringify(foreignRead.body));
});

test('EXT-AC-02: authority-field smuggling into the invocation body is rejected (422)', async () => {
  const { ownerA, executionA, extensionId } = state();
  for (const smuggled of [
    { agencyId: '99999999-9999-4999-8999-999999999999' },
    { scope: { agencyId: 'x', clientId: 'y', workspaceId: 'z' } },
    { provenance: { actor: 'service:evil' } },
    { policyOutcome: 'allow' },
    { grantedDataScopes: ['client:write'] },
  ]) {
    const rejected = await apiCall(
      port(),
      `/api/executions/${executionA}/extension-invocations`,
      {
        token: ownerA.token,
        body: {
          extensionId,
          requestedCapabilities: ['enrich-audience'],
          input: { audienceId: 'aud-1' },
          ...smuggled,
        },
      },
    );
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.ok(JSON.stringify(rejected.body).includes('forbidden authority field'));
  }
});

test('EXT-AC-02: provenance/material-shaped keys INSIDE the invocation input are rejected (422)', async () => {
  const { ownerA, executionA, extensionId } = state();
  for (const key of ['provenance', 'actor', 'agencyId', 'collectedBy', 'evidenceId']) {
    const rejected = await apiCall(
      port(),
      `/api/executions/${executionA}/extension-invocations`,
      {
        token: ownerA.token,
        body: {
          extensionId,
          requestedCapabilities: ['enrich-audience'],
          input: { audienceId: 'aud-1', [key]: 'smuggled' },
        },
      },
    );
    assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
    assert.ok(JSON.stringify(rejected.body).includes(key), `the rejection must name '${key}'`);
  }
  // Material-shaped keys (nested §21 backstop).
  const material = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1', nested: { apiKey: 'sk-live-123' } },
      },
    },
  );
  assert.equal(material.status, 422, JSON.stringify(material.body));
});

test('EXT-AC-02: undeclared-capability invocation is rejected; input contract keys are enforced', async () => {
  const { ownerA, executionA, extensionId } = state();

  const undeclared = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['launch-missiles'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(undeclared.status, 422, JSON.stringify(undeclared.body));
  assert.ok(JSON.stringify(undeclared.body).includes('not a declared capability'));

  const missingRequired = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { somethingElse: 1 },
      },
    },
  );
  assert.equal(missingRequired.status, 422);
  assert.ok(JSON.stringify(missingRequired.body).includes('audienceId'));
});

test('EXT-AC-02: only extension-kind, non-terminal executions host invocations (409 otherwise)', async () => {
  const { ownerA, extensionId, workspaceA } = state();
  const deterministic = await apiCall(port(), `/api/workspaces/${workspaceA}/executions`, {
    token: ownerA.token,
    body: {
      externalRequestRef: 'det-run-1',
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'det-exec-1',
    },
  });
  assert.equal(deterministic.status, 201);
  const deterministicId = ((deterministic.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['executionId'] as string;
  const wrongKind = await apiCall(
    port(),
    `/api/executions/${deterministicId}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(wrongKind.status, 409, JSON.stringify(wrongKind.body));
  assert.ok(JSON.stringify(wrongKind.body).includes('extension-kind'));
});

// ---------------------------------------------------------------------------
// EXT-AC-04 — extensions cannot fabricate evidence provenance
// ---------------------------------------------------------------------------

test('EXT-AC-04: the invocation ledger provenance is SERVER-DERIVED and unforgeable', async () => {
  const { ownerA, invocationId } = state();
  const ledger = await apiCall(port(), `/api/extension-invocations/${invocationId}`, {
    token: ownerA.token,
  });
  assert.equal(ledger.status, 200);
  const provenance = ((ledger.body as Record<string, unknown>)['provenance'] as Record<string, unknown>);
  // The actor is derived from the authenticated principal (never from the
  // request); there is no extension-assertable provenance field anywhere.
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.ok(!('extensionActor' in provenance));

  // The DB row's provenance columns match the server derivation.
  const stored = await the().stack.pg.pool.query<{ recorded_actor: string; input: Record<string, unknown> }>(
    'SELECT recorded_actor, input FROM extension_invocations WHERE invocation_id = $1',
    [invocationId],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0]!.recorded_actor, `user:${ownerA.userId}`);
  // The recorded input round-trips without any provenance-shaped key
  // (jsonb does not preserve key order — compare the sorted set).
  assert.deepEqual(Object.keys(stored.rows[0]!.input).sort(), ['audienceId', 'note']);
});

test('EXT-AC-04: evidence creation through the ONLY sanctioned path rejects caller-supplied provenance and derives it server-side', async () => {
  const { ownerA, clientA } = state();

  // A provenance-shaped field on the /evidence append surface → rejected.
  const smuggled = await apiCall(port(), `/api/clients/${clientA}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'observation',
      sourceSystem: 'extension:audience-enricher',
      observedAt: '2026-01-15T10:00:00.000Z',
      content: { audienceId: 'aud-123', enrichedCount: 42 },
      quality: 'B',
      actor: 'extension:audience-enricher',
    },
  });
  assert.equal(smuggled.status, 422, JSON.stringify(smuggled.body));
  assert.ok(JSON.stringify(smuggled.body).includes('forbidden authority field'));

  // The same evidence WITHOUT the smuggled field is created — with the
  // actor provenance SERVER-DERIVED (the authenticated user), never the
  // extension identity the invocation input tried to assert.
  const created = await apiCall(port(), `/api/clients/${clientA}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'observation',
      sourceSystem: 'extension:audience-enricher',
      observedAt: '2026-01-15T10:00:00.000Z',
      content: { audienceId: 'aud-123', enrichedCount: 42 },
      quality: 'B',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const evidence = created.body as Record<string, unknown>;
  const evidenceProvenance = evidence['provenance'] as Record<string, unknown>;
  assert.equal(evidenceProvenance['actor'], `user:${ownerA.userId}`);
  // The source identity may carry the extension LABEL (observable source
  // descriptor) but the ACTOR provenance is server-derived and the
  // invocation context had no path to assert it.
  assert.equal(evidence['class'], 'observation');

  // There is NO extension-owned evidence surface: the /extensions module
  // API exposes no evidence method (asserted by the architecture suite);
  // operationally, the invocation input cannot even carry the key names.
});

// ---------------------------------------------------------------------------
// Disable/uninstall + invocation fail-closed
// ---------------------------------------------------------------------------

test('lifecycle: disable blocks invocation (409); uninstall is terminal and never resurrections', async () => {
  const { ownerA, workspaceA, installId, extensionId, executionA } = state();

  const disable = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/disable`,
    {
      token: ownerA.token,
      body: { expectedVersion: 3 },
    },
  );
  assert.equal(disable.status, 200, JSON.stringify(disable.body));
  assert.equal((disable.body as Record<string, unknown>)['status'], 'disabled');

  const deniedInvoke = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(deniedInvoke.status, 409, JSON.stringify(deniedInvoke.body));
  assert.ok(JSON.stringify(deniedInvoke.body).includes('authorized'));

  // Re-enable, then uninstall (terminal).
  const authorize = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/authorize`,
    {
      token: ownerA.token,
      body: { expectedVersion: 4 },
    },
  );
  assert.equal(authorize.status, 200);
  const uninstall = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/uninstall`,
    {
      token: ownerA.token,
      body: { expectedVersion: 5 },
    },
  );
  assert.equal(uninstall.status, 200, JSON.stringify(uninstall.body));
  assert.equal((uninstall.body as Record<string, unknown>)['status'], 'uninstalled');

  // Terminal: every further transition is rejected.
  const resurrect = await apiCall(
    port(),
    `/api/workspaces/${workspaceA}/extension-installs/${installId}/authorize`,
    {
      token: ownerA.token,
      body: { expectedVersion: 6 },
    },
  );
  assert.equal(resurrect.status, 409, JSON.stringify(resurrect.body));
  assert.ok(JSON.stringify(resurrect.body).includes('uninstalled'));

  // Invocation after uninstall fails closed.
  const postUninstall = await apiCall(
    port(),
    `/api/executions/${executionA}/extension-invocations`,
    {
      token: ownerA.token,
      body: {
        extensionId,
        requestedCapabilities: ['enrich-audience'],
        input: { audienceId: 'aud-1' },
      },
    },
  );
  assert.equal(postUninstall.status, 409);
});

// ---------------------------------------------------------------------------
// DB backstops (direct SQL rejects the invariants' violation)
// ---------------------------------------------------------------------------

test('DB backstop: published registry rows reject UPDATE (immutable manifests)', async () => {
  const { extensionId } = state();
  await assert.rejects(
    () =>
      the().stack.pg.pool.query('UPDATE extensions SET version = $1 WHERE extension_id = $2', [
        '9.9.9',
        extensionId,
      ]),
    (error: { message?: string }) => {
      assert.ok(
        (error.message ?? '').includes('immutable'),
        `expected the immutability trigger, got: ${error.message}`,
      );
      return true;
    },
  );
});

test('DB backstop: the invocation ledger is append-only (UPDATE and DELETE rejected)', async () => {
  const { invocationId } = state();
  await assert.rejects(
    () =>
      the().stack.pg.pool.query('UPDATE extension_invocations SET input = $1 WHERE invocation_id = $2', [
        JSON.stringify({ forged: true }),
        invocationId,
      ]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('append-only'));
      return true;
    },
  );
  await assert.rejects(
    () =>
      the().stack.pg.pool.query('DELETE FROM extension_invocations WHERE invocation_id = $1', [
        invocationId,
      ]),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('append-only'));
      return true;
    },
  );
});

test('DB backstop: the frozen install lifecycle rejects illegal transitions by direct SQL', async () => {
  const { ownerA, workspaceA } = state();
  // Install v1.2.0 fresh, born 'installed'.
  const v12 = await apiCall(port(), '/api/extensions', {
    token: await adminToken(),
    body: manifestFixture('1.2.0'),
  });
  assert.equal(v12.status, 201);
  const extensionV12Id = (v12.body as Record<string, unknown>)['extensionId'] as string;
  const install = await apiCall(port(), `/api/workspaces/${workspaceA}/extension-installs`, {
    token: ownerA.token,
    body: {
      extensionId: extensionV12Id,
      grantedScopes: ['client:read'],
      idempotencyKey: 'install-a-v12',
    },
  });
  assert.equal(install.status, 201);
  const installV12Id = ((install.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;

  // installed → authorized is NOT a frozen edge (configure comes first).
  await assert.rejects(
    () =>
      the().stack.pg.pool.query(
        "UPDATE extension_installs SET status = 'authorized', version = version + 1 WHERE install_id = $1",
        [installV12Id],
      ),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('illegal extension install transition'));
      return true;
    },
  );
});

test('DB backstop: the install scope chain cannot cross the Client boundary by direct SQL', async () => {
  const { clientB, ownerA, workspaceA, extensionId } = state();
  // A row claiming agency A but client B (foreign client).
  await assert.rejects(
    () =>
      the().stack.pg.pool.query(
        `INSERT INTO extension_installs
           (install_id, extension_id, agency_id, client_id, workspace_id, status, granted_scopes,
            idempotency_key, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'installed', '["client:read"]'::jsonb, 'sql-fence', 1, now(), now())`,
        ['f1111111-1111-4111-8111-111111111110', extensionId, ownerA.agencyId, clientB, workspaceA],
      ),
    (error: { message?: string }) => {
      assert.ok((error.message ?? '').includes('Client boundary'));
      return true;
    },
  );
});

test('DB backstop: invocation rows must match their execution canonical scope (consistency fence)', async () => {
  const { invocationId, workspaceB, ownerB, extensionId, installId } = state();
  // Re-point an invocation-shaped row at a foreign workspace: rejected.
  const stored = await the().stack.pg.pool.query<{
    execution_id: string;
    agency_id: string;
    client_id: string;
    workspace_id: string;
    granted_capabilities: unknown;
    granted_data_scopes: unknown;
    policy_decision_id: string;
    input: unknown;
    recorded_actor: string;
    recorded_via: string;
    correlation_id: string;
    causation_id: string | null;
    issued_at: Date;
    expires_at: Date;
  }>('SELECT * FROM extension_invocations WHERE invocation_id = $1', [invocationId]);
  assert.equal(stored.rows.length, 1);
  const row = stored.rows[0]!;
  await assert.rejects(
    () =>
      the().stack.pg.pool.query(
        `INSERT INTO extension_invocations
           (invocation_id, extension_id, install_id, execution_id, agency_id, client_id, workspace_id,
            granted_capabilities, granted_data_scopes, policy_decision_id, policy_outcome, input,
            recorded_actor, recorded_via, correlation_id, causation_id, issued_at, expires_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, 'allow', $11::jsonb,
                 $12, $13, $14, $15, $16, $17, now())`,
        [
          'f2222222-2222-4222-8222-222222222220',
          extensionId,
          installId,
          row.execution_id,
          row.agency_id,
          row.client_id,
          workspaceB, // the crossed scope
          JSON.stringify(row.granted_capabilities),
          JSON.stringify(row.granted_data_scopes),
          row.policy_decision_id,
          JSON.stringify(row.input),
          row.recorded_actor,
          row.recorded_via,
          row.correlation_id,
          row.causation_id,
          row.issued_at,
          row.expires_at,
        ],
      ),
    (error: { message?: string }) => {
      assert.ok(
        (error.message ?? '').includes('canonical owner') || (error.message ?? '').includes('same workspace'),
        `expected the consistency fence, got: ${error.message}`,
      );
      return true;
    },
  );
  void ownerB;
});
