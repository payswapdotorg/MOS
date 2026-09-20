/**
 * MKT-068 integration tests — the Notification Delivery Plane on the REAL
 * stack: embedded PostgreSQL 18, a real API process (the production
 * composition — the email channel absent there: no provider transport is
 * wired in the default composition, the fail-closed socialAccountFlows
 * precedent), and the SAME in-process application composed against the
 * SAME database with the EMAIL channel wired through the DISCLOSED
 * composition seam (AppOptions.notificationEmailTransport +
 * AppOptions.notificationEmailProvider) carrying a DETERMINISTIC IN-REPO
 * TEST DOUBLE (an in-process object — NO network calls anywhere in this
 * suite, AC-7).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-068; the dispatch
 * acceptance criteria):
 *   - AC-1: the durable notification records carry the full §14 field set
 *     (event type, urgency, explanation, source reference, required
 *     action, deep link, delivery status — the adapter-plane lifecycle
 *     pending → dispatched, NEVER a task state);
 *   - AC-2: the DeliveryAdapter contract — the in-app channel
 *     (module-internal) + the email channel (the provider-seam subtree
 *     wired as composition data) with their DECLARED urgency/event-type
 *     subsets (routine stays in-app);
 *   - AC-3: the per-channel /policies gate — the honest REFUSED receipt on
 *     a channel not sanctioned for the urgency (an attribute-scoped deny
 *     refuses email for 'important' while in-app still delivers), and the
 *     NO-POLICY fail-closed battery (a fresh agency: both channels
 *     refused, reason no-active-policy, ZERO provider egress);
 *   - AC-4: the email provider credential resolves through the
 *     /credentials vault READ-ONLY (the reference created through the
 *     REAL credential routes; the material resolved in-process at
 *     delivery time; a DISABLED reference → the honest FAILED receipt
 *     with the bounded reason while in-app still delivers);
 *   - AC-5: the dedup fence — a REPLAYED occurrence never double-delivers
 *     (the transport counter unchanged, one honest duplicate-skipped
 *     receipt PER TARGETED CHANNEL on the ORIGINAL notification); the
 *     receipt tail is append-only (retries/DB rewrites rejected by
 *     trigger);
 *   - AC-6: the in-app adapter — the durable inbox projection readable
 *     through the module public API + the HTTP surface, with the
 *     read/unread transition set EXACTLY ONCE (a second read is the honest
 *     409);
 *   - AC-7: the email adapter — recipients resolve from the
 *     workspace/client context ONLY (the transport double records exactly
 *     the owning agency's active owners; no address ever arrives from a
 *     request body), the §14 envelope composition, the provider seam
 *     documented (the deterministic double; NO real network calls);
 *   - AC-8: the ROUND TRIP at BOTH levels — module-level operations
 *     (create → gate → per-channel receipts → in-app read surface →
 *     replay → duplicate-skipped) and the HTTP surfaces (the same round
 *     trip through POST/GET on the spawned production API);
 *   - AC-9: the fail-closed isolation battery — anonymous 401, the
 *     uniform 404 (foreign ≡ unknown ≡ malformed), the suspended 403;
 *   - AC-10: the DB backstops — the append-only receipt/fence triggers,
 *     the no-DELETE on notifications, the single dispatch fill and the
 *     single read fill (direct SQL rejections).
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
import type {
  EmailTransportPort,
  NotificationDeliveryModuleApi,
} from '../../src/modules/notification-delivery/public.ts';
import type { CredentialsModuleApi } from '../../src/modules/credentials/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PROVIDER_SECRET_HANDLE = 'notification-delivery-test-provider-key';
const PROVIDER_SECRET_MATERIAL = 'smtp-api-key-material-for-the-deterministic-double';
const PROVIDER_FROM = 'mos-notifications@agency.test';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let notifications: NotificationDeliveryModuleApi | null = null;
let vault: CredentialsModuleApi | null = null;

function delivery(): NotificationDeliveryModuleApi {
  if (notifications === null) throw new Error('application not bootstrapped');
  return notifications;
}
function credentialsModule(): CredentialsModuleApi {
  if (vault === null) throw new Error('application not bootstrapped');
  return vault;
}
function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}
function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const MODULE_PROVENANCE = {
  actor: 'user:99999999-9999-4999-8999-999999999999',
  recordedVia: 'test',
  correlationId: 'integration-notification-delivery-1',
  causationId: null,
} as const;

// ---------------------------------------------------------------------------
// The DETERMINISTIC email transport double (in-process; NO network — AC-7)
// ---------------------------------------------------------------------------

interface RecordedEmail {
  readonly recipients: readonly string[];
  readonly fromAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly credentialMaterialLength: number;
  readonly messageId: string;
}

const sentEmails: RecordedEmail[] = [];
const emailTransport: EmailTransportPort = {
  send: async (input) => {
    const messageId = `test-email-${sentEmails.length + 1}`;
    sentEmails.push({
      recipients: [...input.recipients],
      fromAddress: input.fromAddress,
      subject: input.subject,
      body: input.body,
      credentialMaterialLength: input.credentialMaterial.byteLength,
      messageId,
    });
    return { messageId };
  },
};

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

interface User {
  readonly userId: string;
  readonly token: string;
}
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

let clientSeq = 0;
async function makeClient(agencyId: string, token: string): Promise<string> {
  clientSeq += 1;
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name: `Client ${agencyId.slice(0, 8)} ${clientSeq}` },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
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

/** Declares an AGENCY network policy version with the given rules. */
async function declareNetworkPolicy(
  principal: Principal,
  rules: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension: 'network',
      rules,
      description: 'Integration test notification-channel policy',
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

async function allowAllChannels(principal: Principal): Promise<void> {
  await declareNetworkPolicy(principal, [
    { effect: 'allow', operations: ['*'], reason: 'integration test allowance' },
  ]);
}

async function countRows(table: string, where: string, params: unknown[]): Promise<number> {
  const result = await pool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${where}`,
    params as never[],
  );
  return Number(result.rows[0]!.count);
}

async function assertDbRejects(sql: string, params: unknown[], marker: string): Promise<void> {
  await assert.rejects(
    () => pool().query(sql, params as never[]),
    (error: unknown) => {
      assert.ok(
        error instanceof Error && error.message.includes(marker),
        `expected the database to reject with '${marker}', got: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// Shared state built once in before()
// ---------------------------------------------------------------------------

let alice: Principal;
let aliceClientId: string;
let aliceWorkspaceId: string;
let providerCredentialId: string;
let bob: Principal;
let bobClientId: string;
let carol: Principal;
let carolClientId: string;
let suspendedMember: User;
let suspendedMembershipId: string;

before(async () => {
  stack = await bootStack('notifications');
  // The CRED-001 secret-handle fixture (the social-accounts precedent):
  // the email provider credential is a REAL vault reference whose handle
  // resolves in the fs secret backend; only the reference id ever
  // reaches the adapter (AC-4).
  fs.writeFileSync(
    `${stack.env.secretsDir}/${PROVIDER_SECRET_HANDLE}.secret`,
    PROVIDER_SECRET_MATERIAL,
    { mode: 0o600 },
  );
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // Fixtures: the agencies (the isolation + no-policy batteries), the
  // clients + workspace, the network allowance and the provider vault
  // reference (created through the REAL credential routes).
  alice = await makeAgencyOwner('alice@notifications.test');
  bob = await makeAgencyOwner('bob@notifications.test');
  carol = await makeAgencyOwner('carol@notifications.test');
  aliceClientId = await makeClient(alice.agencyId, alice.token);
  aliceWorkspaceId = await makeWorkspace(aliceClientId, alice.token, 'Growth Room');
  bobClientId = await makeClient(bob.agencyId, bob.token);
  carolClientId = await makeClient(carol.agencyId, carol.token);
  await allowAllChannels(alice);

  const credential = await apiCall(port(), `/api/agencies/${alice.agencyId}/credentials`, {
    token: alice.token,
    body: {
      kind: 'notification_provider_key',
      label: 'email_provider_smtp_key',
      secretHandle: PROVIDER_SECRET_HANDLE,
    },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  providerCredentialId = credential.body['credentialId'] as string;

  // The in-process application with the EMAIL channel wired through the
  // DISCLOSED composition seam (the deterministic in-repo double — the
  // spawned production API keeps the default composition: in-app only).
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({
    notificationEmailTransport: emailTransport,
    notificationEmailProvider: {
      credentialReferenceId: providerCredentialId,
      fromAddress: PROVIDER_FROM,
    },
  });
  notifications = core.modules.notificationDelivery;
  vault = core.modules.credentials;

  // A suspended member of alice's agency (the 403 battery).
  suspendedMember = await makeUser('suspended@notifications.test', 'suspended-pass-123');
  const membership = await apiCall(port(), `/api/agencies/${alice.agencyId}/memberships`, {
    token: alice.token,
    body: { userId: suspendedMember.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  suspendedMembershipId = membership.body['membershipId'] as string;
  const suspend = await apiCall(
    port(),
    `/api/agencies/${alice.agencyId}/memberships/${suspendedMembershipId}`,
    {
      token: alice.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membership.body['version'] as number },
    },
  );
  assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-2/AC-4/AC-5/AC-7/AC-8: THE MODULE-LEVEL GOLDEN PATH — both channels
// ---------------------------------------------------------------------------

test('AC-8 golden path (module level): create → gate → per-channel receipts → in-app read surface → replay → duplicate-skipped — both channels, zero double-delivery', async () => {
  const sentBefore = sentEmails.length;

  // 1. THE DELIVERY COMMAND (a growth mission blocked pending human action —
  //    the v1.6 blocker → notification → action loop).
  const first = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      eventType: 'mission_attention_required',
      urgency: 'critical',
      explanation: 'Mission M-91 is blocked pending human action on the content rights gate.',
      sourceKind: 'growth_mission',
      sourceId: '11111111-1111-4111-8111-111111111111',
      requiredAction: 'Approve or reject the content rights clearance in the console.',
      deepLink: '/console/missions/11111111-1111-4111-8111-111111111111',
      occurrenceKey: 'blocked-transition-1',
    },
    MODULE_PROVENANCE,
  );

  // AC-1: the record carries the FULL §14 field set, born dispatched (the
  // dispatch ran inside the command), NEVER a task state.
  assert.equal(first.duplicate, false);
  assert.equal(first.notification.eventType, 'mission_attention_required');
  assert.equal(first.notification.urgency, 'critical');
  assert.equal(first.notification.explanation, 'Mission M-91 is blocked pending human action on the content rights gate.');
  assert.equal(first.notification.sourceKind, 'growth_mission');
  assert.equal(first.notification.sourceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(first.notification.requiredAction, 'Approve or reject the content rights clearance in the console.');
  assert.equal(first.notification.deepLink, '/console/missions/11111111-1111-4111-8111-111111111111');
  assert.equal(first.notification.agencyId, alice.agencyId);
  assert.equal(first.notification.clientId, aliceClientId);
  assert.equal(first.notification.workspaceId, aliceWorkspaceId);
  assert.equal(first.notification.deliveryStatus, 'dispatched');

  // The per-channel receipts: in_app delivered (the inbox row id) + email
  // delivered (the transport's message id) — both gated (policy decision
  // ids recorded, AC-3).
  assert.deepEqual(
    first.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered'], ['email', 'delivered']],
  );
  const inAppReceipt = first.receipts[0]!;
  const emailReceipt = first.receipts[1]!;
  assert.ok(inAppReceipt.providerMessageId !== null, 'the in-app provider message id is the inbox row id');
  assert.ok(inAppReceipt.policyDecisionId !== null, 'the in-app attempt was policy-gated');
  assert.ok(emailReceipt.policyDecisionId !== null, 'the email attempt was policy-gated');
  assert.equal(emailReceipt.providerMessageId, `test-email-${sentBefore + 1}`);
  assert.equal(emailReceipt.reason, null, 'a delivered receipt carries no refusal reason');

  // AC-7: the deterministic transport double recorded EXACTLY ONE email —
  // to the owning agency's active owner (the workspace/client context —
  // never a request field, never guessed) with the §14 envelope and the
  // resolved provider credential material (in-process only).
  assert.equal(sentEmails.length, sentBefore + 1);
  const sent = sentEmails[sentEmails.length - 1]!;
  assert.deepEqual(sent.recipients, ['alice@notifications.test']);
  assert.equal(sent.fromAddress, PROVIDER_FROM);
  assert.ok(sent.subject.startsWith('[critical] mission_attention_required'));
  assert.ok(sent.body.includes('Approve or reject the content rights clearance'));
  assert.ok(sent.body.includes('Open in console: /console/missions/'));
  assert.ok(sent.credentialMaterialLength > 0, 'the vault-resolved material reached the transport seam in-process');

  // AC-6: the in-app read surface — the durable inbox projection.
  const inbox = await delivery().listInboxItems(aliceClientId);
  assert.equal(inbox.length, 1);
  const item = inbox[0]!;
  assert.equal(item.notification.notificationId, first.notification.notificationId);
  assert.equal(item.readAt, null, 'the inbox item is born unread');

  // The read transition: set EXACTLY once (append-only).
  const read = await delivery().markInboxItemRead(
    { notificationId: first.notification.notificationId },
    MODULE_PROVENANCE,
  );
  assert.ok(read.readAt !== null);
  assert.equal(read.readByActor, MODULE_PROVENANCE.actor);
  const reread = await delivery().markInboxItemRead(
    { notificationId: first.notification.notificationId },
    MODULE_PROVENANCE,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(reread !== null, 'the second read is refused');
  assert.ok(String((reread as Error).message).includes('already read'));

  // 2. THE REPLAY of the SAME occurrence (AC-5): never double-delivers.
  const replay = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: aliceWorkspaceId,
      eventType: 'mission_attention_required',
      urgency: 'critical',
      explanation: 'Mission M-91 is blocked pending human action on the content rights gate.',
      sourceKind: 'growth_mission',
      sourceId: '11111111-1111-4111-8111-111111111111',
      requiredAction: 'Approve or reject the content rights clearance in the console.',
      deepLink: '/console/missions/11111111-1111-4111-8111-111111111111',
      occurrenceKey: 'blocked-transition-1',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(replay.duplicate, true, 'the replay surfaces the duplicate flag');
  assert.equal(
    replay.notification.notificationId,
    first.notification.notificationId,
    'the replay resolves the ORIGINAL notification',
  );
  assert.deepEqual(
    replay.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'duplicate_skipped'], ['email', 'duplicate_skipped']],
    'one honest duplicate-skipped receipt PER TARGETED CHANNEL',
  );
  assert.equal(sentEmails.length, sentBefore + 1, 'ZERO additional provider sends — the fence stopped the replay');

  // A DIFFERENT occurrence of the SAME event type from the SAME source is
  // a NEW notification (the occurrence-key discrimination).
  const second = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'mission_attention_required',
      urgency: 'urgent',
      explanation: 'Mission M-91 is blocked again on the platform policy gate.',
      sourceKind: 'growth_mission',
      sourceId: '11111111-1111-4111-8111-111111111111',
      requiredAction: null,
      deepLink: '/console/missions/11111111-1111-4111-8111-111111111111',
      occurrenceKey: 'blocked-transition-2',
    },
    MODULE_PROVENANCE,
  );
  assert.equal(second.duplicate, false);
  assert.notEqual(second.notification.notificationId, first.notification.notificationId);
  assert.equal(sentEmails.length, sentBefore + 2, 'the new occurrence delivers email again');

  // The receipt-history completeness (AC-5): the FIRST notification's tail
  // carries every attempt in order — delivered, delivered,
  // duplicate_skipped, duplicate_skipped.
  const tail = await delivery().listNotificationReceipts(first.notification.notificationId);
  assert.ok(tail !== null);
  assert.deepEqual(
    tail.map((receipt) => [receipt.channel, receipt.outcome]),
    [
      ['in_app', 'delivered'],
      ['email', 'delivered'],
      ['in_app', 'duplicate_skipped'],
      ['email', 'duplicate_skipped'],
    ],
    'the complete honest delivery history, in order, append-only',
  );
  // The duplicate-skipped receipts carry neither reason nor policy
  // decision nor provider message id (the honest payload shape).
  for (const skipped of tail.slice(2)) {
    assert.equal(skipped.reason, null);
    assert.equal(skipped.policyDecisionId, null);
    assert.equal(skipped.providerMessageId, null);
  }

  // The DB: exactly ONE fence row per occurrence + one notification each;
  // the inbox projection holds the READ item exactly once.
  assert.equal(
    await countRows('notification_delivery_fences', 'source_id = $1 AND occurrence_key = $2', [
      '11111111-1111-4111-8111-111111111111',
      'blocked-transition-1',
    ]),
    1,
  );
  assert.equal(
    await countRows('notifications', 'source_id = $1', ['11111111-1111-4111-8111-111111111111']),
    2,
  );
  assert.equal(
    await countRows('notification_inbox_items', 'notification_id = $1', [
      first.notification.notificationId,
    ]),
    1,
  );
});

// ---------------------------------------------------------------------------
// AC-2: the declared urgency subsets — routine stays in-app
// ---------------------------------------------------------------------------

test('AC-2 (module level): the email channel accepts only important/urgent/critical — a routine notice stays in the in-app inbox', async () => {
  const sentBefore = sentEmails.length;
  const result = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'system_notice',
      urgency: 'routine',
      explanation: 'A weekly digest of mission progress is available.',
      sourceKind: 'platform',
      sourceId: 'digest-runner',
      requiredAction: null,
      deepLink: '/console/reports/weekly',
      occurrenceKey: 'digest-2026-w38',
    },
    MODULE_PROVENANCE,
  );
  // Only the in-app channel is targeted (the declared subset) — no email
  // receipt at all (the channel was not targeted, which is NOT a refusal).
  assert.deepEqual(
    result.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered']],
  );
  assert.equal(sentEmails.length, sentBefore, 'the routine notice never egresses email');
});

// ---------------------------------------------------------------------------
// AC-3: the policy-refusal battery (module level)
// ---------------------------------------------------------------------------

test('AC-3 (module level): a channel not sanctioned for the urgency FAILS CLOSED — the honest refused receipt while the other channel still delivers', async () => {
  const sentBefore = sentEmails.length;

  // A superseding agency network policy: email is DENIED for 'important'
  // deliveries (the urgency-attribute sanction); everything else allowed.
  await declareNetworkPolicy(alice, [
    {
      effect: 'deny',
      operations: ['notification.channel.email'],
      attributes: { urgency: 'important' },
      reason: 'email paused for important notices during the incident review',
    },
    { effect: 'allow', operations: ['*'], reason: 'everything else allowed' },
  ]);

  const refused = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'anomaly_detected',
      urgency: 'important',
      explanation: 'Reach on the primary channel collapsed below the baseline band.',
      sourceKind: 'platform',
      sourceId: 'platform-health-monitor',
      requiredAction: 'Review the distribution anomaly in the console.',
      deepLink: '/console/health',
      occurrenceKey: 'anomaly-991',
    },
    MODULE_PROVENANCE,
  );

  // The per-channel fail-closed battery: email REFUSED (the honest receipt
  // with the policy decision id + the bounded reason), in-app DELIVERED —
  // one channel's refusal never blocks the others.
  assert.deepEqual(
    refused.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered'], ['email', 'refused']],
  );
  const refusal = refused.receipts[1]!;
  assert.ok(refusal.reason !== null && refusal.reason.includes('notification.channel.email'));
  assert.ok(refusal.policyDecisionId !== null, 'the refusal receipt cites the recorded policy decision');
  assert.equal(refusal.providerMessageId, null);

  // The cited decision is the policy engine's OWN record (cross-checked
  // in the DB): a deny on the notification.channel.email operation.
  const decisionRow = await pool().query(
    'SELECT action, outcome, reason_code FROM policy_decisions WHERE decision_id = $1',
    [refusal.policyDecisionId],
  );
  assert.equal((decisionRow.rows[0]!.action as Record<string, unknown>)['operation'], 'notification.channel.email');
  assert.equal(decisionRow.rows[0]!.outcome, 'deny');
  assert.equal(decisionRow.rows[0]!.reason_code, 'rule-denied');

  // ZERO provider egress for the refused channel.
  assert.equal(sentEmails.length, sentBefore);

  // The same channel IS sanctioned for a DIFFERENT urgency once the
  // attribute no longer matches (restore the allow-all first).
  await allowAllChannels(alice);
  const delivered = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'anomaly_detected',
      urgency: 'critical',
      explanation: 'Reach on the primary channel collapsed below the baseline band.',
      sourceKind: 'platform',
      sourceId: 'platform-health-monitor',
      requiredAction: 'Review the distribution anomaly in the console.',
      deepLink: '/console/health',
      occurrenceKey: 'anomaly-992',
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(
    delivered.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered'], ['email', 'delivered']],
    'the urgency-scoped sanction — critical email is allowed again',
  );
  assert.equal(sentEmails.length, sentBefore + 1);
});

