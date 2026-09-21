/**
 * MKT-071 integration tests — the COMMERCE CATALOG AND ORDER CAPABILITIES
 * on the REAL stack: embedded PostgreSQL 18, a real API process whose
 * composition root wires the REAL commerce adapters (the extended
 * read-only commerce-cms connector + the new full-surface commerce-store
 * connector), the in-process LOOPBACK commerce provider double
 * (tests/integration/helpers/commerce-provider.ts — the oauth-provider.ts
 * house pattern) for the commerce-store provider and the MKT-024 sandbox
 * provider for the commerce/CMS platform. REAL HTTP calls over the
 * fetch-based platform HttpCallPort, NO real store SDK, NO external
 * network.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-071: "normalized
 * catalog/order/listing capabilities with webhook idempotency and
 * policy-gated mutations"; spec/architecture-v1.6.md §15/§16):
 *
 *   - AC-1/AC-7 ROUND-TRIP: catalog (paged: page 1 → cursor → page 2) →
 *     product read → listing lifecycle (create/update/end, authorized +
 *     unauthorized variants) → price/inventory reads → orders (revenue +
 *     full line-item records) → webhook (first delivery + replay) →
 *     event history read-back — through the ROUTE surfaces AND the
 *     module-level operations;
 *   - AC-2 PROVIDER CONTRACT: the deterministic commerce provider double
 *     exercising the full capability surface, partial-capability variants
 *     (a read-only token), pagination, the error taxonomy (provider-down,
 *     unauthorized, rate-limited, invalid-scope) and webhook delivery;
 *   - AC-3 WEBHOOK IDEMPOTENCY: first delivery appends ONE ledger event +
 *     ONE evidence + ONE 'ingested' projection row behind the
 *     (provider id, event id) fence; a REPLAY is a no-op that surfaces
 *     honestly as a 'duplicate-received' history row (never a silent
 *     drop); the raw surface refuses replays fail-closed (ConflictError);
 *   - AC-4 POLICY-GATED MUTATIONS: every mutating commerce operation
 *     passes the /integrations policy gate WITH ITS OWN capability key
 *     (a capability-scoped deny blocks product writes while listing
 *     management stays allowed; a client-scoped mutate deny blocks
 *     everything with ZERO provider traffic); the read-only commerce
 *     adapter never declares mutations (422 at capability discovery);
 *     the read-only provider token gets the honest 403 invalid-scope
 *     refusal as DATA;
 *   - AC-5 ATTRIBUTION PASSTHROUGH: order records + webhook events carry
 *     the provider's attribution/reference fields VERBATIM (no linking,
 *     matching or causal computation anywhere);
 *   - AC-6 EVENT STREAM CONTINUITY: verified deliveries append into the
 *     EXISTING integration-events ledger + /evidence path; the fence and
 *     the event stream compose (webhook → dedup → normalized append);
 *   - AC-8 FAIL-CLOSED ISOLATION: uniform 404 foreign≡unknown≡malformed,
 *     suspended membership 403, anonymous 401 (the house battery);
 *   - AC-9 the commerce mutation ledger + event history read-backs.
 *
 * Credential materials are FAKE sandbox strings ASSEMBLED AT RUNTIME
 * (the §21 posture: they exist only in the secrets-dir files and
 * in-process; never in repository content).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import {
  commerceWebhookSignature,
  startCommerceProvider,
  type CommerceProvider,
} from './helpers/commerce-provider.ts';
import {
  startSandboxProvider,
  type SandboxProvider,
} from './helpers/sandbox-provider.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { createIntegrationsModule } from '../../src/modules/integrations/public.ts';
import type {
  IntegrationAdapter,
  IntegrationProvenance,
} from '../../src/modules/integrations/public.ts';
import type { PoliciesModuleApi } from '../../src/modules/policies/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import { ConflictError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

// ---------------------------------------------------------------------------
// FAKE sandbox credential strings — assembled at RUNTIME (the §21
// posture: they live only in the secrets-dir fixture files and
// in-process).
// ---------------------------------------------------------------------------
const STORE_FULL_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxStoreFullToken';
const STORE_READONLY_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxStoreReadOnlyToken';
const STORE_WEBHOOK_SECRET = 'whsec_' + 'Store' + 'FakeSandbox';
const CMS_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxCmsCommerceToken';
const CMS_WEBHOOK_SECRET = 'whsec_' + 'Cms' + 'FakeSandbox';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let store: CommerceProvider | null = null;
let sandbox: SandboxProvider | null = null;
let db: PgDb | null = null;

let adminTokenValue = '';
let aliceTokenValue = '';
let aliceAgencyId = '';
let clientAId = '';
let bobTokenValue = '';
let bobAgencyId = '';
let clientBId = '';

let aliceStoreFullCredentialId = '';
let aliceStoreReadonlyCredentialId = '';
let aliceCmsCredentialId = '';
let bobStoreCredentialId = '';

let aliceStoreFullConnectionId = '';
let aliceStoreReadonlyConnectionId = '';
let aliceCmsConnectionId = '';
let bobStoreConnectionId = '';

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function storeUrl(): string {
  if (store === null) throw new Error('commerce provider not started');
  return store.url;
}

/** The pipeline nests typed application errors under an `error` key. */
function errorBody(response: { readonly body: Record<string, unknown> }): Record<string, unknown> {
  const nested = response.body['error'];
  return (nested !== null && typeof nested === 'object' ? nested : response.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fixtures (real users/agencies/clients/credentials through the API)
// ---------------------------------------------------------------------------

async function adminToken(): Promise<string> {
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  return login.body['token'] as string;
}

async function makePrincipal(email: string): Promise<{ userId: string; token: string; agencyId: string }> {
  const admin = adminTokenValue;
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
    body: { name: `Agency ${email.split('@')[0]!}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'a-very-long-password-123' },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string, agencyId };
}

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

async function makeCredential(
  agencyId: string,
  token: string,
  label: string,
  secretHandle: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label, secretHandle },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['credentialId'] as string;
}

function provisionSecret(handle: string, material: string): void {
  fs.writeFileSync(path.join(stack!.env.secretsDir, `${handle}.secret`), material, { mode: 0o600 });
}

async function declarePlatformPolicy(dimension: string): Promise<void> {
  const declared = await apiCall(port(), '/api/policies', {
    token: adminTokenValue,
    body: {
      dimension,
      rules: [
        {
          effect: 'allow',
          operations: ['*'],
          reason: 'MKT-071 integration-test platform boundary: integration egress and credential use explicitly allowed',
        },
      ],
      description: `MKT-071 integration-test platform default (${dimension} dimension)`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

async function registerConnection(
  token: string,
  clientId: string,
  adapterKey: string,
  credentialReferenceId: string,
  providerConfig: Record<string, string>,
): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token,
    body: { adapterKey, credentialReferenceId, providerConfig },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['connectionId'] as string;
}

async function connectConnection(
  token: string,
  clientId: string,
  connectionId: string,
  expectedHealth: 'healthy' | 'degraded' = 'healthy',
): Promise<void> {
  const current = await apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}`, { token });
  assert.equal(current.status, 200);
  const connected = await apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/connect`, {
    token,
    body: { expectedVersion: current.body['version'] as number },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'connected');
  assert.equal(connected.body['health'], expectedHealth);
}

/**
 * Reconnects a connection after an EXPECTED provider-failure outcome (the
 * frozen bookkeeping semantics: an ok=false call marks the pipe
 * 'error'/unreachable — health bookkeeping, not a terminal state).
 */
async function reconnectAfterExpectedFailure(token: string, clientId: string, connectionId: string): Promise<void> {
  await connectConnection(token, clientId, connectionId);
}

async function read(
  token: string,
  clientId: string,
  connectionId: string,
  operation: string,
  parameters: Record<string, unknown> = {},
) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/read`, {
    token,
    body: { operation, parameters },
  });
}

async function mutate(
  token: string,
  clientId: string,
  connectionId: string,
  operation: string,
  parameters: Record<string, unknown> = {},
) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/mutate`, {
    token,
    body: { operation, parameters },
  });
}

async function webhook(
  token: string,
  clientId: string,
  connectionId: string,
  eventType: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/webhook`, {
    token,
    body: { eventType, payload, headers },
  });
}

