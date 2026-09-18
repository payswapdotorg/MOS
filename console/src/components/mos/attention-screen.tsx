"use client";

/**
 * Journey D — the AI Operator attention queue: category, source, severity
 * (priority score), rationale, impacted client, recommended next action.
 * Sub-filters come from the server's own category vocabulary (the counts
 * object). Consequential actions LINK to the existing approval/decision
 * surfaces — the queue is read-only by construction, so the SPA performs
 * NO direct authority mutation from here.
 */

import * as React from "react";
import { ArrowRight, Filter, Sparkles } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAttentionItem, useAttentionQueue, useClients } from "./hooks";
import { useMosSession } from "./session-store";
import {
  AssumptionDisclosure,
  CountChips,
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  SourceRefList,
  formatWhen,
  shortId,
} from "./shared";

/** Map an attention category to the surface its action contract names. */
function actionTargetFor(item: {
  actionContract: { surface: string; targetRef: { kind: string; id: string } };
  scope: { clientId: string | null };
}): { label: string; onClick?: () => void } {
  const target = item.actionContract.targetRef;
  return {
    label: `${item.actionContract.surface} · ${target.kind}:${shortId(target.id)}`,
  };
}

export function AttentionScreen() {
  const agencyId = useMosSession((state) => state.agencyId);
  const navigate = useMosSession((state) => state.navigate);
  const queue = useAttentionQueue(agencyId);
  const clients = useClients(agencyId);
  const [category, setCategory] = React.useState<string>("all");
  const [clientFilter, setClientFilter] = React.useState<string>("all");
  const [openItem, setOpenItem] = React.useState<string | null>(null);

  if (agencyId === null) {
    return <EmptyState title="No agency selected" hint="Select an agency to view its attention queue." />;
  }
  if (queue.isPending) return <LoadingSkeleton rows={6} />;
  if (queue.isError) {
    return <MosErrorView error={queue.error} what="the attention queue" onRetry={() => void queue.refetch()} />;
  }

  const view = queue.data;
  const categories = Object.keys(view.counts);
  const clientNames = new Map((clients.data ?? []).map((client) => [client.clientId, client.name]));
  const items = view.items.filter((item) => {
    if (category !== "all" && item.category !== category) return false;
    if (clientFilter !== "all" && item.scope.clientId !== clientFilter) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Sparkles className="size-5" aria-hidden="true" /> Attention
        </h1>
        <p className="text-sm text-muted-foreground">
          The AI Operator&apos;s ranked queue over {view.scope.clientCount} client
          {view.scope.clientCount === 1 ? "" : "s"} · {view.items.length} item
          {view.items.length === 1 ? "" : "s"} · source:{" "}
          <span className="font-mono text-xs">GET /api/ai-operator/:agencyId/attention-queue</span> · generated{" "}
          {formatWhen(view.generatedAt)}
        </p>
      </header>

      {/* Ranking disclosure — the queue's honesty block */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Ranking disclosure</CardTitle>
          <CardDescription>
            Every score, category and assumption the operator consumed — no hidden constants.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid gap-2 font-mono text-xs text-muted-foreground sm:grid-cols-2">
            <p>rankVersion: {view.ranking.rankVersion}</p>
            <p>categoryVocabularyVersion: {view.ranking.categoryVocabularyVersion}</p>
            <p>sortRule: {view.ranking.sortRule}</p>
            <p>persistence: {view.ranking.persistence}</p>
            <p>basis: {view.ranking.basis}</p>
            <p>
              consumedProfitIntelligenceVersion:{" "}
              {view.ranking.consumedProfitIntelligenceVersion ?? "—"}
            </p>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Operator policy — every constant the ranker consumed
            </p>
            <AssumptionDisclosure
              assumptions={view.ranking.assumptions ?? {}}
              label="Operator policy assumptions"
            />
          </div>
          <CountChips counts={view.counts} labelSingular="items" />
        </CardContent>
      </Card>

      {/* Sub-filters */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Attention filters">
        <Filter className="size-4 text-muted-foreground" aria-hidden="true" />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="h-10 w-48" aria-label="Filter by category">
            <SelectValue placeholder="Category" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {entry} ({view.counts[entry]})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={clientFilter} onValueChange={setClientFilter}>
          <SelectTrigger className="h-10 w-56" aria-label="Filter by impacted client">
            <SelectValue placeholder="Client" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All clients</SelectItem>
            {(clients.data ?? []).map((client) => (
              <SelectItem key={client.clientId} value={client.clientId}>
                {client.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Badge variant="secondary" className="font-mono">
          {items.length} shown
        </Badge>
      </div>

      {view.items.length === 0 ? (
        <EmptyState
          title="The attention queue is empty"
          hint="No attention items were derived for this agency — nothing is blocked, awaiting approval, risky, anomalous, leaking scope, margin-pressured or opportunistic right now."
        />
      ) : items.length === 0 ? (
        <EmptyState title="No items match the filters" hint="Adjust the category or client filter." />
      ) : (
        <ScrollList label="Attention items" className="space-y-3">
          {items.map((item) => {
            const target = actionTargetFor(item);
            return (
              <Card key={item.itemId}>
                <CardHeader className="cursor-pointer pb-2" onClick={() => setOpenItem(item.itemId)}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="font-mono text-xs">
                      rank #{item.rank}
                    </Badge>
                    <Badge className="font-mono text-xs">{item.category}</Badge>
                    <span className="font-mono text-xs text-muted-foreground">
                      score {item.priorityScore}
                    </span>
                    {item.scope.clientId ? (
                      <Button
                        variant="link"
                        className="h-6 p-0 text-xs"
                        onClick={(event) => {
                          event.stopPropagation();
                          navigate({ kind: "client", clientId: item.scope.clientId as string, tab: "overview" });
                        }}
                      >
                        {clientNames.get(item.scope.clientId) ?? shortId(item.scope.clientId)}
                        <ArrowRight className="size-3" aria-hidden="true" />
                      </Button>
                    ) : (
                      <span className="font-mono text-xs text-muted-foreground">agency-wide</span>
                    )}
                  </div>
                  <CardTitle className="text-base">{item.rationale.headline}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex flex-wrap gap-1.5">
                    {item.rationale.factors.map((factor) => (
                      <Badge key={factor.key} variant="secondary" className="font-mono text-[10px]">
                        {factor.key}: {factor.value}
                      </Badge>
                    ))}
                  </div>
                  <p className="text-sm">
                    <span className="font-medium">Recommended next action: </span>
                    {item.actionContract.note}
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    action contract: {target.label} · policy {item.actionContract.policyDimension} @{" "}
                    {item.actionContract.policyScopeKind}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">sources:</span>
                    <SourceRefList refs={item.sourceRefs} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">score assumptions:</span>
                    {item.scoreAssumptionKeys.map((key) => (
                      <Badge key={key} variant="outline" className="font-mono text-[10px]">
                        {key}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={() => setOpenItem(item.itemId)}>
                      Item detail
                    </Button>
                    {item.scope.clientId ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="gap-1"
                        onClick={() =>
                          navigate({
                            kind: "client",
                            clientId: item.scope.clientId as string,
                            tab: "decisions",
                          })
                        }
                      >
                        Go to approval/decision surface <ArrowRight className="size-3" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </ScrollList>
      )}

      <AttentionItemDialog
        agencyId={agencyId}
        itemId={openItem}
        onOpenChange={(open) => {
          if (!open) setOpenItem(null);
        }}
      />
    </div>
  );
}

function AttentionItemDialog({
  agencyId,
  itemId,
  onOpenChange,
}: {
  agencyId: string;
  itemId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const detail = useAttentionItem(agencyId, itemId);
  return (
    <Dialog open={itemId !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm">Attention item</DialogTitle>
          <DialogDescription>
            source:{" "}
            <span className="font-mono text-xs">
              GET /api/ai-operator/:agencyId/attention-queue/:itemId
            </span>
          </DialogDescription>
        </DialogHeader>
        {detail.isPending ? (
          <LoadingSkeleton rows={3} />
        ) : detail.isError ? (
          <MosErrorView error={detail.error} what="the attention item" />
        ) : detail.data ? (
          <div className="space-y-3 text-sm">
            <p className="break-all font-mono text-xs">{detail.data.item.itemId}</p>
            <pre className="mos-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs">
              {JSON.stringify(detail.data.item, null, 2)}
            </pre>
            <p className="text-xs text-muted-foreground">
              {detail.data.totalItemCount} item{detail.data.totalItemCount === 1 ? "" : "s"} in the queue ·
              generated {formatWhen(detail.data.generatedAt)}
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
