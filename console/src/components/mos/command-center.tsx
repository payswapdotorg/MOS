"use client";

/**
 * Journey A — Agency Command Center. Every section renders the live
 * /api/reporting/command-center/:agencyId view (plus the agency attention
 * queue and profit-intelligence strips, each labeled with its source) and
 * every item clicks through to the underlying resource.
 */

import { ArrowRight, Building2, Goal, ShieldAlert, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useAttentionQueue, useCommandCenter, useProfitAgency } from "./hooks";
import { useMosSession } from "./session-store";
import {
  CountChips,
  EmptyState,
  FigureDisplay,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  SourceRefList,
  StatusBadge,
  formatHorizon,
  formatWhen,
  shortId,
} from "./shared";

export function CommandCenterScreen() {
  const agencyId = useMosSession((state) => state.agencyId);
  const navigate = useMosSession((state) => state.navigate);
  const command = useCommandCenter(agencyId);
  const attention = useAttentionQueue(agencyId);
  const profit = useProfitAgency(agencyId);

  if (agencyId === null) {
    return <EmptyState title="No agency selected" hint="Select an agency to view its command center." />;
  }
  if (command.isPending) {
    return (
      <div className="space-y-4">
        <LoadingSkeleton rows={2} />
        <LoadingSkeleton rows={6} />
      </div>
    );
  }
  if (command.isError) {
    return <MosErrorView error={command.error} what="the command center" onRetry={() => void command.refetch()} />;
  }

  const view = command.data;
  const goalCount = view.portfolioGoals.goals.length;
  const attentionItems = attention.data?.items.slice(0, 6) ?? [];
  const blockedCount = Object.entries(attention.data?.counts ?? {})
    .filter(([key]) => key.includes("blocked"))
    .reduce((sum, [, value]) => sum + value, 0);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Command Center</h1>
        <p className="text-sm text-muted-foreground">
          Agency <span className="font-mono text-xs">{view.scope.agencyId}</span> ·{" "}
          {view.scope.clientCount} live client{view.scope.clientCount === 1 ? "" : "s"} · generated{" "}
          {formatWhen(view.generatedAt)} · source:{" "}
          <span className="font-mono text-xs">GET /api/reporting/command-center/:agencyId</span>
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Clients</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{view.scope.clientCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="gap-1 px-0" onClick={() => navigate({ kind: "clients" })}>
              Open portfolio <ArrowRight className="size-3" aria-hidden="true" />
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Goals (all states)</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{goalCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <CountChips counts={view.portfolioGoals.goalStatusCounts} labelSingular="goals" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Workflow instances</CardDescription>
            <CardTitle className="text-3xl tabular-nums">
              {Object.values(view.workflowState.instanceStatusCounts).reduce((a, b) => a + b, 0)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CountChips counts={view.workflowState.instanceStatusCounts} labelSingular="instances" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Blocked work (attention)</CardDescription>
            <CardTitle className="text-3xl tabular-nums">{blockedCount}</CardTitle>
          </CardHeader>
          <CardContent>
            <Button variant="ghost" size="sm" className="gap-1 px-0" onClick={() => navigate({ kind: "attention" })}>
              Open attention queue <ArrowRight className="size-3" aria-hidden="true" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Attention strip */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="size-4" aria-hidden="true" /> Attention — top ranked items
          </CardTitle>
          <CardDescription>
            Source: <span className="font-mono text-xs">GET /api/ai-operator/:agencyId/attention-queue</span>{" "}
            (rank {attention.data?.ranking.rankVersion ?? "…"})
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attention.isPending ? (
            <LoadingSkeleton rows={3} />
          ) : attention.isError ? (
            <MosErrorView error={attention.error} what="the attention queue" />
          ) : attentionItems.length === 0 ? (
            <EmptyState title="The AI Operator queue is empty" hint="No attention items were derived for this agency." />
          ) : (
            <ScrollList label="Top attention items" className="space-y-2">
              {attentionItems.map((item) => (
                <button
                  key={item.itemId}
                  type="button"
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => navigate({ kind: "attention" })}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      #{item.rank}
                    </Badge>
                    <StatusBadge status={item.category} />
                    <span className="font-mono text-xs text-muted-foreground">score {item.priorityScore}</span>
                    {item.scope.clientId ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        client {shortId(item.scope.clientId)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm">{item.rationale.headline}</p>
                  <p className="mt-1 text-xs text-muted-foreground">Next: {item.actionContract.note}</p>
                </button>
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>

      {/* Portfolio goals */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Goal className="size-4" aria-hidden="true" /> Portfolio goals
          </CardTitle>
          <CardDescription>
            Basis: {view.risks.basis === "" ? "command-center aggregation" : "command-center aggregation"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {goalCount === 0 ? (
            <EmptyState title="No goals yet" hint="Goals appear here once they are created for the agency's clients." />
          ) : (
            <ScrollList label="Portfolio goals" className="space-y-2">
              {view.portfolioGoals.goals.map((goal) => (
                <button
                  key={goal.goalId}
                  type="button"
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => navigate({ kind: "client", clientId: goal.clientId, tab: "goals" })}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={goal.status} />
                    <span className="font-mono text-xs text-muted-foreground">client {shortId(goal.clientId)}</span>
                    {goal.timeHorizon ? (
                      <span className="font-mono text-xs text-muted-foreground">
                        horizon {formatHorizon(goal.timeHorizon)}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-sm">{goal.objective}</p>
                  {goal.constraints.length > 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Constraints: {goal.constraints.map((c) => `${c.kind} — ${c.description}`).join("; ")}
                    </p>
                  ) : null}
                </button>
              ))}
            </ScrollList>
          )}
          {view.portfolioGoals.perClient.length > 0 ? (
            <>
              <Separator />
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Per client</p>
              <div className="space-y-1.5">
                {view.portfolioGoals.perClient.map((tally) => (
                  <button
                    key={tally.clientId}
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent"
                    onClick={() => navigate({ kind: "client", clientId: tally.clientId, tab: "goals" })}
                  >
                    <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="font-mono text-xs">{shortId(tally.clientId)}</span>
                    <CountChips counts={tally.goalStatusCounts} />
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {/* Workflow state */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="size-4" aria-hidden="true" /> Workflow state
          </CardTitle>
          <CardDescription>Instance counts by status across the agency&apos;s workspaces.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {view.workflowState.workflows.length === 0 ? (
            <EmptyState title="No workflows yet" hint="Workflow containers appear once created in a workspace." />
          ) : (
            <ScrollList label="Workflows" className="space-y-2">
              {view.workflowState.workflows.map((workflow) => (
                <button
                  key={workflow.workflowId}
                  type="button"
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => navigate({ kind: "client", clientId: workflow.clientId, tab: "workflows" })}
                >
                  <p className="text-sm font-medium">{workflow.name}</p>
                  {workflow.description ? (
                    <p className="text-xs text-muted-foreground">{workflow.description}</p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <CountChips counts={workflow.instanceCounts} />
                    <span className="font-mono text-xs text-muted-foreground">
                      client {shortId(workflow.clientId)}
                    </span>
                  </div>
                </button>
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>

      {/* Evidence quality */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Evidence quality</CardTitle>
          <CardDescription>
            Read window: <span className="font-mono text-xs">{view.evidenceQuality.window}</span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Total records</p>
              <p className="text-2xl font-semibold tabular-nums">{view.evidenceQuality.totalRecords}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Low-grade records</p>
              <p className="text-2xl font-semibold tabular-nums">{view.evidenceQuality.lowGradeRecords}</p>
            </div>
          </div>
          {view.evidenceQuality.byClass.length === 0 ? (
            <EmptyState title="No evidence records yet" hint="Evidence appears once recorded for the agency's clients." />
          ) : (
            <div className="space-y-1.5">
              {view.evidenceQuality.byClass.map((posture) => (
                <div key={posture.class} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="font-mono text-xs">{posture.class}</span>
                  <span className="text-sm tabular-nums">{posture.total}</span>
                  <CountChips counts={posture.gradeCounts} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Risks + approvals */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Risks</CardTitle>
            <CardDescription>
              Basis: <span className="font-mono text-xs">{view.risks.basis}</span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            {view.risks.items.length === 0 ? (
              <EmptyState title="No derived risks" hint="Risk items are derived from goal constraints and execution state." />
            ) : (
              <ScrollList label="Risks" className="space-y-2">
                {view.risks.items.map((item, index) => (
                  <div key={index} className="rounded-lg border p-3">
                    <StatusBadge status={item["kind"] ?? "risk"} />
                    <p className="mt-1 text-sm">{item["description"] ?? item["status"] ?? item["kind"]}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {item["goalId"] ? `goal ${shortId(item["goalId"])}` : null}
                      {item["executionId"] ? `execution ${shortId(item["executionId"])}` : null}
                      {item["clientId"] ? ` · client ${shortId(item["clientId"])}` : null}
                      {item["updatedAt"] ? ` · ${formatWhen(item["updatedAt"])}` : ""}
                    </p>
                    {item["clientId"] ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-8 gap-1 px-0"
                        onClick={() => navigate({ kind: "client", clientId: item["clientId"], tab: "overview" })}
                      >
                        Investigate client <ArrowRight className="size-3" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending approvals</CardTitle>
            <CardDescription>Experiments awaiting decision and gated workflow transitions.</CardDescription>
          </CardHeader>
          <CardContent>
            {view.pendingApprovals.items.length === 0 ? (
              <EmptyState title="Nothing awaiting approval" hint="Approvals appear when experiments or workflow instances need a decision." />
            ) : (
              <ScrollList label="Pending approvals" className="space-y-2">
                {view.pendingApprovals.items.map((item, index) => (
                  <div key={index} className="rounded-lg border p-3">
                    <StatusBadge status={item["kind"] ?? "approval"} />
                    <p className="mt-1 text-sm">{item["hypothesis"] ?? item["instanceStatus"] ?? item["kind"]}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {item["experimentId"] ? `experiment ${shortId(item["experimentId"])}` : null}
                      {item["workflowInstanceId"] ? `instance ${shortId(item["workflowInstanceId"])}` : null}
                      {item["clientId"] ? ` · client ${shortId(item["clientId"])}` : null}
                    </p>
                    {item["clientId"] ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-8 gap-1 px-0"
                        onClick={() => navigate({ kind: "client", clientId: item["clientId"], tab: "decisions" })}
                      >
                        Go to decisions <ArrowRight className="size-3" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Margin signals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Margin &amp; scope signals</CardTitle>
          <CardDescription>
            Source: <span className="font-mono text-xs">GET /api/profit-intelligence/:agencyId</span> ·
            calculation {profit.data?.calculation.calculationVersion ?? "…"}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {profit.isPending ? (
            <LoadingSkeleton rows={2} />
          ) : profit.isError ? (
            <MosErrorView error={profit.error} what="profit intelligence" />
          ) : profit.data ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <FigureDisplay label="Realized margin" figure={profit.data.margin.realizedMargin} />
                <FigureDisplay label="Estimated margin" figure={profit.data.margin.estimatedMargin} />
                <FigureDisplay label="Total delivery cost" figure={profit.data.costs.totalDeliveryCost} />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Scope leakage indicators
                </p>
                {profit.data.scopeLeakage.indicators.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No scope leakage indicators derived.</p>
                ) : (
                  profit.data.scopeLeakage.indicators.map((indicator) => (
                    <div key={indicator.kind} className="rounded-md border p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">{indicator.kind}</span>
                        <span className="text-sm tabular-nums">{indicator.count}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{indicator.rule}</p>
                      <SourceRefList refs={indicator.sourceRefs} />
                    </div>
                  ))
                )}
              </div>
              <Button variant="outline" size="sm" className="gap-1" onClick={() => navigate({ kind: "profit" })}>
                Open Profit Intelligence <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
