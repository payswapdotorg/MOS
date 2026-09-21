/**
 * MKT-056 integration tests — the Social Platform Adapter Contract on the
 * REAL stack: embedded PostgreSQL 18, the spawned production API and the
 * IN-PROCESS application composed with the disclosed adapter doubles
 * through the AppOptions seams. The CONTRACT HOST under test is fully
 * real (the capability gates, the scope pre-check, the /policies
 * fail-closed gates, the migration-050 idempotency fence, the
 * claim-then-fill ledger); the reference in-memory platform is the
 * disclosed test double at the provider boundary ONLY.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-056; the
 * dispatch acceptance "capability-subset support, adapter conformance
 * suite, no platform-specific knowledge outside adapter subtrees"):
 *   - CAPABILITY-SUBSET SUPPORT: the FULL reference platform (all five
 *     families) and the READ-ONLY partial platform (account +
 *     content-read only) BOTH pass the conformance suite — a
 *     capability-subset adapter is FIRST-CLASS and the undeclared
 *     families fail closed with ZERO provider traffic;
 *   - ADAPTER CONFORMANCE SUITE: the reusable battery
 *     (tests/integration/helpers/social-adapter-conformance.ts) executes
 *     end-to-end against the reference double — registry data, the
 *     account identity/scope propagation (the VERBATIM MKT-055 facts),
 *     the content/analytics/restriction reads, the publish lifecycle
 *     (submit → replay idempotency → status observations), the
 *     fail-closed unknown-op/scope/policy refusals, the dead-binding
 *     and lazy-expiry batteries, cross-client isolation, the
 *     unknown-platform refusal and the direct DB fences;
 *   - THE PUBLISH TAXONOMY ON THE LEDGER: provider-failed submits and
 *     restricted outcomes record their taxonomy codes / restriction
 *     signals on the attempt rows; pre-flight-refused keys burn
 *     honestly (a same-key retry after the fix returns the recorded
 *     refusal as a duplicate — the caller resubmits under a NEW key).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import {
  createLocalOAuthFlow,
  startLocalOAuthProvider,
  type LocalOAuthProvider,
} from './helpers/oauth-provider.ts';
import {
  createReferenceSocialAdapter,
  readOnlyReferenceCapabilities,
  REFERENCE_SOCIAL_ADAPTER_KEY,
  type ReferenceSocialAdapter,
} from './helpers/reference-social-adapter.ts';
import { runSocialAdapterConformanceSuite, createReferenceIntegrationStub } from './helpers/social-adapter-conformance.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import type { SocialAccountsModuleApi } from '../../src/modules/social-accounts/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import type { IntegrationsModuleApi } from '../../src/modules/integrations/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PIPE_SECRET_HANDLE = 'social-adapter-contract-pipe-key';

const PROVENANCE = {
  actor: 'user:00000000-0000-7000-8000-0000000000cc',
  recordedVia: 'test',
  correlationId: 'integration-social-adapter-contract-1',
  causationId: null,
} as const;

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let provider: LocalOAuthProvider | null = null;
let accounts: SocialAccountsModuleApi | null = null;
let integrationsHandle: IntegrationsModuleApi | null = null;
let credentialsHandle: CredentialsModuleApi | null = null;
let referenceAdapter: ReferenceSocialAdapter | null = null;

function module(): SocialAccountsModuleApi {
  if (accounts === null) throw new Error('application not bootstrapped');
  return accounts;
}
function integrationsModule(): IntegrationsModuleApi {
  if (integrationsHandle === null) throw new Error('application not bootstrapped');
  return integrationsHandle;
}
function credentialsModule(): CredentialsModuleApi {
  if (credentialsHandle === null) throw new Error('application not bootstrapped');
  return credentialsHandle;
}
function adapter(): ReferenceSocialAdapter {
  if (referenceAdapter === null) throw new Error('reference adapter not constructed');
  return referenceAdapter;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool() {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

before(async () => {
  stack = await bootStack('social_adapter');
  fs.writeFileSync(`${stack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`, JSON.stringify({ accessToken: 'pipe-bearer' }), {
    mode: 0o600,
  });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  provider = await startLocalOAuthProvider();
  referenceAdapter = createReferenceSocialAdapter();
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    integrationAdapters: [createReferenceIntegrationStub(REFERENCE_SOCIAL_ADAPTER_KEY)],
    socialAccountFlows: [
      createLocalOAuthFlow(provider, { adapterKey: REFERENCE_SOCIAL_ADAPTER_KEY, secretsDir: stack.env.secretsDir }),
    ],
    socialPlatformAdapters: [referenceAdapter],
  });
  accounts = core.modules.socialAccounts;
  integrationsHandle = core.modules.integrations;
  credentialsHandle = core.modules.credentials;
});

after(async () => {
  await provider?.close();
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
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

async function makeAgencyOwner(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', { token: admin, body: { email, displayName: email.split('@')[0]! } });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: 'owner-pass-123' } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: 'owner-pass-123' } });
  assert.equal(login.status, 200);
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  return { userId, token: login.body['token'] as string, agencyId: (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string };
}

async function makeClient(principal: Principal): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/clients`, {
    token: principal.token,
    body: { name: `Client ${principal.agencyId.slice(0, 8)}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

async function allowAll(principal: Principal, dimension: 'network' | 'secrets'): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension,
      rules: [{ effect: 'allow', operations: ['*'], reason: 'integration test allowance' }],
      description: `Integration test ${dimension} allowance`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

let connectionSequence = 0;
/** Creates + connects the reference-platform integration connection through the IN-PROCESS modules. */
async function makePlatformConnection(principal: Principal, clientId: string): Promise<string> {
  // The connection is created through the IN-PROCESS integrations module
  // (the spawned production API has no knowledge of the reference stub —
  // the AppOptions seam applies to the in-process composition; both share
  // the SAME database).
  connectionSequence += 1;
  const credential = await credentialsModule().createCredentialReference({
    agencyId: principal.agencyId,
    clientId,
    kind: 'integration_api_key',
    // NOTE: the credential-label grammar allows NO dashes (underscores
    // instead — the migration-005 pattern) and the (agency, label) pair
    // is fenced among live references — hence the sequence suffix.
    label: `adapter_contract_${clientId.slice(0, 8)}_${connectionSequence}`,
    secretHandle: PIPE_SECRET_HANDLE,
    actorId: null,
  });
  const registered = await integrationsModule().registerConnection(
    {
      clientId,
      adapterKey: REFERENCE_SOCIAL_ADAPTER_KEY,
      credentialReferenceId: credential.credentialId,
      providerConfig: { apiBaseUrl: provider!.url },
    },
    PROVENANCE,
  );
  const connected = await integrationsModule().connectConnection(
    { connectionId: registered.connectionId, expectedVersion: 1 },
    PROVENANCE,
  );
  assert.equal(connected.status, 'connected');
  return registered.connectionId;
}