async function commerceEvents(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/commerce-events`, { token });
  assert.equal(response.status, 200);
  return response.body['events'] as Record<string, unknown>[];
}

async function commerceMutations(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/commerce-mutations`, { token });
  assert.equal(response.status, 200);
  return response.body['mutations'] as Record<string, unknown>[];
}

async function clientIntegrationEvents(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/integration-events`, { token });
  assert.equal(response.status, 200);
  return response.body['events'] as Record<string, unknown>[];
}

before(async () => {
  stack = await bootStack('integrations-commerce');

  // The provider materials (FAKE sandbox strings, runtime-assembled; JSON
  // per the first-party provider credential convention). The commerce-store
  // tokens carry the PROVIDER GRANTS (full vs read-only — the
  // partial-capability variants the provider double enforces at runtime).
  provisionSecret(
    'mkt071-store-full-key',
    JSON.stringify({ accessToken: STORE_FULL_TOKEN, webhookSecret: STORE_WEBHOOK_SECRET }),
  );
  provisionSecret(
    'mkt071-store-readonly-key',
    JSON.stringify({ accessToken: STORE_READONLY_TOKEN, webhookSecret: STORE_WEBHOOK_SECRET }),
  );
  provisionSecret(
    'mkt071-cms-key',
    JSON.stringify({ accessToken: CMS_TOKEN, webhookSecret: CMS_WEBHOOK_SECRET }),
  );
  provisionSecret(
    'mkt071-bob-store-key',
    JSON.stringify({ accessToken: STORE_FULL_TOKEN, webhookSecret: STORE_WEBHOOK_SECRET }),
  );

  // The commerce provider double (loopback; per-token grants; NO real
  // network egress) + the MKT-024 sandbox provider (the commerce/CMS
  // platform's read-only surface).
  store = await startCommerceProvider([
    { accessToken: STORE_FULL_TOKEN, scopes: ['commerce.read', 'commerce.write'] },
    { accessToken: STORE_READONLY_TOKEN, scopes: ['commerce.read'] },
  ]);
  sandbox = await startSandboxProvider({ 'commerce-cms': CMS_TOKEN });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  adminTokenValue = await adminToken();

  const alice = await makePrincipal('erin@commerce.test');
  aliceTokenValue = alice.token;
  aliceAgencyId = alice.agencyId;
  clientAId = await makeClient(aliceAgencyId, alice.token, 'Client Commerce A');

  const bob = await makePrincipal('frank@commerce.test');
  bobTokenValue = bob.token;
  bobAgencyId = bob.agencyId;
  clientBId = await makeClient(bobAgencyId, bob.token, 'Client Commerce B');

  // Platform policy defaults: network + secrets dimensions explicitly
  // allow the integration operations (POL-001: without an explicit allow
  // everything denies).
  await declarePlatformPolicy('network');
  await declarePlatformPolicy('secrets');

  // Alice's CLIENT-scoped network policy: the CAPABILITY-SCOPED mutation
  // boundary (AC-4 — the gate carries its own capability key): product
  // writes are denied, listing management stays allowed.
  const aliceScoped = await apiCall(port(), `/api/clients/${clientAId}/policies`, {
    token: aliceTokenValue,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['*'],
          reason: 'MKT-071 test: Alice may use her commerce connections',
        },
        {
          effect: 'deny',
          operations: ['integration.mutate'],
          attributes: { capability: 'commerce-product-write' },
          reason: 'MKT-071 test: capability-scoped product-write deny (the gate carries the capability key)',
        },
      ],
      description: 'MKT-071 client-scoped capability boundary (Alice)',
    },
  });
  assert.equal(aliceScoped.status, 201, JSON.stringify(aliceScoped.body));

  // Bob's CLIENT-scoped network policy: connect + read allowed, EVERY
  // mutation denied — the fail-closed mutation negative tenant.
  const bobDeny = await apiCall(port(), `/api/clients/${clientBId}/policies`, {
    token: bobTokenValue,
    body: {
      dimension: 'network',
      rules: [
        { effect: 'allow', operations: ['integration.connect'], reason: 'MKT-071 test: Bob may probe his connections' },
        { effect: 'allow', operations: ['integration.read'], reason: 'MKT-071 test: Bob may read' },
        { effect: 'deny', operations: ['integration.mutate'], reason: 'MKT-071 test: client-scoped mutate deny (fail-closed negative)' },
      ],
      description: 'MKT-071 client-scoped network boundaries (negative tenant)',
    },
  });
  assert.equal(bobDeny.status, 201, JSON.stringify(bobDeny.body));

  // Credentials (agency-scoped references by logical handle — never the
  // material itself).
  aliceStoreFullCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce store full', 'mkt071-store-full-key');
  aliceStoreReadonlyCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce store readonly', 'mkt071-store-readonly-key');
  aliceCmsCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce/CMS sandbox', 'mkt071-cms-key');
  bobStoreCredentialId = await makeCredential(bobAgencyId, bobTokenValue, 'Commerce store Bob', 'mkt071-bob-store-key');

  // The connections.
  aliceStoreFullConnectionId = await registerConnection(aliceTokenValue, clientAId, 'commerce-store', aliceStoreFullCredentialId, {
    apiBaseUrl: `${storeUrl()}`,
  });
  aliceStoreReadonlyConnectionId = await registerConnection(aliceTokenValue, clientAId, 'commerce-store', aliceStoreReadonlyCredentialId, {
    apiBaseUrl: `${storeUrl()}`,
  });
  aliceCmsConnectionId = await registerConnection(aliceTokenValue, clientAId, 'commerce-cms', aliceCmsCredentialId, {
    apiBaseUrl: `${sandbox!.url}/commerce-cms`,
  });
  bobStoreConnectionId = await registerConnection(bobTokenValue, clientBId, 'commerce-store', bobStoreCredentialId, {
    apiBaseUrl: `${storeUrl()}`,
  });

  await connectConnection(aliceTokenValue, clientAId, aliceStoreFullConnectionId);
  await connectConnection(aliceTokenValue, clientAId, aliceStoreReadonlyConnectionId);
  await connectConnection(aliceTokenValue, clientAId, aliceCmsConnectionId);
  await connectConnection(bobTokenValue, clientBId, bobStoreConnectionId);
});

after(async () => {
  if (db !== null) {
    await db.close();
    db = null;
  }
  if (store !== null) {
    await store.close();
    store = null;
  }
  if (sandbox !== null) {
    await sandbox.close();
    sandbox = null;
  }
  if (api !== null) {
    api.child.kill('SIGKILL');
    api = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1: the normalized capability surface (the registry is honest data)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1: the registry carries BOTH commerce adapters — commerce-store declares the full surface, commerce-cms declares the READ-ONLY subset (no mutation capability)', async () => {
  const response = await apiCall(port(), '/api/integrations/adapters', { token: aliceTokenValue });
  assert.equal(response.status, 200);
  const adapters = response.body['adapters'] as Record<string, unknown>[];
  const storeAdapter = adapters.find((adapter) => adapter['adapterKey'] === 'commerce-store');
  const cmsAdapter = adapters.find((adapter) => adapter['adapterKey'] === 'commerce-cms');
  assert.ok(storeAdapter !== undefined, 'commerce-store is registered');
  assert.ok(cmsAdapter !== undefined, 'commerce-cms is registered');

  const storeCapabilities = storeAdapter['capabilities'] as Record<string, unknown>[];
  const storeKeys = storeCapabilities.map((capability) => capability['capabilityKey']).sort();
  assert.deepEqual(storeKeys, [
    'commerce-catalog-read',
    'commerce-inventory-read',
    'commerce-listing-manage',
    'commerce-order-webhook',
    'commerce-orders-read',
    'commerce-price-read',
    'commerce-product-read',
    'commerce-product-write',
  ]);
  // The mutation capabilities are declared as MUTATIONS on the store.
  for (const key of ['commerce-product-write', 'commerce-listing-manage']) {
    const capability = storeCapabilities.find((entry) => entry['capabilityKey'] === key)!;
    assert.equal(capability['kind'], 'mutation');
  }

  // The READ-ONLY subset (AC-1: a read-only commerce adapter is
  // first-class): the commerce-cms adapter declares the commerce reads but
  // NEVER a mutation capability (AC-4).
  const cmsCapabilities = cmsAdapter['capabilities'] as Record<string, unknown>[];
  const cmsKeys = cmsCapabilities.map((capability) => capability['capabilityKey']);
  assert.ok(cmsKeys.includes('commerce-catalog-read'));
  assert.ok(cmsKeys.includes('commerce-product-read'));
  assert.ok(cmsKeys.includes('commerce-price-read'));
  assert.ok(cmsKeys.includes('commerce-inventory-read'));
  assert.ok(cmsKeys.includes('commerce-orders-read'));
  assert.equal(
    cmsCapabilities.some((capability) => capability['kind'] === 'mutation'),
    false,
    'the read-only commerce adapter never claims a mutation capability',
  );
});

// ---------------------------------------------------------------------------
// AC-7: the golden-path round-trip (catalog → products → listing
// lifecycle → price/inventory → orders → webhook → event history)
// ---------------------------------------------------------------------------

test('MKT-071 AC-7: catalog read is PAGED — page 1 → cursor → terminal page', async () => {
  const pageOne = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listCatalog', { limit: 2 });
  assert.equal(pageOne.status, 200, JSON.stringify(pageOne.body));
  assert.equal(pageOne.body['ok'], true);
  assert.equal(pageOne.body['adapterKey'], 'commerce-store');
  assert.equal(pageOne.body['operation'], 'listCatalog');
  const records = pageOne.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 1);
  const pageOneData = records[0]!['data'] as Record<string, unknown>;
  assert.equal(pageOneData['recordType'], 'commerce.catalog-page');
  const fields = pageOneData['fields'] as Record<string, unknown>;
  assert.deepEqual(fields['categories'], [
    { categoryId: 'cat_apparel', title: 'Apparel' },
    { categoryId: 'cat_drinkware', title: 'Drinkware' },
  ]);
  assert.equal((fields['products'] as unknown[]).length, 2);
  assert.equal(fields['nextPageCursor'], 'catalog-page-2');
  assert.ok(typeof pageOne.body['policyDecisionId'] === 'string');

  // The cursor walks to the terminal page.
  const pageTwo = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listCatalog', {
    cursor: fields['nextPageCursor'] as string,
  });
  assert.equal(pageTwo.status, 200);
  assert.equal(pageTwo.body['ok'], true);
  const pageTwoFields = ((pageTwo.body['records'] as Record<string, unknown>[])[0]!['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>;
  assert.deepEqual(pageTwoFields['categories'], [{ categoryId: 'cat_stationery', title: 'Stationery' }]);
  assert.equal(pageTwoFields['nextPageCursor'], null);
});

test('MKT-071 AC-7: product read → the normalized product with attributes passthrough', async () => {
  const product = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'getProduct', { productId: 'prd_5001' });
  assert.equal(product.status, 200, JSON.stringify(product.body));
  assert.equal(product.body['ok'], true);
  const record = (product.body['records'] as Record<string, unknown>[])[0]!;
  assert.equal(record['providerRecordId'], 'commerce:product:prd_5001');
  assert.equal(record['sourceTimestamp'], '2026-05-01T09:30:00.000Z');
  const fields = (record['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>;
  assert.equal(fields['productId'], 'prd_5001');
  assert.equal(fields['title'], 'Organic Cotton Tee');
  assert.deepEqual(fields['attributes'], { material: 'organic-cotton', sizes: ['S', 'M', 'L'] });

  // A missing bounded parameter is a fail-closed data refusal (no provider
  // traffic — the request counter proves it).
  const requestsBefore = store!.requestCount();
  const missing = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'getProduct', {});
  assert.equal(missing.status, 200);
  assert.equal(missing.body['ok'], false);
  assert.ok((missing.body['error'] as string).includes("requires a bounded 'productId' parameter"));
  assert.equal(store!.requestCount(), requestsBefore);
  // The frozen bookkeeping marks the pipe 'error' on the data failure —
  // reconnect for the subsequent tests (health bookkeeping, not terminal).
  await reconnectAfterExpectedFailure(aliceTokenValue, clientAId, aliceStoreFullConnectionId);
});

test('MKT-071 AC-7/AC-4: the listing lifecycle round-trips AUTHORIZED (create → update → end) with the provider-visible side effects recorded exactly', async () => {
  // NOTE: Alice's capability-scoped policy DENIES commerce-product-write —
  // the listing lifecycle (commerce-listing-manage) stays allowed (the
  // capability-scoped battery below proves the deny fires).
  const mutationsBefore = store!.mutations().length;

  const created = await mutate(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'createListing', {
    productId: 'prd_5001',
    title: 'Summer Launch Listing',
    price: '29.90',
    currency: 'EUR',
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body['ok'], true);
  const listingId = created.body['providerRecordId'] as string;
  assert.ok(typeof listingId === 'string' && listingId.startsWith('lst_'));

  const updated = await mutate(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'updateListing', {
    listingId,
    title: 'Summer Launch Listing — Restock',
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body['ok'], true);
  assert.equal(updated.body['providerRecordId'], listingId);

  const ended = await mutate(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'endListing', { listingId });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal(ended.body['ok'], true);
  assert.equal(ended.body['providerRecordId'], listingId);

  // The provider double received EXACTLY the three listing mutations with
  // the forwarded bodies (the adapter is a translator, not an inventor).
  const calls = store!.mutations().slice(mutationsBefore);
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.method, 'POST');
  assert.ok(calls[0]!.path.endsWith('/commerce/v1/listings'));
  assert.equal(calls[0]!.body['productId'], 'prd_5001');
  assert.equal(calls[1]!.method, 'PATCH');
  assert.ok(calls[1]!.path.endsWith(`/commerce/v1/listings/${listingId}`));
  assert.equal(calls[2]!.method, 'POST');
  assert.ok(calls[2]!.path.endsWith(`/commerce/v1/listings/${listingId}/end`));
});

test('MKT-071 AC-7: price and inventory reads map to the normalized observations', async () => {
  const price = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'getPrice', { productId: 'prd_5001' });
  assert.equal(price.status, 200);
  assert.equal(price.body['ok'], true);
  const priceFields = (((price.body['records'] as Record<string, unknown>[])[0]!['data'] as Record<string, unknown>)['fields']) as Record<string, unknown>;
  assert.equal(priceFields['amount'], 29.9);
  assert.equal(priceFields['currency'], 'EUR');
  assert.equal(priceFields['priceId'], 'price_9001');

  const inventory = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'getInventory', { productId: 'prd_5001' });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body['ok'], true);
  const inventoryFields = (((inventory.body['records'] as Record<string, unknown>[])[0]!['data'] as Record<string, unknown>)['fields']) as Record<string, unknown>;
  assert.equal(inventoryFields['available'], 148);
  assert.equal(inventoryFields['total'], 160);
});

test('MKT-071 AC-7/AC-5: order reads — revenue continuity + the FULL line-item records with attribution VERBATIM (paged)', async () => {
  // The MKT-024 revenue continuity on the store connector.
  const revenue = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listOrders');
  assert.equal(revenue.status, 200, JSON.stringify(revenue.body));
  assert.equal(revenue.body['ok'], true);
  const revenueRecord = (revenue.body['records'] as Record<string, unknown>[])[0]!;
  assert.equal(revenueRecord['providerRecordId'], 'commerce:order:ord_2001:revenue');
  const envelope = revenueRecord['data'] as Record<string, unknown>;
  assert.equal(envelope['metricName'], 'commerce.revenue');
  assert.equal(envelope['value'], 89.7);
  assert.equal(envelope['unit'], 'EUR');

  // The full order records: line-item shape + attribution passthrough.
  const pageOne = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listOrderRecords');
  assert.equal(pageOne.status, 200, JSON.stringify(pageOne.body));
  assert.equal(pageOne.body['ok'], true);
  const records = pageOne.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 1);
  const order = records[0]!;
  assert.equal(order['providerRecordId'], 'commerce:order-record:ord_2001');
  const fields = (order['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>;
  assert.equal(fields['orderNumber'], 'STORE-2001');
  assert.deepEqual(fields['lineItems'], [
    { lineItemId: 'li_01', productId: 'prd_5001', title: 'Organic Cotton Tee', quantity: 3, unitPrice: 29.9 },
  ]);
  // AC-5: the provider's attribution/reference fields ride VERBATIM.
  assert.deepEqual(fields['attribution'], {
    ref: 'mos_msn_7f3e_attribution',
    source: 'social',
    campaign: 'summer-launch',
    contentId: 'post_9812',
  });
  assert.equal(fields['nextPageCursor'], 'order-records-page-2');

  // The paged walk reaches the attribution-free second order.
  const pageTwo = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listOrderRecords', {
    cursor: 'order-records-page-2',
  });
  assert.equal(pageTwo.status, 200);
  const secondFields = (((pageTwo.body['records'] as Record<string, unknown>[])[0]!['data'] as Record<string, unknown>)['fields']) as Record<string, unknown>;
  assert.equal(secondFields['orderId'], 'ord_2002');
  assert.equal(secondFields['attribution'], null, 'no attribution is fabricated when the provider carries none');
});

// ---------------------------------------------------------------------------
// AC-4: the policy-gated mutation battery (with its own capability key)
// ---------------------------------------------------------------------------

test('MKT-071 AC-4: a CAPABILITY-SCOPED policy deny blocks product writes while listing management stays allowed (the gate carries the capability key)', async () => {
  const mutationsBefore = store!.mutations().length;

  // Alice's client-scoped rule denies integration.mutate with
  // capability='commerce-product-write' — the product write is blocked
  // BEFORE any provider traffic.
  const denied = await mutate(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'createProduct', {
    title: 'Blocked Tee',
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');
  assert.equal(store!.mutations().length, mutationsBefore, 'ZERO provider mutations under the deny');

  // The denial is in the append-only policy-decision ledger (the honest
  // 403-equivalent error record).
  const decisions = await apiCall(port(), `/api/clients/${clientAId}/policy-decisions`, {
    token: aliceTokenValue,
  });
  assert.equal(decisions.status, 200);
  const listed = decisions.body['decisions'] as Record<string, unknown>[];
  assert.ok(
    listed.some((decision) => decision['dimension'] === 'network' && decision['reasonCode'] === 'rule-denied'),
    'the capability-scoped deny is recorded in the policy decision ledger',
  );

  // Listing management (commerce-listing-manage) is NOT covered by the
  // scoped deny — it proceeds.
  const allowed = await mutate(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'createListing', {
    productId: 'prd_5002',
    title: 'Allowed Listing',
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body['ok'], true);
  assert.equal(store!.mutations().length, mutationsBefore + 1);
});

test('MKT-071 AC-4: a client-scoped MUTATE deny blocks EVERY commerce mutation with ZERO provider traffic (the negative tenant)', async () => {
  const mutationsBefore = store!.mutations().length;
  const denied = await mutate(bobTokenValue, clientBId, bobStoreConnectionId, 'createProduct', {
    title: 'Bob Blocked Product',
  });
  assert.equal(denied.status, 403);
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');
  assert.equal(store!.mutations().length, mutationsBefore, 'ZERO provider mutations under the deny');
});

test('MKT-071 AC-4: the read-only commerce ADAPTER rejects mutations at capability discovery (422 — it never claims a mutation capability)', async () => {
  const rejected = await mutate(aliceTokenValue, clientAId, aliceCmsConnectionId, 'createProduct', {
    title: 'CMS Product',
  });
  assert.equal(rejected.status, 422, JSON.stringify(rejected.body));
  assert.equal(errorBody(rejected)['code'], 'INVALID_REQUEST');
  assert.ok(
    (errorBody(rejected)['details'] as string[]).some((detail) =>
      detail.includes("not declared by any mutation capability of adapter 'commerce-cms'"),
    ),
  );
});

test('MKT-071 AC-2/AC-4: the read-only provider TOKEN gets the honest invalid-scope refusal as DATA (the runtime authorization layer)', async () => {
  // The policy ALLOWS the mutation (the scoped deny covers product writes
  // only) — the PROVIDER refuses it: the read-only token lacks
  // commerce.write (the runtime per-connection authorization layer).
  const requestsBefore = store!.requestCount();
  const mutationsBefore = store!.mutations().length;
  const refused = await mutate(aliceTokenValue, clientAId, aliceStoreReadonlyConnectionId, 'createListing', {
    productId: 'prd_5001',
    title: 'Read-only Refused Listing',
  });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  // The honest provider refusal: ok=false + the 403 invalid-scope error.
  assert.equal(refused.body['ok'], false);
  assert.ok((refused.body['error'] as string).includes('HTTP 403'));
  // The request DID reach the provider (the runtime authorization layer —
  // unlike the policy gate, which blocks before any traffic) but produced
  // ZERO provider-visible side effects.
  assert.equal(store!.requestCount(), requestsBefore + 1);
  assert.equal(store!.mutations().length, mutationsBefore, 'a refused mutation has NO provider side effect');
  const connection = refused.body['connection'] as Record<string, unknown>;
  assert.equal(connection['status'], 'error');
  assert.equal(connection['health'], 'unreachable');
  // Reconnect the read-only connection after the expected refusal.
  await reconnectAfterExpectedFailure(aliceTokenValue, clientAId, aliceStoreReadonlyConnectionId);

  // The mutation ledger records the honest refusal (AC-9: the outcome
  // lands with its capability key — never silenced).
  const ledger = await commerceMutations(aliceTokenValue, clientAId);
  const refusal = ledger.find(
    (entry) => entry['ok'] === false && entry['operation'] === 'createListing' && entry['capabilityKey'] === 'commerce-listing-manage',
  );
  assert.ok(refusal !== undefined, 'the invalid-scope refusal is recorded in the commerce mutation ledger');
  assert.ok(typeof refusal!['policyDecisionId'] === 'string');
});

test('MKT-071 AC-9: the commerce mutation ledger read-back carries every gated mutation with its capability key', async () => {
  const ledger = await commerceMutations(aliceTokenValue, clientAId);
  assert.ok(ledger.length >= 4, 'the listing lifecycle + the refusal are recorded');
  const okListingMutations = ledger.filter((entry) => entry['ok'] === true && entry['capabilityKey'] === 'commerce-listing-manage');
  assert.ok(okListingMutations.length >= 4, 'the listing lifecycle (create/update/end + the capability-scoped battery listing) is recorded');
  for (const entry of okListingMutations) {
    assert.equal(entry['adapterKey'], 'commerce-store');
    assert.ok(typeof entry['policyDecisionId'] === 'string');
    assert.ok(typeof entry['provenance'] === 'object');
  }
});

// ---------------------------------------------------------------------------
// AC-2: the error taxonomy (provider-down, unauthorized, rate-limited)
// ---------------------------------------------------------------------------

test('MKT-071 AC-2: provider-down — the transport refusal is an honest data failure with connection bookkeeping', async () => {
  store!.setMode('down');
  try {
    const down = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listCatalog');
    assert.equal(down.status, 200);
    assert.equal(down.body['ok'], false);
    assert.ok((down.body['error'] as string).includes('provider unreachable'));
    const connection = down.body['connection'] as Record<string, unknown>;
    assert.equal(connection['status'], 'error');
    assert.equal(connection['health'], 'unreachable');
  } finally {
    store!.setMode('ok');
  }
  // The pipe is operational plumbing, never terminal: the connect
  // transition restores it, and the next read succeeds.
  await reconnectAfterExpectedFailure(aliceTokenValue, clientAId, aliceStoreFullConnectionId);
  const recovered = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listCatalog');
  assert.equal(recovered.status, 200);
  assert.equal(recovered.body['ok'], true);
});

test('MKT-071 AC-2: unauthorized — a wrong bearer token gets the honest 401 data failure', async () => {
  // A connection whose credential material carries a token the provider
  // does not know (the read-only token IS known — so register a fresh
  // credential with a WRONG token).
  provisionSecret('mkt071-wrong-token-key', JSON.stringify({ accessToken: 'ea-wrong-token-not-granted', webhookSecret: null }));
  const wrongCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Wrong token', 'mkt071-wrong-token-key');
  const wrongConnectionId = await registerConnection(aliceTokenValue, clientAId, 'commerce-store', wrongCredentialId, {
    apiBaseUrl: `${storeUrl()}`,
  });
  // The connect probe reaches the provider but the wrong token is
  // REJECTED (HTTP 401): reachable-but-degraded — the honest probe
  // outcome (the frozen semantics: 401/403 probes are reachable, not
  // healthy).
  await connectConnection(aliceTokenValue, clientAId, wrongConnectionId, 'degraded');
  const unauthorized = await read(aliceTokenValue, clientAId, wrongConnectionId, 'listCatalog');
  assert.equal(unauthorized.status, 200);
  assert.equal(unauthorized.body['ok'], false);
  assert.ok((unauthorized.body['error'] as string).includes('HTTP 401'));
});

test('MKT-071 AC-2: rate-limited — the 429 surfaces the normalized rateLimit state on the outcome AND the connection', async () => {
  store!.setMode('rate-limited');
  try {
    const limited = await read(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'listCatalog');
    assert.equal(limited.status, 200);
    assert.equal(limited.body['ok'], false);
    assert.ok((limited.body['error'] as string).includes('HTTP 429'));
    const rateLimit = limited.body['rateLimit'] as Record<string, unknown>;
    assert.equal(rateLimit['retryAfterSeconds'], 30);
    assert.equal(rateLimit['limitRemaining'], 239);
    const connection = limited.body['connection'] as Record<string, unknown>;
    const connectionRateLimit = connection['rateLimit'] as Record<string, unknown>;
    assert.equal(connectionRateLimit['retryAfterSeconds'], 30);
  } finally {
    store!.setMode('ok');
  }
  // Reconnect after the expected 429 (health bookkeeping, not terminal).
  await reconnectAfterExpectedFailure(aliceTokenValue, clientAId, aliceStoreFullConnectionId);
});

test('MKT-071 AC-2: malformed provider payloads fail closed as data errors (the sandbox malformed mode)', async () => {
  sandbox!.setMode('commerce-cms', 'malformed');
  try {
    const malformed = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'listCatalog');
    assert.equal(malformed.status, 200);
    assert.equal(malformed.body['ok'], false);
    assert.ok((malformed.body['error'] as string).includes('malformed commerce catalog payload'));
  } finally {
    sandbox!.setMode('commerce-cms', 'ok');
  }
  // Reconnect after the expected data failure.
  await reconnectAfterExpectedFailure(aliceTokenValue, clientAId, aliceCmsConnectionId);
});

// ---------------------------------------------------------------------------
// AC-1/AC-7: the partial-capability adapter round-trips its subset
// honestly (the read-only commerce/CMS connector)
// ---------------------------------------------------------------------------

test('MKT-071 AC-7: the READ-ONLY commerce adapter (commerce-cms) round-trips its subset honestly and rejects the rest', async () => {
  const catalog = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'listCatalog');
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body['ok'], true);
  const catalogFields = (((catalog.body['records'] as Record<string, unknown>[])[0]!['data'] as Record<string, unknown>)['fields']) as Record<string, unknown>;
  assert.deepEqual(catalogFields['products'], [
    { productId: 'prd_4410', title: 'Everyday Tote', categoryId: 'cat_essentials', status: 'active' },
  ]);

  const product = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'getProduct', { productId: 'prd_4410' });
  assert.equal(product.status, 200);
  assert.equal((product.body['records'] as Record<string, unknown>[])[0]!['providerRecordId'], 'commerce:product:prd_4410');

  const price = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'getPrice', { productId: 'prd_4410' });
  assert.equal(price.status, 200);
  const inventory = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'getInventory', { productId: 'prd_4410' });
  assert.equal(inventory.status, 200);

  // The subset rejects the operations it does not declare: the full
  // order-records read belongs to the store connector only.
  const rejectedRead = await read(aliceTokenValue, clientAId, aliceCmsConnectionId, 'listOrderRecords');
  assert.equal(rejectedRead.status, 422);
  // ... and every mutation (proven above for createProduct; the listing
  // lifecycle too).
  const rejectedListing = await mutate(aliceTokenValue, clientAId, aliceCmsConnectionId, 'createListing', { productId: 'prd_4410' });
  assert.equal(rejectedListing.status, 422);
});

// ---------------------------------------------------------------------------
// AC-3/AC-6: webhook idempotency + event stream continuity
// ---------------------------------------------------------------------------

test('MKT-071 AC-3/AC-6: the webhook GOLDEN PATH — first delivery appends ledger + evidence + the ingested projection row behind the fence', async () => {
  const payload = {
    eventId: 'evt_order_0001',
    orderId: 'ord_2001',
    status: 'paid',
    total: '89.70',
    currency: 'EUR',
    attribution: { ref: 'mos_msn_7f3e_attribution', source: 'social', campaign: 'summer-launch' },
  };
  const eventsBefore = (await clientIntegrationEvents(aliceTokenValue, clientAId)).length;

  const first = await webhook(
    aliceTokenValue,
    clientAId,
    aliceStoreFullConnectionId,
    'order.created',
    payload,
    commerceWebhookSignature(STORE_WEBHOOK_SECRET, payload),
  );
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body['adapterKey'], 'commerce-store');
  assert.equal(first.body['eventType'], 'commerce:order.created');
  assert.equal(first.body['providerEventId'], 'evt_order_0001');
  const evidenceRef = first.body['evidenceRef'] as string;
  assert.ok(typeof evidenceRef === 'string');
  const commerceEventId = first.body['commerceEventId'] as string;
  assert.ok(typeof commerceEventId === 'string');

  // The EXISTING event-stream path (AC-6): the raw ledger row.
  assert.equal((await clientIntegrationEvents(aliceTokenValue, clientAId)).length, eventsBefore + 1);

  // The derived evidence observation: PINNED class/quality + the
  // attribution passthrough + the fence provenance (raw hash + shape
  // version).
  const fact = await apiCall(port(), `/api/evidence/${evidenceRef}`, { token: aliceTokenValue });
  assert.equal(fact.status, 200);
  const factBody = fact.body as Record<string, unknown>;
  assert.equal(factBody['class'], 'source_fact');
  assert.equal(factBody['quality'], 'C');
  const factContent = factBody['content'] as Record<string, unknown>;
  assert.equal(factContent['providerEventId'], 'evt_order_0001');
  assert.equal(factContent['eventKind'], 'order');
  assert.match(String(factContent['rawEventHash']), /^[a-f0-9]{64}$/);
  assert.equal(factContent['shapeVersion'], 'commerce-event-v1');

  // The event history read-back (AC-7): the ingested projection row.
  const history = await commerceEvents(aliceTokenValue, clientAId);
  const ingested = history.find((entry) => entry['commerceEventId'] === commerceEventId);
  assert.ok(ingested !== undefined);
  assert.equal(ingested!['outcome'], 'ingested');
  assert.equal(ingested!['eventKind'], 'order');
  assert.equal(ingested!['providerEventId'], 'evt_order_0001');
  assert.equal(ingested!['integrationEventRef'], first.body['eventId']);
  assert.equal(ingested!['evidenceRef'], evidenceRef);
  // The ingested row claims no duplicate (the serializer omits null fields).
  assert.equal('duplicateOf' in ingested!, false);
  // AC-5: the normalized event shape carries the attribution VERBATIM.
  assert.deepEqual((ingested!['normalized'] as Record<string, unknown>)['attribution'], payload.attribution);

  // The single-row read-back.
  const single = await apiCall(port(), `/api/commerce-events/${commerceEventId}`, { token: aliceTokenValue });
  assert.equal(single.status, 200);
  assert.equal((single.body as Record<string, unknown>)['commerceEventId'], commerceEventId);
});

test('MKT-071 AC-3: a REPLAYED webhook is a no-op that surfaces honestly (duplicate-received record, never a silent drop)', async () => {
  const payload = {
    eventId: 'evt_order_0002',
    orderId: 'ord_2001',
    status: 'fulfilled',
    attribution: { ref: 'mos_msn_7f3e_attribution', source: 'social' },
  };
  const signature = commerceWebhookSignature(STORE_WEBHOOK_SECRET, payload);
  const first = await webhook(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'order.updated', payload, signature);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstEventId = first.body['eventId'] as string;
  const firstEvidence = first.body['evidenceRef'] as string;

  const ledgerBefore = (await clientIntegrationEvents(aliceTokenValue, clientAId)).length;
  const historyBefore = (await commerceEvents(aliceTokenValue, clientAId)).length;

  // The REPLAY: the same delivery (same event id, same payload, same
  // signature) delivered again.
  const replay = await webhook(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'order.updated', payload, signature);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['deduplicated'], true);
  assert.equal(replay.body['providerEventId'], 'evt_order_0002');
  assert.ok(typeof replay.body['firstReceivedAt'] === 'string');
  const duplicateRow = replay.body['commerceEvent'] as Record<string, unknown>;
  assert.equal(duplicateRow['outcome'], 'duplicate-received');
  assert.equal(duplicateRow['duplicateOf'], first.body['commerceEventId']);
  assert.equal(duplicateRow['providerEventId'], 'evt_order_0002');

  // NO second raw-ledger event, NO second evidence (the no-op).
  assert.equal((await clientIntegrationEvents(aliceTokenValue, clientAId)).length, ledgerBefore);
  // The event history gained exactly the duplicate-received row.
  const history = await commerceEvents(aliceTokenValue, clientAId);
  assert.equal(history.length, historyBefore + 1);
  const duplicate = history.find((entry) => entry['commerceEventId'] === duplicateRow['commerceEventId']);
  assert.ok(duplicate !== undefined);
  assert.equal(duplicate!['outcome'], 'duplicate-received');
  // The duplicate row claims NO ledger row and NO evidence (the serializer
  // omits null fields — the keys are absent).
  assert.equal('integrationEventRef' in duplicate!, false);
  assert.equal('evidenceRef' in duplicate!, false);
  // The ORIGINAL ingested row is untouched.
  const original = history.find((entry) => entry['commerceEventId'] === first.body['commerceEventId']);
  assert.ok(original !== undefined);
  assert.equal(original!['outcome'], 'ingested');
  assert.equal(original!['integrationEventRef'], firstEventId);
  assert.equal(original!['evidenceRef'], firstEvidence);

  // A DISTINCT provider event id ingests fresh (the fence is keyed by the
  // provider event identity, not the event type).
  const freshPayload = { ...payload, eventId: 'evt_order_0003', status: 'cancelled' };
  const fresh = await webhook(
    aliceTokenValue,
    clientAId,
    aliceStoreFullConnectionId,
    'order.updated',
    freshPayload,
    commerceWebhookSignature(STORE_WEBHOOK_SECRET, freshPayload),
  );
  assert.equal(fresh.status, 201);
  assert.equal(fresh.body['deduplicated'], undefined);
  assert.notEqual(fresh.body['eventId'], firstEventId);
});

test('MKT-071 AC-3/AC-8: an UNVERIFIED delivery records NOTHING (the commerce fence never sees it)', async () => {
  const historyBefore = (await commerceEvents(aliceTokenValue, clientAId)).length;
  const ledgerBefore = (await clientIntegrationEvents(aliceTokenValue, clientAId)).length;
  const payload = { eventId: 'evt_forged_0001', orderId: 'ord_2001' };
  const forged = await webhook(aliceTokenValue, clientAId, aliceStoreFullConnectionId, 'order.created', payload, {
    'x-commerce-signature': '0'.repeat(64),
  });
  assert.equal(forged.status, 422);
  assert.equal(errorBody(forged)['code'], 'INVALID_REQUEST');
  assert.equal((await commerceEvents(aliceTokenValue, clientAId)).length, historyBefore);
  assert.equal((await clientIntegrationEvents(aliceTokenValue, clientAId)).length, ledgerBefore);
});

test('MKT-071 AC-5/AC-6: product events flow through the same surface (eventKind product, the event-stream continuity)', async () => {
  const payload = {
    eventId: 'evt_product_0001',
    productId: 'prd_5001',
    status: 'active',
    attribution: { ref: 'mos_msn_9a2b', contentId: 'post_9812' },
  };
  const ingested = await webhook(
    aliceTokenValue,
    clientAId,
    aliceStoreFullConnectionId,
    'product.updated',
    payload,
    commerceWebhookSignature(STORE_WEBHOOK_SECRET, payload),
  );
  assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
  assert.equal(ingested.body['eventType'], 'commerce:product.updated');
  const single = await apiCall(port(), `/api/commerce-events/${ingested.body['commerceEventId']}`, {
    token: aliceTokenValue,
  });
  const row = single.body as Record<string, unknown>;
  assert.equal(row['eventKind'], 'product');
  assert.equal(row['providerRecordId'], 'prd_5001');
  assert.deepEqual((row['normalized'] as Record<string, unknown>)['attribution'], payload.attribution);
});

test('MKT-071 AC-6: the LEGACY unidentified delivery path is unchanged (no event id → no fence, plain append)', async () => {
  // The commerce/CMS platform's event-stream delivery WITHOUT a provider
  // event id: the MKT-023 append-only semantics (201 + the event shape,
  // no commerceEventId, no dedup).
  const payload = { order: 'ord_1001', status: 'fulfilled' };
  const legacy = await webhook(
    aliceTokenValue,
    clientAId,
    aliceCmsConnectionId,
    'order.updated',
    payload,
    commerceWebhookSignature(CMS_WEBHOOK_SECRET, payload),
  );
  assert.equal(legacy.status, 201, JSON.stringify(legacy.body));
  assert.equal(legacy.body['adapterKey'], 'commerce-cms');
  assert.equal(legacy.body['eventType'], 'commerce:order.updated');
  assert.equal(legacy.body['providerEventId'], undefined);
  assert.equal(legacy.body['commerceEventId'], undefined);
  assert.ok(typeof legacy.body['eventId'] === 'string');
  // And the same delivery AGAIN appends again (the legacy unfenced path).
  const legacyReplay = await webhook(
    aliceTokenValue,
    clientAId,
    aliceCmsConnectionId,
    'order.updated',
    payload,
    commerceWebhookSignature(CMS_WEBHOOK_SECRET, payload),
  );
  assert.equal(legacyReplay.status, 201);
  assert.notEqual(legacyReplay.body['eventId'], legacy.body['eventId']);
});

// ---------------------------------------------------------------------------
// AC-7: the module-level operations (the raw surface + the idempotent
// surface against the real DB)
// ---------------------------------------------------------------------------

test('MKT-071 AC-7 MODULE: the raw surface refuses replays fail-closed (ConflictError) while the idempotent surface records duplicates', async () => {
  // A module instance against the REAL database with in-process fakes for
  // the matrix dependencies (the integrations-api.test.ts pattern) and a
  // STUB commerce adapter returning identified events.
  const adapterKey = 'stub-commerce-module';
  const material = new TextEncoder().encode('{"accessToken":"stub","webhookSecret":"stub-secret"}');
  const stubAdapter: IntegrationAdapter = {
    descriptor: {
      adapterKey,
      providerLabel: 'Stub Commerce Module',
      description: 'A stub commerce adapter for module-level tests.',
    },
    capabilities: [
      { capabilityKey: 'commerce-order-webhook', kind: 'webhook', operations: ['order.created'], description: 'Webhook.' },
    ],
    probeConnection: async () => ({ reachable: true, healthy: true, message: null, rateLimit: null }),
    read: async () => ({ ok: true, records: [], error: null, rateLimit: null }),
    mutate: async () => ({ ok: false, providerRecordId: null, data: null, error: 'no mutation', rateLimit: null }),
    verifyWebhook: async (_context, delivery) => ({
      verified: true,
      reason: null,
      normalizedEventType: `commerce:${delivery.eventType}`,
      providerEvent: {
        providerEventId: String(delivery.payload['eventId']),
        eventKind: 'order',
        providerRecordId: String(delivery.payload['orderId'] ?? ''),
        shapeVersion: 'commerce-event-v1',
        normalized: { ...delivery.payload },
      },
    }),
  };

  const evidenceAppends: string[] = [];
  const theModule = createIntegrationsModule({
    db: db!,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    policies: {
      evaluateAction: async (input: Parameters<PoliciesModuleApi['evaluateAction']>[0]) => ({
        decisionId: `decision-${randomUUID()}`,
        dimension: input.action.dimension,
        agencyId: input.scope.agencyId,
        clientId: input.scope.clientId,
        outcome: 'allow' as const,
        reasonCode: 'rule-allowed' as const,
        reasons: [],
        action: input.action,
        matchedPolicyVersions: [],
        provenance: { actor: 'test', recordedVia: 'test', correlationId: 'test', causationId: null },
      }),
    } as unknown as PoliciesModuleApi,
    credentials: {
      getCredentialReference: async () => ({
        credentialId: 'cred-stub',
        agencyId: aliceAgencyId,
        clientId: null,
        kind: 'integration_api_key',
        label: 'stub',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      }),
      resolveCredentialMaterial: async () => ({
        credentialId: 'cred-stub',
        material,
      }),
    } as unknown as CredentialsModuleApi,
    clientOwnership: {
      resolveClientOwnership: async (clientId: string) =>
        clientId === clientAId
          ? { scope: { kind: 'client', agencyId: aliceAgencyId, clientId: clientAId }, client: { clientId: clientAId, agencyId: aliceAgencyId, status: 'active' } }
          : null,
    },
    evidenceSink: {
      // The fake sink DELEGATES to the real /evidence authority through its
      // public API (the FK on integration_events.evidence_ref requires a
      // real evidence row — the honest fake, not a fabricated id).
      appendEvidence: async (input) => {
        const created = await apiCall(port(), `/api/clients/${input.clientId}/evidence`, {
          token: aliceTokenValue,
          body: {
            class: input.class,
            sourceSystem: input.source.system,
            sourceRef: input.source.ref,
            observedAt: input.observedAt,
            content: input.content as Record<string, unknown>,
            contentRef: `mos-objects://evidence/integrations-module/${input.source.ref}`,
            quality: input.quality,
          },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        evidenceAppends.push(created.body['evidenceId'] as string);
        return { evidenceId: created.body['evidenceId'] as string };
      },
    },
    adapters: [stubAdapter],
  });

  // Register + connect a connection through the module (the real store
  // tables of the stack). The credential reference is a REAL row (created
  // through the API) — the DB FK + scope fence backstop the fake
  // /credentials port's acceptance.
  const moduleCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Module stub credential', 'mkt071-store-full-key');
  const connection = await theModule.registerConnection(
    {
      clientId: clientAId,
      adapterKey,
      credentialReferenceId: moduleCredentialId,
      providerConfig: {},
    },
    moduleProvenance(),
  );
  await theModule.connectConnection({ connectionId: connection.connectionId, expectedVersion: connection.version }, moduleProvenance());

  const delivery = {
    connectionId: connection.connectionId,
    eventType: 'order.created',
    payload: { eventId: 'evt_module_0001', orderId: 'ord_mod_1', status: 'paid' },
    headers: { 'x-commerce-signature': 'stub-signature' },
  };

  // The IDEMPOTENT surface: first delivery → the rich outcome.
  const first = await theModule.ingestIdentifiedWebhookEvent(delivery, moduleProvenance());
  assert.equal(first.deduplicated, false);
  assert.ok(first.event !== null);
  assert.equal(first.providerEventId, 'evt_module_0001');
  assert.ok(first.commerceEvent !== null);
  assert.equal(first.commerceEvent!.outcome, 'ingested');
  assert.equal(evidenceAppends.length, 1);

  // The RAW surface on a FRESH event id: appends through the same core.
  const secondDelivery = {
    ...delivery,
    payload: { eventId: 'evt_module_0002', orderId: 'ord_mod_2', status: 'paid' },
  };
  const rawFirst = await theModule.ingestWebhookEvent(secondDelivery, moduleProvenance());
  assert.equal(rawFirst.eventType, 'commerce:order.created');
  assert.equal(evidenceAppends.length, 2);

  // The RAW surface on a REPLAY: fail-closed ConflictError (no bypass of
  // the fence through the raw surface).
  await assert.rejects(
    theModule.ingestWebhookEvent(secondDelivery, moduleProvenance()),
    (error: unknown) => error instanceof ConflictError && String((error as ConflictError).message).includes('evt_module_0002'),
  );

  // The IDEMPOTENT surface on the same replay: the honest duplicate row.
  const replay = await theModule.ingestIdentifiedWebhookEvent(secondDelivery, moduleProvenance());
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.event, null);
  assert.ok(replay.commerceEvent !== null);
  assert.equal(replay.commerceEvent!.outcome, 'duplicate-received');
  assert.ok(replay.commerceEvent!.duplicateOf !== null);
  assert.equal(evidenceAppends.length, 2, 'a replay appends NO second evidence');

  // The event history read-back through the module.
  const history = await theModule.listCommerceEventsForClient(clientAId);
  assert.ok(history.some((entry) => entry.providerEventId === 'evt_module_0001' && entry.outcome === 'ingested'));
  assert.ok(history.some((entry) => entry.providerEventId === 'evt_module_0002' && entry.outcome === 'ingested'));
  assert.ok(history.some((entry) => entry.providerEventId === 'evt_module_0002' && entry.outcome === 'duplicate-received'));
});

