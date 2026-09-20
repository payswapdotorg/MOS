/**
 * MKT-068 integration tests — the Notification Delivery Plane surface on
 * the real stack (embedded PostgreSQL 18 + real API process — no mocks of
 * platform services; the module-level record commands are driven through
 * the SAME in-process application composed against the SAME database the
 * API serves — the MKT-034 sanctioned test-harness wiring, the
 * growth-missions precedent).
 *
 * The EMAIL PROVIDER TRANSPORT is the DISCLOSED deterministic in-repo
 * double (AC-7): the module-level application is composed with a
 * recording transport (NO real network calls anywhere in the suite), and
 * the SPAWNED API process uses the production-default disclosed
 * UnwiredEmailTransport — its honest 'not wired' failed receipts are
 * asserted end-to-end (the seam's production behavior).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-068; the
 * dispatch acceptance criteria AC-1..AC-11):
 *   - AC-8 ROUND-TRIP: create notification → policy gate → per-channel
 *     receipts → in-app read surface → replay the same event →
 *     duplicate-skipped receipt — through BOTH the module-level
 *     operations and the HTTP surfaces;
 *   - AC-1 RECORD MODEL: the full §14 field set round-trips verbatim;
 *     required action NULLABLE; delivery_status is the adapter-plane
 *     lifecycle (the DB battery pins the §14 immutability and the
 *     delivered-terminal transitions);
 *   - AC-2/AC-3 CHANNELS + GATES: the in-app and email golden paths; the
 *     acceptance-mismatch refusal (email + low urgency); the future
 *     capability key refused honestly (whatsapp); the policy-refusal
 *     battery (no-active-policy → unknown → fail-closed; explicit deny);
 *     the receipt carries the deciding policy decision id;
 *   - AC-4 CREDENTIALS: the email provider credential resolves through
 *     the /credentials vault (a REAL provisioned secret + reference);
 *     the credential-gate denial refuses BEFORE material resolution;
 *     an unresolved credential is the honest refused receipt;
 *   - AC-5 IDEMPOTENCY + RECEIPTS: the replay never double-delivers (the
 *     duplicate-skipped receipts reference the EXISTING notification;
 *     one record, one inbox row); the concurrent double-submit converges
 *     on the duplicate path; retries append NEW receipts (attempt
 *     sequences 1, 2, ... — never rewrites; the DB rejects UPDATE/DELETE
 *     on the receipt tail outright);
 *   - AC-6 IN-APP SURFACE: the inbox projection with read/unread state,
 *     the unread-only + client filters, the CAS read transition and the
 *     terminal reversal refusal;
 *   - AC-7 RECIPIENT RESOLUTION: the address resolves ONLY for an active
 *     member of the notification's agency (the double records the
 *     resolved canonical address; a non-member/unresolvable recipient is
 *     the honest refused receipt — never guessed);
 *   - AC-9 FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed
 *     agency/notification identifiers are the UNIFORM 404; a suspended
 *     membership is the 403; the forged cross-tenant fence key is the
 *     uniform 404; every PUT/PATCH/DELETE verb 405s at the router.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
import { bootstrapApplication } from '../../src/composition-root.ts';
import type {
  EmailTransport,
  NotificationChannel,
  NotificationDeliveryModuleApi,
  NotificationEventType,
  NotificationUrgency,
} from '../../src/modules/notification-delivery/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SECRET_HANDLE = 'mkt068-email-provider';
const SECRET_MATERIAL = 'prov-credential-material-0123456789';

// ---------------------------------------------------------------------------
// The DETERMINISTIC email provider transport double (AC-7 — in-repo, no
// network; records the resolved address + the rendered message + the
// material BYTE LENGTH only — never material content)
// ---------------------------------------------------------------------------

interface RecordedSend {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly materialBytes: number;
}

class RecordingEmailTransport implements EmailTransport {
  readonly sends: RecordedSend[] = [];
  private nextMessageId = 0;
  private failReason: string | null = null;

  failNextSend(reason: string): void {
    this.failReason = reason;
  }

  async send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly credentialMaterial: Uint8Array;
  }): Promise<{
    readonly outcome: 'sent' | 'failed';
    readonly providerMessageId: string | null;
    readonly reason: string | null;
  }> {
    if (this.failReason !== null) {
      const reason = this.failReason;
      this.failReason = null;
      return { outcome: 'failed', providerMessageId: null, reason };
    }
    this.nextMessageId += 1;
    this.sends.push({
      to: input.to,
      subject: input.subject,
      body: input.body,
      materialBytes: input.credentialMaterial.byteLength,
    });
    return { outcome: 'sent', providerMessageId: `prov-msg-${this.nextMessageId}`, reason: null };
  }
}

const transport = new RecordingEmailTransport();

// ---------------------------------------------------------------------------
// Stack boot
// ---------------------------------------------------------------------------

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let delivery: NotificationDeliveryModuleApi | null = null;

function module_(): NotificationDeliveryModuleApi {
  if (delivery === null) throw new Error('application not bootstrapped');
  return delivery;
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
  actor: 'service:notification-delivery-integration',
  recordedVia: 'module',
  correlationId: 'integration-notification-delivery-1',
  causationId: null,
} as const;

before(async () => {
  stack = await bootStack('notification_delivery');
  // Provision the email provider secret out-of-band (deployment-style:
  // a mounted file — the credentials-security precedent).
  fs.writeFileSync(
    path.join(stack.env.secretsDir, `${SECRET_HANDLE}.secret`),
    SECRET_MATERIAL,
    { mode: 0o600 },
  );
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/growth-missions
  // precedent): the SAME application composed IN-PROCESS against the
  // SAME database the API serves — with the DISCLOSED deterministic
  // email transport double (the spawned API process keeps the
  // production-default UnwiredEmailTransport; both behaviors asserted).
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication({ emailTransport: transport });
  delivery = core.modules.notificationDelivery;
});

after(async () => {
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
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

async function makeAgencyOwner(email: string): Promise<Principal> {
  const admin = await adminToken();
  const created = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const userId = created.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: 'owner-password-123' },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: 'owner-password-123' },
  });
  assert.equal(login.status, 200);
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId, token: login.body['token'] as string, agencyId };
}

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

/** Declares an AGENCY policy version allowing every operation on a dimension. */
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

