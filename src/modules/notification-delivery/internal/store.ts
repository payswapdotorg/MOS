/**
 * /notification-delivery persistence (the migration-047 tables).
 *
 * DB backstops (migration 047):
 *   - the notification rows are append-oriented: the ONLY sanctioned
 *     UPDATE is the single delivery-status fill (pending → dispatched,
 *     CAS version advanced, exactly once — the trigger is the backstop);
 *     DELETE is rejected outright (the notification_row_disciplined +
 *     notification_no_delete triggers);
 *   - the dedup fence rows are FULLY append-only (UPDATE/DELETE rejected
 *     outright) with the UNIQUE (source_kind, source_id, event_type,
 *     occurrence_key) occurrence fence — the race-free idempotency
 *     backstop (a concurrent first-delivery race converges on ONE
 *     winner; the losers surface honest duplicate-skipped receipts);
 *   - the receipt tail is FULLY append-only (UPDATE/DELETE rejected
 *     outright — retries are NEW rows, never rewrites) with the
 *     closed outcome/channel vocabularies and the honest payload-shape
 *     CHECK (delivered carries no reason; failed/refused carry the
 *     REQUIRED reason; duplicate_skipped carries neither reason nor
 *     policy decision nor provider message id);
 *   - the inbox rows carry the 1:1 notification fence (at most one inbox
 *     row per notification) with the single append-only read transition
 *     (all-NULL → all-set, exactly once, never unset — the trigger is
 *     the backstop) and no-DELETE;
 *   - the tenant scope chain is trigger-fenced on every insert/update
 *     (the client must belong to the agency; the workspace to the
 *     client).
 *
 * Every mutation takes the transaction RUNNER as its first argument
 * where composition matters (the credentials-store pattern); the
 * notification+fence claim is ONE transaction (all-or-nothing), the
 * dispatch receipts are appended OUTSIDE it (adapter calls must never
 * hold a database transaction open).
 *
 * The tables have NO column capable of carrying secret material — the
 * email provider credential is resolved through the /credentials vault
 * at delivery time and exists only in-process (a static boundary test
 * proves the absence).
 */

import { ConflictError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  NotificationDeliveryChannel,
  NotificationDeliveryOutcome,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationFenceRecord,
  NotificationInboxItemRecord,
  NotificationInboxView,
  NotificationProvenance,
  NotificationRecord,
  NotificationReceiptRecord,
  NotificationSourceKind,
  NotificationUrgency,
  PluggableNotificationChannelKey,
} from '../public.ts';

