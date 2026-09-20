/**
 * /notification-delivery persistence (the migration-047 tables — the
 * social-accounts store precedent).
 *
 * DB backstops (migration 047):
 *   - the notification record's §14 field set, scope chain, requested
 *     channel set, email context and creation provenance are IMMUTABLE
 *     (trigger); the ONLY mutable columns are the adapter-plane
 *     delivery lifecycle (delivery_status — the frozen transition
 *     table, delivered TERMINAL), updated_at and the CAS version;
 *     DELETE is rejected outright;
 *   - the receipt tail is FULLY append-only (UPDATE/DELETE rejected
 *     outright) with the per-(notification, channel) attempt sequence
 *     uniqueness backstopping the gapless sequence integrity;
 *   - the dedup fence is a GLOBAL unique index on (source kind, source
 *     id, event type, occurrence key) — the race-safe idempotency
 *     backstop; fence rows are immutable;
 *   - the inbox projection rows are born unread; the single sanctioned
 *     transition is unread → read (terminal, read facts set exactly
 *     once); DELETE is rejected outright;
 *   - the scope-chain triggers (client-within-agency,
 *     workspace-within-client, receipt/inbox agency consistency) and
 *     the FKs (agencies, clients, workspaces, users,
 *     credential_references) backstop the tenant fences.
 *
 * Every mutation takes the transaction RUNNER as its first argument
 * (the credentials-store pattern): the module passes the pool for
 * standalone reads and the locked transaction for the multi-step
 * sequences (record+fence atomicity, receipt+inbox+status atomicity).
 *
 * The tables have NO column capable of carrying secret material — the
 * email credential is the /credentials logical-name identity only (§21).
 * This store is the module's SINGLE DML home: the adapters contain no
 * SQL (the static boundary test pins the discipline).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow, DbTransaction } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  NotificationChannel,
  NotificationDeliveryProvenance,
  NotificationDeliveryRecord,
  NotificationDeliveryReceipt,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationInboxEntry,
  NotificationReadStatus,
  NotificationSourceKind,
  NotificationUrgency,
} from '../public.ts';
import type { ReceiptInsert } from './delivery-validation.ts';

interface NotificationRow extends DbRow {
  notification_id: string;
  agency_id: string;
  client_id: string | null;
  workspace_id: string | null;
  event_type: string;
  urgency: string;
  explanation: string;
  source_kind: string;
  source_id: string;
  required_action: string | null;
  deep_link: string;
  requested_channels: unknown;
  recipient_user_id: string | null;
  email_credential_reference_id: string | null;
  delivery_status: string;
  version: string | number;
  created_at: Date;
  updated_at: Date;
}

interface ReceiptRow extends DbRow {
  receipt_id: string;
  notification_id: string;
  agency_id: string;
  channel: string;
  attempt_seq: string | number;
  outcome: string;
  reason: string | null;
  provider_message_id: string | null;
  policy_decision_id: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface InboxRow extends DbRow {
  notification_id: string;
  agency_id: string;
  read_status: string;
  read_at: Date | null;
  read_by_actor: string | null;
  version: string | number;
  created_at: Date;
  event_type: string;
  urgency: string;
  explanation: string;
  source_kind: string;
  source_id: string;
  required_action: string | null;
  deep_link: string;
  client_id: string | null;
}

interface FenceRow extends DbRow {
  fence_id: string;
  source_kind: string;
  source_id: string;
  event_type: string;
  occurrence_key: string;
  agency_id: string;
  notification_id: string;
}

const NOTIFICATION_SELECT = `
  SELECT notification_id, agency_id, client_id, workspace_id, event_type, urgency, explanation,
         source_kind, source_id, required_action, deep_link, requested_channels,
         recipient_user_id, email_credential_reference_id, delivery_status,
         version, created_at, updated_at
  FROM notification_records
`;

const INBOX_SELECT = `
  SELECT i.notification_id, i.agency_id, i.read_status, i.read_at, i.read_by_actor, i.version, i.created_at,
         n.client_id, n.event_type, n.urgency, n.explanation, n.source_kind, n.source_id,
         n.required_action, n.deep_link
  FROM notification_inbox_states i
  JOIN notification_records n ON n.notification_id = i.notification_id
`;

function toChannels(raw: unknown): NotificationChannel[] {
  if (Array.isArray(raw)) return raw.map((value) => String(value) as NotificationChannel);
  return [];
}

function toNotificationRecord(row: NotificationRow): NotificationDeliveryRecord {
  return {
    notificationId: row.notification_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    workspaceId: row.workspace_id,
    eventType: row.event_type as NotificationEventType,
    urgency: row.urgency as NotificationUrgency,
    explanation: row.explanation,
    source: { kind: row.source_kind as NotificationSourceKind, id: row.source_id },
    requiredAction: row.required_action,
    deepLink: row.deep_link,
    requestedChannels: toChannels(row.requested_channels),
    recipientUserId: row.recipient_user_id,
    emailCredentialReferenceId: row.email_credential_reference_id,
    deliveryStatus: row.delivery_status as NotificationDeliveryStatus,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toReceipt(row: ReceiptRow): NotificationDeliveryReceipt {
  return {
    receiptId: row.receipt_id,
    notificationId: row.notification_id,
    agencyId: row.agency_id,
    channel: row.channel as NotificationChannel,
    attemptSeq: Number(row.attempt_seq),
    outcome: row.outcome as NotificationDeliveryReceipt['outcome'],
    reason: row.reason,
    providerMessageId: row.provider_message_id,
    policyDecisionId: row.policy_decision_id,
    recordedActor: row.recorded_actor,
    recordedVia: row.recorded_via,
    correlationId: row.correlation_id,
    causationId: row.causation_id,
    recordedAt: row.recorded_at.toISOString(),
  };
}

function toInboxEntry(row: InboxRow): NotificationInboxEntry {
  return {
    notificationId: row.notification_id,
    agencyId: row.agency_id,
    clientId: row.client_id,
    eventType: row.event_type as NotificationEventType,
    urgency: row.urgency as NotificationUrgency,
    explanation: row.explanation,
    source: { kind: row.source_kind as NotificationSourceKind, id: row.source_id },
    requiredAction: row.required_action,
    deepLink: row.deep_link,
    readStatus: row.read_status as NotificationReadStatus,
    readAt: row.read_at === null ? null : row.read_at.toISOString(),
    readByActor: row.read_by_actor,
    version: Number(row.version),
    createdAt: row.created_at.toISOString(),
  };
}

/** The write-input shape of the notification record insert. */
export interface NotificationRecordInsert {
  readonly notificationId: string;
  readonly agencyId: string;
  readonly clientId: string | null;
  readonly workspaceId: string | null;
  readonly eventType: NotificationEventType;
  readonly urgency: NotificationUrgency;
  readonly explanation: string;
  readonly sourceKind: NotificationSourceKind;
  readonly sourceId: string;
  readonly requiredAction: string | null;
  readonly deepLink: string;
  readonly channels: readonly string[];
  readonly recipientUserId: string | null;
  readonly emailCredentialReferenceId: string | null;
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
  // Notification records
  // -------------------------------------------------------------------------