/** Declares an AGENCY policy version DENYING every operation on a dimension. */
async function denyAll(principal: Principal, dimension: 'network' | 'secrets'): Promise<void> {
  const declared = await apiCall(port(), `/api/agencies/${principal.agencyId}/policies`, {
    token: principal.token,
    body: {
      dimension,
      rules: [{ effect: 'deny', operations: ['*'], reason: 'integration test denial' }],
      description: `Integration test ${dimension} denial`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

/** Creates the email provider credential reference (a REAL provisioned secret). */
async function makeEmailCredential(principal: Principal): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${principal.agencyId}/credentials`, {
    token: principal.token,
    body: { kind: 'email_provider', label: `Email provider ${randomUUID().slice(0, 8)}`, secretHandle: SECRET_HANDLE },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['credentialId'] as string;
}

function occurrenceInput(principal: Principal, overrides: {
  readonly eventType?: NotificationEventType;
  readonly urgency?: NotificationUrgency;
  readonly channels?: readonly NotificationChannel[];
  readonly occurrenceKey?: string;
  readonly sourceId?: string;
  readonly clientId?: string | null;
  readonly requiredAction?: string | null;
  readonly recipientUserId?: string | null;
  readonly emailCredentialReferenceId?: string | null;
} = {}) {
  return {
    agencyId: principal.agencyId,
    clientId: overrides.clientId ?? null,
    workspaceId: null,
    eventType: overrides.eventType ?? 'mission.state_changed',
    urgency: overrides.urgency ?? 'high',
    explanation: 'The growth mission requires attention: a human-required blocker was recorded.',
    source: { kind: 'mission' as const, id: overrides.sourceId ?? randomUUID() },
    occurrenceKey: overrides.occurrenceKey ?? `occ-${randomUUID()}`,
    requiredAction: overrides.requiredAction ?? 'Review the blocker and resume the mission.',
    deepLink: '/console/missions/blocker',
    channels: overrides.channels ?? (['in-app'] as const),
    recipientUserId: overrides.recipientUserId ?? null,
    emailCredentialReferenceId: overrides.emailCredentialReferenceId ?? null,
  };
}

// ---------------------------------------------------------------------------
// AC-8: the ROUND-TRIP (module-level + HTTP) — the golden path per channel
// ---------------------------------------------------------------------------

test('AC-8 (module-level): the in-app round-trip — create → gate → receipts → read surface', async () => {
  const owner = await makeAgencyOwner('nd-owner-inapp@marketingos.test');
  await allowAll(owner, 'network');

  const result = await module_().recordNotification(
    occurrenceInput(owner, { requiredAction: 'Approve the mission budget.' }),
    MODULE_PROVENANCE,
  );
  assert.equal(result.duplicate, false);
  assert.equal(result.notification.deliveryStatus, 'delivered', 'single in-app channel delivered');
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.channel, 'in-app');
  assert.equal(result.receipts[0]!.outcome, 'delivered');
  assert.equal(result.receipts[0]!.attemptSeq, 1);

  // The §14 field set round-trips verbatim (AC-1).
  assert.equal(result.notification.eventType, 'mission.state_changed');
  assert.equal(result.notification.urgency, 'high');
  assert.equal(result.notification.requiredAction, 'Approve the mission budget.');
  assert.equal(result.notification.source.kind, 'mission');
  assert.equal(result.notification.deepLink, '/console/missions/blocker');

  // The in-app read surface (AC-6): born unread; the read transition is
  // terminal.
  const before = await module_().getInboxEntry(result.notification.notificationId);
  assert.ok(before !== null);
  assert.equal(before.readStatus, 'unread');
  assert.equal(before.explanation, result.notification.explanation);
  const read = await module_().markInboxRead(
    { notificationId: result.notification.notificationId, expectedVersion: before.version },
    MODULE_PROVENANCE,
  );
  assert.equal(read.readStatus, 'read');
  assert.ok(read.readAt !== null);
  assert.equal(read.readByActor, MODULE_PROVENANCE.actor);
});

test('AC-8 (HTTP): the in-app round-trip — POST → receipts → inbox → read', async () => {
  const owner = await makeAgencyOwner('nd-owner-http@marketingos.test');
  await allowAll(owner, 'network');

  const sourceId = randomUUID();
  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
    token: owner.token,
    body: {
      eventType: 'execution.unknown_outcome',
      urgency: 'critical',
      explanation: 'The execution outcome is UNKNOWN and requires reconciliation.',
      sourceKind: 'execution',
      sourceId,
      occurrenceKey: 'http-occ-1',
      requiredAction: 'Reconcile the execution outcome.',
      deepLink: '/console/executions/x',
      channels: ['in-app'],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const notification = created.body['notification'] as Record<string, unknown>;
  assert.equal(notification['deliveryStatus'], 'delivered');
  assert.equal(notification['requiredAction'], 'Reconcile the execution outcome.');
  const receipts = created.body['receipts'] as Record<string, unknown>[];
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!['outcome'], 'delivered');
  const notificationId = notification['notificationId'] as string;

  // The receipt tail read.
  const tail = await apiCall(
    port(),
    `/api/agencies/${owner.agencyId}/notification-delivery/${notificationId}/receipts`,
    { token: owner.token },
  );
  assert.equal(tail.status, 200);
  assert.equal((tail.body['receipts'] as unknown[]).length, 1);

  // The inbox surface: unread, then read via the CAS transition.
  const inbox = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-inbox`, {
    token: owner.token,
  });
  assert.equal(inbox.status, 200);
  const entries = inbox.body['entries'] as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!['readStatus'], 'unread');
  const entryVersion = entries[0]!['version'] as number;

  const read = await apiCall(
    port(),
    `/api/agencies/${owner.agencyId}/notification-inbox/${notificationId}/read`,
    { token: owner.token, body: { expectedVersion: entryVersion } },
  );
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body['readStatus'], 'read');

  // The replay over HTTP: the same occurrence → duplicate-skipped receipts.
  const replay = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
    token: owner.token,
    body: {
      eventType: 'execution.unknown_outcome',
      urgency: 'critical',
      explanation: 'The execution outcome is UNKNOWN and requires reconciliation.',
      sourceKind: 'execution',
      sourceId,
      occurrenceKey: 'http-occ-1',
      deepLink: '/console/executions/x',
      channels: ['in-app'],
    },
  });
  assert.equal(replay.status, 200, 'the replay answers 200 (not a second creation)');
  assert.equal(replay.body['duplicate'], true);
  assert.equal((replay.body['notification'] as Record<string, unknown>)['notificationId'], notificationId);
  const replayReceipts = replay.body['receipts'] as Record<string, unknown>[];
  assert.equal(replayReceipts.length, 1);
  assert.equal(replayReceipts[0]!['outcome'], 'duplicate_skipped');

  // The agency list shows exactly ONE notification for the occurrence.
  const list = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
    token: owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal((list.body['notifications'] as unknown[]).length, 1);

  // The inbox still holds exactly ONE row (never a second delivery).
  const inboxAfter = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-inbox`, {
    token: owner.token,
  });
  assert.equal((inboxAfter.body['entries'] as unknown[]).length, 1);
});

test('AC-8 (module-level): the email golden path — recipient resolution, vault credential, transport double', async () => {
  const owner = await makeAgencyOwner('nd-owner-email@marketingos.test');
  await allowAll(owner, 'network');
  await allowAll(owner, 'secrets');
  const credentialId = await makeEmailCredential(owner);
  const sendsBefore = transport.sends.length;

  const result = await module_().recordNotification(
    occurrenceInput(owner, {
      channels: ['in-app', 'email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credentialId,
    }),
    MODULE_PROVENANCE,
  );
  assert.equal(result.duplicate, false);
  assert.equal(result.notification.deliveryStatus, 'delivered', 'both channels delivered');
  assert.equal(result.receipts.length, 2);
  const emailReceipt = result.receipts.find((receipt) => receipt.channel === 'email')!;
  assert.equal(emailReceipt.outcome, 'delivered');
  assert.ok(emailReceipt.providerMessageId !== null, 'the provider message id lands on the receipt');
  assert.equal(emailReceipt.attemptSeq, 1);

  // The double recorded EXACTLY one send to the canonical address of the
  // ACTIVE agency member (AC-7) — with the deterministic render.
  assert.equal(transport.sends.length, sendsBefore + 1);
  const send = transport.sends[transport.sends.length - 1]!;
  assert.ok(send.to.endsWith('@marketingos.test'));
  assert.ok(send.subject.includes('[high]'));
  assert.ok(send.subject.includes('mission.state_changed'));
  assert.ok(send.body.includes('Review the blocker and resume the mission.'));
  assert.ok(send.body.includes('/console/missions/blocker'));
  assert.equal(send.materialBytes, Buffer.byteLength(SECRET_MATERIAL), 'the REAL vault material reached the seam in-process');
});

test('AC-7 (production posture): the spawned API email attempts honestly FAIL with the unwired transport', async () => {
  const owner = await makeAgencyOwner('nd-owner-unwired@marketingos.test');
  await allowAll(owner, 'network');
  await allowAll(owner, 'secrets');
  const credentialId = await makeEmailCredential(owner);

  const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
    token: owner.token,
    body: {
      eventType: 'execution.failed',
      urgency: 'high',
      explanation: 'An execution failed and the operator should look.',
      sourceKind: 'execution',
      sourceId: randomUUID(),
      occurrenceKey: 'unwired-occ-1',
      deepLink: '/console/executions/y',
      channels: ['in-app', 'email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credentialId,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const receipts = created.body['receipts'] as Record<string, unknown>[];
  const inApp = receipts.find((receipt) => receipt['channel'] === 'in-app')!;
  const email = receipts.find((receipt) => receipt['channel'] === 'email')!;
  assert.equal(inApp['outcome'], 'delivered', 'in-app needs no provider');
  assert.equal(email['outcome'], 'failed', 'the disclosed unwired transport honestly fails');
  const reason = email['reason'] as string;
  assert.ok(reason.includes('not wired'), `the reason discloses the seam (got: ${reason})`);
  assert.equal((created.body['notification'] as Record<string, unknown>)['deliveryStatus'], 'partial');
});

// ---------------------------------------------------------------------------
// AC-2/AC-3: the channel battery (acceptance, future keys, policy refusals)
// ---------------------------------------------------------------------------

test('AC-2/AC-3: the acceptance mismatch refuses the email channel for low urgency (fail-closed receipt)', async () => {
  const owner = await makeAgencyOwner('nd-owner-accept@marketingos.test');
  await allowAll(owner, 'network');
  await allowAll(owner, 'secrets');
  const credentialId = await makeEmailCredential(owner);

  const result = await module_().recordNotification(
    occurrenceInput(owner, {
      urgency: 'low',
      channels: ['in-app', 'email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credentialId,
    }),
    MODULE_PROVENANCE,
  );
  const inApp = result.receipts.find((receipt) => receipt.channel === 'in-app')!;
  const email = result.receipts.find((receipt) => receipt.channel === 'email')!;
  assert.equal(inApp.outcome, 'delivered', 'the in-app channel accepts low urgency');
  assert.equal(email.outcome, 'refused');
  assert.ok(email.reason !== null && email.reason.includes("urgency 'low'"));
  assert.equal(result.notification.deliveryStatus, 'partial');
});

test('AC-2: the future capability keys are declared-but-unimplemented — refused honestly, never dropped', async () => {
  const owner = await makeAgencyOwner('nd-owner-future@marketingos.test');
  await allowAll(owner, 'network');

  const result = await module_().recordNotification(
    occurrenceInput(owner, { channels: ['in-app', 'whatsapp'] }),
    MODULE_PROVENANCE,
  );
  const whatsapp = result.receipts.find((receipt) => receipt.channel === 'whatsapp')!;
  assert.equal(whatsapp.outcome, 'refused');
  assert.ok(whatsapp.reason !== null && whatsapp.reason.includes('no delivery adapter is registered'));
  assert.equal(result.notification.deliveryStatus, 'partial');
});

test('AC-3: no active policy → unknown → the channel is refused fail-closed with the decision id', async () => {
  // A FRESH agency with NO policy declared anywhere: the fail-closed
  // posture refuses the channel delivery (never a silent drop).
  const owner = await makeAgencyOwner('nd-owner-nopolicy@marketingos.test');

  const result = await module_().recordNotification(
    occurrenceInput(owner),
    MODULE_PROVENANCE,
  );
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0]!.outcome, 'refused');
  assert.ok(result.receipts[0]!.policyDecisionId !== null, 'the refusal receipt carries the deciding policy decision id');
  assert.ok(result.receipts[0]!.reason !== null && result.receipts[0]!.reason.includes('policy denied'));
  assert.equal(result.notification.deliveryStatus, 'undelivered');
  // No inbox row exists (the in-app channel never delivered).
  assert.equal(await module_().getInboxEntry(result.notification.notificationId), null);
});

test('AC-3: an explicit deny rule refuses the channel (the recorded decision is traceable)', async () => {
  const owner = await makeAgencyOwner('nd-owner-deny@marketingos.test');
  await denyAll(owner, 'network');

  const result = await module_().recordNotification(
    occurrenceInput(owner),
    MODULE_PROVENANCE,
  );
  assert.equal(result.receipts[0]!.outcome, 'refused');
  assert.ok(result.receipts[0]!.policyDecisionId !== null);
  assert.equal(result.notification.deliveryStatus, 'undelivered');

  // The decision id traces into the /policies decision ledger.
  const decisionId = result.receipts[0]!.policyDecisionId!;
  const ledger = await pool().query(
    'SELECT outcome, reason_code FROM policy_decisions WHERE decision_id = $1',
    [decisionId],
  );
  assert.equal(ledger.rows.length, 1);
  assert.equal(ledger.rows[0]!.outcome, 'deny');
});

test('AC-4: the credential-gate denial refuses BEFORE material resolution; dangling references never persist', async () => {
  const owner = await makeAgencyOwner('nd-owner-cred@marketingos.test');
  await allowAll(owner, 'network');
  // NOTE: NO secrets-dimension allowance — the credential gate must deny.
  const credentialId = await makeEmailCredential(owner);
  const sendsBefore = transport.sends.length;

  const denied = await module_().recordNotification(
    occurrenceInput(owner, {
      channels: ['email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credentialId,
    }),
    MODULE_PROVENANCE,
  );
  const email = denied.receipts.find((receipt) => receipt.channel === 'email')!;
  assert.equal(email.outcome, 'refused');
  assert.ok(email.reason !== null && email.reason.includes('policy denied the email credential use'));
  assert.ok(email.policyDecisionId !== null, 'the credential-gate refusal carries the decision id');
  assert.equal(transport.sends.length, sendsBefore, 'NO send happened — material was never resolved');

  // A DANGLING credential reference is REJECTED at creation (the uniform
  // 404, never persisted — the migration-047 FK + the goal-mappings
  // precedent: no orphan references); the record battery stays clean.
  await assert.rejects(
    () =>
      module_().recordNotification(
        occurrenceInput(owner, {
          channels: ['email'],
          recipientUserId: owner.userId,
          emailCredentialReferenceId: randomUUID(),
        }),
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('not found'),
    'the dangling credential reference is the uniform 404',
  );
  const recordsAfterDangling = await module_().listNotificationsForAgency({
    agencyId: owner.agencyId,
    clientId: null,
  });
  assert.equal(recordsAfterDangling.length, 1, 'only the gate-denied record exists — nothing dangling persisted');

  // A credential that stops resolving AFTER the record was born (disabled
  // through the vault): the retry surfaces the honest refused receipt.
  await allowAll(owner, 'secrets');
  const credential2 = await makeEmailCredential(owner);
  const delivered = await module_().recordNotification(
    occurrenceInput(owner, {
      channels: ['in-app', 'email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credential2,
    }),
    MODULE_PROVENANCE,
  );
  assert.equal(delivered.notification.deliveryStatus, 'delivered');
  // Disable the credential through the vault API (READ-ONLY consumption
  // from the delivery plane — the vault stays the mutation authority).
  const disabled = await apiCall(
    port(),
    `/api/credentials/${credential2}/status`,
    { token: owner.token, method: 'PATCH', body: { status: 'disabled', version: 1 } },
  );
  assert.ok(disabled.status === 200, JSON.stringify(disabled.body));
  const retried = await module_().redeliverChannel(
    { notificationId: delivered.notification.notificationId, channel: 'email' },
    MODULE_PROVENANCE,
  ).catch((error: unknown) => {
    // A delivered notification refuses retries (terminal) — the
    // unresolvability battery runs through a FRESH record instead.
    assert.ok(error instanceof Error && error.message.includes('delivered'));
    return null;
  });
  if (retried === null) {
    // The fresh record with the disabled credential: the honest refused
    // receipt (the vault resolution returns null — fail-closed).
    const refused = await module_().recordNotification(
      occurrenceInput(owner, {
        channels: ['email'],
        recipientUserId: owner.userId,
        emailCredentialReferenceId: credential2,
      }),
      MODULE_PROVENANCE,
    );
    const emailRefused = refused.receipts.find((receipt) => receipt.channel === 'email')!;
    assert.equal(emailRefused.outcome, 'refused');
    assert.ok(
      emailRefused.reason !== null &&
        (emailRefused.reason.includes('does not resolve') ||
          emailRefused.reason.includes('policy denied')),
      'the disabled credential refuses the delivery honestly (vault resolution or the credential gate — both fail-closed)',
    );
  }
  assert.equal(transport.sends.length, sendsBefore + 1, 'exactly ONE real send happened in this test (the golden record)');
});

test('AC-7: a recipient who is not an active member of the agency is refused (no address guessing)', async () => {
  const owner = await makeAgencyOwner('nd-owner-recipient@marketingos.test');
  const outsider = await makeAgencyOwner('nd-outsider-recipient@marketingos.test');
  await allowAll(owner, 'network');
  await allowAll(owner, 'secrets');
  const credentialId = await makeEmailCredential(owner);
  const sendsBefore = transport.sends.length;

  // The OUTSIDER's user id as the recipient: not a member of the
  // notification's agency → the address does not resolve → refused.
  const result = await module_().recordNotification(
    occurrenceInput(owner, {
      channels: ['email'],
      recipientUserId: outsider.userId,
      emailCredentialReferenceId: credentialId,
    }),
    MODULE_PROVENANCE,
  );
  const email = result.receipts.find((receipt) => receipt.channel === 'email')!;
  assert.equal(email.outcome, 'refused');
  assert.ok(email.reason !== null && email.reason.includes('does not resolve to an active member address'));
  assert.equal(transport.sends.length, sendsBefore, 'no send to an unresolvable recipient');
});

// ---------------------------------------------------------------------------
// AC-5: idempotency + the append-only receipt history
// ---------------------------------------------------------------------------

test('AC-5: the replayed occurrence never double-delivers (one record, one inbox row, duplicate-skipped receipts)', async () => {
  const owner = await makeAgencyOwner('nd-owner-replay@marketingos.test');
  await allowAll(owner, 'network');
  const sourceId = randomUUID();

  const first = await module_().recordNotification(
    occurrenceInput(owner, { sourceId, occurrenceKey: 'replay-occ-1' }),
    MODULE_PROVENANCE,
  );
  assert.equal(first.duplicate, false);

  const second = await module_().recordNotification(
    occurrenceInput(owner, { sourceId, occurrenceKey: 'replay-occ-1' }),
    MODULE_PROVENANCE,
  );
  assert.equal(second.duplicate, true);
  assert.equal(second.notification.notificationId, first.notification.notificationId);
  assert.equal(second.receipts.length, 1);
  assert.equal(second.receipts[0]!.outcome, 'duplicate_skipped');
  assert.equal(second.receipts[0]!.channel, 'in-app');
  assert.equal(second.receipts[0]!.attemptSeq, 2, 'the skip receipt carries the next attempt sequence');

  // The DIFFERENT occurrence of the SAME source+event is a NEW notification.
  const third = await module_().recordNotification(
    occurrenceInput(owner, { sourceId, occurrenceKey: 'replay-occ-2' }),
    MODULE_PROVENANCE,
  );
  assert.equal(third.duplicate, false);
  assert.notEqual(third.notification.notificationId, first.notification.notificationId);

  // Exactly TWO records and TWO inbox rows exist for the agency.
  const records = await module_().listNotificationsForAgency({ agencyId: owner.agencyId, clientId: null });
  assert.equal(records.length, 2);
  const inbox = await module_().listInbox({ agencyId: owner.agencyId, clientId: null, unreadOnly: false });
  assert.equal(inbox.length, 2);

  // The receipt tail is complete: first fan-out + replay skip + second
  // fan-out — in attempt order, nothing rewritten.
  const tail = await module_().listReceipts(first.notification.notificationId);
  assert.equal(tail.length, 2);
  assert.equal(tail[0]!.outcome, 'delivered');
  assert.equal(tail[1]!.outcome, 'duplicate_skipped');
});

test('AC-5: the concurrent double-submit converges on the duplicate path (the DB fence backstops the race)', async () => {
  const owner = await makeAgencyOwner('nd-owner-race@marketingos.test');
  await allowAll(owner, 'network');
  const sourceId = randomUUID();
  const input = occurrenceInput(owner, { sourceId, occurrenceKey: 'race-occ-1' });

  const [a, b] = await Promise.all([
    module_().recordNotification(input, MODULE_PROVENANCE),
    module_().recordNotification(input, MODULE_PROVENANCE),
  ]);
  // Exactly ONE real creation and ONE duplicate convergence (either side).
  const duplicates = [a, b].filter((result) => result.duplicate).length;
  assert.equal(duplicates, 1, `exactly one of the concurrent submits is the duplicate (got ${duplicates})`);
  assert.equal(a.notification.notificationId, b.notification.notificationId, 'both converge on the SAME notification');
  const records = await module_().listNotificationsForAgency({ agencyId: owner.agencyId, clientId: null });
  assert.equal(records.length, 1, 'exactly ONE notification record exists');
  const inbox = await module_().listInbox({ agencyId: owner.agencyId, clientId: null, unreadOnly: false });
  assert.equal(inbox.length, 1, 'exactly ONE inbox row exists (never a double delivery)');
});

test('AC-5: retries append NEW receipts (attempt sequences advance, the history is never rewritten)', async () => {
  const owner = await makeAgencyOwner('nd-owner-retry@marketingos.test');
  await allowAll(owner, 'network');
  await allowAll(owner, 'secrets');
  const credentialId = await makeEmailCredential(owner);

  // Force a provider failure on the first email attempt.
  transport.failNextSend('provider 500 (deterministic failure)');
  const first = await module_().recordNotification(
    occurrenceInput(owner, {
      channels: ['in-app', 'email'],
      recipientUserId: owner.userId,
      emailCredentialReferenceId: credentialId,
    }),
    MODULE_PROVENANCE,
  );
  assert.equal(first.notification.deliveryStatus, 'partial');
  const emailReceipt = first.receipts.find((receipt) => receipt.channel === 'email')!;
  assert.equal(emailReceipt.outcome, 'failed');
  assert.ok(emailReceipt.reason !== null && emailReceipt.reason.includes('provider 500'));

  // The retry: a NEW receipt (attempt 2) on the same channel — the failed
  // attempt history stays byte-identical.
  const failedReceiptId = emailReceipt.receiptId;
  const retried = await module_().redeliverChannel(
    { notificationId: first.notification.notificationId, channel: 'email' },
    MODULE_PROVENANCE,
  );
  assert.equal(retried.receipts.length, 1);
  assert.equal(retried.receipts[0]!.attemptSeq, 2, 'the retry is attempt 2');
  assert.equal(retried.receipts[0]!.outcome, 'delivered');
  assert.ok(retried.receipts[0]!.providerMessageId !== null);
  assert.equal(retried.notification.deliveryStatus, 'delivered', 'the retry converged the record');

  const tail = await module_().listReceipts(first.notification.notificationId);
  assert.equal(tail.length, 3, 'in-app + email attempt 1 + email retry');
  const failedRow = tail.find((receipt) => receipt.receiptId === failedReceiptId)!;
  assert.equal(failedRow.outcome, 'failed', 'the failed attempt is still there — never rewritten');
  assert.equal(failedRow.reason, emailReceipt.reason, 'the recorded failure reason is immutable');

  // A retry on a delivered channel is refused (the recorded history is
  // immutable fact; delivered is terminal).
  await assert.rejects(
    () =>
      module_().redeliverChannel(
        { notificationId: first.notification.notificationId, channel: 'email' },
        MODULE_PROVENANCE,
      ),
    (error: unknown) =>
      error instanceof Error && error.message.includes('delivered'),
    'a retry on a delivered notification/channel is refused',
  );
});

test('AC-5/AC-10 (DB battery): the append-only and immutability fences reject direct SQL mutations', async () => {
  const owner = await makeAgencyOwner('nd-owner-db@marketingos.test');
  await allowAll(owner, 'network');
  const result = await module_().recordNotification(
    occurrenceInput(owner),
    MODULE_PROVENANCE,
  );
  const notificationId = result.notification.notificationId;
  const receiptId = result.receipts[0]!.receiptId;

  const rejects = async (label: string, sql: string): Promise<void> => {
    await assert.rejects(
      () => pool().query(sql),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && error.message.length > 0,
          `${label} must be rejected by the database`,
        );
        return true;
      },
      label,
    );
  };

  await rejects('receipt UPDATE', `UPDATE notification_delivery_receipts SET outcome = 'delivered' WHERE receipt_id = '${receiptId}'`);
  await rejects('receipt DELETE', `DELETE FROM notification_delivery_receipts WHERE receipt_id = '${receiptId}'`);
  await rejects('fence UPDATE', `UPDATE notification_delivery_dedup_fence SET occurrence_key = 'forged' WHERE notification_id = '${notificationId}'`);
  await rejects('fence DELETE', `DELETE FROM notification_delivery_dedup_fence WHERE notification_id = '${notificationId}'`);
  await rejects('§14 rewrite', `UPDATE notification_records SET explanation = 'rewritten' WHERE notification_id = '${notificationId}'`);
  await rejects('channel-set rewrite', `UPDATE notification_records SET requested_channels = '["email"]'::jsonb WHERE notification_id = '${notificationId}'`);
  await rejects('record DELETE', `DELETE FROM notification_records WHERE notification_id = '${notificationId}'`);
  await rejects('inbox DELETE', `DELETE FROM notification_inbox_states WHERE notification_id = '${notificationId}'`);

  // The read transition works exactly once; the reversal is rejected.
  const entry = await module_().getInboxEntry(notificationId);
  assert.ok(entry !== null);
  await pool().query(
    `UPDATE notification_inbox_states SET read_status = 'read', read_at = now(), read_by_actor = 'user:t', version = version + 1, updated_at = now() WHERE notification_id = '${notificationId}'`,
  );
  await rejects(
    'inbox read reversal',
    `UPDATE notification_inbox_states SET read_status = 'unread', read_at = NULL, read_by_actor = NULL WHERE notification_id = '${notificationId}'`,
  );

  // The delivered-terminal transition is rejected.
  await pool().query(
    `UPDATE notification_records SET delivery_status = 'delivered', version = version + 1, updated_at = now() WHERE notification_id = '${notificationId}'`,
  );
  await rejects(
    'delivered regression',
    `UPDATE notification_records SET delivery_status = 'partial', version = version + 1 WHERE notification_id = '${notificationId}'`,
  );
});

// ---------------------------------------------------------------------------
// AC-6: the in-app read surface (filters + CAS)
// ---------------------------------------------------------------------------

test('AC-6: the inbox surface honors the client narrowing + unread-only filters and the CAS read transition', async () => {
  const owner = await makeAgencyOwner('nd-owner-inbox@marketingos.test');
  await allowAll(owner, 'network');
  const clientA = await makeClient(owner.agencyId, owner.token, 'Inbox Client A');
  const clientB = await makeClient(owner.agencyId, owner.token, 'Inbox Client B');

  const inClientA = await module_().recordNotification(
    occurrenceInput(owner, { clientId: clientA }),
    MODULE_PROVENANCE,
  );
  await module_().recordNotification(
    occurrenceInput(owner, { clientId: clientB }),
    MODULE_PROVENANCE,
  );
  await module_().recordNotification(
    occurrenceInput(owner, { clientId: null }),
    MODULE_PROVENANCE,
  );

  // The client narrowing.
  const clientAInbox = await module_().listInbox({ agencyId: owner.agencyId, clientId: clientA, unreadOnly: false });
  assert.equal(clientAInbox.length, 1);
  assert.equal(clientAInbox[0]!.notificationId, inClientA.notification.notificationId);
  assert.equal(clientAInbox[0]!.clientId, clientA);

  // The unread-only filter.
  const allUnread = await module_().listInbox({ agencyId: owner.agencyId, clientId: null, unreadOnly: true });
  assert.equal(allUnread.length, 3);
  await module_().markInboxRead(
    { notificationId: inClientA.notification.notificationId, expectedVersion: allUnread.find((e) => e.notificationId === inClientA.notification.notificationId)!.version },
    MODULE_PROVENANCE,
  );
  const afterRead = await module_().listInbox({ agencyId: owner.agencyId, clientId: null, unreadOnly: true });
  assert.equal(afterRead.length, 2);

  // The CAS failure (stale version) is the honest conflict.
  await assert.rejects(
    () =>
      module_().markInboxRead(
        { notificationId: inClientA.notification.notificationId, expectedVersion: 1 },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && (error.message.includes('already read') || error.message.includes('superseded')),
  );

  // The terminal reversal is refused over the module surface too.
  const readEntry = await module_().getInboxEntry(inClientA.notification.notificationId);
  assert.equal(readEntry!.readStatus, 'read');
  await assert.rejects(
    () =>
      module_().markInboxRead(
        { notificationId: inClientA.notification.notificationId, expectedVersion: readEntry!.version },
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('already read'),
  );
});

// ---------------------------------------------------------------------------
// AC-9: the fail-closed isolation battery
// ---------------------------------------------------------------------------

test('AC-9: anonymous 401, uniform 404 for foreign/unknown/malformed, suspended 403, and 405 for the non-GET/POST verbs', async () => {
  const ownerA = await makeAgencyOwner('nd-owner-iso-a@marketingos.test');
  const ownerB = await makeAgencyOwner('nd-owner-iso-b@marketingos.test');
  await allowAll(ownerA, 'network');
  const created = await module_().recordNotification(
    occurrenceInput(ownerA),
    MODULE_PROVENANCE,
  );
  const notificationId = created.notification.notificationId;

  // Anonymous: 401 on every route of the family.
  for (const pathName of [
    `/api/agencies/${ownerA.agencyId}/notification-delivery`,
    `/api/agencies/${ownerA.agencyId}/notification-delivery/${notificationId}`,
    `/api/agencies/${ownerA.agencyId}/notification-delivery/${notificationId}/receipts`,
    `/api/agencies/${ownerA.agencyId}/notification-inbox`,
    `/api/agencies/${ownerA.agencyId}/notification-inbox/${notificationId}`,
  ]) {
    const anonymous = await apiCall(port(), pathName);
    assert.equal(anonymous.status, 401, `anonymous access to ${pathName} is 401`);
  }

  // Foreign/malformed identifiers are the UNIFORM 404.
  for (const [label, agencyId, notificationId2] of [
    ['foreign agency + foreign notification', ownerB.agencyId, randomUUID()],
    ['foreign agency + KNOWN notification', ownerB.agencyId, notificationId],
    ['malformed agency', 'not-a-uuid', notificationId],
    ['malformed notification', ownerA.agencyId, 'not-a-uuid'],
    ['unknown notification', ownerA.agencyId, randomUUID()],
  ] as const) {
    const detail = await apiCall(
      port(),
      `/api/agencies/${agencyId}/notification-delivery/${notificationId2}`,
      { token: ownerA.token },
    );
    assert.equal(detail.status, 404, `${label} is the uniform 404`);
    const receipts = await apiCall(
      port(),
      `/api/agencies/${agencyId}/notification-delivery/${notificationId2}/receipts`,
      { token: ownerA.token },
    );
    assert.equal(receipts.status, 404, `${label} receipts are the uniform 404`);
  }

  // The foreign agency LIST never contains the other agency's records.
  const listB = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/notification-delivery`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 200);
  assert.equal((listB.body['notifications'] as unknown[]).length, 0);
  const inboxB = await apiCall(port(), `/api/agencies/${ownerB.agencyId}/notification-inbox`, {
    token: ownerB.token,
  });
  assert.equal((inboxB.body['entries'] as unknown[]).length, 0);

  // The foreign inbox ENTRY read is the uniform 404.
  const foreignEntry = await apiCall(
    port(),
    `/api/agencies/${ownerB.agencyId}/notification-inbox/${notificationId}`,
    { token: ownerB.token },
  );
  assert.equal(foreignEntry.status, 404);

  // (The forged cross-tenant fence key battery — agency B replaying
  // agency A's occurrence — runs in the dedicated module battery below.)

  // A suspended membership is the 403 (the house membership battery: the
  // admin disables the membership through the /agencies PATCH route).
  const admin = await adminToken();
  const suspendedUser = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email: 'nd-suspended@marketingos.test', displayName: 'Suspended' },
  });
  const suspendedUserId = suspendedUser.body['userId'] as string;
  await apiCall(port(), `/api/users/${suspendedUserId}/credential`, {
    token: admin,
    body: { password: 'suspended-pass-123' },
  });
  const join = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: ownerA.token,
    body: { userId: suspendedUserId, role: 'agency_operator' },
  });
  assert.equal(join.status, 201, JSON.stringify(join.body));
  const suspendedLogin = await apiCall(port(), '/api/auth/login', {
    body: { email: 'nd-suspended@marketingos.test', password: 'suspended-pass-123' },
  });
  const suspendedToken = suspendedLogin.body['token'] as string;
  const activeRead = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/notification-delivery`, {
    token: suspendedToken,
  });
  assert.equal(activeRead.status, 200, 'an active member reads the agency surface');
  // Disable the membership (the growth-missions suspension flow).
  const memberships = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
  });
  const suspendedMembership = (memberships.body['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === suspendedUserId,
  )!;
  const disabled = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${suspendedMembership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'disabled', version: suspendedMembership['version'] as number },
    },
  );
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  // After suspension the read is the 403 (suspended member).
  const suspendedAfter = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/notification-delivery`, {
    token: suspendedToken,
  });
  assert.equal(suspendedAfter.status, 403, 'a suspended membership is the 403');

  // The non-GET/POST verbs 405 at the router.
  for (const [method, pathName] of [
    ['PUT', `/api/agencies/${ownerA.agencyId}/notification-delivery`],
    ['PATCH', `/api/agencies/${ownerA.agencyId}/notification-delivery/${notificationId}`],
    ['DELETE', `/api/agencies/${ownerA.agencyId}/notification-delivery/${notificationId}`],
    ['PUT', `/api/agencies/${ownerA.agencyId}/notification-inbox`],
    ['DELETE', `/api/agencies/${ownerA.agencyId}/notification-inbox/${notificationId}`],
  ] as const) {
    const blocked = await apiCall(port(), pathName, { token: ownerA.token, method });
    assert.equal(blocked.status, 405, `${method} ${pathName} is 405`);
  }
});

