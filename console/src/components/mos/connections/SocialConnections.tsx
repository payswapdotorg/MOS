"use client";

// UX-005 — the SOCIAL family of the Connections Center: every social-account
// binding of the client as an operational card (provider, connected identity,
// authorization state, expiry signal, clear next action) with the grant
// history tail, the event tail and the REAL capability descriptors as
// drill-downs. Composed ONLY from the MKT-055 surface:
//
//   GET  /api/clients/:clientId/social-accounts                     the bindings
//   GET  /api/clients/:clientId/social-accounts/:accountId/grants   the grant tail (409 on dead connections — rendered honestly)
//   GET  /api/clients/:clientId/social-accounts/:accountId/grants/:grantId  the verbatim scope facts
//   GET  /api/clients/:clientId/social-accounts/:accountId/events   the append-only event tail
//   POST /api/clients/:clientId/social-accounts/authorize-start      Connect (the OAuth round)
//   POST /api/clients/:clientId/social-accounts/:accountId/reauthorize  Reconnect
//   POST /api/clients/:clientId/social-accounts/:accountId/refresh   Refresh
//   POST /api/clients/:clientId/social-accounts/:accountId/disconnect  Disconnect (confirm-gated)
//
// plus the MKT-023 adapter registry (GET /api/integrations/adapters) for the
// capability descriptors and the connect-surface platform list, and the
// client's integration connections for the authorize-start prerequisite (an
// account attaches only through an authorized integration pipe of the SAME
// adapter key). Zero new authorities; the platform list is NOT hardcoded —
// it reads the registry, so sibling adapters compose naturally.

import * as React from "react";
import { Link2, RefreshCw, ShieldAlert, Unplug } from "lucide-react";
import {
  useAdapterRegistry,
  useIntegrationConnections,
  useSocialAccountEvents,
  useSocialAccountGrants,
  useSocialAccounts,
  useSocialAuthorizeStart,
  useSocialDisconnect,
  useSocialGrantScopeFacts,
  useSocialReauthorize,
  useSocialRefresh,
} from "@/components/mos/hooks";
import type {
  IntegrationConnectionView,
  RegisteredAdapterView,
  SocialAccountView,
  SocialGrantView,
} from "@/lib/mos-api";
import { useQueryClient } from "@tanstack/react-query";
import {
  Chip,
  LabeledRows,
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  WorkspaceEmptyState,
  formatWhen,
} from "@/components/mos/mission/workspace-atoms";
import {
  ConfirmGate,
  ConnectionCard,
  GrantStateChip,
  PendingRoundPanel,
  ProvenanceRows,
  RouteRefusalNote,
  ScopeHealth,
  SocialStatusChip,
} from "./connections-atoms";

/** The presentation shape of one recorded OAuth round (authorize-start or
 *  reauthorize response) — NEVER a fabricated connected state. */
type PendingRound = {
  authorizationId: string;
  state: string;
  authorizeUrl: string;
  grantState: string;
  platform: string;
};

