/**
 * The MVP IN-APP delivery adapter (MKT-068 AC-6).
 *
 * The in-app channel's delivery effect is the MODULE-OWNED durable
 * projection (migration 047's notification_inbox_states — the row is
 * born 'unread'), appended ATOMICALLY with the delivered receipt by the
 * module core: the adapter decides, the module persists. The adapter is
 * therefore deliberately acceptance-shaped — it declares the channel's
 * acceptance profile (ALL urgencies, ALL event types — the in-app inbox
 * is the always-on internal surface) and its delivery decision IS the
 * projection; ALL SQL stays in the module store (the single DML home).
 *
 * Constructed at the composition root and registered through the module
 * dependencies as DATA (the adapter-registry precedent).
 */

import type {
  AdapterDeliveryOutcome,
  AdapterDeliveryRequest,
  ChannelAcceptance,
  NotificationDeliveryAdapter,
} from '../../../public.ts';
import { NOTIFICATION_EVENT_TYPES, NOTIFICATION_URGENCIES } from '../../../public.ts';

/** The in-app channel's declared acceptance: everything (the always-on inbox). */
export const IN_APP_ACCEPTANCE: ChannelAcceptance = {
  urgencies: [...NOTIFICATION_URGENCIES],
  eventTypes: [...NOTIFICATION_EVENT_TYPES],
};

export class InAppDeliveryAdapter implements NotificationDeliveryAdapter {
  readonly channel = 'in-app' as const;
  readonly acceptance: ChannelAcceptance = IN_APP_ACCEPTANCE;

  async deliver(_request: AdapterDeliveryRequest): Promise<AdapterDeliveryOutcome> {
    // The in-app delivery effect is the module-owned durable projection:
    // the delivered receipt and the inbox row (born 'unread') land in
    // ONE transaction in the module core. There is no provider, no
    // credential and no recipient resolution on this channel — the
    // adapter-plane decision is the delivery.
    return {
      outcome: 'delivered',
      reason: null,
      providerMessageId: null,
    };
  }
}
