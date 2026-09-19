"use client";

/**
 * Journey B — the Client Workspace: Overview, Goals, Strategy/Playbooks,
 * Deployments, Workflows, Evidence, Decisions, Learning, Operating Memory.
 * Each tab renders the corresponding live MOS domain listing (or the
 * decision-room composed view for Overview).
 */

import * as React from "react";
import { ArrowRight, Beaker, BookOpen, Boxes, Brain, Goal, LayoutDashboard, Map, ScrollText, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useClient,
  useClientMemory,
  useDecisionRoom,
  useDecisions,
  useDeployments,
  useEvidence,
  useGoals,
  useLearnings,
  usePlaybooks,
  useWorkflows,
  useWorkspaces,
} from "./hooks";
import { useMosSession, type ClientWorkspaceTab } from "./session-store";
import {
  AssumptionDisclosure,
  CountChips,
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  SourceRefList,
  StatusBadge,
  formatHorizon,
  formatWhen,
  shortId,
} from "./shared";

const TABS: Array<{ value: ClientWorkspaceTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "goals", label: "Goals", icon: Goal },
  { value: "playbooks", label: "Strategy", icon: Map },
  { value: "deployments", label: "Deployments", icon: Boxes },
  { value: "workflows", label: "Workflows", icon: Workflow },
  { value: "evidence", label: "Evidence", icon: ScrollText },
  { value: "decisions", label: "Decisions", icon: Beaker },
  { value: "learning", label: "Learning", icon: BookOpen },
  { value: "memory", label: "Memory", icon: Brain },
];

