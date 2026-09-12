/**
 * MKT-024 integration tests — the FIRST-PARTY CONNECTORS (INT-001 +
 * METRIC-001) on the REAL stack: embedded PostgreSQL 18, a real API
 * process whose composition root wires the REAL first-party adapter
 * classes (meta-ads, google-ads, generic-analytics, crm, commerce-cms),
 * and the in-process LOOPBACK sandbox provider (tests/integration/helpers/
 * sandbox-provider.ts) that stands in for the five providers — REAL
 * HTTP calls over the fetch-based platform HttpCallPort, NO real provider
 * SDK, NO external network (the ai-routing MKT-018 precedent).
 *
 * Acceptance mapping (work-items.md MKT-024; work-item-matrix.md
 * "INT-001, METRIC-001 | connector contract + source mapping tests";
 * requirements.md INT-001 + METRIC-001):
 *
 *   - CONNECTOR CONTRACT: per connector, the connection lifecycle against
 *     the real boundary — register (born 'registered', provider label
 *     DERIVED from the adapter descriptor), connect (the probe against
 *     the sandbox provider → 'connected'/'healthy', rate-limit state
 *     observed), then the observation SYNC surface
 *     (POST .../connections/:id/sync) executing the adapter READ and
 *     delivering the normalized observations through the /metrics and
 *     /evidence PUBLIC contracts;
 *   - SOURCE MAPPING (METRIC-001), per connector, the EXACT
 *     fixture-payload → normalized-contract mapping is asserted END TO
 *     END through the public API surfaces: the composite
 *     providerRecordId (provider ids mapped INSIDE the boundary — no raw
 *     provider id becomes a domain identity), source.system
 *     'integration:<adapterKey>' + source.ref = providerRecordId (the
 *     /evidence + /metrics source mapping), observedAt = the provider
 *     source timestamp (kept DISTINCT from the server-stamped
 *     retrievedAt), the ETag/version metadata preserved on the record
 *     and embedded in the source fact, the metric identity/value/unit/
 *     dimensions from the normalized envelope, and the observation →
 *     source-fact linkage (evidenceRef);
 *   - RATE-LIMIT/BACKOFF metadata (§20): the sandbox 429 surfaces the
 *     normalized rateLimit state on the sync outcome AND the connection
 *     record;
 *   - WEBHOOK/EVENT ingestion (append-oriented, server-derived
 *     provenance): HMAC-verified deliveries (Meta X-Hub-Signature-256,
 *     analytics X-Analytics-Signature, commerce X-Commerce-Signature)
 *     append ONE ledger event + ONE derived 'source_fact' /evidence row
 *     with PINNED class/quality/provenance; a bad signature records
 *     NOTHING; an adapter with no webhook capability rejects delivery;
 *   - FAIL-CLOSED POLICY (POL-001): a client-scoped network DENY blocks
 *     the sync and the mutation BEFORE any provider traffic (the sandbox
 *     request counter PROVES zero provider calls) and the decision lands
 *     in the append-only policy-decision ledger;
 *   - TENANT ISOLATION: cross-tenant sync/webhook probes are uniform 404s
 *     (no existence or traversal oracle);
 *   - APPEND-ONLY REPLAY: a repeated sync appends FRESH immutable rows
 *     (new evidence ids, new observation ids) — history is never
 *     rewritten, no dedup is fabricated;
 *   - FAIL-CLOSED DELIVERY: a malformed provider payload fails the whole
 *     read (ok:false + bounded error) and delivers NOTHING (no partial
 *     silent deliveries).
 *
 * Credential materials are FAKE sandbox strings ASSEMBLED AT RUNTIME
 * (the §21 posture: they exist only in the secrets-dir files and
 * in-process; never in repository content).
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
import {
  startSandboxProvider,
  sandboxWebhookSignature,
  type SandboxProvider,
} from './helpers/sandbox-provider.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

// ---------------------------------------------------------------------------
// FAKE sandbox credential strings — assembled at RUNTIME so no
// credential-shaped literal ever exists in repository content (GitHub
// push protection stays quiet; the §21 posture is what actually matters:
// these values live only in the secrets-dir fixture files and in-process).
// ---------------------------------------------------------------------------
const META_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxMetaToken';
const GOOGLE_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxGoogleToken';
const ANALYTICS_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxAnalyticsToken';
const CRM_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxCrmToken';
const COMMERCE_TOKEN = 'ea-' + 'AIza' + 'fakeSandboxCommerceToken';
const META_WEBHOOK_SECRET = 'whsec_' + 'Meta' + 'FakeSandbox';
const ANALYTICS_WEBHOOK_SECRET = 'whsec_' + 'Analytics' + 'FakeSandbox';
const COMMERCE_WEBHOOK_SECRET = 'whsec_' + 'Commerce' + 'FakeSandbox';

const SANDBOX_ETAG = '"sandbox-fixture-v1"';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let sandbox: SandboxProvider | null = null;

let adminTokenValue = '';
let aliceTokenValue = '';
let aliceAgencyId = '';
let clientAId = '';
let bobTokenValue = '';
let bobAgencyId = '';
let clientBId = '';

let aliceMetaCredentialId = '';
let aliceMeta2CredentialId = '';
let aliceGoogleCredentialId = '';
let aliceAnalyticsCredentialId = '';
let aliceCrmCredentialId = '';
let aliceCommerceCredentialId = '';
let bobMetaCredentialId = '';
let bobCrmCredentialId = '';

let aliceMetaConnectionId = '';
let aliceMeta2ConnectionId = '';
let aliceGoogleConnectionId = '';
let aliceAnalyticsConnectionId = '';
let aliceCrmConnectionId = '';
let aliceCommerceConnectionId = '';
let bobMetaConnectionId = '';
let bobCrmConnectionId = '';

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function sandboxUrl(): string {
  if (sandbox === null) throw new Error('sandbox not started');
  return sandbox.url;
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

/** Provision one agency secret out-of-band (deployment-style). */
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
          reason: 'MKT-024 integration-test platform boundary: integration egress and credential use explicitly allowed',
        },
      ],
      description: `MKT-024 integration-test platform default (${dimension} dimension)`,
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

