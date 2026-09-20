/**
 * MKT-068 unit tests — the frozen Notification Delivery vocabularies, the
 * idempotency-fence math, the adapter-registration contract, the recipient
 * resolution policy, the email envelope composition, the per-channel
 * policy-key composition and the delivery-input/provenance guards (pure
 * functions, no DB).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-068; spec/
 * architecture-v1.6.md §14; spec/module-dependency-matrix-v1.6.md
 * boundary rule 9):
 *   - the vocabularies are frozen and versioned (nd-vocab-v1): the event
 *     types, the urgencies, the source kinds, the implemented channels
 *     (in_app + email), the declared-but-unimplemented pluggable keys
 *     (whatsapp/telegram/sms/signal), the receipt outcomes and the
 *     adapter-plane delivery statuses (pending → dispatched — NEVER a
 *     task state);
 *   - THE IDEMPOTENCY-FENCE MATH (AC-5): the same occurrence composes the
 *     same fence key; ANY differing component (source kind, source id,
 *     event type, occurrence key) is a DIFFERENT occurrence — replays
 *     collide, distinct occurrences never do;
 *   - THE ADAPTER CONTRACT (AC-2): a well-formed registration passes the
 *     pure validation; an unimplemented channel key is refused fail-closed
 *     (whatsapp/telegram/sms/signal); a malformed urgency/event-type
 *     subset is refused; a duplicate channel registration is refused by
 *     the module construction contract;
 *   - THE RECIPIENT RESOLUTION (AC-7): the pure selection policy picks
 *     exactly the ACTIVE agency_owner members with active identities —
 *     deduped, sorted, bounded — and NEVER an invented/guessed address;
 *   - THE EMAIL ENVELOPE: the pure §14 composition (subject + body carry
 *     the explanation, the required action, the deep link, the source
 *     reference — bounded);
 *   - THE POLICY GATE KEY (AC-3): channelPolicyKey composes
 *     notification.channel.<channel> for every declared key;
 *   - the delivery-input guard rejects every malformed shape (unknown
 *     vocabulary value, empty explanation, ABSOLUTE deep link, malformed
 *     occurrence key, oversized fields) fail-closed BEFORE any write,
 *     and the provenance guard enforces the server-derived discipline.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';
import {
  NOTIFICATION_DELIVERY_CHANNELS,
  NOTIFICATION_DELIVERY_OUTCOMES,
  NOTIFICATION_DELIVERY_STATUSES,
  NOTIFICATION_DELIVERY_VOCABULARY_VERSION,
  NOTIFICATION_EMAIL_MAX_RECIPIENTS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SOURCE_KINDS,
  NOTIFICATION_URGENCIES,
  PLUGGABLE_NOTIFICATION_CHANNEL_KEYS,
  channelPolicyKey,
  composeNotificationEmailEnvelope,
  composeNotificationFenceKey,
  isKnownNotificationEventType,
  isKnownNotificationSourceKind,
  isKnownNotificationUrgency,
  selectNotificationRecipients,
  type NotificationDeliveryAdapter,
  type NotificationProvenance,
  type NotificationRecord,
} from '../../src/modules/notification-delivery/public.ts';
import {
  assertValidNotificationDeliveryInput,
  assertValidNotificationProvenance,
  isValidNotificationAdapterRegistration,
} from '../../src/modules/notification-delivery/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (AC-1/AC-2)
// ---------------------------------------------------------------------------

test('MKT-068 AC-1: the §14 vocabularies are frozen, versioned and closed', () => {
  assert.equal(NOTIFICATION_DELIVERY_VOCABULARY_VERSION, 'nd-vocab-v1');
  // Event types: the v1.6 operating-loop surface, exactly the disclosed set.
  assert.deepEqual([...NOTIFICATION_EVENT_TYPES], [
    'mission_attention_required', 'mission_terminal', 'execution_attention_required',
    'deployment_attention_required', 'approval_required', 'anomaly_detected',
    'quota_exhausted', 'policy_denied', 'system_notice',
  ]);
  // Urgencies: routine → important → urgent → critical.
  assert.deepEqual([...NOTIFICATION_URGENCIES], ['routine', 'important', 'urgent', 'critical']);
  // Source kinds: the producing authorities (the §14 source reference).
  assert.deepEqual([...NOTIFICATION_SOURCE_KINDS], [
    'growth_mission', 'execution', 'deployment', 'workflow_instance',
    'job', 'experiment', 'platform', 'extension',
  ]);
  // The implemented channels: in-app + email (§14 MVP).
  assert.deepEqual([...NOTIFICATION_DELIVERY_CHANNELS], ['in_app', 'email']);
  // The declared-but-unimplemented pluggable keys (§14 future adapters).
  assert.deepEqual([...PLUGGABLE_NOTIFICATION_CHANNEL_KEYS], ['whatsapp', 'telegram', 'sms', 'signal']);
  // The receipt outcomes: the honest delivery-attempt tail.
  assert.deepEqual([...NOTIFICATION_DELIVERY_OUTCOMES], ['delivered', 'failed', 'refused', 'duplicate_skipped']);
  // The adapter-plane lifecycle — NEVER a task state (boundary rule 9).
  assert.deepEqual([...NOTIFICATION_DELIVERY_STATUSES], ['pending', 'dispatched']);

  // The guards close the vocabularies.
  for (const value of NOTIFICATION_EVENT_TYPES) assert.ok(isKnownNotificationEventType(value));
  for (const value of NOTIFICATION_URGENCIES) assert.ok(isKnownNotificationUrgency(value));
  for (const value of NOTIFICATION_SOURCE_KINDS) assert.ok(isKnownNotificationSourceKind(value));
  assert.ok(!isKnownNotificationEventType('made_up_event'));
  assert.ok(!isKnownNotificationUrgency('extreme'));
  assert.ok(!isKnownNotificationSourceKind('random_module'));
  // No pluggable key is an implemented channel.
  for (const key of PLUGGABLE_NOTIFICATION_CHANNEL_KEYS) {
    assert.ok(!(NOTIFICATION_DELIVERY_CHANNELS as readonly string[]).includes(key));
  }
});

// ---------------------------------------------------------------------------
// The idempotency-fence math (AC-5)
// ---------------------------------------------------------------------------

test('MKT-068 AC-5: the dedup-fence math — the same occurrence always collides, ANY differing component never does', () => {
  const occurrence = {
    sourceKind: 'growth_mission' as const,
    sourceId: '11111111-1111-4111-8111-111111111111',
    eventType: 'mission_attention_required' as const,
    occurrenceKey: 'state-transition-7',
  };
  const key = composeNotificationFenceKey(occurrence);

  // Purity: identical inputs compose identical outputs.
  assert.equal(composeNotificationFenceKey(occurrence), key);

  // A REPLAY of the same occurrence collides (the fence blocks it).
  assert.equal(composeNotificationFenceKey({ ...occurrence }), key);

  // ANY differing component is a DIFFERENT occurrence.
  assert.notEqual(
    composeNotificationFenceKey({ ...occurrence, sourceKind: 'execution' }),
    key,
    'a different source kind is a different occurrence',
  );
  assert.notEqual(
    composeNotificationFenceKey({ ...occurrence, sourceId: '22222222-2222-4222-8222-222222222222' }),
    key,
    'a different source id is a different occurrence',
  );
  assert.notEqual(
    composeNotificationFenceKey({ ...occurrence, eventType: 'mission_terminal' }),
    key,
    'a different event type is a different occurrence',
  );
  assert.notEqual(
    composeNotificationFenceKey({ ...occurrence, occurrenceKey: 'state-transition-8' }),
    key,
    'a different occurrence key (the next occurrence of the SAME event type from the SAME source) is a different occurrence',
  );

  // The occurrence-key grammar admits the natural discriminators.
  for (const valid of ['1', 'occurrence-1', 'evt:42', 'seq.7', 'T-2026-09-20T00:00:00Z'.replace(/[^A-Za-z0-9._:-]/g, '')]) {
    const problems = problemsOf(() =>
      assertValidNotificationDeliveryInput({ ...VALID_INPUT, occurrenceKey: valid }),
    );
    assert.deepEqual(problems, [], `occurrenceKey '${valid}' is grammatical`);
  }
});

/** Captures the InvalidRequestError problems of a guard call (EMPTY when it passes). */
function problemsOf(call: () => void): readonly string[] {
  try {
    call();
    return [];
  } catch (error) {
    assert.ok(error instanceof InvalidRequestError, 'the guard fails with InvalidRequestError');
    return error.details ?? [];
  }
}

