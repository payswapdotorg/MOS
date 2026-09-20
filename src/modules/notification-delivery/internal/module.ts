/**
 * /notification-delivery module implementation (MKT-068 — the
 * Notification Delivery Plane).
 *
 * The thin orchestration over the store + the adapter registry (data) +
 * the /policies fail-closed gates:
 *
 *   recordNotification:
 *     input guards (pure) → idempotency fence lookup (the replay path
 *     appends the honest duplicate-skipped receipts and STOPS — never a
 *     second delivery; a foreign-agency fence hit is the uniform 404) →
 *     record + fence in ONE transaction (born 'pending') → per-channel
 *     fan-out BETWEEN the transactions (adapter attempts are external
 *     work; no receipt claims what did not land) → receipts + the in-app
 *     projection row + the adapter-plane status move in ONE transaction.
 *
 *   The per-channel pipeline (channel-agnostic — a future channel plugs
 *   in by registering an adapter, no module changes):
 *     adapter lookup (none → honest refused receipt) → acceptance check
 *     (outside the declared urgency/event-type subset → refused receipt)
 *     → the /policies channel gate (notification.channel.<channel>, the
 *     network delivery-egress dimension; deny/unknown → refused receipt
 *     carrying the decision id) → adapter.deliver (the email adapter
 *     internally resolves the recipient address through the port, runs
 *     the secrets-dimension credential gate and resolves the vault
 *     material in-process before the transport send) → the honest
 *     receipt (delivered/failed/refused; provider message id and any
 *     deciding policy decision id when present).
 *
 *   redeliverChannel: re-runs the per-channel pipeline for ONE channel
 *   of an existing notification and appends the NEW receipts (retries
 *   never rewrite; the recorded attempt history is immutable fact); the
 *   adapter-plane status derives from the FULL receipt tail.
 *
 * Fail-closed posture everywhere: policy deny/unknown never delivers
 * (the honest refused receipt records the decision); no adapter, no
 * acceptance, no recipient, no credential → honest refused receipts; a
 * provider/transport failure → the honest failed receipt; NOTHING is
 * ever silently dropped. Boundary rule 9: the module records delivery
 * facts only — there is no task/action state anywhere (the static
 * boundary test pins the vocabulary).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import { notificationsModule } from '../../notifications/public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import type {
  NotificationChannel,
  NotificationDeliveryModuleApi,
  NotificationDeliveryModuleDeps,
  NotificationDeliveryProvenance,
  NotificationDeliveryRecord,
  NotificationDeliveryReceipt,
  NotificationInboxEntry,
  RecordNotificationInput,
  RecordNotificationResult,
  RedeliverChannelResult,
  RegisteredAdapterInfo,
} from '../public.ts';
import { channelAccepts } from '../public.ts';
import {
  assertValidNotificationProvenance,
  assertValidRecordNotificationInput,
  buildAdapterRegistry,
  channelPolicyOperation,
  composeAcceptanceMismatchReceipt,
  composeDuplicateSkippedReceipt,
  composePolicyRefusedReceipt,
  composeReceipt,
  composeUnregisteredChannelReceipt,
  deriveDeliveryStatus,
  isDuplicateFenceViolation,
  type ReceiptInsert,
} from './delivery-validation.ts';
import { NotificationDeliveryStore } from './store.ts';

export function createNotificationDeliveryModule(
  deps: NotificationDeliveryModuleDeps,
): NotificationDeliveryModuleApi {
  // THE SERVED BOUNDARY (the frozen matrix direction
  // /notification-delivery ──→ /notifications): the delivery plane serves
  // behind the Notifications authority — refuse to construct behind any
  // other boundary.
  if (
    deps.notifications === undefined ||
    deps.notifications.name !== notificationsModule.name ||
    deps.notifications.authority !== notificationsModule.authority
  ) {
    throw new ConflictError(
      'the notification delivery plane serves only behind the /notifications boundary (name + authority mismatch — fail-closed)',
    );
  }

  const store = new NotificationDeliveryStore(deps.db, deps.clock, deps.ids);
  const { policies, clock, db, ids } = deps;

  // THE ADAPTER REGISTRY — validated DATA, no provider branches (the
  // MKT-023 precedent). The MVP composition registers exactly the in-app
  // + email adapters; future channels register through the same seam.
  const adapterRegistry = buildAdapterRegistry(deps.adapters);

  // -------------------------------------------------------------------------
  // The per-channel pipeline
  // -------------------------------------------------------------------------

  /**
   * The /policies CHANNEL GATE (AC-3): `notification.channel.<channel>`
   * on the network dimension (the delivery-egress dimension this plane
   * uniformly consults — the social-account.complete precedent), with
   * the channel, urgency and event type as selector attributes so a
   * declared boundary can sanction per urgency/event-type subsets.
   * Returns the recorded decision (the refusal receipt carries its id).
   */
  async function evaluateChannelGate(
    notification: NotificationDeliveryRecord,
    channel: NotificationChannel,
    provenance: NotificationDeliveryProvenance,
  ) {
    return policies.evaluateAction(
      {
        action: {
          dimension: 'network',
          operation: channelPolicyOperation(channel),
          resource: channel,
          attributes: {
            channel,
            urgency: notification.urgency,
            eventType: notification.eventType,
          },
        },
        scope: { agencyId: notification.agencyId, clientId: notification.clientId },
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
  }

  /**
   * Runs ONE channel attempt and returns the receipt insert + the
   * in-app-delivery flag (the module-owned durable projection lands
   * atomically with the receipt in the caller's transaction). The
   * adapter attempt itself runs here — BETWEEN the record transaction
   * and the receipt transaction of the fan-out.
   */
  async function runChannelAttempt(input: {
    readonly notification: NotificationDeliveryRecord;
    readonly channel: NotificationChannel;
    readonly attemptSeq: number;
    readonly provenance: NotificationDeliveryProvenance;
  }): Promise<{ readonly receipt: ReceiptInsert; readonly inAppDelivered: boolean }> {
    const { notification, channel, attemptSeq, provenance } = input;

    // 1. Adapter lookup — a future capability key with no registered
    //    adapter is refused honestly (never silently dropped).
    const adapter = adapterRegistry.get(channel);
    if (adapter === undefined) {
      return {
        receipt: composeUnregisteredChannelReceipt({
          notification,
          channel,
          attemptSeq,
          provenance,
        }),
        inAppDelivered: false,
      };
    }

    // 2. Acceptance check — a channel not sanctioned for the
    //    urgency/event type fails closed (AC-2/AC-3).
    if (!channelAccepts(adapter.acceptance, notification.urgency, notification.eventType)) {
      return {
        receipt: composeAcceptanceMismatchReceipt({
          notification,
          channel,
          acceptance: adapter.acceptance,
          attemptSeq,
          provenance,
        }),
        inAppDelivered: false,
      };
    }

    // 3. The /policies channel gate (AC-3) — deny AND unknown both refuse
    //    (the fail-closed enforcement outcome); the receipt carries the
    //    decision id (traceability into the append-only decision ledger).
    const decision = await evaluateChannelGate(notification, channel, provenance);
    if (enforcementOutcome(decision) !== 'allow') {
      return {
        receipt: composePolicyRefusedReceipt({
          notification,
          channel,
          attemptSeq,
          decisionId: decision.decisionId,
          reasonCode: decision.reasonCode,
          provenance,
        }),
        inAppDelivered: false,
      };
    }

    // 4. The adapter attempt (outcomes are data; the adapter never throws
    //    for channel-level results — the email adapter resolves the
    //    recipient address through the port, runs the secrets-dimension
    //    credential gate and resolves the vault material in-process
    //    before the transport send). An unexpected adapter error becomes
    //    the honest failed receipt.
    let outcome;
    try {
      outcome = await adapter.deliver({
        notification,
        attempt: { attemptSeq, attemptedAt: clock.nowIso() },
        provenance,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      outcome = {
        outcome: 'failed' as const,
        reason: `adapter '${channel}' raised an unexpected error: ${cause}`,
        providerMessageId: null,
        policyDecisionId: null,
      };
    }
    return {
      receipt: composeReceipt({
        notification,
        channel,
        attemptSeq,
        outcome: outcome.outcome,
        reason: outcome.reason,
        providerMessageId: outcome.providerMessageId,
        policyDecisionId: outcome.policyDecisionId ?? null,
        provenance,
      }),
      inAppDelivered: channel === 'in-app' && outcome.outcome === 'delivered',
    };
  }

  /**
   * THE RECEIPT+PROJECTION+STATUS TRANSACTION: locks the notification row
   * (the gapless attempt-sequence serializer), appends every receipt of
   * the attempt batch, appends the in-app projection row for a delivered
   * in-app attempt, and moves the adapter-plane delivery status derived
   * from the FULL receipt tail per the frozen transition table.
   */
  async function commitAttemptBatch(input: {
    readonly notificationId: string;
    readonly expectedVersion: number;
    readonly receipts: readonly ReceiptInsert[];
    readonly inAppDelivered: boolean;
  }): Promise<{
    notification: NotificationDeliveryRecord;
    receipts: readonly NotificationDeliveryReceipt[];
  }> {
    return db.transaction(async (tx) => {
      const locked = await store.lockNotification(tx, input.notificationId);
      if (locked === null) {
        throw new NotFoundError('notification', input.notificationId);
      }
      const appended: NotificationDeliveryReceipt[] = [];
      for (const receipt of input.receipts) {
        appended.push(await store.appendReceipt(tx, receipt));
      }
      if (input.inAppDelivered) {
        await store.insertInboxState(tx, {
          notificationId: input.notificationId,
          agencyId: locked.agencyId,
        });
      }
      // The status derives from the FULL receipt tail (the prior attempts
      // + this batch; the duplicate_skipped receipts never participate).
      const fullTail = await store.listReceiptsVia(tx, input.notificationId);
      const status = deriveDeliveryStatus(
        locked.requestedChannels,
        fullTail.map((receipt) => ({ channel: receipt.channel, outcome: receipt.outcome })),
      );
      const notification = await store.setDeliveryStatus(tx, {
        notificationId: input.notificationId,
        status,
        expectedVersion: input.expectedVersion,
      });
      return { notification, receipts: appended };
    });
  }

  /**
   * The duplicate path: appends the honest duplicate-skipped receipts
   * (one per requested channel of the REPLAY) referencing the EXISTING
   * notification — never a second delivery, never a status move.
   */
  async function appendDuplicateSkipped(
    notification: NotificationDeliveryRecord,
    channels: readonly NotificationChannel[],
    provenance: NotificationDeliveryProvenance,
  ): Promise<readonly NotificationDeliveryReceipt[]> {
    return db.transaction(async (tx) => {
      const locked = await store.lockNotification(tx, notification.notificationId);
      if (locked === null) {
        throw new NotFoundError('notification', notification.notificationId);
      }
      const appended: NotificationDeliveryReceipt[] = [];
      for (const channel of channels) {
        const attemptSeq = await store.nextAttemptSeq(tx, notification.notificationId, channel);
        appended.push(
          await store.appendReceipt(
            tx,
            composeDuplicateSkippedReceipt({ notification, channel, attemptSeq, provenance }),
          ),
        );
      }
      return appended;
    });
  }

  // -------------------------------------------------------------------------
  // The public module API
  // -------------------------------------------------------------------------

  const api: NotificationDeliveryModuleApi = {
    async recordNotification(
      input: RecordNotificationInput,
      provenance: NotificationDeliveryProvenance,
    ): Promise<RecordNotificationResult> {
      assertValidNotificationProvenance(provenance);
      assertValidRecordNotificationInput(input);

      // THE IDEMPOTENCY FENCE (AC-5): a replay of an already-recorded
      // occurrence appends the honest duplicate-skipped receipts and
      // STOPS — never a second delivery.
      const existing = await store.findFence({
        sourceKind: input.source.kind,
        sourceId: input.source.id,
        eventType: input.eventType,
        occurrenceKey: input.occurrenceKey,
      });
      if (existing !== null) {
        if (existing.agencyId !== input.agencyId) {
          // A fence hit whose notification belongs to ANOTHER agency is a
          // forged key, not a duplicate — the uniform 404 (no oracle).
          throw new NotFoundError('notification occurrence', input.occurrenceKey);
        }
        const notification = await store.getNotification(existing.notificationId);
        if (notification === null) {
          throw new NotFoundError('notification', existing.notificationId);
        }
        const receipts = await appendDuplicateSkipped(notification, input.channels, provenance);
        return { notification, receipts, duplicate: true };
      }

      // The record + fence in ONE transaction (the DB fences backstop the
      // concurrent double-submit race: the loser converges on the
      // duplicate path below).
      const notificationId = ids.newId();
      let born: NotificationDeliveryRecord;
      try {
        born = await db.transaction(async (tx) => {
          const record = await store.insertNotification(
            tx,
            {
              notificationId,
              agencyId: input.agencyId,
              clientId: input.clientId,
              workspaceId: input.workspaceId,
              eventType: input.eventType,
              urgency: input.urgency,
              explanation: input.explanation,
              sourceKind: input.source.kind,
              sourceId: input.source.id,
              requiredAction: input.requiredAction,
              deepLink: input.deepLink,
              channels: input.channels,
              recipientUserId: input.recipientUserId,
              emailCredentialReferenceId: input.emailCredentialReferenceId,
            },
            provenance,
          );
          await store.insertFence(tx, {
            notificationId,
            agencyId: input.agencyId,
            sourceKind: input.source.kind,
            sourceId: input.source.id,
            eventType: input.eventType,
            occurrenceKey: input.occurrenceKey,
          });
          return record;
        });
      } catch (error) {
        if (isDuplicateFenceViolation(error)) {
          // The concurrent-race loser: converge on the duplicate path.
          const winner = await store.findFence({
            sourceKind: input.source.kind,
            sourceId: input.source.id,
            eventType: input.eventType,
            occurrenceKey: input.occurrenceKey,
          });
          if (winner !== null && winner.agencyId === input.agencyId) {
            const notification = await store.getNotification(winner.notificationId);
            if (notification !== null) {
              const receipts = await appendDuplicateSkipped(
                notification,
                input.channels,
                provenance,
              );
              return { notification, receipts, duplicate: true };
            }
          }
        }
        throw error;
      }

      // The per-channel fan-out (attempts BETWEEN the transactions). The
      // per-(notification, channel) attempt sequence starts at 1 — the
      // notification was just born; the receipt transaction's row lock
      // serializes against concurrent replays.
      const receipts: ReceiptInsert[] = [];
      let inAppDelivered = false;
      for (const channel of input.channels) {
        const attempt = await runChannelAttempt({
          notification: born,
          channel,
          attemptSeq: 1,
          provenance,
        });
        receipts.push(attempt.receipt);
        if (attempt.inAppDelivered) inAppDelivered = true;
      }

      const committed = await commitAttemptBatch({
        notificationId: born.notificationId,
        expectedVersion: born.version,
        receipts,
        inAppDelivered,
      });
      return { ...committed, duplicate: false };
    },

    async redeliverChannel(
      input: {
        readonly notificationId: string;
        readonly channel: NotificationChannel;
      },
      provenance: NotificationDeliveryProvenance,
    ): Promise<RedeliverChannelResult> {
      assertValidNotificationProvenance(provenance);
      const notification = await store.getNotification(input.notificationId);
      if (notification === null) {
        throw new NotFoundError('notification', input.notificationId);
      }
      if (!(notification.requestedChannels as readonly string[]).includes(input.channel)) {
        throw new ConflictError(
          `channel '${input.channel}' is not among the notification's requested channels (${notification.requestedChannels.join(', ')}) — a retry never widens the delivery intent`,
        );
      }
      if (notification.deliveryStatus === 'delivered') {
        throw new ConflictError(
          'the notification is delivered — the adapter-plane delivery lifecycle is terminal (a retry on a delivered notification is refused)',
        );
      }
      // The channel's latest REAL attempt: a channel that already
      // delivered is terminal (the recorded attempt history is immutable
      // — a retry targets a failed/refused/pending channel only).
      const tail = await store.listReceipts(notification.notificationId);
      const channelReal = tail.filter(
        (receipt) => receipt.channel === input.channel && receipt.outcome !== 'duplicate_skipped',
      );
      if (channelReal.some((receipt) => receipt.outcome === 'delivered')) {
        throw new ConflictError(
          `channel '${input.channel}' is already delivered for notification ${notification.notificationId} — the recorded attempt history is immutable`,
        );
      }

      const attempt = await runChannelAttempt({
        notification,
        channel: input.channel,
        attemptSeq: channelReal.length + 1,
        provenance,
      });

      const committed = await commitAttemptBatch({
        notificationId: notification.notificationId,
        expectedVersion: notification.version,
        receipts: [attempt.receipt],
        inAppDelivered: attempt.inAppDelivered,
      });
      return { notification: committed.notification, receipts: committed.receipts };
    },

    async getNotification(notificationId: string) {
      return store.getNotification(notificationId);
    },

    async listNotificationsForAgency(input: {
      readonly agencyId: string;
      readonly clientId: string | null;
    }) {
      return store.listNotificationsForAgency(input);
    },

    async listReceipts(notificationId: string) {
      const notification = await store.getNotification(notificationId);
      if (notification === null) {
        throw new NotFoundError('notification', notificationId);
      }
      return store.listReceipts(notificationId);
    },

    async listInbox(input: {
      readonly agencyId: string;
      readonly clientId: string | null;
      readonly unreadOnly: boolean;
    }): Promise<readonly NotificationInboxEntry[]> {
      return store.listInbox(input);
    },

    async markInboxRead(
      input: {
        readonly notificationId: string;
        readonly expectedVersion: number;
      },
      provenance: NotificationDeliveryProvenance,
    ): Promise<NotificationInboxEntry> {
      assertValidNotificationProvenance(provenance);
      return store.markInboxRead({
        notificationId: input.notificationId,
        expectedVersion: input.expectedVersion,
        readByActor: provenance.actor,
      });
    },

    async getInboxEntry(notificationId: string) {
      return store.getInboxEntry(notificationId);
    },

    listRegisteredAdapters(): readonly RegisteredAdapterInfo[] {
      return [...adapterRegistry.values()].map((adapter) => ({
        channel: adapter.channel,
        acceptance: adapter.acceptance,
      }));
    },
  };

  return api;
}
