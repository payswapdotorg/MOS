/**
 * /notification-delivery pure input guards, registry builder, receipt
 * composers and idempotency/policy-key helpers (the
 * social-accounts/grant-validation precedent: every guard is a PURE
 * function, exported through public.ts so the guard semantics are part
 * of the module contract and unit-pinnable without a database).
 *
 * Three responsibilities:
 *
 *   - INPUT GUARDS: the RecordNotificationInput / provenance validation
 *     with the frozen vocabularies, the §14 field bounds, the email
 *     context payload shape and the §21 material-key backstop (no
 *     material-shaped value can even be smuggled into a notification
 *     field);
 *   - THE ADAPTER REGISTRY BUILDER: validates adapter registrations as
 *     DATA (unique channel, non-empty legal acceptance subsets) and
 *     builds the channel → adapter map;
 *   - THE RECEIPT COMPOSERS + THE PURE IDEMPOTENCY/STATUS MATH: the
 *     honest receipt shapes for every pipeline outcome (adapter
 *     outcome, duplicate-skip, unregistered channel, acceptance
 *     mismatch, policy refusal), the policy-gate operation-key
 *     derivation, the duplicate-fence violation classification and the
 *     delivery-status derivation from the receipt tail (the
 *     duplicate_skipped receipts never participate — they are not
 *     delivery outcomes).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_SOURCE_KINDS,
  NOTIFICATION_URGENCIES,
  channelAccepts,
  type ChannelAcceptance,
  type NotificationChannel,
  type NotificationDeliveryReceipt,
  type NotificationDeliveryRecord,
  type NotificationDeliveryProvenance,
  type NotificationReceiptOutcome,
  type NotificationDeliveryAdapter,
  type RecordNotificationInput,
} from '../public.ts';

export { channelAccepts as acceptanceCovers };

// ---------------------------------------------------------------------------
// Bounds (the §14 field bounds — mirrored by the migration-047 CHECKs)
// ---------------------------------------------------------------------------

export const MAX_EXPLANATION_LENGTH = 2000;
export const MAX_REQUIRED_ACTION_LENGTH = 512;
export const MAX_DEEP_LINK_LENGTH = 1024;
export const MAX_OCCURRENCE_KEY_LENGTH = 128;
export const MAX_REASON_LENGTH = 512;
export const MAX_CHANNELS = 6;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEEP_LINK_PATTERN = /^(\/[^\s]*|https?:\/\/[^\s]+)$/;

/**
 * The §21 material-shaped backstop (the POLICY_MATERIAL_SHAPED_KEYS
 * posture): no notification input value may be material-shaped — the
 * delivery plane carries vault REFERENCES, never secrets.
 */
const MATERIAL_SHAPED_VALUES =
  /^(sk-|sek-|ghp_|github_pat_|AKIA|AIza|xox[baprs]|Bearer\s|-----BEGIN)/i;

/** The migration-047 vocabulary strings, pinned verbatim for the boundary tests. */
export const NOTIFICATION_CHANNEL_VOCABULARY = [
  'in-app',
  'email',
  'whatsapp',
  'telegram',
  'sms',
  'signal',
] as const;
export const NOTIFICATION_URGENCY_VOCABULARY = [
  'low',
  'normal',
  'high',
  'critical',
] as const;
export const NOTIFICATION_EVENT_TYPE_VOCABULARY = [
  'mission.state_changed',
  'mission.blocked_pending_human_action',
  'execution.failed',
  'execution.unknown_outcome',
  'workflow.attention_required',
] as const;
export const NOTIFICATION_SOURCE_KIND_VOCABULARY = [
  'mission',
  'execution',
  'workflow',
  'job',
] as const;

// ---------------------------------------------------------------------------
// Input guards (pure)
// ---------------------------------------------------------------------------

/**
 * Validates the full RecordNotificationInput: the tenant scope shape
 * (UUIDs; the client/workspace narrowing ids), the frozen vocabularies
 * (event type, urgency, source kind, channels — duplicate-free,
 * non-empty), the §14 field bounds (explanation, required action NULLABLE,
 * deep link), the occurrence-key bound, the EMAIL CONTEXT payload shape
 * (recipient user id + vault reference id REQUIRED exactly when the email
 * channel is requested) and the §21 material-key backstop. Fail-closed
 * by rejection (InvalidRequestError).
 */