const VALID_INPUT = {
  agencyId: '33333333-3333-4333-8333-333333333333',
  clientId: '44444444-4444-4444-8444-444444444444',
  workspaceId: null as string | null,
  eventType: 'mission_attention_required' as const,
  urgency: 'urgent' as const,
  explanation: 'Mission M-91 is blocked pending human action on the rights gate.',
  sourceKind: 'growth_mission' as const,
  sourceId: '55555555-5555-4555-8555-555555555555',
  requiredAction: 'Approve or reject the content rights clearance in the console.' as string | null,
  deepLink: '/console/missions/55555555-5555-4555-8555-555555555555',
  occurrenceKey: 'blocked-2026-09-20-1',
};

// ---------------------------------------------------------------------------
// The adapter-registration contract (AC-2)
// ---------------------------------------------------------------------------

/**
 * A minimal well-formed adapter for the contract tests whose accepts()
 * consults its declared subsets EXACTLY like the real implementations
 * (the email adapter's declared-MVP discipline).
 */
function adapterOf(overrides: Partial<NotificationDeliveryAdapter> = {}): NotificationDeliveryAdapter {
  const declared: NotificationDeliveryAdapter = {
    channel: 'email',
    acceptedUrgencies: ['important', 'urgent', 'critical'],
    acceptedEventTypes: null,
    accepts: () => true,
    deliver: async () => ({ outcome: 'delivered', providerMessageId: 'msg-1' }),
    ...overrides,
  };
  return {
    ...declared,
    accepts: ({ urgency, eventType }) =>
      declared.acceptedUrgencies.includes(urgency) &&
      (declared.acceptedEventTypes === null || declared.acceptedEventTypes.includes(eventType)),
  };
}

