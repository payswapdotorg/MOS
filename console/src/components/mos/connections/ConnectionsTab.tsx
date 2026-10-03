"use client";

// UX-005 — the Connections Center: one client-scoped surface where every kind
// of connection MOS uses is seen and operated — social accounts, product/
// source/store integration connections and notification delivery — three
// authority families, zero new authorities. Every card composes the real
// records of an existing connection authority (MKT-055 / MKT-023 / MKT-068)
// through their own routes; every action is wired to the REAL route with
// confirm-gating on destructive transitions.
//
// UX-010 — the progressive-disclosure hardening: the surface's first view is
// the calm stack of section summary rows (each section carries its own LIVE
// one-line summary — loading/empty/error included); the records, forms and
// route names live in the expanded sections and the collapsed
// SourcesDisclosure. ONE primary action per screen state: "Connect a channel"
// (it opens the Channels section, where the platform's real authorization
// round runs); every per-card action renders in the secondary register.
//
// Entry points: the Client Workspace's "Connections" tab (this component) and
// the mission-creation connections step's "Manage connections →" link (UX-002).

import * as React from "react";
import { Plug } from "lucide-react";
import { SocialConnectionsSection } from "./SocialConnections";
import { IntegrationConnectionsSection } from "./IntegrationConnections";
import { NotificationConnectionsSection } from "./NotificationConnections";
import { SourceLine, WorkspaceActionButton } from "@/components/mos/mission/workspace-atoms";
import { SourcesDisclosure } from "@/components/mos/surface-section";

export function ConnectionsTab({ clientId }: { clientId: string }) {
  // The surface's ONE primary action: opening the Channels section (where
  // the connect flow lives). Controlled open — the summary level stays calm,
  // the growth action stays singular.
  const [channelsOpen, setChannelsOpen] = React.useState(false);
  const openChannels = () => {
    setChannelsOpen(true);
    document
      .getElementById("section-connections-social")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="space-y-6">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-prose">
          <h2 className="text-lg font-semibold tracking-tight text-stone-900">Connections</h2>
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            Every connection this client holds — the channels it can act through, the product and
            store pipes it reads, and the plane its notifications arrive on. Open a section to see
            each connection&apos;s live state and the one action it needs next.
          </p>
        </div>
        <div className="shrink-0">
          <WorkspaceActionButton
            tone="teal"
            onClick={openChannels}
            ariaLabel="Connect a channel — opens the Channels section"
          >
            <span className="inline-flex items-center gap-1.5">
              <Plug className="size-4" aria-hidden="true" />
              Connect a channel
            </span>
          </WorkspaceActionButton>
        </div>
      </div>

      <SocialConnectionsSection
        clientId={clientId}
        open={channelsOpen}
        onOpenChange={setChannelsOpen}
      />
      <IntegrationConnectionsSection clientId={clientId} />
      <NotificationConnectionsSection clientId={clientId} />

      <SourcesDisclosure id="connections-sources" label="Sources & composition">
        <p className="leading-relaxed">
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
      </SourcesDisclosure>
    </div>
  );
}