function moduleProvenance(): IntegrationProvenance {
  return {
    actor: 'user:module-level-test',
    recordedVia: 'test',
    correlationId: `corr-${randomUUID()}`,
    causationId: null,
  };
}

// ---------------------------------------------------------------------------
// AC-8: the fail-closed isolation battery (uniform 404, suspended 403,
// anonymous 401)
// ---------------------------------------------------------------------------

test('MKT-071 AC-8: anonymous callers get 401 on every commerce surface', async () => {
  const attempts = [
    { method: 'GET', path: `/api/clients/${clientAId}/commerce-events` },
    { method: 'GET', path: `/api/clients/${clientAId}/commerce-mutations` },
    { method: 'GET', path: `/api/commerce-events/${randomUUID()}` },
    {
      method: 'POST',
      path: `/api/clients/${clientAId}/connections/${aliceStoreFullConnectionId}/webhook`,
      body: { eventType: 'order.created', payload: { eventId: 'x', orderId: 'y' }, headers: {} },
    },
    {
      method: 'POST',
      path: `/api/clients/${clientAId}/connections/${aliceStoreFullConnectionId}/read`,
      body: { operation: 'listCatalog', parameters: {} },
    },
    {
      method: 'POST',
      path: `/api/clients/${clientAId}/connections/${aliceStoreFullConnectionId}/mutate`,
      body: { operation: 'createProduct', parameters: { title: 'x' } },
    },
  ];
  for (const attempt of attempts) {
    const response = await apiCall(port(), attempt.path, {
      method: attempt.method as 'GET' | 'POST',
      body: attempt.body as Record<string, unknown> | undefined,
    });
    assert.equal(response.status, 401, `${attempt.method} ${attempt.path} must require authentication`);
  }
});

