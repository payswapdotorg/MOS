/**
 * MarketingOS module: /notification-delivery
 * Authority: Notification Delivery Plane (MKT-068 —
 * spec/effective-backlog-v1.6.md: "real delivery adapters over the existing
 * Notifications boundary. in-app/email MVP, pluggable WhatsApp/Telegram/
 * SMS/Signal adapters later, delivery receipts and idempotency";
 * spec/architecture-v1.6.md §14: "Notification is a provider-pluggable
 * capability. MVP: in-app and email. Future adapters: WhatsApp, Telegram,
 * SMS, Signal and additional channels. Every notification has event type,
 * urgency, human-readable explanation, source/mission reference, required
 * action, deep link and delivery status"; spec/
 * module-dependency-matrix-v1.6.md boundary rule 9: "Notification Delivery
 * delivers messages only; it does not become canonical task/action state").
 *
 * This module owns:
 *
 *   - the AGENCY-SCOPED durable NOTIFICATION RECORDS (migration 047)
 *     carrying the full §14 field set: event type, urgency, the
 *     human-readable explanation, the source reference (the producing
 *     authority's kind + opaque record id, carried as DATA — never
 *     resolved here), the nullable required action, the deep link (a
 *     RELATIVE console route) and the adapter-plane delivery status
 *     (pending → dispatched). Delivery status is NEVER a business/task
 *     state: the module records no "task done", no "action taken", no
 *     acknowledgement — reading an inbox message is a DELIVERY fact of the
 *     in-app projection, not an action on the notification's subject
 *     (boundary rule 9);
 *   - the DEDUP FENCE: at most one notification per (source kind, source
 *     id, event type, occurrence key). A replayed event occurrence never
 *     double-delivers — the second attempt surfaces an honest
 *     duplicate-skipped receipt on the ORIGINAL notification;
 *   - the append-only DELIVERY-ATTEMPT RECEIPTS: one immutable row per
 *     channel attempt (channel, outcome, provider message id when present,
 *     the honest refusal reason, the policy decision that gated the
 *     attempt, provenance, timestamp). Retries are NEW rows, never
 *     rewrites;
 *   - the IN-APP READ STATE projection: exactly one durable inbox row per
 *     delivered notification (the surface the future console reads), with
 *     the read/unread transition (append-only: set exactly once, never
 *     unset);
 *   - the DELIVERYADAPTER contract: a platform-neutral adapter interface
 *     with in-app and email as the two MVP implementations, pluggable per
 *     channel without module changes. Each channel declares the
 *     urgency/event-type subsets it accepts. WhatsApp/Telegram/SMS/Signal
 *     are DECLARED-but-UNIMPLEMENTED capability keys (PLUGGABLE_...
 *     below): an adapter registering one of them is refused fail-closed
 *     until its Work Item arrives.
 *
 * The per-channel POLICY GATE: every channel delivery passes the
 * existing /policies engine (the matrix-listed direction) with the
 * notification-channel policy key `notification.channel.<channel>` — a
 * channel not sanctioned for the urgency/event type FAILS CLOSED with an
 * honest refused receipt (never a silent drop).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-068):
 *   - NO notification-policy AUTHORING (which channels/urgencies a
 *     deployment prefers is /policies data — declared by operators through
 *     the existing policy-declaration surface, never re-stated here);
 *   - NO task/action state (boundary rule 9 — no done/acknowledged/
 *     acted-on column or verb exists anywhere);
 *   - NO future channel adapters (WhatsApp/Telegram/SMS/Signal are
 *     declared capability keys; their implementations are later Work
 *     Items);
 *   - NO provider SDK anywhere: the email adapter is the ONLY sanctioned
 *     provider seam subtree (internal/adapters/) and it rides the
 *     EmailTransportPort seam — a real network transport arrives at the
 *     composition root with future provider wiring;
 *   - NO worker/scheduler/retry loop: dispatch runs synchronously inside
 *     the deliverNotification command; a dispatch worker/retry plane is
 *     future Work Item territory (the receipt model already admits
 *     append-only retries).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row:
 * /notification-delivery ──→ /notifications, /policies, /credentials):
 *   - /notifications — the MKT-001 BOUNDARY this delivery plane serves
 *     (boundary identity consumed READ-ONLY; the stub keeps no business
 *     logic and this module adds none to it);
 *   - /policies — the real public contract (the fail-closed per-channel
 *     gate; every decision recorded in the policy engine's own ledger);
 *   - /credentials — the vault, consumed READ-ONLY by the email adapter
 *     (provider credential by vault REFERENCE id; never a raw secret in
 *     the module — there is no material-shaped column anywhere in
 *     migration 047).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
// The MKT-001 /notifications BOUNDARY this delivery plane serves — the
// frozen matrix direction /notification-delivery ──→ /notifications is
// the boundary identity only (the stub owns no business logic; the
// delivery plane lives HERE).
import { notificationsModule } from '../notifications/public.ts';
// The frozen matrix direction /notification-delivery ──→ /policies: the
// real public contract of the execution policy engine (fail-closed
// per-channel gate + the pure enforcement outcome).
import type { PoliciesModuleApi } from '../policies/public.ts';

/** The served /notifications boundary (the MKT-001 frozen identity). */
export const SERVED_NOTIFICATIONS_BOUNDARY = notificationsModule;

