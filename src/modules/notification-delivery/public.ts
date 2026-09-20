/**
 * MarketingOS module: /notification-delivery
 * Authority: Notification Delivery (spec/architecture-v1.6.md §14;
 * spec/effective-backlog-v1.6.md MKT-068; spec/
 * module-dependency-matrix-v1.6.md row /notification-delivery →
 * /notifications, /policies, /credentials and boundary rule 9:
 * "Notification Delivery delivers messages only; it does not become
 * canonical task/action state").
 *
 * This module fills the DELIVERY plane the /notifications boundary
 * (MKT-001 — a boundary-only stub: name + authority, no business logic)
 * reserved: the agency-scoped durable NOTIFICATION RECORDS carrying the
 * full §14 field set (event type, urgency, human-readable explanation,
 * source reference — the producing authority's kind + canonical id —,
 * required action NULLABLE, deep link) and the delivery adapters that
 * fan them out per channel.
 *
 * This module owns:
 *
 *   - the DELIVERY-ADAPTER CONTRACT: a platform-neutral adapter interface
 *     registered as DATA (the /integrations adapter-registry and
 *     /social-accounts flow-registry precedents — instances arrive through
 *     the module dependencies, validated at construction, and are wired
 *     at the composition root ONLY, the sanctioned internal/adapters/**
 *     home). The two MVP implementations ship in this delivery: IN-APP
 *     (delivery = the durable in-app projection readable through this
 *     public entry — the future console surface) and EMAIL (recipient
 *     address resolution through the recipient-address structural port,
 *     provider credential material resolved through the /credentials
 *     vault READ-ONLY after a fail-closed /policies allow, and the send
 *     through the disclosed provider TRANSPORT SEAM — a deterministic
 *     test double in tests, the disclosed unwired transport in the
 *     production composition until the provider wiring arrives). The
 *     future channels (WhatsApp, Telegram, SMS, Signal) are
 *     DECLARABLE-BUT-UNIMPLEMENTED capability keys: the channel
 *     vocabulary is frozen with all six keys, a request naming a future
 *     channel is honestly REFUSED with a receipt (no adapter registered),
 *     never silently dropped;
 *   - the PER-CHANNEL POLICY GATES (MKT-068 AC-3): every channel attempt
 *     passes the existing /policies engine BEFORE the adapter runs —
 *     operation key `notification.channel.<channel>` on the network
 *     dimension (the delivery-egress dimension this plane uniformly
 *     consults; the social-account.complete precedent) with the channel,
 *     urgency and event type as selector attributes, plus the secrets-
 *     dimension gate `notification.email.credential` in front of every
 *     email credential-material resolution (the social-account.credential
 *     precedent). A channel not sanctioned for the urgency/event type
 *     FAILS CLOSED: the honest refused receipt records the outcome and
 *     the policy decision id — never a silent drop;
 *   - the IDEMPOTENCY FENCE (AC-5): exactly one notification per
 *     (source kind, source id, event type, occurrence key) — a replayed
 *     event never double-delivers; the second attempt surfaces the honest
 *     duplicate-skipped receipt referencing the EXISTING notification.
 *     The fence is globally unique (canonical producer UUIDs cannot
 *     collide across tenants) and DB-backstopped;
 *   - the APPEND-ONLY RECEIPT TAIL: every delivery attempt (first
 *     fan-out, retry, replay-skip) is an immutable receipt record —
 *     channel, attempt sequence, adapter outcome, provider message id
 *     when present, policy decision id when a gate decided, timestamp,
 *     server-derived provenance. Retries append NEW receipts and never
 *     rewrite; UPDATE and DELETE are rejected by the database outright;
 *   - the IN-APP READ SURFACE (AC-6): the inbox projection (read/unread
 *     state with the single sanctioned unread → read transition, READ
 *     terminal — append-only transitions) readable through this public
 *     entry: the surface the future Growth Autopilot Console (MKT-074)
 *     consumes.
 *
 * What this module deliberately does NOT do (boundary rule 9 — the
 * delivery plane is NOT task/action state):
 *   - it NEVER records "task done", "action taken" or any business/task
 *     state: delivery_status is the ADAPTER-plane lifecycle ONLY
 *     (pending → delivered | partial | undelivered); there is no
 *     acknowledgment-of-work, no completion, no workflow/execution/mission
 *     state anywhere in its tables or its vocabulary (a static boundary
 *     test pins the absence of task/action-state verbs);
 *   - it does NOT author notification policy: the /policies authority
 *     (MKT-021) stays the sole policy engine — this plane only CONSULTS
 *     it fail-closed per channel attempt;
 *   - it does NOT store or see secret material: the email provider
 *     credential is a /credentials vault REFERENCE id on the record
 *     (§21); material resolves ONLY in-process, inside the sanctioned
 *     email adapter subtree, after the fail-closed allow — the module
 *     core and the store never touch it;
 *   - it does NOT resolve recipient addresses from caller data: the
 *     address arrives ONLY through the recipient-address structural
 *     port (no address guessing — a raw address is not even a field on
 *     any input surface);
 *   - it does NOT implement the future channel adapters (WhatsApp/
 *     Telegram/SMS/Signal are declared capability keys — honest refused
 *     receipts until their deliveries register real adapters).
 *
 * DEPENDENCY POSTURE (frozen matrix: /notification-delivery ──→
 * /notifications, /policies, /credentials): this public entry imports
 * the /notifications boundary entry DIRECTLY (the delivery plane serves
 * behind the Notifications authority — validated at construction) and
 * the /policies + /credentials public contracts DIRECTLY (the only
 * matrix-allowed module dependencies). The recipient-address resolution
 * and the email provider transport arrive through DECLARED STRUCTURAL
 * PORTS (the /app-installs + /policies→/credentials port precedent —
 * deliberately off-matrix, wired at the composition root, disclosed in
 * the module-dependency-matrix authority note and the runbook): the
 * recipient address composes the canonical /users identity with the
 * /agencies membership authority (the workspace/client context — an
 * address exists for the delivery plane ONLY when the recipient is an
 * ACTIVE member of the notification's agency); the transport is the
 * provider seam.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check). The concrete MVP adapters
 * under internal/adapters/** are importable ONLY by the composition root
 * (the sanctioned adapter-wiring exception) and the tests.
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { notificationsModule } from '../notifications/public.ts';
import type { CredentialsModuleApi } from '../credentials/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (MKT-068 — CHECK-fenced in migration 047;
// pinned by unit tests)
// ---------------------------------------------------------------------------

/**
 * The frozen channel vocabulary (§14: "MVP: in-app and email. Future
 * adapters: WhatsApp, Telegram, SMS, Signal and additional channels").
 * The four future keys are DECLARABLE-BUT-UNIMPLEMENTED capability keys:
 * a notification may request them (the record carries the channel), but
 * no adapter ships in this delivery — the attempt is honestly refused
 * with a receipt (never silently dropped) until the future Work Items
 * register real adapters.
 */