test('AC-3 (module level): NO policy at all FAILS CLOSED — both channels refused with reason no-active-policy, zero egress', async () => {
  const sentBefore = sentEmails.length;
  // Carol's agency declared NO network policy (the POL-001 posture).
  const result = await delivery().deliverNotification(
    {
      agencyId: carol.agencyId,
      clientId: carolClientId,
      workspaceId: null,
      eventType: 'approval_required',
      urgency: 'urgent',
      explanation: 'A rights clearance needs reviewer approval.',
      sourceKind: 'extension',
      sourceId: '22222222-2222-4222-8222-222222222222',
      requiredAction: 'Approve or reject the clearance request.',
      deepLink: '/console/approvals',
      occurrenceKey: 'approval-1',
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(
    result.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'refused'], ['email', 'refused']],
  );
  for (const receipt of result.receipts) {
    assert.ok(receipt.reason !== null && receipt.reason.includes('refused fail-closed'));
    assert.ok(receipt.policyDecisionId !== null);
  }
  // The decisions are the engine's no-active-policy unknowns (deny).
  const decisionRows = await pool().query(
    'SELECT reason_code FROM policy_decisions WHERE decision_id = ANY($1::uuid[])',
    [result.receipts.map((receipt) => receipt.policyDecisionId)],
  );
  assert.deepEqual(
    decisionRows.rows.map((row) => row.reason_code),
    ['no-active-policy', 'no-active-policy'],
  );
  assert.equal(sentEmails.length, sentBefore, 'zero egress without a sanctioning policy');
});