/** The full OAuth handshake through the real module + the flow double. */
async function connectAccount(
  clientId: string,
  connectionId: string,
  fixture: {
    readonly accountId: string;
    readonly scopes: readonly string[];
    readonly capabilityTags?: readonly string[];
  },
): Promise<string> {
  const start = await module().startAuthorization(
    { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: [...fixture.scopes], expectedAccountId: null },
    PROVENANCE,
  );
  const issued = provider!.issueAuthorization({
    accountId: fixture.accountId,
    displayIdentity: `adapter:${fixture.accountId}`,
    verifiedAt: '2026-07-01T09:30:00.000Z',
    scopes: [...fixture.scopes],
    capabilityTags: fixture.capabilityTags ?? ['adapter-tag'],
    expiresInMs: 3_600_000,
  });
  const completion = await module().completeAuthorization(
    { clientId, state: start.grant.stateToken, code: issued.code },
    PROVENANCE,
  );
  return completion.account.socialAccountId;
}

const FULL_SCOPES = ['account:read', 'content:read', 'analytics:read', 'content:write'];
const PUBLISH_REQUEST = {
  contentType: 'reference-post',
  payload: { title: 'Adapter contract publish', body: 'The normalized request.' },
  mediaAssets: [{ assetReference: 'content-asset:1', mediaKind: 'video', descriptor: { filename: 'clip.mp4' } }],
  attribution: { missionId: 'mission-adapter-1' },
  scheduledFor: null,
} as const;