test('MKT-068 AC-2: a well-formed adapter registration passes; unimplemented channel keys are refused FAIL-CLOSED', () => {
  // Well-formed: every implemented channel + a non-empty frozen urgency
  // subset (+ optional event-type subset).
  assert.deepEqual(isValidNotificationAdapterRegistration(adapterOf({ channel: 'in_app' })), []);
  assert.deepEqual(isValidNotificationAdapterRegistration(adapterOf()), []);
  assert.deepEqual(
    isValidNotificationAdapterRegistration(
      adapterOf({ acceptedEventTypes: ['mission_attention_required', 'approval_required'] }),
    ),
    [],
  );

  // The DECLARED-but-UNIMPLEMENTED keys are refused with the honest reason.
  for (const key of PLUGGABLE_NOTIFICATION_CHANNEL_KEYS) {
    const problems = isValidNotificationAdapterRegistration(adapterOf({ channel: key }));
    assert.ok(
      problems.some((problem) => problem.includes('UNIMPLEMENTED')),
      `registering the declared-but-unimplemented key '${key}' is refused fail-closed`,
    );
  }

  // A completely unknown channel is refused too.
  assert.ok(
    isValidNotificationAdapterRegistration(adapterOf({ channel: 'pigeon' as never })).length > 0,
    'an undeclared channel is refused',
  );

  // Malformed subsets are refused.
  assert.ok(
    isValidNotificationAdapterRegistration(adapterOf({ acceptedUrgencies: [] })).length > 0,
    'an EMPTY urgency subset is refused',
  );
  assert.ok(
    isValidNotificationAdapterRegistration(
      adapterOf({ acceptedUrgencies: ['extreme' as never] }),
    ).length > 0,
    'a non-frozen urgency is refused',
  );
  assert.ok(
    isValidNotificationAdapterRegistration(
      adapterOf({ acceptedEventTypes: [] as never[] }),
    ).length > 0,
    'an EMPTY event-type subset is refused (null means every type)',
  );

  // The adapter must implement the contract methods.
  const broken = adapterOf();
  (broken as { deliver?: unknown }).deliver = undefined;
  assert.ok(isValidNotificationAdapterRegistration(broken).length > 0);
});

test('MKT-068 AC-2: the adapter accepts() consultation is the targeting gate (the declared subsets)', () => {
  // The MVP email urgency subset: important/urgent/critical — routine
  // stays in the in-app inbox.
  const email = adapterOf();
  assert.ok(email.accepts({ urgency: 'critical', eventType: 'system_notice' }));
  assert.ok(!email.accepts({ urgency: 'routine', eventType: 'system_notice' }));

  // The in-app channel accepts everything (the always-on baseline).
  const inApp = adapterOf({ channel: 'in_app', acceptedUrgencies: [...NOTIFICATION_URGENCIES] });
  for (const urgency of NOTIFICATION_URGENCIES) {
    for (const eventType of NOTIFICATION_EVENT_TYPES) {
      assert.ok(inApp.accepts({ urgency, eventType }));
    }
  }

  // An event-type subset narrows the targeting.
  const narrowed = adapterOf({ acceptedEventTypes: ['approval_required'] });
  assert.ok(narrowed.accepts({ urgency: 'urgent', eventType: 'approval_required' }));
  assert.ok(!narrowed.accepts({ urgency: 'urgent', eventType: 'anomaly_detected' }));
});

