/**
 * MKT-037 integration tests — the Creator Operations Domain Pack on the
 * real stack (embedded PostgreSQL 18 + real API process — no mocks of
 * platform services).
 *
 * Acceptance mapping (work-item-v1.3-overrides.md MKT-037; requirements-
 * v1.3.md CREATOR-001, acceptance CREATOR-AC-01..06):
 *   - CREATOR-AC-01: the pack persists Creator Profile/Account and the
 *     Client-scoped creator operational context (fan, conversation,
 *     content, offer, messages) through the API with every DB row
 *     carrying the EXISTING agency/client scope chain — verified by
 *     direct SQL; cross-client traversal is a UNIFORM 404 (no
 *     cross-tenant oracle); direct-SQL scope-crossing and rewrites are
 *     rejected by the migration-031 triggers; NO new tenant authority
 *     exists (exactly the eight pack tables; no creator evidence/metric
 *     table — CREATOR-AC-02's mapping targets stay /evidence + /metrics);
 *   - CREATOR-AC-02: audience/engagement/monetization observations and
 *     inbound conversation records enter the COMMON Evidence and Metric
 *     contracts through the pack's mapping (verified through the /evidence
 *     and /metrics HTTP surfaces AND direct SQL — the pack owns the
 *     mapping, never a parallel store);
 *   - CREATOR-AC-03: the pack's AI task classes provision as REAL
 *     TaskProfiles of the /ai-runtime authority (read back through the
 *     /ai-runtime HTTP surface with no provider coupling fields); the
 *     manifest's ai-capability declarations are the SAME data;
 *   - CREATOR-AC-04: creator-operation human tasks ride the GENERIC Human
 *     Agent → Job model — a workflow built from the pack's published
 *     'conversation-triage' template projects a chatter-specialized Job
 *     through the EXISTING /jobs authority, the offer/accept/outcome flow
 *     runs end-to-end, and the outcome preserves actor + evidence
 *     provenance; the pack's approval records carry the approver's Human
 *     Agent specializations resolved server-side from /field-agents;
 *   - CREATOR-AC-05: the frozen manifest publishes through the
 *     /domain-packs framework and installs with its artifacts (templates,
 *     human capabilities, integration bindings) — provider platforms
 *     appear only as label data;
 *   - CREATOR-AC-06: the outbound conversation send and content publish
 *     are approval-gated side effects — fail-closed without a policy,
 *     denied without a valid approval when the configured policy demands
 *     one, and born 'sent'/'published' ONLY with the allowing policy
 *     decision id (verified by direct SQL); a foreign approval id is a
 *     uniform 404; the approvalStatus attribute is server-composed.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
    body: { password: 'creator-pack-pass-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'creator-pack-pass-123' },
  });
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
// Shared topology: agency A (owner + chatter + workspace; two clients) and
// a foreign agency B (owner; one client).
// ---------------------------------------------------------------------------

const ownerA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
const chatterUser: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let chatterAgentId = '';

// The subject chain under test (client A1).
let profileA1 = '';
let accountA1 = '';
let fanA1 = '';
let conversationA1 = '';
let contentA1 = '';
let offerA1 = '';

before(async () => {
  stack = await bootStack('creatorops');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  Object.assign(ownerA, await createUser('owner-a@creatorops.test', 'Agency A Owner'));
  Object.assign(ownerB, await createUser('owner-b@creatorops.test', 'Agency B Owner'));
  Object.assign(chatterUser, await createUser('chatter@creatorops.test', 'Chatter Agent'));
  agencyA = await makeAgency('Creator Ops Agency A', ownerA);
  agencyB = await makeAgency('Creator Ops Agency B', ownerB);
  clientA1 = await makeClient(agencyA, 'Creator Client A One');
  clientA2 = await makeClient(agencyA, 'Creator Client A Two');
  clientB = await makeClient(agencyB, 'Creator Client B One');
  workspaceA1 = await makeWorkspace(clientA1, 'Creator Workspace A1');

  // The agency owner also carries a reviewer Human Agent profile (the
  // approver provenance of the CREATOR-AC-06 approval records resolves
  // from this profile server-side).
  const reviewerProfile = await apiCall(port(), '/api/field-agents', {
    token: ownerA.token,
    body: {
      specializations: ['reviewer'],
      capabilities: [{ skill: 'chat_review', level: 'expert' }],
      availability: [{ dayOfWeek: 1, startMinute: 0, endMinute: 1440 }],
      location: { kind: 'country', value: 'ghana' },
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: false,
        continuity: 'any',
        maxConcurrentClientRelationships: 5,
      },
    },
  });
  assert.equal(reviewerProfile.status, 201, JSON.stringify(reviewerProfile.body));

  // The chatter Human Agent (the CREATOR-AC-04 generic-model worker).
  const chatterProfile = await apiCall(port(), '/api/field-agents', {
    token: chatterUser.token,
    body: {
      specializations: ['chatter'],
      capabilities: [{ skill: 'community_reply', level: 'advanced' }],
      availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
      location: { kind: 'city', value: 'accra' },
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: false,
        continuity: 'any',
        maxConcurrentClientRelationships: 5,
      },
    },
  });
  assert.equal(chatterProfile.status, 201, JSON.stringify(chatterProfile.body));
  chatterAgentId = chatterProfile.body['agentId'] as string;

  // The subject chain of client A1.
  const profile = await apiCall(port(), `/api/clients/${clientA1}/creator-profiles`, {
    token: ownerA.token,
    body: {
      displayName: 'Ava Creator',
      handle: 'ava-creator',
      niches: ['fitness', 'lifestyle'],
      bio: 'A fitness creator.',
      attributes: { region: 'emea' },
      idempotencyKey: 'profile-ava-1',
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  profileA1 = profile.body['profileId'] as string;

  const account = await apiCall(port(), `/api/creator-profiles/${profileA1}/accounts`, {
    token: ownerA.token,
    body: {
      platformLabel: 'creator-platform-1',
      accountHandle: '@ava',
      metadata: { verified: true },
      idempotencyKey: 'account-ava-1',
    },
  });
  assert.equal(account.status, 201, JSON.stringify(account.body));
  accountA1 = account.body['accountId'] as string;

  const fan = await apiCall(port(), `/api/creator-accounts/${accountA1}/fans`, {
    token: ownerA.token,
    body: {
      fanAlias: 'top-fan-1',
      tier: 'top_fan',
      tags: ['early-supporter'],
      attributes: {},
      idempotencyKey: 'fan-1',
    },
  });
  assert.equal(fan.status, 201, JSON.stringify(fan.body));
  fanA1 = fan.body['fanId'] as string;

  const conversation = await apiCall(port(), `/api/creator-accounts/${accountA1}/conversations`, {
    token: ownerA.token,
    body: {
      fanId: fanA1,
      channel: 'dm',
      topic: 'welcome',
      attributes: {},
      idempotencyKey: 'conversation-1',
    },
  });
  assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
  conversationA1 = conversation.body['conversationId'] as string;

  const content = await apiCall(port(), `/api/creator-profiles/${profileA1}/content-assets`, {
    token: ownerA.token,
    body: {
      title: 'Morning routine',
      contentKind: 'post',
      plannedPlatforms: ['creator-platform-1'],
      brief: 'A morning routine post.',
      attributes: {},
      idempotencyKey: 'content-1',
    },
  });
  assert.equal(content.status, 201, JSON.stringify(content.body));
  contentA1 = content.body['assetId'] as string;

  const offer = await apiCall(port(), `/api/creator-profiles/${profileA1}/offers`, {
    token: ownerA.token,
    body: {
      title: 'VIP bundle',
      offerKind: 'bundle',
      priceCents: 1999,
      currency: 'USD',
      terms: 'Monthly bundle.',
      attributes: {},
      idempotencyKey: 'offer-1',
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  offerA1 = offer.body['offerId'] as string;
});

after(async () => {
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// CREATOR-AC-01 — the pack-owned, Client-scoped subject surface
// ---------------------------------------------------------------------------

test('CREATOR-AC-01: subject rows carry the EXISTING agency/client scope chain (verified by direct SQL)', async () => {
  const profileRow = await pool().query<{ agency_id: string; client_id: string; handle: string }>(
    'SELECT agency_id, client_id, handle FROM creator_profiles WHERE profile_id = $1',
    [profileA1],
  );
  assert.equal(profileRow.rows.length, 1);
  assert.equal(profileRow.rows[0]!.agency_id, agencyA);
  assert.equal(profileRow.rows[0]!.client_id, clientA1);

  const accountRow = await pool().query<{ agency_id: string; client_id: string; profile_id: string; status: string }>(
    'SELECT agency_id, client_id, profile_id, status FROM creator_accounts WHERE account_id = $1',
    [accountA1],
  );
  assert.equal(accountRow.rows[0]!.agency_id, agencyA);
  assert.equal(accountRow.rows[0]!.client_id, clientA1);
  assert.equal(accountRow.rows[0]!.profile_id, profileA1);
  assert.equal(accountRow.rows[0]!.status, 'active');

  const fanRow = await pool().query<{ client_id: string; account_id: string; status: string; tier: string }>(
    'SELECT client_id, account_id, status, tier FROM creator_fans WHERE fan_id = $1',
    [fanA1],
  );
  assert.equal(fanRow.rows[0]!.client_id, clientA1);
  assert.equal(fanRow.rows[0]!.account_id, accountA1);
  assert.equal(fanRow.rows[0]!.status, 'subscribed');
  assert.equal(fanRow.rows[0]!.tier, 'top_fan');

  const conversationRow = await pool().query<{ client_id: string; account_id: string; fan_id: string; status: string }>(
    'SELECT client_id, account_id, fan_id, status FROM creator_conversations WHERE conversation_id = $1',
    [conversationA1],
  );
  assert.equal(conversationRow.rows[0]!.client_id, clientA1);
  assert.equal(conversationRow.rows[0]!.status, 'open');

  const contentRow = await pool().query<{ client_id: string; profile_id: string; status: string }>(
    'SELECT client_id, profile_id, status FROM creator_content_assets WHERE asset_id = $1',
    [contentA1],
  );
  assert.equal(contentRow.rows[0]!.client_id, clientA1);
  assert.equal(contentRow.rows[0]!.status, 'draft');

  const offerRow = await pool().query<{ client_id: string; profile_id: string; status: string }>(
    'SELECT client_id, profile_id, status FROM creator_offers WHERE offer_id = $1',
    [offerA1],
  );
  assert.equal(offerRow.rows[0]!.client_id, clientA1);
  assert.equal(offerRow.rows[0]!.status, 'draft');
});

test('CREATOR-AC-01: cross-client traversal is a UNIFORM 404 — foreign and unknown are indistinguishable', async () => {
  for (const principal of [ownerB]) {
    const read = await apiCall(port(), `/api/creator-profiles/${profileA1}`, { token: principal.token });
    assert.equal(read.status, 404, 'a foreign-agency principal gets the uniform 404');
    const write = await apiCall(port(), `/api/creator-profiles/${profileA1}/accounts`, {
      token: principal.token,
      body: {
        platformLabel: 'creator-platform-x',
        accountHandle: '@intruder',
        metadata: {},
        idempotencyKey: 'intruder-1',
      },
    });
    assert.equal(write.status, 404, 'a foreign write is the uniform 404 BEFORE dependent traversal');
  }
  const unknown = await apiCall(port(), `/api/creator-profiles/${randomUUID()}`, { token: ownerA.token });
  assert.equal(unknown.status, 404);
  const foreignListing = await apiCall(port(), `/api/clients/${clientA1}/creator-profiles`, {
    token: ownerB.token,
  });
  assert.equal(foreignListing.status, 404, 'a foreign client listing is the uniform 404');
});

test('CREATOR-AC-01: the DB scope-chain trigger rejects crossed agency/client rows even by direct SQL', async () => {
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO creator_profiles (profile_id, agency_id, client_id, display_name, handle)
         VALUES ($1, $2, $3, 'Crossed', 'crossed-handle')`,
        [randomUUID(), agencyA, clientB],
      ),
    /does not belong to agency/,
    'a profile row scoped to agency A but client B is impossible',
  );
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO creator_accounts (account_id, agency_id, client_id, profile_id, platform_label, account_handle)
         VALUES ($1, $2, $3, $4, 'creator-platform-1', '@crossed')`,
        [randomUUID(), agencyA, clientA2, profileA1],
      ),
    /same client/,
    'an account row of client A2 under a profile of client A1 is impossible',
  );
});

test('CREATOR-AC-01: pack-owned identity rows are append-only — direct SQL UPDATE/DELETE are rejected', async () => {
  await assert.rejects(
    () => pool().query('UPDATE creator_profiles SET display_name = $1 WHERE profile_id = $2', ['Rewritten', profileA1]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM creator_profiles WHERE profile_id = $1', [profileA1]),
    /append-only/,
  );
  // An existing message row (the triggers are row-level — a non-matching
  // predicate fires nothing, so use a real row).
  const inbound = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/inbound`,
    {
      token: ownerA.token,
      body: { body: 'Append-only probe.', idempotencyKey: 'append-only-probe', mapToEvidence: false },
    },
  );
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
  await assert.rejects(
    () => pool().query('DELETE FROM creator_conversation_messages WHERE message_id = $1', [inbound.body['messageId'] as string]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query('UPDATE creator_conversation_messages SET body = $1 WHERE message_id = $2', ['Rewritten', inbound.body['messageId'] as string]),
    /append-only/,
  );
});

test('CREATOR-AC-01: the frozen lifecycles transition through CAS and reject illegal edges', async () => {
  // Account: active → paused (CAS), paused → active, illegal self-loop.
  const paused = await apiCall(port(), `/api/creator-accounts/${accountA1}/status`, {
    token: ownerA.token,
    body: { to: 'paused', expectedVersion: 1 },
  });
  assert.equal(paused.status, 200, JSON.stringify(paused.body));
  assert.equal(paused.body['status'], 'paused');
  assert.equal(paused.body['version'], 2);

  const illegal = await apiCall(port(), `/api/creator-accounts/${accountA1}/status`, {
    token: ownerA.token,
    body: { to: 'paused', expectedVersion: 2 },
  });
  assert.equal(illegal.status, 409, 'paused → paused is not a frozen edge');

  const resumed = await apiCall(port(), `/api/creator-accounts/${accountA1}/status`, {
    token: ownerA.token,
    body: { to: 'active', expectedVersion: 2 },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body['status'], 'active');

  // Fan: subscribed → churned → subscribed (the reactivation edge).
  const churned = await apiCall(port(), `/api/creator-fans/${fanA1}/status`, {
    token: ownerA.token,
    body: { to: 'churned', expectedVersion: 1 },
  });
  assert.equal(churned.status, 200);
  assert.equal(churned.body['status'], 'churned');
  const reactivated = await apiCall(port(), `/api/creator-fans/${fanA1}/status`, {
    token: ownerA.token,
    body: { to: 'subscribed', expectedVersion: 2 },
  });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body['status'], 'subscribed');

  // CAS mismatch conflicts.
  const stale = await apiCall(port(), `/api/creator-fans/${fanA1}/status`, {
    token: ownerA.token,
    body: { to: 'churned', expectedVersion: 1 },
  });
  assert.equal(stale.status, 409, 'a stale CAS token conflicts');
});

test('CREATOR-AC-01: duplicate natural-key fences conflict (no silent rewrite)', async () => {
  const duplicateHandle = await apiCall(port(), `/api/clients/${clientA1}/creator-profiles`, {
    token: ownerA.token,
    body: {
      displayName: 'Ava Again',
      handle: 'ava-creator',
      niches: [],
      bio: '',
      attributes: {},
      idempotencyKey: 'profile-ava-2',
    },
  });
  assert.equal(duplicateHandle.status, 409);
});

test('CREATOR-AC-01: NO new tenant authority and NO pack-owned observation table exists', async () => {
  const tables = await pool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'creator_%'
       ORDER BY table_name`,
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    [
      'creator_accounts',
      'creator_content_assets',
      'creator_conversation_messages',
      'creator_conversations',
      'creator_fans',
      'creator_offers',
      'creator_operation_approvals',
      'creator_profiles',
    ],
    'exactly the eight pack-owned subject tables — no tenant table, no observation ledger',
  );
});

// ---------------------------------------------------------------------------
// CREATOR-AC-02 — the observation mapping into the common ledgers
// ---------------------------------------------------------------------------

test('CREATOR-AC-02: an engagement observation enters BOTH the /evidence and /metrics contracts (bound by evidenceRef)', async () => {
  const observation = await apiCall(port(), `/api/clients/${clientA1}/creator-observations`, {
    token: ownerA.token,
    body: {
      subjectKind: 'engagement',
      subjectRef: accountA1,
      eventKind: 'tip_received',
      content: { engagementKind: 'tip', amountCents: 500 },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: {
        name: 'creator.engagement.event_count',
        value: 1,
        unit: 'events',
        dimensions: { accountId: accountA1, engagementKind: 'tip' },
        aggregationMethod: null,
      },
      idempotencyKey: 'observation-1',
    },
  });
  assert.equal(observation.status, 201, JSON.stringify(observation.body));
  const evidenceId = observation.body['evidenceId'] as string;
  const observationId = observation.body['observationId'] as string;
  assert.ok(typeof evidenceId === 'string' && evidenceId.length > 0);
  assert.ok(typeof observationId === 'string' && observationId.length > 0);

  // The evidence half — through the COMMON /evidence HTTP surface.
  const evidenceList = await apiCall(port(), `/api/clients/${clientA1}/evidence`, { token: ownerA.token });
  assert.equal(evidenceList.status, 200);
  const records = evidenceList.body as { evidence: Record<string, unknown>[] };
  const mapped = records['evidence'].find((record) => record['evidenceId'] === evidenceId);
  assert.ok(mapped !== undefined, 'the mapped observation is in the common evidence ledger');
  assert.equal(mapped['class'], 'observation');
  assert.deepEqual((mapped as { source: { system: string } }).source, { system: 'creator-operations', ref: accountA1 });
  assert.equal((mapped as { content: { subjectKind: string } }).content['subjectKind'], 'engagement');
  assert.equal((mapped as { content: { eventKind: string } }).content['eventKind'], 'tip_received');

  // The metric half — through the COMMON /metrics HTTP surface, bound to
  // the evidence record.
  const metricList = await apiCall(port(), `/api/clients/${clientA1}/metrics`, { token: ownerA.token });
  assert.equal(metricList.status, 200);
  const metricBody = metricList.body as { observations: Record<string, unknown>[] };
  const metric = metricBody['observations'].find((row) => row['observationId'] === observationId);
  assert.ok(metric !== undefined, 'the mapped metric observation is in the common metric ledger');
  assert.equal(metric['metricName'], 'creator.engagement.event_count');
  assert.equal(metric['evidenceRef'], evidenceId);
  assert.deepEqual((metric as { source: { system: string } }).source, { system: 'creator-operations', ref: accountA1 });
});

test('CREATOR-AC-02: a monetization observation maps into the revenue metric family', async () => {
  const observation = await apiCall(port(), `/api/clients/${clientA1}/creator-observations`, {
    token: ownerA.token,
    body: {
      subjectKind: 'monetization',
      subjectRef: accountA1,
      eventKind: 'ppp_message_revenue',
      content: { offerId: offerA1, amountCents: 1500 },
      observedAt: new Date().toISOString(),
      quality: 'B',
      metric: {
        name: 'creator.monetization.revenue_cents',
        value: 1500,
        unit: 'cents',
        dimensions: { accountId: accountA1 },
        aggregationMethod: 'sum',
      },
      idempotencyKey: 'observation-2',
    },
  });
  assert.equal(observation.status, 201, JSON.stringify(observation.body));
  const metricList = await apiCall(port(), `/api/clients/${clientA1}/metrics`, { token: ownerA.token });
  const metricBody = metricList.body as { observations: Record<string, unknown>[] };
  const metric = metricBody['observations'].find(
    (row) => row['observationId'] === observation.body['observationId'],
  );
  assert.ok(metric !== undefined);
  assert.equal(metric['metricName'], 'creator.monetization.revenue_cents');
  assert.equal(metric['evidenceRef'], observation.body['evidenceId']);
});

test('CREATOR-AC-02: an inbound conversation message maps into the /evidence ledger (the receipt is stamped on the row)', async () => {
  const inbound = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/inbound`,
    {
      token: ownerA.token,
      body: {
        body: 'Hey! Loved your last post.',
        idempotencyKey: 'inbound-1',
        mapToEvidence: true,
      },
    },
  );
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
  assert.equal(inbound.body['direction'], 'inbound');
  assert.equal(inbound.body['status'], 'received');
  assert.equal(inbound.body['policyDecisionId'], undefined, 'an observation never carries gate provenance');
  const evidenceRef = inbound.body['evidenceRef'] as string;
  assert.ok(typeof evidenceRef === 'string' && evidenceRef.length > 0);

  // The message observation is in the common evidence ledger.
  const evidenceList = await apiCall(port(), `/api/clients/${clientA1}/evidence`, { token: ownerA.token });
  const records = (evidenceList.body as { evidence: Record<string, unknown>[] })['evidence'];
  const mapped = records.find((record) => record['evidenceId'] === evidenceRef);
  assert.ok(mapped !== undefined);
  assert.equal((mapped as { content: { eventKind: string } }).content['eventKind'], 'message_received');
  assert.equal((mapped as { content: { subjectKind: string } }).content['subjectKind'], 'conversation');

  // The replay of the same logical message command converges.
  const replay = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/inbound`,
    {
      token: ownerA.token,
      body: {
        body: 'Hey! Loved your last post.',
        idempotencyKey: 'inbound-1',
        mapToEvidence: true,
      },
    },
  );
  assert.equal(replay.status, 201);
  assert.equal(replay.body['messageId'], inbound.body['messageId'], 'the duplicate logical command converged');
});

test('CREATOR-AC-02: an evidence-only observation (no metric mapping) returns the evidence receipt alone', async () => {
  const observation = await apiCall(port(), `/api/clients/${clientA1}/creator-observations`, {
    token: ownerA.token,
    body: {
      subjectKind: 'audience',
      subjectRef: accountA1,
      eventKind: 'fan_subscribed',
      content: { fanAlias: 'top-fan-1' },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: null,
      idempotencyKey: 'observation-3',
    },
  });
  assert.equal(observation.status, 201);
  assert.ok(typeof observation.body['evidenceId'] === 'string');
  assert.equal(observation.body['observationId'], undefined, 'no metric mapping → no metric observation');
});

// ---------------------------------------------------------------------------
// CREATOR-AC-03 — the AI task declarations through /ai-runtime
// ---------------------------------------------------------------------------

test('CREATOR-AC-03: the pack provisions REAL TaskProfiles through the /ai-runtime authority', async () => {
  const provisioning = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/creator-operations/task-profiles`,
    {
      token: ownerA.token,
      body: { idempotencyKey: 'provision-1' },
    },
  );
  assert.equal(provisioning.status, 201, JSON.stringify(provisioning.body));
  const receipts = provisioning.body['taskProfiles'] as {
    taskClass: string;
    taskProfileId: string;
    replayed: boolean;
  }[];
  assert.equal(receipts.length, 7, 'the seven §5 AI task classes');
  assert.deepEqual(
    receipts.map((receipt) => receipt.taskClass).sort(),
    [
      'creator.classification',
      'creator.content_generation',
      'creator.conversation_summarization',
      'creator.recommendation',
      'creator.response_drafting',
      'creator.retrieval_synthesis',
      'creator.segmentation',
    ],
  );
  assert.ok(receipts.every((receipt) => !receipt.replayed));

  // The TaskProfiles are REAL /ai-runtime records — read back through the
  // authority's own HTTP surface.
  const list = await apiCall(port(), `/api/workspaces/${workspaceA1}/ai/task-profiles`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const body = list.body as { taskProfiles: Record<string, unknown>[] };
  const byClass = new Map(body['taskProfiles'].map((profile) => [String(profile['taskClass']), profile]));
  for (const receipt of receipts) {
    const profile = byClass.get(receipt.taskClass);
    assert.ok(profile !== undefined, `the ${receipt.taskClass} TaskProfile exists in /ai-runtime`);
    assert.equal(profile['taskProfileId'], receipt.taskProfileId);
    // CREATOR-AC-03: no provider coupling fields on the profile — the
    // record is the neutral §10 contract data.
    const serialized = JSON.stringify(profile);
    for (const forbidden of ['"sdk"', '"sdkPackage"', '"clientLibrary"', '"adapter"', '"credential"', '"apiKey"', '"openai"', '"anthropic"']) {
      assert.ok(!serialized.includes(forbidden), `the TaskProfile record must not carry '${forbidden}'`);
    }
  }

  // Replay: the same provisioning command converges per profile.
  const replay = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/creator-operations/task-profiles`,
    {
      token: ownerA.token,
      body: { idempotencyKey: 'provision-1' },
    },
  );
  assert.equal(replay.status, 201);
  const replayed = replay.body['taskProfiles'] as { replayed: boolean }[];
  assert.ok(replayed.every((receipt) => receipt.replayed), 'idempotent per-profile convergence');
});

// ---------------------------------------------------------------------------
// CREATOR-AC-05 + AC-04 setup — publish the frozen manifest, install, materialize
// ---------------------------------------------------------------------------

let packId = '';

test('CREATOR-AC-05: the frozen manifest publishes through the /domain-packs framework and installs with its artifacts', async () => {
  const publish = await apiCall(port(), '/api/creator-operations/publish', {
    token: ownerA.token,
    body: { idempotencyKey: 'creator-pack-publish-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  packId = publish.body['packId'] as string;
  assert.equal(publish.body['packKey'], 'creator-operations');
  assert.equal(publish.body['version'], '1.0.0');

  // Re-publication of the same immutable version is a 409 (§4).
  const republish = await apiCall(port(), '/api/creator-operations/publish', {
    token: ownerA.token,
    body: { idempotencyKey: 'creator-pack-publish-2' },
  });
  assert.equal(republish.status, 409);

  // Install into the workspace through the framework's own install route.
  const install = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId, idempotencyKey: 'creator-pack-install-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));

  // The artifacts materialized with the §5 explicit scope distinction.
  const artifacts = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  assert.equal(artifacts.status, 200);
  const artifactBody = artifacts.body as { artifacts: { artifactKind: string; artifactName: string; scope: string; payload: Record<string, unknown> }[] };
  const byName = new Map(artifactBody['artifacts'].map((artifact) => [artifact.artifactName, artifact]));

  const triage = byName.get('conversation-triage');
  assert.ok(triage !== undefined, 'the conversation-triage workflow template is materialized');
  assert.equal(triage.scope, 'agency-reusable');
  assert.ok((triage.payload as { graph: { nodes: unknown[] } }).graph.nodes.length >= 4);

  const chatterCapability = byName.get('chatter');
  assert.ok(chatterCapability !== undefined, 'the chatter human capability is materialized');
  assert.equal((chatterCapability.payload as { specialization: string }).specialization, 'chatter');

  const sendBinding = byName.get('send_approved_communication');
  assert.ok(sendBinding !== undefined, 'the §6 normalized capability binding is materialized');
  assert.equal((sendBinding.payload as { boundary: string }).boundary, '/integrations | /extensions');
});

// ---------------------------------------------------------------------------
// CREATOR-AC-04 — human work through the GENERIC Human Agent → Job model
// ---------------------------------------------------------------------------

test('CREATOR-AC-04: a workflow built from the pack template projects a chatter-specialized Job; the outcome preserves actor + evidence provenance', async () => {
  // The template content straight from the published pack (data, §4
  // conformant, materialized through the /workflows authority).
  const artifacts = await apiCall(port(), `/api/workspaces/${workspaceA1}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  const artifactBody = artifacts.body as { artifacts: { artifactName: string; payload: Record<string, unknown> }[] };
  const template = artifactBody['artifacts'].find((artifact) => artifact.artifactName === 'conversation-triage');
  assert.ok(template !== undefined);
  const content = template.payload as Record<string, unknown>;

  // Create a REAL workflow + definition from the template content and
  // start a RUNNING instance (the existing /workflows authority).
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: ownerA.token,
    body: { name: `creator-triage-${randomUUID().slice(0, 8)}`, description: 'Pack template materialization' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: ownerA.token,
    body: content,
  });
  assert.equal(created.status, 201, `definition creation failed: ${JSON.stringify(created.body)}`);
  const definitionId = created.body['workflowDefinitionId'] as string;
  let version = created.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status, version },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    version = next.body['version'] as number;
  }

  const instance = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${definitionId}/instances`,
    { token: ownerA.token, body: {} },
  );
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  const instanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
      { token: ownerA.token, body: { to, version: instanceVersion, idempotencyKey: `pack-${to}-${instanceId}` } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }

  // Project the human_task node of the pack template as a Job through the
  // EXISTING /jobs authority — chatter specialization (the §4 role of the
  // pack, served by the GENERIC model).
  const projection = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${instanceId}/jobs`,
    {
      token: ownerA.token,
      body: {
        nodeId: 'approve_reply',
        title: 'Approve the drafted reply',
        description: 'Review the AI-drafted reply and approve the outbound send.',
        specialization: 'chatter',
        requiredCapabilities: ['community_reply'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    },
  );
  assert.equal(projection.status, 201, `projection failed: ${JSON.stringify(projection.body)}`);
  const job = projection.body as Record<string, unknown>;
  const jobId = job['jobId'] as string;
  assert.equal((job['eligibility'] as Record<string, unknown>)['specialization'], 'chatter');
  assert.equal(job['nodeId'], 'approve_reply');
  assert.equal(job['workflowInstanceId'], instanceId);
  assert.equal(job['clientId'], clientA1, 'the job scope is server-derived from the instance chain');

  // Offer → accept (the chatter Human Agent) → outcome with evidence.
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: ownerA.token,
    body: { candidateAgentId: chatterAgentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = (offer.body as Record<string, unknown>)['offerId'] as string;

  const accepted = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: chatterUser.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  const evidence = await apiCall(port(), `/api/clients/${clientA1}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'observation',
      sourceSystem: 'creator-operations',
      sourceRef: conversationA1,
      observedAt: new Date().toISOString(),
      content: { subjectKind: 'conversation', subjectRef: conversationA1, eventKind: 'reply_handled' },
      quality: 'C',
    },
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  const evidenceId = evidence.body['evidenceId'] as string;

  const outcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: chatterUser.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));
  const outcomeBody = outcome.body as Record<string, unknown>;
  const outcomeRecord = outcomeBody['outcome'] as Record<string, unknown>;
  assert.equal(outcomeRecord['evidenceRef'], evidenceId, 'the outcome preserves the evidence provenance');
  const provenance = outcomeRecord['provenance'] as { recordedActor: string; submittedBy: string | null };
  assert.equal(provenance['recordedActor'], `user:${chatterUser.userId}`, 'the outcome preserves the actor provenance');
  assert.equal(provenance['submittedBy'], chatterUser.userId);
});

// ---------------------------------------------------------------------------
// CREATOR-AC-06 — the approval-gated side effects (fail-closed)
// ---------------------------------------------------------------------------

test('CREATOR-AC-06: an outbound send WITHOUT any policy fails closed and never writes a row', async () => {
  const denied = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: { body: 'Thanks for the support!', idempotencyKey: 'outbound-no-policy', approvalId: null },
    },
  );
  assert.equal(denied.status, 403, `the fail-closed gate denies without a policy: ${JSON.stringify(denied.body)}`);

  const rows = await pool().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM creator_conversation_messages WHERE direction = 'outbound'",
  );
  assert.equal(Number(rows.rows[0]!.count), 0, 'an unapproved send never produces a row');
});

test('CREATOR-AC-06: a policy allowing direct sends permits the outbound side effect (the decision id is stamped on the row)', async () => {
  // Declare the client network policy: allow direct sends
  // (approvalStatus='missing').
  const declare = await apiCall(port(), `/api/clients/${clientA1}/policies`, {
    token: ownerA.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['creator.conversation.send', 'creator.content.publish'],
          attributes: { approvalStatus: 'missing' },
          reason: 'creator operations allow direct sends in this client',
        },
      ],
      description: 'Creator conversation gate v1 (direct sends allowed)',
    },
  });
  assert.equal(declare.status, 201, JSON.stringify(declare.body));

  const sent = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: { body: 'Thanks for the support!', idempotencyKey: 'outbound-direct-1', approvalId: null },
    },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body['status'], 'sent');
  const decisionId = sent.body['policyDecisionId'] as string;
  assert.ok(typeof decisionId === 'string' && decisionId.length > 0);

  // The row is born 'sent' with the ALLOWING decision (direct SQL).
  const row = await pool().query<{ direction: string; status: string; policy_decision_id: string | null; approval_id: string | null }>(
    'SELECT direction, status, policy_decision_id, approval_id FROM creator_conversation_messages WHERE message_id = $1',
    [sent.body['messageId'] as string],
  );
  assert.equal(row.rows[0]!.direction, 'outbound');
  assert.equal(row.rows[0]!.status, 'sent');
  assert.equal(row.rows[0]!.policy_decision_id, decisionId);
  assert.equal(row.rows[0]!.approval_id, null);

  // The policy decision is recorded in the /policies ledger.
  const decision = await pool().query<{ outcome: string; reason_code: string }>(
    'SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = $1',
    [decisionId],
  );
  assert.equal(decision.rows.length, 1);
  assert.equal(decision.rows[0]!.outcome, 'allow');
});

test('CREATOR-AC-06: a policy demanding approval blocks unapproved sends; a valid pack approval unlocks the side effect', async () => {
  // Supersede the policy: approvals are now REQUIRED (only
  // approvalStatus='approved' matches the allow rule).
  const supersede = await apiCall(port(), `/api/clients/${clientA1}/policies`, {
    token: ownerA.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['creator.conversation.send'],
          attributes: { approvalStatus: 'approved' },
          reason: 'creator conversation sends require a human approval in this client',
        },
      ],
      description: 'Creator conversation gate v2 (approvals required)',
    },
  });
  assert.equal(supersede.status, 201, JSON.stringify(supersede.body));

  // Unapproved send: DENIED (fail-closed), no row.
  const denied = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: { body: 'Unapproved!', idempotencyKey: 'outbound-needs-approval', approvalId: null },
    },
  );
  assert.equal(denied.status, 403, JSON.stringify(denied.body));

  // Record the human approval — the approver is the authenticated
  // principal; the approver specializations are resolved server-side from
  // the /field-agents profile.
  const approval = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/approvals`,
    {
      token: ownerA.token,
      body: { decision: 'approved', notes: 'Reply is on-brand.', idempotencyKey: 'approval-send-1' },
    },
  );
  assert.equal(approval.status, 201, JSON.stringify(approval.body));
  const approvalId = approval.body['approvalId'] as string;
  assert.equal(approval.body['approverUserId'], ownerA.userId, 'the approver is the authenticated principal');
  assert.deepEqual(
    approval.body['approverSpecializations'],
    ['reviewer'],
    'the approver provenance carries the Human Agent specializations resolved from /field-agents',
  );

  // The approved send: born 'sent' carrying the decision AND the approval.
  const sent = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: { body: 'Thanks so much!', idempotencyKey: 'outbound-approved-1', approvalId },
    },
  );
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body['approvalId'], approvalId);
  const row = await pool().query<{ approval_id: string | null; policy_decision_id: string | null }>(
    'SELECT approval_id, policy_decision_id FROM creator_conversation_messages WHERE message_id = $1',
    [sent.body['messageId'] as string],
  );
  assert.equal(row.rows[0]!.approval_id, approvalId);
  assert.ok(row.rows[0]!.policy_decision_id !== null);

  // A REJECTED approval never satisfies the gate.
  const rejected = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/approvals`,
    {
      token: ownerA.token,
      body: { decision: 'rejected', notes: 'No.', idempotencyKey: 'approval-send-2' },
    },
  );
  assert.equal(rejected.status, 201);
  const sendWithRejected = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: {
        body: 'Should not send',
        idempotencyKey: 'outbound-rejected-approval',
        approvalId: rejected.body['approvalId'] as string,
      },
    },
  );
  assert.equal(sendWithRejected.status, 422, 'a rejected approval is an invalid gate input (fail-closed)');
});

test('CREATOR-AC-06: a foreign approval id is a UNIFORM 404 (no cross-tenant oracle)', async () => {
  // A conversation + approval in the foreign client B.
  const profileB = await apiCall(port(), `/api/clients/${clientB}/creator-profiles`, {
    token: ownerB.token,
    body: {
      displayName: 'Bee Creator',
      handle: 'bee-creator',
      niches: [],
      bio: '',
      attributes: {},
      idempotencyKey: 'profile-bee-1',
    },
  });
  assert.equal(profileB.status, 201);
  const accountB = await apiCall(
    port(),
    `/api/creator-profiles/${profileB.body['profileId'] as string}/accounts`,
    {
      token: ownerB.token,
      body: {
        platformLabel: 'creator-platform-1',
        accountHandle: '@bee',
        metadata: {},
        idempotencyKey: 'account-bee-1',
      },
    },
  );
  assert.equal(accountB.status, 201);
  const fanB = await apiCall(
    port(),
    `/api/creator-accounts/${accountB.body['accountId'] as string}/fans`,
    {
      token: ownerB.token,
      body: { fanAlias: 'bee-fan-1', tier: 'standard', tags: [], attributes: {}, idempotencyKey: 'fan-bee-1' },
    },
  );
  assert.equal(fanB.status, 201);
  const conversationB = await apiCall(
    port(),
    `/api/creator-accounts/${accountB.body['accountId'] as string}/conversations`,
    {
      token: ownerB.token,
      body: {
        fanId: fanB.body['fanId'] as string,
        channel: 'dm',
        topic: '',
        attributes: {},
        idempotencyKey: 'conversation-bee-1',
      },
    },
  );
  assert.equal(conversationB.status, 201);
  const approvalB = await apiCall(
    port(),
    `/api/creator-conversations/${conversationB.body['conversationId'] as string}/approvals`,
    {
      token: ownerB.token,
      body: { decision: 'approved', notes: '', idempotencyKey: 'approval-bee-1' },
    },
  );
  assert.equal(approvalB.status, 201);

  // Presenting the foreign (client B) approval to an A1 send: the
  // approval exists but belongs to another client — a uniform 404, the
  // same as an unknown id.
  const foreignApprovalSend = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: {
        body: 'Cross-client approval probe',
        idempotencyKey: 'outbound-foreign-approval',
        approvalId: approvalB.body['approvalId'] as string,
      },
    },
  );
  assert.equal(foreignApprovalSend.status, 404, 'a foreign approval is indistinguishable from an unknown one');
  const unknownApprovalSend = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: {
        body: 'Unknown approval probe',
        idempotencyKey: 'outbound-unknown-approval',
        approvalId: randomUUID(),
      },
    },
  );
  assert.equal(unknownApprovalSend.status, 404);
});

test('CREATOR-AC-06: the content PUBLISH edge is the same fail-closed gated side effect', async () => {
  // Move the asset through the frozen lifecycle to 'approved'.
  const toReview = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: { to: 'in_review', expectedVersion: 1, approvalId: null },
  });
  assert.equal(toReview.status, 200, JSON.stringify(toReview.body));
  const toApproved = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: { to: 'approved', expectedVersion: 2, approvalId: null },
  });
  assert.equal(toApproved.status, 200, JSON.stringify(toApproved.body));
  const version = toApproved.body['version'] as number;

  // The v2 policy demands approvals for SENDS only — publishing matches no
  // rule (the v1 rule that allowed 'creator.content.publish' with
  // approvalStatus='missing' was superseded) → fail closed.
  const publishDenied = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: { to: 'published', expectedVersion: version, approvalId: null },
  });
  assert.equal(publishDenied.status, 403, `the publish gate fails closed: ${JSON.stringify(publishDenied.body)}`);

  // The asset stays 'approved' (no side effect without the gate).
  const stillApproved = await pool().query<{ status: string; published_at: string | null }>(
    'SELECT status, published_at FROM creator_content_assets WHERE asset_id = $1',
    [contentA1],
  );
  assert.equal(stillApproved.rows[0]!.status, 'approved');
  assert.equal(stillApproved.rows[0]!.published_at, null);

  // Declare a publish policy requiring approval; record the approval;
  // publish succeeds with the decision stamped.
  const publishPolicy = await apiCall(port(), `/api/clients/${clientA1}/policies`, {
    token: ownerA.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['creator.conversation.send', 'creator.content.publish'],
          attributes: { approvalStatus: 'approved' },
          reason: 'creator sends and publishes require human approval in this client',
        },
      ],
      description: 'Creator gate v3 (approvals required for sends and publishes)',
    },
  });
  assert.equal(publishPolicy.status, 201, JSON.stringify(publishPolicy.body));

  const publishWithoutApproval = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: { to: 'published', expectedVersion: version, approvalId: null },
  });
  assert.equal(publishWithoutApproval.status, 403, 'the approval-requiring policy blocks the unapproved publish');

  const publishApproval = await apiCall(port(), `/api/creator-content-assets/${contentA1}/approvals`, {
    token: ownerA.token,
    body: { decision: 'approved', notes: 'Content reviewed.', idempotencyKey: 'approval-publish-1' },
  });
  assert.equal(publishApproval.status, 201, JSON.stringify(publishApproval.body));
  assert.deepEqual(publishApproval.body['approverSpecializations'], ['reviewer']);

  const published = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: {
      to: 'published',
      expectedVersion: version,
      approvalId: publishApproval.body['approvalId'] as string,
    },
  });
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body['status'], 'published');
  assert.ok(typeof published.body['publishedAt'] === 'string');
  assert.ok(typeof published.body['policyDecisionId'] === 'string');
  assert.equal(published.body['approvalId'], publishApproval.body['approvalId']);

  // The DB row carries the gate provenance; published is TERMINAL.
  const row = await pool().query<{ status: string; policy_decision_id: string | null; published_at: string | null }>(
    'SELECT status, policy_decision_id, published_at FROM creator_content_assets WHERE asset_id = $1',
    [contentA1],
  );
  assert.equal(row.rows[0]!.status, 'published');
  assert.ok(row.rows[0]!.policy_decision_id !== null);
  assert.ok(row.rows[0]!.published_at !== null);

  const terminal = await apiCall(port(), `/api/creator-content-assets/${contentA1}/status`, {
    token: ownerA.token,
    body: { to: 'rejected', expectedVersion: (published.body['version'] as number) + 1, approvalId: null },
  });
  assert.equal(terminal.status, 409, 'published is terminal');
});

test('CREATOR-AC-06: the gate provenance is never request-suppliable (DTO authority-field rejection)', async () => {
  const injected = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/messages/outbound`,
    {
      token: ownerA.token,
      body: { body: 'Probe', idempotencyKey: 'outbound-inject', approvalId: null, policyDecisionId: 'forged' },
    },
  );
  assert.equal(injected.status, 422, 'a forged gate provenance field is rejected before any traversal');

  const injectedApproval = await apiCall(
    port(),
    `/api/creator-conversations/${conversationA1}/approvals`,
    {
      token: ownerA.token,
      body: { decision: 'approved', notes: '', idempotencyKey: 'approval-inject', approverUserId: randomUUID() },
    },
  );
  assert.equal(injectedApproval.status, 422, 'a forged approver identity is rejected');

  const material = await apiCall(port(), `/api/clients/${clientA1}/creator-profiles`, {
    token: ownerA.token,
    body: {
      displayName: 'Material Probe',
      handle: 'material-probe',
      niches: [],
      bio: '',
      attributes: { secret: 'leak' },
      idempotencyKey: 'profile-material',
    },
  });
  assert.equal(material.status, 422, 'material-shaped keys are rejected (§21)');
});