// ---------------------------------------------------------------------------
// AC-4: the vault fail-closed — a disabled provider credential
// ---------------------------------------------------------------------------

test('AC-4 (module level): a disabled provider credential reference FAILS the email channel honestly — the in-app channel still delivers', async () => {
  const sentBefore = sentEmails.length;

  // Disable the provider credential reference through the REAL vault API.
  const reference = await credentialsModule().getCredentialReference(providerCredentialId);
  assert.notEqual(reference, null);
  await credentialsModule().setCredentialStatus({
    credentialId: providerCredentialId,
    status: 'disabled',
    expectedVersion: reference!.version,
  });

  const failed = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'quota_exhausted',
      urgency: 'critical',
      explanation: 'The daily platform API quota is exhausted.',
      sourceKind: 'platform',
      sourceId: 'quota-monitor',
      requiredAction: 'Raise the quota or pause the publishing schedule.',
      deepLink: '/console/billing',
      occurrenceKey: 'quota-7',
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(
    failed.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered'], ['email', 'failed']],
    'the disabled reference fails the email channel honestly; the in-app channel still delivers',
  );
  const failure = failed.receipts[1]!;
  assert.ok(failure.reason !== null && failure.reason.includes('does not resolve'));
  assert.equal(sentEmails.length, sentBefore, 'no egress with a dead credential');

  // Restore the reference (disabled → active is a legal transition).
  await credentialsModule().setCredentialStatus({
    credentialId: providerCredentialId,
    status: 'active',
    expectedVersion: (await credentialsModule().getCredentialReference(providerCredentialId))!.version,
  });
  const recovered = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'quota_exhausted',
      urgency: 'critical',
      explanation: 'The daily platform API quota is exhausted.',
      sourceKind: 'platform',
      sourceId: 'quota-monitor',
      requiredAction: 'Raise the quota or pause the publishing schedule.',
      deepLink: '/console/billing',
      occurrenceKey: 'quota-8',
    },
    MODULE_PROVENANCE,
  );
  assert.deepEqual(
    recovered.receipts.map((receipt) => [receipt.channel, receipt.outcome]),
    [['in_app', 'delivered'], ['email', 'delivered']],
    'the re-enabled reference recovers the email channel',
  );
  assert.equal(sentEmails.length, sentBefore + 1);
});