export function assertValidRecordNotificationInput(input: RecordNotificationInput): void {
  const problems: string[] = [];

  if (!UUID_PATTERN.test(input.agencyId)) {
    problems.push('agencyId: a canonical agency UUID is required');
  }
  if (input.clientId !== null && !UUID_PATTERN.test(input.clientId)) {
    problems.push('clientId: must be null or a canonical client UUID');
  }
  if (input.workspaceId !== null && !UUID_PATTERN.test(input.workspaceId)) {
    problems.push('workspaceId: must be null or a canonical workspace UUID');
  }
  if (!UUID_PATTERN.test(input.source.id)) {
    problems.push('source.id: the producing authority record id must be a canonical UUID (recorded verbatim)');
  }
  if (!(NOTIFICATION_SOURCE_KINDS as readonly string[]).includes(input.source.kind)) {
    problems.push(
      `source.kind: '${String(input.source.kind)}' is not one of the frozen source kinds (${NOTIFICATION_SOURCE_KINDS.join(', ')})`,
    );
  }
  if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(input.eventType)) {
    problems.push(
      `eventType: '${String(input.eventType)}' is not one of the frozen event types (${NOTIFICATION_EVENT_TYPES.join(', ')})`,
    );
  }
  if (!(NOTIFICATION_URGENCIES as readonly string[]).includes(input.urgency)) {
    problems.push(
      `urgency: '${String(input.urgency)}' is not one of the frozen urgencies (${NOTIFICATION_URGENCIES.join(', ')})`,
    );
  }
  if (typeof input.explanation !== 'string' || input.explanation.trim().length < 1 || input.explanation.length > MAX_EXPLANATION_LENGTH) {
    problems.push(`explanation: the human-readable explanation is required (1..${MAX_EXPLANATION_LENGTH} chars)`);
  }
  if (
    input.requiredAction !== null &&
    (typeof input.requiredAction !== 'string' ||
      input.requiredAction.trim().length < 1 ||
      input.requiredAction.length > MAX_REQUIRED_ACTION_LENGTH)
  ) {
    problems.push(`requiredAction: must be null or 1..${MAX_REQUIRED_ACTION_LENGTH} chars`);
  }
  if (
    typeof input.deepLink !== 'string' ||
    input.deepLink.length < 1 ||
    input.deepLink.length > MAX_DEEP_LINK_LENGTH ||
    !DEEP_LINK_PATTERN.test(input.deepLink)
  ) {
    problems.push(
      `deepLink: 1..${MAX_DEEP_LINK_LENGTH} chars, an absolute console path (/...) or an http(s) URL`,
    );
  }
  if (
    typeof input.occurrenceKey !== 'string' ||
    input.occurrenceKey.trim().length < 1 ||
    input.occurrenceKey.length > MAX_OCCURRENCE_KEY_LENGTH
  ) {
    problems.push(`occurrenceKey: 1..${MAX_OCCURRENCE_KEY_LENGTH} chars (the idempotency fence key component)`);
  }
  if (!Array.isArray(input.channels) || input.channels.length < 1 || input.channels.length > MAX_CHANNELS) {
    problems.push(`channels: a non-empty channel set (1..${MAX_CHANNELS})`);
  } else {
    const seen = new Set<string>();
    for (const channel of input.channels) {
      if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
        problems.push(`channels: '${String(channel)}' is not one of the frozen channel keys (${NOTIFICATION_CHANNELS.join(', ')})`);
        break;
      }
      if (seen.has(channel)) {
        problems.push(`channels: duplicate channel '${channel}' — the requested channel set is a set`);
        break;
      }
      seen.add(channel);
    }
  }
  const wantsEmail = (input.channels as readonly string[]).includes('email');
  if (wantsEmail) {
    if (input.recipientUserId === null || !UUID_PATTERN.test(input.recipientUserId)) {
      problems.push('recipientUserId: a canonical MOS user id is REQUIRED when the email channel is requested (the address resolves only through the recipient port)');
    }
    if (input.emailCredentialReferenceId === null || !UUID_PATTERN.test(input.emailCredentialReferenceId)) {
      problems.push('emailCredentialReferenceId: a /credentials vault reference id is REQUIRED when the email channel is requested (never material — §21)');
    }
  } else {
    if (input.recipientUserId !== null || input.emailCredentialReferenceId !== null) {
      problems.push('recipientUserId/emailCredentialReferenceId: the email context is legal ONLY when the email channel is requested');
    }
  }

  // The §21 material-key backstop over every string field.
  for (const [field, value] of [
    ['explanation', input.explanation],
    ['requiredAction', input.requiredAction],
    ['deepLink', input.deepLink],
    ['occurrenceKey', input.occurrenceKey],
  ] as const) {
    if (typeof value === 'string' && MATERIAL_SHAPED_VALUES.test(value)) {
      problems.push(`${field}: material-shaped values are rejected outright (§21 — the delivery plane carries vault references, never secrets)`);
    }
  }

  if (problems.length > 0) {
    throw new InvalidRequestError(`invalid notification-delivery input: ${problems.join('; ')}`);
  }
}

