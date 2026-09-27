"use client";

// UX-005 — the Connections Center: one client-scoped surface where every kind
// of connection MOS uses is seen and operated — social accounts, product/
// source/store integration connections and notification delivery — three
// authority families, zero new authorities. Every card composes the real
// records of an existing connection authority (MKT-055 / MKT-023 / MKT-068)
// through their own routes; every action is wired to the REAL route with
// confirm-gating on destructive transitions.
//
// Entry points: the Client Workspace's "Connections" tab (this component) and
// the mission-creation connections step's "Manage connections →" link (UX-002).

import { SocialConnectionsSection } from "./SocialConnections";
import { IntegrationConnectionsSection } from "./IntegrationConnections";
import { NotificationConnectionsSection } from "./NotificationConnections";
import { SourceLine } from "@/components/mos/mission/workspace-atoms";

export function ConnectionsTab({ clientId }: { clientId: string }) {
  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-stone-900">Connections</h2>
        <p className="mt-1 text-sm leading-relaxed text-stone-600">
          Every connection this client holds — the channels it can act through, the product and
          store pipes it reads, and the plane its notifications arrive on. Each card shows the
          live authorization state, the permissions the provider actually granted, and the one
          action that state needs next.
        </p>
      </div>

      <SocialConnectionsSection clientId={clientId} />
      <IntegrationConnectionsSection clientId={clientId} />
      <NotificationConnectionsSection clientId={clientId} />

      <div className="rounded-xl border border-stone-200 bg-stone-50/60 px-5 py-4">
        <p className="text-sm leading-relaxed text-stone-600">
          This center composes the platform&apos;s existing connection authorities — it holds no
          connection state of its own. Authorization lives server-side behind the same agency
          membership checks every other surface uses; revocation, expiry and provider
          limitations render exactly as the records carry them.
        </p>
        <SourceLine
          sources={[
            "GET /api/clients/:clientId/social-accounts (+ grants, events)",
            "GET /api/clients/:clientId/connections",
            "GET /api/clients/:clientId/notifications (+ :notificationId receipts)",
            "GET /api/integrations/adapters",
          ]}
        />
      </div>
    </div>
  );
}