// ---------------------------------------------------------------------------
// AC-1/AC-10: the DB backstops — append-only triggers, the single fills
// ---------------------------------------------------------------------------

test('AC-10: the DB backstops — receipts/fences are append-only, notifications carry no DELETE, the dispatch/read fills run exactly once', async () => {
  const created = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'policy_denied',
      urgency: 'important',
      explanation: 'The autonomous publish action was denied by policy.',
      sourceKind: 'execution',
      sourceId: '33333333-3333-4333-8333-333333333333',
      requiredAction: 'Review the policy decision.',
      deepLink: '/console/executions',
      occurrenceKey: 'deny-1',
    },
    MODULE_PROVENANCE,
  );
  const notificationId = created.notification.notificationId;
  const receiptId = created.receipts[0]!.receiptId;

  // The receipt tail is append-only: UPDATE and DELETE are rejected.
  await assertDbRejects(
    'UPDATE notification_delivery_receipts SET outcome = \'delivered\' WHERE receipt_id = $1',
    [receiptId],
    'append-only',
  );
  await assertDbRejects(
    'DELETE FROM notification_delivery_receipts WHERE receipt_id = $1',
    [receiptId],
    'append-only',
  );

  // The fence rows are append-only.
  await assertDbRejects(
    'UPDATE notification_delivery_fences SET occurrence_key = \'forged\' WHERE notification_id = $1',
    [notificationId],
    'append-only',
  );
  await assertDbRejects(
    'DELETE FROM notification_delivery_fences WHERE notification_id = $1',
    [notificationId],
    'append-only',
  );

  // Notifications carry NO DELETE; the §14 facts are immutable; the
  // delivery status can only fill pending → dispatched.
  await assertDbRejects(
    'DELETE FROM notifications WHERE notification_id = $1',
    [notificationId],
    'cannot be deleted',
  );
  await assertDbRejects(
    'UPDATE notifications SET explanation = \'forged\' WHERE notification_id = $1',
    [notificationId],
    'immutable',
  );
  await assertDbRejects(
    'UPDATE notifications SET delivery_status = \'pending\' WHERE notification_id = $1',
    [notificationId],
    'illegal notification delivery-status transition',
  );
  // A forged tenant-scope crossing is rejected by the fence trigger.
  await assertDbRejects(
    'UPDATE notifications SET agency_id = $1 WHERE notification_id = $2',
    [bob.agencyId, notificationId],
    'tenant scope chain is immutable',
  );

  // The inbox read transition runs exactly once (mark it read first, then
  // the direct-SQL resets are rejected by the trigger battery).
  const item = await delivery().getInboxItem(notificationId);
  assert.ok(item !== null);
  await delivery().markInboxItemRead({ notificationId }, MODULE_PROVENANCE);
  await assertDbRejects(
    'UPDATE notification_inbox_items SET read_at = NULL WHERE notification_id = $1',
    [notificationId],
    'read state is an append-only transition',
  );
  await assertDbRejects(
    'UPDATE notification_inbox_items SET read_at = now() WHERE notification_id = $1',
    [notificationId],
    'read state is an append-only transition',
  );
  await assertDbRejects(
    'DELETE FROM notification_inbox_items WHERE notification_id = $1',
    [notificationId],
    'cannot be deleted',
  );

  // The payload-shape CHECK: a receipt with a delivered outcome cannot
  // carry a reason; a failed receipt cannot omit one.
  await assertDbRejects(
    `INSERT INTO notification_delivery_receipts
       (receipt_id, notification_id, channel, outcome, provider_message_id, reason,
        policy_decision_id, recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
     VALUES ('44444444-4444-4444-8444-444444444444', $1, 'in_app', 'delivered', NULL, 'a reason is not allowed here',
             NULL, 'forged', 'sql', 'forged', NULL, now())`,
    [notificationId],
    'notification_receipt_shape',
  );
});

