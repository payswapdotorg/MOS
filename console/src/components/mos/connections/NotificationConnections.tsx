"use client";

// UX-005 — the NOTIFICATION family of the Connections Center: the delivery
// channels as the platform really runs them, with their health composed from
// the client's own delivery receipts (MKT-068):
//
//   GET  /api/clients/:clientId/notifications                    the in-app inbox (deliveryStatus per record)
//   GET  /api/clients/:clientId/notifications/:notificationId    one notification + the full append-only receipt tail
//
// The channels themselves are DEPLOYMENT state (the in-app channel is
// constructed inside the module; the email adapter registers only when the
// deployment configures a transport + provider) — there is deliberately no
// console action that connects or disconnects a notification channel, and
// this family says so honestly instead of faking an action. What IS real
// here: every receipt the client's notifications produced, its channel,
// outcome, provider message id and policy decision — the channel-health
// basis the work order names.

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useClientNotifications, useNotificationDetail } from "@/components/mos/hooks";
import type { NotificationInboxItemView, NotificationReceiptView } from "@/lib/mos-api";
import {
  Chip,
  LabeledRows,
  SectionSkeleton,
  SourceLine,
  WorkspaceEmptyState,
  formatWhen,
} from "@/components/mos/mission/workspace-atoms";
import { SectionErrorViewInline } from "./SocialConnections";

export function NotificationConnectionsSection({ clientId }: { clientId: string }) {
  const notifications = useClientNotifications(clientId);

  const list = notifications.data ?? [];
  // The channel-health basis, from the inbox view's own facts: every inbox
  // item IS an in-app delivery (deliveredAt set by the in-app channel — the
  // adapter-plane deliveryStatus is the dispatch lifecycle, never task
  // state). The per-channel receipts (delivered/failed/refused per channel)
  // open per notification below — no fabricated channel state.
  const delivered = list.filter((item) => item.deliveredAt !== "");
  const read = list.filter((item) => item.readAt !== null);

  return (
    <section aria-labelledby="connections-notifications-heading" className="space-y-3">
      <div>
        <h3 id="connections-notifications-heading" className="font-medium text-stone-800">
          Notification delivery
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          How this client&apos;s notifications are actually being delivered — the in-app inbox
          state and each delivery&apos;s channel receipts.
        </p>
      </div>

      {notifications.isPending ? (
        <SectionSkeleton rows={3} />
      ) : notifications.isError ? (
        <SectionErrorViewInline
          error={notifications.error}
          what="the notification inbox"
          onRetry={() => void notifications.refetch()}
        />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No notifications have been delivered on this client yet."
          why="Notifications are the plane that surfaces attention, approvals and anomalies — mission blockers, terminal states and policy refusals all arrive through it. An empty plane means nothing has needed attention yet."
          next="Nothing to connect: the in-app channel is always on (it is part of the platform itself), and additional channels — like email — are registered through the deployment's own configuration, not through the console. Deliveries land here as work runs."
        />
      ) : (
        <div className="rounded-xl border border-stone-200 bg-white px-5 py-4">
          <p className="font-medium text-stone-800">Channel health</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip
              label={`in-app · ${delivered.length} delivered`}
              className="border-teal-800/20 bg-teal-50 text-teal-900"
            />
            <Chip
              label={`${read.length} read`}
              className="border-stone-200 bg-stone-50 text-stone-600"
            />
            <Chip
              label={`${list.length} notification${list.length === 1 ? "" : "s"} in the inbox`}
              className="border-stone-300 bg-white text-stone-700"
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-stone-500">
            The in-app channel is part of the platform (always on). Email and future channels
            register through the deployment&apos;s configuration — each delivery&apos;s receipts
            open below, with the channel&apos;s own outcome and policy decision.
          </p>
        </div>
      )}

      {list.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {list.slice(0, 6).map((item) => (
            <NotificationRow key={item.inboxItemId} clientId={clientId} item={item} />
          ))}
          {list.length > 6 ? (
            <li className="text-xs text-stone-500">
              … {list.length - 6} earlier notification{list.length - 6 === 1 ? "" : "s"} in the
              inbox.
            </li>
          ) : null}
        </ul>
      ) : null}

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/notifications`,
          "GET …/notifications/:notificationId (the receipt tail, on expand)",
        ]}
      />
    </section>
  );
}

function NotificationRow({
  clientId,
  item,
}: {
  clientId: string;
  item: NotificationInboxItemView;
}) {
  const [open, setOpen] = React.useState(false);
  const detail = useNotificationDetail(open ? clientId : null, item.notificationId);
  const receipts = detail.data?.receipts ?? [];
  const read = item.readAt !== null;

  return (
    <li className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`notification-${item.notificationId}-receipts`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[56px] w-full items-start justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-stone-800">
            {item.notification.explanation}
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">
            {item.notification.eventType.replace(/_/g, " ")} ·{" "}
            {item.notification.urgency} · delivered {formatWhen(item.deliveredAt)}
            {read ? " · read" : ""}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <Chip
            label={item.notification.deliveryStatus}
            className={
              item.notification.deliveryStatus === "delivered"
                ? "border-teal-800/20 bg-teal-50 text-teal-900"
                : "border-amber-700/20 bg-amber-50 text-amber-900"
            }
          />
          <ChevronDown
            aria-hidden="true"
            className={`size-4 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <div
          id={`notification-${item.notificationId}-receipts`}
          className="space-y-3 border-t border-stone-100 bg-stone-50/40 px-5 py-4"
        >
          {detail.isPending ? (
            <SectionSkeleton rows={2} />
          ) : detail.isError ? (
            <SectionErrorViewInline
              error={detail.error}
              what="this notification's receipts"
              onRetry={() => void detail.refetch()}
            />
          ) : (
            <ReceiptList receipts={receipts} />
          )}
          <LabeledRows
            label="Notification record"
            record={{
              source: `${item.notification.sourceKind}:${item.notification.sourceId.slice(0, 12)}…`,
              requiredAction: item.notification.requiredAction ?? "—",
              deepLink: item.notification.deepLink,
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

function ReceiptList({ receipts }: { receipts: NotificationReceiptView[] }) {
  if (receipts.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No receipts recorded on this notification — an append-only receipt lands per
        targeted channel on every delivery (and on every replayed occurrence).
      </p>
    );
  }
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
        Channel receipts (append-only)
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {receipts.map((receipt) => (
          <li
            key={receipt.receiptId}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-stone-700"
          >
            <Chip
              label={receipt.channel}
              className="border-stone-300 bg-white text-stone-700"
            />
            <Chip
              label={receipt.outcome}
              className={
                receipt.outcome === "delivered"
                  ? "border-teal-800/20 bg-teal-50 text-teal-900"
                  : receipt.outcome === "refused"
                    ? "border-red-800/20 bg-red-50 text-red-900"
                    : "border-stone-200 bg-stone-50 text-stone-600"
              }
            />
            {receipt.reason ? (
              <span className="text-xs text-stone-500">{receipt.reason}</span>
            ) : null}
            {receipt.providerMessageId ? (
              <span className="font-mono text-[11px] text-stone-400">
                provider message {receipt.providerMessageId.slice(0, 14)}…
              </span>
            ) : null}
            {receipt.policyDecisionId ? (
              <span className="font-mono text-[11px] text-stone-400">
                policy {receipt.policyDecisionId.slice(0, 14)}…
              </span>
            ) : null}
            <span className="ml-auto shrink-0 text-xs text-stone-400">
              {formatWhen(
                (receipt.provenance["recordedAt"] as string | undefined) ?? "",
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
