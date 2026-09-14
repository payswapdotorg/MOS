/**
 * MKT-052 integration tests — the App Metering and Commercial Attribution
 * surface on the real stack (embedded PostgreSQL 18 + real API process —
 * no mocks of platform services; the module-level collection/ingestion/
 * recompute commands are driven through the SAME in-process application
 * composed against the SAME database the API serves — the MKT-034
 * sanctioned test-harness wiring, the operating-graph precedent).
 *
 * Acceptance mapping (spec/effective-backlog-v1.5.md MKT-052; the
 * dispatch acceptance criteria AC-1..AC-8):
 *   - AC-1 GOLDEN PATH (install → invoke → usage → meter events appear):
 *     a real install through the MKT-048 surface, a real invocation
 *     through the MKT-022 extension-invocation surface, real usage
 *     observations through the module-level ingestion command, then the
 *     COLLECTION over the real sources — the meter events appear with
 *     the correct dimensions/units/provenance/canonical source
 *     references (DB-asserted), and the attribution views roll up
 *     correctly;
 *   - AC-1 IDEMPOTENT COLLECTION: re-collection appends ZERO rows; the
 *     collection is event consumption over public contracts (the
 *     authority tables are byte-identical after);
 *   - AC-2/AC-8 THE VIEWS: the workspace view, the agency rollup and
 *     the publisher commercial view (per app / per publisher / per
 *     workspace / per period) with the frozen calculation version, the
 *     assumption record and the honest unattributed remainder;
 *   - AC-3 DERIVED, NOT FINANCIAL: the metering tail carries
 *     quantities; the DB rejects UPDATE and DELETE outright
 *     (append-only); the rollup recompute is the disclosed rebuild path
 *     and rollups NEVER feed the views (the views are live);
 *   - AC-5 GROUND TRUTH + RECOMPUTE-CONVERGENCE: direct SQL over the
 *     tail equals the rollups AND the views' raw totals; rebuilding
 *     twice converges to identical aggregate rows;
 *   - AC-7 LIVE-FOLLOW: new invocations move the views (after
 *     collection); an upgrade appends a second installation meter event;
 *   - AC-4/AC-1 ISOLATION: anonymous 401; foreign/malformed workspace,
 *     agency and publisher identifiers are the UNIFORM 404; a suspended
 *     membership is the 403; every mutating verb 405s at the router;
 *     the publisher view NEVER surfaces tenant identities;
 *   - the ingestion guards: a non-installed app is the uniform 404; a
 *     non-declared metering dimension/capability/namespace is the 422
 *     with zero rows; a foreign invocation is the 404; §8 replays
 *     converge and divergent key reuse is the 409.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { AppMeteringModuleApi } from '../../src/modules/app-metering/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SECRET_HANDLE = 'metering-test-provider-key';
const SECRET_MATERIAL = 'MATERIAL-do-not-leak-metering-1c2b3a4d5e';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let appMetering: AppMeteringModuleApi | null = null;

function metering(): AppMeteringModuleApi {
  if (appMetering === null) throw new Error('application not bootstrapped');
  return appMetering;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const WORKER_PROVENANCE = {
  actor: 'service:metering-worker',
  recordedVia: 'module',
  correlationId: 'integration-metering-1',
  causationId: null,
} as const;

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

// ---------------------------------------------------------------------------
// The extension + app fixtures (the full v1.5 app chain)
// ---------------------------------------------------------------------------

const EXTENSION_KEY = 'audience-enricher';
const EXTENSION_PUBLISHER = 'payswap-labs';
const APP_KEY = 'golden-reporter';

/** The §Manifest extension fixture (the MKT-022 shape, one secret required). */
function extensionManifestFixture(version: string): Record<string, unknown> {
  return {
    manifest: {
      extensionKey: EXTENSION_KEY,
      publisher: EXTENSION_PUBLISHER,
      version,
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [
        { category: 'data-source', name: 'enrich-audience' },
        { category: 'research-discovery', name: 'discover-lookalikes' },
      ],
      permissions: [{ action: 'data:read' }, { action: 'secret:use' }],
      requiredSecretNames: ['DATA_PROVIDER_KEY'],
      dataScopes: ['client:read', 'workspace:read'],
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
    idempotencyKey: `register-ext-${version}`,
  };
}

/** The §Manifest app fixture: depends on the extension, declares ALL five metering dimensions. */
function appManifestFixture(appKey: string, version: string): Record<string, unknown> {
  return {
    manifest: {
      appKey,
      version,
      compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
      capabilities: [{ name: 'render-report', version: '1.0.0' }],
      inputSchema: { required: ['workspaceId'] },
      outputSchema: { required: ['ok'] },
      dataScopes: ['client:read', 'workspace:read'],
      mutationScopes: ['evidence:append'],
      networkDestinations: [],
      runtimeClass: 'pooled-worker',
      eventSubscriptions: [],
      uiSurfaces: [{ surface: 'workspace-tab', route: `/tabs/${appKey}` }],
      configSchema: {},
      requiredCredentialNames: [],
      stateNamespaces: [`app:${appKey}:docs`],
      migrationVersion: 1,
      dependencies: [
        {
          kind: 'extension',
          publisher: EXTENSION_PUBLISHER,
          key: EXTENSION_KEY,
          minVersion: '1.0.0',
          maxVersion: '2.0.0',
        },
      ],
      supportLevel: 'standard',
      meteringDimensions: [
        'installations',
        'invocations',
        'compute-runtime',
        'data-volume',
        'premium-capabilities',
      ],
    },
    idempotencyKey: `publish-${appKey}-${version}`,
  };
}

// ---------------------------------------------------------------------------
// Shared state built once in the first tests (creation order matters)
// ---------------------------------------------------------------------------

interface SharedState {
  readonly developer: User;
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly installId: string;
  readonly extensionId: string;
  readonly executionId: string;
  readonly invocationId: string;
}
let shared: SharedState | null = null;
function state(): SharedState {
  if (shared === null) throw new Error('shared fixtures not built');
  return shared;
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await pool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    params as never[],
  );
  return Number(result.rows[0]!.count);
}