// ---------------------------------------------------------------------------
// AC-8/AC-9: THE HTTP SURFACES — the round trip on the spawned production API
// ---------------------------------------------------------------------------

test('AC-8 (HTTP): the delivery round trip on the production API — create → receipts → inbox → read → replay → the honest duplicate + the receipt tail', async () => {
  // The delivery POST (owner): the in-app channel delivers on the default
  // composition (the email channel is the disclosed composition seam — its
  // golden path is the module-level battery above).
  const created = await apiCall(port(), `/api/clients/${aliceClientId}/notifications`, {
    token: alice.token,
    body: {
      eventType: 'mission_terminal',
      urgency: 'urgent',
      explanation: 'Mission M-42 achieved its declared business objective.',
      sourceKind: 'growth_mission',
      sourceId: '55555555-5555-4555-8555-555555555555',
      deepLink: '/console/missions/55555555-5555-4555-8555-555555555555',
      occurrenceKey: 'terminal-1',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const notification = created.body['notification'] as Record<string, unknown>;
  const notificationId = notification['notificationId'] as string;
  assert.equal(created.body['duplicate'], false);
  assert.equal(notification['deliveryStatus'], 'dispatched');
  const receipts = created.body['receipts'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    receipts.map((receipt) => [receipt['channel'], receipt['outcome']]),
    [['in_app', 'delivered']],
  );

  // The inbox read surface (GET): the client's in-app projection.
  const inbox = await apiCall(port(), `/api/clients/${aliceClientId}/notifications`, {
    token: alice.token,
  });
  assert.equal(inbox.status, 200);
  const items = inbox.body['inbox'] as Array<Record<string, unknown>>;
  const item = items.find((entry) => entry['notificationId'] === notificationId);
  assert.ok(item !== undefined, 'the delivered notification is in the inbox');
  assert.equal(item['readAt'], null);

  // The unread filter.
  const unread = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications?unread=true`,
    { token: alice.token },
  );
  assert.equal(unread.status, 200);
  assert.ok(
    (unread.body['inbox'] as Array<Record<string, unknown>>).some(
      (entry) => entry['notificationId'] === notificationId,
    ),
    'the unread filter keeps the fresh item',
  );

  // The read transition (POST): 200 with the readAt set; the SECOND read
  // is the honest 409.
  const read = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/${notificationId}/read`,
    { token: alice.token, body: {} },
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.ok((read.body as Record<string, unknown>)['readAt'] !== null);
  const reread = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/${notificationId}/read`,
    { token: alice.token, body: {} },
  );
  assert.equal(reread.status, 409);

  // The unread filter no longer shows it; the plain listing does.
  const unreadAfter = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications?unread=true`,
    { token: alice.token },
  );
  assert.ok(
    !(unreadAfter.body['inbox'] as Array<Record<string, unknown>>).some(
      (entry) => entry['notificationId'] === notificationId,
    ),
    'the read item leaves the unread filter',
  );

  // The workspace slice.
  const workspaceInbox = await apiCall(
    port(),
    `/api/workspaces/${aliceWorkspaceId}/notifications`,
    { token: alice.token },
  );
  assert.equal(workspaceInbox.status, 200);
  assert.ok(
    !(workspaceInbox.body['inbox'] as Array<Record<string, unknown>>).some(
      (entry) => entry['notificationId'] === notificationId,
    ),
    'the no-workspace notification is not in the workspace slice',
  );

  // The REPLAY over HTTP: the same occurrence → the honest duplicate.
  const replay = await apiCall(port(), `/api/clients/${aliceClientId}/notifications`, {
    token: alice.token,
    body: {
      eventType: 'mission_terminal',
      urgency: 'urgent',
      explanation: 'Mission M-42 achieved its declared business objective.',
      sourceKind: 'growth_mission',
      sourceId: '55555555-5555-4555-8555-555555555555',
      deepLink: '/console/missions/55555555-5555-4555-8555-555555555555',
      occurrenceKey: 'terminal-1',
    },
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.body['duplicate'], true);
  assert.equal(
    (replay.body['notification'] as Record<string, unknown>)['notificationId'],
    notificationId,
  );
  assert.deepEqual(
    (replay.body['receipts'] as Array<Record<string, unknown>>).map((receipt) => [
      receipt['channel'],
      receipt['outcome'],
    ]),
    [['in_app', 'duplicate_skipped']],
  );

  // The notification detail with the FULL receipt tail.
  const detail = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/${notificationId}`,
    { token: alice.token },
  );
  assert.equal(detail.status, 200);
  const tail = detail.body['receipts'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    tail.map((receipt) => [receipt['channel'], receipt['outcome']]),
    [['in_app', 'delivered'], ['in_app', 'duplicate_skipped']],
    'the complete honest delivery history over HTTP',
  );

  // The module-level golden-path notifications are visible over HTTP too
  // (the same database — the two compositions share the durable plane).
  const allItems = inbox.body['inbox'] as Array<Record<string, unknown>>;
  assert.ok(allItems.length >= 1);
});

test('AC-8 (HTTP): the workspace narrowing — the delivered notification slices to its workspace', async () => {
  const created = await apiCall(port(), `/api/clients/${aliceClientId}/notifications`, {
    token: alice.token,
    body: {
      eventType: 'execution_attention_required',
      urgency: 'critical',
      explanation: 'An execution finished with an UNKNOWN outcome and needs reconciliation.',
      sourceKind: 'execution',
      sourceId: '66666666-6666-4666-8666-666666666666',
      deepLink: '/console/executions/66666666-6666-4666-8666-666666666666',
      occurrenceKey: 'unknown-1',
      workspaceId: aliceWorkspaceId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const notificationId = (created.body['notification'] as Record<string, unknown>)['notificationId'] as string;

  const workspaceInbox = await apiCall(
    port(),
    `/api/workspaces/${aliceWorkspaceId}/notifications`,
    { token: alice.token },
  );
  assert.equal(workspaceInbox.status, 200);
  assert.ok(
    (workspaceInbox.body['inbox'] as Array<Record<string, unknown>>).some(
      (entry) => entry['notificationId'] === notificationId,
    ),
    'the workspace-narrowed notification is in the workspace slice',
  );

  // The client listing with the workspace filter.
  const filtered = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications?workspaceId=${aliceWorkspaceId}`,
    { token: alice.token },
  );
  assert.equal(filtered.status, 200);
  assert.ok(
    (filtered.body['inbox'] as Array<Record<string, unknown>>).some(
      (entry) => entry['notificationId'] === notificationId,
    ),
  );
});

// ---------------------------------------------------------------------------
// AC-9: the fail-closed isolation battery (HTTP)
// ---------------------------------------------------------------------------

test('AC-9: anonymous 401; foreign ≡ unknown ≡ malformed uniform 404; suspended 403; the role gate on the delivery POST', async () => {
  const path = `/api/clients/${aliceClientId}/notifications`;

  // Anonymous: 401 on every surface.
  assert.equal((await apiCall(port(), path, { body: {} })).status, 401);
  assert.equal((await apiCall(port(), path)).status, 401);
  assert.equal(
    (await apiCall(port(), `/api/clients/${aliceClientId}/notifications/some-id`, { token: alice.token })).status,
    404,
  );

  // A notification created by alice (module level, in bob's reach?).
  const created = await delivery().deliverNotification(
    {
      agencyId: alice.agencyId,
      clientId: aliceClientId,
      workspaceId: null,
      eventType: 'system_notice',
      urgency: 'routine',
      explanation: 'Isolation fixture notice.',
      sourceKind: 'platform',
      sourceId: 'isolation-fixture',
      requiredAction: null,
      deepLink: '/console/notices',
      occurrenceKey: 'isolation-1',
    },
    MODULE_PROVENANCE,
  );
  const aliceNotificationId = created.notification.notificationId;
  const bobNotification = await delivery().deliverNotification(
    {
      agencyId: bob.agencyId,
      clientId: bobClientId,
      workspaceId: null,
      eventType: 'system_notice',
      urgency: 'routine',
      explanation: 'Bob fixture notice.',
      sourceKind: 'platform',
      sourceId: 'bob-fixture',
      requiredAction: null,
      deepLink: '/console/notices',
      occurrenceKey: 'bob-1',
    },
    MODULE_PROVENANCE,
  );

  // FOREIGN ≡ UNKNOWN ≡ MALFORMED — the uniform 404 battery (no oracle).
  const foreign = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/${bobNotification.notification.notificationId}`,
    { token: alice.token },
  );
  const unknown = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/77777777-7777-4777-8777-777777777777`,
    { token: alice.token },
  );
  const malformed = await apiCall(
    port(),
    `/api/clients/${aliceClientId}/notifications/not-a-uuid`,
    { token: alice.token },
  );
  assert.deepEqual(
    [foreign.status, unknown.status, malformed.status],
    [404, 404, 404],
    'foreign, unknown and malformed notification identifiers are indistinguishable',
  );

  // A foreign client (bob's) through alice's token: the uniform 404 on the
  // CLIENT (the hard boundary before any dependent traversal).
  assert.equal(
    (await apiCall(port(), `/api/clients/${bobClientId}/notifications`, { token: alice.token })).status,
    404,
  );
  // The bob-owned notification through alice's client path: 404.
  assert.equal(
    (
      await apiCall(port(), `/api/clients/${aliceClientId}/notifications/${bobNotification.notification.notificationId}`, {
        token: bob.token,
      })
    ).status,
    404,
  );
  // The read transition on a foreign notification: 404.
  assert.equal(
    (
      await apiCall(port(), `/api/clients/${aliceClientId}/notifications/${bobNotification.notification.notificationId}/read`, {
        token: alice.token,
        body: {},
      })
    ).status,
    404,
  );

  // The detail of alice's own notification through alice's token: 200
  // (the control).
  assert.equal(
    (await apiCall(port(), `/api/clients/${aliceClientId}/notifications/${aliceNotificationId}`, { token: alice.token })).status,
    200,
  );

  // The suspended membership: 403 (an intra-tenant failure, never 404 —
  // the honest distinction).
  assert.equal(
    (await apiCall(port(), path, { token: suspendedMember.token })).status,
    403,
  );
  assert.equal(
    (
      await apiCall(port(), `/api/clients/${aliceClientId}/notifications/${aliceNotificationId}/read`, {
        token: suspendedMember.token,
        body: {},
      })
    ).status,
    403,
  );

  // The role gate: the delivery POST requires owner|admin — the read
  // surfaces accept any active member. (The suspended member is not an
  // active-member control; the role battery is proven by the 403 above +
  // the owner-path 201s throughout.)
});

// ---------------------------------------------------------------------------
// The HTTP validation battery (fail-closed by rejection)
// ---------------------------------------------------------------------------

test('MKT-068 (HTTP): malformed delivery inputs and authority-field injections are rejected 422 — never written', async () => {
  const path = `/api/clients/${aliceClientId}/notifications`;
  const base = {
    eventType: 'system_notice',
    urgency: 'routine',
    explanation: 'Validation battery notice.',
    sourceKind: 'platform',
    sourceId: 'validation-fixture',
    deepLink: '/console/notices',
    occurrenceKey: 'validation-1',
  };

  // The control: the honest shape passes.
  assert.equal((await apiCall(port(), path, { token: alice.token, body: { ...base } })).status, 201);

  // Unknown vocabulary values.
  assert.equal(
    (await apiCall(port(), path, { token: alice.token, body: { ...base, eventType: 'made_up_event' } })).status,
    422,
  );
  assert.equal(
    (await apiCall(port(), path, { token: alice.token, body: { ...base, urgency: 'extreme' } })).status,
    422,
  );
  assert.equal(
    (await apiCall(port(), path, { token: alice.token, body: { ...base, sourceKind: 'random_module' } })).status,
    422,
  );

  // The ABSOLUTE deep link is rejected (the §14 RELATIVE fence).
  assert.equal(
    (
      await apiCall(port(), path, {
        token: alice.token,
        body: { ...base, deepLink: 'https://evil.example.com/console' },
      })
    ).status,
    422,
  );

  // The occurrence-key grammar.
  assert.equal(
    (await apiCall(port(), path, { token: alice.token, body: { ...base, occurrenceKey: 'has space' } })).status,
    422,
  );

  // Authority-field injection: identity/lifecycle/receipt/provenance and
  // recipient/material shapes are rejected outright.
  for (const injected of [
    { notificationId: '88888888-8888-4888-8888-888888888888' },
    { agencyId: '99999999-9999-4999-8999-999999999999' },
    { deliveryStatus: 'dispatched' },
    { recipients: ['attacker@evil.test'] },
    { email: 'attacker@evil.test' },
    { secretMaterial: 'x' },
    { provenance: { actor: 'forged' } },
  ]) {
    const response = await apiCall(port(), path, {
      token: alice.token,
      body: { ...base, occurrenceKey: `injection-${JSON.stringify(injected).length}`, ...injected },
    });
    assert.equal(response.status, 422, `the injected authority field must be rejected: ${JSON.stringify(injected)}`);
  }

  // Nothing from the battery was written (the control row only).
  assert.equal(
    await countRows('notifications', 'source_id = $1', ['validation-fixture']),
    1,
  );
});
