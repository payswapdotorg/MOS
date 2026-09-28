"use client";

// UX-006 — the RESEARCH family of the Content/Rights surface: the agency's
// research sessions (MKT-062 Web Research) as operational cards — the
// declared topic/focus/sources, the deterministic research pass with its
// honest per-source outcomes, the retained source facts with FULL
// provenance (source ref, fetched-at, extractor, content hash) and the
// insight claims (evidence-linked, verification-state-carrying). Composed
// ONLY from the /research-sessions surface:
//
//   GET  /api/agencies/:agencyId/research-sessions        the sessions
//   GET  /api/research-sessions/:researchSessionId        the composed read-back (declaration + versions + facts + insights + runs)
//   POST /api/agencies/:agencyId/research-sessions        create (owner|admin)
//   POST /api/research-sessions/:researchSessionId/runs   run the deterministic research pass (owner|admin)
//
// plus the /evidence authority's append route (POST /api/clients/:clientId
// /evidence) as the research→content bridge: a retained source fact
// becomes a citable client OBSERVATION through the evidence authority's
// own creation path — the fact's own fields carried verbatim (class
// 'source_fact', the research source reference, the fetched-at time, the
// fact's content). The evidence authority stays the sole evidence
// authority; this surface records nothing of its own.

import * as React from "react";
import { Microscope, Play } from "lucide-react";
import { useClient, useResearchSessionDetail, useResearchSessions } from "@/components/mos/hooks";
import { useAppendClientEvidence } from "@/components/mos/hooks";
import { useCreateResearchSession } from "@/components/mos/hooks";
import { useRunResearchPass } from "@/components/mos/hooks";
import type { ResearchSessionView, ResearchSourceFactView } from "@/lib/mos-api";
import {
  Chip,
  ConfirmGate,
  ContentRecordCard,
  LabeledRows,
  ResearchOutcomeChip,
  SectionSkeleton,
  SelectField,
  SourceLine,
  TextField,
  formatWhen,
} from "./content-atoms";
import {
  SectionErrorView as SectionErrorViewInline,
  WorkspaceActionButton,
  WorkspaceEmptyState,
} from "@/components/mos/mission/workspace-atoms";

// The frozen source-kind vocabulary (RESEARCH_SOURCE_KINDS, research-v1 —
// mirrored for the declare form; the route rejects anything else with its
// own 422 words).
const SOURCE_KINDS = [
  "web_page",
  "documentation",
  "research_paper",
  "news",
  "market_source",
  "public_social_content",
] as const;

type DraftSource = { kind: string; reference: string; authorization: string };