test('AC-9 (module battery): the cross-tenant fence hit is the uniform NotFound (no oracle)', async () => {
  const ownerA = await makeAgencyOwner('nd-owner-fence-a@marketingos.test');
  const ownerB = await makeAgencyOwner('nd-owner-fence-b@marketingos.test');
  const sourceId = randomUUID();

  // Agency A records the occurrence.
  await module_().recordNotification(
    occurrenceInput(ownerA, { sourceId, occurrenceKey: 'fence-occ-1' }),
    MODULE_PROVENANCE,
  );
  // Agency B replays the SAME (source, event, occurrence): the fence hit
  // resolves to A's notification — the uniform 404 (a forged key is not
  // a traversal oracle; nothing about A's record is revealed).
  await assert.rejects(
    () =>
      module_().recordNotification(
        occurrenceInput(ownerB, { sourceId, occurrenceKey: 'fence-occ-1' }),
        MODULE_PROVENANCE,
      ),
    (error: unknown) => error instanceof Error && error.message.includes('not found'),
  );
  // Agency B has exactly ZERO records after the forged probe.
  const recordsB = await module_().listNotificationsForAgency({ agencyId: ownerB.agencyId, clientId: null });
  assert.equal(recordsB.length, 0);
});

// ---------------------------------------------------------------------------
// The HTTP DTO authority-field rejection battery
// ---------------------------------------------------------------------------

