"use client";

// UX-005 — the PRODUCT/SOURCE/STORE family of the Connections Center: every
// client integration connection as an operational card with the REAL
// capability descriptors of its adapter, health, rate-limit and last-error
// signals, and the register/connect/suspend actions wired to the MKT-023
// routes:
//
//   GET  /api/clients/:clientId/connections                          the connections
//   POST /api/clients/:clientId/connections                          register (owner|admin)
//   POST /api/clients/:clientId/connections/:connectionId/connect     the policy-gated probe (CAS)
//   POST /api/clients/:clientId/connections/:connectionId/suspend     the administrative pause (CAS, confirm-gated)
//   GET  /api/integrations/adapters                                  the adapter registry (capabilities)
//   GET  /api/agencies/:agencyId/credentials                         the live credential references
//
// There is deliberately NO delete: the frozen connection lifecycle has no
// terminal state (suspend + reconnect) — the card says so instead of faking
// a remove action. The register path needs a credential REFERENCE (opaque,
// non-secret — material lives in the deployment's secret backend, never in
// the console).

import * as React from "react";
import { Pause, Plug } from "lucide-react";
import {
  useAdapterRegistry,
  useAgencyCredentials,
  useConnectIntegrationConnection,
  useIntegrationConnections,
  useRegisterIntegrationConnection,
  useSuspendIntegrationConnection,
} from "@/components/mos/hooks";
import { useMosSession } from "@/components/mos/session-store";
import type {
  IntegrationConnectionView,
  RegisteredAdapterView,
} from "@/lib/mos-api";
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
  IntegrationStatusChip,
  RouteRefusalNote,
} from "./connections-atoms";
import { SectionErrorViewInline } from "./SocialConnections";