// ---------------------------------------------------------------------------
// The frozen vocabularies (nd-vocab-v1 — a change to ANY value is a NEW
// version string, never a silent re-statement)
// ---------------------------------------------------------------------------

/**
 * The closed event-type vocabulary (§14 "Every notification has event
 * type"). The set is the v1.6 operating-loop notification surface: the
 * growth-mission attention/terminal events, the execution/deployment
 * attention events, the approval gate, the platform-health anomaly, the
 * budget/quota exhaustion, the policy denial on an autonomous action and
 * the platform notice.
 */
export const NOTIFICATION_EVENT_TYPES = [
  'mission_attention_required',
  'mission_terminal',
  'execution_attention_required',
  'deployment_attention_required',
  'approval_required',
  'anomaly_detected',
  'quota_exhausted',
  'policy_denied',
  'system_notice',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

export function isKnownNotificationEventType(value: string): value is NotificationEventType {
  return (NOTIFICATION_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The closed urgency vocabulary (§14 "Every notification has urgency"):
 * routine → important → urgent → critical.
 */
export const NOTIFICATION_URGENCIES = ['routine', 'important', 'urgent', 'critical'] as const;

export type NotificationUrgency = (typeof NOTIFICATION_URGENCIES)[number];

export function isKnownNotificationUrgency(value: string): value is NotificationUrgency {
  return (NOTIFICATION_URGENCIES as readonly string[]).includes(value);
}

/**
 * The closed source-kind vocabulary — the PRODUCING AUTHORITIES whose
 * events surface as notifications (the §14 "source/mission reference"
 * kind half; the id half is the producing authority's opaque record id,
 * carried as data). The delivery plane never resolves the source.
 */
export const NOTIFICATION_SOURCE_KINDS = [
  'growth_mission',
  'execution',
  'deployment',
  'workflow_instance',
  'job',
  'experiment',
  'platform',
  'extension',
] as const;

export type NotificationSourceKind = (typeof NOTIFICATION_SOURCE_KINDS)[number];

export function isKnownNotificationSourceKind(value: string): value is NotificationSourceKind {
  return (NOTIFICATION_SOURCE_KINDS as readonly string[]).includes(value);
}

/** The adapter-plane delivery lifecycle of a notification record. */
export const NOTIFICATION_DELIVERY_STATUSES = ['pending', 'dispatched'] as const;

export type NotificationDeliveryStatus = (typeof NOTIFICATION_DELIVERY_STATUSES)[number];

/**
 * The IMPLEMENTED delivery channels (§14 MVP: in-app and email). Channels
 * register as adapters; the module core dispatches through the
 * DeliveryAdapter contract — a new channel is a new ADAPTER, not a
 * module change.
 */
export const NOTIFICATION_DELIVERY_CHANNELS = ['in_app', 'email'] as const;

export type NotificationDeliveryChannel = (typeof NOTIFICATION_DELIVERY_CHANNELS)[number];

/**
 * The DECLARED-but-UNIMPLEMENTED pluggable channel capability keys (§14
 * "Future adapters: WhatsApp, Telegram, SMS, Signal and additional
 * channels"). Registering an adapter under one of these keys is refused
 * fail-closed: the capability is declared for architecture planning, not
 * shipped — their Work Items will move a key into
 * NOTIFICATION_DELIVERY_CHANNELS as part of a NEW vocabulary version.
 */
export const PLUGGABLE_NOTIFICATION_CHANNEL_KEYS = [
  'whatsapp',
  'telegram',
  'sms',
  'signal',
] as const;

export type PluggableNotificationChannelKey = (typeof PLUGGABLE_NOTIFICATION_CHANNEL_KEYS)[number];

/** The closed receipt-outcome vocabulary of the delivery-attempt tail. */
export const NOTIFICATION_DELIVERY_OUTCOMES = [
  'delivered',
  'failed',
  'refused',
  'duplicate_skipped',
] as const;

export type NotificationDeliveryOutcome = (typeof NOTIFICATION_DELIVERY_OUTCOMES)[number];

/**
 * The frozen vocabulary version (the am-meter-v1/gm-vocab-v1 discipline):
 * the event-type, urgency, source-kind, channel, outcome and
 * delivery-status vocabularies above. A change to ANY of them is a NEW
 * version string — the vocabularies are versioned, never silently
 * re-stated.
 */
export const NOTIFICATION_DELIVERY_VOCABULARY_VERSION = 'nd-vocab-v1' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every notification-delivery command (the
 * GrowthMissionProvenance precedent): built exclusively from the
 * authenticated principal, the ambient correlation context and the
 * recording surface — never from a request body.
 */
export interface NotificationProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module' | 'test'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface NotificationRecordedProvenance extends NotificationProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 047 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted notification record — the full §14 field set. */
export interface NotificationRecord {
  readonly notificationId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  /** §14: the human-readable explanation. */
  readonly explanation: string;
  /** §14: the source reference — the producing authority kind + opaque id. */
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  /** §14: the required action (nullable — informational events carry none). */
  readonly requiredAction: string | null;
  /** §14: the deep link (a RELATIVE console route). */
  readonly deepLink: string;
  /** The adapter-plane lifecycle (pending → dispatched). NEVER task state. */
  readonly deliveryStatus: NotificationDeliveryStatus;
  readonly provenance: NotificationRecordedProvenance;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The dedup-fence claim of one event occurrence. */
export interface NotificationFenceRecord {
  readonly fenceId: string;
  readonly notificationId: string;
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  readonly eventType: NotificationEventType;
  readonly occurrenceKey: string;
  readonly claimedAt: string;
  readonly provenance: NotificationRecordedProvenance;
}

/**
 * One append-only delivery-attempt receipt. `policyDecisionId` links the
 * attempt to the /policies decision that gated it (null only on
 * duplicate-skipped receipts — the fence stops before any gate).
 */
export interface NotificationReceiptRecord {
  readonly receiptId: string;
  readonly notificationId: string;
  readonly channel: NotificationDeliveryChannel | PluggableNotificationChannelKey;
  readonly outcome: NotificationDeliveryOutcome;
  readonly providerMessageId: string | null;
  readonly reason: string | null;
  readonly policyDecisionId: string | null;
  readonly provenance: NotificationRecordedProvenance;
}

/**
 * One in-app projection row — the durable in-app DELIVERY (exactly one
 * per delivered notification) with the read/unread state. The read state
 * is a delivery fact of the projection, never a task/action state.
 */
export interface NotificationInboxItemRecord {
  readonly inboxItemId: string;
  readonly notificationId: string;
  readonly readAt: string | null;
  readonly readByActor: string | null;
  readonly deliveredAt: string;
}

/**
 * The composed inbox view: the in-app projection row JOINED with its
 * notification record (the surface the future console reads — the §14
 * content plus the read state in one row).
 */
export interface NotificationInboxView extends NotificationInboxItemRecord {
  readonly notification: NotificationRecord;
}

/** The result of one deliverNotification command. */
export interface NotificationDeliveryResult {
  readonly notification: NotificationRecord;
  /** The receipts THIS attempt produced (the dispatch tail or the duplicate-skips). */
  readonly receipts: readonly NotificationReceiptRecord[];
  /** True when the dedup fence stopped a replayed occurrence. */
  readonly duplicate: boolean;
}

// ---------------------------------------------------------------------------
// The DeliveryAdapter contract (MKT-068 AC-2 — the pluggability seam)
// ---------------------------------------------------------------------------

/** The adapter delivery input: the notification + its scope chain. */
export interface AdapterDeliveryInput {
  readonly notification: NotificationRecord;
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
  };
}

/**
 * The adapter delivery outcome: ONLY the adapter-plane truth. `delivered`
 * carries the provider's message id when the adapter obtained one (the
 * in-app projection row id for the in-app channel; the provider message
 * id for external channels). `failed` carries the honest bounded reason.
 * Policy refusal is NOT an adapter outcome: the module core runs the
 * per-channel /policies gate BEFORE any adapter call and records the
 * refused receipt itself (fail-closed — an adapter never sees a denied
 * delivery).
 */
export type AdapterDeliveryOutcome =
  | { readonly outcome: 'delivered'; readonly providerMessageId: string | null }
  | { readonly outcome: 'failed'; readonly reason: string };

/**
 * THE platform-neutral delivery adapter (§14 "provider-pluggable").
 * Implementations:
 *   - declare their channel key (an IMPLEMENTED channel — registering a
 *     declared-but-unimplemented key is refused fail-closed at module
 *     construction);
 *   - declare the urgency/event-type subsets they accept (the module core
 *     consults `accepts` before any gate or adapter call — a channel that
 *     does not accept the notification is not targeted, no receipt);
 *   - perform the channel delivery and return the honest outcome.
 *
 * MVP implementations: the in-app channel (module-internal — it persists
 * the migration-047 inbox projection) and the email channel (the
 * sanctioned provider-seam subtree internal/adapters/, wired at the
 * composition root as data). Future channels (WhatsApp/Telegram/SMS/
 * Signal) register the same way WITHOUT module changes once their keys
 * move into the implemented vocabulary.
 */
export interface NotificationDeliveryAdapter {
  /** The implemented channel key this adapter delivers through. */
  readonly channel: NotificationDeliveryChannel;
  /** The urgency subset this channel accepts. */
  readonly acceptedUrgencies: readonly NotificationUrgency[];
  /** The event-type subset this channel accepts (null = every type). */
  readonly acceptedEventTypes: readonly NotificationEventType[] | null;
  /** Whether this adapter is targeted for the given urgency/event type. */
  accepts(input: {
    readonly urgency: NotificationUrgency;
    readonly eventType: NotificationEventType;
  }): boolean;
  /** Performs the channel delivery. NEVER called for a denied policy. */
  deliver(input: AdapterDeliveryInput): Promise<AdapterDeliveryOutcome>;
}

// ---------------------------------------------------------------------------
// The per-channel policy gate key (MKT-068 AC-3)
// ---------------------------------------------------------------------------

/**
 * The notification-channel policy key of a channel: the operation label
 * the per-channel /policies gate evaluates (e.g.
 * 'notification.channel.email'). A channel not sanctioned for the
 * urgency/event type FAILS CLOSED — the module core records the honest
 * refused receipt, never a silent drop. The gate rides the `network`
 * policy dimension (the delivery plane's outbound-facing dimension; the
 * in-app channel is gated identically for uniform fail-closed sanction
 * semantics — every channel must be explicitly sanctioned, disclosed in
 * docs/implementation/MKT-068.md).
 */
export function channelPolicyKey(
  channel: NotificationDeliveryChannel | PluggableNotificationChannelKey,
): string {
  return `notification.channel.${channel}`;
}

// ---------------------------------------------------------------------------
// The email provider seam (the transport port + the recipient/credential
// resolution ports — all satisfied at the composition root)
// ---------------------------------------------------------------------------

/**
 * The EMAIL TRANSPORT PORT — the deterministic provider seam. A real
 * provider transport (SMTP/API egress over fetch — NO SDK) is future
 * composition-root wiring; the integration tests supply the
 * deterministic in-repo double (no network). The resolved provider
 * credential MATERIAL passes in-process to the transport ONLY — never
 * persisted, logged or receipted.
 */
export interface EmailTransportPort {
  send(input: {
    readonly recipients: readonly string[];
    readonly fromAddress: string;
    readonly subject: string;
    readonly body: string;
    readonly credentialMaterial: Uint8Array;
  }): Promise<{ readonly messageId: string }>;
}

/**
 * A raw operator-context candidate for recipient resolution: one agency
 * membership joined with its user identity. The pure
 * selectNotificationRecipients helper below owns the selection policy.
 */
export interface NotificationRecipientCandidate {
  readonly email: string;
  readonly membershipStatus: string;
  readonly role: string;
  readonly userStatus: string;
}

/**
 * The recipient-resolution port (satisfied structurally at the
 * composition root from the /agencies membership + /users identity
 * authorities — deliberately off-matrix wiring, the social-accounts
 * workspace-ownership port precedent). Recipients resolve from the
 * NOTIFICATION's own scope chain (the agency owning the client) — never
 * from a request body, never guessed.
 */
export interface NotificationRecipientResolutionPort {
  resolveRecipientCandidates(agencyId: string): Promise<readonly NotificationRecipientCandidate[]>;
}

/** The MAXIMUM recipient count per email delivery (the bounded fan-out). */
export const NOTIFICATION_EMAIL_MAX_RECIPIENTS = 25 as const;

/**
 * PURE recipient selection: the ACTIVE agency_owner members with active
 * user identities of the notification's owning agency — deduped, sorted,
 * bounded. This is the MVP recipient policy (disclosed): the email
 * channel notifies the accountable owners of the client's owning agency;
 * broadening to further roles is /policies-or-console territory, never
 * silent.
 */
export function selectNotificationRecipients(
  candidates: readonly NotificationRecipientCandidate[],
): readonly string[] {
  const selected = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.membershipStatus !== 'active') continue;
    if (candidate.role !== 'agency_owner') continue;
    if (candidate.userStatus !== 'active') continue;
    selected.add(candidate.email);
  }
  return [...selected].sort().slice(0, NOTIFICATION_EMAIL_MAX_RECIPIENTS);
}

/**
 * The narrow structural view of the /credentials vault the email adapter
 * consumes (READ-ONLY): provider-credential material resolution by vault
 * REFERENCE id in the notification's authorized-execution scope. The
 * concrete CredentialsModuleApi satisfies this structurally at the
 * composition root (the growth-missions structural-port precedent).
 */
export interface NotificationEmailCredentialPort {
  resolveCredentialMaterial(input: {
    readonly credentialId: string;
    readonly scope: {
      readonly kind: 'authorized-execution';
      readonly agencyId: string;
      readonly clientId: string | null;
    };
  }): Promise<{ readonly material: Uint8Array } | null>;
}

/**
 * PURE email envelope composition: the subject/body rendered from the
 * §14 notification fields (the explanation, the required action and the
 * deep link). Bounded and deterministic.
 */
export function composeNotificationEmailEnvelope(
  notification: NotificationRecord,
): { readonly subject: string; readonly body: string } {
  const subject = `[${notification.urgency}] ${notification.eventType} — ${notification.explanation}`.slice(
    0,
    500,
  );
  const lines = [
    notification.explanation,
    '',
    notification.requiredAction === null
      ? 'No specific action is required.'
      : `Required action: ${notification.requiredAction}`,
    `Open in console: ${notification.deepLink}`,
    '',
    `Source: ${notification.sourceKind} ${notification.sourceId}`,
    `Urgency: ${notification.urgency}`,
  ];
  return { subject, body: lines.join('\n').slice(0, 5000) };
}

// ---------------------------------------------------------------------------
// Canonical ownership resolution (the route-layer authorization input)
// ---------------------------------------------------------------------------

/** The canonical notification ownership context (the uniform-404 input). */
export interface NotificationOwnerContext {
  readonly scope: {
    readonly kind: 'notification';
    readonly agencyId: string;
    readonly notificationId: string;
  };
  readonly notification: NotificationRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface NotificationDeliveryModuleApi {
  /**
   * THE delivery command (the MKT-068 golden path): claims the event
   * occurrence on the dedup fence, appends the notification record (born
   * 'pending') and dispatches synchronously through every registered
   * channel that ACCEPTS the urgency/event type — the per-channel
   * /policies gate (notification.channel.<key>) runs BEFORE every adapter
   * call and a non-allow FAILS CLOSED into an honest refused receipt.
   * Every attempt (delivered/failed/refused) is an append-only receipt;
   * the record's delivery status fills pending → dispatched exactly once.
   *
   * A REPLAYED occurrence (the fence is already claimed) NEVER
   * double-delivers: no adapter runs, no gate runs — the command appends
   * one honest duplicate-skipped receipt per targeted channel on the
   * ORIGINAL notification and returns it with `duplicate: true`.
   *
   * Malformed vocabulary/shape input → InvalidRequestError (fail-closed by
   * rejection, before any write); a crossed tenant scope chain is
   * DB-backstopped (the migration-047 triggers).
   */
  deliverNotification(
    input: {
      readonly agencyId: string;
      readonly clientId: string;
      readonly workspaceId: string | null;
      readonly eventType: NotificationEventType;
      readonly urgency: NotificationUrgency;
      readonly explanation: string;
      readonly sourceKind: NotificationSourceKind;
      readonly sourceId: string;
      readonly requiredAction: string | null;
      readonly deepLink: string;
      readonly occurrenceKey: string;
    },
    provenance: NotificationProvenance,
  ): Promise<NotificationDeliveryResult>;

  /** Raw notification record by id. Null when unknown. */
  getNotification(notificationId: string): Promise<NotificationRecord | null>;

  /**
   * Canonical notification ownership resolution (the route-layer input):
   * the record + its owning agency. Null when the notification does not
   * exist — callers surface the uniform 404 so foreign and unknown
   * identifiers are indistinguishable.
   */
  resolveNotificationOwnership(notificationId: string): Promise<NotificationOwnerContext | null>;

  /** The client's notifications, newest first (all delivery statuses). */
  listNotificationsForClient(clientId: string): Promise<readonly NotificationRecord[]>;

  /**
   * The append-only receipt tail of one notification (oldest first — the
   * complete honest delivery history). Null when the notification is
   * unknown.
   */
  listNotificationReceipts(
    notificationId: string,
  ): Promise<readonly NotificationReceiptRecord[] | null>;

  /**
   * THE IN-APP READ SURFACE (the future console inbox): the client's
   * in-app projection rows JOINED with their notifications, newest first;
   * optional workspace narrowing and unread-only filtering.
   */
  listInboxItems(
    clientId: string,
    filter?: {
      readonly workspaceId?: string | null;
      readonly unreadOnly?: boolean;
    },
  ): Promise<readonly NotificationInboxView[]>;

  /** The workspace's in-app projection rows (newest first). */
  listInboxItemsForWorkspace(workspaceId: string): Promise<readonly NotificationInboxView[]>;

  /** One inbox view by notification id (the read surface's detail). Null when unknown. */
  getInboxItem(notificationId: string): Promise<NotificationInboxView | null>;

  /**
   * The READ TRANSITION of the in-app projection (append-only: read_at
   * set EXACTLY ONCE, never unset, never re-set). Unknown notification →
   * uniform NotFoundError; an already-read item → ConflictError (the
   * honest record: reading is idempotent-visible, the transition is
   * not re-recorded).
   */
  markInboxItemRead(
    input: {
      readonly notificationId: string;
    },
    provenance: NotificationProvenance,
  ): Promise<NotificationInboxView>;
}

export interface NotificationDeliveryModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Matrix-listed direction: the /policies public contract (the per-channel gate). */
  readonly policies: PoliciesModuleApi;
  /**
   * The extrinsic channel adapters, arriving as DATA (the composition
   * root is the sanctioned wiring point of the email adapter — the
   * internal/adapters/ subtree). The in-app channel is constructed
   * INTERNALLY by the module (it persists the module's own inbox
   * projection); duplicate channel keys fail construction loudly.
   */
  readonly adapters?: ReadonlyArray<NotificationDeliveryAdapter> | undefined;
}

export { createNotificationDeliveryModule } from './internal/module.ts';
/**
 * The pure input guards (delivery-input/provenance validation + the
 * adapter-registration contract checks) and the pure idempotency-fence
 * key helper — exported for unit tests and future server-side callers
 * so the guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidNotificationDeliveryInput,
  assertValidNotificationProvenance,
  composeNotificationFenceKey,
  isValidNotificationAdapterRegistration,
} from './internal/validation.ts';