test('MKT-071 AC-8: foreign≡unknown≡malformed — uniform 404s on every commerce surface (no existence or traversal oracle)', async () => {
  const foreignAttempts: { token: string; clientId: string; label: string }[] = [
    // Alice lists BOB's commerce surfaces (foreign client — the fence).
    { token: aliceTokenValue, clientId: clientBId, label: 'foreign client listing' },
    // An unknown client id.
    { token: aliceTokenValue, clientId: randomUUID(), label: 'unknown client' },
    // A malformed client id.
    { token: aliceTokenValue, clientId: 'not-a-uuid', label: 'malformed client id' },
  ];
  for (const attempt of foreignAttempts) {
    const events = await apiCall(port(), `/api/clients/${attempt.clientId}/commerce-events`, { token: attempt.token });
    assert.equal(events.status, 404, `commerce-events ${attempt.label}: expected 404`);
    const mutations = await apiCall(port(), `/api/clients/${attempt.clientId}/commerce-mutations`, { token: attempt.token });
    assert.equal(mutations.status, 404, `commerce-mutations ${attempt.label}: expected 404`);
  }

  // Foreign/unknown/malformed CONNECTION ids under an accessible client
  // path: the same uniform 404 for read/mutate/webhook.
  const connectionAttempts: { connectionId: string; label: string }[] = [
    { connectionId: bobStoreConnectionId, label: 'foreign connection under own client' },
    { connectionId: randomUUID(), label: 'unknown connection' },
    { connectionId: 'not-a-uuid', label: 'malformed connection id' },
  ];
  for (const attempt of connectionAttempts) {
    const readResponse = await read(aliceTokenValue, clientAId, attempt.connectionId, 'listCatalog');
    assert.equal(readResponse.status, 404, `read ${attempt.label}: expected 404`);
    const mutateResponse = await mutate(aliceTokenValue, clientAId, attempt.connectionId, 'createProduct', { title: 'x' });
    assert.equal(mutateResponse.status, 404, `mutate ${attempt.label}: expected 404`);
    const payload = { eventId: 'evt_probe', orderId: 'ord_probe' };
    const webhookResponse = await webhook(
      aliceTokenValue,
      clientAId,
      attempt.connectionId,
      'order.created',
      payload,
      commerceWebhookSignature(STORE_WEBHOOK_SECRET, payload),
    );
    assert.equal(webhookResponse.status, 404, `webhook ${attempt.label}: expected 404`);
  }

  // A foreign/unknown commerce event id: the same uniform 404.
  for (const eventId of [randomUUID(), 'not-a-uuid']) {
    const single = await apiCall(port(), `/api/commerce-events/${eventId}`, { token: aliceTokenValue });
    assert.equal(single.status, 404);
  }
});