export function SocialConnectionsSection({ clientId }: { clientId: string }) {
  const accounts = useSocialAccounts(clientId);
  const registry = useAdapterRegistry();
  const connections = useIntegrationConnections(clientId);

  const authorizeStart = useSocialAuthorizeStart(clientId);

  const [pendingRound, setPendingRound] = React.useState<PendingRound | null>(null);
  const [connectTarget, setConnectTarget] = React.useState<{
    adapter: RegisteredAdapterView;
    connectionId: string;
  } | null>(null);
  const [requestedScopes, setRequestedScopes] = React.useState("");

  const list = accounts.data ?? [];
  const adapters = registry.data ?? [];
  const connectionList = connections.data ?? [];
  const registryByPlatform = React.useMemo(
    () => new Map(adapters.map((adapter) => [adapter.adapterKey, adapter])),
    [adapters],
  );

  const startRound = async (connectionId: string, adapter: RegisteredAdapterView) => {
    const scopes = requestedScopes
      .split(/[\s,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const outcome = await authorizeStart.mutateAsync({
      connectionId,
      ...(scopes.length === 0 ? {} : { requestedScopes: scopes }),
    });
    setPendingRound({
      authorizationId: outcome.authorizationId,
      state: outcome.state,
      authorizeUrl: outcome.authorizeUrl,
      grantState: outcome.grant.grantState,
      platform: adapter.providerLabel,
    });
    setConnectTarget(null);
    setRequestedScopes("");
  };

  return (
    <section aria-labelledby="connections-social-heading" className="space-y-3">
      <div>
        <h3 id="connections-social-heading" className="font-medium text-stone-800">
          Social accounts
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          The channels this client can publish and read through. Each card shows the live
          authorization state and the one action that state needs next — connecting runs the
          platform&apos;s real OAuth round.
        </p>
      </div>

      {authorizeStart.isError ? (
        <RouteRefusalNote
          message={
            authorizeStart.error instanceof Error
              ? authorizeStart.error.message
              : String(authorizeStart.error)
          }
        />
      ) : null}

      {pendingRound ? (
        <PendingRoundLive round={pendingRound} onSettled={() => setPendingRound(null)} />
      ) : null}

      {accounts.isPending ? (
        <SectionSkeleton rows={3} />
      ) : accounts.isError ? (
        <SectionErrorViewInline
          error={accounts.error}
          what="the social accounts"
          onRetry={() => void accounts.refetch()}
        />
      ) : (
        <>
          {list.length === 0 ? (
            <WorkspaceEmptyState
              missing="No social accounts are connected on this client yet."
              why="A mission reaches people through connected channels — publishing, reading and analytics all run through a real authorization this client holds with the platform."
              next="Connect a platform below: pick an adapter with an authorized integration pipe and run its OAuth round. Until then, missions on this client record their plans but cannot act on any channel."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((account) => (
                <SocialAccountCard
                  key={account.socialAccountId}
                  clientId={clientId}
                  account={account}
                  registryAdapter={registryByPlatform.get(account.platformId) ?? null}
                />
              ))}
            </ul>
          )}

          {registry.isPending ? (
            <SectionSkeleton rows={2} />
          ) : registry.isError ? (
            <SectionErrorViewInline
              error={registry.error}
              what="the adapter registry"
              onRetry={() => void registry.refetch()}
            />
          ) : (
            <ConnectPlatformSurface
              adapters={adapters}
              connections={connectionList}
              connectionsPending={connections.isPending}
              connectionsError={connections.isError}
              onRetryConnections={() => void connections.refetch()}
              registeredPlatformKeys={new Set(list.map((account) => account.platformId))}
              onStartRound={(adapter, connectionId) => setConnectTarget({ adapter, connectionId })}
              busy={authorizeStart.isPending}
            />
          )}
        </>
      )}

      <ConfirmGate
        open={connectTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConnectTarget(null);
            setRequestedScopes("");
          }
        }}
        title={`Connect ${connectTarget?.adapter.providerLabel ?? ""}`}
        consequence="This starts the platform's real OAuth round: MOS records the authorization round (a pending grant) and returns the provider's authorize URL. The account owner signs in at the provider — the connection completes only when the provider's callback lands. Nothing is connected until then."
        confirmLabel="Start the authorization round"
        confirmTone="default"
        busy={authorizeStart.isPending}
        onConfirm={() => {
          if (connectTarget !== null) {
            void startRound(connectTarget.connectionId, connectTarget.adapter);
          }
        }}
      >
        <div className="mt-1">
          <label
            htmlFor="connect-requested-scopes"
            className="text-xs font-medium uppercase tracking-wide text-stone-500"
          >
            Requested permissions (optional, the intent recorded on the grant)
          </label>
          <input
            id="connect-requested-scopes"
            type="text"
            value={requestedScopes}
            onChange={(event) => setRequestedScopes(event.target.value)}
            placeholder="e.g. account:read content:read analytics:read"
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
          />
          <p className="mt-1 text-xs leading-relaxed text-stone-500">
            Space- or comma-separated. The provider&apos;s answer is recorded verbatim and shown
            against this request as the permission health.
          </p>
        </div>
      </ConfirmGate>

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/social-accounts`,
          "GET …/social-accounts/:accountId/grants (authorization health; refuses 409 on dead connections)",
          "GET …/social-accounts/:accountId/grants/:grantId (scope facts)",
          "GET …/social-accounts/:accountId/events (audit tail)",
          "POST …/social-accounts/authorize-start | :accountId/reauthorize | :accountId/refresh | :accountId/disconnect",
          "GET /api/integrations/adapters (capability descriptors)",
        ]}
      />
    </section>
  );
}

// --- The pending round (live re-check) ----------------------------------------------

function PendingRoundLive({ round, onSettled }: { round: PendingRound; onSettled?: () => void }) {
  const queryClient = useQueryClient();
  const [rechecking, setRechecking] = React.useState(false);
  const recheck = async () => {
    setRechecking(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ["social-accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["social-account-grants"] });
      // The round's outcome is now whatever the real records say — the panel
      // has served its purpose and gets out of the way.
      onSettled?.();
    } finally {
      setRechecking(false);
    }
  };
  return (
    <PendingRoundPanel round={round} onRecheck={() => void recheck()} rechecking={rechecking} />
  );
}

// --- One social account card ----------------------------------------------------------

function SocialAccountCard({
  clientId,
  account,
  registryAdapter,
}: {
  clientId: string;
  account: SocialAccountView;
  registryAdapter: RegisteredAdapterView | null;
}) {
  const grants = useSocialAccountGrants(clientId, account.socialAccountId);
  const events = useSocialAccountEvents(clientId, account.socialAccountId);

  const reauthorize = useSocialReauthorize(clientId);
  const refresh = useSocialRefresh(clientId);
  const disconnect = useSocialDisconnect(clientId);

  const [disconnectOpen, setDisconnectOpen] = React.useState(false);
  const [disconnectReason, setDisconnectReason] = React.useState("");
  const [localPending, setLocalPending] = React.useState<PendingRound | null>(null);

  const grantList = grants.data ?? [];
  // The newest-first tail's FIRST entry is the live grant (the append-only
  // history renders in the drill-down; this is the operational first screen).
  const latestGrant = grantList[0] ?? null;
  const dead = account.status === "disconnected" || account.status === "revoked";
  // Expired: the RECORDED state, or the platform-reported expiry passed — the
  // platform itself refuses usable-authorization reads lazily on
  // expired-by-time grants; this display applies the same real comparison
  // to the grant's own expiresAt datum (never an invented state).
  const expired =
    latestGrant !== null
      && (latestGrant.grantState === "expired"
        || (latestGrant.expiresAt !== undefined
          && new Date(latestGrant.expiresAt).getTime() < Date.now()));

  const startReconnect = async () => {
    const outcome = await reauthorize.mutateAsync({ accountId: account.socialAccountId });
    const round: PendingRound = {
      authorizationId: outcome.authorizationId,
      state: outcome.state,
      authorizeUrl: outcome.authorizeUrl,
      grantState: outcome.grant.grantState,
      platform: registryAdapter?.providerLabel ?? account.platformId,
    };
    setLocalPending(round);
  };

  const providerLabel = registryAdapter?.providerLabel ?? account.platformId.replace(/_/g, " ");

  return (
    <ConnectionCard
      id={`social-${account.socialAccountId}`}
      detail={
        <div className="space-y-4">
          {grants.isPending ? (
            <SectionSkeleton rows={3} />
          ) : grants.isError ? (
            <div className="space-y-2">
              <RouteRefusalNote
                message={
                  grants.error instanceof Error
                    ? grants.error.message
                    : String(grants.error)
                }
              />
              <p className="text-xs leading-relaxed text-stone-600">
                Every authorization-bearing read of a dead connection refuses — the grants stay
                recorded on the platform but are not served for authorization decisions anymore.
                The event tail below (audit) remains readable.
              </p>
            </div>
          ) : grantList.length === 0 ? (
            <p className="text-sm leading-relaxed text-stone-600">
              No grants recorded on this account yet.
            </p>
          ) : (
            <GrantTail
              clientId={clientId}
              accountId={account.socialAccountId}
              grants={grantList}
            />
          )}

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
              Event tail (append-only audit)
            </p>
            {events.isPending ? (
              <div className="mt-2">
                <SectionSkeleton rows={2} />
              </div>
            ) : events.isError ? (
              <div className="mt-2">
                <SectionErrorViewInline
                  error={events.error}
                  what="this account's events"
                  onRetry={() => void events.refetch()}
                />
              </div>
            ) : (events.data ?? []).length === 0 ? (
              <p className="mt-1 text-sm leading-relaxed text-stone-600">
                No events recorded yet — every authorize, refresh, disconnect and revocation lands
                here as an immutable record.
              </p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1.5">
                {(events.data ?? []).slice(0, 8).map((event) => (
                  <li
                    key={event.eventId}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-stone-700"
                  >
                    <span className="font-medium">{event.eventType.replace(/_/g, " ")}</span>
                    {event.reason ? (
                      <span className="text-xs text-stone-500">{event.reason}</span>
                    ) : null}
                    {event.providerRevokeOutcome ? (
                      <span className="text-xs text-stone-500">
                        provider: {event.providerRevokeOutcome}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-stone-400">
                      {formatWhen(event.recordedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {registryAdapter ? (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Capability surface (the adapter registry, verbatim)
              </p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                {registryAdapter.description}
              </p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {registryAdapter.capabilities.map((capability) => (
                  <li
                    key={capability.capabilityKey}
                    className="rounded-lg border border-stone-200 bg-white px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip
                        label={capability.capabilityKey}
                        className="border-stone-300 bg-white text-stone-700"
                      />
                      <Chip
                        label={capability.kind}
                        className="border-stone-200 bg-stone-50 text-stone-600"
                      />
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-stone-600">
                      {capability.description}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-stone-400">
                      operations: {capability.operations.join(", ")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-stone-500">
              No capability descriptor is registered for platform &ldquo;{account.platformId}&rdquo;
              in this deployment&apos;s adapter registry — the card shows only what the grant
              records carry. Capability parity is never assumed.
            </p>
          )}
        </div>
      }
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-stone-800">{providerLabel}</p>
          <p className="mt-0.5 truncate text-sm text-stone-500">
            {account.displayIdentity ?? account.externalAccountId}
            {account.verifiedAt ? " · verified" : ""}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <SocialStatusChip status={account.status} />
            {latestGrant ? <GrantStateChip state={latestGrant.grantState} /> : null}
            {latestGrant?.expiresAt ? (
              <span
                className={`font-mono text-[11px] ${
                  new Date(latestGrant.expiresAt).getTime() < Date.now()
                    ? "text-amber-900"
                    : "text-stone-500"
                }`}
              >
                {new Date(latestGrant.expiresAt).getTime() < Date.now() ? "expired" : "expires"}{" "}
                {formatWhen(latestGrant.expiresAt)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {dead ? (
            <span className="max-w-[220px] text-right text-xs leading-relaxed text-stone-500">
              Terminal — a dead binding is never reactivated in place. A fresh
              Connect round on the platform&apos;s pipe below re-binds the identity.
            </span>
          ) : expired ? (
            <WorkspaceActionButton
              tone="teal"
              onClick={() => void startReconnect()}
              disabled={reauthorize.isPending}
              ariaLabel={`Reauthorize ${providerLabel}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <Link2 className="size-4" aria-hidden="true" />
                Reauthorize
              </span>
            </WorkspaceActionButton>
          ) : (
            <WorkspaceActionButton
              tone="plain"
              onClick={() =>
                void refresh.mutateAsync({ accountId: account.socialAccountId })
              }
              disabled={refresh.isPending}
              ariaLabel={`Refresh ${providerLabel}`}
            >
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw className="size-4" aria-hidden="true" />
                Refresh
              </span>
            </WorkspaceActionButton>
          )}
          <WorkspaceActionButton
            tone="amber"
            onClick={() => setDisconnectOpen(true)}
            disabled={disconnect.isPending || dead}
            ariaLabel={`Disconnect ${providerLabel}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Unplug className="size-4" aria-hidden="true" />
              Disconnect
            </span>
          </WorkspaceActionButton>
        </div>
      </div>

      {localPending ? (
        <div className="mt-3">
          <PendingRoundLive round={localPending} onSettled={() => setLocalPending(null)} />
        </div>
      ) : null}

      {reauthorize.isError ? (
        <div className="mt-3">
          <RouteRefusalNote
            message={
              reauthorize.error instanceof Error
                ? reauthorize.error.message
                : String(reauthorize.error)
            }
          />
        </div>
      ) : null}
      {refresh.isError ? (
        <div className="mt-3">
          <RouteRefusalNote
            message={
              refresh.error instanceof Error ? refresh.error.message : String(refresh.error)
            }
          />
        </div>
      ) : null}

      <ConfirmGate
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={`Disconnect ${providerLabel}`}
        consequence="This is the terminal fail-closed death of the connection: every authorization-bearing read refuses from here on, the vault references die (no zombie grants), and publishing through this channel stops. The grant history stays recorded as immutable history."
        confirmLabel="Disconnect this account"
        busy={disconnect.isPending}
        showReason
        reason={disconnectReason}
        onReasonChange={setDisconnectReason}
        onConfirm={() => {
          void disconnect
            .mutateAsync({
              accountId: account.socialAccountId,
              ...(disconnectReason === "" ? {} : { reason: disconnectReason }),
              revokeAtProvider: false,
            })
            .then(() => setDisconnectOpen(false));
        }}
      />
    </ConnectionCard>
  );
}

// --- The grant history tail (drill-down) ------------------------------------------------

function GrantTail({
  clientId,
  accountId,
  grants,
}: {
  clientId: string;
  accountId: string;
  grants: SocialGrantView[];
}) {
  return (
    <div>
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
        Grant history ({grants.length} grant{grants.length === 1 ? "" : "s"}, append-only)
      </p>
      <ul className="mt-1.5 flex flex-col gap-2">
        {grants.map((grant) => (
          <GrantRow key={grant.grantId} clientId={clientId} accountId={accountId} grant={grant} />
        ))}
      </ul>
    </div>
  );
}

function GrantRow({
  clientId,
  accountId,
  grant,
}: {
  clientId: string;
  accountId: string;
  grant: SocialGrantView;
}) {
  const [open, setOpen] = React.useState(false);
  const facts = useSocialGrantScopeFacts(
    open ? clientId : null,
    accountId,
    grant.grantId,
  );
  const historical = grant.grantState === "refreshed" || grant.grantState === "superseded";
  return (
    <li className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`grant-${grant.grantId}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[48px] w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <GrantStateChip state={grant.grantState} />
        <span className="font-mono text-[11px] text-stone-500">{grant.grantId.slice(0, 8)}…</span>
        {grant.expiresAt ? (
          <span className="font-mono text-[11px] text-stone-400">
            expires {formatWhen(grant.expiresAt)}
          </span>
        ) : null}
        {grant.successorGrantId ? (
          <span className="font-mono text-[11px] text-stone-400">
            succeeded by {grant.successorGrantId.slice(0, 8)}…
          </span>
        ) : null}
        <span className="ml-auto text-xs text-stone-400">{formatWhen(grant.createdAt)}</span>
      </button>
      {open ? (
        <div id={`grant-${grant.grantId}-detail`} className="space-y-3 border-t border-stone-100 px-3 py-3">
          {historical ? (
            <p className="text-xs leading-relaxed text-stone-500">
              This grant is superseded history — kept in full, never deleted. Its scopes are no
              longer the live authorization.
            </p>
          ) : null}
          {facts.isPending ? (
            <SectionSkeleton rows={2} />
          ) : facts.isError ? (
            <RouteRefusalNote
              message={
                facts.error instanceof Error ? facts.error.message : String(facts.error)
              }
            />
          ) : (
            <ScopeHealth
              requested={grant.requestedScopes}
              granted={facts.data?.grantedScopes ?? []}
            />
          )}
          {facts.data && facts.data.capabilityTags.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Capability tags (provider&apos;s verbatim answer)
              </span>
              {facts.data.capabilityTags.map((tag) => (
                <Chip
                  key={tag}
                  label={tag}
                  className="border-stone-300 bg-white text-stone-700"
                />
              ))}
            </div>
          ) : null}
          <LabeledRows
            label="Grant record"
            record={{
              completedAt: grant.completedAt ?? "—",
              credentialReferenceId: grant.credentialReferenceId ?? "—",
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

// --- The connect-a-platform surface --------------------------------------------------------

/**
 * The platform list composes the ADAPTER REGISTRY (generic — no hardcoded
 * providers): every registered adapter is a connectable surface IF the client
 * holds an authorized integration pipe of the same adapter key (the
 * authorize-start prerequisite). Adapters without a pipe render the honest
 * prerequisite state and point at the product/source family.
 */
function ConnectPlatformSurface({
  adapters,
  connections,
  connectionsPending,
  connectionsError,
  onRetryConnections,
  registeredPlatformKeys,
  onStartRound,
  busy,
}: {
  adapters: RegisteredAdapterView[];
  connections: IntegrationConnectionView[];
  connectionsPending: boolean;
  connectionsError: boolean;
  onRetryConnections: () => void;
  registeredPlatformKeys: Set<string>;
  onStartRound: (adapter: RegisteredAdapterView, connectionId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white px-5 py-4">
      <p className="font-medium text-stone-800">Connect a platform</p>
      <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
        Every adapter this deployment registers, with the client&apos;s live pipe state. A social
        account attaches through an authorized integration pipe of the same adapter key — the
        OAuth round itself is the platform&apos;s own.
      </p>
      {connectionsError ? (
        <div className="mt-3">
          <SectionErrorViewInline
            error={new Error("the client's integration connections")}
            what="the prerequisite pipe state"
            onRetry={onRetryConnections}
          />
        </div>
      ) : connectionsPending ? (
        <div className="mt-3">
          <SectionSkeleton rows={2} />
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {adapters.map((adapter) => {
            const pipes = connections.filter(
              (connection) => connection.adapterKey === adapter.adapterKey,
            );
            const authorizedPipe = pipes.find(
              (connection) => connection.status === "connected",
            );
            const bound = registeredPlatformKeys.has(adapter.adapterKey);
            return (
              <li
                key={adapter.adapterKey}
                className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-800">
                    {adapter.providerLabel}
                    {bound ? (
                      <span className="ml-2 font-normal text-xs text-teal-900">
                        account bound on this client
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500">
                    {adapter.capabilities.length} capabilit
                    {adapter.capabilities.length === 1 ? "y" : "ies"} ·{" "}
                    {authorizedPipe
                      ? `authorized pipe ${authorizedPipe.connectionId.slice(0, 8)}…`
                      : pipes.length > 0
                        ? `${pipes.length} pipe${pipes.length === 1 ? "" : "s"} on this client, none connected`
                        : "no integration pipe on this client yet"}
                  </p>
                </div>
                {authorizedPipe ? (
                  <WorkspaceActionButton
                    tone="teal"
                    onClick={() => onStartRound(adapter, authorizedPipe.connectionId)}
                    disabled={busy}
                    ariaLabel={`Connect ${adapter.providerLabel} account`}
                  >
                    Connect
                  </WorkspaceActionButton>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                    <ShieldAlert className="size-4 shrink-0 text-stone-400" aria-hidden="true" />
                    needs an authorized pipe first (product &amp; source connections below)
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- The inline error view (the UX-002/003 precedent) --------------------------------------

function SectionErrorViewInline({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-amber-700/20 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">{what} couldn&apos;t be loaded just now.</p>
      <p className="mt-1 break-words text-sm leading-relaxed text-amber-900/80">{message}</p>
      {onRetry ? (
        <div className="mt-3">
          <WorkspaceActionButton tone="amber" onClick={onRetry}>
            Try again
          </WorkspaceActionButton>
        </div>
      ) : null}
    </div>
  );
}

export { SectionErrorViewInline };