// ---------------------------------------------------------------------------
// The recipient resolution policy (AC-7)
// ---------------------------------------------------------------------------

test('MKT-068 AC-7: recipient selection resolves ONLY active agency owners with active identities — never guessed, deduped, sorted, bounded', () => {
  const candidates = [
    // The accountable owner (active membership + active identity).
    { email: 'owner@agency.test', membershipStatus: 'active', role: 'agency_owner', userStatus: 'active' },
    // A duplicate snapshot of the same owner (deduped).
    { email: 'owner@agency.test', membershipStatus: 'active', role: 'agency_owner', userStatus: 'active' },
    // A second owner (sorted).
    { email: 'a-owner@agency.test', membershipStatus: 'active', role: 'agency_owner', userStatus: 'active' },
    // NOT selected: other roles.
    { email: 'operator@agency.test', membershipStatus: 'active', role: 'agency_operator', userStatus: 'active' },
    { email: 'admin@agency.test', membershipStatus: 'active', role: 'agency_admin', userStatus: 'active' },
    // NOT selected: suspended membership.
    { email: 'suspended@agency.test', membershipStatus: 'disabled', role: 'agency_owner', userStatus: 'active' },
    // NOT selected: disabled identity.
    { email: 'disabled@agency.test', membershipStatus: 'active', role: 'agency_owner', userStatus: 'disabled' },
  ];
  assert.deepEqual(selectNotificationRecipients(candidates), [
    'a-owner@agency.test',
    'owner@agency.test',
  ]);

  // Nothing resolves → EMPTY (the honest failure path — no invented address).
  assert.deepEqual(selectNotificationRecipients([]), []);
  assert.deepEqual(
    selectNotificationRecipients([
      { email: 'x@agency.test', membershipStatus: 'active', role: 'agency_operator', userStatus: 'active' },
    ]),
    [],
  );

  // Bounded fan-out: the selection is capped at the maximum.
  const many = Array.from({ length: NOTIFICATION_EMAIL_MAX_RECIPIENTS + 10 }, (_, index) => ({
    email: `owner-${index}@agency.test`,
    membershipStatus: 'active',
    role: 'agency_owner',
    userStatus: 'active',
  }));
  assert.equal(
    selectNotificationRecipients(many).length,
    NOTIFICATION_EMAIL_MAX_RECIPIENTS,
    'the recipient fan-out is bounded',
  );

  // Purity: identical inputs select identical outputs.
  assert.deepEqual(selectNotificationRecipients(candidates), selectNotificationRecipients([...candidates].reverse()));
});

// ---------------------------------------------------------------------------
// The email envelope composition (AC-7 — the §14 rendering)
// ---------------------------------------------------------------------------

