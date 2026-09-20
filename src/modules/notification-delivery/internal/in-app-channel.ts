/**
 * The IN-APP delivery channel adapter (MKT-068 AC-6 — one of the two MVP
 * DeliveryAdapter implementations).
 *
 * The in-app channel's DELIVERY is the durable inbox projection row of
 * migration 047 (notification_inbox_items): inserting the row IS the
 * delivery. The row is the surface the future console reads (joined with
 * the notification's §14 content through the module's read API); the
 * read/unread state lives on the projection with the append-only
 * transition (set exactly once — never a task/action state, boundary
 * rule 9).
 *
 * The adapter is MODULE-INTERNAL by construction (NOT under the
 * internal/adapters/ provider-seam subtree): it persists the module's
 * OWN tables through the module's OWN store, so the module core
 * constructs it directly — no composition-root wiring exists or is
 * needed for the in-app channel. This mirrors the fact that the in-app
 * projection is intrinsic to this module's authority (the extrinsic
 * channels — email today, WhatsApp/Telegram/SMS/Signal later — arrive
 * as adapter DATA through the composition seam).
 *
 * The provider message id of the in-app delivery is the inbox row id
 * (the durable, replayable identity of the in-app delivery).
 */

import type {
  AdapterDeliveryInput,
  AdapterDeliveryOutcome,
  NotificationDeliveryAdapter,
} from '../public.ts';
import { NOTIFICATION_URGENCIES } from '../public.ts';
import type { NotificationDeliveryStore } from './store.ts';

export function createInAppChannel(store: NotificationDeliveryStore): NotificationDeliveryAdapter {
  return {
    channel: 'in_app',
    // The in-app channel is the baseline delivery surface: it accepts
    // every urgency and every event type of the frozen vocabulary (the
    // console inbox is the always-on record; the subsets are the
    // EXTRINSIC channels' declarations).
    acceptedUrgencies: [...NOTIFICATION_URGENCIES],
    acceptedEventTypes: null,
    accepts: ({ urgency, eventType }) => {
      void urgency;
      void eventType;
      return true;
    },
    deliver: async (input: AdapterDeliveryInput): Promise<AdapterDeliveryOutcome> => {
      // The durable in-app delivery: the inbox projection row (the unique
      // notification fence makes it at-most-once — a concurrent double
      // dispatch converges on the single row).
      const item = await store.insertInboxItem(
        { notificationId: input.notification.notificationId },
        {
          actor: input.notification.provenance.actor,
          recordedVia: input.notification.provenance.recordedVia,
          correlationId: input.notification.provenance.correlationId,
          causationId: input.notification.provenance.causationId,
        },
      );
      return { outcome: 'delivered', providerMessageId: item.inboxItemId };
    },
  };
}