interface NotificationRow extends DbRow {
  notification_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  event_type: string;
  urgency: string;
  explanation: string;
  source_kind: string;
  source_id: string;
  required_action: string | null;
  deep_link: string;
  delivery_status: string;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

interface FenceRow extends DbRow {
  fence_id: string;
  notification_id: string;
  source_kind: string;
  source_id: string;
  event_type: string;
  occurrence_key: string;
  claimed_by_actor: string;
  claimed_via: string;
  correlation_id: string;
  causation_id: string | null;
  claimed_at: Date;
}

interface ReceiptRow extends DbRow {
  receipt_id: string;
  notification_id: string;
  channel: string;
  outcome: string;
  provider_message_id: string | null;
  reason: string | null;
  policy_decision_id: string | null;
  recorded_by_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface InboxRow extends DbRow {
  inbox_item_id: string;
  notification_id: string;
  read_at: Date | null;
  read_by_actor: string | null;
  read_via: string | null;
  read_correlation_id: string | null;
  delivered_by_actor: string;
  delivered_via: string;
  delivered_correlation_id: string;
  delivered_causation_id: string | null;
  created_at: Date;
}

const NOTIFICATION_SELECT = `
  SELECT notification_id, agency_id, client_id, workspace_id, event_type, urgency,
         explanation, source_kind, source_id, required_action, deep_link, delivery_status,
         created_by_actor, created_via, correlation_id, causation_id, created_at, updated_at, version
  FROM notifications
`;

const INBOX_JOIN_SELECT = `
  SELECT i.inbox_item_id, i.notification_id, i.read_at, i.read_by_actor,
         i.delivered_by_actor, i.delivered_via, i.delivered_correlation_id,
         i.delivered_causation_id, i.created_at AS delivered_record_created_at,
         n.notification_id AS n_notification_id, n.agency_id, n.client_id, n.workspace_id,
         n.event_type, n.urgency, n.explanation, n.source_kind, n.source_id,
         n.required_action, n.deep_link, n.delivery_status,
         n.created_by_actor, n.created_via, n.correlation_id, n.causation_id,
         n.created_at, n.updated_at, n.version
  FROM notification_inbox_items i
  JOIN notifications n ON n.notification_id = i.notification_id
`;

/** The outcome of the atomic notification+fence claim. */
export type FenceClaimResult =
  | { readonly kind: 'created'; readonly notification: NotificationRecord }
  | {
      readonly kind: 'duplicate';
      readonly notification: NotificationRecord;
      readonly fence: NotificationFenceRecord;
    };

/**
 * Classifies a PostgreSQL error as the OCCURRENCE-FENCE hit (the unique
 * violation on the migration-047 fence) — the duplicate-detection seam.
 */
function isOccurrenceFenceViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('notification_delivery_fences_occurrence_fence') ||
    (message.includes('duplicate key value violates unique constraint') &&
      message.includes('notification_delivery_fences'))
  );
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toNotificationRecord(row: NotificationRow): NotificationRecord {
  return {
    notificationId: row.notification_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type as NotificationEventType,
    urgency: row.urgency as NotificationUrgency,
    explanation: row.explanation,
    sourceKind: row.source_kind as NotificationSourceKind,
    sourceId: row.source_id,
    requiredAction: row.required_action,
    deepLink: row.deep_link,
    deliveryStatus: row.delivery_status as NotificationDeliveryStatus,
    provenance: {
      actor: row.created_by_actor,
      recordedVia: row.created_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.created_at),
    },
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toFenceRecord(row: FenceRow): NotificationFenceRecord {
  return {
    fenceId: row.fence_id,
    notificationId: row.notification_id,
    sourceKind: row.source_kind as NotificationSourceKind,
    sourceId: row.source_id,
    eventType: row.event_type as NotificationEventType,
    occurrenceKey: row.occurrence_key,
    claimedAt: toIso(row.claimed_at),
    provenance: {
      actor: row.claimed_by_actor,
      recordedVia: row.claimed_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.claimed_at),
    },
  };
}

function toReceiptRecord(row: ReceiptRow): NotificationReceiptRecord {
  return {
    receiptId: row.receipt_id,
    notificationId: row.notification_id,
    channel: row.channel as NotificationDeliveryChannel | PluggableNotificationChannelKey,
    outcome: row.outcome as NotificationDeliveryOutcome,
    providerMessageId: row.provider_message_id,
    reason: row.reason,
    policyDecisionId: row.policy_decision_id,
    provenance: {
      actor: row.recorded_by_actor,
      recordedVia: row.recorded_via,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

interface InboxJoinRow extends DbRow {
  inbox_item_id: string;
  notification_id: string;
  read_at: Date | null;
  read_by_actor: string | null;
  read_via: string | null;
  read_correlation_id: string | null;
  delivered_by_actor: string;
  delivered_via: string;
  delivered_correlation_id: string;
  delivered_causation_id: string | null;
  delivered_record_created_at: Date;
  n_notification_id: string;
  agency_id: string;
  client_id: string;
  workspace_id: string | null;
  event_type: string;
  urgency: string;
  explanation: string;
  source_kind: string;
  source_id: string;
  required_action: string | null;
  deep_link: string;
  delivery_status: string;
  created_by_actor: string;
  created_via: string;
  correlation_id: string;
  causation_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: string | number;
}

function toInboxView(row: InboxJoinRow): NotificationInboxView {
  return {
    inboxItemId: row.inbox_item_id,
    notificationId: row.notification_id,
    readAt: row.read_at === null ? null : toIso(row.read_at),
    readByActor: row.read_by_actor,
    deliveredAt: toIso(row.delivered_record_created_at),
    notification: {
      notificationId: row.n_notification_id,
      agencyId: row.agency_id,
      clientId: row.client_id,
      workspaceId: row.workspace_id,
      eventType: row.event_type as NotificationEventType,
      urgency: row.urgency as NotificationUrgency,
      explanation: row.explanation,
      sourceKind: row.source_kind as NotificationSourceKind,
      sourceId: row.source_id,
      requiredAction: row.required_action,
      deepLink: row.deep_link,
      deliveryStatus: row.delivery_status as NotificationDeliveryStatus,
      provenance: {
        actor: row.created_by_actor,
        recordedVia: row.created_via,
        correlationId: row.correlation_id,
        causationId: row.causation_id,
        recordedAt: toIso(row.created_at),
      },
      version: Number(row.version),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    },
  };
}

export class NotificationDeliveryStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  // -------------------------------------------------------------------------
  // The atomic notification + fence claim (the idempotency seam)
  // -------------------------------------------------------------------------

  /**
   * Claims the event occurrence in ONE transaction: inserts the
   * notification record (born 'pending') and its fence row together —
   * all-or-nothing. The unique occurrence fence makes the claim
   * race-free: a concurrent or replayed attempt that loses the claim
   * surfaces as { kind: 'duplicate' } with the WINNING notification (the
   * caller appends the honest duplicate-skipped receipts — no adapter
   * ever runs twice for one occurrence).
   */
  async claimOccurrence(
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
  ): Promise<FenceClaimResult> {
    const notificationId = this.ids.newId();
    const fenceId = this.ids.newId();
    const now = new Date(this.clock.nowIso());

    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO notifications
             (notification_id, agency_id, client_id, workspace_id, event_type, urgency,
              explanation, source_kind, source_id, required_action, deep_link, delivery_status,
              created_by_actor, created_via, correlation_id, causation_id,
              created_at, updated_at, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending',
                   $12, $13, $14, $15, $16, $16, 1)`,
          [
            notificationId,
            input.agencyId,
            input.clientId,
            input.workspaceId,
            input.eventType,
            input.urgency,
            input.explanation,
            input.sourceKind,
            input.sourceId,
            input.requiredAction,
            input.deepLink,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
        await tx.query(
          `INSERT INTO notification_delivery_fences
             (fence_id, source_kind, source_id, event_type, occurrence_key, notification_id,
              claimed_by_actor, claimed_via, correlation_id, causation_id, claimed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            fenceId,
            input.sourceKind,
            input.sourceId,
            input.eventType,
            input.occurrenceKey,
            notificationId,
            provenance.actor,
            provenance.recordedVia,
            provenance.correlationId,
            provenance.causationId,
            now,
          ],
        );
      });
    } catch (error) {
      if (isOccurrenceFenceViolation(error)) {
        // The occurrence was already claimed — surface the WINNING
        // notification for the honest duplicate-skipped receipts.
        const existing = await this.getNotificationByOccurrence(
          input.sourceKind,
          input.sourceId,
          input.eventType,
          input.occurrenceKey,
        );
        if (existing === null) {
          // The fence exists but the winning notification row is gone —
          // impossible through any sanctioned path (no-DELETE); refuse
          // fail-closed rather than guess.
          throw new ConflictError(
            'the event occurrence is fenced but its winning notification could not be resolved — fail-closed',
          );
        }
        return { kind: 'duplicate', notification: existing.notification, fence: existing.fence };
      }
      throw error;
    }