test('MKT-071 AC-8: a suspended membership gets 403 (the intra-tenant failure), a foreign principal stays 404', async () => {
  // A second member of Alice's agency, then suspended.
  const collaborator = await makePrincipal('grace@commerce.test');
  const membership = await apiCall(port(), `/api/agencies/${aliceAgencyId}/memberships`, {
    token: adminTokenValue,
    body: { userId: collaborator.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));

  // Active member: reads Alice's commerce surfaces.
  const activeRead = await apiCall(port(), `/api/clients/${clientAId}/commerce-events`, {
    token: collaborator.token,
  });
  assert.equal(activeRead.status, 200);

  // Suspend the membership → 403 (NOT 200, NOT 404).
  const memberships = await apiCall(port(), `/api/agencies/${aliceAgencyId}/memberships`, {
    token: adminTokenValue,
  });
  const row = (memberships.body['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === collaborator.userId,
  )!;
  const disabled = await apiCall(
    port(),
    `/api/agencies/${aliceAgencyId}/memberships/${row['membershipId'] as string}`,
    {
      token: adminTokenValue,
      method: 'PATCH',
      body: { status: 'disabled', version: row['version'] as number },
    },
  );
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const suspendedRead = await apiCall(port(), `/api/clients/${clientAId}/commerce-events`, {
    token: collaborator.token,
  });
  assert.equal(suspendedRead.status, 403, 'a suspended membership never authorizes');
  const suspendedMutation = await mutate(collaborator.token, clientAId, aliceStoreFullConnectionId, 'createListing', {
    productId: 'prd_5001',
  });
  assert.equal(suspendedMutation.status, 403);
});