// ---------------------------------------------------------------------------
// The conformance suite executes (the dispatch AC-2 proof)
// ---------------------------------------------------------------------------

test('AC-2: the FULL reference platform passes the social adapter conformance suite', async () => {
  const suiteProvider = await startLocalOAuthProvider();
  const suiteAdapter = createReferenceSocialAdapter();
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'full',
    });
    assert.equal(report.failed, 0);
    assert.ok(report.scenarios.length >= 12, `expected the full battery, got ${report.scenarios.length} scenarios`);
    for (const scenario of report.scenarios) assert.equal(scenario.ok, true);
  } finally {
    await suiteProvider.close();
  }
});

test('AC-1: the READ-ONLY partial platform passes the suite (capability-subset support is first-class)', async () => {
  const suiteProvider = await startLocalOAuthProvider();
  const suiteAdapter = createReferenceSocialAdapter({ capabilities: readOnlyReferenceCapabilities() });
  try {
    const report = await runSocialAdapterConformanceSuite({
      adapter: suiteAdapter,
      adapterHandle: suiteAdapter,
      provider: suiteProvider,
      label: 'partial',
    });
    assert.equal(report.failed, 0);
    const names = report.scenarios.map((scenario) => scenario.name).join('\n');
    assert.ok(names.includes('capability-subset enforcement'), 'the subset-enforcement scenario ran');
    assert.ok(!names.includes('publish submit'), 'the publish scenarios are correctly absent for the read-only platform');
  } finally {
    await suiteProvider.close();
  }
});

// ---------------------------------------------------------------------------
// The publish taxonomy on the ledger (direct module-level battery)
// ---------------------------------------------------------------------------

