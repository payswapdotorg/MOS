"use client";

/**
 * Journey C — the Decision Ledger chain:
 * Objective → Evidence → Context → Hypothesis → Expected impact →
 * Expected cost → Recommendation → Decision → Execution → Outcome →
 * Learning. Every link renders the decision record's own fields —
 * "not recorded" when the server has no value. Dispositions go through the
 * real POST /api/decisions/:decisionId/disposition route.
 */

import * as React from "react";
import { ArrowRight, CheckCircle2, Link2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useDecision, useDecisionDisposition, useDecisionEvents } from "./hooks";
import { useMosSession } from "./session-store";
import {
  EmptyState,
  LoadingSkeleton,
  MosErrorView,
  ScrollList,
  StatusBadge,
  formatWhen,
  shortId,
} from "./shared";

function ChainStep({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="relative space-y-1 pl-8">
      <span
        aria-hidden="true"
        className="absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full border bg-background font-mono text-xs"
      >
        {index}
      </span>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="text-sm">{children}</div>
    </li>
  );
}

export function DecisionDetailScreen({ decisionId }: { decisionId: string }) {
  const navigate = useMosSession((state) => state.navigate);
  const decision = useDecision(decisionId);
  const events = useDecisionEvents(decisionId);
  const disposition = useDecisionDisposition(decisionId);
  const [reason, setReason] = React.useState("");

  if (decision.isPending) return <LoadingSkeleton rows={6} />;
  if (decision.isError) {
    return <MosErrorView error={decision.error} what="the decision" onRetry={() => void decision.refetch()} />;
  }
  const record = decision.data;

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1 px-0"
          onClick={() => navigate({ kind: "client", clientId: record.clientId, tab: "decisions" })}
        >
          ← Client decisions
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Decision</h1>
          <StatusBadge status={record.disposition} />
          <span className="font-mono text-xs text-muted-foreground">{record.decisionId}</span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          source: GET /api/decisions/:decisionId · client {shortId(record.clientId)} · agency{" "}
          {shortId(record.agencyId)}
        </p>
      </header>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Decision chain</CardTitle>
          <CardDescription>
            The Decision Ledger view — every link is the record&apos;s own field, honestly rendered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-5">
            <ChainStep index={1} title="Objective">
              <p>{record.objective}</p>
            </ChainStep>

            <ChainStep index={2} title="Evidence">
              {record.evidenceRefs.length === 0 ? (
                <p className="text-muted-foreground">No evidence references recorded.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {record.evidenceRefs.map((ref) => (
                    <Badge key={ref} variant="outline" className="font-mono text-xs">
                      <Link2 className="mr-1 size-3" aria-hidden="true" />
                      {shortId(ref)}
                    </Badge>
                  ))}
                </div>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="mt-1 h-8 gap-1 px-0"
                onClick={() =>
                  navigate({ kind: "client", clientId: record.clientId, tab: "evidence" })
                }
              >
                View client evidence <ArrowRight className="size-3" aria-hidden="true" />
              </Button>
            </ChainStep>

            <ChainStep index={3} title="Context">
              <p>{record.context ?? <span className="text-muted-foreground">Not recorded.</span>}</p>
            </ChainStep>

            <ChainStep index={4} title="Hypothesis">
              <p>{record.hypothesisSummary}</p>
              {record.experimentRef ? (
                <p className="font-mono text-xs text-muted-foreground">
                  experiment {shortId(record.experimentRef)}
                </p>
              ) : null}
            </ChainStep>

            <ChainStep index={5} title="Expected impact">
              <p>{record.expectedImpact.summary}</p>
              <p className="font-mono text-xs text-muted-foreground">
                {[record.expectedImpact.direction, record.expectedImpact.magnitude]
                  .filter((part) => part !== undefined && part !== "")
                  .join(" · ") || "no direction/magnitude recorded"}
              </p>
              {record.uncertainty ? (
                <pre className="mos-scroll mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
                  {JSON.stringify(record.uncertainty, null, 2)}
                </pre>
              ) : null}
            </ChainStep>

            <ChainStep index={6} title="Expected cost">
              <p>{record.expectedCost ?? <span className="text-muted-foreground">Not recorded.</span>}</p>
            </ChainStep>

            <ChainStep index={7} title="Recommendation (proposal)">
              <p className="font-mono text-xs text-muted-foreground">
                proposer: {record.proposer.actor} ({record.proposer.role})
              </p>
              {record.alternatives.length === 0 ? (
                <p className="text-muted-foreground">No alternatives recorded.</p>
              ) : (
                <ul className="list-disc pl-4">
                  {record.alternatives.map((alternative, index) => (
                    <li key={index}>{alternative}</li>
                  ))}
                </ul>
              )}
              {record.predecessorDecisionId ? (
                <Button
                  variant="link"
                  className="h-7 gap-1 px-0"
                  onClick={() => navigate({ kind: "decision", decisionId: record.predecessorDecisionId as string })}
                >
                  ← predecessor decision {shortId(record.predecessorDecisionId)}
                </Button>
              ) : null}
            </ChainStep>

            <ChainStep index={8} title="Decision">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={record.disposition} />
                {record.dispositionAt ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatWhen(record.dispositionAt)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">not yet dispositioned</span>
                )}
                {record.successorDecisionId ? (
                  <Button
                    variant="link"
                    className="h-7 gap-1 px-0"
                    onClick={() => navigate({ kind: "decision", decisionId: record.successorDecisionId as string })}
                  >
                    successor {shortId(record.successorDecisionId)} <ArrowRight className="size-3" aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              {record.disposition === "proposed" ? (
                <div className="mt-2 space-y-2 rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">
                    Record a disposition through{" "}
                    <span className="font-mono text-[10px]">POST /api/decisions/:decisionId/disposition</span>{" "}
                    (agency owner/admin — the server enforces it).
                  </p>
                  <div className="space-y-1.5">
                    <Label htmlFor="mos-disposition-reason">Reason (optional)</Label>
                    <Textarea
                      id="mos-disposition-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      rows={2}
                      maxLength={2000}
                      placeholder="Why this disposition?"
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="gap-1"
                      disabled={disposition.isPending}
                      onClick={() => disposition.mutate({ command: "accept", reason })}
                    >
                      <CheckCircle2 className="size-4" aria-hidden="true" /> Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1"
                      disabled={disposition.isPending}
                      onClick={() => disposition.mutate({ command: "reject", reason })}
                    >
                      <XCircle className="size-4" aria-hidden="true" /> Reject
                    </Button>
                  </div>
                </div>
              ) : null}
            </ChainStep>

            <ChainStep index={9} title="Execution">
              <div className="space-y-1">
                <p className="font-mono text-xs">
                  executionRef: {record.executionRef ? shortId(record.executionRef) : "—"}
                </p>
                <p className="font-mono text-xs">
                  deploymentRef: {record.deploymentRef ? shortId(record.deploymentRef) : "—"}
                </p>
                {record.deploymentRef ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 px-0"
                    onClick={() => navigate({ kind: "client", clientId: record.clientId, tab: "deployments" })}
                  >
                    View client deployments <ArrowRight className="size-3" aria-hidden="true" />
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">No execution recorded yet.</p>
                )}
              </div>
            </ChainStep>

            <ChainStep index={10} title="Outcome">
              {record.observedOutcome ? (
                <div className="space-y-1">
                  <p>{record.observedOutcome.summary}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    asExpected:{" "}
                    {record.observedOutcome.asExpected === undefined
                      ? "—"
                      : String(record.observedOutcome.asExpected)}
                  </p>
                  {record.observedOutcome.notes ? (
                    <p className="text-xs text-muted-foreground">{record.observedOutcome.notes}</p>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted-foreground">No observed outcome recorded yet.</p>
              )}
            </ChainStep>

            <ChainStep index={11} title="Learning">
              {record.learningRef ? (
                <div className="space-y-1">
                  <p className="font-mono text-xs">{shortId(record.learningRef)}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 px-0"
                    onClick={() => navigate({ kind: "client", clientId: record.clientId, tab: "learning" })}
                  >
                    View client learnings <ArrowRight className="size-3" aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <p className="text-muted-foreground">No learning linked yet.</p>
              )}
            </ChainStep>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Event ledger</CardTitle>
          <CardDescription>
            source: <span className="font-mono text-xs">GET /api/decisions/:decisionId/events</span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {events.isPending ? (
            <LoadingSkeleton rows={2} />
          ) : events.isError ? (
            <MosErrorView error={events.error} what="decision events" />
          ) : (events.data ?? []).length === 0 ? (
            <EmptyState title="No events recorded" />
          ) : (
            <ScrollList label="Decision events" className="space-y-1.5">
              {(events.data ?? []).map((event) => (
                <div key={event.eventId} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                  <Badge variant="outline" className="font-mono text-xs">
                    {event.eventType}
                  </Badge>
                  <span className="text-xs">{event.actor}</span>
                  <span className="font-mono text-xs text-muted-foreground">{formatWhen(event.recordedAt)}</span>
                  {event.reason ? (
                    <span className="w-full text-xs text-muted-foreground">reason: {event.reason}</span>
                  ) : null}
                </div>
              ))}
            </ScrollList>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