  /**
   * Appends the notification record (born 'pending') — the caller runs
   * this inside the record+fence transaction. FK/scope-chain violations
   * are mapped to the uniform NotFoundError (unknown agency/client/
   * workspace — no existence oracle); the vocabulary/shape violations
   * surface as the database's own rejection (the module guards ran
   * first — a violation here is a module bug, loudly surfaced).
   */
  async insertNotification(
    runner: DbTransaction,
    input: NotificationRecordInsert,
    provenance: NotificationDeliveryProvenance,
  ): Promise<NotificationDeliveryRecord> {
    const now = new Date(this.clock.nowIso());
    try {
      await runner.query(
        `INSERT INTO notification_records
           (notification_id, agency_id, client_id, workspace_id, event_type, urgency, explanation,
            source_kind, source_id, required_action, deep_link, requested_channels,
            recipient_user_id, email_credential_reference_id, delivery_status,
            created_by_actor, created_via, correlation_id, causation_id,
            created_at, updated_at, version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, 'pending',
                 $15, $16, $17, $18, $19, $19, 1)`,
        [
          input.notificationId,
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
          JSON.stringify(input.channels),
          input.recipientUserId,
          input.emailCredentialReferenceId,
          provenance.actor,
          provenance.recordedVia,
          provenance.correlationId,
          provenance.causationId,
          now,
        ],
      );
    } catch (error) {
      throw classifyRecordInsert(error, input);
    }
    const created = await this.notificationVia(runner, input.notificationId);
    if (created === null) {
      throw new Error(`inserted notification ${input.notificationId} could not be read back`);
    }
    return created;
  }