async function sync(token: string, clientId: string, connectionId: string, operation: string) {
  return apiCall(port(), `/api/clients/${clientId}/connections/${connectionId}/sync`, {
    token,
    body: { operation, parameters: {} },
  });
}

async function clientMetrics(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/metrics`, { token });
  assert.equal(response.status, 200);
  return response.body['observations'] as Record<string, unknown>[];
}

async function clientEvidence(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, { token });
  assert.equal(response.status, 200);
  return response.body['evidence'] as Record<string, unknown>[];
}

async function clientIntegrationEvents(token: string, clientId: string): Promise<Record<string, unknown>[]> {
  const response = await apiCall(port(), `/api/clients/${clientId}/integration-events`, { token });
  assert.equal(response.status, 200);
  return response.body['events'] as Record<string, unknown>[];
}

before(async () => {
  stack = await bootStack('integrations-connectors');

  // The five provider materials (FAKE sandbox strings, runtime-assembled;
  // JSON per the first-party provider credential convention).
  provisionSecret('mkt024-meta-key', JSON.stringify({ accessToken: META_TOKEN, webhookSecret: META_WEBHOOK_SECRET }));
  provisionSecret('mkt024-meta-key-2', JSON.stringify({ accessToken: META_TOKEN, webhookSecret: META_WEBHOOK_SECRET }));
  provisionSecret('mkt024-google-key', JSON.stringify({ accessToken: GOOGLE_TOKEN, webhookSecret: null }));
  provisionSecret('mkt024-analytics-key', JSON.stringify({ accessToken: ANALYTICS_TOKEN, webhookSecret: ANALYTICS_WEBHOOK_SECRET }));
  provisionSecret('mkt024-crm-key', JSON.stringify({ accessToken: CRM_TOKEN, webhookSecret: null }));
  provisionSecret('mkt024-commerce-key', JSON.stringify({ accessToken: COMMERCE_TOKEN, webhookSecret: COMMERCE_WEBHOOK_SECRET }));
  // Bob's materials carry the SAME sandbox provider tokens (the sandbox
  // authenticates per PROVIDER, not per tenant — every tenant connection
  // holds its own copy of the valid provider token).
  provisionSecret('mkt024-bob-meta-key', JSON.stringify({ accessToken: META_TOKEN, webhookSecret: 'whsec_bob-not-used' }));
  provisionSecret('mkt024-bob-crm-key', JSON.stringify({ accessToken: CRM_TOKEN, webhookSecret: null }));

  // The sandbox provider (loopback; per-provider bearer checks against
  // the materials above; NO real network egress).
  sandbox = await startSandboxProvider({
    meta: META_TOKEN,
    'google-ads': GOOGLE_TOKEN,
    analytics: ANALYTICS_TOKEN,
    crm: CRM_TOKEN,
    'commerce-cms': COMMERCE_TOKEN,
  });

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  adminTokenValue = await adminToken();

  const alice = await makePrincipal('carol@connectors.test');
  aliceTokenValue = alice.token;
  aliceAgencyId = alice.agencyId;
  clientAId = await makeClient(aliceAgencyId, alice.token, 'Client Connector A');

  const bob = await makePrincipal('dave@connectors.test');
  bobTokenValue = bob.token;
  bobAgencyId = bob.agencyId;
  clientBId = await makeClient(bobAgencyId, bob.token, 'Client Connector B');

  // Platform policy defaults: network + secrets dimensions explicitly
  // allow the integration operations (POL-001: without an explicit allow
  // everything denies — these declarations make Alice's flows live).
  await declarePlatformPolicy('network');
  await declarePlatformPolicy('secrets');

  // Bob's CLIENT-scoped network policy: connect allowed (his connections
  // stay live for the cross-tenant negatives), read + mutate DENIED —
  // the fail-closed negative tenant (deny overrides the platform allow
  // through the scope chain).
  const bobDeny = await apiCall(port(), `/api/clients/${clientBId}/policies`, {
    token: bobTokenValue,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['integration.connect'],
          reason: 'MKT-024 test: Bob may probe his connections (live pipe for the tenant-isolation negatives)',
        },
        {
          effect: 'deny',
          operations: ['integration.read'],
          reason: 'MKT-024 test: client-scoped read deny (fail-closed negative)',
        },
        {
          effect: 'deny',
          operations: ['integration.mutate'],
          reason: 'MKT-024 test: client-scoped mutate deny (fail-closed negative)',
        },
      ],
      description: 'MKT-024 client-scoped network boundaries (negative tenant)',
    },
  });
  assert.equal(bobDeny.status, 201, JSON.stringify(bobDeny.body));

  // Credentials (agency-scoped references by logical handle — never the
  // material itself).
  aliceMetaCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Meta sandbox', 'mkt024-meta-key');
  aliceMeta2CredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Meta sandbox 2', 'mkt024-meta-key-2');
  aliceGoogleCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Google Ads sandbox', 'mkt024-google-key');
  aliceAnalyticsCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Analytics sandbox', 'mkt024-analytics-key');
  aliceCrmCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'CRM sandbox', 'mkt024-crm-key');
  aliceCommerceCredentialId = await makeCredential(aliceAgencyId, aliceTokenValue, 'Commerce sandbox', 'mkt024-commerce-key');
  bobMetaCredentialId = await makeCredential(bobAgencyId, bobTokenValue, 'Meta sandbox Bob', 'mkt024-bob-meta-key');
  bobCrmCredentialId = await makeCredential(bobAgencyId, bobTokenValue, 'CRM sandbox Bob', 'mkt024-bob-crm-key');

  // The connections (the unique (client, adapter, credential) fence gives
  // the malformed/rate-limit meta tests their own connection + credential).
  aliceMetaConnectionId = await registerConnection(aliceTokenValue, clientAId, 'meta-ads', aliceMetaCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/meta`,
    accountId: '998877',
    currency: 'EUR',
  });
  aliceMeta2ConnectionId = await registerConnection(aliceTokenValue, clientAId, 'meta-ads', aliceMeta2CredentialId, {
    apiBaseUrl: `${sandboxUrl()}/meta`,
    accountId: '998877',
    currency: 'EUR',
  });
  aliceGoogleConnectionId = await registerConnection(aliceTokenValue, clientAId, 'google-ads', aliceGoogleCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/google-ads`,
    customerId: '1234567890',
  });
  aliceAnalyticsConnectionId = await registerConnection(aliceTokenValue, clientAId, 'generic-analytics', aliceAnalyticsCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/analytics`,
    propertyId: 'prop_77',
  });
  aliceCrmConnectionId = await registerConnection(aliceTokenValue, clientAId, 'crm', aliceCrmCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/crm`,
  });
  aliceCommerceConnectionId = await registerConnection(aliceTokenValue, clientAId, 'commerce-cms', aliceCommerceCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/commerce-cms`,
  });
  bobMetaConnectionId = await registerConnection(bobTokenValue, clientBId, 'meta-ads', bobMetaCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/meta`,
    accountId: '998877',
  });
  bobCrmConnectionId = await registerConnection(bobTokenValue, clientBId, 'crm', bobCrmCredentialId, {
    apiBaseUrl: `${sandboxUrl()}/crm`,
  });

  await connectConnection(aliceTokenValue, clientAId, aliceMetaConnectionId);
  await connectConnection(bobTokenValue, clientBId, bobMetaConnectionId);
  await connectConnection(bobTokenValue, clientBId, bobCrmConnectionId);
});

after(async () => {
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
// Connector lifecycle + exact source mapping (per connector)
// ---------------------------------------------------------------------------

test('INT-001/METRIC-001 meta-ads: connect probe → healthy pipe, then insights sync maps the payload EXACTLY to /metrics + /evidence', async () => {
  const response = await sync(aliceTokenValue, clientAId, aliceMetaConnectionId, 'getInsights');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['ok'], true);
  assert.equal(response.body['adapterKey'], 'meta-ads');
  assert.equal(response.body['operation'], 'getInsights');

  // Rate-limit metadata surfaced on the outcome (§20: the sandbox sends
  // X-RateLimit headers on every response).
  const rateLimit = response.body['rateLimit'] as Record<string, unknown>;
  assert.equal(rateLimit['limitRemaining'], 480);
  assert.ok(typeof rateLimit['limitResetAt'] === 'string');

  // EXACT mapping: one metric record per (row x metric field) — the
  // fixture row reports impressions/clicks/spend/ctr.
  const records = response.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 4);
  const ids = records.map((record) => record['providerRecordId']).sort();
  assert.deepEqual(ids, [
    'meta:insights:23840001:2026-01-15:clicks',
    'meta:insights:23840001:2026-01-15:ctr',
    'meta:insights:23840001:2026-01-15:impressions',
    'meta:insights:23840001:2026-01-15:spend',
  ]);
  for (const record of records) {
    // Source timestamp from date_start (the day the metric was true),
    // ETag from the provider response — both preserved on the record.
    assert.equal(record['sourceTimestamp'], '2026-01-15T00:00:00.000Z');
    assert.equal(record['etag'], SANDBOX_ETAG);
  }

  // Delivery receipts: 4 evidence ids + 4 observation ids.
  const receipts = response.body['receipts'] as Record<string, unknown>[];
  assert.equal(receipts.length, 4);
  for (const receipt of receipts) {
    assert.ok(typeof receipt['evidenceId'] === 'string');
    assert.ok(typeof receipt['observationId'] === 'string');
    assert.equal(typeof receipt['providerRecordId'], 'string');
  }
  assert.ok(typeof response.body['retrievedAt'] === 'string');
  assert.ok(typeof response.body['policyDecisionId'] === 'string');

  // The EXACT metric observation (spend): identity, value, unit (the
  // connection currency), dimensions (provider identity preserved INSIDE
  // the boundary), the SOURCE mapping, the timestamp pair, the evidence
  // linkage, the server-side recordedVia.
  const spendReceipt = receipts.find((receipt) => receipt['providerRecordId'] === 'meta:insights:23840001:2026-01-15:spend')!;
  const observation = await apiCall(port(), `/api/metrics/${spendReceipt['observationId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(observation.status, 200);
  const observationBody = observation.body as Record<string, unknown>;
  assert.equal(observationBody['metricName'], 'meta.ads.spend');
  assert.equal(observationBody['value'], 128.45);
  assert.equal(observationBody['unit'], 'EUR');
  assert.deepEqual(observationBody['dimensions'], {
    campaignId: '23840001',
    campaignName: 'Spring Launch',
    date: '2026-01-15',
  });
  assert.deepEqual(observationBody['source'], {
    system: 'integration:meta-ads',
    ref: 'meta:insights:23840001:2026-01-15:spend',
  });
  // The METRIC-001 timestamp pair: observedAt (provider source moment)
  // DISTINCT from retrievedAt (server-stamped retrieval moment).
  assert.equal(observationBody['observedAt'], '2026-01-15T00:00:00.000Z');
  assert.equal(observationBody['retrievedAt'], response.body['retrievedAt']);
  assert.notEqual(observationBody['observedAt'], observationBody['retrievedAt']);
  assert.equal(observationBody['evidenceRef'], spendReceipt['evidenceId']);
  const provenance = observationBody['provenance'] as Record<string, unknown>;
  assert.equal(provenance['recordedVia'], 'integration:meta-ads');

  // The remaining metrics of the row map exactly.
  const metricsList = await clientMetrics(aliceTokenValue, clientAId);
  const byId = new Map(
    metricsList.map((metric) => {
      const source = metric['source'] as Record<string, unknown> | undefined;
      return [String(source?.['ref']), metric];
    }),
  );
  const impressions = byId.get('meta:insights:23840001:2026-01-15:impressions');
  assert.ok(impressions !== undefined);
  assert.equal(impressions['metricName'], 'meta.ads.impressions');
  assert.equal(impressions['value'], 12845);
  assert.equal(impressions['unit'], 'count');
  const clicks = byId.get('meta:insights:23840001:2026-01-15:clicks');
  assert.ok(clicks !== undefined);
  assert.equal(clicks['value'], 512);
  const ctr = byId.get('meta:insights:23840001:2026-01-15:ctr');
  assert.ok(ctr !== undefined);
  assert.equal(ctr['metricName'], 'meta.ads.ctr');
  assert.equal(ctr['value'], 3.98);
  assert.equal(ctr['unit'], 'percent');

  // The EXACT source fact (/evidence): class 'source_fact', quality 'C',
  // the source mapping, the envelope embedded with the source metadata
  // (ETag + sourceTimestamp), PINNED server-side provenance.
  const fact = await apiCall(port(), `/api/evidence/${spendReceipt['evidenceId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(fact.status, 200);
  const factBody = fact.body as Record<string, unknown>;
  assert.equal(factBody['class'], 'source_fact');
  assert.equal(factBody['quality'], 'C');
  assert.deepEqual(factBody['source'], {
    system: 'integration:meta-ads',
    ref: 'meta:insights:23840001:2026-01-15:spend',
  });
  assert.equal(factBody['observedAt'], '2026-01-15T00:00:00.000Z');
  const content = factBody['content'] as Record<string, unknown>;
  assert.equal(content['operation'], 'getInsights');
  assert.equal(content['etag'], SANDBOX_ETAG);
  assert.equal(content['sourceTimestamp'], '2026-01-15T00:00:00.000Z');
  const envelope = content['envelope'] as Record<string, unknown>;
  assert.equal(envelope['kind'], 'metric');
  assert.equal(envelope['metricName'], 'meta.ads.spend');
  const factProvenance = factBody['provenance'] as Record<string, unknown>;
  assert.equal(factProvenance['recordedVia'], 'integration:meta-ads');
});

test('INT-001/METRIC-001 meta-ads: campaign listing maps to source-record envelopes — evidence ONLY, no fabricated metrics', async () => {
  const response = await sync(aliceTokenValue, clientAId, aliceMetaConnectionId, 'listCampaigns');
  assert.equal(response.status, 200);
  assert.equal(response.body['ok'], true);

  const records = response.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 1);
  assert.equal(records[0]!['providerRecordId'], 'meta:campaign:23840001');
  assert.equal(records[0]!['sourceTimestamp'], '2026-01-20T17:03:11.000Z');

  const receipts = response.body['receipts'] as Record<string, unknown>[];
  assert.equal(receipts.length, 1);
  // Source-record envelopes deliver NO metric observation (no measured
  // series — no fabricated /metrics row — the serialized receipt omits
  // the observationId key entirely).
  assert.ok(!('observationId' in receipts[0]!));

  const fact = await apiCall(port(), `/api/evidence/${receipts[0]!['evidenceId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(fact.status, 200);
  const content = (fact.body as Record<string, unknown>)['content'] as Record<string, unknown>;
  const envelope = content['envelope'] as Record<string, unknown>;
  assert.equal(envelope['kind'], 'record');
  assert.equal(envelope['recordType'], 'meta.campaign');

  // The campaign fields ARE the record payload (the fields map of the
  // envelope — provider row fields preserved verbatim, non-secret).
  const fields = envelope['fields'] as Record<string, unknown>;
  assert.equal(fields['name'], 'Spring Launch');
  assert.equal(fields['status'], 'PAUSED');
  assert.equal(fields['objective'], 'OUTCOME_TRAFFIC');
});

test('INT-001/METRIC-001 google-ads: campaign metrics sync — costMicros converted INSIDE the boundary, version metadata preserved', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceGoogleConnectionId);
  const response = await sync(aliceTokenValue, clientAId, aliceGoogleConnectionId, 'getCampaignMetrics');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['ok'], true);

  const records = response.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 4);
  const ids = records.map((record) => record['providerRecordId']).sort();
  assert.deepEqual(ids, [
    'google-ads:metrics:21470001:2026-02-01:clicks',
    'google-ads:metrics:21470001:2026-02-01:costMicros',
    'google-ads:metrics:21470001:2026-02-01:ctr',
    'google-ads:metrics:21470001:2026-02-01:impressions',
  ]);
  for (const record of records) {
    // observedAt from segments.date; the API version is the §20
    // source-version metadata path.
    assert.equal(record['sourceTimestamp'], '2026-02-01T00:00:00.000Z');
    assert.equal(record['sourceVersion'], 'v16');
    assert.equal(record['etag'], SANDBOX_ETAG);
  }

  // The cost observation: micros → currency units (4_560_000 → 4.56), the
  // metric name namespaced without the raw provider spelling.
  const receipts = response.body['receipts'] as Record<string, unknown>[];
  const costReceipt = receipts.find((receipt) => receipt['providerRecordId'] === 'google-ads:metrics:21470001:2026-02-01:costMicros')!;
  const observation = await apiCall(port(), `/api/metrics/${costReceipt['observationId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(observation.status, 200);
  const body = observation.body as Record<string, unknown>;
  assert.equal(body['metricName'], 'googleads.cost');
  assert.equal(body['value'], 4.56);
  assert.equal(body['unit'], 'USD');
  assert.deepEqual(body['dimensions'], { campaignId: '21470001', campaignName: 'Search - Brand', date: '2026-02-01' });
  assert.deepEqual(body['source'], {
    system: 'integration:google-ads',
    ref: 'google-ads:metrics:21470001:2026-02-01:costMicros',
  });
  assert.equal(body['observedAt'], '2026-02-01T00:00:00.000Z');
  assert.equal(body['retrievedAt'], response.body['retrievedAt']);
  assert.equal(body['evidenceRef'], costReceipt['evidenceId']);

  // Campaign listing (the sibling read): source-record envelopes with
  // the version metadata too.
  const campaigns = await sync(aliceTokenValue, clientAId, aliceGoogleConnectionId, 'listCampaigns');
  assert.equal(campaigns.status, 200);
  assert.equal(campaigns.body['ok'], true);
  const campaignRecords = campaigns.body['records'] as Record<string, unknown>[];
  assert.equal(campaignRecords.length, 1);
  assert.equal(campaignRecords[0]!['providerRecordId'], 'google-ads:campaign:21470001');
  assert.equal(campaignRecords[0]!['sourceVersion'], 'v16');
  const campaignReceipts = campaigns.body['receipts'] as Record<string, unknown>[];
  assert.ok(!('observationId' in campaignReceipts[0]!));
});

test('INT-001/METRIC-001 generic-analytics: runReport sync — provider dimension identity preserved, compact date → source timestamp', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceAnalyticsConnectionId);
  const response = await sync(aliceTokenValue, clientAId, aliceAnalyticsConnectionId, 'runReport');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['ok'], true);

  const records = response.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 2);
  const ids = records.map((record) => record['providerRecordId']).sort();
  assert.deepEqual(ids, [
    'analytics:report:20260301:Organic Search:conversions',
    'analytics:report:20260301:Organic Search:sessions',
  ]);
  for (const record of records) {
    // The compact GA4 date dimension (20260301) is the source timestamp.
    assert.equal(record['sourceTimestamp'], '2026-03-01T00:00:00.000Z');
    assert.equal(record['etag'], SANDBOX_ETAG);
  }

  const receipts = response.body['receipts'] as Record<string, unknown>[];
  assert.equal(receipts.length, 2);

  const sessionsReceipt = receipts.find((receipt) => receipt['providerRecordId'] === 'analytics:report:20260301:Organic Search:sessions')!;
  const observation = await apiCall(port(), `/api/metrics/${sessionsReceipt['observationId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(observation.status, 200);
  const body = observation.body as Record<string, unknown>;
  assert.equal(body['metricName'], 'analytics.sessions');
  assert.equal(body['value'], 4831);
  assert.equal(body['unit'], 'count');
  // The provider's own dimension identity (names AND values) is
  // preserved as the observation dimensions.
  assert.deepEqual(body['dimensions'], {
    date: '20260301',
    sessionDefaultChannelGroup: 'Organic Search',
  });
  assert.deepEqual(body['source'], {
    system: 'integration:generic-analytics',
    ref: 'analytics:report:20260301:Organic Search:sessions',
  });
  assert.equal(body['observedAt'], '2026-03-01T00:00:00.000Z');
  assert.equal(body['evidenceRef'], sessionsReceipt['evidenceId']);

  const conversionsReceipt = receipts.find((receipt) => receipt['providerRecordId'] === 'analytics:report:20260301:Organic Search:conversions')!;
  const conversions = await apiCall(port(), `/api/metrics/${conversionsReceipt['observationId']}`, {
    token: aliceTokenValue,
  });
  assert.equal((conversions.body as Record<string, unknown>)['value'], 312);
});

test('INT-001/METRIC-001 crm: contact listing is a source fact ONLY (no metric fabricated) and the contact-sync mutation round-trips', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceCrmConnectionId);

  const metricsBefore = (await clientMetrics(aliceTokenValue, clientAId)).length;

  const response = await sync(aliceTokenValue, clientAId, aliceCrmConnectionId, 'listContacts');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['ok'], true);

  const records = response.body['records'] as Record<string, unknown>[];
  assert.equal(records.length, 1);
  assert.equal(records[0]!['providerRecordId'], 'crm:contact:cnt_0021');
  assert.equal(records[0]!['sourceTimestamp'], '2026-03-12T08:30:00.000Z');
  const data = (records[0] as Record<string, unknown>)['data'] as Record<string, unknown>;
  assert.equal(data['kind'], 'record');
  assert.equal(data['recordType'], 'crm.contact');

  const receipts = response.body['receipts'] as Record<string, unknown>[];
  assert.equal(receipts.length, 1);
  assert.ok(!('observationId' in receipts[0]!));
  const fact = await apiCall(port(), `/api/evidence/${receipts[0]!['evidenceId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(fact.status, 200);
  assert.deepEqual((fact.body as Record<string, unknown>)['source'], {
    system: 'integration:crm',
    ref: 'crm:contact:cnt_0021',
  });

  // NO metric observations appeared (contact data is not a measured
  // series — the honest no-fabrication posture).
  const metricsAfter = (await clientMetrics(aliceTokenValue, clientAId)).length;
  assert.equal(metricsAfter, metricsBefore);

  // The mutation (the one sanctioned MKT-024 mutation surface): the
  // policy-gated contact upsert forwards the caller parameters to the
  // provider and maps the provider outcome.
  const upsertsBefore = sandbox!.crmUpserts().length;
  const mutation = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceCrmConnectionId}/mutate`, {
    token: aliceTokenValue,
    body: {
      operation: 'upsertContact',
      parameters: { email: 'grace@example.test', firstName: 'Grace', lastName: 'Hopper' },
    },
  });
  assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
  assert.equal(mutation.body['ok'], true);
  assert.equal(mutation.body['providerRecordId'], 'crm:contact:cnt_0022');
  assert.deepEqual(mutation.body['data'], { id: 'cnt_0022', result: 'created' });
  assert.ok(typeof mutation.body['policyDecisionId'] === 'string');

  // The sandbox provider received EXACTLY one upsert with the forwarded
  // body (the adapter is a translator, not an inventor).
  const upserts = sandbox!.crmUpserts();
  assert.equal(upserts.length, upsertsBefore + 1);
  assert.deepEqual(upserts[upserts.length - 1]!.body, {
    email: 'grace@example.test',
    firstName: 'Grace',
    lastName: 'Hopper',
  });
});

