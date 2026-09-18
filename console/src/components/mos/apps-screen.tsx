"use client";

/**
 * Journey E — Apps: Installed (version identity, upgrade/rollback through
 * the existing POST routes) and Marketplace (discover, trust, permissions,
 * install). The workspace selector drives all workspace-scoped surfaces.
 */

import * as React from "react";
import { History, Package, Puzzle, ShieldCheck, Store } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useClients,
  useInstallApp,
  useMarketplace,
  useMarketplaceDetail,
  useRollbackApp,
  useUpgradeApp,
  useWorkspaceInstalls,
  useWorkspaces,
} from "./hooks";
import { useMosSession, type AppsTab } from "./session-store";
import { EmptyState, LoadingSkeleton, MosErrorView, ScrollList, formatWhen, shortId } from "./shared";
import { AppsPacksSection } from "./apps-packs";

export function AppsScreen({ tab }: { tab: AppsTab }) {
  const agencyId = useMosSession((state) => state.agencyId);
  const [tabState, setTabState] = React.useState<AppsTab>(tab);
  React.useEffect(() => setTabState(tab), [tab]);

  const clients = useClients(agencyId);
  const [clientId, setClientId] = React.useState<string | null>(null);
  const effectiveClientId =
    clientId !== null && (clients.data ?? []).some((client) => client.clientId === clientId)
      ? clientId
      : ((clients.data ?? [])[0]?.clientId ?? null);
  const workspaces = useWorkspaces(effectiveClientId);
  const [workspaceId, setWorkspaceId] = React.useState<string | null>(null);
  const effectiveWorkspaceId =
    workspaceId !== null && (workspaces.data ?? []).some((entry) => entry.workspaceId === workspaceId)
      ? workspaceId
      : ((workspaces.data ?? [])[0]?.workspaceId ?? null);
  const selectedWorkspace = (workspaces.data ?? []).find((entry) => entry.workspaceId === effectiveWorkspaceId);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Puzzle className="size-5" aria-hidden="true" /> Apps
        </h1>
        <p className="text-sm text-muted-foreground">
          Installs, marketplace, first-party packs and the developer portal — every version identity
          comes from the MOS app registry.
        </p>
      </header>

      {/* Workspace selector (drives workspace-scoped app surfaces) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Workspace scope</CardTitle>
          <CardDescription>
            App installs, upgrades, rollbacks and pack surfaces are workspace-scoped; marketplace
            browsing is agency-scoped.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="mos-app-client">Client</Label>
            <Select
              value={effectiveClientId ?? ""}
              onValueChange={(value) => {
                setClientId(value);
                setWorkspaceId(null);
              }}
            >
              <SelectTrigger id="mos-app-client" className="h-10">
                <SelectValue placeholder={agencyId === null ? "No agency" : "Select client"} />
              </SelectTrigger>
              <SelectContent>
                {(clients.data ?? []).map((client) => (
                  <SelectItem key={client.clientId} value={client.clientId}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="mos-app-workspace">Workspace</Label>
            <Select value={effectiveWorkspaceId ?? ""} onValueChange={setWorkspaceId}>
              <SelectTrigger id="mos-app-workspace" className="h-10">
                <SelectValue placeholder="Select workspace" />
              </SelectTrigger>
              <SelectContent>
                {(workspaces.data ?? []).map((workspace) => (
                  <SelectItem key={workspace.workspaceId} value={workspace.workspaceId}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div role="tablist" aria-label="Apps sections" className="flex flex-wrap gap-2">
        {(
          [
            ["installed", "Installed", Package],
            ["marketplace", "Marketplace", Store],
            ["first-party", "First-party packs", Puzzle],
            ["developer", "Developer portal", History],
          ] as Array<[AppsTab, string, React.ComponentType<{ className?: string }>]> 
        ).map(([value, label, Icon]) => (
          <Button
            key={value}
            role="tab"
            aria-selected={tabState === value}
            variant={tabState === value ? "secondary" : "outline"}
            className="gap-2"
            onClick={() => setTabState(value)}
          >
            <Icon className="size-4" aria-hidden="true" /> {label}
          </Button>
        ))}
      </div>

      {agencyId === null ? (
        <EmptyState title="No agency selected" hint="Select an agency to browse the marketplace." />
      ) : tabState === "installed" ? (
        <InstalledSection workspaceId={effectiveWorkspaceId} workspaceName={selectedWorkspace?.name} />
      ) : tabState === "marketplace" ? (
        <MarketplaceSection agencyId={agencyId} workspaceId={effectiveWorkspaceId} />
      ) : tabState === "first-party" ? (
        <AppsPacksSection workspaceId={effectiveWorkspaceId} mode="packs" />
      ) : (
        <AppsPacksSection workspaceId={effectiveWorkspaceId} mode="developer" />
      )}
    </div>
  );
}

function InstalledSection({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string | null;
  workspaceName: string | undefined;
}) {
  const installs = useWorkspaceInstalls(workspaceId);
  const [upgradeTarget, setUpgradeTarget] = React.useState<Record<string, string>>({});

  if (workspaceId === null) {
    return (
      <EmptyState
        title="No workspace in scope"
        hint="Pick a client and workspace above (or create one through the MOS workspaces API) to manage app installs."
      />
    );
  }
  if (installs.isPending) return <LoadingSkeleton rows={4} />;
  if (installs.isError) {
    return <MosErrorView error={installs.error} what="the install list" onRetry={() => void installs.refetch()} />;
  }

  const list = installs.installs ?? [];
  const byApp = new Map<string, typeof list>();
  for (const install of list) {
    const group = byApp.get(install.appKey) ?? [];
    group.push(install);
    byApp.set(install.appKey, group);
  }

  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-muted-foreground">
        source: GET /api/workspaces/:workspaceId/app-installs · workspace{" "}
        {workspaceName ?? shortId(workspaceId)} · {list.length} install row{list.length === 1 ? "" : "s"} (
        historical version identity preserved by the API)
      </p>
      {list.length === 0 ? (
        <EmptyState title="No apps installed in this workspace" hint="Install from the Marketplace tab." />
      ) : (
        [...byApp.entries()].map(([appKey, group]) => {
          const active = group.find((install) => install.status === "ACTIVE") ?? group[0];
          const history = group.filter((install) => install.installId !== active.installId);
          return (
            <InstallRow
              key={appKey}
              appKey={appKey}
              workspaceId={workspaceId}
              active={active}
              history={history}
              upgradeVersion={upgradeTarget[appKey] ?? ""}
              onUpgradeVersion={(version) =>
                setUpgradeTarget((state) => ({ ...state, [appKey]: version }))
              }
            />
          );
        })
      )}
    </div>
  );
}

function InstallRow({
  appKey,
  workspaceId,
  active,
  history,
  upgradeVersion,
  onUpgradeVersion,
}: {
  appKey: string;
  workspaceId: string;
  active: import("@/lib/mos-api").AppInstallRecord;
  history: import("@/lib/mos-api").AppInstallRecord[];
  upgradeVersion: string;
  onUpgradeVersion: (version: string) => void;
}) {
  const upgrade = useUpgradeApp(workspaceId, active.installId);
  const rollback = useRollbackApp(workspaceId, active.installId);
  const [rollbackTarget, setRollbackTarget] = React.useState<string>("");

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-base">{appKey}</CardTitle>
          <Badge variant={active.status === "ACTIVE" ? "default" : "outline"}>{active.status}</Badge>
          <Badge variant="secondary" className="font-mono">
            v{active.version}
          </Badge>
          <span className="font-mono text-xs text-muted-foreground">
            seq {active.selectionSeq} · installed {formatWhen(active.installedAt)}
          </span>
        </div>
        <CardDescription className="font-mono text-[10px]">
          appVersionId {active.appVersionId} · installId {shortId(active.installId)} · operation{" "}
          {active.operation}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div>
            <p className="font-medium uppercase tracking-wide text-muted-foreground">Granted data scopes</p>
            <p className="font-mono">
              {active.grantedDataScopes.length > 0 ? active.grantedDataScopes.join(", ") : "none"}
            </p>
          </div>
          <div>
            <p className="font-medium uppercase tracking-wide text-muted-foreground">Granted mutation scopes</p>
            <p className="font-mono">
              {active.grantedMutationScopes.length > 0 ? active.grantedMutationScopes.join(", ") : "none"}
            </p>
          </div>
          <div>
            <p className="font-medium uppercase tracking-wide text-muted-foreground">Policy decision</p>
            <p className="font-mono">{active.policyDecisionId ?? "—"}</p>
          </div>
        </div>

        {/* Upgrade: select any registry version through the real POST */}
        <div className="space-y-1.5 rounded-lg border p-3">
          <Label htmlFor={`mos-upgrade-${appKey}`} className="text-xs">
            Upgrade to version (POST …/app-installs/:installId/upgrade)
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`mos-upgrade-${appKey}`}
              className="h-9 font-mono text-sm"
              placeholder="e.g. 1.1.0"
              value={upgradeVersion}
              onChange={(event) => onUpgradeVersion(event.target.value)}
            />
            <Button
              size="sm"
              disabled={upgrade.isPending || upgradeVersion.trim() === "" || upgradeVersion.trim() === active.version}
              onClick={() => upgrade.mutate(upgradeVersion.trim())}
            >
              Upgrade
            </Button>
          </div>
        </div>

        {/* Rollback: pick a prior superseded install row */}
        {history.length > 0 ? (
          <div className="space-y-1.5 rounded-lg border p-3">
            <Label htmlFor={`mos-rollback-${appKey}`} className="text-xs">
              Rollback to a prior selection (POST …/app-installs/:installId/rollback)
            </Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={rollbackTarget} onValueChange={setRollbackTarget}>
                <SelectTrigger id={`mos-rollback-${appKey}`} className="h-9 font-mono text-sm">
                  <SelectValue placeholder="Prior install" />
                </SelectTrigger>
                <SelectContent>
                  {history.map((prior) => (
                    <SelectItem key={prior.installId} value={prior.installId} className="font-mono text-xs">
                      v{prior.version} · seq {prior.selectionSeq} · {prior.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={rollback.isPending || rollbackTarget === ""}
                onClick={() => rollback.mutate(rollbackTarget)}
              >
                Rollback
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No prior selections to roll back to (this is the first recorded selection).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function MarketplaceSection({
  agencyId,
  workspaceId,
}: {
  agencyId: string;
  workspaceId: string | null;
}) {
  const [search, setSearch] = React.useState("");
  const marketplace = useMarketplace(agencyId, { search });
  const [detailKey, setDetailKey] = React.useState<string | null>(null);

  if (marketplace.isPending) return <LoadingSkeleton rows={4} />;
  if (marketplace.isError) {
    return (
      <MosErrorView error={marketplace.error} what="the marketplace" onRetry={() => void marketplace.refetch()} />
    );
  }
  const apps = marketplace.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          className="h-10 sm:max-w-xs"
          placeholder="Search apps…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search marketplace apps"
        />
        <p className="font-mono text-xs text-muted-foreground">
          source: GET /api/app-marketplace/:agencyId/apps?search=… · {apps.length} app
          {apps.length === 1 ? "" : "s"}
        </p>
      </div>

      {apps.length === 0 ? (
        <EmptyState
          title="No apps in the marketplace"
          hint="Apps appear once publishers publish versions through the developer portal."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {apps.map((entry) => (
            <Card key={entry.appKey} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="font-mono text-base">{entry.appKey}</CardTitle>
                  <Badge variant="outline" className="font-mono text-xs">
                    {entry.publisherKind}
                  </Badge>
                  <Badge
                    variant={entry.trustState.trustLevel === "MOS_CERTIFIED" ? "default" : "secondary"}
                    className="font-mono text-xs"
                  >
                    <ShieldCheck className="mr-1 size-3" aria-hidden="true" />
                    {entry.trustState.trustLevel}
                  </Badge>
                </div>
                <CardDescription className="font-mono text-xs">
                  publisher {entry.publisher} · latest{" "}
                  {entry.latestVersion?.version ?? "—"} · {entry.versions.length} version
                  {entry.versions.length === 1 ? "" : "s"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-3">
                <p className="text-xs text-muted-foreground">
                  Reviews: {entry.reviewSummary.reviewCount}
                  {entry.reviewSummary.averageRating !== undefined
                    ? ` · avg ${entry.reviewSummary.averageRating}`
                    : ""}
                  {Object.entries(entry.reviewSummary.verdictCounts)
                    .filter(([, value]) => value !== 0)
                    .map(([key, value]) => ` · ${key}: ${value}`)
                    .join("")}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => setDetailKey(entry.appKey)}>
                    Details &amp; trust ledger
                  </Button>
                  {workspaceId !== null ? <InstallButton entry={entry} workspaceId={workspaceId} /> : null}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <MarketplaceDetailDialog
        agencyId={agencyId}
        appKey={detailKey}
        onOpenChange={(open) => {
          if (!open) setDetailKey(null);
        }}
      />
    </div>
  );
}

function InstallButton({
  entry,
  workspaceId,
}: {
  entry: import("@/lib/mos-api").MarketplaceAppEntry;
  workspaceId: string;
}) {
  const install = useInstallApp(workspaceId);
  const [version, setVersion] = React.useState(entry.latestVersion?.version ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={version} onValueChange={setVersion}>
        <SelectTrigger className="h-9 w-32 font-mono text-xs" aria-label={`Install version for ${entry.appKey}`}>
          <SelectValue placeholder="version" />
        </SelectTrigger>
        <SelectContent>
          {entry.versions.map((candidate) => (
            <SelectItem key={candidate.appVersionId} value={candidate.version} className="font-mono text-xs">
              v{candidate.version}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={install.isPending || version === ""}
        onClick={() => install.mutate({ appKey: entry.appKey, version })}
      >
        Install
      </Button>
    </div>
  );
}

function MarketplaceDetailDialog({
  agencyId,
  appKey,
  onOpenChange,
}: {
  agencyId: string;
  appKey: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useMarketplaceDetail(agencyId, appKey);
  return (
    <Dialog open={appKey !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">{appKey}</DialogTitle>
          <DialogDescription>
            source:{" "}
            <span className="font-mono text-xs">GET /api/app-marketplace/:agencyId/apps/:appKey</span>
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : detail.isError ? (
          <MosErrorView error={detail.error} what="the app detail" />
        ) : detail.data ? (
          <div className="space-y-4 text-sm">
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Version history (immutable registry identity)
              </h3>
              <ScrollList label="Versions" className="space-y-1">
                {detail.data.entry.versions.map((version) => (
                  <div key={version.appVersionId} className="flex flex-wrap items-center gap-2 rounded border p-2">
                    <Badge variant="secondary" className="font-mono text-xs">
                      v{version.version}
                    </Badge>
                    <span className="font-mono text-xs text-muted-foreground">{version.runtimeClass}</span>
                    <span className="text-xs text-muted-foreground">{formatWhen(version.publishedAt)}</span>
                    <span className="w-full font-mono text-[10px] text-muted-foreground">
                      capabilities: {version.capabilities.join(", ") || "—"}
                    </span>
                  </div>
                ))}
              </ScrollList>
            </section>
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Trust ledger
              </h3>
              {detail.data.trustEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">No trust transitions recorded.</p>
              ) : (
                <ScrollList label="Trust events" className="space-y-1">
                  {detail.data.trustEvents.map((event) => (
                    <div key={event.eventId} className="rounded border p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="font-mono text-xs">
                          {event.transition}
                        </Badge>
                        <span className="font-mono text-xs">
                          {event.fromState} → {event.toState}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatWhen(event.recordedAt)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{event.reason}</p>
                    </div>
                  ))}
                </ScrollList>
              )}
            </section>
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Reviews</h3>
              {detail.data.reviews.length === 0 ? (
                <p className="text-xs text-muted-foreground">No reviews recorded.</p>
              ) : (
                <ScrollList label="Reviews" className="space-y-1">
                  {detail.data.reviews.map((review) => (
                    <div key={review.reviewId} className="rounded border p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="secondary" className="font-mono text-xs">
                          {review.rating}/5 · {review.verdict}
                        </Badge>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatWhen(review.recordedAt)}
                        </span>
                      </div>
                      <p className="text-xs">{review.body}</p>
                    </div>
                  ))}
                </ScrollList>
              )}
            </section>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
