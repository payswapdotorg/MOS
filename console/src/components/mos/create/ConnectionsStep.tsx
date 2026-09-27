"use client";

// UX-002 — step 4 of the flow: CONNECTIONS. Truthful live state only.
// Missions live at the agency level in this platform, while connections
// (social accounts) are held by CLIENTS — so this step shows the REAL state
// through the existing read APIs:
//   GET /api/agencies/:agencyId/clients           (the agency's clients)
//   GET /api/clients/:clientId/social-accounts    (that client's bindings)
// Looking changes nothing: the mission being drafted is agency-scoped and
// carries no client binding, and nothing in this step pretends otherwise.
// When there is no client context, the WORKER-CONTRACT empty state renders:
// what is missing, why it matters, what to do next — always with an
// explicit, working action.

import { Building2, ChevronRight, Link2 } from "lucide-react";
import { useMosQuery } from "@/components/mos/hooks";
import { useClients } from "@/components/mos/hooks";
import { useNavigate } from "@/components/mos/home/outcomes";
import type { ClientRecord } from "@/lib/mos-api";

type SocialAccountView = {
  socialAccountId: string;
  platformId: string;
  displayIdentity: string | null;
  status: string;
  verifiedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type SocialAccountsResponse = { clientId: string; socialAccounts: SocialAccountView[] };

/** Social-account status vocabulary (MKT-055): connected | disconnected |
 *  revoked. Teal = connected, amber = disconnected, red = revoked. */
const CONNECTION_STATUS_STYLES: Record<string, string> = {
  connected: "border-teal-800/20 bg-teal-50 text-teal-900",
  disconnected: "border-amber-700/20 bg-amber-50 text-amber-900",
  revoked: "border-red-800/20 bg-red-50 text-red-900",
};

function ConnectionStatusChip({ status }: { status: string }) {
  const cls =
    CONNECTION_STATUS_STYLES[status.toLowerCase()] ??
    "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function platformLabel(platformId: string): string {
  return platformId.replace(/_/g, " ");
}

export function ConnectionsStep({
  agencyId,
  selectedClientId,
  onSelectClient,
}: {
  agencyId: string;
  selectedClientId: string | null;
  onSelectClient: (clientId: string | null) => void;
}) {
  const clients = useClients(agencyId);

  if (clients.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading clients">
        <div className="h-12 animate-pulse rounded-xl bg-stone-200/60" />
        <div className="h-12 animate-pulse rounded-xl bg-stone-200/60" />
      </div>
    );
  }

  if (clients.isError) {
    return (
      <div className="rounded-xl border border-amber-700/20 bg-amber-50 p-5">
        <p className="font-medium text-amber-900">Your clients couldn&apos;t be loaded just now.</p>
        <p className="mt-1 text-sm leading-relaxed text-amber-900/80">
          The rest of the flow still works — connections are shown for context only, and this step
          never blocks creating the mission.
        </p>
        <button
          type="button"
          onClick={() => void clients.refetch()}
          className="mt-3 inline-flex min-h-[44px] items-center rounded-lg border border-amber-700/30 bg-white px-4 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
        >
          Try again
        </button>
      </div>
    );
  }

  const list = clients.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Connections this mission can draw on</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-600">
          Missions belong to your agency, and channels are connected by each client. Pick a client
          to see its real connections — looking changes nothing, and the mission you&apos;re
          creating stays with the agency either way.
        </p>
      </div>

      {list.length === 0 ? <NoClientsState /> : (
        <div className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium text-stone-800">Your clients</legend>
            {list.map((client) => (
              <ClientPickerRow
                key={client.clientId}
                client={client}
                selected={client.clientId === selectedClientId}
                onSelect={() =>
                  onSelectClient(client.clientId === selectedClientId ? null : client.clientId)
                }
              />
            ))}
          </fieldset>
          {selectedClientId === null ? (
            <p className="text-sm leading-relaxed text-stone-600">
              Select a client above to see its connections, or continue — connections are not
              required to create a draft mission.
            </p>
          ) : (
            <ClientConnections clientId={selectedClientId} clientName={
              list.find((client) => client.clientId === selectedClientId)?.name ?? undefined
            } />
          )}
        </div>
      )}
    </div>
  );
}