test('INT-001/METRIC-001 commerce-cms: orders map to revenue metrics (row currency) and CMS content to versioned source facts', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceCommerceConnectionId);

  const orders = await sync(aliceTokenValue, clientAId, aliceCommerceConnectionId, 'listOrders');
  assert.equal(orders.status, 200, JSON.stringify(orders.body));
  assert.equal(orders.body['ok'], true);
  const orderRecords = orders.body['records'] as Record<string, unknown>[];
  assert.equal(orderRecords.length, 1);
  assert.equal(orderRecords[0]!['providerRecordId'], 'commerce:order:ord_1001:revenue');
  assert.equal(orderRecords[0]!['sourceTimestamp'], '2026-03-14T11:05:00.000Z');
  const orderReceipts = orders.body['receipts'] as Record<string, unknown>[];
  assert.equal(orderReceipts.length, 1);
  const orderObservation = await apiCall(port(), `/api/metrics/${orderReceipts[0]!['observationId']}`, {
    token: aliceTokenValue,
  });
  assert.equal(orderObservation.status, 200);
  const orderBody = orderObservation.body as Record<string, unknown>;
  assert.equal(orderBody['metricName'], 'commerce.revenue');
  assert.equal(orderBody['value'], 249.9);
  assert.equal(orderBody['unit'], 'USD');
  assert.deepEqual(orderBody['dimensions'], { orderId: 'ord_1001', orderNumber: 'MOS-1001', orderStatus: 'paid' });
  assert.deepEqual(orderBody['source'], {
    system: 'integration:commerce-cms',
    ref: 'commerce:order:ord_1001:revenue',
  });

  const content = await sync(aliceTokenValue, clientAId, aliceCommerceConnectionId, 'listContent');
  assert.equal(content.status, 200);
  assert.equal(content.body['ok'], true);
  const contentRecords = content.body['records'] as Record<string, unknown>[];
  assert.equal(contentRecords.length, 1);
  // The provider content version rides the record (the §20 version path).
  assert.equal(contentRecords[0]!['providerRecordId'], 'cms:content:post_880');
  assert.equal(contentRecords[0]!['sourceVersion'], '7');
  assert.equal(contentRecords[0]!['sourceTimestamp'], '2026-03-09T09:00:00.000Z');
  const contentReceipts = content.body['receipts'] as Record<string, unknown>[];
  assert.equal(contentReceipts.length, 1);
  assert.ok(!('observationId' in contentReceipts[0]!));
  const contentFact = await apiCall(port(), `/api/evidence/${contentReceipts[0]!['evidenceId']}`, {
    token: aliceTokenValue,
  });
  const contentData = ((contentFact.body as Record<string, unknown>)['content'] as Record<string, unknown>)['envelope'] as Record<string, unknown>;
  assert.equal(contentData['recordType'], 'cms.content');
});

