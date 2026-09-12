/**
 * MKT-023 integration tests — the provider integration boundary (INT-001)
 * on the real stack (embedded PostgreSQL 18 + real API process — no mocks
 * of platform services; the provider side is exercised through STUB
 * adapters implementing the generic IntegrationAdapter port, the
 * ai-routing MKT-018 precedent: no live network, no SDKs).
 *
 * Acceptance mapping (work-items.md MKT-023 acceptance: "provider
 * isolation / static checks" — the behavioral half; the unit file carries
 * the pure guard surfaces, the architecture file the static isolation
 * proofs):
 *   - the ADAPTER MECHANISM end-to-end: stub adapters arrive as DATA,
 *     register through the validated registry, connections are born
 *     'registered' with the provider label DERIVED from the adapter
 *     descriptor (never caller-supplied), and the connect probe / read /
 *     webhook flows call ONLY the port methods;
 *   - FAIL-CLOSED POLICY (POL-001): a 'deny' AND an 'unknown' decision on
 *     the network dimension block the connect probe BEFORE any credential
 *     material resolution or adapter call; network and secrets gates both
 *     precede material resolution on execution reads;
 *   - CROSS-TENANT UNIFORM 404: a foreign connection id under another
 *     Client's path, an unknown connection id and a cross-agency ownership
 *     mismatch are INDISTINGUISHABLE (no existence or traversal oracle) at
 *     the route level and at the module level;
 *   - AUTHORITY-FIELD SMUGGLING: server-derived identity/lifecycle/
 *     provenance fields on the registration/execution/webhook DTOs are
 *     422s (implementation-contract §3);
 *   - §21 CREDENTIAL VALUES NEVER ENTER INTEGRATION RECORDS:
 *     material-shaped keys in providerConfig (any nesting depth) are
 *     422s at the route, InvalidRequestError at the module, and the DB
 *     CHECK rejects them on the connection config and the event payload;
 *     the credential resolves as MATERIAL only in-process after a policy
 *     allow (the authorized-execution scope), never into durable state;
 *   - WEBHOOK INGESTION: a verified delivery appends ONE ledger row and
 *     exactly one derived 'source_fact' evidence observation with PINNED
 *     class/quality/provenance; an unverified delivery records NOTHING;
 *   - DB BACKSTOPS (migration 029): duplicate-registration fence,
 *     cross-tenant credential fence, identity immutability, the frozen
 *     transition table, the append-only event ledger and the
 *     connection-consistency fences — all enforced by the database even
 *     against direct SQL.
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
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { createIntegrationsModule } from '../../src/modules/integrations/public.ts';
import type {
  IntegrationsModuleApi,
  IntegrationAdapter,
  IntegrationsClientOwnershipSnapshot,
  IntegrationEvidenceAppendInput,
  IntegrationEvidenceProvenance,
  IntegrationProvenance,
} from '../../src/modules/integrations/public.ts';
import type { PoliciesModuleApi } from '../../src/modules/policies/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';
import {
  ConflictError,
  InvalidRequestError,
  NotFoundError,
  PolicyDeniedError,
} from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const ALICE_SECRET_HANDLE = 'integ-alice-api-key';
const ALICE_SECRET_MATERIAL = 'MATERIAL-alice-do-not-leak-4f3e2d1c';
const BOB_SECRET_HANDLE = 'integ-bob-api-key';
const BOB_SECRET_MATERIAL = 'MATERIAL-bob-do-not-leak-9a8b7c6d';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

/** The pipeline nests typed application errors under an `error` key. */
function errorBody(response: { readonly body: Record<string, unknown> }): Record<string, unknown> {
  const nested = response.body['error'];
  return (nested !== null && typeof nested === 'object' ? nested : response.body) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The STUB ADAPTERS (the generic port — provider-neutral test doubles)
// ---------------------------------------------------------------------------

interface AdapterCalls {
  probe: number;
  read: number;
  mutate: number;
  verify: number;
}

function stubAdapter(
  adapterKey: string,
  calls: AdapterCalls,
  overrides: Partial<IntegrationAdapter> = {},
): IntegrationAdapter {
  return {
    descriptor: {
      adapterKey,
      providerLabel: `Stub ${adapterKey}`,
      description: `Stub ${adapterKey} provider for integration tests.`,
    },
    capabilities: [
      {
        capabilityKey: 'reports-read',
        kind: 'read',
        operations: ['listCampaigns', 'getCampaignReport'],
        description: 'Read campaign reports.',
      },
      {
        capabilityKey: 'campaigns-mutate',
        kind: 'mutation',
        operations: ['upsertCampaign'],
        description: 'Upsert campaigns.',
      },
      {
        capabilityKey: 'events-webhook',
        kind: 'webhook',
        operations: ['report.completed'],
        description: 'Receive report completion events.',
      },
    ],
    probeConnection: async () => {
      calls.probe += 1;
      return { reachable: true, healthy: true, message: null, rateLimit: null };
    },
    read: async () => {
      calls.read += 1;
      return {
        ok: true,
        records: [
          {
            providerRecordId: 'provider-row-1',
            data: { spend: 12.5, currency: 'USD' },
            sourceTimestamp: '2026-01-15T10:30:00.000Z',
            etag: 'etag-1',
            sourceVersion: 'v9',
          },
        ],
        error: null,
        rateLimit: null,
      };
    },
    mutate: async () => {
      calls.mutate += 1;
      return { ok: true, providerRecordId: 'provider-row-2', data: { id: 'provider-row-2' }, error: null, rateLimit: null };
    },
    verifyWebhook: async () => {
      calls.verify += 1;
      return { verified: true, reason: null, normalizedEventType: 'report.completed' };
    },
    ...overrides,
  };
}

const adapterCalls: AdapterCalls = { probe: 0, read: 0, mutate: 0, verify: 0 };

/** The webhookless adapter: declares NO webhook capability. */
function webhooklessAdapter(adapterKey: string): IntegrationAdapter {
  return {
    ...stubAdapter(adapterKey, adapterCalls),
    capabilities: [
      {
        capabilityKey: 'reports-read',
        kind: 'read',
        operations: ['listCampaigns'],
        description: 'Read campaign reports.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Scriptable module-dependency fakes (the ai-routing in-process pattern)
// ---------------------------------------------------------------------------

/** The scriptable policy outcome: (dimension, operation) → allow|deny|unknown. */
let policyOutcome: (dimension: string, operation: string) => 'allow' | 'deny' | 'unknown' = () => 'allow';
const policyCalls: { dimension: string; operation: string; agencyId: string }[] = [];

/** Material-resolution observation: the §21 in-process-only invariant. */
const materialResolutions: { credentialId: string; agencyId: string; clientId: string | null }[] = [];

/** Evidence-sink observations (the pinned derived observation). */
const evidenceAppends: { input: IntegrationEvidenceAppendInput; provenance: IntegrationEvidenceProvenance }[] = [];

/** Ownership overrides for the uniform-404 / foreign-chain tests. */
let ownershipOverride: ((clientId: string) => IntegrationsClientOwnershipSnapshot | null) | null = null;

let integrations: IntegrationsModuleApi | null = null;
let credentialRecordA: Record<string, unknown> | null = null;
let credentialRecordB: Record<string, unknown> | null = null;

// Real identities created through the API in before().
let aliceTokenValue = '';
let aliceAgencyId = '';
let clientAId = '';
let bobTokenValue = '';
let bobAgencyId = '';
let clientBId = '';
let credentialAId = '';
let credentialBId = '';
let evidenceFixtureId = '';

function theModule(): IntegrationsModuleApi {
  if (integrations === null) throw new Error('module not constructed');
  return integrations;
}

const provenance = (): IntegrationProvenance => ({
  actor: 'user:test-actor',
  recordedVia: 'api',
  correlationId: 'corr-integrations-test',
  causationId: null,
});

// ---------------------------------------------------------------------------
// Fixtures (real users/agencies/clients/credentials through the API)
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

async function makePrincipal(email: string): Promise<{ userId: string; token: string; agencyId: string }> {
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
    body: { name: `Agency ${email.split('@')[0]}`, ownerUserId: userId },
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
): Promise<Record<string, unknown>> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/credentials`, {
    token,
    body: { kind: 'integration_api_key', label, secretHandle },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  // The API serialization omits a null clientId; the module contract
  // expects the full record shape (clientId: null for agency-scoped).
  const record = created.body as Record<string, unknown>;
  return { ...record, clientId: record['clientId'] ?? null };
}

async function makeEvidenceFixture(clientId: string, token: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'source_fact',
      sourceSystem: 'fixture-provider',
      sourceRef: 'fixture/ref-1',
      observedAt: '2026-01-15T10:30:00.000Z',
      content: { metric: 'spend', value: 1.25, currency: 'USD' },
      contentRef: 'mos-objects://evidence/integrations-fixture/spend.json',
      quality: 'D',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['evidenceId'] as string;
}

before(async () => {
  stack = await bootStack('integrations');
  // Provision the two agency secrets out-of-band (deployment-style).
  fs.writeFileSync(path.join(stack.env.secretsDir, `${ALICE_SECRET_HANDLE}.secret`), ALICE_SECRET_MATERIAL, { mode: 0o600 });
  fs.writeFileSync(path.join(stack.env.secretsDir, `${BOB_SECRET_HANDLE}.secret`), BOB_SECRET_MATERIAL, { mode: 0o600 });
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  const alice = await makePrincipal('alice@integrations.test');
  aliceTokenValue = alice.token;
  aliceAgencyId = alice.agencyId;
  clientAId = await makeClient(aliceAgencyId, alice.token, 'Client Alpha');

  const bob = await makePrincipal('bob@integrations.test');
  bobTokenValue = bob.token;
  bobAgencyId = bob.agencyId;
  clientBId = await makeClient(bobAgencyId, bob.token, 'Client Beta');

  credentialRecordA = await makeCredential(aliceAgencyId, alice.token, 'Provider Alpha', ALICE_SECRET_HANDLE);
  credentialAId = credentialRecordA['credentialId'] as string;
  credentialRecordB = await makeCredential(bobAgencyId, bob.token, 'Provider Beta', BOB_SECRET_HANDLE);
  credentialBId = credentialRecordB['credentialId'] as string;

  evidenceFixtureId = await makeEvidenceFixture(clientAId, aliceTokenValue);

  // The in-process module instance (the ai-routing pattern): SAME database
  // as the API process, STUB adapters as injected data, scriptable fakes
  // for the cross-module contracts so the fail-closed ORDER is assertable.
  db = new PgDb(stack.env.databaseUrl, 2);
  integrations = createIntegrationsModule({
    db,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    policies: {
      evaluateAction: async (
        input: Parameters<PoliciesModuleApi['evaluateAction']>[0],
        decisionProvenance: Parameters<PoliciesModuleApi['evaluateAction']>[1],
      ) => {
        policyCalls.push({
          dimension: input.action.dimension,
          operation: input.action.operation,
          agencyId: input.scope.agencyId,
        });
        const outcome = policyOutcome(input.action.dimension, input.action.operation);
        return {
          decisionId: `decision-${policyCalls.length}`,
          dimension: input.action.dimension,
          agencyId: input.scope.agencyId,
          clientId: input.scope.clientId,
          outcome,
          reasonCode: outcome === 'allow' ? 'rule-allowed' : outcome === 'deny' ? 'rule-denied' : 'no-matching-rule',
          reasons: [],
          action: input.action,
          matchedPolicyVersions: [],
          provenance: decisionProvenance,
        };
      },
    } as unknown as PoliciesModuleApi,
    credentials: {
      getCredentialReference: async (credentialId: string) => {
        if (credentialId === credentialAId) return credentialRecordA;
        if (credentialId === credentialBId) return credentialRecordB;
        return null;
      },
      resolveCredentialMaterial: async (input: { credentialId: string; scope: { agencyId: string; clientId: string | null } }) => {
        materialResolutions.push({
          credentialId: input.credentialId,
          agencyId: input.scope.agencyId,
          clientId: input.scope.clientId,
        });
        return { credentialId: input.credentialId, material: new TextEncoder().encode('stub-material-in-process-only') };
      },
    } as unknown as CredentialsModuleApi,
    clientOwnership: {
      resolveClientOwnership: async (clientId: string) => {
        if (ownershipOverride !== null) return ownershipOverride(clientId);
        if (clientId === clientAId) {
          return {
            scope: { kind: 'client', agencyId: aliceAgencyId, clientId: clientAId },
            client: { clientId: clientAId, agencyId: aliceAgencyId, status: 'active' },
          };
        }
        if (clientId === clientBId) {
          return {
            scope: { kind: 'client', agencyId: bobAgencyId, clientId: clientBId },
            client: { clientId: clientBId, agencyId: bobAgencyId, status: 'active' },
          };
        }
        return null;
      },
    },
    evidenceSink: {
      appendEvidence: async (input: IntegrationEvidenceAppendInput, evidenceProvenance: IntegrationEvidenceProvenance) => {
        evidenceAppends.push({ input, provenance: evidenceProvenance });
        return { evidenceId: evidenceFixtureId };
      },
    },
    // NOTE: every successful registration consumes a UNIQUE (client,
    // adapter, credential) triple (the DB fence) — the pad adapters give
    // each test its own key.
    adapters: [
      stubAdapter('stub-analytics', adapterCalls),
      stubAdapter('stub-crm', adapterCalls),
      stubAdapter('stub-commerce', adapterCalls),
      stubAdapter('stub-cms', adapterCalls),
      stubAdapter('stub-webhooks', adapterCalls),
      webhooklessAdapter('stub-nohooks'),
      ...Array.from({ length: 17 }, (_, index) =>
        stubAdapter(`stub-pad-${String(index + 1).padStart(2, '0')}`, adapterCalls),
      ),
    ],
  });
});

after(async () => {
  if (db !== null) {
    await db.close();
    db = null;
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

function resetFakes(): void {
  policyOutcome = () => 'allow';
  policyCalls.length = 0;
  materialResolutions.length = 0;
  evidenceAppends.length = 0;
  ownershipOverride = null;
  adapterCalls.probe = 0;
  adapterCalls.read = 0;
  adapterCalls.mutate = 0;
  adapterCalls.verify = 0;
}

async function register(adapterKey: string): Promise<string> {
  const record = await theModule().registerConnection(
    {
      clientId: clientAId,
      adapterKey,
      credentialReferenceId: credentialAId,
      providerConfig: { region: 'eu-west-1' },
    },
    provenance(),
  );
  return record.connectionId;
}

async function connectAndAwait(connectionId: string): Promise<void> {
  const current = await theModule().getConnection(connectionId);
  assert.notEqual(current, null);
  await theModule().connectConnection({ connectionId, expectedVersion: current!.version }, provenance());
  // Observe ONLY the operation under test from here on — the connect
  // probe's own gate calls (policy evaluation, material resolution,
  // adapter probe) are not part of the per-operation assertions.
  policyCalls.length = 0;
  materialResolutions.length = 0;
  adapterCalls.probe = 0;
  adapterCalls.read = 0;
  adapterCalls.mutate = 0;
  adapterCalls.verify = 0;
}

// ---------------------------------------------------------------------------
// Route-level surface (the real HTTP stack; the deployment registry is
// EMPTY in MKT-023 — the composition root registers no first-party
// adapters until MKT-024)
// ---------------------------------------------------------------------------

test('INT-001 ROUTE: the adapter registry surface is honest data — empty in the MKT-023 deployment', async () => {
  const response = await apiCall(port(), '/api/integrations/adapters', {
    token: aliceTokenValue,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body['adapters'], []);
});

test('INT-001 ROUTE: registering against an unknown adapter is a uniform 404 (registry is data)', async () => {
  const response = await apiCall(port(), `/api/clients/${clientAId}/connections`, {
    token: aliceTokenValue,
    body: {
      adapterKey: 'not-registered-anywhere',
      credentialReferenceId: credentialAId,
      providerConfig: { region: 'eu' },
    },
  });
  assert.equal(response.status, 404);
  assert.equal(errorBody(response)['code'], 'NOT_FOUND');
});

test('INT-001 ROUTE (§3): authority-field smuggling on the registration DTO is a 422', async () => {
  const smuggleAttempts: Record<string, unknown>[] = [
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, status: 'connected' },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, connectionId: randomUUID() },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, version: 42 },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, agencyId: bobAgencyId },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, provenance: { actor: 'user:evil' } },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: {}, health: 'healthy' },
  ];
  for (const body of smuggleAttempts) {
    const response = await apiCall(port(), `/api/clients/${clientAId}/connections`, {
      token: aliceTokenValue,
      body,
    });
    assert.equal(response.status, 422, `expected 422 for smuggled ${JSON.stringify(body)}`);
    assert.equal(errorBody(response)['code'], 'INVALID_REQUEST');
  }
});

test('INT-001 ROUTE (§21): credential VALUES never enter integration records — material-shaped keys are 422s at any depth', async () => {
  const leakAttempts: Record<string, unknown>[] = [
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: { token: 'leak' } },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: { apiKey: 'leak' } },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: { nested: { secret: 'leak' } } },
    { adapterKey: 'stub-analytics', credentialReferenceId: credentialAId, providerConfig: { deep: [{ password: 'leak' }] } },
  ];
  for (const body of leakAttempts) {
    const response = await apiCall(port(), `/api/clients/${clientAId}/connections`, {
      token: aliceTokenValue,
      body,
    });
    assert.equal(response.status, 422, `expected 422 for material-shaped ${JSON.stringify(body)}`);
  }
});

test('INT-001 ROUTE (tenant boundary): a foreign principal registering on another Client is a uniform 404', async () => {
  const response = await apiCall(port(), `/api/clients/${clientAId}/connections`, {
    token: bobTokenValue,
    body: {
      adapterKey: 'stub-analytics',
      credentialReferenceId: credentialAId,
      providerConfig: { region: 'eu' },
    },
  });
  // Bob is not a member of the OWNING agency — indistinguishable from an
  // unknown Client (the hard boundary; no cross-tenant oracle).
  assert.equal(response.status, 404);
  assert.equal(errorBody(response)['code'], 'NOT_FOUND');
});

test('INT-001 ROUTE (tenant boundary): a foreign connection id under another Client path is the SAME uniform 404 as an unknown id', async () => {
  resetFakes();
  const connectionId = await register('stub-analytics');

  // The owning member reads it fine.
  const owner = await apiCall(port(), `/api/clients/${clientAId}/connections/${connectionId}`, {
    token: aliceTokenValue,
  });
  assert.equal(owner.status, 200);
  assert.equal((owner.body as Record<string, unknown>)['status'], 'registered');

  // The foreign principal under THEIR client path: uniform 404.
  const foreign = await apiCall(port(), `/api/clients/${clientBId}/connections/${connectionId}`, {
    token: bobTokenValue,
  });
  assert.equal(foreign.status, 404);

  // An unknown id under the owning path: SAME shape — the only difference
  // is the echoed identifier (no existence oracle).
  const unknownId = randomUUID();
  const unknown = await apiCall(port(), `/api/clients/${clientAId}/connections/${unknownId}`, {
    token: aliceTokenValue,
  });
  assert.equal(unknown.status, 404);
  const foreignBody = errorBody(foreign);
  const unknownBody = errorBody(unknown);
  assert.equal(foreignBody['code'], unknownBody['code']);
  assert.equal(
    String(foreignBody['message']).replace(connectionId, '<id>'),
    String(unknownBody['message']).replace(unknownId, '<id>'),
    'foreign and unknown identifiers must be indistinguishable',
  );
});

test('INT-001 ROUTE: the Client connection listing surface works (and stays empty before any registration)', async () => {
  const response = await apiCall(port(), `/api/clients/${clientBId}/connections`, {
    token: bobTokenValue,
  });
  assert.equal(response.status, 200);
  assert.deepEqual((response.body as Record<string, unknown>)['connections'], []);
});

// ---------------------------------------------------------------------------
// Module-level behavioral surface (stub adapters through the generic port)
// ---------------------------------------------------------------------------

test('INT-001 MODULE: registration derives the provider label and ownership from the ADAPTER and the CLIENT chain', async () => {
  resetFakes();
  const record = await theModule().registerConnection(
    {
      clientId: clientAId,
      adapterKey: 'stub-crm',
      credentialReferenceId: credentialAId,
      providerConfig: { region: 'eu-west-1' },
    },
    provenance(),
  );
  assert.equal(record.status, 'registered');
  assert.equal(record.health, 'unknown');
  assert.equal(record.version, 1);
  assert.equal(record.providerLabel, 'Stub stub-crm', 'the label comes from the adapter descriptor, never the caller');
  assert.equal(record.agencyId, aliceAgencyId, 'the agency comes from the resolved CLIENT chain');
  assert.equal(record.credentialReferenceId, credentialAId);
  assert.deepEqual(record.providerConfig, { region: 'eu-west-1' });
});

test('INT-001 MODULE: an unknown Client is a uniform NotFoundError; a disabled Client blocks new writes', async () => {
  resetFakes();
  await assert.rejects(
    theModule().registerConnection(
      { clientId: randomUUID(), adapterKey: 'stub-crm', credentialReferenceId: credentialAId, providerConfig: {} },
      provenance(),
    ),
    (error: unknown) => error instanceof NotFoundError,
  );

  ownershipOverride = () => ({
    scope: { kind: 'client', agencyId: aliceAgencyId, clientId: clientAId },
    client: { clientId: clientAId, agencyId: aliceAgencyId, status: 'disabled' },
  });
  await assert.rejects(
    theModule().registerConnection(
      { clientId: clientAId, adapterKey: 'stub-crm', credentialReferenceId: credentialAId, providerConfig: {} },
      provenance(),
    ),
    (error: unknown) => error instanceof ConflictError,
  );
});

test('INT-001 MODULE (§21): a foreign credential reference is a uniform NotFoundError — never an existence oracle', async () => {
  resetFakes();
  await assert.rejects(
    theModule().registerConnection(
      { clientId: clientAId, adapterKey: 'stub-crm', credentialReferenceId: credentialBId, providerConfig: {} },
      provenance(),
    ),
    (error: unknown) =>
      error instanceof NotFoundError && String(error.message).includes('credential reference'),
  );
});

test('INT-001 MODULE (§21): material-shaped keys in providerConfig are rejected at the module boundary too', async () => {
  resetFakes();
  await assert.rejects(
    theModule().registerConnection(
      { clientId: clientAId, adapterKey: 'stub-crm', credentialReferenceId: credentialAId, providerConfig: { token: 'leak' } as Record<string, string> },
      provenance(),
    ),
    (error: unknown) => error instanceof InvalidRequestError,
  );
});

test('INT-AC fail-closed: a network-policy DENY blocks the connect probe BEFORE any credential resolution or adapter call', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-02');
  policyOutcome = () => 'deny';

  await assert.rejects(
    theModule().connectConnection({ connectionId, expectedVersion: 1 }, provenance()),
    (error: unknown) => error instanceof PolicyDeniedError,
  );
  assert.equal(adapterCalls.probe, 0, 'the adapter probe must NOT run on a denied action');
  assert.equal(materialResolutions.length, 0, 'credential material must NOT be resolved on a denied action');
  assert.deepEqual(policyCalls.map((call) => [call.dimension, call.operation]), [
    ['network', 'integration.connect'],
  ]);

  // Fail-closed also means the durable state is untouched: still 'registered'.
  const after = await theModule().getConnection(connectionId);
  assert.equal(after?.status, 'registered');
});

test('INT-AC fail-closed: an UNKNOWN policy decision denies exactly like an explicit deny (POL-001)', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-03');
  policyOutcome = () => 'unknown';

  await assert.rejects(
    theModule().connectConnection({ connectionId, expectedVersion: 1 }, provenance()),
    (error: unknown) => error instanceof PolicyDeniedError,
  );
  assert.equal(adapterCalls.probe, 0);
  assert.equal(materialResolutions.length, 0);
});

test('INT-001 MODULE: an ALLOWED connect resolves material in-process, probes the port once and lands connected/healthy', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-04');
  const record = await theModule().connectConnection({ connectionId, expectedVersion: 1 }, provenance());

  assert.equal(record.status, 'connected');
  assert.equal(record.health, 'healthy');
  assert.equal(record.version, 2, 'the transition CAS-bumps the version');
  assert.equal(adapterCalls.probe, 1, 'exactly one port probe');
  assert.equal(materialResolutions.length, 1);
  assert.deepEqual(materialResolutions[0], {
    credentialId: credentialAId,
    agencyId: aliceAgencyId,
    clientId: clientAId,
  }, 'material resolves ONLY in the authorized-execution scope of the owning chain');
  assert.deepEqual(policyCalls.map((call) => [call.dimension, call.operation]), [
    ['network', 'integration.connect'],
  ]);
});

test('INT-001 MODULE: an allowed executeRead runs the FULL gate chain and returns the normalized outcome', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-05');
  await connectAndAwait(connectionId);

  const outcome = await theModule().executeRead(
    { connectionId, operation: 'listCampaigns', parameters: { pageSize: 10 } },
    provenance(),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.operation, 'listCampaigns');
  assert.equal(outcome.records.length, 1);
  assert.equal(outcome.records[0]!.providerRecordId, 'provider-row-1');
  assert.ok(outcome.policyDecisionId.startsWith('decision-'), 'the network decision is recorded on the outcome');
  assert.equal(outcome.connection.status, 'connected');
  assert.equal(outcome.connection.health, 'healthy');
  assert.equal(adapterCalls.read, 1, 'exactly one port read');
  assert.equal(materialResolutions.length, 1);
  // The gate ORDER: network egress first, credential use second.
  assert.deepEqual(policyCalls.map((call) => [call.dimension, call.operation]), [
    ['network', 'integration.read'],
    ['secrets', 'integration.credential'],
  ]);
});

test('INT-AC fail-closed: a network DENY on executeRead blocks BEFORE material resolution and the adapter call', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-06');
  await connectAndAwait(connectionId);
  policyOutcome = (dimension) => (dimension === 'network' ? 'deny' : 'allow');

  await assert.rejects(
    theModule().executeRead({ connectionId, operation: 'listCampaigns', parameters: {} }, provenance()),
    (error: unknown) => error instanceof PolicyDeniedError,
  );
  assert.equal(adapterCalls.read, 0);
  assert.equal(materialResolutions.length, 0);
});

test('INT-AC fail-closed: a SECRETS-dimension deny blocks the read BEFORE material resolution (credential use is gated, not assumed)', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-07');
  await connectAndAwait(connectionId);
  policyOutcome = (dimension) => (dimension === 'secrets' ? 'deny' : 'allow');

  await assert.rejects(
    theModule().executeRead({ connectionId, operation: 'listCampaigns', parameters: {} }, provenance()),
    (error: unknown) => error instanceof PolicyDeniedError,
  );
  assert.equal(adapterCalls.read, 0, 'no provider traffic when the credential-use gate denies');
  assert.equal(materialResolutions.length, 0, 'the material is never even resolved');
});

test('INT-001 MODULE: capability calls require a CONNECTED pipe — a suspended connection is a Conflict, no port call', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-08');
  await connectAndAwait(connectionId);
  const suspended = await theModule().suspendConnection(
    { connectionId, reason: 'operational pause', expectedVersion: 2 },
    provenance(),
  );
  assert.equal(suspended.status, 'suspended');

  await assert.rejects(
    theModule().executeRead({ connectionId, operation: 'listCampaigns', parameters: {} }, provenance()),
    (error: unknown) => error instanceof ConflictError,
  );
  assert.equal(adapterCalls.read, 0, 'no provider traffic through a dead pipe');
  assert.equal(materialResolutions.length, 0);
});

test('INT-001 MODULE: an undeclared operation is a 422 — capability discovery is data, not a provider branch', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-09');
  await connectAndAwait(connectionId);

  await assert.rejects(
    theModule().executeRead({ connectionId, operation: 'notDeclaredAnywhere', parameters: {} }, provenance()),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  assert.equal(adapterCalls.read, 0);
});

test('INT-001 MODULE (§21): material-shaped keys in EXECUTION parameters are rejected (the exfiltration guard)', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-10');
  await connectAndAwait(connectionId);

  await assert.rejects(
    theModule().executeRead(
      { connectionId, operation: 'listCampaigns', parameters: { filter: { secret: 'leak' } } },
      provenance(),
    ),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  assert.equal(adapterCalls.read, 0, 'the outbound parameters never reach the provider');
  assert.equal(materialResolutions.length, 0);
});

test('INT-001 MODULE: a VERIFIED webhook appends one ledger row and ONE pinned source_fact evidence observation', async () => {
  resetFakes();
  const connectionId = await register('stub-webhooks');
  await connectAndAwait(connectionId);

  const event = await theModule().ingestWebhookEvent(
    {
      connectionId,
      eventType: 'report.completed',
      payload: { reportId: 'rep-9', status: 'done' },
      headers: { 'x-provider-signature': 'sig-abc' },
    },
    provenance(),
  );

  assert.equal(event.connectionId, connectionId);
  assert.equal(event.clientId, clientAId);
  assert.equal(event.adapterKey, 'stub-webhooks');
  assert.equal(event.eventType, 'report.completed', 'the adapter-normalized event type wins');
  assert.equal(event.evidenceRef, evidenceFixtureId);
  assert.deepEqual(event.payload, { reportId: 'rep-9', status: 'done' });
  assert.equal(adapterCalls.verify, 1);

  // The derived evidence observation: PINNED class/quality/provenance.
  assert.equal(evidenceAppends.length, 1, 'exactly one derived evidence append');
  const sinkInput = evidenceAppends[0]!.input;
  assert.equal(sinkInput.clientId, clientAId);
  assert.equal(sinkInput.class, 'source_fact');
  assert.equal(sinkInput.quality, 'C');
  assert.equal(sinkInput.source.system, 'integration:stub-webhooks');
  assert.equal(sinkInput.source.ref, event.eventId, 'the event identity is the source reference');
  assert.equal(evidenceAppends[0]!.provenance.recordedVia, 'integration:stub-webhooks', 'server-derived provenance');
  assert.equal(evidenceAppends[0]!.provenance.actor, provenance().actor);

  // The secrets-dimension gate ran before material resolution.
  assert.deepEqual(policyCalls.map((call) => [call.dimension, call.operation]), [
    ['secrets', 'integration.webhook'],
  ]);
  assert.equal(materialResolutions.length, 1);

  // The ledger round-trips.
  const readBack = await theModule().getIngestedEvent(event.eventId);
  assert.notEqual(readBack, null);
  assert.equal(readBack!.eventId, event.eventId);
  const listed = await theModule().listIngestedEventsForClient(clientAId);
  assert.ok(listed.some((entry) => entry.eventId === event.eventId));
});

test('INT-AC fail-closed: an UNVERIFIED webhook records NOTHING — no ledger row, no evidence', async () => {
  resetFakes();
  // An adapter whose verification always fails.
  const connectionId = await register('stub-pad-11');
  await connectAndAwait(connectionId);
  // Re-register is fenced; use the module-level verification failure by
  // driving a delivery with a bad signature through a rejecting adapter:
  // construct a second module instance sharing the same fakes but with an
  // always-unverified adapter.
  const rejecting = createIntegrationsModule({
    db: db!,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    policies: {
      evaluateAction: async (
        input: Parameters<PoliciesModuleApi['evaluateAction']>[0],
        decisionProvenance: Parameters<PoliciesModuleApi['evaluateAction']>[1],
      ) => ({
        decisionId: `decision-x`,
        dimension: input.action.dimension,
        agencyId: input.scope.agencyId,
        clientId: input.scope.clientId,
        outcome: 'allow' as const,
        reasonCode: 'rule-allowed' as const,
        reasons: [],
        action: input.action,
        matchedPolicyVersions: [],
        provenance: decisionProvenance,
      }),
    } as unknown as PoliciesModuleApi,
    credentials: {
      getCredentialReference: async () => credentialRecordA,
      resolveCredentialMaterial: async (input: { credentialId: string; scope: { agencyId: string; clientId: string | null } }) => ({
        credentialId: input.credentialId,
        material: new TextEncoder().encode('stub-material-in-process-only'),
      }),
    } as unknown as CredentialsModuleApi,
    clientOwnership: {
      resolveClientOwnership: async (clientId: string) =>
        clientId === clientAId
          ? { scope: { kind: 'client', agencyId: aliceAgencyId, clientId: clientAId }, client: { clientId: clientAId, agencyId: aliceAgencyId, status: 'active' } }
          : null,
    },
    evidenceSink: {
      appendEvidence: async (input, evidenceProvenance) => {
        evidenceAppends.push({ input, provenance: evidenceProvenance });
        return { evidenceId: evidenceFixtureId };
      },
    },
    adapters: [
      {
        // SAME adapter key as the connection row — but a verification that
        // always fails (the unverified-delivery posture).
        ...stubAdapter('stub-pad-11', adapterCalls),
        verifyWebhook: async () => ({ verified: false, reason: 'signature mismatch', normalizedEventType: null }),
      },
    ],
  });

  const before = (await theModule().listIngestedEventsForClient(clientAId)).length;
  await assert.rejects(
    rejecting.ingestWebhookEvent(
      {
        connectionId,
        eventType: 'report.completed',
        payload: { reportId: 'rep-bad' },
        headers: { 'x-provider-signature': 'sig-BAD' },
      },
      provenance(),
    ),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  const after = await theModule().listIngestedEventsForClient(clientAId);
  assert.equal(after.length, before, 'no ledger row was appended');
  assert.equal(evidenceAppends.length, 0, 'no evidence was appended for an unverified delivery');
});

test('INT-001 MODULE: webhook ingestion on an adapter with NO webhook capability is a 422', async () => {
  resetFakes();
  const connectionId = await register('stub-nohooks');
  await connectAndAwait(connectionId);

  await assert.rejects(
    theModule().ingestWebhookEvent(
      { connectionId, eventType: 'report.completed', payload: { x: 1 }, headers: {} },
      provenance(),
    ),
    (error: unknown) => error instanceof InvalidRequestError,
  );
  assert.equal(adapterCalls.verify, 0);
  assert.equal(evidenceAppends.length, 0);
});

test('INT-001 MODULE (no oracle): unknown, orphaned and cross-agency ownership all resolve to the SAME null', async () => {
  resetFakes();
  assert.equal(await theModule().resolveConnectionOwnership(randomUUID()), null);

  const connectionId = await register('stub-pad-12');
  // A Client chain that resolves to ANOTHER agency than the connection row
  // (the smuggled-mismatch posture): null — indistinguishable from unknown.
  ownershipOverride = (clientId: string) =>
    clientId === clientAId
      ? { scope: { kind: 'client', agencyId: bobAgencyId, clientId: clientAId }, client: { clientId: clientAId, agencyId: bobAgencyId, status: 'active' } }
      : null;
  assert.equal(await theModule().resolveConnectionOwnership(connectionId), null);
  // And the follow-on operation surfaces the uniform 404.
  await assert.rejects(
    theModule().connectConnection({ connectionId, expectedVersion: 1 }, provenance()),
    (error: unknown) => error instanceof NotFoundError,
  );
});

// ---------------------------------------------------------------------------
// DB backstops (migration 029 — the storage-layer fences, proven against
// direct SQL with every application check bypassed)
// ---------------------------------------------------------------------------

async function sql(query: string, params: readonly (string | number | null)[] = []) {
  if (db === null) throw new Error('db not connected');
  return db.query<Record<string, unknown>>(query, params);
}

test('DB fence (029): duplicate (client, adapter, credential) registration is rejected by the unique fence', async () => {
  // The stub-analytics row was registered by the route-level test — the
  // direct SQL insert of the SAME triple must be fenced.
  await assert.rejects(
    sql(
      `INSERT INTO integration_connections (connection_id, client_id, agency_id, adapter_key,
                                   provider_label, status, health, credential_reference_id,
                                   provider_config, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'stub-analytics', 'Dup', 'registered', 'unknown', $4,
               '{}'::jsonb, 1, now(), now())`,
      [randomUUID(), clientAId, aliceAgencyId, credentialAId],
    ),
    (error: unknown) => String(error).includes('duplicate') || String(error).includes('unique'),
  );
});

test('DB fence (029, §21): a cross-agency credential reference cannot be bound to another agency\'s connection', async () => {
  await assert.rejects(
    sql(
      `INSERT INTO integration_connections (connection_id, client_id, agency_id, adapter_key,
                                   provider_label, status, health, credential_reference_id,
                                   provider_config, version, created_at, updated_at)
       VALUES ($1, $2, $3, 'stub-crm', 'Evil', 'registered', 'unknown', $4,
               '{}'::jsonb, 1, now(), now())`,
      [randomUUID(), clientAId, aliceAgencyId, credentialBId],
    ),
    (error: unknown) => String(error).includes('cross-tenant credential use is rejected'),
  );
});

test('DB fence (029): connection identity/ownership is immutable under direct SQL', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-13');
  await assert.rejects(
    sql(`UPDATE integration_connections SET client_id = $2 WHERE connection_id = $1`, [connectionId, clientBId]),
    (error: unknown) =>
      String(error).includes('cannot be crossed') || String(error).includes('cannot change Client ownership'),
  );
  await assert.rejects(
    sql(`UPDATE integration_connections SET adapter_key = 'stub-cms' WHERE connection_id = $1`, [connectionId]),
    (error: unknown) => String(error).includes('cannot change its adapter'),
  );
});

test('DB fence (029): the frozen connection transition table rejects illegal status rewrites', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-14');
  // Force a 'suspended' row via SQL bookkeeping (a legal transition from
  // registered), then attempt the ILLEGAL suspended -> error edge.
  await sql(`UPDATE integration_connections SET status = 'suspended' WHERE connection_id = $1`, [connectionId]);
  await assert.rejects(
    sql(`UPDATE integration_connections SET status = 'error' WHERE connection_id = $1`, [connectionId]),
    (error: unknown) => String(error).includes('illegal integration connection transition suspended -> error'),
  );
});

test('DB fence (029, §21): the event ledger CHECK rejects material-shaped payload keys', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-15');
  await assert.rejects(
    sql(
      `INSERT INTO integration_events (event_id, connection_id, client_id, adapter_key,
                                  event_type, payload, recorded_actor, recorded_via,
                                  correlation_id, received_at)
       VALUES ($1, $2, $3, 'stub-pad-15', 'report.completed', '{"token":"leak"}'::jsonb,
               'user:evil', 'api', 'corr-evil', now())`,
      [randomUUID(), connectionId, clientAId],
    ),
    (error: unknown) => String(error).includes('check constraint'),
  );
});

test('DB fence (029): the ingested-event ledger is append-only — UPDATE and DELETE are rejected', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-16');
  await connectAndAwait(connectionId);
  const event = await theModule().ingestWebhookEvent(
    {
      connectionId,
      eventType: 'report.completed',
      payload: { reportId: 'rep-ledger' },
      headers: { 'x-provider-signature': 'sig-1' },
    },
    provenance(),
  );
  await assert.rejects(
    sql(`UPDATE integration_events SET event_type = 'tampered' WHERE event_id = $1`, [event.eventId]),
    (error: unknown) => String(error).includes('append-only'),
  );
  await assert.rejects(
    sql(`DELETE FROM integration_events WHERE event_id = $1`, [event.eventId]),
    (error: unknown) => String(error).includes('append-only'),
  );
});

test('DB fence (029): a cross-tenant event row (connection of another Client) is rejected', async () => {
  resetFakes();
  const connectionId = await register('stub-pad-17');
  await assert.rejects(
    sql(
      `INSERT INTO integration_events (event_id, connection_id, client_id, adapter_key,
                                  event_type, payload, recorded_actor, recorded_via,
                                  correlation_id, received_at)
       VALUES ($1, $2, $3, 'stub-pad-17', 'report.completed', '{"ok":1}'::jsonb,
               'user:evil', 'api', 'corr-evil', now())`,
      [randomUUID(), connectionId, clientBId],
    ),
    (error: unknown) => String(error).includes('belongs to another client'),
  );
});

// ---------------------------------------------------------------------------
// Shared-state wiring: the in-process module's writes are visible through
// the real API reads (same database — the deployment topology proof)
// ---------------------------------------------------------------------------

test('INT-001 WIRING: module-level registration and ingestion are readable through the API routes', async () => {
  resetFakes();
  const connectionId = await register('stub-cms');
  await connectAndAwait(connectionId);

  const connectionRead = await apiCall(port(), `/api/clients/${clientAId}/connections/${connectionId}`, {
    token: aliceTokenValue,
  });
  assert.equal(connectionRead.status, 200);
  assert.equal((connectionRead.body as Record<string, unknown>)['status'], 'connected');
  assert.equal((connectionRead.body as Record<string, unknown>)['providerLabel'], 'Stub stub-cms');

  const event = await theModule().ingestWebhookEvent(
    {
      connectionId,
      eventType: 'report.completed',
      payload: { reportId: 'rep-api' },
      headers: { 'x-provider-signature': 'sig-2' },
    },
    provenance(),
  );

  const eventsRead = await apiCall(port(), `/api/clients/${clientAId}/integration-events`, {
    token: aliceTokenValue,
  });
  assert.equal(eventsRead.status, 200);
  const events = (eventsRead.body as Record<string, unknown>)['events'] as Record<string, unknown>[];
  assert.ok(events.some((entry) => entry['eventId'] === event.eventId));

  // The single-event read: a member of the OWNING agency reads it; the
  // foreign principal gets the uniform 404.
  const ownerRead = await apiCall(port(), `/api/integration-events/${event.eventId}`, {
    token: aliceTokenValue,
  });
  assert.equal(ownerRead.status, 200);
  const foreignRead = await apiCall(port(), `/api/integration-events/${event.eventId}`, {
    token: bobTokenValue,
  });
  assert.equal(foreignRead.status, 404);
  assert.equal(errorBody(foreignRead)['code'], 'NOT_FOUND');
});