export function ResearchSection({ clientId }: { clientId: string }) {
  const client = useClient(clientId);
  const agencyId = client.data?.agencyId ?? null;
  const sessions = useResearchSessions(agencyId);
  const createSession = useCreateResearchSession(agencyId ?? "");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [topic, setTopic] = React.useState("");
  const [focus, setFocus] = React.useState("");
  const [sources, setSources] = React.useState<DraftSource[]>([
    { kind: "web_page", reference: "", authorization: "public" },
  ]);

  const [runTarget, setRunTarget] = React.useState<ResearchSessionView | null>(null);
  const runPass = useRunResearchPass(runTarget?.researchSessionId ?? "");

  const list = sessions.data ?? [];

  const submitCreate = () => {
    const validSources = sources
      .map((source) => ({
        kind: source.kind,
        reference: source.reference.trim(),
        authorization: source.authorization,
      }))
      .filter((source) => source.reference !== "");
    void createSession
      .mutateAsync({
        ...(topic.trim() === "" ? {} : { topic: topic.trim() }),
        ...(focus.trim() === "" ? {} : { focus: focus.trim() }),
        sources: validSources,
      })
      .catch(() => {
        /* the toast carries the server's own words */
      });
  };

  return (
    <section aria-labelledby="content-research-heading" className="space-y-3">
      <div>
        <h3 id="content-research-heading" className="flex items-center gap-2 font-medium text-stone-800">
          <Microscope className="size-4 text-stone-400" aria-hidden="true" />
          Research
        </h3>
        <p className="mt-0.5 text-sm leading-relaxed text-stone-600">
          The research sessions this client&apos;s agency ran — each one declares its sources up
          front and records the honest pass over them: what was fetched, what was extracted, and
          what failed. A retained fact can be promoted into the client&apos;s evidence ledger,
          where content candidates cite it.
        </p>
      </div>

      {client.isPending ? (
        <SectionSkeleton rows={2} />
      ) : client.isError ? (
        <SectionErrorViewInline
          error={client.error}
          what="the client record (the owning agency of the research sessions)"
          onRetry={() => void client.refetch()}
        />
      ) : sessions.isPending ? (
        <SectionSkeleton rows={3} />
      ) : sessions.isError ? (
        <SectionErrorViewInline
          error={sessions.error}
          what="the research sessions"
          onRetry={() => void sessions.refetch()}
        />
      ) : (
        <>
          {list.length === 0 ? (
            <WorkspaceEmptyState
              missing="No research sessions exist for this client's agency yet."
              why="Research is where content work starts: a session declares the public web sources for a niche and runs the deterministic pass that retains the observed facts — titles, excerpts, structure — with full provenance."
              next="Start the first session below: declare a topic and one or more public web sources, then run the research pass over them."
              action={
                <WorkspaceActionButton
                  onClick={() => setCreateOpen(true)}
                  ariaLabel="Start a research session"
                >
                  Start a research session
                </WorkspaceActionButton>
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((session) => (
                <ResearchSessionCard
                  key={session.researchSessionId}
                  session={session}
                  clientId={clientId}
                  onRun={() => setRunTarget(session)}
                  runPending={
                    runTarget?.researchSessionId === session.researchSessionId && runPass.isPending
                  }
                />
              ))}
            </ul>
          )}

          {list.length > 0 ? (
            <div>
              <WorkspaceActionButton
                tone="plain"
                onClick={() => setCreateOpen(true)}
                ariaLabel="Start another research session"
              >
                Start another research session
              </WorkspaceActionButton>
            </div>
          ) : null}
        </>
      )}

      <CreateSessionGate
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setTopic("");
            setFocus("");
            setSources([{ kind: "web_page", reference: "", authorization: "public" }]);
          }
        }}
        busy={createSession.isPending}
        topic={topic}
        onTopicChange={setTopic}
        focus={focus}
        onFocusChange={setFocus}
        sources={sources}
        onSourcesChange={setSources}
        onConfirm={submitCreate}
      />

      <ConfirmGate
        open={runTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRunTarget(null);
        }}
        title={`Run the research pass${runTarget ? "" : ""}`}
        consequence="This runs the platform's real deterministic research pass over the session's CURRENT declared sources: every source is fetched read-only through the page reader, every outcome — extracted facts, empty pages, HTTP errors, transport refusals — is recorded honestly on the run. Nothing is invented and nothing is retried silently."
        confirmLabel="Run the pass"
        confirmTone="default"
        busy={runPass.isPending}
        onConfirm={() => {
          if (runTarget !== null) {
            void runPass
              .mutateAsync()
              .catch(() => {
                /* the toast carries the server's own words */
              })
              .finally(() => setRunTarget(null));
          }
        }}
      />

      <SourceLine
        sources={[
          agencyId === null
            ? "GET /api/agencies/:agencyId/research-sessions (the agency resolves from the client record)"
            : `GET /api/agencies/${agencyId.slice(0, 8)}…/research-sessions`,
          "GET /api/research-sessions/:researchSessionId (the composed read-back, on expand)",
          "POST …/research-sessions (create) · POST …/research-sessions/:id/runs (the research pass)",
          "POST /api/clients/:clientId/evidence (a retained fact becomes a citable observation — the research→content bridge)",
        ]}
      />
    </section>
  );
}

// --- The create-session dialog ---------------------------------------------------------