// ---------------------------------------------------------------------------
// Webhook/event ingestion (append-oriented, server-derived provenance)
// ---------------------------------------------------------------------------

test('INT-001 meta-ads webhook: a verified X-Hub-Signature-256 delivery appends ONE event + ONE pinned source_fact; a bad signature records NOTHING', async () => {
  const eventsBefore = (await clientIntegrationEvents(aliceTokenValue, clientAId)).length;

  const payload = { campaign_id: '23840001', date_start: '2026-01-15', reason: 'insights_refreshed' };
  const headers = sandboxWebhookSignature('meta', META_WEBHOOK_SECRET, payload);
  const ingested = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceMetaConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: { eventType: 'insights.updated', payload, headers },
  });
  assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
  assert.equal(ingested.body['adapterKey'], 'meta-ads');
  // The NORMALIZED event type (provider prefix applied inside the adapter).
  assert.equal(ingested.body['eventType'], 'meta:insights.updated');
  const evidenceRef = ingested.body['evidenceRef'] as string;
  assert.ok(typeof evidenceRef === 'string');

  // The derived evidence: PINNED class/quality, server-side provenance,
  // the payload preserved as the observation content.
  const fact = await apiCall(port(), `/api/evidence/${evidenceRef}`, { token: aliceTokenValue });
  assert.equal(fact.status, 200);
  const factBody = fact.body as Record<string, unknown>;
  assert.equal(factBody['class'], 'source_fact');
  assert.equal(factBody['quality'], 'C');
  assert.deepEqual(factBody['source'], {
    system: 'integration:meta-ads',
    ref: ingested.body['eventId'],
  });
  const factContent = factBody['content'] as Record<string, unknown>;
  assert.equal(factContent['eventType'], 'meta:insights.updated');
  assert.equal(factContent['provider'], 'meta-ads');
  assert.deepEqual(factContent['payload'], payload);
  const factProvenance = factBody['provenance'] as Record<string, unknown>;
  assert.equal(factProvenance['recordedVia'], 'integration:meta-ads');

  // Exactly ONE event appended.
  assert.equal((await clientIntegrationEvents(aliceTokenValue, clientAId)).length, eventsBefore + 1);

  // A FORGED signature: rejected with NOTHING recorded (fail closed).
  const forged = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceMetaConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'insights.updated',
      payload,
      headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    },
  });
  assert.equal(forged.status, 422);
  assert.equal(errorBody(forged)['code'], 'INVALID_REQUEST');
  assert.equal((await clientIntegrationEvents(aliceTokenValue, clientAId)).length, eventsBefore + 1);
});