export function ClientWorkspaceScreen({ clientId, tab }: { clientId: string; tab: ClientWorkspaceTab }) {
  const navigate = useMosSession((state) => state.navigate);
  const client = useClient(clientId);
  const workspaces = useWorkspaces(clientId);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <Button variant="ghost" size="sm" className="h-8 gap-1 px-0" onClick={() => navigate({ kind: "clients" })}>
          ← Clients
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {client.data?.name ?? shortId(clientId)}
        </h1>
        <p className="text-sm text-muted-foreground">
          {client.isPending ? (
            "loading client…"
          ) : client.isError ? (
            "client read failed — see below"
          ) : (
            <>
              <span className="font-mono text-xs">{client.data?.clientId}</span> · status{" "}
              {client.data?.status} · {(workspaces.data ?? []).length} workspace
              {(workspaces.data ?? []).length === 1 ? "" : "s"}
            </>
          )}
        </p>
      </header>
      {client.isError ? <MosErrorView error={client.error} what="the client record" /> : null}

      <Tabs
        value={tab}
        onValueChange={(value) => navigate({ kind: "client", clientId, tab: value as ClientWorkspaceTab })}
      >
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((entry) => (
            <TabsTrigger key={entry.value} value={entry.value} className="gap-1.5">
              <entry.icon className="size-3.5" aria-hidden="true" />
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="goals" className="mt-4">
          <GoalsTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="playbooks" className="mt-4">
          <PlaybooksTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="deployments" className="mt-4">
          <WorkspaceGroupedTab
            clientId={clientId}
            render={(workspaceId) => <DeploymentsList workspaceId={workspaceId} />}
            emptyHint="Deployments are workspace-scoped; create a workspace first."
          />
        </TabsContent>
        <TabsContent value="workflows" className="mt-4">
          <WorkspaceGroupedTab
            clientId={clientId}
            render={(workspaceId) => <WorkflowsList workspaceId={workspaceId} />}
            emptyHint="Workflows are workspace-scoped; create a workspace first."
          />
        </TabsContent>
        <TabsContent value="evidence" className="mt-4">
          <EvidenceTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="decisions" className="mt-4">
          <DecisionsTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="learning" className="mt-4">
          <LearningTab clientId={clientId} />
        </TabsContent>
        <TabsContent value="memory" className="mt-4">
          <MemoryTab clientId={clientId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function WorkspaceGroupedTab({
  clientId,
  render,
  emptyHint,
}: {
  clientId: string;
  render: (workspaceId: string) => React.ReactNode;
  emptyHint: string;
}) {
  const workspaces = useWorkspaces(clientId);
  if (workspaces.isPending) return <LoadingSkeleton rows={3} />;
  if (workspaces.isError) {
    return <MosErrorView error={workspaces.error} what="the workspace list" />;
  }
  const list = workspaces.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No workspaces for this client" hint={emptyHint} />;
  }
  return (
    <div className="space-y-4">
      {list.map((workspace) => (
        <Card key={workspace.workspaceId}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{workspace.name}</CardTitle>
            <CardDescription className="font-mono text-xs">
              {shortId(workspace.workspaceId)} · <StatusBadge status={workspace.status} />
            </CardDescription>
          </CardHeader>
          <CardContent>{render(workspace.workspaceId)}</CardContent>
        </Card>
      ))}
    </div>
  );
}

function OverviewTab({ clientId }: { clientId: string }) {
  const room = useDecisionRoom(clientId);
  if (room.isPending) return <LoadingSkeleton rows={5} />;
  if (room.isError) {
    return <MosErrorView error={room.error} what="the decision room" onRetry={() => void room.refetch()} />;
  }
  const view = room.data;
  // Defensive reads: the decision-room contract ships these blocks, but the
  // render must never crash on an absent one — it shows an honest empty
  // state instead (no fabricated data).
  const goals = view.whatHappened?.goals ?? [];
  const workflows = view.whatHappened?.workflows ?? [];
  const learnings = view.why?.learnings ?? [];
  const evidenceByClass = view.evidenceQuality?.byClass ?? [];
  const experiments = view.experiments?.experiments ?? [];
  const recommendations = view.recommendations?.items ?? [];
  const approvals = view.approvals?.items ?? [];
  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-muted-foreground">
        source: GET /api/reporting/decision-room/:clientId · generated {formatWhen(view.generatedAt)}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What happened — goals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CountChips counts={view.whatHappened?.goalStatusCounts ?? {}} labelSingular="goals" />
            {goals.length === 0 ? (
              <EmptyState title="No goals yet" hint="Goals appear here once created for this client." />
            ) : (
              <ScrollList label="Goals" className="space-y-1.5">
                {goals.map((goal) => (
                  <div key={goal.goalId} className="rounded-md border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={goal.status} />
                      {goal.timeHorizon ? (
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatHorizon(goal.timeHorizon)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-sm">{goal.objective}</p>
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">What happened — workflows</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CountChips counts={view.whatHappened?.instanceStatusCounts ?? {}} labelSingular="instances" />
            {workflows.length === 0 ? (
              <EmptyState title="No workflows yet" />
            ) : (
              <ScrollList label="Workflows" className="space-y-1.5">
                {workflows.map((workflow) => (
                  <div key={workflow.workflowId} className="rounded-md border p-2">
                    <p className="text-sm font-medium">{workflow.name}</p>
                    <CountChips counts={workflow.instanceCounts} />
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Why — learnings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CountChips counts={view.why?.learningStatusCounts ?? {}} labelSingular="learnings" />
            {learnings.length === 0 ? (
              <EmptyState title="No learnings yet" />
            ) : (
              <ScrollList label="Learnings" className="space-y-1.5">
                {learnings.map((learning) => (
                  <div key={learning.learningId} className="rounded-md border p-2">
                    <StatusBadge status={learning.status} />
                    <p className="mt-1 text-sm">{learning.statement}</p>
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Evidence quality</CardTitle>
            <CardDescription className="font-mono text-xs">{view.evidenceQuality?.window ?? "—"}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-2xl font-semibold tabular-nums">
              {view.evidenceQuality?.totalRecords ?? 0} records
            </p>
            {evidenceByClass.length === 0 ? (
              <EmptyState title="No evidence records yet" />
            ) : (
              evidenceByClass.map((posture) => (
                <div key={posture.class} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <span className="font-mono text-xs">{posture.class}</span>
                  <span className="text-sm tabular-nums">{posture.total}</span>
                  <CountChips counts={posture.gradeCounts} />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Experiments</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <CountChips counts={view.experiments?.experimentStatusCounts ?? {}} labelSingular="experiments" />
            {experiments.length === 0 ? (
              <EmptyState title="No experiments yet" />
            ) : (
              <ScrollList label="Experiments" className="space-y-1.5">
                {experiments.map((experiment) => (
                  <div key={experiment.experimentId} className="rounded-md border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={experiment.status} />
                      <span className="font-mono text-xs text-muted-foreground">{experiment.resultState}</span>
                    </div>
                    <p className="mt-1 text-sm">{experiment.hypothesis}</p>
                    <p className="text-xs text-muted-foreground">
                      target {experiment.decisionTarget} · {experiment.designType} · metric{" "}
                      {experiment.primaryMetricName}
                    </p>
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recommendations</CardTitle>
            <CardDescription className="font-mono text-xs">{view.recommendations?.basis ?? "—"}</CardDescription>
          </CardHeader>
          <CardContent>
            {recommendations.length === 0 ? (
              <EmptyState title="No recommendations derived" />
            ) : (
              <ScrollList label="Recommendations" className="space-y-1.5">
                {recommendations.map((item, index) => (
                  <div key={index} className="rounded-md border p-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      {String(item["kind"])}
                    </Badge>
                    <p className="mt-1 text-sm">
                      {typeof item["statement"] === "string" ? item["statement"] : String(item["hypothesis"] ?? "")}
                    </p>
                  </div>
                ))}
              </ScrollList>
            )}
          </CardContent>
        </Card>
      </div>

      {approvals.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Awaiting approval</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {approvals.map((item, index) => (
              <div key={index} className="rounded-md border p-2">
                <StatusBadge status={item["kind"]} />
                <p className="mt-1 text-sm">{item["hypothesis"] ?? item["instanceStatus"] ?? item["kind"]}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function GoalsTab({ clientId }: { clientId: string }) {
  const goals = useGoals(clientId);
  if (goals.isPending) return <LoadingSkeleton rows={4} />;
  if (goals.isError) return <MosErrorView error={goals.error} what="goals" onRetry={() => void goals.refetch()} />;
  const list = goals.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No goals yet" hint="Goals are created through the MOS goals API (no SPA creation path yet)." />;
  }
  return (
    <ScrollList label="Goals" className="space-y-3">
      {list.map((goal) => (
        <Card key={goal.goalId}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={goal.status} />
              <span className="font-mono text-xs text-muted-foreground">{shortId(goal.goalId)}</span>
              {goal.timeHorizon ? (
                <span className="font-mono text-xs text-muted-foreground">
                  horizon {formatHorizon(goal.timeHorizon)}
                </span>
              ) : null}
            </div>
            <CardTitle className="text-base">{goal.objective}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {goal.successCriteria.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Success criteria</p>
                <ul className="list-disc pl-4">
                  {goal.successCriteria.map((criterion, index) => (
                    <li key={index}>
                      <span className="font-mono text-xs">
                        {criterion.metric} {criterion.comparator} {criterion.targetValue}
                        {criterion.unit ? ` ${criterion.unit}` : ""}
                      </span>
                      {criterion.description ? ` — ${criterion.description}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {goal.metrics.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Metrics</p>
                <p className="font-mono text-xs">{goal.metrics.map((metric) => metric.name).join(", ")}</p>
              </div>
            ) : null}
            {goal.constraints.length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Constraints</p>
                <ul className="list-disc pl-4">
                  {goal.constraints.map((constraint, index) => (
                    <li key={index}>
                      <span className="font-mono text-xs">{constraint.kind}</span> — {constraint.description}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ))}
    </ScrollList>
  );
}

function PlaybooksTab({ clientId }: { clientId: string }) {
  const playbooks = usePlaybooks(clientId);
  if (playbooks.isPending) return <LoadingSkeleton rows={4} />;
  if (playbooks.isError) {
    return <MosErrorView error={playbooks.error} what="playbooks" onRetry={() => void playbooks.refetch()} />;
  }
  const list = playbooks.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No playbooks yet" hint="Playbooks are created through the MOS playbooks API (agency or client scoped)." />;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {list.map((playbook) => (
        <Card key={playbook.playbookId}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{playbook.name}</CardTitle>
            <CardDescription className="font-mono text-xs">
              {shortId(playbook.playbookId)} · v{playbook.version}
              {playbook.goalId ? ` · goal ${shortId(playbook.goalId)}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            {playbook.description ? playbook.description : "No description recorded."}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function DeploymentsList({ workspaceId }: { workspaceId: string }) {
  const deployments = useDeployments(workspaceId);
  if (deployments.isPending) return <LoadingSkeleton rows={3} />;
  if (deployments.isError) {
    return <MosErrorView error={deployments.error} what="deployments" onRetry={() => void deployments.refetch()} />;
  }
  const list = deployments.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No deployments in this workspace" hint="Deployments are created through the MOS deployments API." />;
  }
  return (
    <ScrollList label="Deployments" className="space-y-2">
      {list.map((deployment) => (
        <div key={deployment.deploymentId} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={deployment.status} />
            <span className="font-mono text-xs text-muted-foreground">{shortId(deployment.deploymentId)}</span>
            <span className="font-mono text-xs text-muted-foreground">v{deployment.version}</span>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            playbookVersion {shortId(deployment.playbookVersionId)} · {deployment.workflowDefinitionIds.length} workflow
            definition{deployment.workflowDefinitionIds.length === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted-foreground">updated {formatWhen(deployment.updatedAt)}</p>
        </div>
      ))}
    </ScrollList>
  );
}

function WorkflowsList({ workspaceId }: { workspaceId: string }) {
  const workflows = useWorkflows(workspaceId);
  if (workflows.isPending) return <LoadingSkeleton rows={3} />;
  if (workflows.isError) {
    return <MosErrorView error={workflows.error} what="workflows" onRetry={() => void workflows.refetch()} />;
  }
  const list = workflows.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No workflows in this workspace" hint="Workflows are created through the MOS workflows API." />;
  }
  return (
    <div className="space-y-2">
      {list.map((workflow) => (
        <div key={workflow.workflowId} className="rounded-lg border p-3">
          <p className="text-sm font-medium">{workflow.name}</p>
          {workflow.description ? (
            <p className="text-xs text-muted-foreground">{workflow.description}</p>
          ) : null}
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {shortId(workflow.workflowId)} · v{workflow.version} · updated {formatWhen(workflow.updatedAt)}
          </p>
        </div>
      ))}
    </div>
  );
}

function EvidenceTab({ clientId }: { clientId: string }) {
  const evidence = useEvidence(clientId);
  if (evidence.isPending) return <LoadingSkeleton rows={4} />;
  if (evidence.isError) {
    return <MosErrorView error={evidence.error} what="evidence" onRetry={() => void evidence.refetch()} />;
  }
  const list = evidence.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No evidence records yet" hint="Evidence is recorded through the MOS evidence API." />;
  }
  return (
    <ScrollList label="Evidence" className="space-y-2">
      {list.map((record) => (
        <div key={record.evidenceId} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="font-mono text-xs">
              {record.class}
            </Badge>
            <StatusBadge status={record.quality} />
            {record.confidence !== undefined ? (
              <span className="font-mono text-xs text-muted-foreground">
                confidence {record.confidence}
              </span>
            ) : null}
            {record.supersededBy ? <Badge variant="destructive">superseded</Badge> : null}
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {record.source.system}
            {record.source.ref ? `:${record.source.ref}` : ""} · observed {formatWhen(record.observedAt)}
          </p>
          <EvidenceContent content={record.content} />
          {record.supersedes ? (
            <p className="font-mono text-xs text-muted-foreground">supersedes {shortId(record.supersedes)}</p>
          ) : null}
        </div>
      ))}
    </ScrollList>
  );
}

/**
 * F-1 (VER-001): the evidence content payload as FORMATTED UI — never a raw
 * JSON dump, never a <pre> block. Typed presentation per KNOWN content
 * shape; every other shape falls back to the labeled key/value disclosure
 * (the same formatted style the neighbouring intelligence tabs pass with —
 * every key stays visible, nothing is dropped or synthesized).
 *
 * Content-shape inventory handled (the honest-shape rule — the backend
 * contract is a free-form non-empty JSON object, so the renderer must stay
 * total over every possible shape):
 *   1. metric observation `{ metric, value, unit?, … }` — the dominant shape
 *      of the authoritative classes (all three seeded Helio records are
 *      exactly this): metric name, the measured value and its unit as one
 *      formatted figure, remaining fields as labeled rows;
 *   2. statement-bearing claims `{ statement, … }` — the prose carrier of the
 *      claim classes (the attribution/causal_estimate classes additionally
 *      carry the contract-required `content.method`, rendered as a labeled
 *      row by the disclosure);
 *   3. any other / future shape — the `AssumptionDisclosure` labeled key/value
 *      list (nested records as sub-rows, vocabularies as chips, numbers
 *      tabular), still not a JSON dump.
 */
function EvidenceContent({ content }: { content: Record<string, unknown> }) {
  const entries = Object.entries(content);
  const metricName = typeof content["metric"] === "string" ? content["metric"] : null;
  const value = content["value"];
  if (
    metricName !== null &&
    (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
  ) {
    const unit = typeof content["unit"] === "string" ? content["unit"] : null;
    const rest = Object.fromEntries(
      entries.filter(([key]) => key !== "metric" && key !== "value" && key !== "unit"),
    );
    return (
      <div className="mt-2 space-y-2">
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs text-muted-foreground">{metricName}</span>
          <span className="font-mono text-lg font-semibold tabular-nums">
            {formatMetricValue(value)}
          </span>
          {unit !== null ? <span className="font-mono text-xs text-muted-foreground">{unit}</span> : null}
        </p>
        {Object.keys(rest).length > 0 ? (
          <AssumptionDisclosure assumptions={rest} label="Additional evidence content fields" />
        ) : null}
      </div>
    );
  }
  const statement = typeof content["statement"] === "string" ? content["statement"] : null;
  if (statement !== null && statement !== "") {
    const rest = Object.fromEntries(entries.filter(([key]) => key !== "statement"));
    return (
      <div className="mt-2 space-y-2">
        <p className="text-sm">{statement}</p>
        {Object.keys(rest).length > 0 ? (
          <AssumptionDisclosure assumptions={rest} label="Additional evidence content fields" />
        ) : null}
      </div>
    );
  }
  return <AssumptionDisclosure assumptions={content} label="Evidence content fields" />;
}

/** A measured metric value, formatted by kind (grouping only — never rounded). */
function formatMetricValue(value: number | string | boolean): string {
  if (typeof value === "number" && Number.isInteger(value)) return value.toLocaleString();
  return String(value);
}

function DecisionsTab({ clientId }: { clientId: string }) {
  const decisions = useDecisions(clientId);
  const navigate = useMosSession((state) => state.navigate);
  if (decisions.isPending) return <LoadingSkeleton rows={4} />;
  if (decisions.isError) {
    return <MosErrorView error={decisions.error} what="decisions" onRetry={() => void decisions.refetch()} />;
  }
  const list = decisions.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No decisions yet" hint="Decisions are recorded through the MOS decisions API." />;
  }
  return (
    <ScrollList label="Decisions" className="space-y-2">
      {list.map((decision) => (
        <button
          key={decision.decisionId}
          type="button"
          className="w-full rounded-lg border p-3 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => navigate({ kind: "decision", decisionId: decision.decisionId })}
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={decision.disposition} />
            <span className="font-mono text-xs text-muted-foreground">{shortId(decision.decisionId)}</span>
            {decision.observedOutcome ? <Badge variant="secondary">outcome recorded</Badge> : null}
          </div>
          <p className="mt-1 text-sm">{decision.objective}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            hypothesis: {decision.hypothesisSummary}
          </p>
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
            Open the decision ledger <ArrowRight className="size-3" aria-hidden="true" />
          </span>
        </button>
      ))}
    </ScrollList>
  );
}

function LearningTab({ clientId }: { clientId: string }) {
  const learnings = useLearnings(clientId);
  if (learnings.isPending) return <LoadingSkeleton rows={4} />;
  if (learnings.isError) {
    return <MosErrorView error={learnings.error} what="learnings" onRetry={() => void learnings.refetch()} />;
  }
  const list = learnings.data ?? [];
  if (list.length === 0) {
    return <EmptyState title="No learnings yet" hint="Learnings are recorded through the MOS learnings API." />;
  }
  return (
    <ScrollList label="Learnings" className="space-y-2">
      {list.map((learning) => (
        <div key={learning.learningId} className="rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={learning.status} />
            {learning.confidence !== undefined ? (
              <span className="font-mono text-xs text-muted-foreground">confidence {learning.confidence}</span>
            ) : null}
            <span className="font-mono text-xs text-muted-foreground">{shortId(learning.learningId)}</span>
          </div>
          <p className="mt-1 text-sm">{learning.statement}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            applicability {JSON.stringify(learning.applicability)}
          </p>
          {learning.evidenceRefs.length > 0 ? (
            <p className="font-mono text-xs text-muted-foreground">
              evidence {learning.evidenceRefs.map((ref) => shortId(ref)).join(", ")}
            </p>
          ) : null}
        </div>
      ))}
    </ScrollList>
  );
}

function MemoryTab({ clientId }: { clientId: string }) {
  const agencyId = useMosSession((state) => state.agencyId);
  const memory = useClientMemory(agencyId, clientId);
  if (agencyId === null) return <EmptyState title="No agency selected" />;
  if (memory.isPending) return <LoadingSkeleton rows={4} />;
  if (memory.isError) {
    return <MosErrorView error={memory.error} what="operating memory" onRetry={() => void memory.refetch()} />;
  }
  const view = memory.data;
  if (view === undefined) return null;
  return (
    <div className="space-y-4">
      <p className="font-mono text-xs text-muted-foreground">
        source: GET /api/client-memory/:agencyId/clients/:clientId · projection {view.projection.projectionVersion} ·
        generated {formatWhen(view.generatedAt)}
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>{view.profile.name}</p>
            <p className="font-mono text-xs text-muted-foreground">
              {view.profile.slug} · <StatusBadge status={view.profile.status} />
            </p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              source {view.profile.sourceRef.kind}:{shortId(view.profile.sourceRef.id)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Records by kind</CardTitle>
          </CardHeader>
          <CardContent>
            <CountChips counts={view.perKind} labelSingular="records" />
            <p className="mt-2 text-xs text-muted-foreground">
              {view.supersededEvidenceCount} superseded evidence record
              {view.supersededEvidenceCount === 1 ? "" : "s"} excluded
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Projection</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-xs text-muted-foreground">
            <p>{view.projection.basis}</p>
            {Object.keys(view.projection.selectionRules).length > 0 ? (
              <div
                role="list"
                aria-label="Projection selection rules"
                className="mos-scroll max-h-40 space-y-0.5 overflow-y-auto rounded border p-2"
              >
                {Object.entries(view.projection.selectionRules).map(([ruleKey, rule]) => (
                  <p key={ruleKey} className="font-mono text-[10px]">
                    <span className="text-muted-foreground">{ruleKey}:</span> {rule}
                  </p>
                ))}
              </div>
            ) : null}
            <p className="font-mono text-[10px]">{view.projection.persistence}</p>
            <p className="font-mono text-[10px]">{view.projection.retrievalTechnology}</p>
          </CardContent>
        </Card>
      </div>
      {view.items.length === 0 ? (
        <EmptyState title="No projected memory items" hint="Memory items project from goals, decisions, learnings and evidence." />
      ) : (
        <ScrollList label="Memory items" className="space-y-2">
          {view.items.map((item) => (
            <div key={`${item.kind}:${item.id}`} className="rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {item.kind}
                </Badge>
                {item.status === null ? (
                  <span className="font-mono text-xs text-muted-foreground">no status</span>
                ) : (
                  <StatusBadge status={item.status} />
                )}
                <span className="font-mono text-xs text-muted-foreground">{shortId(item.id)}</span>
                <span className="font-mono text-xs text-muted-foreground">{formatWhen(item.recordedAt)}</span>
              </div>
              <p className="mt-1 text-sm">{item.summary}</p>
              <SourceRefList refs={item.links} />
            </div>
          ))}
        </ScrollList>
      )}
    </div>
  );
}