function ClientPickerRow({
  client,
  selected,
  onSelect,
}: {
  client: ClientRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex min-h-[56px] cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3 transition-colors ${
        selected
          ? "border-teal-700/50 bg-teal-50/50"
          : "border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-100/50"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3">
        <input
          type="radio"
          name="connections-client"
          value={client.clientId}
          checked={selected}
          onChange={onSelect}
          className="sr-only"
        />
        <span
          aria-hidden="true"
          className={`flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
            selected ? "border-teal-700" : "border-stone-300"
          }`}
        >
          {selected ? <span className="size-2 rounded-full bg-teal-700" /> : null}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-stone-800">{client.name}</span>
          <span className="block text-xs text-stone-500">client · {client.status}</span>
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
    </label>
  );
}

function ClientConnections({ clientId, clientName }: { clientId: string; clientName?: string }) {
  const navigate = useNavigate();
  const query = useMosQuery<SocialAccountsResponse>(
    ["client-social-accounts", clientId],
    `/api/clients/${clientId}/social-accounts`,
  );

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading connections">
        <div className="h-12 animate-pulse rounded-xl bg-stone-200/60" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="rounded-xl border border-amber-700/20 bg-amber-50 p-4">
        <p className="text-sm text-amber-900">
          This client&apos;s connections couldn&apos;t be loaded just now.
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 inline-flex min-h-[44px] items-center rounded-lg border border-amber-700/30 bg-white px-3 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
        >
          Try again
        </button>
      </div>
    );
  }

  const accounts = query.data?.socialAccounts ?? [];

  const manageLink = (
    <button
      type="button"
      onClick={() => navigate({ kind: "client", clientId, tab: "connections" })}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      <Link2 className="size-4" aria-hidden="true" />
      Manage connections{clientName ? ` for ${clientName}` : ""} →
    </button>
  );

  if (accounts.length === 0) {
    return (
      <div className="rounded-xl border border-stone-200 bg-white p-5">
        <p className="font-medium text-stone-800">No connected channels on this client yet</p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          <span className="font-medium">What&apos;s missing:</span> a channel this mission could
          work through — a social account connected to this client.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          <span className="font-medium">Why it matters:</span> once channels are connected, missions
          can act through them and report what actually happened. A draft mission works fine
          without any.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          <span className="font-medium">What to do next:</span> open the Connections Center —
          connect a platform, watch its OAuth round and its granted permissions land live. You
          can also continue creating this mission — drafts don&apos;t run anything.
        </p>
        <div className="mt-4">{manageLink}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
        <ul className="divide-y divide-stone-100">
          {accounts.map((account) => (
            <li key={account.socialAccountId} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-stone-800">
                  {platformLabel(account.platformId)}
                </span>
                <span className="block truncate text-xs text-stone-500">
                  {account.displayIdentity ?? "account"}
                  {account.verifiedAt ? " · verified" : ""}
                </span>
              </span>
              <ConnectionStatusChip status={account.status} />
            </li>
          ))}
        </ul>
      </div>
      <div>{manageLink}</div>
    </div>
  );
}

function NoClientsState() {
  const navigate = useNavigate();
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="flex items-start gap-3">
        <Building2 className="mt-0.5 size-5 shrink-0 text-stone-400" aria-hidden="true" />
        <div>
          <p className="font-medium text-stone-800">No clients yet — so nothing is connected</p>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            <span className="font-medium">What&apos;s missing:</span> a client. Channels are
            connected by clients in this platform, and your agency has none yet.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            <span className="font-medium">Why it matters:</span> missions act through your
            clients&apos; connected channels when they run. A client is where those connections
            will live.
          </p>
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            <span className="font-medium">What to do next:</span> create your first client now
            (takes a moment), or continue — a draft mission doesn&apos;t need any connection.
          </p>
          <button
            type="button"
            onClick={() => navigate({ kind: "clients" })}
            className="mt-4 inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
          >
            Open Clients
          </button>
        </div>
      </div>
    </div>
  );
}