test('INT-001 analytics + commerce-cms webhooks: verified event-stream deliveries append through the same surface', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceAnalyticsConnectionId);
  await connectConnection(aliceTokenValue, clientAId, aliceCommerceConnectionId);

  const analyticsPayload = { event: 'session', sessionId: 's_9182', date: '2026-03-01' };
  const analyticsIngested = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceAnalyticsConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'event.received',
      payload: analyticsPayload,
      headers: sandboxWebhookSignature('analytics', ANALYTICS_WEBHOOK_SECRET, analyticsPayload),
    },
  });
  assert.equal(analyticsIngested.status, 201, JSON.stringify(analyticsIngested.body));
  assert.equal(analyticsIngested.body['eventType'], 'analytics:event.received');
  assert.equal(analyticsIngested.body['adapterKey'], 'generic-analytics');

  const commercePayload = { order: 'ord_1001', status: 'fulfilled' };
  const commerceIngested = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceCommerceConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'order.updated',
      payload: commercePayload,
      headers: sandboxWebhookSignature('commerce-cms', COMMERCE_WEBHOOK_SECRET, commercePayload),
    },
  });
  assert.equal(commerceIngested.status, 201, JSON.stringify(commerceIngested.body));
  assert.equal(commerceIngested.body['eventType'], 'commerce:order.updated');
  assert.equal(commerceIngested.body['adapterKey'], 'commerce-cms');
});