export type NotificationChannel = 'in-app' | 'email' | 'whatsapp' | 'telegram' | 'sms' | 'signal';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'in-app',
  'email',
  'whatsapp',
  'telegram',
  'sms',
  'signal',
];

/** The two channels whose adapters SHIP in this delivery (the §14 MVP). */
export const MVP_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['in-app', 'email'];

/** The declared-but-unimplemented future capability keys (§14). */
export const FUTURE_NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
  'whatsapp',
  'telegram',
  'sms',
  'signal',
];

/**
 * The frozen urgency vocabulary (§14 "urgency"). Four levels, the
 * standard escalation ladder; CHECK-fenced in migration 047.
 */
export type NotificationUrgency = 'low' | 'normal' | 'high' | 'critical';

export const NOTIFICATION_URGENCIES: readonly NotificationUrgency[] = [
  'low',
  'normal',
  'high',
  'critical',
];

/**
 * The frozen event-type vocabulary (§14 "event type") — the MVP set
 * grounded in the authorities that EXIST at this Work Item's base: the
 * growth-mission lifecycle states (MKT-053 — including the explicit
 * blocked-pending-human-action blocker of the v1.6 human-growth rules),
 * the execution lifecycle (failure and the first-class UNKNOWN outcome
 * that requires reconciliation) and the workflow attention surface
 * (approvals/attention). Future producers extend the vocabulary through
 * a disclosed migration (the append-only house discipline); the delivery
 * plane records the event type VERBATIM and never interprets it.
 */
