/**
 * MKT-068 unit tests — the pure contract halves of the Notification
 * Delivery Plane (the social-accounts.test.ts precedent: vocabulary
 * pinning, input guards, idempotency math, adapter-registry validation,
 * receipt composers, policy-key derivation and the disclosed unwired
 * transport — all through the module PUBLIC entry; the provider-specific
 * adapter subtrees are proven end-to-end by the integration suite
 * through the composition seams).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-068):
 *   - AC-1/AC-10 VOCABULARY PINNING: the frozen urgency/event-type/
 *     channel/source-kind/outcome/delivery-status vocabularies and their
 *     transition tables are the module contract (the migration CHECKs
 *     mirror them — the boundary test pins the equality);
 *   - AC-2 ADAPTER CONTRACT: the registry validation (unique channel,
 *     legal acceptance subsets) and the acceptance math;
 *   - AC-5 IDEMPOTENCY MATH: the delivery-status derivation (the
 *     duplicate_skipped receipts NEVER participate), the duplicate-skip
 *     receipt shape and the fence-violation classification;
 *   - AC-3 the policy-gate key derivation (notification.channel.<channel>
 *     + notification.email.credential);
 *   - AC-7 the disclosed UnwiredEmailTransport (honest failed outcomes —
 *     never a silent drop);
 *   - the served-boundary validation (the /notifications boundary
 *     identity is enforced at construction).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUTURE_NOTIFICATION_CHANNELS,
  MVP_NOTIFICATION_CHANNELS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_DELIVERY_TRANSITIONS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_RECEIPT_OUTCOMES,
  NOTIFICATION_READ_STATUSES,
  NOTIFICATION_READ_TRANSITIONS,
  NOTIFICATION_SOURCE_KINDS,
  NOTIFICATION_URGENCIES,
  UnwiredEmailTransport,
  buildAdapterRegistry,
  channelAccepts,
  channelPolicyOperation,
  composeAcceptanceMismatchReceipt,
  composeDuplicateSkippedReceipt,
  composePolicyRefusedReceipt,
  composeReceipt,
  composeUnregisteredChannelReceipt,
  createNotificationDeliveryModule,
  deriveDeliveryStatus,
  emailCredentialPolicyOperation,
  isDuplicateFenceViolation,
  isLegalNotificationDeliveryTransition,
  isLegalNotificationReadTransition,
  assertValidNotificationProvenance,
  assertValidRecordNotificationInput,
  type ChannelAcceptance,
  type NotificationChannel,
  type NotificationDeliveryProvenance,
  type NotificationEventType,
  type NotificationUrgency,
  type NotificationDeliveryAdapter,
  type RecordNotificationInput,
} from '../../src/modules/notification-delivery/public.ts';
import { ConflictError, InvalidRequestError } from '../../src/platform/errors/errors.ts';
import { notificationsModule } from '../../src/modules/notifications/public.ts';

const UUID = '01234567-89ab-cdef-0123-456789abcdef';
const AGENCY = 'aaaaaaaa-89ab-cdef-0123-456789abcdef';
const USER = 'bbbbbbbb-89ab-cdef-0123-456789abcdef';
const CREDENTIAL = 'cccccccc-89ab-cdef-0123-456789abcdef';

const PROVENANCE: NotificationDeliveryProvenance = {
  actor: 'user:u1',
  recordedVia: 'module',
  correlationId: 'corr-1',
  causationId: null,
};

function validInput(overrides: Partial<RecordNotificationInput> = {}): RecordNotificationInput {
  return {
    agencyId: AGENCY,
    clientId: null,
    workspaceId: null,
    eventType: 'mission.state_changed',
    urgency: 'high',
    explanation: 'The mission moved to active.',
    source: { kind: 'mission', id: UUID },
    occurrenceKey: 'occurrence-1',
    requiredAction: 'Review the mission plan.',
    deepLink: '/console/missions/x',
    channels: ['in-app'],
    recipientUserId: null,
    emailCredentialReferenceId: null,
    ...overrides,
  };
}

const NOTIFICATION = {
  notificationId: 'dddddddd-89ab-cdef-0123-456789abcdef',
  agencyId: AGENCY,
  clientId: null,
  workspaceId: null,
  eventType: 'mission.state_changed' as NotificationEventType,
  urgency: 'high' as NotificationUrgency,
  explanation: 'The mission moved to active.',
  source: { kind: 'mission' as const, id: UUID },
  requiredAction: 'Review the mission plan.',
  deepLink: '/console/missions/x',
  requestedChannels: ['in-app'] as NotificationChannel[],
  recipientUserId: null,
  emailCredentialReferenceId: null,
  deliveryStatus: 'pending' as const,
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

// ---------------------------------------------------------------------------
// AC-1/AC-10: vocabulary pinning
// ---------------------------------------------------------------------------

test('MKT-068 AC-1: the frozen vocabularies are the module contract (pinned verbatim)', () => {
  assert.deepEqual([...NOTIFICATION_URGENCIES], ['low', 'normal', 'high', 'critical']);
  assert.deepEqual([...NOTIFICATION_EVENT_TYPES], [
    'mission.state_changed',
    'mission.blocked_pending_human_action',
    'execution.failed',
    'execution.unknown_outcome',
    'workflow.attention_required',
  ]);
  assert.deepEqual([...NOTIFICATION_SOURCE_KINDS], ['mission', 'execution', 'workflow', 'job']);
  assert.deepEqual([...NOTIFICATION_RECEIPT_OUTCOMES], [
    'delivered',
    'failed',
    'refused',
    'duplicate_skipped',
  ]);
  assert.deepEqual([...NOTIFICATION_DELIVERY_STATUSES], [
    'pending',
    'delivered',
    'partial',
    'undelivered',
  ]);
  assert.deepEqual([...NOTIFICATION_READ_STATUSES], ['unread', 'read']);
});

test('MKT-068 AC-2: the channel vocabulary carries the six keys — the two MVP + the four future capability keys', () => {
  assert.deepEqual([...NOTIFICATION_CHANNELS], ['in-app', 'email', 'whatsapp', 'telegram', 'sms', 'signal']);
  assert.deepEqual([...MVP_NOTIFICATION_CHANNELS], ['in-app', 'email']);
  assert.deepEqual([...FUTURE_NOTIFICATION_CHANNELS], ['whatsapp', 'telegram', 'sms', 'signal']);
});

test('MKT-068 AC-1: the adapter-plane delivery lifecycle transition table (delivered TERMINAL)', () => {
  assert.deepEqual([...NOTIFICATION_DELIVERY_TRANSITIONS.pending], ['delivered', 'partial', 'undelivered']);
  assert.deepEqual([...NOTIFICATION_DELIVERY_TRANSITIONS.delivered], []);
  assert.deepEqual([...NOTIFICATION_DELIVERY_TRANSITIONS.partial], ['delivered', 'partial', 'undelivered']);
  assert.deepEqual([...NOTIFICATION_DELIVERY_TRANSITIONS.undelivered], ['delivered', 'partial', 'undelivered']);
  assert.equal(isLegalNotificationDeliveryTransition('pending', 'delivered'), true);
  assert.equal(isLegalNotificationDeliveryTransition('delivered', 'partial'), false);
  assert.equal(isLegalNotificationDeliveryTransition('pending', 'pending'), false);
});

test('MKT-068 AC-6: the single sanctioned inbox transition (unread → read, terminal)', () => {
  assert.deepEqual([...NOTIFICATION_READ_TRANSITIONS.unread], ['read']);
  assert.deepEqual([...NOTIFICATION_READ_TRANSITIONS.read], []);
  assert.equal(isLegalNotificationReadTransition('unread', 'read'), true);
  assert.equal(isLegalNotificationReadTransition('read', 'unread'), false);
});

// ---------------------------------------------------------------------------
// Input guards (fail-closed by rejection)
// ---------------------------------------------------------------------------

test('MKT-068 input guard: a valid §14 record input passes', () => {
  assert.doesNotThrow(() => assertValidRecordNotificationInput(validInput()));
  assert.doesNotThrow(() =>
    assertValidRecordNotificationInput(
      validInput({
        channels: ['in-app', 'email'],
        recipientUserId: USER,
        emailCredentialReferenceId: CREDENTIAL,
      }),
    ),
  );
});

test('MKT-068 input guard: every vocabulary violation is rejected fail-closed', () => {
  for (const [label, overrides] of [
    ['urgency', { urgency: 'catastrophic' as NotificationUrgency }],
    ['eventType', { eventType: 'mission.exploded' as NotificationEventType }],
    ['source.kind', { source: { kind: 'pigeon' as never, id: UUID } }],
    ['source.id (non-uuid)', { source: { kind: 'mission', id: 'not-a-uuid' } }],
    ['channel', { channels: ['pigeon'] as unknown as NotificationChannel[] }],
    ['duplicate channels', { channels: ['in-app', 'in-app'] }],
    ['empty channels', { channels: [] }],
  ] as const) {
    assert.throws(
      () => assertValidRecordNotificationInput(validInput(overrides as Partial<RecordNotificationInput>)),
      InvalidRequestError,
      `${label} must be rejected`,
    );
  }
});

test('MKT-068 input guard: the email-context payload shape is enforced (REQUIRED exactly when email is requested)', () => {
  assert.throws(
    () => assertValidRecordNotificationInput(validInput({ channels: ['email'] })),
    InvalidRequestError,
    'email without recipient/credential is rejected',
  );
  assert.throws(
    () =>
      assertValidRecordNotificationInput(
        validInput({ channels: ['email'], recipientUserId: USER }),
      ),
    InvalidRequestError,
    'email without the credential reference is rejected',
  );
  assert.throws(
    () =>
      assertValidRecordNotificationInput(
        validInput({ channels: ['in-app'], recipientUserId: USER, emailCredentialReferenceId: CREDENTIAL }),
      ),
    InvalidRequestError,
    'the email context without the email channel is rejected',
  );
});

test('MKT-068 input guard: the §21 material-shaped value backstop rejects smuggled secrets', () => {
  for (const field of ['explanation', 'requiredAction', 'deepLink', 'occurrenceKey'] as const) {
    assert.throws(
      () => assertValidRecordNotificationInput(validInput({ [field]: 'sk-live-secret-token-value' } as Partial<RecordNotificationInput>)),
      InvalidRequestError,
      `a material-shaped ${field} is rejected`,
    );
  }
});

test('MKT-068 input guard: the §14 field bounds are enforced', () => {
  assert.throws(() => assertValidRecordNotificationInput(validInput({ explanation: '' })), InvalidRequestError);
  assert.throws(() => assertValidRecordNotificationInput(validInput({ deepLink: 'not a link' })), InvalidRequestError);
  assert.throws(() => assertValidRecordNotificationInput(validInput({ occurrenceKey: '' })), InvalidRequestError);
  assert.throws(() => assertValidRecordNotificationInput(validInput({ agencyId: 'nope' })), InvalidRequestError);
  assert.doesNotThrow(() =>
    assertValidRecordNotificationInput(validInput({ requiredAction: null })),
  );
});

test('MKT-068 provenance guard: the server-derived provenance shape is enforced', () => {
  assert.doesNotThrow(() => assertValidNotificationProvenance(PROVENANCE));
  for (const bad of [
    { ...PROVENANCE, actor: '' },
    { ...PROVENANCE, recordedVia: '' },
    { ...PROVENANCE, correlationId: '' },
    { ...PROVENANCE, causationId: '' },
  ] as const) {
    assert.throws(() => assertValidNotificationProvenance(bad), InvalidRequestError);
  }
});

// ---------------------------------------------------------------------------
// AC-5: the idempotency + delivery-status math
// ---------------------------------------------------------------------------

test('MKT-068 AC-5: deriveDeliveryStatus — the duplicate_skipped receipts NEVER participate', () => {
  // No real receipts yet: the record stays pending.
  assert.equal(deriveDeliveryStatus(['in-app'], []), 'pending');
  assert.equal(
    deriveDeliveryStatus(['in-app'], [{ channel: 'in-app', outcome: 'duplicate_skipped' }]),
    'pending',
    'a replay-only tail leaves the status pending',
  );
  // All requested channels delivered.
  assert.equal(
    deriveDeliveryStatus(['in-app', 'email'], [
      { channel: 'in-app', outcome: 'delivered' },
      { channel: 'email', outcome: 'delivered' },
    ]),
    'delivered',
  );
  // Some delivered.
  assert.equal(
    deriveDeliveryStatus(['in-app', 'email'], [
      { channel: 'in-app', outcome: 'delivered' },
      { channel: 'email', outcome: 'refused' },
    ]),
    'partial',
  );
  // None delivered.
  assert.equal(
    deriveDeliveryStatus(['in-app'], [{ channel: 'in-app', outcome: 'failed' }]),
    'undelivered',
  );
});

test('MKT-068 AC-5: deriveDeliveryStatus — the LATEST real receipt per channel decides (retries converge)', () => {
  assert.equal(
    deriveDeliveryStatus(['email'], [
      { channel: 'email', outcome: 'failed' },
      { channel: 'email', outcome: 'delivered' },
    ]),
    'delivered',
    'a successful retry moves the channel to delivered',
  );
  assert.equal(
    deriveDeliveryStatus(['email'], [
      { channel: 'email', outcome: 'delivered' },
      { channel: 'email', outcome: 'failed' },
    ]),
    'undelivered',
    'the math reads the latest receipt honestly (this input cannot occur in practice: delivered is terminal and retries on delivered channels are refused)',
  );
  assert.equal(
    deriveDeliveryStatus(['in-app', 'email'], [
      { channel: 'in-app', outcome: 'delivered' },
      { channel: 'in-app', outcome: 'duplicate_skipped' },
      { channel: 'email', outcome: 'failed' },
    ]),
    'partial',
    'the fence receipt never downgrades a delivered channel',
  );
});

test('MKT-068 AC-5: the duplicate-skipped receipt carries ONLY the skip fact', () => {
  const receipt = composeDuplicateSkippedReceipt({
    notification: NOTIFICATION,
    channel: 'in-app',
    attemptSeq: 2,
    provenance: PROVENANCE,
  });
  assert.equal(receipt.outcome, 'duplicate_skipped');
  assert.equal(receipt.providerMessageId, null);
  assert.equal(receipt.policyDecisionId, null);
  assert.ok(receipt.reason !== null && receipt.reason.includes('idempotency fence'));
  assert.equal(receipt.recordedActor, PROVENANCE.actor);
});

test('MKT-068 AC-5: isDuplicateFenceViolation classifies exactly the fence unique violation', () => {
  assert.equal(isDuplicateFenceViolation({ code: '23505', constraint: 'notification_dedup_fence_unique' }), true);
  assert.equal(isDuplicateFenceViolation({ code: '23505', constraint: 'notification_delivery_dedup_fence_pkey' }), true);
  assert.equal(isDuplicateFenceViolation({ code: '23505', constraint: 'some_other_unique' }), false);
  assert.equal(isDuplicateFenceViolation({ code: '23503', constraint: 'notification_dedup_fence_unique' }), false);
  assert.equal(isDuplicateFenceViolation(new Error('nope')), false);
  assert.equal(isDuplicateFenceViolation(null), false);
});

// ---------------------------------------------------------------------------
// AC-2: the adapter registry + acceptance math
// ---------------------------------------------------------------------------

function stubAdapter(channel: NotificationChannel, acceptance: ChannelAcceptance): NotificationDeliveryAdapter {
  return {
    channel,
    acceptance,
    async deliver() {
      return { outcome: 'delivered', reason: null, providerMessageId: null };
    },
  };
}

const FULL: ChannelAcceptance = {
  urgencies: [...NOTIFICATION_URGENCIES],
  eventTypes: [...NOTIFICATION_EVENT_TYPES],
};

test('MKT-068 AC-2: the registry validates adapter registrations as DATA (unique channel, legal acceptance)', () => {
  const registry = buildAdapterRegistry([
    stubAdapter('in-app', FULL),
    stubAdapter('email', { urgencies: ['normal', 'high', 'critical'], eventTypes: [...NOTIFICATION_EVENT_TYPES] }),
  ]);
  assert.equal(registry.size, 2);
  assert.ok(registry.has('in-app'));
  assert.ok(registry.has('email'));
  // Duplicate channel registration fails loudly.
  assert.throws(
    () => buildAdapterRegistry([stubAdapter('in-app', FULL), stubAdapter('in-app', FULL)]),
    InvalidRequestError,
  );
  // Unknown channel key fails loudly.
  assert.throws(
    () => buildAdapterRegistry([stubAdapter('pigeon' as NotificationChannel, FULL)]),
    InvalidRequestError,
  );
  // Empty acceptance subsets fail loudly.
  assert.throws(
    () => buildAdapterRegistry([stubAdapter('sms', { urgencies: [], eventTypes: [...NOTIFICATION_EVENT_TYPES] })]),
    InvalidRequestError,
  );
  assert.throws(
    () => buildAdapterRegistry([stubAdapter('sms', { urgencies: [...NOTIFICATION_URGENCIES], eventTypes: [] })]),
    InvalidRequestError,
  );
  // Vocabulary violations in acceptance fail loudly.
  assert.throws(
    () =>
      buildAdapterRegistry([
        stubAdapter('sms', { urgencies: ['mega' as NotificationUrgency], eventTypes: [...NOTIFICATION_EVENT_TYPES] }),
      ]),
    InvalidRequestError,
  );
});

test('MKT-068 AC-2/AC-3: channelAccepts — a channel not sanctioned for the urgency/event type fails closed', () => {
  const emailAcceptance: ChannelAcceptance = {
    urgencies: ['normal', 'high', 'critical'],
    eventTypes: [...NOTIFICATION_EVENT_TYPES],
  };
  assert.equal(channelAccepts(emailAcceptance, 'high', 'mission.state_changed'), true);
  assert.equal(channelAccepts(emailAcceptance, 'low', 'mission.state_changed'), false, 'low urgency is outside the email acceptance');
  const restricted: ChannelAcceptance = {
    urgencies: [...NOTIFICATION_URGENCIES],
    eventTypes: ['execution.failed'],
  };
  assert.equal(channelAccepts(restricted, 'high', 'execution.failed'), true);
  assert.equal(channelAccepts(restricted, 'high', 'mission.state_changed'), false);
});

// ---------------------------------------------------------------------------
// AC-3: the policy-gate key derivation
// ---------------------------------------------------------------------------

test('MKT-068 AC-3: the per-channel policy keys derive deterministically', () => {
  assert.equal(channelPolicyOperation('in-app'), 'notification.channel.in-app');
  assert.equal(channelPolicyOperation('email'), 'notification.channel.email');
  assert.equal(channelPolicyOperation('whatsapp'), 'notification.channel.whatsapp');
  assert.equal(emailCredentialPolicyOperation(), 'notification.email.credential');
});

// ---------------------------------------------------------------------------
// The receipt composers (the honest outcome shapes)
// ---------------------------------------------------------------------------

test('MKT-068 AC-3/AC-5: the receipt composers produce the honest payload shapes', () => {
  // A policy refusal carries the decision id.
  const refused = composePolicyRefusedReceipt({
    notification: NOTIFICATION,
    channel: 'email',
    attemptSeq: 1,
    decisionId: 'dec-1',
    reasonCode: 'no-active-policy',
    provenance: PROVENANCE,
  });
  assert.equal(refused.outcome, 'refused');
  assert.equal(refused.policyDecisionId, 'dec-1');
  assert.ok(refused.reason !== null && refused.reason.includes('dec-1'));

  // An unregistered future channel is refused honestly.
  const unregistered = composeUnregisteredChannelReceipt({
    notification: NOTIFICATION,
    channel: 'whatsapp',
    attemptSeq: 1,
    provenance: PROVENANCE,
  });
  assert.equal(unregistered.outcome, 'refused');
  assert.ok(unregistered.reason !== null && unregistered.reason.includes('no delivery adapter is registered'));
  assert.equal(unregistered.policyDecisionId, null);

  // The acceptance mismatch names the offending dimension.
  const mismatchUrgency = composeAcceptanceMismatchReceipt({
    notification: { ...NOTIFICATION, urgency: 'low' },
    channel: 'email',
    acceptance: { urgencies: ['normal', 'high', 'critical'], eventTypes: [...NOTIFICATION_EVENT_TYPES] },
    attemptSeq: 1,
    provenance: PROVENANCE,
  });
  assert.equal(mismatchUrgency.outcome, 'refused');
  assert.ok(mismatchUrgency.reason !== null && mismatchUrgency.reason.includes("urgency 'low'"));
  const mismatchEvent = composeAcceptanceMismatchReceipt({
    notification: NOTIFICATION,
    channel: 'email',
    acceptance: { urgencies: [...NOTIFICATION_URGENCIES], eventTypes: ['execution.failed'] },
    attemptSeq: 1,
    provenance: PROVENANCE,
  });
  assert.ok(mismatchEvent.reason !== null && mismatchEvent.reason.includes("event type 'mission.state_changed'"));

  // An adapter outcome receipt: provider message ids only on
  // delivered/failed; the policy decision id only on refused.
  const delivered = composeReceipt({
    notification: NOTIFICATION,
    channel: 'email',
    attemptSeq: 1,
    outcome: 'delivered',
    reason: null,
    providerMessageId: 'pm-1',
    policyDecisionId: null,
    provenance: PROVENANCE,
  });
  assert.equal(delivered.providerMessageId, 'pm-1');
  assert.equal(delivered.policyDecisionId, null);
  const refusedWithDecision = composeReceipt({
    notification: NOTIFICATION,
    channel: 'email',
    attemptSeq: 1,
    outcome: 'refused',
    reason: 'credential gate denied',
    providerMessageId: null,
    policyDecisionId: 'dec-2',
    provenance: PROVENANCE,
  });
  assert.equal(refusedWithDecision.policyDecisionId, 'dec-2');
  // The reason is bounded.
  const longReason = composeReceipt({
    notification: NOTIFICATION,
    channel: 'email',
    attemptSeq: 1,
    outcome: 'failed',
    reason: 'x'.repeat(2000),
    providerMessageId: null,
    policyDecisionId: null,
    provenance: PROVENANCE,
  });
  assert.ok(longReason.reason !== null && longReason.reason.length <= 512);
});

// ---------------------------------------------------------------------------
// AC-7: the disclosed unwired transport
// ---------------------------------------------------------------------------

test('MKT-068 AC-7: the UnwiredEmailTransport honestly FAILS every send (never a silent drop)', async () => {
  const transport = new UnwiredEmailTransport();
  const result = await transport.send({
    to: 'someone@example.test',
    subject: 's',
    body: 'b',
    credentialMaterial: new Uint8Array([1, 2, 3]),
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.providerMessageId, null);
  assert.ok(result.reason !== null && result.reason.includes('not wired'));
});

// ---------------------------------------------------------------------------
// The served-boundary validation (the /notifications dependency)
// ---------------------------------------------------------------------------

test('MKT-068: the delivery plane refuses to construct behind any boundary other than /notifications', () => {
  const deps = {
    db: {} as never,
    clock: {} as never,
    ids: {} as never,
    notifications: { name: 'wrong', authority: 'Wrong' } as unknown as typeof notificationsModule,
    policies: {} as never,
    credentials: {} as never,
    adapters: [],
  };
  assert.throws(() => createNotificationDeliveryModule(deps), ConflictError);
});

test('MKT-068: the delivery plane constructs behind the canonical /notifications boundary identity', () => {
  const deps = {
    db: {} as never,
    clock: {} as never,
    ids: {} as never,
    notifications: notificationsModule,
    policies: {} as never,
    credentials: {} as never,
    adapters: [],
  };
  const module = createNotificationDeliveryModule(deps);
  assert.equal(module.listRegisteredAdapters().length, 0, 'no adapters registered — the empty registry is legal');
  assert.equal(typeof module.recordNotification, 'function');
});