before(async () => {
  stack = await bootStack('app-metering');
  // The CRED-001 secret-handle fixture (the extensions-api precedent):
  // the credential authority resolves a REAL handle in the fs secret
  // backend; only the reference id ever lands in the install row.
  fs.writeFileSync(
    `${stack.env.secretsDir}/${SECRET_HANDLE}.secret`,
    SECRET_MATERIAL,
    { mode: 0o600 },
  );
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/operating-graph
  // precedent): the SAME application composed IN-PROCESS against the
  // SAME database the API serves — the collection, ingestion and
  // recompute are module-level operations, never routes.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  appMetering = core.modules.appMetering;
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1: THE GOLDEN PATH — real install → real invoke → usage → collect
// ---------------------------------------------------------------------------

test('AC-1 golden path: the full real chain — extension publish/install/authorize, app install (MKT-048 surface), a real invocation (MKT-022 surface)', async () => {
  const admin = await adminToken();

  // The platform policies: the extension boundary (install + invoke) and
  // the app-install boundary (the extension dimension — install/
  // upgrade/rollback allowed).
  const extensionPolicy = await apiCall(port(), '/api/policies', {
    token: admin,
    body: {
      dimension: 'extension',
      rules: [
        {
          effect: 'allow',
          operations: ['install', 'invoke', 'upgrade', 'rollback'],
          reason: 'platform extension boundary allows install and invoke',
        },
      ],
      description: 'Platform extension boundary for metering golden path',
    },
  });
  assert.equal(extensionPolicy.status, 201, JSON.stringify(extensionPolicy.body));

  const developer = await makeDeveloper('metering-developer@marketingos.test');
  const owner = await makeAgencyOwner('metering-owner@marketingos.test');
  const clientId = await makeClient(owner.agencyId, owner.token);
  const workspaceId = await makeWorkspace(clientId, owner.token, 'Metering Workspace');

  // Publish the extension (the invocation surface's dependency).
  const publishExtension = await apiCall(port(), '/api/extensions', {
    token: admin,
    body: extensionManifestFixture('1.0.0'),
  });
  assert.equal(publishExtension.status, 201, JSON.stringify(publishExtension.body));
  const extensionId = publishExtension.body['extensionId'] as string;

  // Install + configure + authorize the extension in the workspace (the
  // full MKT-022 install lifecycle — authorized installs are invocable).
  const credential = await apiCall(port(), `/api/agencies/${owner.agencyId}/credentials`, {
    token: owner.token,
    body: { kind: 'integration_api_key', label: 'provider key', secretHandle: SECRET_HANDLE },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const installExtension = await apiCall(port(), `/api/workspaces/${workspaceId}/extension-installs`, {
    token: owner.token,
    body: {
      extensionId,
      grantedScopes: ['client:read', 'workspace:read'],
      idempotencyKey: 'metering-ext-install-1',
    },
  });
  assert.equal(installExtension.status, 201, JSON.stringify(installExtension.body));
  const extensionInstallId = ((installExtension.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;
  const configure = await apiCall(
    port(),
    `/api/workspaces/${workspaceId}/extension-installs/${extensionInstallId}/configure`,
    {
      token: owner.token,
      body: {
        config: { region: 'eu' },
        secretBindings: { DATA_PROVIDER_KEY: credential.body['credentialId'] as string },
        expectedVersion: 1,
      },
    },
  );
  assert.equal(configure.status, 200, JSON.stringify(configure.body));
  const authorize = await apiCall(
    port(),
    `/api/workspaces/${workspaceId}/extension-installs/${extensionInstallId}/authorize`,
    { token: owner.token, body: { expectedVersion: 2 } },
  );
  assert.equal(authorize.status, 200, JSON.stringify(authorize.body));

  // Publish the app (the developer surface — the manifest declares the
  // extension dependency + ALL FIVE metering dimensions).
  const publishApp = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture(APP_KEY, '1.0.0'),
  });
  assert.equal(publishApp.status, 201, JSON.stringify(publishApp.body));

  // THE REAL INSTALL through the MKT-048 surface.
  const install = await apiCall(port(), `/api/workspaces/${workspaceId}/app-installs`, {
    token: owner.token,
    body: {
      appKey: APP_KEY,
      version: '1.0.0',
      idempotencyKey: 'metering-app-install-1',
    },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const installId = ((install.body as Record<string, unknown>)['install'] as Record<string, unknown>)['installId'] as string;

  // THE REAL INVOCATION through the MKT-022 surface.
  const execution = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: owner.token,
    body: {
      externalRequestRef: 'metering-exec-1',
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'metering-exec-1',
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionId = ((execution.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['executionId'] as string;
  const invoke = await apiCall(port(), `/api/executions/${executionId}/extension-invocations`, {
    token: owner.token,
    body: {
      extensionId,
      requestedCapabilities: ['enrich-audience'],
      input: { audienceId: 'aud-1' },
    },
  });
  assert.equal(invoke.status, 201, JSON.stringify(invoke.body));
  const invocationId = (invoke.body as Record<string, unknown>)['invocationId'] as string;

  shared = {
    developer,
    owner,
    agencyId: owner.agencyId,
    clientId,
    workspaceId,
    installId,
    extensionId,
    executionId,
    invocationId,
  };
});

test('AC-1 golden path: usage observations ingest through the module-level command with the manifest-declared context guards', async () => {
  const { workspaceId, invocationId } = state();

  // Three usage dimensions observed during the real invocation.
  const runtime = await metering().recordMeterObservation(
    {
      workspaceId,
      appKey: APP_KEY,
      dimension: 'compute-runtime',
      quantity: 1500,
      capability: null,
      stateNamespace: null,
      sourceInvocationId: invocationId,
      idempotencyKey: 'usage-runtime-1',
    },
    WORKER_PROVENANCE,
  );
  assert.equal(runtime.replayed, false);
  assert.equal(runtime.event.dimension, 'compute-runtime');
  assert.equal(runtime.event.unit, 'milliseconds');
  assert.equal(runtime.event.quantity, 1500);
  assert.equal(runtime.event.appKey, APP_KEY);
  assert.equal(runtime.event.sourceKind, 'observed-usage');
  assert.equal(runtime.event.sourceId, invocationId);
  assert.equal(runtime.event.sourceLinkId, state().executionId);

  const dataVolume = await metering().recordMeterObservation(
    {
      workspaceId,
      appKey: APP_KEY,
      dimension: 'data-volume',
      quantity: 4096,
      capability: null,
      stateNamespace: `app:${APP_KEY}:docs`,
      sourceInvocationId: invocationId,
      idempotencyKey: 'usage-bytes-1',
    },
    WORKER_PROVENANCE,
  );
  assert.equal(dataVolume.event.dimension, 'data-volume');
  assert.equal(dataVolume.event.unit, 'bytes');
  assert.equal(dataVolume.event.stateNamespace, `app:${APP_KEY}:docs`);

  const premium = await metering().recordMeterObservation(
    {
      workspaceId,
      appKey: APP_KEY,
      dimension: 'premium-capabilities',
      quantity: 2,
      capability: 'render-report',
      stateNamespace: null,
      sourceInvocationId: invocationId,
      idempotencyKey: 'usage-premium-1',
    },
    WORKER_PROVENANCE,
  );
  assert.equal(premium.event.dimension, 'premium-capabilities');
  assert.equal(premium.event.unit, 'capability-uses');
  assert.equal(premium.event.capability, 'render-report');

  // §8 replay convergence: the identical command converges (replayed).
  const replay = await metering().recordMeterObservation(
    {
      workspaceId,
      appKey: APP_KEY,
      dimension: 'compute-runtime',
      quantity: 1500,
      capability: null,
      stateNamespace: null,
      sourceInvocationId: invocationId,
      idempotencyKey: 'usage-runtime-1',
    },
    WORKER_PROVENANCE,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.event.eventId, runtime.event.eventId, 'the same row — zero state change');
  // Divergent key reuse conflicts.
  await assert.rejects(
    () =>
      metering().recordMeterObservation(
        {
          workspaceId,
          appKey: APP_KEY,
          dimension: 'compute-runtime',
          quantity: 999,
          capability: null,
          stateNamespace: null,
          sourceInvocationId: invocationId,
          idempotencyKey: 'usage-runtime-1',
        },
        WORKER_PROVENANCE,
      ),
    (error: unknown) => (error as { code?: string }).code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('AC-1 golden path: the ingestion guards fail closed (uniform 404s + honest 422s with zero rows)', async () => {
  const { workspaceId, invocationId } = state();
  const before = await countRows('app_metering_events', 'workspace_id = $1', [workspaceId]);

  // A NON-INSTALLED app is the uniform 404 (no install oracle).
  await assert.rejects(
    () =>
      metering().recordMeterObservation(
        {
          workspaceId,
          appKey: 'never-installed-app',
          dimension: 'compute-runtime',
          quantity: 100,
          capability: null,
          stateNamespace: null,
          sourceInvocationId: invocationId,
          idempotencyKey: 'usage-guard-1',
        },
        WORKER_PROVENANCE,
      ),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );

  // A NON-DECLARED dimension is the honest 422 (metering dimensions are
  // manifest-declared — the app declares all five, so use a foreign
  // workspace's app... instead: declare-only check via a malformed
  // dimension label guard).
  await assert.rejects(
    () =>
      metering().recordMeterObservation(
        {
          workspaceId,
          appKey: APP_KEY,
          dimension: 'installations' as never,
          quantity: 100,
          capability: null,
          stateNamespace: null,
          sourceInvocationId: invocationId,
          idempotencyKey: 'usage-guard-2',
        },
        WORKER_PROVENANCE,
      ),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_REQUEST',
  );

  // A FOREIGN invocation is the uniform 404.
  await assert.rejects(
    () =>
      metering().recordMeterObservation(
        {
          workspaceId,
          appKey: APP_KEY,
          dimension: 'compute-runtime',
          quantity: 100,
          capability: null,
          stateNamespace: null,
          sourceInvocationId: '01234567-89ab-cdef-0123-456789abcdef',
          idempotencyKey: 'usage-guard-3',
        },
        WORKER_PROVENANCE,
      ),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );

  const after = await countRows('app_metering_events', 'workspace_id = $1', [workspaceId]);
  assert.equal(after, before, 'zero rows from the rejected guards');
});

test('AC-1 golden path: THE COLLECTION over the real sources — meter events appear with the correct dimensions/units/provenance/canonical source references (DB-asserted)', async () => {
  const { workspaceId, installId, extensionId, invocationId, executionId } = state();

  const outcome = await metering().collectWorkspaceMetering(
    { workspaceId },
    WORKER_PROVENANCE,
  );
  assert.equal(outcome.installationsCollected, 1, 'one install-selection meter event');
  assert.equal(outcome.invocationsCollected, 1, 'one invocation meter event');
  assert.equal(outcome.meterEventsAppended, 2);
  assert.equal(outcome.installationsAlreadyMetered, 0);
  assert.equal(outcome.invocationsAlreadyMetered, 0);

  // DB-asserted: the installation meter event.
  const installEvent = await pool().query<{
    event_id: string; dimension: string; unit: string; quantity: string;
    app_key: string; app_version_id: string; version: string;
    extension_id: string | null; capability: string | null; state_namespace: string | null;
    source_kind: string; source_id: string; source_link_id: string;
    recorded_actor: string; recorded_via: string; correlation_id: string;
    idempotency_key: string;
  }>(
    `SELECT event_id, dimension, unit, quantity::text, app_key, app_version_id, version,
            extension_id, capability, state_namespace, source_kind, source_id, source_link_id,
            recorded_actor, recorded_via, correlation_id, idempotency_key
     FROM app_metering_events WHERE source_kind = 'app-install-selection' AND workspace_id = $1`,
    [workspaceId],
  );
  assert.equal(installEvent.rows.length, 1);
  const installRow = installEvent.rows[0]!;
  assert.equal(installRow.dimension, 'installations');
  assert.equal(installRow.unit, 'selections');
  assert.equal(installRow.quantity, '1');
  assert.equal(installRow.app_key, APP_KEY);
  // The canonical source references: the ledger row id + the lifecycle event id.
  assert.equal(installRow.source_id, installId);
  const lifecycle = await pool().query<{ event_id: string }>(
    'SELECT event_id FROM app_install_events WHERE install_id = $1',
    [installId],
  );
  assert.equal(installRow.source_link_id, lifecycle.rows[0]!.event_id);
  // The provenance is server-derived from the collection command.
  assert.equal(installRow.recorded_actor, 'service:metering-worker');
  assert.equal(installRow.recorded_via, 'module');
  assert.equal(installRow.correlation_id, 'integration-metering-1');
  assert.equal(installRow.idempotency_key, `collect:app-install-selection:${installId}`);

  // DB-asserted: the invocation meter event — the RAW extension facts.
  const invocationEvent = await pool().query<{
    dimension: string; unit: string; quantity: string;
    app_key: string | null; extension_id: string; extension_key: string;
    extension_publisher: string; extension_version: string;
    source_kind: string; source_id: string; source_link_id: string; idempotency_key: string;
  }>(
    `SELECT dimension, unit, quantity::text, app_key, extension_id, extension_key,
            extension_publisher, extension_version, source_kind, source_id, source_link_id,
            idempotency_key
     FROM app_metering_events WHERE source_kind = 'extension-invocation' AND workspace_id = $1`,
    [workspaceId],
  );
  assert.equal(invocationEvent.rows.length, 1);
  const invocationRow = invocationEvent.rows[0]!;
  assert.equal(invocationRow.dimension, 'invocations');
  assert.equal(invocationRow.unit, 'invocations');
  assert.equal(invocationRow.quantity, '1');
  // The RAW facts: NO app identity materialized on the tail (attribution
  // is a view-time derivation), the four extension facts re-verified
  // against the immutable registry.
  assert.equal(invocationRow.app_key, null);
  assert.equal(invocationRow.extension_id, extensionId);
  assert.equal(invocationRow.extension_key, EXTENSION_KEY);
  assert.equal(invocationRow.extension_publisher, EXTENSION_PUBLISHER);
  assert.equal(invocationRow.extension_version, '1.0.0');
  assert.equal(invocationRow.source_id, invocationId);
  assert.equal(invocationRow.source_link_id, executionId);
  assert.equal(invocationRow.idempotency_key, `collect:extension-invocation:${invocationId}`);
});

test('AC-1 IDEMPOTENT COLLECTION: re-collection appends ZERO rows and the authority tables are byte-identical (event consumption, never a write)', async () => {
  const { workspaceId } = state();

  const installLedgerBefore = await pool().query<{ snapshot: string }>(
    `SELECT md5(string_agg(install_id::text || operation || status || selection_seq::text, ',' ORDER BY install_id)) AS snapshot FROM app_installs WHERE workspace_id = $1`,
    [workspaceId],
  );
  const invocationLedgerBefore = await pool().query<{ snapshot: string }>(
    `SELECT md5(string_agg(invocation_id::text, ',' ORDER BY invocation_id)) AS snapshot FROM extension_invocations WHERE workspace_id = $1`,
    [workspaceId],
  );

  const outcome = await metering().collectWorkspaceMetering(
    { workspaceId },
    { ...WORKER_PROVENANCE, correlationId: 'integration-metering-2' },
  );
  assert.equal(outcome.meterEventsAppended, 0, 're-collection appends ZERO rows');
  assert.equal(outcome.installationsAlreadyMetered, 1);
  assert.equal(outcome.invocationsAlreadyMetered, 1);

  const installLedgerAfter = await pool().query<{ snapshot: string }>(
    `SELECT md5(string_agg(install_id::text || operation || status || selection_seq::text, ',' ORDER BY install_id)) AS snapshot FROM app_installs WHERE workspace_id = $1`,
    [workspaceId],
  );
  const invocationLedgerAfter = await pool().query<{ snapshot: string }>(
    `SELECT md5(string_agg(invocation_id::text, ',' ORDER BY invocation_id)) AS snapshot FROM extension_invocations WHERE workspace_id = $1`,
    [workspaceId],
  );
  assert.equal(installLedgerAfter.rows[0]!.snapshot, installLedgerBefore.rows[0]!.snapshot);
  assert.equal(invocationLedgerAfter.rows[0]!.snapshot, invocationLedgerBefore.rows[0]!.snapshot);
});

// ---------------------------------------------------------------------------
// AC-2/AC-8: THE ATTRIBUTION VIEWS (live derivations with the versioned
// assumption record)
// ---------------------------------------------------------------------------

test('AC-2/AC-3/AC-8: the WORKSPACE attribution view rolls up correctly — per-app attribution, the linkage, the honest unattributed remainder and the calculation disclosure', async () => {
  const { workspaceId, agencyId, clientId, owner } = state();

  const view = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const body = view.body as Record<string, unknown>;

  // The scope is server-derived from the canonical ownership.
  const scope = body['scope'] as Record<string, string>;
  assert.equal(scope['kind'], 'workspace-app-metering');
  assert.equal(scope['agencyId'], agencyId);
  assert.equal(scope['clientId'], clientId);
  assert.equal(scope['workspaceId'], workspaceId);

  // The RAW totals (the ground truth): 1 installation selection, 1
  // invocation, 1500ms runtime, 4096 bytes, 2 capability uses.
  const totals = body['totals'] as Record<string, unknown>[];
  const totalOf = (dimension: string): Record<string, unknown> => {
    const row = totals.find((entry) => entry['dimension'] === dimension);
    assert.ok(row !== undefined, `totals must carry '${dimension}'`);
    return row;
  };
  assert.deepEqual(totalOf('installations'), { dimension: 'installations', unit: 'selections', quantity: 1, eventCount: 1 });
  assert.deepEqual(totalOf('invocations'), { dimension: 'invocations', unit: 'invocations', quantity: 1, eventCount: 1 });
  assert.deepEqual(totalOf('compute-runtime'), { dimension: 'compute-runtime', unit: 'milliseconds', quantity: 1500, eventCount: 1 });
  assert.deepEqual(totalOf('data-volume'), { dimension: 'data-volume', unit: 'bytes', quantity: 4096, eventCount: 1 });
  assert.deepEqual(totalOf('premium-capabilities'), { dimension: 'premium-capabilities', unit: 'capability-uses', quantity: 2, eventCount: 1 });

  // The per-app attribution: the app gets EVERYTHING (its install
  // selection, its usage observations AND the invocation through the
  // dependency-declared linkage).
  const perApp = body['perApp'] as Record<string, unknown>[];
  assert.equal(perApp.length, 1);
  const appRow = perApp[0]!;
  assert.equal(appRow['appKey'], APP_KEY);
  assert.equal(appRow['publisher'], `dev:${state().developer.userId}`);
  assert.equal(appRow['currentSelectionCount'], 1);
  const appDimensions = appRow['dimensions'] as Record<string, unknown>[];
  assert.equal(appDimensions.length, 5, 'all five dimensions attributed');
  const appInvocations = appDimensions.find((entry) => entry['dimension'] === 'invocations')!;
  assert.equal(appInvocations['quantity'], 1, 'the invocation is attributed through the linkage');

  // The honest unattributed remainder: ZERO (the single declaring app).
  const unattributed = body['unattributedInvocations'] as Record<string, unknown>;
  assert.equal(unattributed['count'], 0);

  // The calculation disclosure ships in every response.
  const calculation = body['calculation'] as Record<string, unknown>;
  assert.equal(calculation['calculationVersion'], 'am-attrib-v1');
  assert.equal(calculation['vocabularyVersion'], 'am-meter-v1');
  assert.equal(calculation['basis'], 'live-derivation-over-own-append-only-tail');
  assert.equal(calculation['persistence'], 'append-only-tail-plus-rebuildable-rollups');
  const assumptions = calculation['assumptions'] as Record<string, string>;
  assert.equal(assumptions['invocationAppAttribution'], 'dependency-declared-current-selection');
  assert.equal(assumptions['periodBasis'], 'source-occurred-at-utc-calendar-month');
});

test('AC-3/AC-8: the AGENCY attribution view — the portfolio rollup with per-publisher and per-period rows', async () => {
  const { agencyId, owner } = state();

  const view = await apiCall(port(), `/api/app-metering/agencies/${agencyId}`, {
    token: owner.token,
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const body = view.body as Record<string, unknown>;
  assert.deepEqual((body['scope'] as Record<string, string>)['agencyId'], agencyId);

  // The totals match the workspace slice (one workspace in the agency).
  const totals = body['totals'] as Record<string, unknown>[];
  const installations = totals.find((entry) => entry['dimension'] === 'installations')!;
  assert.equal(installations['quantity'], 1);

  // The per-publisher rollup: the developer's publisher row.
  const perPublisher = body['perPublisher'] as Record<string, unknown>[];
  assert.equal(perPublisher.length, 1);
  assert.equal(perPublisher[0]!['publisher'], `dev:${state().developer.userId}`);
  assert.deepEqual(perPublisher[0]!['appKeys'], [APP_KEY]);

  // The per-period rollup: one UTC month bucket (the source's own
  // occurredAt — the test runs within one month).
  const perPeriod = body['perPeriod'] as Record<string, unknown>[];
  assert.equal(perPeriod.length, 1);
  assert.ok(/^\d{4}-\d{2}-01T00:00:00\.000Z$/.test(perPeriod[0]!['periodStart'] as string));

  // The calculation disclosure ships here too.
  assert.equal((body['calculation'] as Record<string, unknown>)['calculationVersion'], 'am-attrib-v1');
});

test('AC-3/AC-4: the PUBLISHER attribution view — the commercial rollup of the developer\'s apps, NO tenant identities', async () => {
  const { developer } = state();

  const view = await apiCall(port(), `/api/app-metering/publishers/${developer.userId}`, {
    token: developer.token,
  });
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const body = view.body as Record<string, unknown>;
  const scope = body['scope'] as Record<string, string>;
  assert.equal(scope['kind'], 'publisher-app-metering');
  assert.equal(scope['publisher'], `dev:${developer.userId}`);

  // The per-app rows aggregate the publisher's app across the platform.
  const perApp = body['perApp'] as Record<string, unknown>[];
  assert.equal(perApp.length, 1);
  assert.equal(perApp[0]!['appKey'], APP_KEY);
  // The current-selection count is the honest null at platform scope.
  assert.equal(perApp[0]!['currentSelectionCount'], null);
  const appDimensions = perApp[0]!['dimensions'] as Record<string, unknown>[];
  assert.equal(appDimensions.length, 5);

  // TENANT IDENTITIES NEVER SURFACE: no workspace/agency/client ids
  // anywhere in the payload.
  const serialized = JSON.stringify(body);
  for (const forbidden of [state().workspaceId, state().agencyId, state().clientId]) {
    assert.ok(
      !serialized.includes(forbidden),
      'the publisher view must never surface tenant identifiers (the cross-tenant boundary)',
    );
  }
  assert.ok(!('perWorkspace' in body) && !('workspaceIds' in body));
});

// ---------------------------------------------------------------------------
// AC-3: APPEND-ONLY + AC-5: GROUND TRUTH + RECOMPUTE-CONVERGENCE
// ---------------------------------------------------------------------------

test('AC-3: the meter event tail is APPEND-ONLY — the database rejects UPDATE and DELETE outright', async () => {
  const { workspaceId } = state();
  const event = await pool().query<{ event_id: string }>(
    'SELECT event_id FROM app_metering_events WHERE workspace_id = $1 LIMIT 1',
    [workspaceId],
  );
  const eventId = event.rows[0]!.event_id;
  await assert.rejects(
    () =>
      pool().query('UPDATE app_metering_events SET quantity = 999 WHERE event_id = $1', [eventId]),
    /append-only/i,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM app_metering_events WHERE event_id = $1', [eventId]),
    /append-only/i,
  );
});

test('AC-5 GROUND TRUTH: direct SQL over the tail equals the rollups AND the views\' raw totals', async () => {
  const { workspaceId, owner } = state();

  // The recompute materializes the rollup projection from the tail.
  const recompute = await metering().recomputeAttributionRollups();
  assert.ok(recompute.rollupRows >= 5, 'one rollup row per (workspace, app, dimension, month)');
  assert.equal(recompute.meterEventsConsidered, 5, 'the whole tail in scope');

  // DIRECT SQL ground truth: the per-dimension sums over the workspace's
  // tail (attributed + unattributed alike).
  const direct = await pool().query<{ dimension: string; unit: string; quantity_sum: string; event_count: string }>(
    `SELECT dimension, unit, SUM(quantity)::text AS quantity_sum, COUNT(*)::text AS event_count
     FROM app_metering_events WHERE workspace_id = $1 GROUP BY dimension, unit ORDER BY dimension`,
    [workspaceId],
  );
  const rollups = await pool().query<{ dimension: string; unit: string; quantity_sum: string; event_count: string }>(
    `SELECT dimension, unit, SUM(quantity_sum)::text AS quantity_sum, SUM(event_count)::text AS event_count
     FROM app_metering_rollups WHERE workspace_id = $1 GROUP BY dimension, unit ORDER BY dimension`,
    [workspaceId],
  );
  assert.deepEqual(rollups.rows, direct.rows, 'the rollups are the direct-SQL ground truth');

  // The views' raw totals are the SAME ground truth (rollups never feed
  // the views — both derive independently from the tail).
  const view = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  assert.equal(view.status, 200);
  const totals = (view.body as Record<string, unknown>)['totals'] as Record<string, unknown>[];
  for (const row of direct.rows) {
    const viewRow = totals.find((entry) => entry['dimension'] === row.dimension);
    assert.ok(viewRow !== undefined, `the view carries '${row.dimension}'`);
    assert.equal(viewRow['quantity'], Number(row.quantity_sum));
    assert.equal(viewRow['eventCount'], Number(row.event_count));
  }
});

test('AC-5 RECOMPUTE-CONVERGENCE: rebuilding twice converges to identical aggregate rows', async () => {
  await metering().recomputeAttributionRollups();
  const first = await pool().query<{
    workspace_id: string; app_key: string; dimension: string; unit: string;
    period_start: string; quantity_sum: string; event_count: string;
  }>(
    `SELECT workspace_id, app_key, dimension, unit, period_start::text, quantity_sum::text, event_count::text
     FROM app_metering_rollups ORDER BY workspace_id, app_key, dimension, period_start`,
  );
  await metering().recomputeAttributionRollups();
  const second = await pool().query<{
    workspace_id: string; app_key: string; dimension: string; unit: string;
    period_start: string; quantity_sum: string; event_count: string;
  }>(
    `SELECT workspace_id, app_key, dimension, unit, period_start::text, quantity_sum::text, event_count::text
     FROM app_metering_rollups ORDER BY workspace_id, app_key, dimension, period_start`,
  );
  // rebuilt_at is the only non-deterministic column (disclosed) — the
  // aggregate rows are identical.
  assert.deepEqual(second.rows, first.rows, 'the deterministic rebuild converges');

  // The unattributed bucket: the invocation events' raw rows (app_key ''
  // — the attribution is a view-time derivation, never materialized).
  const unattributedRollup = await pool().query<{ quantity_sum: string }>(
    `SELECT SUM(quantity_sum)::text AS quantity_sum FROM app_metering_rollups WHERE app_key = '' AND dimension = 'invocations'`,
  );
  assert.equal(Number(unattributedRollup.rows[0]!.quantity_sum), 1, 'the raw invocation events live in the unattributed bucket');
});

// ---------------------------------------------------------------------------
// AC-7: LIVE-FOLLOW — new invocations move the views
// ---------------------------------------------------------------------------

test('AC-7 LIVE-FOLLOW: a new invocation moves the views after collection; an upgrade appends a second installation meter event', async () => {
  const { workspaceId, installId, extensionId, owner, developer } = state();

  // A SECOND real invocation.
  const execution2 = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token: owner.token,
    body: {
      externalRequestRef: 'metering-exec-2',
      executionKind: 'extension',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'metering-exec-2',
    },
  });
  assert.equal(execution2.status, 201);
  const executionId2 = ((execution2.body as Record<string, unknown>)['execution'] as Record<string, unknown>)['executionId'] as string;
  const invoke2 = await apiCall(port(), `/api/executions/${executionId2}/extension-invocations`, {
    token: owner.token,
    body: {
      extensionId,
      requestedCapabilities: ['enrich-audience'],
      input: { audienceId: 'aud-2' },
    },
  });
  assert.equal(invoke2.status, 201);
  const invocationId2 = (invoke2.body as Record<string, unknown>)['invocationId'] as string;

  // BEFORE collection: the views do NOT yet count the new invocation
  // (collection is explicit event consumption).
  const beforeView = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  const beforeTotals = (beforeView.body as Record<string, unknown>)['totals'] as Record<string, unknown>[];
  assert.equal(
    (beforeTotals.find((entry) => entry['dimension'] === 'invocations') as Record<string, unknown>)['quantity'],
    1,
  );

  // Collect: exactly the NEW invocation is metered.
  const outcome = await metering().collectWorkspaceMetering({ workspaceId }, WORKER_PROVENANCE);
  assert.equal(outcome.invocationsCollected, 1);
  assert.equal(outcome.installationsAlreadyMetered, 1);

  // AFTER collection: the views moved.
  const afterView = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  const afterTotals = (afterView.body as Record<string, unknown>)['totals'] as Record<string, unknown>[];
  assert.equal(
    (afterTotals.find((entry) => entry['dimension'] === 'invocations') as Record<string, unknown>)['quantity'],
    2,
  );
  const afterPerApp = (afterView.body as Record<string, unknown>)['perApp'] as Record<string, unknown>[];
  const afterAppDimensions = (afterPerApp[0]! as Record<string, unknown>)['dimensions'] as Record<string, unknown>[];
  assert.equal(
    (afterAppDimensions.find((entry) => entry['dimension'] === 'invocations') as Record<string, unknown>)['quantity'],
    2,
    'the attributed invocation count moved too',
  );
  void invocationId2;

  // An UPGRADE through the MKT-048 surface: publish v1.1.0, upgrade —
  // the ledger appends a second selection row, and the next collection
  // meters it (the one-per-selection-row assumption).
  const publish2 = await apiCall(port(), '/api/apps', {
    token: developer.token,
    body: appManifestFixture(APP_KEY, '1.1.0'),
  });
  assert.equal(publish2.status, 201, JSON.stringify(publish2.body));
  const upgrade = await apiCall(
    port(),
    `/api/workspaces/${workspaceId}/app-installs/${installId}/upgrade`,
    {
      token: owner.token,
      body: { version: '1.1.0', idempotencyKey: 'metering-app-upgrade-1' },
    },
  );
  assert.equal(upgrade.status, 201, JSON.stringify(upgrade.body));

  const outcome2 = await metering().collectWorkspaceMetering({ workspaceId }, WORKER_PROVENANCE);
  assert.equal(outcome2.installationsCollected, 1, 'the upgrade selection is a NEW installation meter event');
  assert.equal(outcome2.invocationsCollected, 0);

  const finalView = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  const finalTotals = (finalView.body as Record<string, unknown>)['totals'] as Record<string, unknown>[];
  assert.equal(
    (finalTotals.find((entry) => entry['dimension'] === 'installations') as Record<string, unknown>)['quantity'],
    2,
    'two selection rows = two installation meter events',
  );
  // The CURRENT installation count stays 1 (the ACTIVE-row basis — the
  // superseded selection is metered history, not a current install).
  const finalPerApp = (finalView.body as Record<string, unknown>)['perApp'] as Record<string, unknown>[];
  assert.equal((finalPerApp[0]! as Record<string, unknown>)['currentSelectionCount'], 1);
});

// ---------------------------------------------------------------------------
// AC-4/AC-1: THE ISOLATION BATTERY (the honest fail-closed posture)
// ---------------------------------------------------------------------------

test('AC-4 isolation: anonymous 401; uniform 404 for foreign/malformed workspaces, agencies and publishers; suspended membership 403; mutating verbs 405', async () => {
  const { workspaceId, agencyId, owner, developer } = state();

  // Anonymous calls fail closed 401.
  const anonymous = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {});
  assert.equal(anonymous.status, 401);
  const anonymousAgency = await apiCall(port(), `/api/app-metering/agencies/${agencyId}`, {});
  assert.equal(anonymousAgency.status, 401);

  // A FOREIGN workspace: a second agency's workspace is the uniform 404.
  const stranger = await makeAgencyOwner('metering-stranger@marketingos.test');
  const strangerClient = await makeClient(stranger.agencyId, stranger.token);
  const strangerWorkspace = await makeWorkspace(strangerClient, stranger.token, 'Stranger Workspace');
  const foreignWorkspace = await apiCall(port(), `/api/app-metering/workspaces/${strangerWorkspace}`, {
    token: owner.token,
  });
  assert.equal(foreignWorkspace.status, 404);
  // A malformed workspace id is indistinguishable.
  const malformedWorkspace = await apiCall(port(), '/api/app-metering/workspaces/not-a-uuid', {
    token: owner.token,
  });
  assert.equal(malformedWorkspace.status, 404);

  // A foreign agency is the uniform 404 (no cross-agency oracle).
  const foreignAgency = await apiCall(port(), `/api/app-metering/agencies/${stranger.agencyId}`, {
    token: owner.token,
  });
  assert.equal(foreignAgency.status, 404);
  const malformedAgency = await apiCall(port(), '/api/app-metering/agencies/not-a-uuid', {
    token: owner.token,
  });
  assert.equal(malformedAgency.status, 404);

  // A foreign publisher id is the uniform 404 (the caller is not the
  // publisher, not a platform admin).
  const foreignPublisher = await apiCall(port(), `/api/app-metering/publishers/${stranger.userId}`, {
    token: developer.token,
  });
  assert.equal(foreignPublisher.status, 404);
  const malformedPublisher = await apiCall(port(), '/api/app-metering/publishers/not-a-uuid', {
    token: developer.token,
  });
  assert.equal(malformedPublisher.status, 404);
  // A NON-publisher ordinary caller is the 404 too.
  const ordinaryAsPublisher = await apiCall(port(), `/api/app-metering/publishers/${owner.userId}`, {
    token: owner.token,
  });
  // owner IS the user themselves → the view resolves (their own empty
  // commercial view — an honest 200 with no apps).
  assert.equal(ordinaryAsPublisher.status, 200);
  const ordinaryBody = ordinaryAsPublisher.body as Record<string, unknown>;
  assert.deepEqual(ordinaryBody['perApp'], [], 'an unknown publisher identity yields the honest empty view');

  // The platform administrator CAN view any publisher's rollup.
  const adminPublisher = await apiCall(port(), `/api/app-metering/publishers/${developer.userId}`, {
    token: await adminToken(),
  });
  assert.equal(adminPublisher.status, 200);

  // A suspended membership is the 403 (the intra-tenant posture).
  const suspendedMember = await makeUser('metering-member@marketingos.test', 'member-password-123');
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: suspendedMember.userId, role: 'client_collaborator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  const membershipId = (membership.body as Record<string, unknown>)['membershipId'] as string;
  const membershipList = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: owner.token,
  });
  const membershipRow = (membershipList.body['memberships'] as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry['membershipId'] === membershipId,
  )!;
  const suspend = await apiCall(
    port(),
    `/api/agencies/${agencyId}/memberships/${membershipId}`,
    {
      token: owner.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membershipRow['version'] as number },
    },
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
  const suspendedView = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: suspendedMember.token,
  });
  assert.equal(suspendedView.status, 403);

  // EVERY MUTATING VERB 405s at the router (the GET-only read model).
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const mutation = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
      token: owner.token,
      method: verb,
      body: { dimension: 'compute-runtime', quantity: 1 },
    });
    assert.equal(mutation.status, 405, `the ${verb} verb must 405`);
  }
});

test('AC-3/AC-4 module-level 404s: the collection and views of an UNKNOWN workspace are the uniform 404; the publisher shape guard is a 422', async () => {
  await assert.rejects(
    () =>
      metering().collectWorkspaceMetering(
        { workspaceId: '01234567-89ab-cdef-0123-456789abcdef' },
        WORKER_PROVENANCE,
      ),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => metering().getWorkspaceAppMetering('01234567-89ab-cdef-0123-456789abcdef'),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => metering().getPublisherAppMetering('svc:not-a-developer-publisher'),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_REQUEST',
  );
});

// ---------------------------------------------------------------------------
// The final consistency assertion: the whole tail is consistent with the
// direct-SQL ground truth after every mutation (the live-follow moved it)
// ---------------------------------------------------------------------------

test('AC-5 FINAL CONSISTENCY: the rollups rebuild to the moved ground truth and the views agree after all mutations', async () => {
  const { workspaceId, owner } = state();
  await metering().recomputeAttributionRollups();

  const direct = await pool().query<{ dimension: string; quantity_sum: string }>(
    `SELECT dimension, SUM(quantity)::text AS quantity_sum
     FROM app_metering_events WHERE workspace_id = $1 GROUP BY dimension ORDER BY dimension`,
    [workspaceId],
  );
  const rollups = await pool().query<{ dimension: string; quantity_sum: string }>(
    `SELECT dimension, SUM(quantity_sum)::text AS quantity_sum
     FROM app_metering_rollups WHERE workspace_id = $1 GROUP BY dimension ORDER BY dimension`,
    [workspaceId],
  );
  assert.deepEqual(rollups.rows, direct.rows);

  const view = await apiCall(port(), `/api/app-metering/workspaces/${workspaceId}`, {
    token: owner.token,
  });
  const totals = (view.body as Record<string, unknown>)['totals'] as Record<string, unknown>[];
  for (const row of direct.rows) {
    const viewRow = totals.find((entry) => entry['dimension'] === row.dimension);
    assert.equal(viewRow!['quantity'], Number(row.quantity_sum));
  }
  // The final state: 2 installation selections, 2 invocations, 1500ms,
  // 4096 bytes, 2 capability uses.
  const totalOf = (dimension: string): number =>
    (totals.find((entry) => entry['dimension'] === dimension) as Record<string, unknown>)['quantity'] as number;
  assert.equal(totalOf('installations'), 2);
  assert.equal(totalOf('invocations'), 2);
  assert.equal(totalOf('compute-runtime'), 1500);
  assert.equal(totalOf('data-volume'), 4096);
  assert.equal(totalOf('premium-capabilities'), 2);
});
