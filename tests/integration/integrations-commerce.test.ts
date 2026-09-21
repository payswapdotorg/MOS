/**
 * MKT-071 integration tests — the COMMERCE CATALOG AND ORDER CAPABILITIES
 * on the REAL stack: embedded PostgreSQL 18, a real API process whose
 * composition root wires the REAL CommerceCmsAdapter (full capability
 * profile), the in-process LOOPBACK commerce provider double
 * (tests/integration/helpers/commerce-provider.ts — the oauth-provider
 * house pattern: fixture-driven, per-token granted scopes, scriptable
 * error taxonomy, recorded mutations, NO real commerce platform, NO
 * external network) AND a module-level in-process module instance
 * (the integrations-api.test.ts pattern) constructed with the REAL
 * read-only CommerceCmsAdapter — the partial-capability proof.
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-071; spec/
 * architecture-v1.6.md §15/§16; module-dependency-matrix-v1.6.md rule 8):
 *
 *   - AC-1  the normalized capability surface through the route AND module
 *           surfaces: registry listing, paged catalog read, product read,
 *           price/inventory reads, order reads (summary metrics + the
 *           line-item detail shape), the listing lifecycle;
 *   - AC-2  the provider double exercises the FULL surface incl.
 *           partial-capability variants (read-only + lying credentials),
 *           pagination, the error taxonomy (provider-down, unauthorized,
 *           rate-limited, invalid-scope) and webhook delivery;
 *   - AC-3  webhook idempotency: first delivery + replay + mutated-payload
 *           replay — the honest duplicate-received history, never a silent
 *           drop, never a second ledger/evidence/projection row;
 *   - AC-4  policy-gated mutations: the blanket client-scoped deny, the
 *           CAPABILITY-SCOPED deny (its own capability key), and the
 *           provider-scope refusals — all fail closed with ZERO provider
 *           side effects;
 *   - AC-5  attribution passthrough: the provider's reference fields ride
 *           VERBATIM through order reads and the normalized event
 *           projection (deep-equal assertions; no interpretation);
 *   - AC-6  event-stream continuity: the ingested commerce events append
 *           through the SAME event ledger with the same envelope
 *           discipline (one ledger row + one pinned source_fact each);
 *   - AC-7  the full round-trip: catalog → products → listing lifecycle →
 *           price/inventory → orders → webhook (+replay) → history
 *           read-backs;
 *   - AC-8  the fail-closed isolation battery: agency/server-derived
 *           scope, uniform 404 foreign≡unknown≡malformed, suspended
 *           membership 403, anonymous 401, suspended pipe 409 (no
 *           provider traffic), the cross-tenant provider-event-id fence.
 *
 * Credential materials are FAKE sandbox strings ASSEMBLED AT RUNTIME (the
 * §21 posture: they exist only in the secrets-dir files and in-process).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import {
  COMMERCE_FIXTURES,
  commerceWebhookSignature,
  startCommerceProvider,
  type CommerceProviderDouble,
} from './helpers/commerce-provider.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import type { PoliciesModuleApi } from '../../src/modules/policies/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import {
  COMMERCE_READ_ONLY_CAPABILITY_KEYS,
  commerceCapabilitiesForProfile,
  commerceWebhookEventIdentity,
  createIntegrationsModule,
  mapCommerceCatalogResponse,
  mapCommerceOrderDetailsResponse,
  normalizeCommerceWebhookEvent,
  type CommerceEventRecord,
  type CommerceEventReceiptRecord,
  type IntegrationAdapter,
  type IntegrationEvidenceAppendInput,
  type IntegrationEvidenceProvenance,
  type IntegrationProvenance,
  type IntegrationsModuleApi,
} from '../../src/modules/integrations/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

// ---------------------------------------------------------------------------
// FAKE sandbox credential strings — assembled at RUNTIME so no
// credential-shaped literal ever exists in repository content (the §21
// posture; the GitHub push-protection discipline of the house tests).
// ---------------------------------------------------------------------------
const FULL_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxFullCommerce';
const READ_ONLY_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxReadOnlyCommerce';
const LYING_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxLyingCommerce';
const BOB_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxBobCommerce';
const MODULE_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxModuleCommerce';
const WEBHOOK_SECRET = 'whsec_' + 'Commerce' + 'FakeSandbox';
const BOB_WEBHOOK_SECRET = 'whsec_' + 'Commerce' + 'BobFakeSandbox';
const MODULE_WEBHOOK_SECRET = 'whsec_' + 'Commerce' + 'ModuleFakeSandbox';
const ALL_SCOPES = ['catalog:read', 'orders:read', 'products:write', 'listings:write'];
const READ_ONLY_SCOPES = ['catalog:read', 'orders:read'];

/** A dead loopback port (connection refused — the provider-down taxonomy). */
const DEAD_PROVIDER_URL = 'http://127.0.0.1:1';

/** The attribution/reference fixture carried VERBATIM (AC-5). */
const ATTRIBUTION = {
  attributionRef: 'mission:gm_882:experiment:exp_401',
  utmSource: 'instagram',
  utmCampaign: 'spring-launch',
  landingRoute: '/l/spring-882',
} as const;

const ORDER_EVENT_PAYLOAD = {
  eventId: 'evt_9001',
  kind: 'order.created',
  occurredAt: '2026-05-04T11:00:00.000Z',
  order: {
    id: 'ord_2001',
    number: 'MOS-2001',
    status: 'paid',
    currency: 'USD',
    total: '189.00',
    placedAt: '2026-05-04T11:00:00.000Z',
    updatedAt: '2026-05-04T11:05:00.000Z',
    customerEmail: 'buyer@example.test',
    lineItems: [
      {
        productId: 'prd_501',
        variantId: 'var_9',
        title: 'Tactical Apron',
        quantity: 1,
        unitPrice: '189.00',
      },
    ],
    attribution: ATTRIBUTION,
  },
} as const;

const PRODUCT_EVENT_PAYLOAD = {
  eventId: 'evt_9002',
  kind: 'product.updated',
  occurredAt: '2026-05-06T08:00:00.000Z',
  product: { id: 'prd_501', title: 'Tactical Apron', status: 'active' },
} as const;

const MODULE_ORDER_EVENT_PAYLOAD = {
  eventId: 'evt_mod_1',
  kind: 'order.fulfilled',
  occurredAt: '2026-05-08T08:00:00.000Z',
  order: {
    id: 'ord_3001',
    number: 'MOS-3001',
    status: 'fulfilled',
    currency: 'USD',
    total: '189.00',
    lineItems: [
      { productId: 'prd_501', variantId: 'var_9', title: 'Tactical Apron', quantity: 1, unitPrice: '189.00' },
    ],
    attribution: { attributionRef: 'mission:gm_882', utmSource: 'tiktok' },
  },
} as const;

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let readOnlyApi: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let provider: CommerceProviderDouble | null = null;
let moduleDb: PgDb | null = null;
let moduleInstance: IntegrationsModuleApi | null = null;
const moduleEvidenceAppends: { input: IntegrationEvidenceAppendInput }[] = [];

let adminTokenValue = '';
let aliceTokenValue = '';
let aliceAgencyId = '';
let clientAId = '';
let clientCId = '';
let bobTokenValue = '';
let bobAgencyId = '';
let clientBId = '';
let suspendedMemberToken = '';

let moduleCredentialId = '';
let moduleEvidenceFixtureId = '';

let aliceFullConnectionId = '';
let aliceReadOnlyConnectionId = '';
let aliceLyingConnectionId = '';
let aliceClientCConnectionId = '';
let aliceDeadConnectionId = '';
let bobCommerceConnectionId = '';
let moduleConnectionId = '';

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function readOnlyPort(): number {
  if (readOnlyApi === null) throw new Error('read-only api not spawned');
  return readOnlyApi.port;
}

function providerUrl(): string {
  if (provider === null) throw new Error('provider not started');
  return provider.url;
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

async function makePrincipal(email: string, password: string): Promise<{ userId: string; token: string; agencyId: string }> {
  const admin = adminTokenValue;
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email.split('@')[0]!}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string, agencyId };
}

async function makeUser(email: string, password: string): Promise<{ userId: string; token: string }> {
  const user = await apiCall(port(), '/api/users', {
    token: adminTokenValue,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: adminTokenValue,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password },
  });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
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
  credentialReferenceId: string,
  apiBaseUrl: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/connections`, {
    token,
    body: { adapterKey: 'commerce-cms', credentialReferenceId, providerConfig: { apiBaseUrl } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body['status'], 'registered');
  return created.body['connectionId'] as string;
}

async function connectConnection(token: string, clientId: string, connectionId: string): Promise<void> {
  const current = await apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}`, { token });
  assert.equal(current.status, 200);
  const connected = await apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/connect`, {
    token,
    body: { expectedVersion: current.body['version'] as number },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'connected');
  assert.equal(connected.body['health'], 'healthy');
}

async function read(token: string, clientId: string, connectionId: string, operation: string, parameters: Record<string, unknown> = {}) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/read`, {
    token,
    body: { operation, parameters },
  });
}