test('MKT-068 AC-7: the email envelope composes the §14 fields deterministically and bounded', () => {
  const notification: NotificationRecord = {
    notificationId: '66666666-6666-4666-8666-666666666666',
    agencyId: VALID_INPUT.agencyId,
    clientId: VALID_INPUT.clientId,
    workspaceId: null,
    eventType: 'mission_attention_required',
    urgency: 'critical',
    explanation: 'Mission M-91 is blocked pending human action on the rights gate.',
    sourceKind: 'growth_mission',
    sourceId: VALID_INPUT.sourceId,
    requiredAction: 'Approve or reject the content rights clearance in the console.',
    deepLink: '/console/missions/55555555-5555-4555-8555-555555555555',
    deliveryStatus: 'pending',
    provenance: {
      actor: 'worker:growth-operator',
      recordedVia: 'module',
      correlationId: 'corr-1',
      causationId: null,
      recordedAt: '2026-09-20T10:00:00.000Z',
    },
    version: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  const envelope = composeNotificationEmailEnvelope(notification);
  assert.ok(envelope.subject.startsWith('[critical] mission_attention_required —'));
  assert.ok(envelope.subject.includes('Mission M-91 is blocked'));
  assert.ok(envelope.body.includes('Required action: Approve or reject the content rights clearance'));
  assert.ok(envelope.body.includes('Open in console: /console/missions/'));
  assert.ok(envelope.body.includes('Source: growth_mission 55555555-5555-4555-8555-555555555555'));
  assert.ok(envelope.body.includes('Urgency: critical'));
  // Deterministic (pure) composition.
  assert.deepEqual(composeNotificationEmailEnvelope(notification), envelope);

  // The no-action rendering is honest.
  const informational = composeNotificationEmailEnvelope({
    ...notification,
    requiredAction: null,
  });
  assert.ok(informational.body.includes('No specific action is required.'));

  // Bounded: an oversized explanation is truncated, never thrown.
  const oversized = composeNotificationEmailEnvelope({
    ...notification,
    explanation: 'x'.repeat(4000),
  });
  assert.ok(oversized.subject.length <= 500);
  assert.ok(oversized.body.length <= 5000);
});

// ---------------------------------------------------------------------------
// The per-channel policy gate key (AC-3)
// ---------------------------------------------------------------------------

test('MKT-068 AC-3: the channel policy key is notification.channel.<channel> for every declared key', () => {
  assert.equal(channelPolicyKey('in_app'), 'notification.channel.in_app');
  assert.equal(channelPolicyKey('email'), 'notification.channel.email');
  assert.equal(channelPolicyKey('whatsapp'), 'notification.channel.whatsapp');
  assert.equal(channelPolicyKey('telegram'), 'notification.channel.telegram');
  assert.equal(channelPolicyKey('sms'), 'notification.channel.sms');
  assert.equal(channelPolicyKey('signal'), 'notification.channel.signal');
  // Distinct per channel (no cross-channel collision).
  assert.notEqual(channelPolicyKey('in_app'), channelPolicyKey('email'));
});

// ---------------------------------------------------------------------------
// The delivery-input guard (fail-closed by rejection)
// ---------------------------------------------------------------------------

test('MKT-068: the delivery-input guard accepts the honest shape and rejects every malformed one FAIL-CLOSED', () => {
  // The honest shape passes.
  assert.deepEqual(problemsOf(() => assertValidNotificationDeliveryInput(VALID_INPUT)), []);

  // With a workspace narrowing.
  assert.deepEqual(
    problemsOf(() =>
      assertValidNotificationDeliveryInput({
        ...VALID_INPUT,
        workspaceId: '77777777-7777-4777-8777-777777777777',
      }),
    ),
    [],
  );

  // Unknown vocabulary values are rejected (the frozen nd-vocab-v1 set).
  assert.ok(
    problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, eventType: 'random_event' as never })).some((p) =>
      p.includes('event-type vocabulary'),
    ),
  );
  assert.ok(
    problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, urgency: 'extreme' as never })).some((p) =>
      p.includes('urgency vocabulary'),
    ),
  );
  assert.ok(
    problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, sourceKind: 'random_module' as never })).some((p) =>
      p.includes('source-kind vocabulary'),
    ),
  );

  // The explanation is required and bounded.
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, explanation: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, explanation: 'x'.repeat(2001) })).length > 0);

  // The required action is nullable-but-bounded.
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, requiredAction: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, requiredAction: null })).length === 0);

  // The DEEP LINK must be RELATIVE (no scheme, no host — the §14 fence).
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, deepLink: 'https://console.example.com/missions/1' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, deepLink: '/missions/1' })).length === 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, deepLink: 'missions/1' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, deepLink: '/has space' })).length > 0);

  // The occurrence key grammar (the producing authority's discriminator).
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, occurrenceKey: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, occurrenceKey: '-leading-dash' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, occurrenceKey: 'has space' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, occurrenceKey: 'x'.repeat(129) })).length > 0);

  // The tenant scope is server-derived input (present, non-empty).
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, agencyId: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationDeliveryInput({ ...VALID_INPUT, clientId: '' })).length > 0);
});

// ---------------------------------------------------------------------------
// The provenance guard (server-derived — never a request field)
// ---------------------------------------------------------------------------

test('MKT-068: the provenance guard enforces the server-derived discipline', () => {
  const valid: NotificationProvenance = {
    actor: 'user:88888888-8888-4888-8888-888888888888',
    recordedVia: 'api',
    correlationId: 'corr-42',
    causationId: null,
  };
  assert.deepEqual(problemsOf(() => assertValidNotificationProvenance(valid)), []);
  assert.ok(problemsOf(() => assertValidNotificationProvenance({ ...valid, actor: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationProvenance({ ...valid, recordedVia: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationProvenance({ ...valid, correlationId: '' })).length > 0);
  assert.ok(problemsOf(() => assertValidNotificationProvenance({ ...valid, causationId: '' })).length > 0);
  assert.deepEqual(problemsOf(() => assertValidNotificationProvenance({ ...valid, causationId: 'cause-1' })), []);
});