export type NotificationEventType =
  | 'mission.state_changed'
  | 'mission.blocked_pending_human_action'
  | 'execution.failed'
  | 'execution.unknown_outcome'
  | 'workflow.attention_required';

export const NOTIFICATION_EVENT_TYPES: readonly NotificationEventType[] = [
  'mission.state_changed',
  'mission.blocked_pending_human_action',
  'execution.failed',
  'execution.unknown_outcome',
  'workflow.attention_required',
];

/**
 * The frozen source-kind vocabulary (§14 "source/mission reference"):
 * the producing authority families that exist at this base. The source
 * id is the producer's CANONICAL record id (a UUID) recorded VERBATIM —
 * the delivery plane never re-derives producer state.
 */
export type NotificationSourceKind = 'mission' | 'execution' | 'workflow' | 'job';

export const NOTIFICATION_SOURCE_KINDS: readonly NotificationSourceKind[] = [
  'mission',
  'execution',
  'workflow',
  'job',
];

/**
 * The frozen receipt-outcome vocabulary (the adapter-plane attempt
 * outcomes): delivered (the adapter delivered), failed (the adapter
 * attempted and the provider/transport failed — retryable), refused
 * (fail-closed refusal: policy denial, acceptance mismatch, no adapter,
 * unresolved recipient/credential — not retryable without a change),
 * duplicate_skipped (the idempotency fence stopped a REPLAYED event —
 * not a delivery outcome and never part of the record's
 * delivery_status computation).
 */
export type NotificationReceiptOutcome =
  | 'delivered'
  | 'failed'
  | 'refused'
  | 'duplicate_skipped';

export const NOTIFICATION_RECEIPT_OUTCOMES: readonly NotificationReceiptOutcome[] = [
  'delivered',
  'failed',
  'refused',
  'duplicate_skipped',
];

/**
 * The frozen ADAPTER-PLANE delivery lifecycle (§14 "delivery status"):
 * pending at birth; delivered (every requested channel's latest attempt
 * delivered), partial (some delivered, some not) or undelivered (no
 * channel delivered) after a fan-out or retry. `delivered` is TERMINAL.
 * This is the ONLY lifecycle on the record — there is NO task/action
 * state anywhere (boundary rule 9).
 */
export type NotificationDeliveryStatus = 'pending' | 'delivered' | 'partial' | 'undelivered';

export const NOTIFICATION_DELIVERY_STATUSES: readonly NotificationDeliveryStatus[] = [
  'pending',
  'delivered',
  'partial',
  'undelivered',
];

export const NOTIFICATION_DELIVERY_TRANSITIONS: Readonly<
  Record<NotificationDeliveryStatus, readonly NotificationDeliveryStatus[]>
> = {
  pending: ['delivered', 'partial', 'undelivered'],
  delivered: [],
  partial: ['delivered', 'partial', 'undelivered'],
  undelivered: ['delivered', 'partial', 'undelivered'],
};

export function isLegalNotificationDeliveryTransition(
  from: NotificationDeliveryStatus,
  to: NotificationDeliveryStatus,
): boolean {
  return NOTIFICATION_DELIVERY_TRANSITIONS[from].includes(to);
}

/** The frozen in-app read-state vocabulary (the inbox projection). */
export type NotificationReadStatus = 'unread' | 'read';

export const NOTIFICATION_READ_STATUSES: readonly NotificationReadStatus[] = ['unread', 'read'];

