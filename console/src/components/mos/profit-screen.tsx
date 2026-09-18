"use client";

/**
 * Profit Intelligence — the derived financial surface. The soul of this
 * screen is PROVENANCE: every figure carries its calculation version,
 * assumptions and source references; the calculation block ships the full
 * frozen assumption record. Client drill-in uses the client-scoped view.
 */

import * as React from "react";
import { ArrowRight, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useClients, useProfitAgency, useProfitClient } from "./hooks";
import { useMosSession } from "./session-store";
import {
  AssumptionDisclosure,
  EmptyState,
  FigureDisplay,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  SourceRefList,
  formatWhen,
  shortId,
} from "./shared";

export function ProfitScreen() {
  const agencyId = useMosSession((state) => state.agencyId);
  const navigate = useMosSession((state) => state.navigate);
  const profit = useProfitAgency(agencyId);
  const clients = useClients(agencyId);
  const [drillClient, setDrillClient] = React.useState<string | null>(null);

  if (agencyId === null) {
    return <EmptyState title="No agency selected" hint="Select an agency to view profit intelligence." />;
  }
  if (profit.isPending) return <LoadingSkeleton rows={6} />;
  if (profit.isError) {
    return <MosErrorView error={profit.error} what="profit intelligence" onRetry={() => void profit.refetch()} />;
  }

  const view = profit.data;
  const clientNames = new Map((clients.data ?? []).map((client) => [client.clientId, client.name]));

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <TrendingUp className="size-5" aria-hidden="true" /> Profit Intelligence
        </h1>
        <p className="text-sm text-muted-foreground">
          {view.scope.clientCount} client{view.scope.clientCount === 1 ? "" : "s"} ·{" "}
          {view.scope.humanAgentCount} human agent{view.scope.humanAgentCount === 1 ? "" : "s"} · source:{" "}
          <span className="font-mono text-xs">GET /api/profit-intelligence/:agencyId</span> · generated{" "}
          {formatWhen(view.generatedAt)}
        </p>
      </header>

      {/* The calculation block — provenance first */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Calculation &amp; assumptions</CardTitle>
          <CardDescription>
            {view.calculation.basis} · persistence: {view.calculation.persistence}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="font-mono text-xs text-muted-foreground">
            calculationVersion: {view.calculation.calculationVersion}
          </p>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Frozen assumption record — every constant the calculation consumed
            </p>
            <AssumptionDisclosure
              assumptions={view.calculation.assumptions ?? {}}
              label="Profit calculation assumptions"
            />
          </div>
        </CardContent>
      </Card>

      {/* Margin headline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Margins</CardTitle>
          <CardDescription>{view.margin.currencyPolicyNote}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FigureDisplay label="Realized revenue" figure={view.margin.realizedRevenue} />
            <FigureDisplay label="Realized delivery cost" figure={view.margin.realizedDeliveryCost} />
            <FigureDisplay label="Realized margin" figure={view.margin.realizedMargin} />
            <FigureDisplay label="Estimated revenue" figure={view.margin.estimatedRevenue} />
            <FigureDisplay label="Estimated delivery cost" figure={view.margin.estimatedDeliveryCost} />
            <FigureDisplay label="Estimated margin" figure={view.margin.estimatedMargin} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Revenue rollup</CardTitle>
            <CardDescription>
              {view.revenue.observationCount} observation{view.revenue.observationCount === 1 ? "" : "s"} ·{" "}
              {view.revenue.restatedIdentityCount} restated identit
              {view.revenue.restatedIdentityCount === 1 ? "y" : "ies"} ·{" "}
              {view.revenue.supersededObservationCount} superseded
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {view.revenue.byCurrency.length === 0 ? (
              <EmptyState title="No revenue observations" hint="Revenue appears from metric observations recorded through the MOS metrics API." />
            ) : (
              view.revenue.byCurrency.map((entry) => (
                <div key={entry.currency} className="space-y-1 rounded-lg border p-3">
                  <FigureDisplay label={`Total (${entry.currency})`} figure={entry.total} />
                  <p className="text-xs text-muted-foreground">
                    {entry.identityCount} identit{entry.identityCount === 1 ? "y" : "ies"}
                  </p>
                  <SourceRefList refs={entry.sourceRefs} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Delivery costs</CardTitle>
            <CardDescription>
              {view.costs.deliveredJobCount} delivered job{view.costs.deliveredJobCount === 1 ? "" : "s"} ·{" "}
              {view.costs.inFlightJobCount} in flight
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3">
              <FigureDisplay label="Human delivery cost" figure={view.costs.humanDeliveryCost} />
              <FigureDisplay label="Automation delivery cost" figure={view.costs.automationDeliveryCost} />
              <FigureDisplay label="Total delivery cost" figure={view.costs.totalDeliveryCost} />
            </div>
            <p className="text-xs text-muted-foreground">{view.costs.humanExecutionCostAttribution}</p>
            <p className="text-xs text-muted-foreground">
              AI provider telemetry: {view.costs.aiProvider.telemetryCost.value}{" "}
              {view.costs.aiProvider.telemetryCost.currency} over {view.costs.aiProvider.telemetryRowCount} row
              {view.costs.aiProvider.telemetryRowCount === 1 ? "" : "s"} ·{" "}
              {view.costs.aiProvider.adapterActivityNote}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Capacity &amp; utilization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm">
              {view.capacity.activeProfileCount} active profile
              {view.capacity.activeProfileCount === 1 ? "" : "s"} · {view.capacity.skippedProfileCount} skipped ·{" "}
              {view.capacity.weeklyCapacityMinutes} weekly capacity minute
              {view.capacity.weeklyCapacityMinutes === 1 ? "" : "s"}
            </p>
            <FigureDisplay label="Weekly capacity cost" figure={view.capacity.weeklyCapacityCost} />
            <FigureDisplay label="Delivered work minutes" figure={view.utilization.deliveredWorkMinutes} />
            <FigureDisplay label="Utilization" figure={view.utilization.utilization} />
            <p className="text-xs text-muted-foreground">{view.utilization.numeratorNote}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Scope leakage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {view.scopeLeakage.indicators.length === 0 ? (
              <EmptyState title="No scope leakage indicators" />
            ) : (
              view.scopeLeakage.indicators.map((indicator) => (
                <div key={indicator.kind} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">{indicator.kind}</span>
                    <span className="text-sm tabular-nums">{indicator.count}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{indicator.rule}</p>
                  <SourceRefList refs={indicator.sourceRefs} />
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-client contributions */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Per-client contributions</CardTitle>
          <CardDescription>Click a row for the client-scoped profit intelligence view.</CardDescription>
        </CardHeader>
        <CardContent>
          {view.perClient.length === 0 ? (
            <EmptyState title="No client contributions" hint="Contributions derive from jobs, executions and metric observations." />
          ) : (
            <div className="space-y-2">
              {view.perClient.map((row) => (
                <button
                  key={row.clientId}
                  type="button"
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => setDrillClient(row.clientId)}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {clientNames.get(row.clientId) ?? shortId(row.clientId)}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      drill in <ArrowRight className="size-3" aria-hidden="true" />
                    </span>
                  </div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-3">
                    <FigureDisplay label="Revenue" figure={row.revenue} />
                    <FigureDisplay label="Delivery cost" figure={row.deliveryCost} />
                    <FigureDisplay label="Margin" figure={row.margin} />
                  </div>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Service + project contributions */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Service contributions (playbooks)</CardTitle>
          </CardHeader>
          <CardContent>
            {view.serviceContributions.length === 0 ? (
              <EmptyState title="No service contributions" />
            ) : (
              <ScrollList label="Service contributions" className="space-y-2">
                {view.serviceContributions.map((row) => (
                  <div key={row.playbookId} className="rounded-lg border p-3">
                    <p className="font-mono text-xs">playbook {shortId(row.playbookId)}</p>
                    <div className="mt-1 grid gap-2 sm:grid-cols-2">
                      <FigureDisplay label="Delivery cost" figure={row.deliveryCost} />
                      <FigureDisplay label="Revenue" figure={row.revenue} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.deliveredJobCount} delivered job{row.deliveredJobCount === 1 ? "" : "s"} ·{" "}
                      {row.executionCount} execution{row.executionCount === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </ScrollList>
            )}
            <div className="mt-3">
              <FigureDisplay label="Unattributed service cost" figure={view.unattributedServiceDeliveryCost} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Project contributions (deployments)</CardTitle>
          </CardHeader>
          <CardContent>
            {view.projectContributions.length === 0 ? (
              <EmptyState title="No project contributions" />
            ) : (
              <ScrollList label="Project contributions" className="space-y-2">
                {view.projectContributions.map((row) => (
                  <div key={row.deploymentId} className="rounded-lg border p-3">
                    <p className="font-mono text-xs">
                      deployment {shortId(row.deploymentId)} · {row.deploymentStatus}
                    </p>
                    <div className="mt-1 grid gap-2 sm:grid-cols-2">
                      <FigureDisplay label="Delivery cost" figure={row.deliveryCost} />
                      <FigureDisplay label="Revenue" figure={row.revenue} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {row.deliveredJobCount} delivered job{row.deliveredJobCount === 1 ? "" : "s"} ·{" "}
                      {row.executionCount} execution{row.executionCount === 1 ? "" : "s"}
                    </p>
                  </div>
                ))}
              </ScrollList>
            )}
            <div className="mt-3">
              <FigureDisplay label="Unattributed project cost" figure={view.unattributedProjectDeliveryCost} />
            </div>
          </CardContent>
        </Card>
      </div>

      <ProfitClientDialog
        agencyId={agencyId}
        clientId={drillClient}
        clientName={drillClient === null ? null : (clientNames.get(drillClient) ?? undefined)}
        onOpenChange={(open) => {
          if (!open) setDrillClient(null);
        }}
        onOpenClient={() => {
          if (drillClient !== null) navigate({ kind: "client", clientId: drillClient, tab: "overview" });
        }}
      />
    </div>
  );
}

function ProfitClientDialog({
  agencyId,
  clientId,
  clientName,
  onOpenChange,
  onOpenClient,
}: {
  agencyId: string;
  clientId: string | null;
  // P0-SRC: fixed a latent type error (TS2322) the deployment workspace's
  // repo-wide tsc include masked — the call site legitimately passes null
  // (no drill target) and the render already handles null via `?? "client"`.
  clientName?: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenClient: () => void;
}) {
  const detail = useProfitClient(agencyId, clientId);
  return (
    <Dialog open={clientId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Profit intelligence — {clientName ?? "client"}</DialogTitle>
          <DialogDescription>
            source:{" "}
            <span className="font-mono text-xs">
              GET /api/profit-intelligence/:agencyId/clients/:clientId
            </span>
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : detail.isError ? (
          <MosErrorView error={detail.error} what="client profit intelligence" />
        ) : detail.data ? (
          <div className="space-y-4 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <FigureDisplay label="Realized margin" figure={detail.data.margin.realizedMargin} />
              <FigureDisplay label="Estimated margin" figure={detail.data.margin.estimatedMargin} />
              <FigureDisplay label="Total delivery cost" figure={detail.data.costs.totalDeliveryCost} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FigureDisplay label="Delivered work minutes" figure={detail.data.utilization.deliveredWorkMinutes} />
              <FigureDisplay label="Utilization" figure={detail.data.utilization.utilization} />
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              calculationVersion: {detail.data.calculation.calculationVersion} · generated{" "}
              {formatWhen(detail.data.generatedAt)}
            </p>
            <Button variant="outline" size="sm" className="gap-1" onClick={onOpenClient}>
              Open client workspace <ArrowRight className="size-3" aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