  async getNotification(notificationId: string): Promise<NotificationDeliveryRecord | null> {
    return this.notificationVia(this.db, notificationId);
  }

  /** The record read on the CALLER'S runner (transactional read-backs). */
  async notificationVia(
    runner: DbTransaction,
    notificationId: string,
  ): Promise<NotificationDeliveryRecord | null> {
    const result = await runner.query<NotificationRow>(
      `${NOTIFICATION_SELECT} WHERE notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toNotificationRecord(row);
  }

  /**
   * Locks the notification row FOR UPDATE (the receipt-append serializer:
   * the per-(notification, channel) gapless attempt sequence is computed
   * under this lock) — null when unknown.
   */
  async lockNotification(
    runner: DbTransaction,
    notificationId: string,
  ): Promise<NotificationDeliveryRecord | null> {
    const result = await runner.query<NotificationRow>(
      `${NOTIFICATION_SELECT} WHERE notification_id = $1 FOR UPDATE`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toNotificationRecord(row);
  }

  async listNotificationsForAgency(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
  }): Promise<readonly NotificationDeliveryRecord[]> {
    const result =
      input.clientId === null
        ? await this.db.query<NotificationRow>(
            `${NOTIFICATION_SELECT} WHERE agency_id = $1 ORDER BY created_at DESC, notification_id DESC LIMIT 200`,
            [input.agencyId],
          )
        : await this.db.query<NotificationRow>(
            `${NOTIFICATION_SELECT} WHERE agency_id = $1 AND client_id = $2 ORDER BY created_at DESC, notification_id DESC LIMIT 200`,
            [input.agencyId, input.clientId],
          );
    return result.rows.map(toNotificationRecord);
  }

  /**
   * THE ADAPTER-PLANE STATUS MOVE (CAS): the frozen transition table is
   * enforced by the trigger (delivered TERMINAL; pending → the three
   * terminal-ish outcomes; the same-move UPDATE is legal and only bumps
   * version/updated_at so retries converge idempotently).
   */
  async setDeliveryStatus(
    runner: DbTransaction,
    input: {
      readonly notificationId: string;
      readonly status: NotificationDeliveryStatus;
      readonly expectedVersion: number;
    },
  ): Promise<NotificationDeliveryRecord> {
    const now = new Date(this.clock.nowIso());
    try {
      const result = await runner.query<NotificationRow>(
        `UPDATE notification_records
         SET delivery_status = $1, updated_at = $2, version = version + 1
         WHERE notification_id = $3 AND version = $4
         RETURNING notification_id, agency_id, client_id, workspace_id, event_type, urgency, explanation,
                   source_kind, source_id, required_action, deep_link, requested_channels,
                   recipient_user_id, email_credential_reference_id, delivery_status,
                   version, created_at, updated_at`,
        [input.status, now, input.notificationId, input.expectedVersion],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ConflictError(
          `notification ${input.notificationId} version ${input.expectedVersion} was superseded — reload and retry`,
        );
      }
      return toNotificationRecord(row);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('the adapter-plane delivery lifecycle is terminal')) {
        throw new ConflictError(
          `notification ${input.notificationId} is delivered — the adapter-plane delivery lifecycle is terminal`,
        );
      }
      if (message.includes('illegal notification delivery-status transition')) {
        throw new ConflictError(
          `illegal delivery-status transition on notification ${input.notificationId} (target '${input.status}')`,
        );
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // The dedup fence
  // -------------------------------------------------------------------------

  /** The fence lookup: the notification id of an already-recorded occurrence, if any. */
  async findFence(
    input: {
      readonly sourceKind: NotificationSourceKind;
      readonly sourceId: string;
      readonly eventType: NotificationEventType;
      readonly occurrenceKey: string;
    },
  ): Promise<{ readonly notificationId: string; readonly agencyId: string } | null> {
    const result = await this.db.query<FenceRow>(
      `SELECT fence_id, source_kind, source_id, event_type, occurrence_key, agency_id, notification_id
       FROM notification_delivery_dedup_fence
       WHERE source_kind = $1 AND source_id = $2 AND event_type = $3 AND occurrence_key = $4`,
      [input.sourceKind, input.sourceId, input.eventType, input.occurrenceKey],
    );
    const row = result.rows[0];
    return row === undefined ? null : { notificationId: row.notification_id, agencyId: row.agency_id };
  }

  /** Appends the fence row (inside the record+fence transaction). */
  async insertFence(
    runner: DbTransaction,
    input: {
      readonly notificationId: string;
      readonly agencyId: string;
      readonly sourceKind: NotificationSourceKind;
      readonly sourceId: string;
      readonly eventType: NotificationEventType;
      readonly occurrenceKey: string;
    },
  ): Promise<void> {
    await runner.query(
      `INSERT INTO notification_delivery_dedup_fence
         (fence_id, source_kind, source_id, event_type, occurrence_key, agency_id, notification_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        this.ids.newId(),
        input.sourceKind,
        input.sourceId,
        input.eventType,
        input.occurrenceKey,
        input.agencyId,
        input.notificationId,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // The append-only receipt tail
  // -------------------------------------------------------------------------

  /**
   * The next per-(notification, channel) attempt sequence — computed
   * under the caller's row lock (lockNotification): 1 for the first
   * attempt, +1 per retry. The UNIQUE index backstops the gapless
   * sequence integrity.
   */
  async nextAttemptSeq(
    runner: DbTransaction,
    notificationId: string,
    channel: string,
  ): Promise<number> {
    const result = await runner.query<{ max_seq: string | number | null }>(
      `SELECT COALESCE(MAX(attempt_seq), 0) AS max_seq
       FROM notification_delivery_receipts
       WHERE notification_id = $1 AND channel = $2`,
      [notificationId, channel],
    );
    return Number(result.rows[0]?.max_seq ?? 0) + 1;
  }

  /**
   * Appends ONE receipt (fully append-only — the DB rejects UPDATE/DELETE
   * outright; the receipt id is generated here so the composer stays
   * pure).
   */
  async appendReceipt(
    runner: DbTransaction,
    insert: ReceiptInsert,
  ): Promise<NotificationDeliveryReceipt> {
    const receiptId = this.ids.newId();
    const recordedAt = new Date(this.clock.nowIso());
    await runner.query(
      `INSERT INTO notification_delivery_receipts
         (receipt_id, notification_id, agency_id, channel, attempt_seq, outcome, reason,
          provider_message_id, policy_decision_id, recorded_actor, recorded_via,
          correlation_id, causation_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        receiptId,
        insert.notificationId,
        insert.agencyId,
        insert.channel,
        insert.attemptSeq,
        insert.outcome,
        insert.reason,
        insert.providerMessageId,
        insert.policyDecisionId,
        insert.recordedActor,
        insert.recordedVia,
        insert.correlationId,
        insert.causationId,
        recordedAt,
      ],
    );
    return {
      receiptId,
      notificationId: insert.notificationId,
      agencyId: insert.agencyId,
      channel: insert.channel,
      attemptSeq: insert.attemptSeq,
      outcome: insert.outcome,
      reason: insert.reason,
      providerMessageId: insert.providerMessageId,
      policyDecisionId: insert.policyDecisionId,
      recordedActor: insert.recordedActor,
      recordedVia: insert.recordedVia,
      correlationId: insert.correlationId,
      causationId: insert.causationId,
      recordedAt: recordedAt.toISOString(),
    };
  }

  /** The append-only receipt tail of one notification (attempt order). */
  async listReceipts(notificationId: string): Promise<readonly NotificationDeliveryReceipt[]> {
    return this.listReceiptsVia(this.db, notificationId);
  }

  /** The receipt tail on the CALLER'S runner (transactional reads). */
  async listReceiptsVia(
    runner: DbTransaction,
    notificationId: string,
  ): Promise<readonly NotificationDeliveryReceipt[]> {
    const result = await runner.query<ReceiptRow>(
      `SELECT receipt_id, notification_id, agency_id, channel, attempt_seq, outcome, reason,
              provider_message_id, policy_decision_id, recorded_actor, recorded_via,
              correlation_id, causation_id, recorded_at
       FROM notification_delivery_receipts
       WHERE notification_id = $1
       ORDER BY recorded_at ASC, attempt_seq ASC, receipt_id ASC`,
      [notificationId],
    );
    return result.rows.map(toReceipt);
  }

  // -------------------------------------------------------------------------
  // The in-app projection (the console read surface)
  // -------------------------------------------------------------------------

  /**
   * Appends the inbox projection row (born 'unread') — the IN-APP
   * delivery effect, appended ATOMICALLY with the delivered receipt.
   * The scope/in-app-channel consistency triggers backstop the insert.
   */
  async insertInboxState(
    runner: DbTransaction,
    input: {
      readonly notificationId: string;
      readonly agencyId: string;
    },
  ): Promise<void> {
    await runner.query(
      `INSERT INTO notification_inbox_states (inbox_state_id, notification_id, agency_id)
       VALUES ($1, $2, $3)`,
      [this.ids.newId(), input.notificationId, input.agencyId],
    );
  }

  async listInbox(input: {
    readonly agencyId: string;
    readonly clientId: string | null;
    readonly unreadOnly: boolean;
  }): Promise<readonly NotificationInboxEntry[]> {
    const filters: string[] = ['i.agency_id = $1'];
    const params: (string | boolean)[] = [input.agencyId];
    if (input.clientId !== null) {
      params.push(input.clientId);
      filters.push(`n.client_id = $${params.length}`);
    }
    if (input.unreadOnly) {
      filters.push('i.read_status = \'unread\'');
    }
    const result = await this.db.query<InboxRow>(
      `${INBOX_SELECT} WHERE ${filters.join(' AND ')}
       ORDER BY i.created_at DESC, i.notification_id DESC LIMIT 200`,
      params,
    );
    return result.rows.map(toInboxEntry);
  }

  async getInboxEntry(notificationId: string): Promise<NotificationInboxEntry | null> {
    const result = await this.db.query<InboxRow>(
      `${INBOX_SELECT} WHERE i.notification_id = $1`,
      [notificationId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toInboxEntry(row);
  }

  /**
   * THE SINGLE SANCTIONED INBOX TRANSITION: unread → read (CAS; the read
   * facts are server-stamped exactly once; READ is terminal — the
   * disciplined trigger rejects the reversal and every other mutation).
   */
  async markInboxRead(input: {
    readonly notificationId: string;
    readonly expectedVersion: number;
    readonly readByActor: string;
  }): Promise<NotificationInboxEntry> {
    const now = new Date(this.clock.nowIso());
    let updated = false;
    try {
      const result = await this.db.query(
        `UPDATE notification_inbox_states i
         SET read_status = 'read', read_at = $1, read_by_actor = $2, version = version + 1, updated_at = $1
         FROM notification_records n
         WHERE n.notification_id = i.notification_id
           AND i.notification_id = $3 AND i.version = $4 AND i.read_status = 'unread'`,
        [now, input.readByActor, input.notificationId, input.expectedVersion],
      );
      updated = result.rowCount === 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('the read transition is terminal')) {
        throw new ConflictError(
          `notification ${input.notificationId} is already read — the read transition is terminal`,
        );
      }
      throw error;
    }
    if (!updated) {
      // Either the row does not exist, the CAS failed, or it was already read.
      const existing = await this.getInboxEntry(input.notificationId);
      if (existing === null) {
        throw new NotFoundError('notification inbox entry', input.notificationId);
      }
      if (existing.readStatus === 'read') {
        throw new ConflictError(
          `notification ${input.notificationId} is already read — the read transition is terminal`,
        );
      }
      throw new ConflictError(
        `inbox entry version ${input.expectedVersion} was superseded — reload and retry`,
      );
    }
    const entry = await this.getInboxEntry(input.notificationId);
    if (entry === null) {
      throw new Error(`inbox entry ${input.notificationId} could not be read back`);
    }
    return entry;
  }
}

/** FK/scope-chain violation → the uniform NotFoundError (no existence oracle). */
function classifyRecordInsert(error: unknown, input: NotificationRecordInsert): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23503'
  ) {
    if (message.includes('agency_id')) return new NotFoundError('agency', input.agencyId);
    if (message.includes('client_id') && input.clientId !== null) {
      return new NotFoundError('client', input.clientId);
    }
    if (message.includes('workspace_id') && input.workspaceId !== null) {
      return new NotFoundError('workspace', input.workspaceId);
    }
    if (message.includes('recipient_user_id') && input.recipientUserId !== null) {
      return new NotFoundError('user', input.recipientUserId);
    }
    if (
      message.includes('email_credential_reference_id') &&
      input.emailCredentialReferenceId !== null
    ) {
      return new NotFoundError('credential reference', input.emailCredentialReferenceId);
    }
  }
  // The scope-chain trigger messages (client/workspace of another tenant):
  // foreign scope ≡ unknown scope — the uniform 404 (no oracle).
  if (message.includes('the tenant scope chain cannot be crossed')) {
    if (message.includes('client')) return new NotFoundError('client', input.clientId ?? '');
    return new NotFoundError('workspace', input.workspaceId ?? '');
  }
  return error;
}