function CreateSessionGate({
  open,
  onOpenChange,
  busy,
  topic,
  onTopicChange,
  focus,
  onFocusChange,
  sources,
  onSourcesChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  topic: string;
  onTopicChange: (value: string) => void;
  focus: string;
  onFocusChange: (value: string) => void;
  sources: DraftSource[];
  onSourcesChange: (sources: DraftSource[]) => void;
  onConfirm: () => void;
}) {
  const anyReference = sources.some((source) => source.reference.trim() !== "");
  return (
    <ConfirmGate
      open={open}
      onOpenChange={onOpenChange}
      title="Start a research session"
      consequence="This records the session (version 1 of its declaration): the topic, the focus and the sources are declared up front — the declared sources are immutable per version, and a correction is a new version record. The research pass itself runs separately, on demand."
      confirmLabel="Record the session"
      confirmTone="default"
      busy={busy}
      onConfirm={onConfirm}
    >
      <div className="mt-1 space-y-3">
        <TextField
          id="research-topic"
          label="Topic"
          value={topic}
          onChange={onTopicChange}
          placeholder="e.g. Widget niche trends"
          hint="Optional, ≤500 characters — the declared topic of the research."
        />
        <TextField
          id="research-focus"
          label="Focus"
          value={focus}
          onChange={onFocusChange}
          placeholder="e.g. Q1 short-form widget content"
          hint="Optional, ≤2000 characters."
        />
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Declared sources (at least one)
          </p>
          {sources.map((source, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-lg border border-stone-200 bg-white p-3 sm:flex-row sm:items-end"
            >
              <div className="sm:w-44">
                <SelectField
                  id={`research-source-kind-${index}`}
                  label="Kind"
                  value={source.kind}
                  onChange={(kind) =>
                    onSourcesChange(
                      sources.map((entry, i) => (i === index ? { ...entry, kind } : entry)),
                    )
                  }
                  options={SOURCE_KINDS.map((kind) => ({
                    value: kind,
                    label: kind.replace(/_/g, " "),
                  }))}
                />
              </div>
              <div className="min-w-0 flex-1">
                <TextField
                  id={`research-source-reference-${index}`}
                  label="Reference (URL)"
                  value={source.reference}
                  onChange={(reference) =>
                    onSourcesChange(
                      sources.map((entry, i) => (i === index ? { ...entry, reference } : entry)),
                    )
                  }
                  placeholder="https://example.test/report"
                  hint="The public web address the pass will fetch read-only."
                  invalid={open && index === 0 && source.reference.trim() === "" && !anyReference}
                />
              </div>
              <div className="sm:w-36">
                <SelectField
                  id={`research-source-authorization-${index}`}
                  label="Authorization"
                  value={source.authorization}
                  onChange={(authorization) =>
                    onSourcesChange(
                      sources.map((entry, i) =>
                        i === index ? { ...entry, authorization } : entry,
                      ),
                    )
                  }
                  options={[
                    { value: "public", label: "public" },
                    { value: "authorized", label: "authorized" },
                  ]}
                  hint="Public web kinds take 'public'."
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              onSourcesChange([
                ...sources,
                { kind: "web_page", reference: "", authorization: "public" },
              ])
            }
            className="inline-flex min-h-[44px] items-center rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700"
          >
            Add another source
          </button>
        </div>
      </div>
    </ConfirmGate>
  );
}

// --- One research session card ---------------------------------------------------------

function ResearchSessionCard({
  session,
  clientId,
  onRun,
  runPending,
}: {
  session: ResearchSessionView;
  clientId: string;
  onRun: () => void;
  runPending: boolean;
}) {
  return (
    <ContentRecordCard
      id={`research-${session.researchSessionId}`}
      detailLabel="Declaration, retained facts, insights and runs"
      detail={(open) =>
        open ? (
          <ResearchSessionDetailBody
            researchSessionId={session.researchSessionId}
            clientId={clientId}
          />
        ) : null
      }
    >
      <ResearchSessionSummary session={session} onRun={onRun} runPending={runPending} />
    </ContentRecordCard>
  );
}

function ResearchSessionSummary({
  session,
  onRun,
  runPending,
}: {
  session: ResearchSessionView;
  onRun: () => void;
  runPending: boolean;
}) {
  // The topic line needs the current declaration — the card mounts the
  // composed detail read lazily ONLY when expanded, so the first screen
  // shows what the session record itself carries (version, timestamps).
  return (
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-medium text-stone-800">
          Research session{" "}
          <span className="font-mono text-sm text-stone-500">
            {session.researchSessionId.slice(0, 8)}…
          </span>
        </p>
        <p className="mt-0.5 text-sm text-stone-500">
          declaration version {session.currentVersionSeq} · created{" "}
          {formatWhen(session.createdAt)} · updated {formatWhen(session.updatedAt)}
        </p>
        <p className="mt-1 text-xs leading-relaxed text-stone-400">
          The declared sources and retained facts render on expand — the topic and focus ride the
          declaration read-back.
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <WorkspaceActionButton tone="teal" onClick={onRun} disabled={runPending} ariaLabel="Run the research pass">
          <span className="inline-flex items-center gap-1.5">
            <Play className="size-4" aria-hidden="true" />
            {runPending ? "Running…" : "Run the research pass"}
          </span>
        </WorkspaceActionButton>
      </div>
    </div>
  );
}

// --- The expanded session detail (expand→fetch) ------------------------------------------

function ResearchSessionDetailBody({
  researchSessionId,
  clientId,
}: {
  researchSessionId: string;
  clientId: string;
}) {
  const detail = useResearchSessionDetail(researchSessionId);
  const appendEvidence = useAppendClientEvidence(clientId);
  const [promoteTarget, setPromoteTarget] = React.useState<ResearchSourceFactView | null>(null);

  if (detail.isPending) return <SectionSkeleton rows={4} />;
  if (detail.isError) {
    return (
      <SectionErrorViewInline
        error={detail.error}
        what="the research session read-back"
        onRetry={() => void detail.refetch()}
      />
    );
  }
  const view = detail.data;
  if (view === undefined) return null;

  const current = view.currentVersion;
  const factsBySource = new Map<string, number>();
  for (const fact of view.sourceFacts) {
    factsBySource.set(fact.sourceId, (factsBySource.get(fact.sourceId) ?? 0) + 1);
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Current declaration (version {current.versionSeq} of {view.versions.length})
        </p>
        <p className="mt-1 text-sm font-medium text-stone-800">
          {current.topic ?? "No topic declared"}
        </p>
        {current.focus ? (
          <p className="mt-0.5 text-sm leading-relaxed text-stone-600">{current.focus}</p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-1.5">
          {current.sources.map((source) => (
            <li
              key={source.sourceId}
              className="rounded-lg border border-stone-200 bg-white px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Chip label={source.kind.replace(/_/g, " ")} className="border-stone-300 bg-stone-100 text-stone-700" />
                <Chip
                  label={source.authorization}
                  className={
                    source.authorization === "public"
                      ? "border-stone-200 bg-stone-50 text-stone-600"
                      : "border-teal-800/20 bg-teal-50 text-teal-900"
                  }
                />
                <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                  {factsBySource.get(source.sourceId) ?? 0} fact(s) retained
                </span>
              </div>
              <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-stone-500">
                {source.reference}
              </p>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Retained source facts ({view.sourceFacts.length}) — extracted observations, with FULL provenance
        </p>
        {view.sourceFacts.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No facts retained yet — run the research pass to fetch and extract over the declared
            sources.
          </p>
        ) : (
          <ul className="mos-scroll mt-1 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
            {view.sourceFacts.map((fact) => (
              <li
                key={fact.sourceFactId}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Chip
                    label={fact.factKind.replace(/_/g, " ")}
                    className="border-teal-800/20 bg-teal-50 text-teal-900"
                  />
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-stone-400">
                    fetched {formatWhen(fact.fetchedAt)}
                  </span>
                </div>
                <p className="mt-1 break-all font-mono text-[11px] text-stone-500">
                  {fact.sourceRef}
                </p>
                <LabeledRows record={fact.content} />
                <p className="mt-1 font-mono text-[11px] text-stone-400">
                  extractor {fact.extractor} · hash {fact.contentHash.slice(0, 12)}…
                  {fact.extractionNotes !== null ? ` · ${fact.extractionNotes}` : ""}
                </p>
                <div className="mt-2">
                  <WorkspaceActionButton
                    tone="plain"
                    onClick={() => setPromoteTarget(fact)}
                    disabled={appendEvidence.isPending}
                    ariaLabel={`Record fact ${fact.sourceFactId.slice(0, 8)} as client evidence`}
                  >
                    Record as client evidence
                  </WorkspaceActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[11px] leading-relaxed text-stone-400">
          &ldquo;Record as client evidence&rdquo; appends an immutable /evidence record of class
          source_fact carrying this fact&apos;s own fields (the source reference, the fetched-at
          time, the extracted content) — the evidence authority&apos;s creation route, never a
          shadow copy.
        </p>
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Research insight claims ({view.insights.length}) — every insight a CLAIM, never a conclusion
        </p>
        {view.insights.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No insight claims recorded on this session yet.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {view.insights.map((insight) => (
              <li
                key={insight.researchInsightId}
                className="rounded-lg border border-amber-700/20 bg-amber-50/40 px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Chip
                    label={insight.derivationKind.replace(/_/g, " ")}
                    className="border-amber-700/25 bg-white text-amber-900"
                  />
                  <Chip
                    label={insight.verificationState.replace(/_/g, " ")}
                    className={
                      insight.verificationState === "evidence_backed"
                        ? "border-teal-800/20 bg-teal-50 text-teal-900"
                        : "border-stone-300 bg-stone-100 text-stone-600"
                    }
                  />
                  {insight.supersededByResearchInsightId ? (
                    <span className="text-[11px] text-stone-400">superseded · history</span>
                  ) : null}
                </div>
                {typeof insight.statement["summary"] === "string" ? (
                  <p className="mt-1 text-sm leading-relaxed text-stone-700">
                    {insight.statement["summary"]}
                  </p>
                ) : (
                  <div className="mt-1">
                    <LabeledRows record={insight.statement} />
                  </div>
                )}
                <p className="mt-1 font-mono text-[11px] text-stone-400">
                  evidence facts: {insight.evidenceSourceFactIds.length} cited
                  {insight.aiAssistance !== null ? " · AI assistance disclosed" : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Research runs ({view.runs.length}) — the honest per-source outcomes
        </p>
        {view.runs.length === 0 ? (
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            No runs recorded yet — the research pass runs on demand from the card header.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-2">
            {view.runs.map((run) => (
              <li
                key={run.researchRunId}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <ResearchOutcomeChip outcome={run.status} />
                  <span className="text-xs text-stone-500">
                    {run.sourcesInspected} source(s) inspected · {run.factsRetained} fact(s)
                    retained
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-stone-400">
                    {formatWhen(run.finishedAt)}
                  </span>
                </div>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {run.sourceOutcomes.map((outcome) => (
                    <li
                      key={outcome.researchRunSourceOutcomeId}
                      className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-stone-600"
                    >
                      <ResearchOutcomeChip outcome={outcome.outcome} />
                      <span className="text-stone-500">
                        {outcome.factsExtracted} fact(s)
                        {outcome.detail !== null ? ` · ${outcome.detail}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-stone-400">
        claim tier {view.derivedRecordTier} · vocabulary {view.vocabularyVersion}
      </p>

      <ConfirmGate
        open={promoteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setPromoteTarget(null);
        }}
        title="Record as client evidence"
        consequence="'Record as client evidence' appends an immutable /evidence record of class source_fact carrying this fact's own fields (the source reference, the fetched-at time, the extracted content) — the evidence authority's creation route, never a shadow copy."
        confirmLabel="Record the evidence"
        confirmTone="default"
        busy={appendEvidence.isPending}
        onConfirm={() => {
          if (promoteTarget !== null) {
            void appendEvidence
              .mutateAsync({
                class: "source_fact",
                sourceSystem: "research",
                sourceRef: promoteTarget.sourceRef,
                observedAt: promoteTarget.fetchedAt,
                content: {
                  researchSessionId: promoteTarget.researchSessionId,
                  sourceFactId: promoteTarget.sourceFactId,
                  factKind: promoteTarget.factKind,
                  extractor: promoteTarget.extractor,
                  ...promoteTarget.content,
                },
                quality: "C",
              })
              .catch(() => {
                /* the toast carries the server's own words */
              })
              .finally(() => setPromoteTarget(null));
          }
        }}
      />
    </div>
  );
}