test('the provider-failed submit records the taxonomy failure code on the attempt row', async () => {
  const principal = await makeAgencyOwner('taxonomy-failed@adapter.test');
  const clientId = await makeClient(principal);
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makePlatformConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { accountId: 'taxonomy-failed-1', scopes: FULL_SCOPES });

  adapter().setFailure('submitPublish', 'rate-limited', 'the reference platform quota is exhausted');
  const submit = await module().submitPublish(
    accountId,
    { idempotencyKey: 'taxonomy-failed-key', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'rate-limited', 'the taxonomy code rides the attempt row');
  assert.ok(submit.attempt.providerPublishId === null, 'no provider publish reference exists');
  adapter().clearFailure('submitPublish');

  // The DB row carries the CHECK-fenced code.
  const row = await pool().query<{ publish_state: string; failure_code: string }>(
    'SELECT publish_state, failure_code FROM social_publish_attempts WHERE attempt_id = $1',
    [submit.attempt.attemptId],
  );
  assert.equal(row.rows[0]!.publish_state, 'failed');
  assert.equal(row.rows[0]!.failure_code, 'rate-limited');

  // The failed key replays as the RECORDED refusal (the fence holds the
  // outcome; a caller fixes the quota and resubmits under a NEW key).
  const replay = await module().submitPublish(
    accountId,
    { idempotencyKey: 'taxonomy-failed-key', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.attempt.failureCode, 'rate-limited');
  assert.equal(
    adapter().publishesForIdempotencyKey('taxonomy-failed-key').length,
    0,
    'the scripted provider failure never recorded a provider publish — and the replay added none',
  );
});

test('the restricted submit records the observable restriction signals on the attempt row', async () => {
  const principal = await makeAgencyOwner('restricted@adapter.test');
  const clientId = await makeClient(principal);
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makePlatformConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { accountId: 'restricted-1', scopes: FULL_SCOPES });

  adapter().setNextSubmitState('restricted');
  const submit = await module().submitPublish(
    accountId,
    { idempotencyKey: 'restricted-key', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  adapter().setNextSubmitState('accepted');
  assert.equal(submit.attempt.publishState, 'restricted');
  assert.equal(submit.attempt.failureCode, null, 'a restricted outcome is not a taxonomy failure — the signals carry it');
  assert.equal(submit.attempt.restrictionSignals.length, 1);
  assert.equal(submit.attempt.restrictionSignals[0]!.signalKind, 'REFERENCE_ELIGIBILITY_HOLD');

  // The DB row: the CHECK fence demands failure_code NULL on non-failed states.
  const row = await pool().query<{ publish_state: string; failure_code: string | null; restriction_signals: unknown }>(
    'SELECT publish_state, failure_code, restriction_signals FROM social_publish_attempts WHERE attempt_id = $1',
    [submit.attempt.attemptId],
  );
  assert.equal(row.rows[0]!.publish_state, 'restricted');
  assert.equal(row.rows[0]!.failure_code, null);
  assert.ok(Array.isArray(row.rows[0]!.restriction_signals) && row.rows[0]!.restriction_signals.length === 1);
});

test('the insufficient-scope pre-flight refusal burns the key honestly (recorded + duplicate on replay)', async () => {
  const principal = await makeAgencyOwner('scope-burn@adapter.test');
  const clientId = await makeClient(principal);
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makePlatformConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, {
    accountId: 'scope-burn-1',
    scopes: ['account:read'], // content:write missing — publish refuses pre-flight
  });

  const before = adapter().callCount('submitPublish');
  const submit = await module().submitPublish(
    accountId,
    { idempotencyKey: 'scope-burn-key', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  assert.equal(submit.duplicate, false);
  assert.equal(submit.attempt.publishState, 'failed');
  assert.equal(submit.attempt.failureCode, 'insufficient-scope');
  assert.equal(adapter().callCount('submitPublish'), before, 'zero provider traffic');

  // The replay returns the recorded refusal — the same key NEVER becomes
  // a different operation (the caller resubmits under a NEW key).
  const replay = await module().submitPublish(
    accountId,
    { idempotencyKey: 'scope-burn-key', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.attempt.failureCode, 'insufficient-scope');
  assert.equal(adapter().callCount('submitPublish'), before, 'still zero provider traffic');

  // A NEW key after reauthorization-with-scopes... the read-only account
  // stays refused under any NEW key too (the state did not change).
  const freshKey = await module().submitPublish(
    accountId,
    { idempotencyKey: 'scope-burn-key-2', request: PUBLISH_REQUEST },
    PROVENANCE,
  );
  assert.equal(freshKey.duplicate, false);
  assert.equal(freshKey.attempt.failureCode, 'insufficient-scope');
});

test('the same idempotency key on ANOTHER account is a DIFFERENT publish (the fence is per-account)', async () => {
  const principal = await makeAgencyOwner('per-account@adapter.test');
  const clientId = await makeClient(principal);
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makePlatformConnection(principal, clientId);
  const accountOne = await connectAccount(clientId, connectionId, { accountId: 'per-account-1', scopes: FULL_SCOPES });
  // The frozen MKT-055 binding rule: ONE connection binds ONE platform
  // identity — the second account needs its OWN connection.
  const secondConnectionId = await makePlatformConnection(principal, clientId);
  const accountTwo = await connectAccount(clientId, secondConnectionId, { accountId: 'per-account-2', scopes: FULL_SCOPES });

  const first = await module().submitPublish(accountOne, { idempotencyKey: 'shared-key', request: PUBLISH_REQUEST }, PROVENANCE);
  const second = await module().submitPublish(accountTwo, { idempotencyKey: 'shared-key', request: PUBLISH_REQUEST }, PROVENANCE);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, false, 'the fence is per (account, key) — another account is a different publish');
  assert.notEqual(first.attempt.attemptId, second.attempt.attemptId);
  assert.equal(adapter().publishesForIdempotencyKey('shared-key').length, 2);
});

test('the malformed publish request refuses BEFORE any fence row exists (InvalidRequestError, zero rows)', async () => {
  const principal = await makeAgencyOwner('malformed@adapter.test');
  const clientId = await makeClient(principal);
  await allowAll(principal, 'network');
  await allowAll(principal, 'secrets');
  const connectionId = await makePlatformConnection(principal, clientId);
  const accountId = await connectAccount(clientId, connectionId, { accountId: 'malformed-1', scopes: FULL_SCOPES });

  const before = (await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM social_publish_attempts')).rows[0]!.count;
  await assert.rejects(
    () =>
      module().submitPublish(
        accountId,
        {
          idempotencyKey: 'malformed-key',
          request: {
            contentType: 'reference-post',
            payload: { accessToken: 'ey1234567890abcdefghij' }, // §21 material-shaped value — refused
            mediaAssets: [],
            attribution: {},
            scheduledFor: null,
          },
        },
        PROVENANCE,
      ),
    (error: unknown) =>
      error instanceof InvalidRequestError &&
      (error.details ?? []).some((detail) => detail.includes('material-shaped')),
    'the §21 backstop rejects the material-shaped payload',
  );
  await assert.rejects(
    () =>
      module().submitPublish(
        accountId,
        { idempotencyKey: 'bad key with spaces!', request: PUBLISH_REQUEST },
        PROVENANCE,
      ),
    () => true,
    'the idempotency-key shape guard refuses',
  );
  const after = (await pool().query<{ count: string }>('SELECT count(*)::text AS count FROM social_publish_attempts')).rows[0]!.count;
  assert.equal(after, before, 'ZERO fence rows from malformed requests');
});

test('the unsupported-capability publish refusal records honestly (undeclared publish operation)', async () => {
  // A platform declaring the publish family with submit ONLY (a
  // synchronous publisher — getPublishStatus deliberately absent).
  const synchronousOnly = createReferenceSocialAdapter({
    capabilities: [
      {
        family: 'account',
        operations: ['verifyAccountIdentity', 'getAccountProfile'],
        requiredScopes: ['account:read'],
        description: 'Account family (test).',
      },
      {
        family: 'publish',
        operations: ['submitPublish'],
        requiredScopes: ['content:write'],
        description: 'Synchronous publish only — no status polling (test).',
      },
    ],
  });
  const suiteProvider = await startLocalOAuthProvider();
  try {
    // Compose a THROWAWAY in-process app with the synchronous adapter +
    // its own stack: the module construction must accept the subset.
    const throwawayStack = await bootStack('social_sync_publish');
    fs.writeFileSync(
      `${throwawayStack.env.secretsDir}/${PIPE_SECRET_HANDLE}.secret`,
      JSON.stringify({ accessToken: 'pipe-bearer' }),
      { mode: 0o600 },
    );
    const throwawayApi = await spawnApi(throwawayStack.env, {
      MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
      MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
    });
    const savedEnv = { ...process.env };
    process.env.MOS_DATABASE_URL = throwawayStack.env.databaseUrl;
    process.env.MOS_INTERNAL_API_TOKEN = throwawayStack.env.internalApiToken;
    process.env.MOS_ENV = 'test';
    process.env.MOS_OBJECT_STORE = 'fs';
    process.env.MOS_OBJECT_STORE_DIR = throwawayStack.env.objectStoreDir;
    process.env.MOS_SECRETS_DIR = throwawayStack.env.secretsDir;
    const { createReferenceIntegrationStub } = await import('./helpers/social-adapter-conformance.ts');
    const core = await bootstrapApplication({
      integrationAdapters: [createReferenceIntegrationStub(REFERENCE_SOCIAL_ADAPTER_KEY)],
      socialAccountFlows: [
        createLocalOAuthFlow(suiteProvider, { adapterKey: REFERENCE_SOCIAL_ADAPTER_KEY, secretsDir: throwawayStack.env.secretsDir }),
      ],
      socialPlatformAdapters: [synchronousOnly],
    });
    const throwawayAccounts = core.modules.socialAccounts;
    const throwawayIntegrations = core.modules.integrations;
    const throwawayCredentials = core.modules.credentials;

    // Fixtures through the throwaway API.
    let throwawayAdminToken: string | null = null;
    const login = await apiCall(throwawayApi.port, '/api/auth/login', {
      body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
    });
    assert.equal(login.status, 200);
    throwawayAdminToken = login.body['token'] as string;
    const userCreate = await apiCall(throwawayApi.port, '/api/users', {
      token: throwawayAdminToken,
      body: { email: 'sync@adapter.test', displayName: 'sync' },
    });
    assert.equal(userCreate.status, 201);
    const userId = userCreate.body['userId'] as string;
    await apiCall(throwawayApi.port, `/api/users/${userId}/credential`, { token: throwawayAdminToken, body: { password: 'sync-pass-123' } });
    const userLogin = await apiCall(throwawayApi.port, '/api/auth/login', { body: { email: 'sync@adapter.test', password: 'sync-pass-123' } });
    const token = userLogin.body['token'] as string;
    const agency = await apiCall(throwawayApi.port, '/api/agencies', {
      token: throwawayAdminToken,
      body: { name: 'Sync Agency', ownerUserId: userId },
    });
    const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
    const client = await apiCall(throwawayApi.port, `/api/agencies/${agencyId}/clients`, { token, body: { name: 'Sync Client' } });
    const clientId = client.body['clientId'] as string;
    for (const dimension of ['network', 'secrets'] as const) {
      const declaredPolicy = await apiCall(throwawayApi.port, `/api/agencies/${agencyId}/policies`, {
        token,
        body: { dimension, rules: [{ effect: 'allow', operations: ['*'], reason: 'allow' }], description: 'allow' },
      });
      assert.equal(declaredPolicy.status, 201);
    }
    const credential = await throwawayCredentials.createCredentialReference({
      agencyId,
      clientId,
      kind: 'integration_api_key',
      label: 'sync_pipe',
      secretHandle: PIPE_SECRET_HANDLE,
      actorId: null,
    });
    const registered = await throwawayIntegrations.registerConnection(
      {
        clientId,
        adapterKey: REFERENCE_SOCIAL_ADAPTER_KEY,
        credentialReferenceId: credential.credentialId,
        providerConfig: {},
      },
      PROVENANCE,
    );
    const connected = await throwawayIntegrations.connectConnection(
      { connectionId: registered.connectionId, expectedVersion: 1 },
      PROVENANCE,
    );
    const connectionId = registered.connectionId;
    assert.equal(connected.status, 'connected');

    const start = await throwawayAccounts.startAuthorization(
      { clientId, integrationConnectionId: connectionId, workspaceId: null, requestedScopes: FULL_SCOPES, expectedAccountId: null },
      PROVENANCE,
    );
    const issued = suiteProvider.issueAuthorization({
      accountId: 'sync-1',
      displayIdentity: 'sync:1',
      verifiedAt: null,
      scopes: FULL_SCOPES,
      capabilityTags: [],
      expiresInMs: 3_600_000,
    });
    const completion = await throwawayAccounts.completeAuthorization(
      { clientId, state: start.grant.stateToken, code: issued.code },
      PROVENANCE,
    );
    const accountId = completion.account.socialAccountId;

    // submitPublish WORKS (declared); the immediate 'published' state
    // carries the provider content id.
    synchronousOnly.setNextSubmitState('published');
    const submit = await throwawayAccounts.submitPublish(
      accountId,
      { idempotencyKey: 'sync-key', request: PUBLISH_REQUEST },
      PROVENANCE,
    );
    assert.equal(submit.attempt.publishState, 'published');
    assert.ok(submit.attempt.providerContentId !== null);

    // refreshPublishStatus on the synchronous platform: getPublishStatus
    // is NOT declared — the poll is refused fail-closed as data (the
    // honest observation records the 'unsupported-capability' refusal;
    // the provider was never called).
    const pollsBefore = synchronousOnly.callCount('getPublishStatus');
    const refresh = await throwawayAccounts.refreshPublishStatus(accountId, submit.attempt.attemptId, PROVENANCE);
    assert.equal(refresh.observation.failureCode, 'unsupported-capability', 'the undeclared status poll refuses as data');
    assert.equal(refresh.attempt.publishState, 'published', 'the attempt row is untouched by the refused poll');
    assert.equal(synchronousOnly.callCount('getPublishStatus'), pollsBefore, 'the provider status endpoint was never called');

    throwawayApi.child.kill('SIGKILL');
    await shutdownStack(throwawayStack);
    process.env.MOS_DATABASE_URL = savedEnv.MOS_DATABASE_URL ?? '';
    process.env.MOS_INTERNAL_API_TOKEN = savedEnv.MOS_INTERNAL_API_TOKEN ?? '';
    process.env.MOS_OBJECT_STORE_DIR = savedEnv.MOS_OBJECT_STORE_DIR ?? '';
    process.env.MOS_SECRETS_DIR = savedEnv.MOS_SECRETS_DIR ?? '';
  } finally {
    await suiteProvider.close();
  }
});