export function IntegrationConnectionsSection({ clientId }: { clientId: string }) {
  const agencyId = useMosSession((state) => state.agencyId);
  const connections = useIntegrationConnections(clientId);
  const registry = useAdapterRegistry();
  const credentials = useAgencyCredentials(agencyId);

  const register = useRegisterIntegrationConnection(clientId);

  const [registerOpen, setRegisterOpen] = React.useState(false);
  const [registerAdapterKey, setRegisterAdapterKey] = React.useState("");
  const [registerCredentialId, setRegisterCredentialId] = React.useState("");
  const [registerBaseUrl, setRegisterBaseUrl] = React.useState("");

  const list = connections.data ?? [];
  const adapters = registry.data ?? [];
  const credentialList = credentials.data ?? [];
  const adapterByKey = React.useMemo(
    () => new Map(adapters.map((adapter) => [adapter.adapterKey, adapter])),
    [adapters],
  );

  return (
    <section aria-labelledby="connections-integrations-heading" className="space-y-3">
      <div>
        <h3 id="connections-integrations-heading" className="font-medium text-stone-800">
          Product, source and store connections
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          The integration pipes this client reads products, analytics and commerce events
          through — each with the capabilities its adapter actually declares and the live
          probe state.
        </p>
      </div>

      {connections.isPending ? (
        <SectionSkeleton rows={3} />
      ) : connections.isError ? (
        <SectionErrorViewInline
          error={connections.error}
          what="the integration connections"
          onRetry={() => void connections.refetch()}
        />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No product, source or store connections are registered on this client yet."
          why="Product sources, analytics reads and commerce event ingestion all run through an authorized integration pipe — without one, there is nothing to market or attribute against."
          next="Register a connection: pick an adapter from the registry and a live credential reference (the opaque handle of material provisioned in the deployment's secret backend), then run the connect probe."
          action={
            <WorkspaceActionButton tone="teal" onClick={() => setRegisterOpen(true)}>
              Register a connection
            </WorkspaceActionButton>
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {list.map((connection) => (
            <IntegrationConnectionCard
              key={connection.connectionId}
              clientId={clientId}
              connection={connection}
              adapter={adapterByKey.get(connection.adapterKey) ?? null}
            />
          ))}
        </ul>
      )}

      {list.length > 0 ? (
        <WorkspaceActionButton tone="teal" onClick={() => setRegisterOpen(true)}>
          Register another connection
        </WorkspaceActionButton>
      ) : null}

      <ConfirmGate
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        title="Register an integration connection"
        consequence="This registers the connection in its born state ('registered' — nothing is contacted yet). The connect probe then runs the platform's fail-closed policy gates and the adapter's provider probe; a healthy probe transitions it to connected."
        confirmLabel="Register the connection"
        confirmTone="default"
        busy={register.isPending}
        onConfirm={() => {
          const adapter = adapterByKey.get(registerAdapterKey);
          const providerConfig: Record<string, unknown> =
            registerBaseUrl.trim() === "" ? {} : { apiBaseUrl: registerBaseUrl.trim() };
          void register
            .mutateAsync({
              adapterKey: registerAdapterKey,
              credentialReferenceId: registerCredentialId,
              providerConfig,
            })
            .then(() => {
              setRegisterOpen(false);
              setRegisterAdapterKey("");
              setRegisterCredentialId("");
              setRegisterBaseUrl("");
            })
            .catch(() => {
              /* the refusal renders below — never a fake success */
            });
        }}
      >
        <div className="mt-1 space-y-3">
          <div>
            <label
              htmlFor="register-adapter"
              className="text-xs font-medium uppercase tracking-wide text-stone-500"
            >
              Adapter (the registry — real capability surface)
            </label>
            <select
              id="register-adapter"
              value={registerAdapterKey}
              onChange={(event) => setRegisterAdapterKey(event.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-700"
            >
              <option value="">Select an adapter…</option>
              {adapters.map((adapter) => (
                <option key={adapter.adapterKey} value={adapter.adapterKey}>
                  {adapter.providerLabel} ({adapter.adapterKey})
                </option>
              ))}
            </select>
            {registerAdapterKey !== "" ? (
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                {adapterByKey.get(registerAdapterKey)?.description}
              </p>
            ) : null}
          </div>
          <div>
            <label
              htmlFor="register-credential"
              className="text-xs font-medium uppercase tracking-wide text-stone-500"
            >
              Credential reference (opaque — the material stays in the vault)
            </label>
            <select
              id="register-credential"
              value={registerCredentialId}
              onChange={(event) => setRegisterCredentialId(event.target.value)}
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-700"
            >
              <option value="">Select a live credential reference…</option>
              {credentialList.map((credential) => (
                <option key={credential.credentialId} value={credential.credentialId}>
                  {credential.label} · {credential.kind} · {credential.status}
                </option>
              ))}
            </select>
            {credentialList.length === 0 ? (
              <p className="mt-1 text-xs leading-relaxed text-stone-500">
                No live credential references on this agency yet — create one through the
                platform&apos;s credential routes (an opaque handle of material provisioned in
                the deployment&apos;s secret backend; the console never sees material).
              </p>
            ) : null}
          </div>
          <div>
            <label
              htmlFor="register-base-url"
              className="text-xs font-medium uppercase tracking-wide text-stone-500"
            >
              Provider base URL (optional providerConfig)
            </label>
            <input
              id="register-base-url"
              type="text"
              value={registerBaseUrl}
              onChange={(event) => setRegisterBaseUrl(event.target.value)}
              placeholder="https://provider.example.com"
              className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700"
            />
          </div>
          {register.isError ? (
            <RouteRefusalNote
              message={
                register.error instanceof Error
                  ? register.error.message
                  : String(register.error)
              }
            />
          ) : null}
        </div>
      </ConfirmGate>

      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/connections`,
          "POST /api/clients/:clientId/connections (register)",
          "POST …/connections/:connectionId/connect | …/suspend (CAS transitions)",
          "GET /api/integrations/adapters (capability descriptors)",
          "GET /api/agencies/:agencyId/credentials (live references)",
        ]}
      />
    </section>
  );
}

function IntegrationConnectionCard({
  clientId,
  connection,
  adapter,
}: {
  clientId: string;
  connection: IntegrationConnectionView;
  adapter: RegisteredAdapterView | null;
}) {
  const connect = useConnectIntegrationConnection(clientId);
  const suspend = useSuspendIntegrationConnection(clientId);

  const [suspendOpen, setSuspendOpen] = React.useState(false);
  const [suspendReason, setSuspendReason] = React.useState("");

  const isLive = connection.status === "connected";

  return (
    <ConnectionCard
      id={`integration-${connection.connectionId}`}
      detail={
        <div className="space-y-4">
          {adapter ? (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                Capability surface (the adapter registry, verbatim)
              </p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500">{adapter.description}</p>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {adapter.capabilities.map((capability) => (
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
              The adapter &ldquo;{connection.adapterKey}&rdquo; is not registered in this
              deployment&apos;s registry anymore — the connection outlives the adapter set, and
              its pipe is unusable until an adapter of that key registers again (the
              platform&apos;s own rule, shown as recorded).
            </p>
          )}

          <LabeledRows
            label="Connection record"
            record={{
              connectionId: connection.connectionId,
              adapterKey: connection.adapterKey,
              credentialReferenceId: connection.credentialReferenceId,
              providerConfig: connection.providerConfig,
              rateLimit: connection.rateLimit ?? "none recorded",
              lastError: connection.lastError ?? "none recorded",
              lastCheckedAt: connection.lastCheckedAt ? formatWhen(connection.lastCheckedAt) : "never probed",
              version: connection.version,
              createdAt: formatWhen(connection.createdAt),
              updatedAt: formatWhen(connection.updatedAt),
            }}
          />

          <p className="text-xs leading-relaxed text-stone-500">
            There is deliberately no delete: the frozen connection lifecycle has no terminal
            state — suspend pauses it, connect resumes it, and the append-only event ledger
            keeps every transition.
          </p>
        </div>
      }
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium text-stone-800">
            {connection.providerLabel}
            <span className="ml-2 font-mono text-xs font-normal text-stone-400">
              {connection.adapterKey}
            </span>
          </p>
          <p className="mt-0.5 text-sm text-stone-500">
            pipe {connection.connectionId.slice(0, 8)}… · credential{" "}
            {connection.credentialReferenceId.slice(0, 8)}…
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1.5">
            <IntegrationStatusChip status={connection.status} health={connection.health} />
            {connection.lastCheckedAt ? (
              <span className="font-mono text-[11px] text-stone-500">
                probed {formatWhen(connection.lastCheckedAt)}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-stone-500">never probed</span>
            )}
          </p>
          {connection.lastError ? (
            <p className="mt-1.5 break-words text-xs leading-relaxed text-red-900">
              Last error: {connection.lastError}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <WorkspaceActionButton
            tone={isLive ? "plain" : "teal"}
            onClick={() =>
              void connect.mutateAsync({
                connectionId: connection.connectionId,
                expectedVersion: connection.version,
              })
            }
            disabled={connect.isPending}
            ariaLabel={`Connect ${connection.providerLabel} pipe`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Plug className="size-4" aria-hidden="true" />
              {isLive ? "Re-run the connect probe" : "Connect"}
            </span>
          </WorkspaceActionButton>
          <WorkspaceActionButton
            tone="amber"
            onClick={() => setSuspendOpen(true)}
            disabled={suspend.isPending || connection.status === "suspended"}
            ariaLabel={`Suspend ${connection.providerLabel}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <Pause className="size-4" aria-hidden="true" />
              Suspend
            </span>
          </WorkspaceActionButton>
        </div>
      </div>

      {connect.isError ? (
        <div className="mt-3">
          <RouteRefusalNote
            message={connect.error instanceof Error ? connect.error.message : String(connect.error)}
          />
        </div>
      ) : null}

      <ConfirmGate
        open={suspendOpen}
        onOpenChange={setSuspendOpen}
        title={`Suspend ${connection.providerLabel}`}
        consequence="The administrative pause: pure bookkeeping (no provider call), but reads and mutations through this pipe stop while it is suspended. The connect probe resumes it — the lifecycle has no terminal state."
        confirmLabel="Suspend this connection"
        busy={suspend.isPending}
        showReason
        reason={suspendReason}
        onReasonChange={setSuspendReason}
        onConfirm={() => {
          void suspend
            .mutateAsync({
              connectionId: connection.connectionId,
              expectedVersion: connection.version,
              ...(suspendReason === "" ? {} : { reason: suspendReason }),
            })
            .then(() => setSuspendOpen(false));
        }}
      />
    </ConnectionCard>
  );
}