/** Validates the SERVER-DERIVED provenance shape (the §3 contract). */
export function assertValidNotificationProvenance(
  provenance: NotificationDeliveryProvenance,
): void {
  const problems: string[] = [];
  if (typeof provenance.actor !== 'string' || provenance.actor.trim().length < 1 || provenance.actor.length > 100) {
    problems.push('actor: 1..100 chars (server-derived)');
  }
  if (typeof provenance.recordedVia !== 'string' || provenance.recordedVia.trim().length < 1 || provenance.recordedVia.length > 100) {
    problems.push('recordedVia: 1..100 chars (server-derived)');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.trim().length < 1) {
    problems.push('correlationId: required (server-derived)');
  }
  if (provenance.causationId !== null && (typeof provenance.causationId !== 'string' || provenance.causationId.trim().length < 1)) {
    problems.push('causationId: must be null or a non-empty id');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(`invalid notification-delivery provenance: ${problems.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------
// The adapter registry (DATA validation — pure)
// ---------------------------------------------------------------------------

/**
 * Builds the channel → adapter registry from the registered adapter
 * instances. Construction fails loudly (the MKT-023 precedent) on a
 * duplicate channel registration or a malformed acceptance declaration
 * (empty subsets or values outside the frozen vocabularies).
 */
export function buildAdapterRegistry(
  adapters: readonly NotificationDeliveryAdapter[],
): ReadonlyMap<NotificationChannel, NotificationDeliveryAdapter> {
  const registry = new Map<NotificationChannel, NotificationDeliveryAdapter>();
  for (const adapter of adapters) {
    if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(adapter.channel)) {
      throw new InvalidRequestError(
        `adapter registration: channel '${String(adapter.channel)}' is not one of the frozen channel keys`,
      );
    }
    if (registry.has(adapter.channel)) {
      throw new InvalidRequestError(
        `adapter registration: channel '${adapter.channel}' is registered twice — one adapter per channel`,
      );
    }
    assertValidAcceptance(adapter.channel, adapter.acceptance);
    registry.set(adapter.channel, adapter);
  }
  return registry;
}

function assertValidAcceptance(channel: NotificationChannel, acceptance: ChannelAcceptance): void {
  const problems: string[] = [];
  if (!Array.isArray(acceptance.urgencies) || acceptance.urgencies.length < 1) {
    problems.push('acceptance.urgencies: a non-empty urgency subset is required');
  } else {
    for (const urgency of acceptance.urgencies) {
      if (!(NOTIFICATION_URGENCIES as readonly string[]).includes(urgency)) {
        problems.push(`acceptance.urgencies: '${String(urgency)}' is outside the frozen urgency vocabulary`);
        break;
      }
    }
  }
  if (!Array.isArray(acceptance.eventTypes) || acceptance.eventTypes.length < 1) {
    problems.push('acceptance.eventTypes: a non-empty event-type subset is required');
  } else {
    for (const eventType of acceptance.eventTypes) {
      if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(eventType)) {
        problems.push(`acceptance.eventTypes: '${String(eventType)}' is outside the frozen event-type vocabulary`);
        break;
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError(
      `adapter registration for channel '${channel}': ${problems.join('; ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Policy-gate key derivation (pure)
// ---------------------------------------------------------------------------

/**
 * The per-channel policy gate key (AC-3): `notification.channel.<channel>`
 * on the network dimension (the delivery-egress dimension this plane
 * uniformly consults — the social-account.complete precedent; the
 * in-app internal channel is gated through the SAME engine per the
 * per-channel-gate contract).
 */
export function channelPolicyOperation(channel: NotificationChannel): string {
  return `notification.channel.${channel}`;
}

/** The email credential-use gate key: `notification.email.credential` (the secrets dimension). */
export function emailCredentialPolicyOperation(): string {
  return 'notification.email.credential';
}

// ---------------------------------------------------------------------------
// Receipt composers (pure)
// ---------------------------------------------------------------------------

/** The receipt insert shape (the store's append input). */
export interface ReceiptInsert {
  readonly notificationId: string;
  readonly agencyId: string;
  readonly channel: NotificationChannel;
  readonly attemptSeq: number;
  readonly outcome: NotificationReceiptOutcome;
  readonly reason: string | null;
  readonly providerMessageId: string | null;
  readonly policyDecisionId: string | null;
  readonly recordedActor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

function clampReason(reason: string | null): string | null {
  if (reason === null) return null;
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > MAX_REASON_LENGTH ? `${trimmed.slice(0, MAX_REASON_LENGTH - 3)}...` : trimmed;
}

/** Composes one honest receipt from an adapter attempt outcome. */
export function composeReceipt(input: {
  readonly notification: Pick<NotificationDeliveryRecord, 'notificationId' | 'agencyId'>;
  readonly channel: NotificationChannel;
  readonly attemptSeq: number;
  readonly outcome: Exclude<NotificationReceiptOutcome, 'duplicate_skipped'>;
  readonly reason: string | null;
  readonly providerMessageId: string | null;
  readonly policyDecisionId: string | null;
  readonly provenance: NotificationDeliveryProvenance;
}): ReceiptInsert {
  return {
    notificationId: input.notification.notificationId,
    agencyId: input.notification.agencyId,
    channel: input.channel,
    attemptSeq: input.attemptSeq,
    outcome: input.outcome,
    reason: clampReason(input.reason),
    providerMessageId:
      input.outcome === 'delivered' || input.outcome === 'failed' ? input.providerMessageId : null,
    policyDecisionId: input.outcome === 'refused' ? input.policyDecisionId : null,
    recordedActor: input.provenance.actor,
    recordedVia: input.provenance.recordedVia,
    correlationId: input.provenance.correlationId,
    causationId: input.provenance.causationId,
  };
}

/** Composes the honest DUPLICATE-SKIPPED receipt of a replayed occurrence (AC-5). */
export function composeDuplicateSkippedReceipt(input: {
  readonly notification: Pick<NotificationDeliveryRecord, 'notificationId' | 'agencyId'>;
  readonly channel: NotificationChannel;
  readonly attemptSeq: number;
  readonly provenance: NotificationDeliveryProvenance;
}): ReceiptInsert {
  return {
    notificationId: input.notification.notificationId,
    agencyId: input.notification.agencyId,
    channel: input.channel,
    attemptSeq: input.attemptSeq,
    outcome: 'duplicate_skipped',
    reason: 'the occurrence was already recorded — the idempotency fence stopped this replay (no second delivery)',
    providerMessageId: null,
    policyDecisionId: null,
    recordedActor: input.provenance.actor,
    recordedVia: input.provenance.recordedVia,
    correlationId: input.provenance.correlationId,
    causationId: input.provenance.causationId,
  };
}

/** Composes the honest refused receipt of a channel with NO registered adapter (the future keys). */
export function composeUnregisteredChannelReceipt(input: {
  readonly notification: Pick<NotificationDeliveryRecord, 'notificationId' | 'agencyId'>;
  readonly channel: NotificationChannel;
  readonly attemptSeq: number;
  readonly provenance: NotificationDeliveryProvenance;
}): ReceiptInsert {
  return composeReceipt({
    notification: input.notification,
    channel: input.channel,
    attemptSeq: input.attemptSeq,
    outcome: 'refused',
    reason: `no delivery adapter is registered for channel '${input.channel}' in this composition (the declared-but-unimplemented future capability keys are refused honestly, never silently dropped)`,
    providerMessageId: null,
    policyDecisionId: null,
    provenance: input.provenance,
  });
}

/** Composes the honest refused receipt of an acceptance-mismatch attempt (AC-2/AC-3). */
export function composeAcceptanceMismatchReceipt(input: {
  readonly notification: Pick<
    NotificationDeliveryRecord,
    'notificationId' | 'agencyId' | 'urgency' | 'eventType'
  >;
  readonly channel: NotificationChannel;
  readonly acceptance: ChannelAcceptance;
  readonly attemptSeq: number;
  readonly provenance: NotificationDeliveryProvenance;
}): ReceiptInsert {
  const missingUrgency = !(input.acceptance.urgencies as readonly string[]).includes(input.notification.urgency);
  return composeReceipt({
    notification: input.notification,
    channel: input.channel,
    attemptSeq: input.attemptSeq,
    outcome: 'refused',
    reason: `channel '${input.channel}' is not sanctioned for this notification (${missingUrgency ? `urgency '${input.notification.urgency}'` : `event type '${input.notification.eventType}'`} is outside the channel's declared acceptance — fail-closed)`,
    providerMessageId: null,
    policyDecisionId: null,
    provenance: input.provenance,
  });
}

/** Composes the honest refused receipt of a policy-gate denial (AC-3). */
export function composePolicyRefusedReceipt(input: {
  readonly notification: Pick<NotificationDeliveryRecord, 'notificationId' | 'agencyId'>;
  readonly channel: NotificationChannel;
  readonly attemptSeq: number;
  readonly decisionId: string;
  readonly reasonCode: string;
  readonly provenance: NotificationDeliveryProvenance;
}): ReceiptInsert {
  return composeReceipt({
    notification: input.notification,
    channel: input.channel,
    attemptSeq: input.attemptSeq,
    outcome: 'refused',
    reason: `policy denied the channel delivery (decision ${input.decisionId}, reason '${input.reasonCode}' — fail-closed, never a silent drop)`,
    providerMessageId: null,
    policyDecisionId: input.decisionId,
    provenance: input.provenance,
  });
}

/** Composes the bounded retry reason for a failed attempt's next receipt. */
export function composeRetryReason(channel: NotificationChannel, cause: string): string | null {
  return clampReason(`retry of channel '${channel}' after: ${cause}`);
}

// ---------------------------------------------------------------------------
// Idempotency classification + the delivery-status math (pure)
// ---------------------------------------------------------------------------

/**
 * True when the thrown database error is the duplicate-fence unique
 * violation (the migration-047 fence index) — the race-safe replay
 * signal (a concurrent double-submit converges on the duplicate path).
 */
export function isDuplicateFenceViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const coded = error as { code?: unknown; constraint?: unknown };
  if (coded.code !== '23505') return false;
  return (
    coded.constraint === 'notification_dedup_fence_unique' ||
    coded.constraint === 'notification_delivery_dedup_fence_pkey'
  );
}

/**
 * THE DELIVERY-STATUS MATH (pure): derives the adapter-plane
 * delivery_status from the requested channel set and the receipt tail.
 * For every requested channel, the LATEST non-duplicate_skipped receipt
 * decides the channel state (delivered / not delivered); a channel with
 * no real attempt receipts yet counts as not delivered. All delivered →
 * 'delivered'; none → 'undelivered'; some → 'partial'. The
 * duplicate_skipped receipts NEVER participate (they are fence facts,
 * not delivery outcomes).
 */
export function deriveDeliveryStatus(
  requestedChannels: readonly NotificationChannel[],
  receipts: readonly Pick<NotificationDeliveryReceipt, 'channel' | 'outcome'>[],
): 'pending' | 'delivered' | 'partial' | 'undelivered' {
  const real = receipts.filter((receipt) => receipt.outcome !== 'duplicate_skipped');
  const latestByChannel = new Map<NotificationChannel, Pick<NotificationDeliveryReceipt, 'channel' | 'outcome'>>();
  for (const receipt of real) {
    latestByChannel.set(receipt.channel, receipt);
  }
  let deliveredCount = 0;
  let attemptedCount = 0;
  for (const channel of requestedChannels) {
    const latest = latestByChannel.get(channel);
    if (latest === undefined) continue;
    attemptedCount += 1;
    if (latest.outcome === 'delivered') deliveredCount += 1;
  }
  if (attemptedCount === 0) return 'pending';
  if (deliveredCount === requestedChannels.length) return 'delivered';
  if (deliveredCount === 0) return 'undelivered';
  return 'partial';
}

/** New receipt ids come from the module's id generator (kept here for composability). */
export function newReceiptId(ids: IdGenerator): string {
  return ids.newId();
}