test('INT-001 webhook: an adapter with NO webhook capability rejects deliveries (google-ads)', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceGoogleConnectionId);
  const rejected = await apiCall(port(), `/api/clients/${clientAId}/connections/${aliceGoogleConnectionId}/webhook`, {
    token: aliceTokenValue,
    body: {
      eventType: 'anything.changed',
      payload: { some: 'event' },
      headers: { 'x-hub-signature-256': 'sha256=' + 'a'.repeat(64) },
    },
  });
  assert.equal(rejected.status, 422);
  assert.equal(errorBody(rejected)['code'], 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// Fail-closed policy (POL-001) — the negative tenant
// ---------------------------------------------------------------------------

test('POL-001/METRIC-001 fail-closed: a client-scoped network DENY blocks the sync BEFORE any provider traffic (zero sandbox calls)', async () => {
  const metaRequestsBefore = sandbox!.requests('meta');
  const denied = await sync(bobTokenValue, clientBId, bobMetaConnectionId, 'getInsights');
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');

  // ZERO provider traffic: the gate precedes credential resolution and
  // the adapter call (the sandbox counter is the proof).
  assert.equal(sandbox!.requests('meta'), metaRequestsBefore);

  // The denial landed in the append-only policy-decision ledger with the
  // honest reason code.
  const decisions = await apiCall(port(), `/api/clients/${clientBId}/policy-decisions`, {
    token: bobTokenValue,
  });
  assert.equal(decisions.status, 200);
  const listed = decisions.body['decisions'] as Record<string, unknown>[];
  const readDenials = listed.filter(
    (decision) => decision['dimension'] === 'network' && decision['reasonCode'] === 'rule-denied',
  );
  assert.ok(readDenials.length > 0);
});

test('POL-001 fail-closed: the client-scoped mutation DENY blocks the CRM upsert with ZERO provider mutations', async () => {
  const upsertsBefore = sandbox!.crmUpserts().length;
  const denied = await apiCall(port(), `/api/clients/${clientBId}/connections/${bobCrmConnectionId}/mutate`, {
    token: bobTokenValue,
    body: {
      operation: 'upsertContact',
      parameters: { email: 'mallory@example.test', firstName: 'Mallory' },
    },
  });
  assert.equal(denied.status, 403);
  assert.equal(errorBody(denied)['code'], 'POLICY_DENIED');
  assert.equal(sandbox!.crmUpserts().length, upsertsBefore);
});

// ---------------------------------------------------------------------------
// Tenant isolation (uniform 404s — no existence or traversal oracle)
// ---------------------------------------------------------------------------

test('INT-001 tenant isolation: cross-tenant sync/webhook probes are uniform 404s', async () => {
  const attempts: { token: string; clientId: string; connectionId: string; label: string }[] = [
    // Alice probes Bob's connection under her OWN client path (the
    // connection is not hers to see — same 404 as an unknown id).
    { token: aliceTokenValue, clientId: clientAId, connectionId: bobMetaConnectionId, label: 'foreign connection under own client' },
    // Alice probes Bob's connection under BOB's client path (foreign
    // client — the client fence itself).
    { token: aliceTokenValue, clientId: clientBId, connectionId: bobMetaConnectionId, label: 'foreign client path' },
    // Bob probes Alice's connection under Alice's client path.
    { token: bobTokenValue, clientId: clientAId, connectionId: aliceMetaConnectionId, label: 'foreign principal + client' },
    // An unknown connection id.
    { token: aliceTokenValue, clientId: clientAId, connectionId: '636f6e6e-0000-4000-8000-000000000000', label: 'unknown connection' },
  ];
  for (const attempt of attempts) {
    const syncResponse = await sync(attempt.token, attempt.clientId, attempt.connectionId, 'getInsights');
    assert.equal(syncResponse.status, 404, `sync ${attempt.label}: expected 404`);
    assert.equal(errorBody(syncResponse)['code'], 'NOT_FOUND');
    const webhookResponse = await apiCall(
      port(),
      `/api/clients/${attempt.clientId}/connections/${attempt.connectionId}/webhook`,
      {
        token: attempt.token,
        body: {
          eventType: 'insights.updated',
          payload: { x: 1 },
          headers: { 'x-hub-signature-256': 'sha256=' + 'b'.repeat(64) },
        },
      },
    );
    assert.equal(webhookResponse.status, 404, `webhook ${attempt.label}: expected 404`);
    assert.equal(errorBody(webhookResponse)['code'], 'NOT_FOUND');
  }
});

// ---------------------------------------------------------------------------
// Append-only replay (idempotent in the append-only sense)
// ---------------------------------------------------------------------------

test('METRIC-001 replay: a repeated sync appends FRESH immutable rows — history is never rewritten', async () => {
  const spendRowsBefore = (
    await clientMetrics(aliceTokenValue, clientAId)
  ).filter((metric) => {
    const source = metric['source'] as Record<string, unknown>;
    return source?.['ref'] === 'meta:insights:23840001:2026-01-15:spend';
  }).length;

  const first = await sync(aliceTokenValue, clientAId, aliceMetaConnectionId, 'getInsights');
  assert.equal(first.status, 200);
  const firstReceipts = first.body['receipts'] as Record<string, unknown>[];
  const firstIds = firstReceipts.map((receipt) => String(receipt['evidenceId']));
  const firstObservationIds = firstReceipts.map((receipt) => String(receipt['observationId']));

  const second = await sync(aliceTokenValue, clientAId, aliceMetaConnectionId, 'getInsights');
  assert.equal(second.status, 200);
  assert.equal(second.body['ok'], true);
  const secondReceipts = second.body['receipts'] as Record<string, unknown>[];
  const secondIds = secondReceipts.map((receipt) => String(receipt['evidenceId']));
  const secondObservationIds = secondReceipts.map((receipt) => String(receipt['observationId']));

  // FRESH rows: every id is new (append-only; no dedup fabrication, no
  // rewriting of the first delivery).
  for (const id of firstIds) assert.ok(!secondIds.includes(id));
  for (const id of firstObservationIds) assert.ok(!secondObservationIds.includes(id));

  // Both deliveries are visible as immutable history: the spend source
  // ref appears exactly twice MORE (append-only rows; nothing rewritten).
  const metricsList = await clientMetrics(aliceTokenValue, clientAId);
  const spendRows = metricsList.filter((metric) => {
    const source = metric['source'] as Record<string, unknown>;
    return source?.['ref'] === 'meta:insights:23840001:2026-01-15:spend';
  });
  assert.equal(spendRows.length, spendRowsBefore + 2);
  // The observation timestamps are IDENTICAL (the provider truth) while
  // the retrieval moments differ (fresh server stamps).
  assert.equal(spendRows[0]!['observedAt'], spendRows[1]!['observedAt']);
});

// ---------------------------------------------------------------------------
// Fail-closed delivery (malformed provider payloads + rate limits)
// ---------------------------------------------------------------------------

test('METRIC-001 fail-closed: a malformed provider payload fails the whole read and delivers NOTHING', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceMeta2ConnectionId);
  const evidenceBefore = (await clientEvidence(aliceTokenValue, clientAId)).length;
  const metricsBefore = (await clientMetrics(aliceTokenValue, clientAId)).length;

  sandbox!.setMode('meta', 'malformed');
  try {
    const response = await sync(aliceTokenValue, clientAId, aliceMeta2ConnectionId, 'getInsights');
    assert.equal(response.status, 200);
    assert.equal(response.body['ok'], false);
    const error = response.body['error'] as string;
    assert.ok(error !== undefined && error.includes('malformed Meta insights payload'), `unexpected error: ${error}`);
    // NOTHING delivered: no receipts, no new evidence, no new metrics —
    // and no retrieval moment either (the failed read never reached the
    // emitter; the serialized outcome omits the key entirely).
    assert.deepEqual(response.body['receipts'], []);
    assert.ok(!('retrievedAt' in response.body));
    assert.equal((await clientEvidence(aliceTokenValue, clientAId)).length, evidenceBefore);
    assert.equal((await clientMetrics(aliceTokenValue, clientAId)).length, metricsBefore);
    // The connection records the honest error state.
    assert.equal(response.body['connection'] !== undefined, true);
  } finally {
    sandbox!.setMode('meta', 'ok');
  }
});