async function mutate(token: string, clientId: string, connectionId: string, operation: string, parameters: Record<string, unknown>) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/mutate`, {
    token,
    body: { operation, parameters },
  });
}

async function webhook(token: string, clientId: string, connectionId: string, payload: Record<string, unknown>, secret: string) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/webhook`, {
    token,
    body: {
      eventType: payload['kind'] as string,
      payload,
      headers: commerceWebhookSignature(secret, payload),
    },
  });
}

async function commerceReceipts(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/commerce-event-receipts`, { token });
  assert.equal(response.status, 200);
  return response.body['receipts'] as Record<string, unknown>[];
}

async function commerceEvents(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/commerce-events`, { token });
  assert.equal(response.status, 200);
  return response.body['events'] as Record<string, unknown>[];
}

async function integrationEvents(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/integration-events`, { token });
  assert.equal(response.status, 200);
  return response.body['events'] as Record<string, unknown>[];
}

async function clientEvidenceCount(token: string, clientId: string): Promise<number> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, { token });
  assert.equal(response.status, 200);
  return (response.body['evidence'] as unknown[]).length;
}

const provenance = (): IntegrationProvenance => ({
  actor: 'user:test-actor',
  recordedVia: 'api',
  correlationId: 'corr-mkt071-test',
  causationId: null,
});

before(async () => {
  stack = await bootStack('integrations-commerce');

  // The provider credential materials (FAKE sandbox strings, runtime
  // assembled; JSON per the provider credential convention — the
  // grantedScopes list is the provider-granted authorization the adapter
  // pre-checks; the LYING material claims write scopes its token does not
  // have, exercising the provider-side 403 defense in depth).
  provisionSecret('mkt071-full-key', JSON.stringify({ accessToken: FULL_TOKEN, webhookSecret: WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }));
  provisionSecret('mkt071-readonly-key', JSON.stringify({ accessToken: READ_ONLY_TOKEN, webhookSecret: WEBHOOK_SECRET, grantedScopes: READ_ONLY_SCOPES }));
  provisionSecret('mkt071-lying-key', JSON.stringify({ accessToken: LYING_TOKEN, webhookSecret: WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }));
  provisionSecret('mkt071-bob-key', JSON.stringify({ accessToken: BOB_TOKEN, webhookSecret: BOB_WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }));
  provisionSecret('mkt071-dead-key', JSON.stringify({ accessToken: FULL_TOKEN, webhookSecret: WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }));
  provisionSecret('mkt071-module-key', JSON.stringify({ accessToken: MODULE_TOKEN, webhookSecret: MODULE_WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }));

  // The commerce provider double (loopback; per-token granted scopes; the
  // LYING token deliberately lacks the write scopes its material claims).
  provider = await startCommerceProvider({
    [FULL_TOKEN]: ALL_SCOPES,
    [READ_ONLY_TOKEN]: READ_ONLY_SCOPES,
    [LYING_TOKEN]: READ_ONLY_SCOPES,
    [BOB_TOKEN]: ALL_SCOPES,
    [MODULE_TOKEN]: ALL_SCOPES,
  });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // A SECOND API process on the SAME stack with the READ-ONLY commerce
  // capability profile (MOS_COMMERCE_GRANTED_CAPABILITIES — the
  // capability-subset declaration): the REAL CommerceCmsAdapter instance
  // constructed with the read-only grant, sharing the database (the
  // partial-capability route-surface proof — a read-only commerce adapter
  // is first-class and rejects the rest).
  readOnlyApi = await spawnApi(stack.env, {
    MOS_COMMERCE_GRANTED_CAPABILITIES: COMMERCE_READ_ONLY_CAPABILITY_KEYS.join(','),
  });

  adminTokenValue = await adminToken();

  const alice = await makePrincipal('alice@commerce.test', 'a-very-long-password-123');
  aliceTokenValue = alice.token;
  aliceAgencyId = alice.agencyId;
  clientAId = await makeClient(aliceAgencyId, alice.token, 'Client Commerce A');
  clientCId = await makeClient(aliceAgencyId, alice.token, 'Client Commerce C');

  const bob = await makePrincipal('bob@commerce.test', 'a-very-long-password-123');
  bobTokenValue = bob.token;
  bobAgencyId = bob.agencyId;
  clientBId = await makeClient(bobAgencyId, bob.token, 'Client Commerce B');

  // A suspended member of alice's agency (the 403 battery).
  const suspendedMember = await makeUser('suspended@commerce.test', 'a-very-long-password-123');
  const membership = await apiCall(port(), `/api/agencies/${aliceAgencyId}/memberships`, {
    token: aliceTokenValue,
    body: { userId: suspendedMember.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  const suspend = await apiCall(port(), `/api/agencies/${aliceAgencyId}/memberships/${membership.body['membershipId']}`, {
    token: aliceTokenValue,
    method: 'PATCH',
    body: { status: 'disabled', version: membership.body['version'] as number },
  });
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
  suspendedMemberToken = suspendedMember.token;

  // Platform policy defaults: network + secrets dimensions explicitly
  // allow the integration operations (POL-001: without an explicit allow
  // everything denies — these declarations make the commerce flows live).
  await declarePlatformPolicy('network');
  await declarePlatformPolicy('secrets');

  // Bob's CLIENT-scoped network policy: connect allowed (his connections
  // stay live for the tenant-isolation negatives), read + mutate DENIED —
  // the fail-closed negative tenant (the blanket mutation-deny battery).
  const bobDeny = await apiCall(port(), `/api/clients/${clientBId}/policies`, {
    token: bobTokenValue,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['integration.connect'],
          reason: 'MKT-071 test: Bob may probe his connections (live pipe for the tenant-isolation negatives)',
        },
        {
          effect: 'deny',
          operations: ['integration.read'],
          reason: 'MKT-071 test: client-scoped read deny (fail-closed negative)',
        },
        {
          effect: 'deny',
          operations: ['integration.mutate'],
          reason: 'MKT-071 test: client-scoped mutate deny (fail-closed negative)',
        },
      ],
      description: 'MKT-071 client-scoped network boundaries (negative tenant)',
    },
  });
  assert.equal(bobDeny.status, 201, JSON.stringify(bobDeny.body));

  // Client C's CAPABILITY-SCOPED deny: mutations through the
  // commerce-product-write capability are denied WHILE listing management
  // stays allowed — the "policy gate with its own capability key" proof
  // (the decision trail records which capability was attempted).
  const capabilityScoped = await apiCall(port(), `/api/clients/${clientCId}/policies`, {
    token: aliceTokenValue,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'deny',
          operations: ['integration.mutate'],
          attributes: { capability: 'commerce-product-write' },
          reason: 'MKT-071 test: product writes denied for this client while listing management stays allowed (the capability-scoped sanction)',
        },
      ],
      description: 'MKT-071 capability-scoped mutation boundary (client C)',
    },
  });
  assert.equal(capabilityScoped.status, 201, JSON.stringify(capabilityScoped.body));

  // The credentials (agency-scoped references by logical handle).
  const fullCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce full', 'mkt071-full-key');
  const readOnlyCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce read only', 'mkt071-readonly-key');
  const lyingCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce lying scopes', 'mkt071-lying-key');
  const clientCCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce client C', 'mkt071-dead-key');
  const deadCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce dead provider', 'mkt071-full-key');
  moduleCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce module level', 'mkt071-module-key');
  const bobCredentialId = await makeCredential(bobAgencyId, bobTokenValue, 'Commerce Bob', 'mkt071-bob-key');
  void deadCredentialId;

  // A REAL /evidence fixture for the module-level instance's fake sink (the
  // migration-029 evidence-linkage trigger requires the referenced evidence
  // row to exist — the integrations-api.test.ts pattern).
  const evidenceFixture = await apiCall(port(), `/api/clients/${clientAId}/evidence`, {
    token: aliceTokenValue,
    body: {
      class: 'source_fact',
      sourceSystem: 'fixture-provider',
      sourceRef: 'fixture/mkt071-module/1',
      observedAt: '2026-01-15T10:30:00.000Z',
      content: { metric: 'spend', value: 1.25, currency: 'USD' },
      contentRef: 'mos-objects://evidence/mkt071-module/spend.json',
      quality: 'D',
    },
  });
  assert.equal(evidenceFixture.status, 201, JSON.stringify(evidenceFixture.body));
  moduleEvidenceFixtureId = evidenceFixture.body['evidenceId'] as string;

  // The connections.
  aliceFullConnectionId = await registerConnection(aliceTokenValue, clientAId, fullCredentialId, providerUrl());
  aliceReadOnlyConnectionId = await registerConnection(aliceTokenValue, clientAId, readOnlyCredentialId, providerUrl());
  aliceLyingConnectionId = await registerConnection(aliceTokenValue, clientAId, lyingCredentialId, providerUrl());
  aliceClientCConnectionId = await registerConnection(aliceTokenValue, clientCId, clientCCredentialId, providerUrl());
  aliceDeadConnectionId = await registerConnection(aliceTokenValue, clientAId, deadCredentialId, DEAD_PROVIDER_URL);
  bobCommerceConnectionId = await registerConnection(bobTokenValue, clientBId, bobCredentialId, providerUrl());

  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);
  await connectConnection(aliceTokenValue, clientAId, aliceReadOnlyConnectionId);
  await connectConnection(aliceTokenValue, clientAId, aliceLyingConnectionId);
  await connectConnection(aliceTokenValue, clientCId, aliceClientCConnectionId);
  await connectConnection(bobTokenValue, clientBId, bobCommerceConnectionId);

  // The MODULE-LEVEL in-process instance (the integrations-api.test.ts
  // pattern): the SAME database as the API processes, a STUB READ-ONLY
  // commerce adapter (defined IN THIS FILE — tests may import module
  // public entries only, and the public entry carries the entire commerce
  // normalized contract) built on the PUBLIC pure mapping/normalization
  // functions, scriptable fakes for the cross-module contracts. This
  // proves the MODULE-level gate chain over a capability-subset adapter
  // (the REAL read-only adapter's route surface is proven through the
  // second spawned API above).
  moduleDb = new PgDb(stack.env.databaseUrl, 2);
  moduleInstance = createIntegrationsModule({
    db: moduleDb,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    policies: {
      evaluateAction: async (input: Parameters<PoliciesModuleApi['evaluateAction']>[0]) => ({
        decisionId: 'module-level-decision',
        dimension: input.action.dimension,
        agencyId: input.scope.agencyId,
        clientId: input.scope.clientId,
        outcome: 'allow',
        reasonCode: 'rule-allowed',
        reasons: [],
        action: input.action,
        matchedPolicyVersions: [],
        provenance: {
          actor: 'module-level-test',
          recordedVia: 'test',
          correlationId: 'corr-module-level',
          causationId: null,
        },
      }),
    } as unknown as PoliciesModuleApi,
    credentials: {
      getCredentialReference: async (credentialId: string) => {
        if (credentialId !== moduleCredentialId) return null;
        return {
          credentialId: moduleCredentialId,
          agencyId: aliceAgencyId,
          clientId: null,
          status: 'active',
          kind: 'integration_api_key',
          label: 'Commerce module-level',
          createdAt: '2026-01-01T00:00:00.000Z',
          version: 1,
        };
      },
      resolveCredentialMaterial: async (input: { credentialId: string }) => {
        assert.equal(input.credentialId, moduleCredentialId);
        return {
          credentialId: input.credentialId,
          material: new TextEncoder().encode(
            JSON.stringify({ accessToken: MODULE_TOKEN, webhookSecret: MODULE_WEBHOOK_SECRET, grantedScopes: ALL_SCOPES }),
          ),
        };
      },
    } as unknown as CredentialsModuleApi,
    clientOwnership: {
      resolveClientOwnership: async (clientId: string) => {
        if (clientId !== clientAId) return null;
        return {
          scope: { kind: 'client' as const, agencyId: aliceAgencyId, clientId: clientAId },
          client: { clientId: clientAId, agencyId: aliceAgencyId, status: 'active' },
        };
      },
    },
    evidenceSink: {
      appendEvidence: async (input: IntegrationEvidenceAppendInput, _evidenceProvenance: IntegrationEvidenceProvenance) => {
        moduleEvidenceAppends.push({ input });
        // A REAL evidence row (the migration-029 evidence-linkage trigger
        // requires the referenced evidence to exist — the fake sink returns
        // the API-created fixture's id, the integrations-api.test.ts
        // pattern).
        return { evidenceId: moduleEvidenceFixtureId };
      },
    },
    adapters: [stubReadOnlyCommerceAdapter()],
  });
  const registered = await moduleInstance.registerConnection(
    {
      clientId: clientAId,
      adapterKey: 'commerce-cms',
      credentialReferenceId: moduleCredentialId,
      providerConfig: { apiBaseUrl: providerUrl() },
    },
    provenance(),
  );
  moduleConnectionId = registered.connectionId;
  const current = await moduleInstance.getConnection(moduleConnectionId);
  await moduleInstance.connectConnection({ connectionId: moduleConnectionId, expectedVersion: current!.version }, provenance());
});

after(async () => {
  if (moduleDb !== null) {
    await moduleDb.close();
    moduleDb = null;
  }
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
  if (api !== null) {
    api.child.kill('SIGKILL');
    api = null;
  }
  if (readOnlyApi !== null) {
    readOnlyApi.child.kill('SIGKILL');
    readOnlyApi = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

/**
 * The STUB READ-ONLY commerce adapter (module-level test data — the
 * integrations-api.test.ts stub pattern): implements the generic
 * IntegrationAdapter port with the READ-ONLY commerce capability
 * declaration (the public commerceCapabilitiesForProfile over the public
 * read-only subset) and read/verify behaviors built on the PUBLIC pure
 * mapping/normalization functions over the provider-double fixtures. The
 * stub's mutate is never reachable through the module (the
 * capability-discovery gate rejects first) — it refuses honestly anyway.
 */
function stubReadOnlyCommerceAdapter(): IntegrationAdapter {
  return {
    descriptor: {
      adapterKey: 'commerce-cms',
      providerLabel: 'Commerce/CMS platform (stub read-only)',
      description: 'The in-file module-level read-only commerce stub of the MKT-071 integration tests.',
    },
    capabilities: commerceCapabilitiesForProfile(COMMERCE_READ_ONLY_CAPABILITY_KEYS),
    probeConnection: async () => ({ reachable: true, healthy: true, message: null, rateLimit: null }),
    read: async (_context, request) => {
      if (request.operation === 'listCatalog') {
        const mapping = mapCommerceCatalogResponse(COMMERCE_FIXTURES.catalogPage1, null);
        if (!mapping.ok) return { ok: false, records: [], error: mapping.error, rateLimit: null };
        return { ok: true, records: mapping.records, error: null, rateLimit: null, pageCursor: mapping.pageCursor };
      }
      if (request.operation === 'listOrderDetails') {
        const mapping = mapCommerceOrderDetailsResponse(COMMERCE_FIXTURES.orderDetailsPage1, null);
        if (!mapping.ok) return { ok: false, records: [], error: mapping.error, rateLimit: null };
        return { ok: true, records: mapping.records, error: null, rateLimit: null, pageCursor: mapping.pageCursor };
      }
      return {
        ok: false,
        records: [],
        error: `stub read operation '${request.operation}' is not mapped by the module-level test stub`,
        rateLimit: null,
      };
    },
    mutate: async () => ({
      ok: false,
      providerRecordId: null,
      data: null,
      error: 'the read-only commerce stub declares no mutation capability',
      rateLimit: null,
    }),
    verifyWebhook: async (_context, delivery) => {
      const signature = delivery.headers['x-commerce-signature'] ?? delivery.headers['x-commerce-signature'.toLowerCase()] ?? null;
      if (signature === null || signature.trim() === '') {
        return { verified: false, reason: "missing signature header 'x-commerce-signature'", normalizedEventType: null };
      }
      const expected = createHmac('sha256', MODULE_WEBHOOK_SECRET)
        .update(JSON.stringify(delivery.payload))
        .digest('hex');
      if (signature !== expected) {
        return { verified: false, reason: 'HMAC signature mismatch', normalizedEventType: null };
      }
      const normalization = normalizeCommerceWebhookEvent(delivery.payload);
      if (!normalization.ok) {
        return { verified: false, reason: normalization.error, normalizedEventType: null };
      }
      return {
        verified: true,
        reason: null,
        normalizedEventType: `commerce:${delivery.eventType}`,
        eventIdentity: commerceWebhookEventIdentity(normalization),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// AC-1: the registry surface (capability discovery)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1 registry: the commerce adapter declares the FULL normalized commerce capability catalog as data', async () => {
  const response = await apiCall(port(), '/api/integrations/adapters', { token: aliceTokenValue });
  assert.equal(response.status, 200);
  const adapters = response.body['adapters'] as Record<string, unknown>[];
  const commerce = adapters.find((adapter) => adapter['adapterKey'] === 'commerce-cms');
  assert.ok(commerce !== undefined, 'the commerce-cms adapter is registered');
  const capabilities = commerce!['capabilities'] as Record<string, unknown>[];
  const keys = capabilities.map((capability) => capability['capabilityKey']) as string[];
  // The MKT-071 keys + the two unchanged MKT-024 capabilities.
  assert.deepEqual(
    [...keys].sort(),
    [
      'cms-content-read',
      'commerce-catalog-read',
      'commerce-event-stream',
      'commerce-inventory-read',
      'commerce-listing-manage',
      'commerce-order-webhook',
      'commerce-orders-read',
      'commerce-price-read',
      'commerce-product-read',
      'commerce-product-write',
    ].sort(),
  );
  const orders = capabilities.find((capability) => capability['capabilityKey'] === 'commerce-orders-read')!;
  assert.deepEqual(orders['operations'], ['listOrders', 'listOrderDetails']);
  const webhookCapability = capabilities.find((capability) => capability['capabilityKey'] === 'commerce-order-webhook')!;
  assert.deepEqual(webhookCapability['operations'], [
    'order.created',
    'order.updated',
    'order.fulfilled',
    'order.cancelled',
    'product.created',
    'product.updated',
  ]);
  assert.equal(webhookCapability['kind'], 'webhook');
  const productWrite = capabilities.find((capability) => capability['capabilityKey'] === 'commerce-product-write')!;
  assert.equal(productWrite['kind'], 'mutation');
});

// ---------------------------------------------------------------------------
// AC-7: the golden-path round-trip through the ROUTE surface
// ---------------------------------------------------------------------------

test('MKT-071 AC-1/AC-7 catalog: the paged catalog read maps categories + products and carries the page cursor', async () => {
  const page1 = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog', { limit: 2 });
  assert.equal(page1.status, 200, JSON.stringify(page1.body));
  assert.equal(page1.body['ok'], true);
  assert.equal(page1.body['adapterKey'], 'commerce-cms');
  assert.equal(page1.body['operation'], 'listCatalog');
  const records = page1.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record['providerRecordId']).sort(),
    [
      'commerce:catalog:category:cat_10',
      'commerce:catalog:product:prd_501',
      'commerce:catalog:product:prd_502',
    ],
  );
  // The record envelope: source-record (evidence-only — no fabricated metrics).
  const product = records.find((record) => record['providerRecordId'] === 'commerce:catalog:product:prd_501')!;
  const data = product['data'] as Record<string, unknown>;
  assert.equal(data['kind'], 'record');
  assert.equal(data['recordType'], 'commerce.product');
  assert.deepEqual(data['fields'], {
    providerProductId: 'prd_501',
    title: 'Tactical Apron',
    status: 'active',
    providerCategoryIds: ['cat_10'],
    variantCount: 2,
  });
  assert.equal(product['sourceTimestamp'], '2026-05-02T09:30:00.000Z');
  assert.equal(product['etag'], '"commerce-fixture-v1"');
  // Rate-limit metadata (§20).
  const rateLimit = page1.body['rateLimit'] as Record<string, unknown>;
  assert.equal(rateLimit['limitRemaining'], 12);
  // The page cursor feeds the next read.
  assert.equal(page1.body['pageCursor'], 'catalog-page-2');

  const page2 = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog', {
    cursor: 'catalog-page-2',
  });
  assert.equal(page2.status, 200);
  assert.equal(page2.body['ok'], true);
  const page2Records = page2.body['records'] as Record<string, unknown>[];
  assert.deepEqual(
    page2Records.map((record) => record['providerRecordId']).sort(),
    ['commerce:catalog:category:cat_20', 'commerce:catalog:product:prd_503'],
  );
  // The FINAL page carries NO cursor (the key is omitted entirely).
  assert.ok(!('pageCursor' in page2.body));
});

test('MKT-071 AC-1 product/price/inventory: the single-subject reads map to versioned source records', async () => {
  const product = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'getProduct', { productId: 'prd_501' });
  assert.equal(product.status, 200, JSON.stringify(product.body));
  assert.equal(product.body['ok'], true);
  const record = (product.body['records'] as Record<string, unknown>[])[0]!;
  assert.equal(record['providerRecordId'], 'commerce:product:prd_501');
  assert.equal(record['sourceVersion'], '7');
  const fields = ((record['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>);
  assert.equal(fields['providerProductId'], 'prd_501');
  assert.equal(fields['variantCount'], 2);
  const variants = fields['variants'] as Record<string, unknown>[];
  assert.deepEqual(variants[0], {
    providerVariantId: 'var_9',
    title: 'Black',
    price: 189,
    currency: 'USD',
    inventory: 12,
  });

  const price = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'getPrice', {
    productId: 'prd_501',
    variantId: 'var_9',
  });
  assert.equal(price.status, 200);
  assert.equal(price.body['ok'], true);
  const priceRecord = (price.body['records'] as Record<string, unknown>[])[0]!;
  assert.equal(priceRecord['providerRecordId'], 'commerce:price:prd_501:var_9');
  assert.deepEqual((priceRecord['data'] as Record<string, unknown>)['fields'], {
    providerProductId: 'prd_501',
    providerVariantId: 'var_9',
    amount: 189,
    currency: 'USD',
    compareAtAmount: 219,
  });
  assert.equal(priceRecord['sourceTimestamp'], '2026-05-03T10:00:00.000Z');

  const inventory = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'getInventory', {
    productId: 'prd_501',
    variantId: 'var_9',
  });
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body['ok'], true);
  const inventoryRecord = (inventory.body['records'] as Record<string, unknown>[])[0]!;
  assert.equal(inventoryRecord['providerRecordId'], 'commerce:inventory:prd_501:var_9');
  assert.deepEqual((inventoryRecord['data'] as Record<string, unknown>)['fields'], {
    providerProductId: 'prd_501',
    providerVariantId: 'var_9',
    available: 12,
    reserved: 1,
    incoming: 0,
  });

  // A read without its subject parameter fails closed as an honest data
  // error — the house bookkeeping then marks the pipe 'error' (the
  // observed health of the failed call), so the connection is RECONNECTED
  // (the probe passes) to keep the golden-path pipe live for the
  // subsequent round-trip stages.
  const noSubject = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'getProduct', {});
  assert.equal(noSubject.status, 200);
  assert.equal(noSubject.body['ok'], false);
  assert.match(String(noSubject.body['error']), /parameters.productId/);
  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);
});

test('MKT-071 AC-4/AC-7 listing lifecycle: the authorized mutation round-trip records the EXACT provider-visible side effects', async () => {
  const upsertsBefore = provider!.productUpserts().length;
  const listingMutationsBefore = provider!.listingMutations().length;

  const upsert = await mutate(aliceTokenValue, clientAId, aliceFullConnectionId, 'upsertProduct', {
    product: {
      id: 'prd_777',
      title: 'Trail Spork',
      status: 'active',
      variants: [{ id: 'var_77', title: 'Titanium', price: '12.50', currency: 'USD' }],
    },
  });
  assert.equal(upsert.status, 200, JSON.stringify(upsert.body));
  assert.equal(upsert.body['ok'], true);
  assert.equal(upsert.body['providerRecordId'], 'commerce:product:prd_777');
  const upsertData = upsert.body['data'] as Record<string, unknown>;
  assert.equal((upsertData['fields'] as Record<string, unknown>)['providerProductId'], 'prd_777');
  // The provider saw EXACTLY the mutation body (the recorded side effect).
  assert.equal(provider!.productUpserts().length, upsertsBefore + 1);
  assert.deepEqual(provider!.productUpserts().at(-1)!.body, {
    product: {
      id: 'prd_777',
      title: 'Trail Spork',
      status: 'active',
      variants: [{ id: 'var_77', title: 'Titanium', price: '12.50', currency: 'USD' }],
    },
  });

  const create = await mutate(aliceTokenValue, clientAId, aliceFullConnectionId, 'createListing', {
    listing: { productId: 'prd_777', price: '12.50', currency: 'USD', quantity: 5 },
  });
  assert.equal(create.status, 200, JSON.stringify(create.body));
  assert.equal(create.body['ok'], true);
  const createRecordId = create.body['providerRecordId'] as string;
  assert.match(createRecordId, /^commerce:listing:lst_\d+$/);
  assert.equal(
    ((create.body['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>)['listingStatus'],
    'active',
  );
  const listingId = createRecordId.slice('commerce:listing:'.length);

  const update = await mutate(aliceTokenValue, clientAId, aliceFullConnectionId, 'updateListing', {
    listingId,
    listing: { price: '11.00', quantity: 4 },
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body['ok'], true);
  const updateFields = (update.body['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>;
  assert.equal(updateFields['price'], 11);
  assert.equal(updateFields['quantity'], 4);

  const end = await mutate(aliceTokenValue, clientAId, aliceFullConnectionId, 'endListing', { listingId });
  assert.equal(end.status, 200, JSON.stringify(end.body));
  assert.equal(end.body['ok'], true);
  assert.equal(
    ((end.body['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>)['listingStatus'],
    'ended',
  );

  // The listing lifecycle at the provider: create → update → end, in order.
  const mutations = provider!.listingMutations().slice(listingMutationsBefore);
  assert.deepEqual(mutations.map((mutation) => mutation.kind), ['create', 'update', 'end']);
  assert.deepEqual(mutations[0]!.body, {
    listing: { productId: 'prd_777', price: '12.50', currency: 'USD', quantity: 5 },
  });

  // An undeclared operation is rejected by the capability-discovery gate
  // (422 — never a provider call).
  const undeclared = await mutate(aliceTokenValue, clientAId, aliceFullConnectionId, 'deleteCatalog', {});
  assert.equal(undeclared.status, 422);
  assert.equal(errorBody(undeclared)['code'], 'INVALID_REQUEST');
  assert.equal(provider!.listingMutations().length, listingMutationsBefore + 3);
});

test('MKT-071 AC-1/AC-5/AC-7 orders: the summary metric mapping is preserved and the detailed reads carry line items + attribution VERBATIM', async () => {
  // The frozen MKT-024 listOrders mapping (revenue metric observations).
  const summary = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listOrders');
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body['ok'], true);
  const summaryRecords = summary.body['records'] as Record<string, unknown>[];
  assert.equal(summaryRecords.length, 1);
  assert.equal(summaryRecords[0]!['providerRecordId'], 'commerce:order:ord_1001:revenue');
  const envelope = summaryRecords[0]!['data'] as Record<string, unknown>;
  assert.equal(envelope['kind'], 'metric');
  assert.equal(envelope['metricName'], 'commerce.revenue');
  assert.equal(envelope['value'], 249.9);
  assert.equal(envelope['unit'], 'USD');

  // The MKT-071 detailed reads: paged, line-item shape, attribution
  // passthrough VERBATIM (deep-equal — recorded, never interpreted).
  const details1 = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listOrderDetails');
  assert.equal(details1.status, 200, JSON.stringify(details1.body));
  assert.equal(details1.body['ok'], true);
  assert.equal(details1.body['pageCursor'], 'orders-page-2');
  const detailRecords = details1.body['records'] as Record<string, unknown>[];
  assert.equal(detailRecords.length, 1);
  const order = detailRecords[0]!;
  assert.equal(order['providerRecordId'], 'commerce:order:ord_2001');
  assert.equal(order['sourceTimestamp'], '2026-05-04T11:05:00.000Z');
  const orderFields = (order['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>;
  assert.deepEqual(orderFields['lineItems'], [
    {
      providerProductId: 'prd_501',
      providerVariantId: 'var_9',
      title: 'Tactical Apron',
      quantity: 1,
      unitPrice: 189,
    },
  ]);
  assert.deepEqual(orderFields['attribution'], ATTRIBUTION);

  const details2 = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listOrderDetails', {
    cursor: 'orders-page-2',
  });
  assert.equal(details2.status, 200);
  assert.equal(details2.body['ok'], true);
  const page2Records = details2.body['records'] as Record<string, unknown>[];
  assert.equal(page2Records.length, 1);
  const order2Fields = ((page2Records[0]!['data'] as Record<string, unknown>)['fields'] as Record<string, unknown>);
  assert.equal((order2Fields['lineItems'] as unknown[]).length, 1);
  // The empty-attribution order carries the EMPTY passthrough object.
  assert.deepEqual(order2Fields['attribution'], {});
  assert.ok(!('pageCursor' in details2.body));
});

// ---------------------------------------------------------------------------
// AC-3/AC-5/AC-6: webhook golden path + replay idempotency + history
// ---------------------------------------------------------------------------

test('MKT-071 AC-3/AC-5/AC-6 webhook: the first delivery ingests once (ledger + evidence + projection); the REPLAY is an honest no-op duplicate', async () => {
  const eventsBefore = (await integrationEvents(aliceTokenValue, clientAId)).length;
  const evidenceBefore = await clientEvidenceCount(aliceTokenValue, clientAId);
  const commerceEventsBefore = (await commerceEvents(aliceTokenValue, clientAId)).length;

  const first = await webhook(aliceTokenValue, clientAId, aliceFullConnectionId, ORDER_EVENT_PAYLOAD, WEBHOOK_SECRET);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body['eventType'], 'commerce:order.created');
  assert.equal(first.body['duplicate'], false);
  const receipt = first.body['commerceReceipt'] as Record<string, unknown>;
  assert.equal(receipt['deliveryOutcome'], 'ingested');
  assert.ok(!('firstReceiptId' in receipt));
  assert.match(String(receipt['rawEventHash']), /^[0-9a-f]{64}$/);
  assert.equal(receipt['eventKind'], 'order.created');
  assert.equal(receipt['normalizedShapeVersion'], 'commerce-order-v1');
  assert.equal(receipt['providerEventId'], 'evt_9001');
  const projection = first.body['commerceEvent'] as Record<string, unknown>;
  assert.equal(projection['providerEventId'], 'evt_9001');
  assert.equal(projection['providerSubjectId'], 'ord_2001');
  assert.equal(projection['eventKind'], 'order.created');
  assert.equal(projection['eventId'], first.body['eventId']);
  // AC-5: the attribution/reference fields VERBATIM on the projection.
  assert.deepEqual(projection['attribution'], ATTRIBUTION);
  const normalizedPayload = projection['normalizedPayload'] as Record<string, unknown>;
  const normalizedOrder = normalizedPayload['order'] as Record<string, unknown>;
  assert.deepEqual(normalizedOrder['attribution'], ATTRIBUTION);
  assert.deepEqual(normalizedOrder['lineItems'], [
    {
      providerProductId: 'prd_501',
      providerVariantId: 'var_9',
      title: 'Tactical Apron',
      quantity: 1,
      unitPrice: 189,
    },
  ]);

  // Event-stream continuity (AC-6): exactly ONE ledger event + ONE pinned
  // source_fact evidence observation + ONE projection appended.
  assert.equal((await integrationEvents(aliceTokenValue, clientAId)).length, eventsBefore + 1);
  assert.equal(await clientEvidenceCount(aliceTokenValue, clientAId), evidenceBefore + 1);
  assert.equal((await commerceEvents(aliceTokenValue, clientAId)).length, commerceEventsBefore + 1);
  const evidenceRef = first.body['evidenceRef'] as string;
  const fact = await apiCall(port(), `/api/evidence/${evidenceRef}`, { token: aliceTokenValue });
  assert.equal(fact.status, 200);
  const factBody = fact.body as Record<string, unknown>;
  assert.equal(factBody['class'], 'source_fact');
  assert.equal(factBody['quality'], 'C');
  assert.deepEqual((factBody['content'] as Record<string, unknown>)['payload'], ORDER_EVENT_PAYLOAD);

  // THE REPLAY: 200, duplicate: true, the duplicate receipt referencing the
  // first delivery, the ORIGINAL projection returned — and NOTHING new
  // anywhere (the no-op).
  const replay = await webhook(aliceTokenValue, clientAId, aliceFullConnectionId, ORDER_EVENT_PAYLOAD, WEBHOOK_SECRET);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['duplicate'], true);
  assert.equal(replay.body['eventId'], first.body['eventId']);
  const replayReceipt = replay.body['commerceReceipt'] as Record<string, unknown>;
  assert.equal(replayReceipt['deliveryOutcome'], 'duplicate');
  assert.equal(replayReceipt['firstReceiptId'], receipt['receiptId']);
  assert.equal(replayReceipt['rawEventHash'], receipt['rawEventHash']);
  const replayProjection = replay.body['commerceEvent'] as Record<string, unknown>;
  assert.equal(replayProjection['commerceEventId'], projection['commerceEventId']);
  assert.equal((await integrationEvents(aliceTokenValue, clientAId)).length, eventsBefore + 1);
  assert.equal(await clientEvidenceCount(aliceTokenValue, clientAId), evidenceBefore + 1);
  assert.equal((await commerceEvents(aliceTokenValue, clientAId)).length, commerceEventsBefore + 1);

  // A SECOND replay with a MUTATED payload under the reused event id: the
  // duplicate receipt records ITS OWN hash — the mutation is VISIBLE in
  // the history (honest provenance, never a silent rewrite).
  const mutatedPayload = {
    ...ORDER_EVENT_PAYLOAD,
    order: { ...ORDER_EVENT_PAYLOAD.order, total: '999.00' },
  };
  const mutatedReplay = await webhook(aliceTokenValue, clientAId, aliceFullConnectionId, mutatedPayload, WEBHOOK_SECRET);
  assert.equal(mutatedReplay.status, 200);
  assert.equal(mutatedReplay.body['duplicate'], true);
  const mutatedReceipt = mutatedReplay.body['commerceReceipt'] as Record<string, unknown>;
  assert.notEqual(mutatedReceipt['rawEventHash'], receipt['rawEventHash']);
  assert.equal((await commerceEvents(aliceTokenValue, clientAId)).length, commerceEventsBefore + 1);

  // A product event ingests with its own shape version.
  const productEvent = await webhook(aliceTokenValue, clientAId, aliceFullConnectionId, PRODUCT_EVENT_PAYLOAD, WEBHOOK_SECRET);
  assert.equal(productEvent.status, 201, JSON.stringify(productEvent.body));
  assert.equal(productEvent.body['duplicate'], false);
  const productProjection = productEvent.body['commerceEvent'] as Record<string, unknown>;
  assert.equal(productProjection['normalizedShapeVersion'], 'commerce-product-v1');
  assert.equal(productProjection['providerSubjectId'], 'prd_501');

  // THE EVENT HISTORY READ-BACK (AC-7): the receipts list shows the honest
  // delivery history (ingested + duplicates, newest first) and the
  // projection list shows exactly one row per INGESTED event.
  const receiptsList = await commerceReceipts(aliceTokenValue, clientAId);
  const evt9001Receipts = receiptsList.filter((row) => row['providerEventId'] === 'evt_9001');
  assert.equal(evt9001Receipts.length, 3);
  assert.equal(evt9001Receipts.filter((row) => row['deliveryOutcome'] === 'ingested').length, 1);
  assert.equal(evt9001Receipts.filter((row) => row['deliveryOutcome'] === 'duplicate').length, 2);
  assert.ok(
    evt9001Receipts.every((row) => (row['provenance'] as Record<string, unknown>)['receivedAt'] !== undefined),
  );
  const eventsList = await commerceEvents(aliceTokenValue, clientAId);
  const evt9001Events = eventsList.filter((row) => row['providerEventId'] === 'evt_9001');
  assert.equal(evt9001Events.length, 1);
  assert.deepEqual(evt9001Events[0]!['attribution'], ATTRIBUTION);

  // The legacy event ledger carries BOTH ingested commerce events (the
  // event-stream continuity through the SAME surface).
  const ledger = await integrationEvents(aliceTokenValue, clientAId);
  const commerceLedgerEvents = ledger.filter((row) => String(row['eventType']).startsWith('commerce:'));
  assert.ok(commerceLedgerEvents.length >= 2);
  assert.ok(commerceLedgerEvents.some((row) => row['eventId'] === projection['eventId']));
});

test('MKT-071 AC-3 fail-closed webhook: a forged signature records NOTHING; an unmappable event with an id is rejected', async () => {
  const eventsBefore = (await integrationEvents(aliceTokenValue, clientAId)).length;
  const receiptsBefore = (await commerceReceipts(aliceTokenValue, clientAId)).length;

  const forged = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'order.created',
      payload: ORDER_EVENT_PAYLOAD,
      headers: { 'x-commerce-signature': '0'.repeat(64) },
    },
  });
  assert.equal(forged.status, 422);
  assert.equal(errorBody(forged)['code'], 'INVALID_REQUEST');
  assert.equal((await integrationEvents(aliceTokenValue, clientAId)).length, eventsBefore);
  assert.equal((await commerceReceipts(aliceTokenValue, clientAId)).length, receiptsBefore);

  // An event id with an UNKNOWN kind fails closed (the closed vocabulary).
  const unknownKind = await webhook(aliceTokenValue, clientAId, aliceFullConnectionId, {
    eventId: 'evt_9999',
    kind: 'listing.ended',
    order: { id: 'ord_x' },
  }, WEBHOOK_SECRET);
  assert.equal(unknownKind.status, 422);
  assert.equal((await commerceReceipts(aliceTokenValue, clientAId)).length, receiptsBefore);
});

// ---------------------------------------------------------------------------
// AC-4: the policy-gated mutation battery
// ---------------------------------------------------------------------------

test('MKT-071 AC-4 policy: the client-scoped mutate DENY fails closed with ZERO provider mutations; the decision carries the capability key', async () => {
  const upsertsBefore = provider!.productUpserts().length;
  const listingsBefore = provider!.listingMutations().length;

  const denied = await mutate(bobTokenValue, clientBId, bobCommerceConnectionId, 'upsertProduct', {
    product: { title: 'Should Never Exist' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');

  // ZERO provider traffic (the sandbox counter is the proof).
  assert.equal(provider!.productUpserts().length, upsertsBefore);
  assert.equal(provider!.listingMutations().length, listingsBefore);

  // The denial landed in the append-only policy-decision ledger WITH the
  // attempted capability key on the decision (the honest 403-equivalent
  // error record names WHICH commerce mutation capability was attempted).
  const decisions = await apiCall(port(), `/api/clients/${clientBId}/policy-decisions`, {
    token: bobTokenValue,
  });
  assert.equal(decisions.status, 200);
  const listed = decisions.body['decisions'] as Record<string, unknown>[];
  const capabilityDecisions = listed.filter(
    (decision) =>
      decision['dimension'] === 'network' &&
      (decision['action'] as Record<string, unknown> | undefined)?.['attributes'] !== undefined &&
      ((decision['action'] as Record<string, unknown>)['attributes'] as Record<string, unknown>)['capability'] === 'commerce-product-write',
  );
  assert.ok(
    capabilityDecisions.length > 0,
    'a policy decision carries the attempted commerce capability key (its own capability key)',
  );
});

test('MKT-071 AC-4 policy: the CAPABILITY-SCOPED deny blocks product writes while listing management stays allowed (its own capability key)', async () => {
  const upsertsBefore = provider!.productUpserts().length;
  const listingsBefore = provider!.listingMutations().length;

  // The product write is denied (the capability-scoped rule matches the
  // commerce-product-write capability attribute).
  const denied = await mutate(aliceTokenValue, clientCId, aliceClientCConnectionId, 'upsertProduct', {
    product: { title: 'Denied Product' },
  });
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');
  assert.equal(provider!.productUpserts().length, upsertsBefore);

  // The listing mutation on the SAME connection is allowed (the scoped
  // deny does not match the commerce-listing-manage capability).
  const allowed = await mutate(aliceTokenValue, clientCId, aliceClientCConnectionId, 'createListing', {
    listing: { productId: 'prd_501', price: '189.00', currency: 'USD', quantity: 1 },
  });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal(allowed.body['ok'], true);
  assert.equal(provider!.listingMutations().length, listingsBefore + 1);
});

test('MKT-071 AC-4 provider scopes: the read-only credential refuses mutations honestly BEFORE provider traffic; the lying credential surfaces the provider 403', async () => {
  const upsertsBefore = provider!.productUpserts().length;

  // The READ-ONLY connection's READS work (catalog:read is granted) —
  // asserted FIRST because the refused mutation's bookkeeping honestly
  // marks that pipe 'error' (the observed health of the refused call).
  const readOk = await read(aliceTokenValue, clientAId, aliceReadOnlyConnectionId, 'listCatalog');
  assert.equal(readOk.status, 200);
  assert.equal(readOk.body['ok'], true);

  // The READ-ONLY credential: the adapter-side scope pre-check refuses
  // BEFORE any provider traffic (an honest data error — never a silent
  // skip, never a fabricated success).
  const refused = await mutate(aliceTokenValue, clientAId, aliceReadOnlyConnectionId, 'upsertProduct', {
    product: { title: 'Refused Product' },
  });
  assert.equal(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(refused.body['ok'], false);
  assert.match(String(refused.body['error']), /does not grant the scope/);
  assert.match(String(refused.body['error']), /products:write/);
  assert.equal(provider!.productUpserts().length, upsertsBefore);

  // The LYING credential (material claims write scopes; the token lacks
  // them): the provider's own 403 surfaces as the invalid-scope taxonomy.
  const lying = await mutate(aliceTokenValue, clientAId, aliceLyingConnectionId, 'upsertProduct', {
    product: { title: 'Lying Product' },
  });
  assert.equal(lying.status, 200, JSON.stringify(lying.body));
  assert.equal(lying.body['ok'], false);
  assert.match(String(lying.body['error']), /invalid-scope/);
  assert.equal(provider!.productUpserts().length, upsertsBefore);
});

// ---------------------------------------------------------------------------
// AC-2: the error taxonomy
// ---------------------------------------------------------------------------

test('MKT-071 AC-2 taxonomy: rate-limited, provider-down, unauthorized and malformed provider responses map to labeled honest data errors', async () => {
  // NOTE: the house bookkeeping honestly marks the pipe 'error' after
  // every failed provider call (the observed health of the failed call),
  // so the golden-path connection is RECONNECTED between the taxonomy
  // cases (the probe passes — the failures are provider-side modes, not
  // pipe deaths).
  provider!.setMode('rate-limited');
  const rateLimited = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog');
  assert.equal(rateLimited.status, 200, JSON.stringify(rateLimited.body));
  assert.equal(rateLimited.body['ok'], false);
  assert.match(String(rateLimited.body['error']), /rate-limited/);
  const rateLimit = rateLimited.body['rateLimit'] as Record<string, unknown>;
  assert.equal(rateLimit['retryAfterSeconds'], 30);
  provider!.setMode('ok');
  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);

  provider!.setMode('provider-down');
  const down = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog');
  assert.equal(down.status, 200, JSON.stringify(down.body));
  assert.equal(down.body['ok'], false);
  assert.match(String(down.body['error']), /provider-down/);
  provider!.setMode('ok');
  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);

  provider!.setMode('unauthorized');
  const unauthorized = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog');
  assert.equal(unauthorized.status, 200);
  assert.equal(unauthorized.body['ok'], false);
  assert.match(String(unauthorized.body['error']), /unauthorized/);
  provider!.setMode('ok');
  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);

  provider!.setMode('malformed');
  const malformed = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog');
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body['ok'], false);
  assert.match(String(malformed.body['error']), /malformed catalog payload/);
  provider!.setMode('ok');
  await connectConnection(aliceTokenValue, clientAId, aliceFullConnectionId);

  // The pipe recovers (the bookkeeping converges back to connected/healthy).
  const recovered = await read(aliceTokenValue, clientAId, aliceFullConnectionId, 'listCatalog');
  assert.equal(recovered.body['ok'], true);
  assert.equal((recovered.body['connection'] as Record<string, unknown>)['health'], 'healthy');
});

test('MKT-071 AC-2/AC-8 taxonomy: a dead provider endpoint fails the probe (error/unreachable) and capability calls through the dead pipe are the fail-closed 409', async () => {
  // The connection was registered against a dead loopback port: the
  // connect probe HONESTLY reports the unreachable provider.
  const current = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceDeadConnectionId}`, {
    token: aliceTokenValue,
  });
  assert.equal(current.status, 200);
  const connected = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceDeadConnectionId}/connect`, {
    token: aliceTokenValue,
    body: { expectedVersion: current.body['version'] as number },
  });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.equal(connected.body['status'], 'error');
  assert.equal(connected.body['health'], 'unreachable');
  assert.match(String(connected.body['lastError'] ?? ''), /unreachable|refused/i);

  // Capability calls through a dead pipe are the house ConflictError
  // (fail-closed — NO provider traffic through dead pipes); the
  // provider-down DATA error is the taxonomy case above (a connected
  // pipe whose provider dies between calls).
  const requestsBefore = provider!.requestCount();
  const dead = await read(aliceTokenValue, clientAId, aliceDeadConnectionId, 'listCatalog');
  assert.equal(dead.status, 409, JSON.stringify(dead.body));
  assert.equal(errorBody(dead)['code'], 'CONFLICT');
  assert.equal(provider!.requestCount(), requestsBefore);
});

// ---------------------------------------------------------------------------
// AC-8: the fail-closed isolation battery
// ---------------------------------------------------------------------------

test('MKT-071 AC-8 isolation: anonymous 401; foreign/unknown/malformed identifiers are the UNIFORM 404; a suspended membership is the 403', async () => {
  // Anonymous (no token) on every commerce surface.
  const anonymousEvents = await apiCall(port(), `/api/clients/${clientAId}/commerce-events`);
  assert.equal(anonymousEvents.status, 401);
  const anonymousReceipts = await apiCall(port(), `/api/clients/${clientAId}/commerce-event-receipts`);
  assert.equal(anonymousReceipts.status, 401);
  const anonymousWebhook = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/webhook`, {
    body: { eventType: 'order.created', payload: ORDER_EVENT_PAYLOAD, headers: {} },
  });
  assert.equal(anonymousWebhook.status, 401);

  // A foreign connection id under alice's authorized path is the SAME
  // uniform 404 as an unknown or malformed one (no traversal oracle).
  const foreignRead = await read(aliceTokenValue, clientAId, bobCommerceConnectionId, 'listCatalog');
  assert.equal(foreignRead.status, 404);
  assert.equal(errorBody(foreignRead)['code'], 'NOT_FOUND');
  const unknownRead = await read(aliceTokenValue, clientAId, '0199aaaa-0000-7000-8000-000000000001', 'listCatalog');
  assert.equal(unknownRead.status, 404);
  const malformedRead = await read(aliceTokenValue, clientAId, 'not-a-uuid', 'listCatalog');
  assert.equal(malformedRead.status, 404);
  const foreignWebhook = await apiCall(port(), `/api/clients/${clientAId}/connections/${bobCommerceConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: { eventType: 'order.created', payload: ORDER_EVENT_PAYLOAD, headers: commerceWebhookSignature(WEBHOOK_SECRET, ORDER_EVENT_PAYLOAD) },
  });
  assert.equal(foreignWebhook.status, 404);

  // Bob reading ALICE's commerce surfaces is the uniform 404 (foreign
  // Client — indistinguishable from unknown).
  const foreignClientReceipts = await apiCall(port(), `/api/clients/${clientAId}/commerce-event-receipts`, {
    token: bobTokenValue,
  });
  assert.equal(foreignClientReceipts.status, 404);
  const foreignClientEvents = await apiCall(port(), `/api/clients/${clientAId}/commerce-events`, {
    token: bobTokenValue,
  });
  assert.equal(foreignClientEvents.status, 404);
  const unknownClientEvents = await apiCall(port(), '/api/clients/0199bbbb-0000-7000-8000-000000000001/commerce-events', {
    token: aliceTokenValue,
  });
  assert.equal(unknownClientEvents.status, 404);

  // A malformed CLIENT identifier on the commerce read-back surfaces is
  // the SAME uniform 404 (the house UUID guard — it never reaches the
  // database).
  const malformedClient = await apiCall(port(), '/api/clients/not-a-uuid/commerce-events', {
    token: aliceTokenValue,
  });
  assert.equal(malformedClient.status, 404);

  // A suspended membership of the owning agency is the 403.
  const suspended = await apiCall(port(), `/api/clients/${clientAId}/commerce-events`, {
    token: suspendedMemberToken,
  });
  assert.equal(suspended.status, 403, JSON.stringify(suspended.body));
});

test('MKT-071 AC-8 isolation: a SUSPENDED connection is a 409 with ZERO provider traffic; a cross-tenant provider event id is rejected fail-closed', async () => {
  // Suspend the lying connection (no longer needed) — capability calls
  // through a suspended pipe are the house Conflict, no provider traffic.
  const current = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceLyingConnectionId}`, {
    token: aliceTokenValue,
  });
  const suspendedPipe = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceLyingConnectionId}/suspend`, {
    token: aliceTokenValue,
    body: { expectedVersion: current.body['version'] as number, reason: 'MKT-071 suspended-pipe battery' },
  });
  assert.equal(suspendedPipe.status, 200);
  assert.equal(suspendedPipe.body['status'], 'suspended');
  const requestsBefore = provider!.requestCount();
  const suspendedRead = await read(aliceTokenValue, clientAId, aliceLyingConnectionId, 'listCatalog');
  assert.equal(suspendedRead.status, 409, JSON.stringify(suspendedRead.body));
  assert.equal(errorBody(suspendedRead)['code'], 'CONFLICT');
  assert.equal(provider!.requestCount(), requestsBefore);

  // A CROSS-TENANT provider event id: Bob delivers an event id already
  // INGESTED through Alice's connection — the global provider event-id
  // namespace is tenant-fenced (fail-closed 409, never a cross-tenant
  // duplicate record or oracle).
  const crossTenant = await webhook(bobTokenValue, clientBId, bobCommerceConnectionId, ORDER_EVENT_PAYLOAD, BOB_WEBHOOK_SECRET);
  assert.equal(crossTenant.status, 409, JSON.stringify(crossTenant.body));
  assert.equal(errorBody(crossTenant)['code'], 'CONFLICT');
  // Bob's own event history gained NOTHING from the rejected delivery.
  const bobReceipts = await commerceReceipts(bobTokenValue, clientBId);
  assert.equal(bobReceipts.filter((row) => row['providerEventId'] === 'evt_9001').length, 0);
});

// ---------------------------------------------------------------------------
// AC-1/AC-7: the PARTIAL-CAPABILITY adapter at MODULE level (the
// in-process instance with the REAL read-only CommerceCmsAdapter)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1/AC-7 partial capability: the read-only adapter round-trips its subset through MODULE-level operations and rejects the rest', async () => {
  const theModule = moduleInstance!;

  // The registry of the module-level instance declares the READ-ONLY
  // commerce surface: every commerce capability EXCEPT the two mutations
  // (the stub carries no legacy MKT-024 capabilities — it is the pure
  // read-only subset).
  const registry = theModule.listRegisteredAdapters();
  const commerce = registry.find((adapter) => adapter.descriptor.adapterKey === 'commerce-cms')!;
  assert.deepEqual(
    commerce.capabilities.map((capability) => capability.capabilityKey).sort(),
    [...COMMERCE_READ_ONLY_CAPABILITY_KEYS].sort(),
  );

  // The subset round-trips HONESTLY through the module-level gate chain.
  const catalog = await theModule.executeRead(
    { connectionId: moduleConnectionId, operation: 'listCatalog', parameters: {} },
    provenance(),
  );
  assert.equal(catalog.ok, true);
  assert.equal(catalog.operation, 'listCatalog');
  assert.equal(catalog.records.length, 3);
  assert.equal(catalog.pageCursor, 'catalog-page-2');
  assert.equal(catalog.adapterKey, 'commerce-cms');

  const orderDetails = await theModule.executeRead(
    { connectionId: moduleConnectionId, operation: 'listOrderDetails', parameters: {} },
    provenance(),
  );
  assert.equal(orderDetails.ok, true);
  assert.equal(orderDetails.records[0]!.providerRecordId, 'commerce:order:ord_2001');

  // The mutation the adapter does NOT declare is rejected by the module's
  // capability-discovery gate — even though the credential's scopes would
  // allow it (the DECLARATION is the gate; never a provider call).
  const upsertsBefore = provider!.productUpserts().length;
  await assert.rejects(
    theModule.executeMutation(
      { connectionId: moduleConnectionId, operation: 'upsertProduct', parameters: { product: { title: 'Nope' } } },
      provenance(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(
        (error.details ?? []).some((detail) => detail.includes('not declared by any mutation capability')),
        'the honest problem names the undeclared mutation operation',
      );
      return true;
    },
  );
  assert.equal(provider!.productUpserts().length, upsertsBefore);

  // The webhook idempotency works identically at module level: first
  // delivery ingests, replay duplicates honestly.
  const evidenceBefore = moduleEvidenceAppends.length;
  const first = await theModule.ingestWebhookEvent(
    {
      connectionId: moduleConnectionId,
      eventType: 'order.fulfilled',
      payload: MODULE_ORDER_EVENT_PAYLOAD,
      headers: commerceWebhookSignature(MODULE_WEBHOOK_SECRET, MODULE_ORDER_EVENT_PAYLOAD),
    },
    provenance(),
  );
  assert.equal(first.duplicate, false);
  assert.equal(first.commerceReceipt!.deliveryOutcome, 'ingested');
  assert.equal(first.commerceEvent!.eventKind, 'order.fulfilled');
  assert.deepEqual(first.commerceEvent!.attribution, {
    attributionRef: 'mission:gm_882',
    utmSource: 'tiktok',
  });
  assert.equal(moduleEvidenceAppends.length, evidenceBefore + 1);

  const replay = await theModule.ingestWebhookEvent(
    {
      connectionId: moduleConnectionId,
      eventType: 'order.fulfilled',
      payload: MODULE_ORDER_EVENT_PAYLOAD,
      headers: commerceWebhookSignature(MODULE_WEBHOOK_SECRET, MODULE_ORDER_EVENT_PAYLOAD),
    },
    provenance(),
  );
  assert.equal(replay.duplicate, true);
  assert.equal(replay.commerceReceipt!.deliveryOutcome, 'duplicate');
  assert.equal(replay.commerceReceipt!.firstReceiptId, first.commerceReceipt!.receiptId);
  assert.equal(replay.commerceEvent!.commerceEventId, first.commerceEvent!.commerceEventId);
  assert.equal(moduleEvidenceAppends.length, evidenceBefore + 1);

  // The read-backs through the module surface include the module-level
  // receipt (the shared DB, the shared fence).
  const receipts: readonly CommerceEventReceiptRecord[] =
    await theModule.listCommerceEventReceiptsForClient(clientAId);
  assert.ok(
    receipts.some((row) => row.providerEventId === 'evt_mod_1' && row.deliveryOutcome === 'ingested'),
  );
  const events: readonly CommerceEventRecord[] = await theModule.listCommerceEventsForClient(clientAId);
  assert.ok(events.some((row) => row.providerEventId === 'evt_mod_1' && row.providerSubjectId === 'ord_3001'));
  assert.ok(
    events.every((row) => row.providerEventId !== 'evt_mod_1' || row.adapterKey === 'commerce-cms'),
  );
});

// ---------------------------------------------------------------------------
// AC-1/AC-7: the PARTIAL-CAPABILITY adapter at ROUTE level (the REAL
// read-only CommerceCmsAdapter — the second spawned API process)
// ---------------------------------------------------------------------------

test('MKT-071 AC-1/AC-7 partial capability (routes): the REAL read-only commerce adapter round-trips its subset and rejects the rest', async () => {
  // The registry of the read-only deployment: the commerce adapter
  // declares NO mutation capability (the provider grant is the profile).
  const registry = await apiCall(readOnlyPort(), '/api/integrations/adapters', { token: aliceTokenValue });
  assert.equal(registry.status, 200);
  const commerce = (registry.body['adapters'] as Record<string, unknown>[]).find(
    (adapter) => adapter['adapterKey'] === 'commerce-cms',
  )!;
  const keys = (commerce['capabilities'] as Record<string, unknown>[]).map(
    (capability) => capability['capabilityKey'],
  );
  assert.ok(keys.includes('commerce-catalog-read'));
  assert.ok(keys.includes('commerce-order-webhook'));
  assert.ok(!keys.includes('commerce-product-write'));
  assert.ok(!keys.includes('commerce-listing-manage'));

  // The subset round-trips HONESTLY through the route surface: alice's
  // FULL-scope connection (registered through the full API, resolved
  // against the read-only registry — the same adapterKey data) reads the
  // catalog against the REAL provider double.
  const catalog = await apiCall(readOnlyPort(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/read`, {
    token: aliceTokenValue,
    body: { operation: 'listCatalog', parameters: {} },
  });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body['ok'], true);
  assert.equal((catalog.body['records'] as unknown[]).length, 3);
  assert.equal(catalog.body['pageCursor'], 'catalog-page-2');

  // The mutation the adapter does NOT declare is rejected by the
  // capability-discovery gate — even though the credential's granted
  // scopes WOULD allow it (the DECLARATION is the gate — the adapter never
  // claims a mutation capability the provider grant does not include).
  const upsertsBefore = provider!.productUpserts().length;
  const refused = await apiCall(readOnlyPort(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/mutate`, {
    token: aliceTokenValue,
    body: { operation: 'upsertProduct', parameters: { product: { title: 'Never' } } },
  });
  assert.equal(refused.status, 422, JSON.stringify(refused.body));
  assert.equal(errorBody(refused)['code'], 'INVALID_REQUEST');
  assert.ok(
    (errorBody(refused)['details'] as string[] | undefined)?.some((detail) =>
      detail.includes('not declared by any mutation capability'),
    ),
    'the honest problem names the undeclared mutation operation',
  );
  assert.equal(provider!.productUpserts().length, upsertsBefore);

  // The webhook capability REMAINS in the read-only profile — order
  // events ingest idempotently through the read-only deployment too.
  const readOnlyEventPayload = {
    eventId: 'evt_ro_1',
    kind: 'order.cancelled',
    occurredAt: '2026-05-09T08:00:00.000Z',
    order: {
      id: 'ord_4001',
      status: 'cancelled',
      currency: 'USD',
      total: '10.00',
      lineItems: [{ productId: 'prd_501', quantity: 1, unitPrice: '10.00' }],
      attribution: { attributionRef: 'mission:gm_882' },
    },
  };
  const first = await apiCall(readOnlyPort(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'order.cancelled',
      payload: readOnlyEventPayload,
      headers: commerceWebhookSignature(WEBHOOK_SECRET, readOnlyEventPayload),
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body['duplicate'], false);
  const replay = await apiCall(readOnlyPort(), `/api/clients/${clientAId}/connections/${aliceFullConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'order.cancelled',
      payload: readOnlyEventPayload,
      headers: commerceWebhookSignature(WEBHOOK_SECRET, readOnlyEventPayload),
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body['duplicate'], true);
});
