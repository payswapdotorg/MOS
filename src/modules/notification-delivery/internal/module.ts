/**
 * /notification-delivery module implementation (MKT-068 — the Notification
 * Delivery Plane).
 *
 * Thin orchestration over the store + the channel registry (data):
 *
 *   validated input (the pure guards — vocabulary + §14 shapes) → THE
 *   ATOMIC OCCURRENCE CLAIM (the notification row born 'pending' + the
 *   dedup fence row, ONE transaction; the fence's unique index makes the
 *   claim race-free) → THE DISPATCH (for every registered adapter that
 *   ACCEPTS the urgency/event type, IN THE ADAPTER REGISTRATION ORDER:
 *   the per-channel /policies gate (notification.channel.<key>) runs
 *   BEFORE every adapter call — a non-allow FAILS CLOSED into an honest
 *   refused receipt, and the adapter NEVER runs for a denied delivery)
 *   → the append-only receipts (delivered/failed/refused — one per
 *   attempt; retries are new rows) → THE DISPATCH FILL (pending →
 *   dispatched, exactly once, CAS-backstopped).
 *
 * The replay path: a losing/replayed occurrence claim NEVER dispatches
 * — no gate, no adapter — the command appends ONE honest
 * duplicate-skipped receipt PER TARGETED CHANNEL on the WINNING
 * notification and returns it (duplicate: true). A replayed event never
 * double-delivers.
 *
 * Fail-closed contract (POL-001 posture, consumed from /policies):
 *   - malformed input (vocabulary/shape/provenance) →
 *     InvalidRequestError BEFORE any write (fail-closed by rejection);
 *   - an adapter registration under a declared-but-unimplemented
 *     channel key (whatsapp/telegram/sms/signal) or any malformed
 *     registration → construction fails LOUDLY (no silent degrade to a
 *     narrower channel set);
 *   - a duplicate channel registration → construction fails loudly;
 *   - a crossed tenant scope chain → the migration-047 DB triggers
 *     (the scope is server-derived input; the database backstops it);
 *   - a policy deny/unknown on a channel → the honest REFUSED receipt
 *     (never a silent drop — the receipt carries the policy decision
 *     id, and the decision itself is recorded in the policy engine's own
 *     append-only ledger);
 *   - an adapter failure → the honest FAILED receipt with the bounded
 *     reason (the notification record itself stays intact and readable).
 */

import { ConflictError, NotFoundError } from '../../../platform/errors/errors.ts';
import type { Db } from '../../../platform/db/contract.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type { PoliciesModuleApi } from '../../policies/public.ts';
import { enforcementOutcome } from '../../policies/public.ts';
import type {
  NotificationDeliveryAdapter,
  NotificationDeliveryChannel,
  NotificationDeliveryModuleApi,
  NotificationDeliveryResult,
  NotificationInboxView,
  NotificationOwnerContext,
  NotificationProvenance,
  NotificationReceiptRecord,
  NotificationRecord,
} from '../public.ts';
import {
  channelPolicyKey,
  SERVED_NOTIFICATIONS_BOUNDARY,
} from '../public.ts';
import {
  assertValidNotificationDeliveryInput,
  assertValidNotificationProvenance,
  isValidNotificationAdapterRegistration,
} from './validation.ts';
import { createInAppChannel } from './in-app-channel.ts';
import { NotificationDeliveryStore } from './store.ts';