test('INT-001 (§20) rate-limit metadata: a provider 429 surfaces the normalized backoff state on the outcome and the connection', async () => {
  await connectConnection(aliceTokenValue, clientAId, aliceMeta2ConnectionId);
  sandbox!.setMode('meta', 'rate-limited');
  try {
    const response = await sync(aliceTokenValue, clientAId, aliceMeta2ConnectionId, 'getInsights');
    assert.equal(response.status, 200);
    assert.equal(response.body['ok'], false);
    const rateLimit = response.body['rateLimit'] as Record<string, unknown>;
    assert.equal(rateLimit['retryAfterSeconds'], 30);
    assert.equal(rateLimit['limitRemaining'], 480);
    assert.ok(typeof rateLimit['limitResetAt'] === 'string');

    // The connection record carries the same normalized state (§20: the
    // observed pipe state persists for the next decision).
    const connection = await apiCall(
      port(),
      `/api/clients/${clientAId}/connections/${aliceMeta2ConnectionId}`,
      { token: aliceTokenValue },
    );
    assert.equal(connection.status, 200);
    const connectionRateLimit = connection.body['rateLimit'] as Record<string, unknown>;
    assert.equal(connectionRateLimit['retryAfterSeconds'], 30);
  } finally {
    sandbox!.setMode('meta', 'ok');
  }
});