    const created = await this.getNotificationVia(this.db, notificationId);
    if (created === null) {
      throw new Error(`inserted notification ${notificationId} could not be read back`);
    }
    return { kind: 'created', notification: created };
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async getNotification(notificationId: string): Promise<NotificationRecord | null> {
    return this.getNotificationVia(this.db, notificationId);
  }

  private async getNotificationVia(
    runner: DbTransaction,
    notificationId: string,
  ): Promise<NotificationRecord | null> {
    const result = await runner.query<NotificationRow>(
      `${NOTIFICATION_SELECT} WHERE notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toNotificationRecord(row);
  }

  /** The fence + its winning notification of one event occurrence (null when unfenced). */
  async getNotificationByOccurrence(
    sourceKind: NotificationSourceKind,
    sourceId: string,
    eventType: NotificationEventType,
    occurrenceKey: string,
  ): Promise<{ notification: NotificationRecord; fence: NotificationFenceRecord } | null> {
    const fenceResult = await this.db.query<FenceRow>(
      `SELECT fence_id, notification_id, source_kind, source_id, event_type, occurrence_key,
              claimed_by_actor, claimed_via, correlation_id, causation_id, claimed_at
       FROM notification_delivery_fences
       WHERE source_kind = $1 AND source_id = $2 AND event_type = $3 AND occurrence_key = $4`,
      [sourceKind, sourceId, eventType, occurrenceKey],
    );
    const fenceRow = fenceResult.rows[0];
    if (fenceRow === undefined) return null;
    const notification = await this.getNotification(fenceRow.notification_id);
    if (notification === null) return null;
    return { notification, fence: toFenceRecord(fenceRow) };
  }

  async listNotificationsForClient(clientId: string): Promise<readonly NotificationRecord[]> {
    const result = await this.db.query<NotificationRow>(
      `${NOTIFICATION_SELECT} WHERE client_id = $1
       ORDER BY created_at DESC, notification_id DESC`,
      [clientId],
    );
    return result.rows.map(toNotificationRecord);
  }

  async listReceipts(
    notificationId: string,
  ): Promise<readonly NotificationReceiptRecord[] | null> {
    const exists = await this.getNotification(notificationId);
    if (exists === null) return null;
    const result = await this.db.query<ReceiptRow>(
      `SELECT receipt_id, notification_id, channel, outcome, provider_message_id, reason,
              policy_decision_id, recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at
       FROM notification_delivery_receipts
       WHERE notification_id = $1
       ORDER BY recorded_at ASC, receipt_id ASC`,
      [notificationId],
    );
    return result.rows.map(toReceiptRecord);
  }

  // -------------------------------------------------------------------------
  // The receipt tail (append-only)
  // -------------------------------------------------------------------------

  /** Appends ONE immutable delivery-attempt receipt. */
  async appendReceipt(
    input: {
      readonly notificationId: string;
      readonly channel: NotificationDeliveryChannel | PluggableNotificationChannelKey;
      readonly outcome: NotificationDeliveryOutcome;
      readonly providerMessageId: string | null;
      readonly reason: string | null;
      readonly policyDecisionId: string | null;
    },
    provenance: NotificationProvenance,
  ): Promise<NotificationReceiptRecord> {
    const receiptId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    await this.db.query(
      `INSERT INTO notification_delivery_receipts
         (receipt_id, notification_id, channel, outcome, provider_message_id, reason,
          policy_decision_id, recorded_by_actor, recorded_via, correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        receiptId,
        input.notificationId,
        input.channel,
        input.outcome,
        input.providerMessageId,
        input.reason,
        input.policyDecisionId,
        provenance.actor,
        provenance.recordedVia,
        provenance.correlationId,
        provenance.causationId,
        now,
      ],
    );
    return {
      receiptId,
      notificationId: input.notificationId,
      channel: input.channel,
      outcome: input.outcome,
      providerMessageId: input.providerMessageId,
      reason: input.reason,
      policyDecisionId: input.policyDecisionId,
      provenance: {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
        recordedAt: now.toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // The single delivery-status fill (pending → dispatched)
  // -------------------------------------------------------------------------

  /**
   * THE DISPATCH FILL: pending → dispatched, exactly once (CAS on the
   * stored status). Returns the updated record; a concurrent fill loss
   * re-reads and returns the already-dispatched record (convergent — the
   * fill is idempotent-visible, never an error to the caller).
   */
  async markDispatched(notificationId: string): Promise<NotificationRecord> {
    const now = new Date(this.clock.nowIso());
    const result = await this.db.query<NotificationRow>(
      `UPDATE notifications
         SET delivery_status = 'dispatched', updated_at = $2, version = version + 1
       WHERE notification_id = $1 AND delivery_status = 'pending'
       RETURNING notification_id, agency_id, client_id, workspace_id, event_type, urgency,
                 explanation, source_kind, source_id, required_action, deep_link, delivery_status,
                 created_by_actor, created_via, correlation_id, causation_id, created_at, updated_at, version`,
      [notificationId, now],
    );
    if (result.rows[0] !== undefined) return toNotificationRecord(result.rows[0]);
    const existing = await this.getNotification(notificationId);
    if (existing === null) {
      throw new Error(`notification ${notificationId} could not be read back after the dispatch fill`);
    }
    return existing;
  }

  // -------------------------------------------------------------------------
  // The in-app projection (the console read surface)
  // -------------------------------------------------------------------------

  /**
   * Appends the in-app inbox row — the in-app channel's DURABLE delivery.
   * The unique (notification_id) fence makes the in-app delivery
   * at-most-once even under concurrency: a duplicate insert is the
   * idempotent convergence (the existing row is returned, no second
   * row can exist).
   */
  async insertInboxItem(
    input: {
      readonly notificationId: string;
    },
    provenance: NotificationProvenance,
  ): Promise<NotificationInboxItemRecord> {
    const inboxItemId = this.ids.newId();
    const now = new Date(this.clock.nowIso());
    try {
      await this.db.query(
        `INSERT INTO notification_inbox_items
           (inbox_item_id, notification_id, read_at, read_by_actor, read_via, read_correlation_id,
            delivered_by_actor, delivered_via, delivered_correlation_id, delivered_causation_id, created_at)
         VALUES ($1, $2, NULL, NULL, NULL, NULL, $3, $4, $5, $6, $7)`,
        [
          inboxItemId,
          input.notificationId,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('notification_inbox_items_notification_unique') ||
        (message.includes('duplicate key value violates unique constraint') &&
          message.includes('notification_inbox_items'))
      ) {
        // At-most-once convergence: the in-app delivery already happened.
        const existing = await this.getRawInboxItem(input.notificationId);
        if (existing !== null) return existing;
      }
      throw error;
    }
    const created = await this.getRawInboxItem(input.notificationId);
    if (created === null) {
      throw new Error(`inserted inbox item for ${input.notificationId} could not be read back`);
    }
    return created;
  }

  private async getRawInboxItem(
    notificationId: string,
  ): Promise<NotificationInboxItemRecord | null> {
    const result = await this.db.query<InboxRow>(
      `SELECT inbox_item_id, notification_id, read_at, read_by_actor, read_via, read_correlation_id,
              delivered_by_actor, delivered_via, delivered_correlation_id, delivered_causation_id, created_at
       FROM notification_inbox_items WHERE notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      inboxItemId: row.inbox_item_id,
      notificationId: row.notification_id,
      readAt: row.read_at === null ? null : toIso(row.read_at),
      readByActor: row.read_by_actor,
      deliveredAt: toIso(row.created_at),
    };
  }

  async getInboxItem(notificationId: string): Promise<NotificationInboxView | null> {
    const result = await this.db.query<InboxJoinRow>(
      `${INBOX_JOIN_SELECT} WHERE i.notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInboxView(row);
  }

  async listInboxItems(
    clientId: string,
    filter?: {
      readonly workspaceId?: string | null;
      readonly unreadOnly?: boolean;
    },
  ): Promise<readonly NotificationInboxView[]> {
    return this.listInboxItemsWhere(clientId, filter);
  }

  async listInboxItemsForWorkspace(workspaceId: string): Promise<readonly NotificationInboxView[]> {
    return this.listInboxItemsWhere(null, { workspaceId });
  }

  private async listInboxItemsWhere(
    clientId: string | null,
    filter?: {
      readonly workspaceId?: string | null;
      readonly unreadOnly?: boolean;
    },
  ): Promise<readonly NotificationInboxView[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (clientId !== null) {
      params.push(clientId);
      conditions.push(`n.client_id = $${params.length}`);
    }
    if (filter?.workspaceId !== undefined && filter.workspaceId !== null) {
      params.push(filter.workspaceId);
      conditions.push(`n.workspace_id = $${params.length}`);
    }
    if (filter?.workspaceId === null) {
      conditions.push(`n.workspace_id IS NULL`);
    }
    if (filter?.unreadOnly === true) {
      conditions.push(`i.read_at IS NULL`);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const result = await this.db.query<InboxJoinRow>(
      `${INBOX_JOIN_SELECT} ${where}
       ORDER BY i.created_at DESC, i.inbox_item_id DESC`,
      params as never[],
    );
    return result.rows.map(toInboxView);
  }

  // -------------------------------------------------------------------------
  // The single read transition (append-only: set exactly once)
  // -------------------------------------------------------------------------

  /**
   * THE READ FILL: read_at/read_by/read_via/read_correlation set exactly
   * once (all-NULL → all-set). Returns:
   *   - { kind: 'read' } with the updated view;
   *   - { kind: 'already-read' } when the item was read before (the
   *     honest idempotent-visible convergence — the caller surfaces the
   *     ConflictError);
   *   - null when no inbox item exists for the notification.
   */
  async markInboxItemRead(
    notificationId: string,
    provenance: NotificationProvenance,
  ): Promise<
    | { readonly kind: 'read'; readonly view: NotificationInboxView }
    | { readonly kind: 'already-read'; readonly view: NotificationInboxView }
    | null
  > {
    const now = new Date(this.clock.nowIso());
    const result = await this.db.query(
      `UPDATE notification_inbox_items
         SET read_at = $2, read_by_actor = $3, read_via = $4, read_correlation_id = $5
       WHERE notification_id = $1 AND read_at IS NULL`,
      [notificationId, now, provenance.actor, provenance.recordedVia, provenance.correlationId],
    );
    if (result.rowCount === 1) {
      const view = await this.getInboxItem(notificationId);
      if (view === null) {
        throw new Error(`inbox item of notification ${notificationId} could not be read back after the read fill`);
      }
      return { kind: 'read', view };
    }
    // Zero matched rows: either no inbox item exists at all (null) or the
    // item was already read (the honest already-read convergence).
    const view = await this.getInboxItem(notificationId);
    if (view === null) return null;
    return view.readAt === null
      ? null
      : { kind: 'already-read', view };
  }
}