test('AC-9 (DTO battery): authority/material-shaped fields are rejected on every mutation surface', async () => {
  const owner = await makeAgencyOwner('nd-owner-dto@marketingos.test');
  const base = {
    eventType: 'workflow.attention_required',
    urgency: 'normal',
    explanation: 'A workflow step needs attention.',
    sourceKind: 'workflow',
    sourceId: randomUUID(),
    occurrenceKey: 'dto-occ-1',
    deepLink: '/console/workflows/z',
    channels: ['in-app'],
  };

  for (const extra of [
    { notificationId: randomUUID() },
    { deliveryStatus: 'delivered' },
    { version: 1 },
    { provenance: { actor: 'user:x' } },
    { receipts: [] },
    { recipientAddress: 'someone@example.test' },
    { secretMaterial: 'sk-live-abc' },
    { to: 'someone@example.test' },
  ] as const) {
    const created = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
      token: owner.token,
      body: { ...base, occurrenceKey: `dto-${randomUUID()}`, ...extra },
    });
    assert.equal(created.status, 422, `the authority/material field ${Object.keys(extra)[0]} is rejected (the house InvalidRequestError status)`);
  }

  // A malformed body (missing the required §14 fields) is rejected.
  const missing = await apiCall(port(), `/api/agencies/${owner.agencyId}/notification-delivery`, {
    token: owner.token,
    body: { eventType: 'workflow.attention_required' },
  });
  assert.equal(missing.status, 422);
});