/** The single sanctioned inbox transition: unread → read (terminal). */
export const NOTIFICATION_READ_TRANSITIONS: Readonly<
  Record<NotificationReadStatus, readonly NotificationReadStatus[]>
> = {
  unread: ['read'],
  read: [],
};

export function isLegalNotificationReadTransition(
  from: NotificationReadStatus,
  to: NotificationReadStatus,
): boolean {
  return NOTIFICATION_READ_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Records (the durable shapes of migration 047)
// ---------------------------------------------------------------------------

/**
 * One durable NOTIFICATION RECORD (migration 047): the agency-scoped §14
 * field set with the requested channel set and the email channel
 * context. The record carries NO secret material of any kind (§21 — the
 * email credential is a /credentials vault REFERENCE id) and NO
 * task/action state (boundary rule 9 — delivery_status is the
 * adapter-plane lifecycle only).
 */
export interface NotificationDeliveryRecord {
  readonly notificationId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  readonly explanation: string;
  readonly source: {
    readonly kind: NotificationSourceKind;
    readonly id: string;
  };
  readonly requiredAction: string | null;
  readonly deepLink: string;
  readonly requestedChannels: readonly NotificationChannel[];
  readonly recipientUserId: string | null;
  readonly emailCredentialReferenceId: string | null;
  readonly deliveryStatus: NotificationDeliveryStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * One immutable row of the append-only delivery-attempt tail (migration
 * 047): the channel, the per-(notification, channel) attempt sequence,
 * the adapter outcome, the honest bounded reason, the provider message
 * id when the adapter obtained one, the policy decision id when a
 * /policies gate decided a refusal, and the SERVER-DERIVED provenance.
 * Retries append NEW receipts; the recorded attempt history is immutable
 * fact (UPDATE/DELETE rejected by the database).
 */
export interface NotificationDeliveryReceipt {
  readonly receiptId: string;
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
  readonly recordedAt: string;
}

/**
 * One row of the in-app projection read state (migration 047): the
 * console read surface. Born 'unread' at in-app delivery; the single
 * sanctioned transition is unread → read (terminal — an acknowledged
 * notification is never un-acknowledged).
 */
export interface NotificationInboxEntry {
  readonly notificationId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  readonly explanation: string;
  readonly source: {
    readonly kind: NotificationSourceKind;
    readonly id: string;
  };
  readonly requiredAction: string | null;
  readonly deepLink: string;
  readonly readStatus: NotificationReadStatus;
  readonly readAt: string | null;
  readonly readByActor: string | null;
  readonly version: number;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// The DeliveryAdapter contract (MKT-068 AC-2 — the platform-neutral,
// pluggable adapter interface)
// ---------------------------------------------------------------------------

/**
 * The channel ACCEPTANCE declaration: the urgency and event-type subsets
 * this channel's adapter accepts. An attempt whose urgency or event type
 * falls outside the declared subset is REFUSED fail-closed with an
 * honest receipt (a channel not sanctioned for the urgency/event type
 * never delivers — AC-3).
 */
export interface ChannelAcceptance {
  /** The urgency subset the channel accepts (non-empty, from the frozen vocabulary). */
  readonly urgencies: readonly NotificationUrgency[];
  /** The event-type subset the channel accepts (non-empty, from the frozen vocabulary). */
  readonly eventTypes: readonly NotificationEventType[];
}

/** True when the declared acceptance covers the (urgency, event type) pair (pure). */
export function channelAccepts(
  acceptance: ChannelAcceptance,
  urgency: NotificationUrgency,
  eventType: NotificationEventType,
): boolean {
  return (
    (acceptance.urgencies as readonly string[]).includes(urgency) &&
    (acceptance.eventTypes as readonly string[]).includes(eventType)
  );
}

/** The §14 delivery facts handed to an adapter attempt (non-secret). */
export interface AdapterDeliveryRequest {
  /** The notification's §14 facts + tenant scope (NO secret material). */
  readonly notification: NotificationDeliveryRecord;
  /** The attempt identity: the per-(notification, channel) sequence and time. */
  readonly attempt: {
    readonly attemptSeq: number;
    readonly attemptedAt: string;
  };
  /** The acting SERVER-DERIVED provenance (for adapter-internal policy gates). */
  readonly provenance: NotificationDeliveryProvenance;
}

/**
 * THE ADAPTER OUTCOME: the adapter-plane result of one delivery attempt.
 *   delivered — the channel delivered (providerMessageId when the
 *               provider returned one);
 *   failed     — the adapter attempted and the provider/transport failed
 *               (honest bounded reason; retryable);
 *   refused    — fail-closed refusal (unresolved recipient, unresolved
 *               credential, policy denial inside the adapter's credential
 *               gate...; honest bounded reason; not retryable without a
 *               change).
 * Adapters NEVER throw for channel-level outcomes — outcomes are data;
 * only unexpected internal errors surface as exceptions (the module
 * records the honest failed receipt). policyDecisionId carries the
 * deciding /policies decision when an adapter-internal gate (the email
 * credential gate) refused the attempt.
 */
export interface AdapterDeliveryOutcome {
  readonly outcome: 'delivered' | 'failed' | 'refused';
  readonly reason: string | null;
  readonly providerMessageId: string | null;
  /** The deciding /policies decision id when an adapter-internal gate refused. */
  readonly policyDecisionId?: string | null;
}

/**
 * THE PROVIDER-NEUTRAL DELIVERY-ADAPTER CONTRACT (AC-2): one
 * implementation per channel, registered as DATA through the module
 * dependencies (the /integrations adapter-registry precedent) and wired
 * at the composition root (the sanctioned internal/adapters/** home —
 * the static architecture checker allows exactly the composition root
 * and tests to import concrete adapters). Pluggable per channel without
 * module changes: a future channel plugs in by registering a new
 * adapter instance; the module's per-channel pipeline (acceptance →
 * policy gate → adapter → receipt) is channel-agnostic.
 *
 * The in-app adapter's delivery effect is the MODULE-OWNED durable
 * projection (migration 047's notification_inbox_states), appended
 * ATOMICALLY with the delivered receipt — the adapter decides, the
 * module persists: ALL SQL lives in the module store (the single DML
 * home), so every adapter is storage-free and the DB fences stay sole.
 */
export interface NotificationDeliveryAdapter {
  /** The channel this adapter serves (unique in the registry). */
  readonly channel: NotificationChannel;
  /** The urgency/event-type subsets this channel accepts. */
  readonly acceptance: ChannelAcceptance;
  /** Performs ONE delivery attempt. Outcomes are data, never throws for channel-level results. */
  deliver(request: AdapterDeliveryRequest): Promise<AdapterDeliveryOutcome>;
}

// ---------------------------------------------------------------------------
// The email provider seam (MKT-068 AC-7 — the disclosed transport port)
// ---------------------------------------------------------------------------

/**
 * THE EMAIL PROVIDER TRANSPORT SEAM: the boundary between the email
 * ADAPTER (recipient resolution, vault credential resolution, message
 * rendering — all real, all in this delivery) and the concrete provider
 * send (SMTP relay / email API). The seam ships so the adapter's
 * provider dependency is a PORT, never a hard-wired SDK: tests supply
 * the DETERMINISTIC IN-REPO TEST DOUBLE (no real network calls in the
 * test suite); the production composition wires the DISCLOSED UNWIRED
 * transport (honest failed receipts: 'provider transport not wired')
 * until the provider-wiring work item lands a real transport over the
 * platform HttpCallPort. A real transport implementation lives under
 * the sanctioned adapter subtree and is wired at the composition root
 * ONLY (no provider SDK import outside that subtree — AC-4).
 */
export interface EmailTransport {
  /**
   * Sends one rendered email. `credentialMaterial` is the provider
   * credential material resolved IN-PROCESS through the /credentials
   * authorized-execution path (after the fail-closed /policies allow) —
   * it exists only for this call and is never persisted, logged or
   * audited.
   */
  send(input: {
    readonly to: string;
    readonly subject: string;
    readonly body: string;
    readonly credentialMaterial: Uint8Array;
  }): Promise<{
    readonly outcome: 'sent' | 'failed';
    readonly providerMessageId: string | null;
    readonly reason: string | null;
  }>;
}

/**
 * The DISCLOSED degenerate transport of the MVP production composition
 * (the NoCache/UnavailableLock precedent): every send honestly FAILS
 * with the unwired reason — the receipt records the truth, nothing is
 * silently dropped and no network is touched. Replaced by a real
 * transport at the composition root when the provider wiring arrives.
 */
export class UnwiredEmailTransport implements EmailTransport {
  async send(): Promise<{
    readonly outcome: 'failed';
    readonly providerMessageId: null;
    readonly reason: string;
  }> {
    return {
      outcome: 'failed',
      providerMessageId: null,
      reason:
        'email provider transport not wired in this composition (the MKT-068 disclosed seam — real provider transports arrive with the provider wiring work item)',
    };
  }
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every notification-delivery mutation
 * (the SocialAccountProvenance precedent): built exclusively from the
 * authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body. Route validation
 * rejects provenance-shaped authority fields; this type is a separate
 * module-API argument so no DTO can feed it structurally.
 */
export interface NotificationDeliveryProvenance {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

// ---------------------------------------------------------------------------
// Structural ports (the disclosed off-matrix composition seams)
// ---------------------------------------------------------------------------

/**
 * The RECIPIENT-ADDRESS RESOLUTION PORT (AC-7): the ONLY path from a
 * canonical MOS user identity to an email delivery address. Satisfied
 * at the composition root by composing the /users public contract (the
 * canonical identity + address) with the /agencies membership authority
 * (the workspace/client context): an address resolves ONLY when the
 * recipient user exists AND holds an ACTIVE membership in the
 * notification's agency — never from caller data, never guessed (the
 * /app-installs structural-port precedent, deliberately off-matrix and
 * disclosed).
 */
export interface RecipientAddressResolutionPort {
  resolveRecipientAddress(input: {
    readonly userId: string;
    readonly agencyId: string;
  }): Promise<{ readonly address: string } | null>;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

/** The input of the recording + fan-out command. */
export interface RecordNotificationInput {
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  /** The human-readable explanation (§14), bounded. */
  readonly explanation: string;
  /** The producing-authority reference (§14 source/mission reference). */
  readonly source: {
    readonly kind: NotificationSourceKind;
    readonly id: string;
  };
  /**
   * The occurrence key of the idempotency fence: the producer's identity
   * of THIS occurrence of the event (bounded, non-empty). Together with
   * (source kind, source id, event type) it forms the frozen fence key —
   * a replay of the same occurrence never double-delivers.
   */
  readonly occurrenceKey: string;
  /** The required action (§14), NULLABLE. */
  readonly requiredAction: string | null;
  /** The deep link (§14), bounded. */
  readonly deepLink: string;
  /** The requested channel set (non-empty, duplicate-free, frozen vocabulary). */
  readonly channels: readonly NotificationChannel[];
  /**
   * The email recipient: a canonical MOS user id (the address resolves
   * ONLY through the recipient-address port — never caller data).
   * REQUIRED exactly when 'email' is among the channels.
   */
  readonly recipientUserId: string | null;
  /**
   * The /credentials vault REFERENCE id of the email provider credential
   * (never material — §21). REQUIRED exactly when 'email' is among the
   * channels; resolved in-process by the email adapter after the
   * fail-closed allow.
   */
  readonly emailCredentialReferenceId: string | null;
}

/** The result of the recording + fan-out command. */
export interface RecordNotificationResult {
  readonly notification: NotificationDeliveryRecord;
  /** Every receipt appended by THIS attempt (fan-out or duplicate-skip). */
  readonly receipts: readonly NotificationDeliveryReceipt[];
  /** True when the idempotency fence stopped a REPLAY (duplicate-skipped). */
  readonly duplicate: boolean;
}

/** The result of the channel retry command. */
export interface RedeliverChannelResult {
  readonly notification: NotificationDeliveryRecord;
  /** The NEW receipts appended by the retry attempt (one per requested channel). */
  readonly receipts: readonly NotificationDeliveryReceipt[];
}

/** One registered adapter's visible identity (the registry read). */
export interface RegisteredAdapterInfo {
  readonly channel: NotificationChannel;
  readonly acceptance: ChannelAcceptance;
}

export interface NotificationDeliveryModuleApi {
  /**
   * THE RECORDING + FAN-OUT COMMAND (AC-8): validates the full input
   * (§14 field set, frozen vocabularies, email context shape, provenance
   * shape — fail-closed by rejection), then:
   *
   *   1. IDEMPOTENCY FENCE (AC-5): the (source kind, source id, event
   *      type, occurrence key) lookup. A replay of an already-recorded
   *      occurrence appends the honest DUPLICATE-SKIPPED receipts (one
   *      per requested channel) referencing the EXISTING notification —
   *      never a second delivery. A fence hit whose existing notification
   *      belongs to ANOTHER agency is the uniform 404 (forged keys are
   *      not a traversal oracle);
   *   2. the notification record is born (delivery_status 'pending')
   *      together with its fence row in ONE transaction (the DB fences
   *      backstop the race);
   *   3. PER-CHANNEL FAN-OUT (AC-2/AC-3): for every requested channel —
   *      adapter lookup (none registered → honest refused receipt),
   *      acceptance check (outside the declared urgency/event-type
   *      subset → refused receipt), the /policies channel gate
   *      (notification.channel.<channel>; deny/unknown → refused receipt
   *      carrying the decision id), the email credential gate
   *      (notification.email.credential) and the material resolution for
   *      the email channel, then the adapter attempt;
   *   4. the receipts (and, for a delivered in-app attempt, the inbox
   *      projection row born 'unread') are appended atomically and the
   *      record's adapter-plane delivery_status moves per the frozen
   *      transition table.
   *
   * Adapter attempts run BETWEEN the record transaction and the receipt
   * transaction: a crash after an adapter attempt leaves the honest
   * 'pending' record (no receipt claims what did not land); the retry
   * command converges.
   */
  recordNotification(
    input: RecordNotificationInput,
    provenance: NotificationDeliveryProvenance,
  ): Promise<RecordNotificationResult>;

  /**
   * THE CHANNEL RETRY COMMAND (AC-5): re-runs the per-channel pipeline
   * (acceptance → policy gate → adapter) for ONE channel of an EXISTING
   * notification and appends the NEW receipts — never a rewrite of the
   * recorded attempt history. The adapter-plane delivery_status moves
   * per the frozen transition table (delivered is terminal — a retry on
   * a delivered channel is refused; a 'pending' record whose channel
   * never completed converges here). Unknown/foreign notification →
   * uniform 404; a channel outside the record's requested set → 409.
   */
  redeliverChannel(
    input: {
      readonly notificationId: string;
      readonly channel: NotificationChannel;
    },
    provenance: NotificationDeliveryProvenance,
  ): Promise<RedeliverChannelResult>;

  /** Raw record by id (any delivery status — the status is the visible fact). */
  getNotification(notificationId: string): Promise<NotificationDeliveryRecord | null>;

  /** The agency's records (bounded, newest first; optional client narrowing). */
  listNotificationsForAgency(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
  }): Promise<readonly NotificationDeliveryRecord[]>;

  /**
   * The append-only receipt tail of one notification (attempt order).
   * Unknown notification → uniform 404.
   */
  listReceipts(notificationId: string): Promise<readonly NotificationDeliveryReceipt[]>;

  /**
   * THE IN-APP READ SURFACE (AC-6 — the future console reads this): the
   * agency's inbox projection — the delivered in-app notifications with
   * their read/unread state (optional client narrowing and unread-only
   * filter), newest first.
   */
  listInbox(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly unreadOnly: boolean;
  }): Promise<readonly NotificationInboxEntry[]>;

  /**
   * The single sanctioned inbox transition: unread → read (terminal).
   * CAS-guarded (expectedVersion); the read facts (read_at, read_by)
   * are server-stamped exactly once from the provenance actor. Unknown
   * notification, no inbox row (never in-app delivered) or already read
   * → 404/409 honestly.
   */
  markInboxRead(
    input: {
      readonly notificationId: string;
      readonly expectedVersion: number;
    },
    provenance: NotificationDeliveryProvenance,
  ): Promise<NotificationInboxEntry>;

  /**
   * The inbox entry of one notification (the console detail read); null
   * when the notification has no in-app projection.
   */
  getInboxEntry(notificationId: string): Promise<NotificationInboxEntry | null>;

  /** The registered adapter registry (channel + declared acceptance). */
  listRegisteredAdapters(): readonly RegisteredAdapterInfo[];
}

export interface NotificationDeliveryModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Matrix-listed direction (/notification-delivery ──→ /notifications):
   * the boundary this delivery plane serves behind. Validated at
   * construction (name + authority) — the delivery plane refuses to
   * construct behind any other boundary.
   */
  readonly notifications: typeof notificationsModule;
  /**
   * Matrix-listed direction (/notification-delivery ──→ /policies): the
   * fail-closed decision engine consulted BEFORE every channel attempt
   * (notification.channel.<channel>) and every email credential-material
   * resolution (notification.email.credential). Only explicit allows
   * proceed (enforcementOutcome).
   */
  readonly policies: PoliciesModuleApi;
  /**
   * Matrix-listed direction (/notification-delivery ──→ /credentials):
   * the vault authority — the email provider credential REFERENCE is
   * resolved (authorized-execution scope, in-process only, after a
   * fail-closed allow) through this public contract. READ-ONLY: this
   * module never creates, mutates or disables a credential reference
   * (the social-accounts grant lifecycle is NOT repeated here — the
   * delivery plane owns no credentials).
   */
  readonly credentials: CredentialsModuleApi;
  /**
   * THE ADAPTER REGISTRATION SURFACE (AC-2): adapter instances as DATA
   * (the /integrations adapter-registry precedent). Validated at
   * construction (unique channel, legal acceptance subsets). The MVP
   * composition registers exactly the in-app + email adapters; future
   * channels register through this seam with NO module changes. The
   * RECIPIENT-ADDRESS structural port and the provider TRANSPORT SEAM
   * arrive with the EMAIL ADAPTER's own construction deps (see
   * EmailDeliveryAdapterDeps / the composition root).
   */
  readonly adapters: readonly NotificationDeliveryAdapter[];
}

export { createNotificationDeliveryModule } from './internal/module.ts';
/**
 * The input guards (vocabulary/shape/provenance validation with the §21
 * material-key backstop), the pure acceptance/idempotency helpers, the
 * adapter-registry builder, the receipt composers and the policy-gate
 * key derivation — exported for unit tests and future server-side
 * callers so the guard semantics are part of the module contract. Pure
 * functions.
 */
export {
  MAX_DEEP_LINK_LENGTH,
  MAX_EXPLANATION_LENGTH,
  MAX_OCCURRENCE_KEY_LENGTH,
  MAX_REASON_LENGTH,
  MAX_REQUIRED_ACTION_LENGTH,
  NOTIFICATION_EVENT_TYPE_VOCABULARY,
  NOTIFICATION_URGENCY_VOCABULARY,
  NOTIFICATION_SOURCE_KIND_VOCABULARY,
  NOTIFICATION_CHANNEL_VOCABULARY,
  assertValidRecordNotificationInput,
  assertValidNotificationProvenance,
  buildAdapterRegistry,
  channelPolicyOperation,
  composeDuplicateSkippedReceipt,
  composeReceipt,
  composeUnregisteredChannelReceipt,
  composeAcceptanceMismatchReceipt,
  composePolicyRefusedReceipt,
  deriveDeliveryStatus,
  emailCredentialPolicyOperation,
  isDuplicateFenceViolation,
} from './internal/delivery-validation.ts';