/** The minimum plausible id guard shape (an opaque uuid). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotificationDeliveryModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly policies: PoliciesModuleApi;
  readonly adapters?: ReadonlyArray<NotificationDeliveryAdapter> | undefined;
}

export function createNotificationDeliveryModule(
  deps: NotificationDeliveryModuleDeps,
): NotificationDeliveryModuleApi {
  // The served /notifications boundary identity (the MKT-001 frozen
  // boundary — this module fills the DELIVERY plane that boundary
  // reserved; the boundary itself stays business-logic-free).
  if (
    SERVED_NOTIFICATIONS_BOUNDARY.name !== 'notifications' ||
    SERVED_NOTIFICATIONS_BOUNDARY.authority !== 'Notifications'
  ) {
    throw new ConflictError(
      'the /notification-delivery plane requires the registered /notifications boundary (name + authority) — boundary mismatch, refusing to start',
    );
  }

  const store = new NotificationDeliveryStore(deps.db, deps.clock, deps.ids);
  const { policies, clock } = deps;

  // THE CHANNEL REGISTRY — validated DATA (the flow-registry precedent):
  // the in-app channel (module-internal — it persists this module's own
  // inbox projection) plus the injected extrinsic adapters (the email
  // adapter arrives through the composition seam; future channels the
  // same way). Construction fails LOUDLY on malformed registrations,
  // declared-but-unimplemented channel keys and duplicate channels.
  const registered = new Map<NotificationDeliveryChannel, NotificationDeliveryAdapter>();
  const adapters: readonly NotificationDeliveryAdapter[] = [
    createInAppChannel(store),
    ...(deps.adapters ?? []),
  ];
  for (const adapter of adapters) {
    const problems = isValidNotificationAdapterRegistration(adapter);
    if (problems.length > 0) {
      throw new ConflictError(
        `invalid notification delivery adapter registration (channel '${String((adapter as { channel?: unknown }).channel)}'): ${problems.join('; ')}`,
      );
    }
    const existing = registered.get(adapter.channel);
    if (existing !== undefined) {
      throw new ConflictError(
        `duplicate notification delivery adapter registration for channel '${adapter.channel}' — one adapter per channel, fail-closed`,
      );
    }
    registered.set(adapter.channel, adapter);
  }

  /** The adapters targeted by one notification (stable registration order). */
  function targetedAdapters(
    urgency: NotificationRecord['urgency'],
    eventType: NotificationRecord['eventType'],
  ): readonly NotificationDeliveryAdapter[] {
    return adapters.filter((adapter) => adapter.accepts({ urgency, eventType }));
  }

  /**
   * THE PER-CHANNEL FAIL-CLOSED POLICY GATE (MKT-068 AC-3): the
   * notification-channel policy key evaluated through the /policies
   * engine (every decision recorded in ITS append-only ledger). Only an
   * explicit allow permits — deny AND unknown both refuse (the POL-001
   * contract). The gate runs BEFORE the adapter call; a refused delivery
   * records the honest receipt and moves on (fail-closed per channel —
   * one channel's refusal never blocks the others' delivery).
   */
  async function evaluateChannelPolicy(
    channel: NotificationDeliveryChannel,
    notification: NotificationRecord,
    provenance: NotificationProvenance,
  ): Promise<{ readonly allowed: boolean; readonly decisionId: string | null }> {
    const decision = await policies.evaluateAction(
      {
        action: {
          dimension: 'network',
          operation: channelPolicyKey(channel),
          resource: null,
          attributes: {
            urgency: notification.urgency,
            eventType: notification.eventType,
            sourceKind: notification.sourceKind,
          },
        },
        scope: {
          agencyId: notification.agencyId,
          clientId: notification.clientId,
        },
      },
      {
        actor: provenance.actor,
        recordedVia: provenance.recordedVia,
        correlationId: provenance.correlationId,
        causationId: provenance.causationId,
      },
    );
    if (enforcementOutcome(decision) === 'allow') {
      return { allowed: true, decisionId: decision.decisionId };
    }
    return {
      allowed: false,
      decisionId: decision.decisionId,
    };
  }

  /** Bounded honest refusal reason for a denied channel gate. */
  function refusalReason(
    channel: NotificationDeliveryChannel,
    notification: NotificationRecord,
    decisionId: string | null,
  ): string {
    return `policy key ${channelPolicyKey(channel)} refused the ${notification.urgency}/${notification.eventType} delivery (decision ${decisionId ?? 'unrecorded'}) — the channel is not sanctioned for this urgency/event type, refused fail-closed, never silently dropped`;
  }

  return {
    async deliverNotification(input, provenance): Promise<NotificationDeliveryResult> {
      assertValidNotificationProvenance(provenance);
      assertValidNotificationDeliveryInput(input);

      // THE ATOMIC OCCURRENCE CLAIM: notification (born 'pending') +
      // fence, one transaction. A losing claim (replay or race) surfaces
      // the WINNING notification for the duplicate-skipped receipts.
      const claim = await store.claimOccurrence(input, provenance);

      const targets = targetedAdapters(claim.notification.urgency, claim.notification.eventType);

      if (claim.kind === 'duplicate') {
        // THE REPLAY PATH: no gate, no adapter — the honest
        // duplicate-skipped receipt per targeted channel on the WINNING
        // notification (a replayed event never double-delivers).
        const receipts: NotificationReceiptRecord[] = [];
        for (const adapter of targets) {
          receipts.push(
            await store.appendReceipt(
              {
                notificationId: claim.notification.notificationId,
                channel: adapter.channel,
                outcome: 'duplicate_skipped',
                providerMessageId: null,
                reason: null,
                policyDecisionId: null,
              },
              provenance,
            ),
          );
        }
        return { notification: claim.notification, receipts, duplicate: true };
      }

      // THE DISPATCH: per targeted channel — gate first (fail-closed),
      // then the adapter (only on an explicit allow). Every attempt is
      // an append-only receipt; one channel's failure never blocks the
      // others.
      const receipts: NotificationReceiptRecord[] = [];
      for (const adapter of targets) {
        const gate = await evaluateChannelPolicy(
          adapter.channel,
          claim.notification,
          provenance,
        );
        if (!gate.allowed) {
          receipts.push(
            await store.appendReceipt(
              {
                notificationId: claim.notification.notificationId,
                channel: adapter.channel,
                outcome: 'refused',
                providerMessageId: null,
                reason: refusalReason(adapter.channel, claim.notification, gate.decisionId),
                policyDecisionId: gate.decisionId,
              },
              provenance,
            ),
          );
          continue;
        }

        let outcome:
          | { readonly outcome: 'delivered'; readonly providerMessageId: string | null }
          | { readonly outcome: 'failed'; readonly reason: string };
        try {
          outcome = await adapter.deliver({
            notification: claim.notification,
            scope: {
              agencyId: claim.notification.agencyId,
              clientId: claim.notification.clientId,
              workspaceId: claim.notification.workspaceId,
            },
          });
        } catch (error) {
          // An adapter that THROWS is an honest failure receipt, never a
          // broken dispatch (the other channels still deliver).
          outcome = {
            outcome: 'failed',
            reason: `adapter for channel '${adapter.channel}' errored: ${
              error instanceof Error ? error.message.slice(0, 400) : String(error).slice(0, 400)
            }`.slice(0, 1000),
          };
        }

        if (outcome.outcome === 'delivered') {
          receipts.push(
            await store.appendReceipt(
              {
                notificationId: claim.notification.notificationId,
                channel: adapter.channel,
                outcome: 'delivered',
                providerMessageId:
                  outcome.providerMessageId === undefined ? null : outcome.providerMessageId,
                reason: null,
                policyDecisionId: gate.decisionId,
              },
              provenance,
            ),
          );
        } else {
          receipts.push(
            await store.appendReceipt(
              {
                notificationId: claim.notification.notificationId,
                channel: adapter.channel,
                outcome: 'failed',
                providerMessageId: null,
                reason: outcome.reason.slice(0, 1000),
                policyDecisionId: gate.decisionId,
              },
              provenance,
            ),
          );
        }
      }

      // THE DISPATCH FILL: pending → dispatched, exactly once (the DB
      // trigger + CAS are the backstops). The per-channel truth is the
      // receipt tail.
      const notification = await store.markDispatched(claim.notification.notificationId);
      return { notification, receipts, duplicate: false };
    },

    async getNotification(notificationId) {
      if (!UUID_PATTERN.test(notificationId)) return null;
      return store.getNotification(notificationId);
    },

    async resolveNotificationOwnership(notificationId): Promise<NotificationOwnerContext | null> {
      if (!UUID_PATTERN.test(notificationId)) return null;
      const notification = await store.getNotification(notificationId);
      if (notification === null) return null;
      return {
        scope: {
          kind: 'notification',
          agencyId: notification.agencyId,
          notificationId: notification.notificationId,
        },
        notification,
        resolvedAt: new Date(clock.nowIso()).toISOString(),
      };
    },

    async listNotificationsForClient(clientId) {
      return store.listNotificationsForClient(clientId);
    },

    async listNotificationReceipts(notificationId) {
      if (!UUID_PATTERN.test(notificationId)) return null;
      return store.listReceipts(notificationId);
    },

    async listInboxItems(clientId, filter) {
      return store.listInboxItems(clientId, filter);
    },

    async listInboxItemsForWorkspace(workspaceId) {
      return store.listInboxItemsForWorkspace(workspaceId);
    },

    async getInboxItem(notificationId) {
      if (!UUID_PATTERN.test(notificationId)) return null;
      return store.getInboxItem(notificationId);
    },

    async markInboxItemRead(input, provenance): Promise<NotificationInboxView> {
      assertValidNotificationProvenance(provenance);
      if (!UUID_PATTERN.test(input.notificationId)) {
        throw new NotFoundError('notification', input.notificationId);
      }
      const outcome = await store.markInboxItemRead(input.notificationId, provenance);
      if (outcome === null) {
        // Unknown notification OR no in-app delivery (never delivered on
        // the in-app channel — policy-refused or channel-absent): the
        // uniform 404 (no existence oracle).
        throw new NotFoundError('notification inbox item', input.notificationId);
      }
      if (outcome.kind === 'already-read') {
        throw new ConflictError(
          `the inbox item of notification ${input.notificationId} was already read at ${outcome.view.readAt} — the read state is an append-only transition, never re-recorded`,
        );
      }
      return outcome.view;
    },
  };
}
