"use client";

// UX-004 — the TEN LINKS of the Scientific Trace, composed from real surfaces
// ONLY (verified contracts, exact paths):
//
//   1  Question      — NO research-questions surface yet (MKT-062 in flight,
//                      backend only): the truthful coming state + what is
//                      observable now — the mission objective through the
//                      mission workspace (agency missions list + per-mission
//                      detail on expand). NEVER an invented questions store.
//   2  Research      — same truthful coming state; dependency disclosed plainly.
//   3  Evidence      — GET /api/clients/:clientId/evidence (OBSERVED FACTS;
//                      the supersede chain renders as lineage — a superseded
//                      record is visibly historical, never deleted-looking).
//   4  Hypothesis    — the experiments' hypothesis field VERBATIM
//                      (GET /api/clients/:clientId/experiments) — always
//                      marked as a declared, unproven claim.
//   5  Experiment    — the same experiments list + per-experiment expansion
//                      (the DECLARED DESIGN vocabulary).
//   6  Publication   — the REAL MKT-065 distribution surface:
//                      GET /api/clients/:clientId/cross-platform-distribution/plans
//                      (+ plan detail on expand). A READ surface — no dispatch
//                      controls; where control lives is disclosed.
//   7  Measurement   — GET /api/clients/:clientId/metrics (OBSERVED FACTS)
//                      + the 065 plan measurement references (plan detail's
//                      measurement_reference lineage events).
//   8  Analysis      — the MKT-067 surfaces: analyses + allocations
//                      by-experiment (on expand per experiment) — ALWAYS
//                      marked DERIVED (method + version + window disclosed).
//   9  Decision      — GET /api/clients/:clientId/decisions + detail
//                      GET /api/decisions/:decisionId on expand (+ the
//                      existing decision ledger as the drill-down) — a CAUSAL
//                      INTERPRETATION with its basis disclosed.
//  10  Learning      — GET /api/clients/:clientId/learnings + relationships
//                      GET /api/learnings/:learningId/relationships on expand
//                      — interpreted conclusions, linked to their relatives.
//
// THE COMPOSITION DISCIPLINE (binding): every section composes its owning
// module's real read surface through thin useMosQuery wrappers; no second
// analytics layer, no client-side derivation of authority state; every
// section names its source (SourceLine). Empty states are the norm for young
// clients — each renders the WORKER-CONTRACT empty state (what is missing,
// why it matters, what to do next).

import * as React from "react";
import { ArrowRight, ChevronDown } from "lucide-react";
import {
  useAgencyGrowthMissions,
  useDecision,
  useDecisions,
  useDistributionPlanDetail,
  useDistributionPlans,
  useEvidence,
  useExperimentAllocations,
  useExperimentAnalyses,
  useExperimentsForClient,
  useGrowthMissionDetail,
  useLearnings,
  useLearningRelationships,
  useMetricObservations,
} from "@/components/mos/hooks";
import type {
  AllocationRecommendationView,
  DecisionRecord,
  DistributionDestinationView,
  DistributionPlanView,
  DistributionPublicationView,
  EvidenceRecord,
  ExperimentAnalysisView,
  ExperimentView,
  LearningRecord,
  MetricObservationView,
} from "@/lib/mos-api";
import { useMosSession } from "@/components/mos/session-store";
import {
  Chip,
  LabeledRows,
  SectionErrorView,
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  WorkspaceEmptyState,
  formatMetricValue,
  formatWhen,
  provenanceString,
} from "@/components/mos/mission/workspace-atoms";
import {
  ComingStateCard,
  RegisterBadge,
  RegisterFrame,
  TraceSection,
  shortRef,
} from "./trace-atoms";

// --- Shared row helpers -------------------------------------------------------------

/** The honest header treatment for one expandable list row (house pattern). */
function RowToggle({
  open,
  onToggle,
  controlsId,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  controlsId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controlsId}
      onClick={onToggle}
      className="flex min-h-[56px] w-full items-start justify-between gap-3 rounded-xl px-1 py-2 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      <span className="min-w-0 flex-1">{children}</span>
      <ChevronDown
        aria-hidden="true"
        className={`mt-1 size-4 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
      />
    </button>
  );
}

function evidenceQualityClass(quality: string): string {
  switch (quality) {
    case "A":
    case "B":
      return "border-teal-800/20 bg-teal-50 text-teal-900";
    case "C":
      return "border-stone-300 bg-stone-100 text-stone-700";
    case "D":
    case "E":
      return "border-amber-700/20 bg-amber-50 text-amber-900";
    case "F":
      return "border-red-800/20 bg-red-50 text-red-900";
    default:
      return "border-stone-200 bg-stone-50 text-stone-600";
  }
}

function statusToneClass(status: string | null | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "running":
    case "active":
    case "accepted":
    case "achieved":
    case "published":
    case "connected":
    case "completed":
      return "border-teal-800/20 bg-teal-50 text-teal-900";
    case "paused":
    case "draft":
    case "planned":
    case "proposed":
    case "dispatching":
    case "publishing":
      return "border-stone-300 bg-stone-100 text-stone-700";
    case "stopped":
    case "rejected":
    case "failed":
    case "blocked":
    case "rights_blocked":
    case "policy_blocked":
    case "capability_rejected":
      return "border-red-800/20 bg-red-50 text-red-900";
    case "invalidated":
    case "review":
    case "rights_review_required":
    case "restricted":
    case "submitted":
      return "border-amber-700/20 bg-amber-50 text-amber-900";
    default:
      return "border-stone-200 bg-stone-50 text-stone-600";
  }
}

/** A cross-link button that opens another link of the chain (real navigation
 *  inside the trace — never a fabricated link the data does not express). The
 *  label is wrapped in a span so it stays a single addressable text node
 *  alongside the arrow icon. */
function CrossLinkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-teal-800/25 bg-white px-3.5 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      <span>{children}</span>
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </button>
  );
}

// =====================================================================================
// LINK 1 — QUESTION
// =====================================================================================

/**
 * The truthful coming state: research questions will live here once the
 * research module (MKT-062 — backend, in flight by a sibling worker) exposes
 * its HTTP surfaces. What is observable NOW: the mission objective — the
 * closest live "question" — reachable through the mission workspace link
 * (the agency's missions; each row expands to its objective verbatim + goal
 * mappings, and opens the workspace).
 */
export function QuestionLink({
  clientId,
  agencyId,
  open,
  onOpenChange,
}: {
  clientId: string;
  agencyId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useAgencyGrowthMissions(agencyId);
  const list = query.data ?? [];
  const summary =
    agencyId === null
      ? "Research module in flight — no agency selected for the mission list"
      : query.isPending
        ? "Research module in flight — loading the mission list…"
        : query.isError
          ? "Research module in flight — the mission list couldn't load just now"
          : list.length === 0
            ? "Research module in flight — no missions to show a live question from"
            : `Research module in flight — ${list.length} mission${list.length === 1 ? "" : "s"} carry the live questions`;
  return (
    <TraceSection
      id="question"
      index={1}
      link="Question"
      title="What we asked"
      summary={summary}
      summaryTone="warning"
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-4">
        <ComingStateCard
          missing="Research questions are not recorded on this platform yet."
          why="Questions are where the scientific chain starts — a precise, answerable question seeds the research and the evidence collection that follow, and keeps every later conclusion anchored to something actually asked."
          coming="When the research module ships, this link will list this client's open research questions: what was asked, when, why it mattered, and which research and evidence grew from it."
          dependency="Dependency, disclosed plainly: the research module (MKT-062) is being built now — backend only, no HTTP surface on this platform yet. This trace will never invent a questions store; it will compose that module's real read surface when it exists."
        />
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Observable now — the closest live question
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
            A mission&apos;s objective is the live question its work answers. Missions connect to
            this client through the goals they map to — open one to see its objective verbatim and
            whether it reaches this client.
          </p>
          {agencyId === null ? (
            <div className="mt-3">
              <WorkspaceEmptyState
                missing="No agency is selected for this session."
                why="Missions live inside an agency — without one selected there is no mission list to compose."
                next="Select your agency (the session remembers it); this list fills in on its own — no reload needed."
              />
            </div>
          ) : query.isPending ? (
            <div className="mt-3">
              <SectionSkeleton rows={2} />
            </div>
          ) : query.isError ? (
            <div className="mt-3">
              <SectionErrorView
                error={query.error}
                what="the mission list"
                onRetry={() => void query.refetch()}
              />
            </div>
          ) : list.length === 0 ? (
            <div className="mt-3">
              <WorkspaceEmptyState
                missing="No missions exist in your agency yet."
                why="A mission is guided work toward one outcome — its objective is the closest thing this platform has to a recorded question today."
                next="Starting one takes a minute: you say what you want and what success looks like."
                action={<StartMissionButton />}
              />
            </div>
          ) : (
            <ul className="mt-3 flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
              {list.map((mission) => (
                <QuestionMissionRow
                  key={mission.missionId}
                  missionId={mission.missionId}
                  status={mission.status}
                  updatedAt={mission.updatedAt}
                  clientId={clientId}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <SourceLine
        sources={
          agencyId === null
            ? ["research questions: not built yet (MKT-062, backend in flight)"]
            : [
                `GET /api/agencies/${agencyId.slice(0, 8)}…/growth-missions (all lifecycle states)`,
                "GET /api/growth-missions/:missionId (on expand — objective verbatim + goal mappings)",
              ]
        }
      />
    </TraceSection>
  );
}

function StartMissionButton() {
  const navigate = useMosSession((state) => state.navigate);
  return (
    <WorkspaceActionButton onClick={() => navigate({ kind: "create-mission" })}>
      Start a mission
    </WorkspaceActionButton>
  );
}

/** One mission row: expand → the mission's live detail (objective verbatim +
 *  goal mappings — highlighting any mapping to THIS client); open → the
 *  mission workspace. The per-mission detail is fetched on expand only (the
 *  expand→fetch house pattern — never a bulk prefetch). */
function QuestionMissionRow({
  missionId,
  status,
  updatedAt,
  clientId,
}: {
  missionId: string;
  status: string;
  updatedAt: string;
  clientId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const detail = useGrowthMissionDetail(open ? missionId : null);
  return (
    <li className="rounded-xl border border-stone-200 bg-stone-50/50">
      <RowToggle
        open={open}
        onToggle={() => setOpen((value) => !value)}
        controlsId={`trace-question-mission-${missionId}`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Chip label={status.replace(/_/g, " ")} className={statusToneClass(status)} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-800">
            {`Mission ${shortRef(missionId)}`}
          </span>
          <span className="text-xs text-stone-400">{`updated ${formatWhen(updatedAt)}`}</span>
        </span>
      </RowToggle>
      {open ? (
        <div id={`trace-question-mission-${missionId}`} className="border-t border-stone-200 bg-white px-4 py-4">
          {detail.isPending ? (
            <SectionSkeleton rows={2} />
          ) : detail.isError ? (
            <SectionErrorView
              error={detail.error}
              what="this mission's details"
              onRetry={() => void detail.refetch()}
            />
          ) : detail.data === undefined ? null : (
            <QuestionMissionDetail missionId={missionId} detail={detail.data} clientId={clientId} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function QuestionMissionDetail({
  missionId,
  detail,
  clientId,
}: {
  missionId: string;
  detail: NonNullable<ReturnType<typeof useGrowthMissionDetail>["data"]>;
  clientId: string;
}) {
  const navigate = useMosSession((state) => state.navigate);
  const activeMappings = detail.goalMappings.filter((mapping) => mapping.removedAt === null);
  const clientMappings = activeMappings.filter((mapping) => mapping.goalClientId === clientId);
  return (
    <div className="flex flex-col gap-3">
      <blockquote className="border-l-2 border-stone-300 pl-3 text-sm leading-relaxed text-stone-800">
        &ldquo;{detail.currentVersion.objective}&rdquo;
      </blockquote>
      <p className="text-xs leading-relaxed text-stone-500">
        The mission&apos;s declared objective, verbatim — the live question its work answers.
      </p>
      {activeMappings.length === 0 ? (
        <p className="text-sm leading-relaxed text-stone-600">
          No goals are mapped to this mission yet, so it does not reach any client&apos;s working
          surfaces — including this one&apos;s.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Goal mappings</p>
          {activeMappings.map((mapping) => (
            <p key={mapping.mappingId} className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-stone-700">
              <span className="font-mono text-xs text-stone-500">goal {shortRef(mapping.goalId)}</span>
              {mapping.goalStatus ? (
                <Chip label={mapping.goalStatus} className={statusToneClass(mapping.goalStatus)} />
              ) : null}
              {mapping.goalClientId === clientId ? (
                <Chip label="this client" className="border-teal-800/20 bg-teal-50 text-teal-900" />
              ) : (
                <span className="text-xs text-stone-400">another client</span>
              )}
            </p>
          ))}
          {clientMappings.length === 0 ? (
            <p className="text-xs leading-relaxed text-stone-500">
              None of this mission&apos;s mapped goals belong to this client — it is listed because
              missions are agency-scoped, and shown honestly as not reaching this client.
            </p>
          ) : null}
        </div>
      )}
      <div>
        <WorkspaceActionButton onClick={() => navigate({ kind: "mission", missionId })}>
          Open the mission workspace
        </WorkspaceActionButton>
      </div>
    </div>
  );
}

// =====================================================================================
// LINK 2 — RESEARCH
// =====================================================================================

/** The truthful coming state: no research HTTP surface exists on main today
 *  (MKT-062 in flight, backend only). The dependency is disclosed plainly;
 *  what research WILL compose (the evidence collection of link 3) is named
 *  so the chain still reads top-to-bottom. */
export function ResearchLink({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <TraceSection
      id="research"
      index={2}
      link="Research"
      title="What we went and found out"
      summary="Research module in flight — no research records exist on this platform yet"
      summaryTone="warning"
      open={open}
      onOpenChange={onOpenChange}
    >
      <ComingStateCard
        missing="No research has been recorded for this client yet — and no research surface exists to record it."
        why="Research is the gathering step between the question and the evidence: what was looked at, where it was found, and what it seemed to say. Without it, the evidence link below has no stated provenance of search — only what systems directly observed."
        coming="When the research module ships, this link will show the research carried out for this client's questions: sources consulted, findings captured, and how each finding fed the evidence ledger."
        dependency="Dependency, disclosed plainly: the research module (MKT-062) is being built now — backend only; no HTTP surface is deployed on this platform yet. The trace will compose that surface when it lands; until then this link stays honest and empty, and the chain continues from the evidence that IS recorded (link 3)."
      />
      <SourceLine sources={["research: not built yet (MKT-062, backend in flight)"]} />
    </TraceSection>
  );
}

// =====================================================================================
// LINK 3 — EVIDENCE (OBSERVED FACTS)
// =====================================================================================

/**
 * The client's evidence ledger — OBSERVED FACTS, each with provenance +
 * quality + confidence always visible. The supersede chain renders as
 * lineage: a superseded record is visibly historical (kept in full, never
 * deleted-looking), and corrections point at what they replace.
 */
export function EvidenceLink({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useEvidence(clientId);
  const list = query.data ?? [];
  const supersededCount = list.filter((record) => record.supersededBy !== undefined).length;
  const summary = query.isPending
    ? "Loading the evidence ledger…"
    : query.isError
      ? "The evidence ledger couldn't load just now"
      : list.length === 0
        ? "No evidence recorded on this client yet"
        : `${list.length} observed record${list.length === 1 ? "" : "s"}${supersededCount > 0 ? ` · ${supersededCount} superseded (kept as history)` : ""}`;
  return (
    <TraceSection
      id="evidence"
      index={3}
      link="Evidence"
      title="What was actually observed"
      summary={summary}
      registers={["observed"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="evidence" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No evidence records exist on this client yet."
          why="Evidence is what a system actually saw — the observed ground truth every hypothesis, analysis, decision and learning in this chain builds on. Without it, the rest is opinion."
          next="Evidence is recorded through the platform's evidence surfaces as work runs (and corrected only through the explicit supersede command, which keeps history). A young client starts empty and fills in as observations land."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2.5 overflow-y-auto pr-1">
          {list.map((record) => (
            <EvidenceFactRow key={record.evidenceId} record={record} />
          ))}
        </ul>
      )}
      <SourceLine sources={[`GET /api/clients/${clientId.slice(0, 8)}…/evidence`]} />
    </TraceSection>
  );
}

function EvidenceFactRow({ record }: { record: EvidenceRecord }) {
  const historical = record.supersededBy !== undefined;
  return (
    <li className={historical ? "opacity-80" : undefined}>
      <RegisterFrame
        register="observed"
        label={historical ? "Observed fact — superseded" : "Observed fact"}
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label={record.class} className="border-stone-300 bg-white text-stone-700" />
            <span className="font-mono text-[11px] text-stone-400">
              observed {formatWhen(record.observedAt)}
            </span>
          </span>
        }
        disclosure={
          <div className="flex flex-col gap-2">
            <LabeledRows
              label="Provenance — how this was recorded"
              record={{
                source: `${record.source.system}${record.source.ref ? `:${record.source.ref}` : ""}`,
                quality: record.quality,
                ...(record.confidence !== undefined ? { confidence: record.confidence } : {}),
                recordedBy: record.provenance.actor,
                recordedVia: record.provenance.recordedVia,
                correlation: record.provenance.correlationId,
                ...(record.provenance.recordedAt ? { recordedAt: record.provenance.recordedAt } : {}),
              }}
            />
          </div>
        }
      >
        {/* The lineage line FIRST on superseded records — the chain, visible. */}
        {historical ? (
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-stone-500">
            <Chip label="historical" className="border-stone-300 bg-stone-100 text-stone-500" />
            superseded by <span className="font-mono text-[11px] text-stone-600">{shortRef(record.supersededBy)}</span> —
            kept in full as history, never deleted.
          </p>
        ) : record.supersedes ? (
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-stone-500">
            <Chip label="correction" className="border-teal-800/20 bg-teal-50 text-teal-900" />
            replaces <span className="font-mono text-[11px] text-stone-600">{shortRef(record.supersedes)}</span> —
            the explicit supersede path.
          </p>
        ) : null}
        <EvidenceFactContent content={record.content} />
        <p className="font-mono text-[11px] text-stone-400">evidence {shortRef(record.evidenceId)}</p>
      </RegisterFrame>
    </li>
  );
}

/** The evidence content, formatted by its kind — never a raw JSON dump (the
 *  client-workspace/mission-workspace house treatment). */
function EvidenceFactContent({ content }: { content: Record<string, unknown> }) {
  const metricName = typeof content["metric"] === "string" ? content["metric"] : null;
  const value = content["value"];
  if (
    metricName !== null &&
    (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
  ) {
    const unit = typeof content["unit"] === "string" ? content["unit"] : null;
    const rest = Object.fromEntries(
      Object.entries(content).filter(([key]) => key !== "metric" && key !== "value" && key !== "unit"),
    );
    return (
      <div className="flex flex-col gap-1.5">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-stone-500">{metricName}</span>
          <span className="font-mono text-base font-semibold tabular-nums text-stone-800">
            {typeof value === "number" ? formatMetricValue(value) : String(value)}
          </span>
          {unit !== null ? <span className="font-mono text-xs text-stone-500">{unit}</span> : null}
        </p>
        {Object.keys(rest).length > 0 ? <LabeledRows record={rest} /> : null}
      </div>
    );
  }
  const statement = typeof content["statement"] === "string" ? content["statement"] : null;
  if (statement !== null && statement !== "") {
    const rest = Object.fromEntries(Object.entries(content).filter(([key]) => key !== "statement"));
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm leading-relaxed text-stone-700">{statement}</p>
        {Object.keys(rest).length > 0 ? <LabeledRows record={rest} /> : null}
      </div>
    );
  }
  return <LabeledRows record={content} />;
}

// =====================================================================================
// LINK 4 — HYPOTHESIS (DECLARED, UNPROVEN)
// =====================================================================================

/**
 * The experiments' hypothesis field VERBATIM — always marked as a declared,
 * unproven claim (the DERIVED register), never as an observed fact. Each
 * hypothesis cross-links to the experiment that tests it (link 5).
 */
export function HypothesisLink({
  clientId,
  open,
  onOpenChange,
  onOpenExperiment,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cross-link into link 5: opens the Experiment section and that row. */
  onOpenExperiment: (experimentId: string) => void;
}) {
  const query = useExperimentsForClient(clientId);
  const list = query.data ?? [];
  const summary = query.isPending
    ? "Loading declared hypotheses…"
    : query.isError
      ? "The experiments list couldn't load just now"
      : list.length === 0
        ? "No hypotheses declared on this client yet"
        : `${list.length} hypothes${list.length === 1 ? "is" : "es"} declared — none proven here; proof lives further down the chain`;
  return (
    <TraceSection
      id="hypothesis"
      index={4}
      link="Hypothesis"
      title="What we claimed — before testing"
      summary={summary}
      registers={["derived"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="experiments" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No hypotheses have been declared on this client yet."
          why="A hypothesis is the claim an experiment sets out to test — declared before any data arrives, so the chain stays honest about what was believed and when. Without declared hypotheses, results cannot be fairly evaluated."
          next="Hypotheses are declared as part of an experiment through the platform's experiment surfaces; each one appears here verbatim, always marked as unproven until the analysis link settles it."
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {list.map((experiment) => (
            <li key={experiment.experimentId}>
              <RegisterFrame
                register="derived"
                label="Hypothesis — declared, unproven"
                meta={
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Chip
                      label={experiment.status.replace(/_/g, " ")}
                      className={statusToneClass(experiment.status)}
                    />
                    <span className="font-mono text-[11px] text-stone-400">
                      experiment {shortRef(experiment.experimentId)}
                    </span>
                  </span>
                }
                disclosure={
                  <LabeledRows
                    label="Declared at experiment design time"
                    record={{
                      decisionTarget: experiment.decisionTarget,
                      treatment: experiment.treatment,
                      comparison: experiment.comparison,
                      primaryMetric: experiment.primaryMetric.name,
                    }}
                  />
                }
              >
                <blockquote className="border-l-2 border-amber-700/30 pl-3 text-sm leading-relaxed text-stone-800">
                  &ldquo;{experiment.hypothesis}&rdquo;
                </blockquote>
                <p className="text-xs leading-relaxed text-stone-500">
                  A claim being tested — not an observation. Whether the data supported it is
                  settled by the analysis (link 8), never here.
                </p>
                <div>
                  <CrossLinkButton onClick={() => onOpenExperiment(experiment.experimentId)}>
                    Open the experiment that tests it
                  </CrossLinkButton>
                </div>
              </RegisterFrame>
            </li>
          ))}
        </ul>
      )}
      <SourceLine sources={[`GET /api/clients/${clientId.slice(0, 8)}…/experiments (hypothesis field, verbatim)`]} />
    </TraceSection>
  );
}

// =====================================================================================
// LINK 5 — EXPERIMENT (THE DECLARED DESIGN)
// =====================================================================================

/**
 * The same experiments list with per-experiment expansion: the DECLARED
 * DESIGN vocabulary (design type, population unit, assignment method,
 * primary metric, guardrails, result state) — what was committed, not what
 * happened. Each experiment cross-links to its analyses (link 8, same
 * experimentId).
 */
export function ExperimentLink({
  clientId,
  open,
  onOpenChange,
  focusExperimentId,
  onOpenAnalysis,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set by the Hypothesis cross-link: this row renders expanded. */
  focusExperimentId: string | null;
  /** Cross-link into link 8: opens the Analysis section and that sub-row. */
  onOpenAnalysis: (experimentId: string) => void;
}) {
  const query = useExperimentsForClient(clientId);
  const list = query.data ?? [];
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    if (focusExperimentId !== null) {
      setOpenIds((previous) => (previous.has(focusExperimentId) ? previous : new Set([...previous, focusExperimentId])));
    }
  }, [focusExperimentId]);
  const summary = query.isPending
    ? "Loading experiments…"
    : query.isError
      ? "The experiments list couldn't load just now"
      : list.length === 0
        ? "No experiments declared on this client yet"
        : `${list.length} experiment${list.length === 1 ? "" : "s"} · expand for the declared design`;
  return (
    <TraceSection
      id="experiment"
      index={5}
      link="Experiment"
      title="What we committed to test"
      summary={summary}
      registers={["derived"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="experiments" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No experiments have been declared on this client yet."
          why="The experiment is the commitment: what population, what treatment against what comparison, measured how, stopped when. Declared in advance, it is what keeps a result meaningful rather than a story told after the fact."
          next="Experiments are declared through the platform's experiment surfaces; each appears here with its full declared design, and its analyses render in the analysis link below."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((experiment) => (
            <ExperimentDesignRow
              key={experiment.experimentId}
              experiment={experiment}
              open={openIds.has(experiment.experimentId)}
              onToggle={() =>
                setOpenIds((previous) => {
                  const next = new Set(previous);
                  if (next.has(experiment.experimentId)) next.delete(experiment.experimentId);
                  else next.add(experiment.experimentId);
                  return next;
                })
              }
              onOpenAnalysis={onOpenAnalysis}
            />
          ))}
        </ul>
      )}
      <SourceLine sources={[`GET /api/clients/${clientId.slice(0, 8)}…/experiments`]} />
    </TraceSection>
  );
}

function ExperimentDesignRow({
  experiment,
  open,
  onToggle,
  onOpenAnalysis,
}: {
  experiment: ExperimentView;
  open: boolean;
  onToggle: () => void;
  onOpenAnalysis: (experimentId: string) => void;
}) {
  return (
    <li className="overflow-hidden rounded-xl border border-dashed border-amber-700/30 bg-amber-50/30">
      <RowToggle open={open} onToggle={onToggle} controlsId={`trace-experiment-${experiment.experimentId}`}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <RegisterBadge register="derived" label="Declared design" />
            <Chip
              label={experiment.status.replace(/_/g, " ")}
              className={statusToneClass(experiment.status)}
            />
            {experiment.resultState ? (
              <Chip label={`result: ${experiment.resultState.replace(/_/g, " ")}`} className="border-stone-300 bg-white text-stone-700" />
            ) : null}
          </span>
          <span className="text-sm leading-relaxed text-stone-800">&ldquo;{experiment.hypothesis}&rdquo;</span>
          <span className="text-xs text-stone-500">
            {experiment.treatment} vs {experiment.comparison} · measures {experiment.primaryMetric.name}
          </span>
        </span>
      </RowToggle>
      {open ? (
        <div id={`trace-experiment-${experiment.experimentId}`} className="border-t border-amber-700/20 bg-white px-4 py-4">
          <div className="flex flex-col gap-3">
            <LabeledRows
              label="Declared design — what was committed, not what happened"
              record={{
                designType: experiment.designType,
                populationUnit: experiment.populationUnit,
                assignment: experiment.assignmentMethod,
                primaryMetric: experiment.primaryMetric.name,
                guardrails: experiment.guardrails.map((metric) => metric.name).join(", ") || "none declared",
                analysisMethod: experiment.analysisMethod,
                ...(experiment.analysisMethodVersion
                  ? { analysisMethodVersion: experiment.analysisMethodVersion }
                  : {}),
                uncertaintyRepresentation: experiment.uncertaintyRepresentation,
                ...(experiment.resultState !== null ? { resultState: experiment.resultState } : {}),
                ...(experiment.concludedAt ? { concludedAt: experiment.concludedAt } : {}),
              }}
            />
            <p className="text-xs leading-relaxed text-stone-500">
              Whether this design produced a settled result is answered by the deterministic
              analysis — never by reading the design.
            </p>
            <div>
              <CrossLinkButton onClick={() => onOpenAnalysis(experiment.experimentId)}>
                Open its analysis
              </CrossLinkButton>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// =====================================================================================
// LINK 6 — PUBLICATION (THE MKT-065 DISTRIBUTION SURFACE — READ ONLY)
// =====================================================================================

/**
 * The REAL MKT-065 surface: the client's distribution plans; per-plan
 * expansion composes the plan detail — destinations with their capability
 * context and state, publications (the 056 ledger links, with provider refs),
 * and the append-only lineage tail. A READ surface: no dispatch controls —
 * the trace discloses where control lives (the platform's dispatch API; no
 * console control surface exists yet).
 */
export function PublicationLink({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useDistributionPlans(clientId);
  const list = query.data ?? [];
  const summary = query.isPending
    ? "Loading distribution plans…"
    : query.isError
      ? "The distribution plans couldn't load just now"
      : list.length === 0
        ? "No distribution plans recorded on this client yet"
        : `${list.length} distribution plan${list.length === 1 ? "" : "s"} · expand for destinations, publications and lineage`;
  return (
    <TraceSection
      id="publication"
      index={6}
      link="Publication"
      title="What we sent into the world"
      summary={summary}
      registers={["observed"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView
          error={query.error}
          what="distribution plans"
          onRetry={() => void query.refetch()}
        />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No distribution plans are recorded on this client yet."
          why="A distribution plan is the §5 chain declaration — source asset, transformation plan, destinations — and the publication ledger records what actually went out, where, and with what provider reference. Without it, the measurement link has nothing published to measure."
          next="Plans are recorded and dispatched through the platform's cross-platform-distribution API (owner or admin). This trace is a read surface — it never dispatches; the dispatch operation lives in the platform API, and no console control surface exists for it yet."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((plan) => (
            <PublicationPlanRow key={plan.planId} plan={plan} clientId={clientId} />
          ))}
        </ul>
      )}
      <p className="mt-3 rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-xs leading-relaxed text-stone-500">
        Read surface: the trace composes the platform&apos;s distribution records; it offers no
        dispatch controls. Dispatch is a platform API operation (POST
        …/cross-platform-distribution/plans/:planId/dispatch, owner or admin) — no console control
        surface for it exists yet, so none is faked here.
      </p>
      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/cross-platform-distribution/plans`,
          "GET …/cross-platform-distribution/plans/:planId (on expand — destinations, publications, lineage)",
        ]}
      />
    </TraceSection>
  );
}

function PublicationPlanRow({
  plan,
  clientId,
}: {
  plan: DistributionPlanView;
  clientId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const detail = useDistributionPlanDetail(open ? clientId : null, open ? plan.planId : null);
  return (
    <li className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/50">
      <RowToggle open={open} onToggle={() => setOpen((value) => !value)} controlsId={`trace-plan-${plan.planId}`}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label="plan" className="border-stone-300 bg-white text-stone-700" />
            <Chip label={plan.planState.replace(/_/g, " ")} className={statusToneClass(plan.planState)} />
            <span className="font-mono text-xs text-stone-500">{shortRef(plan.planId)}</span>
          </span>
          <span className="font-mono text-[11px] text-stone-400">
            {`source ${plan.sourceAssetRef.slice(0, 16)}… · updated ${formatWhen(plan.updatedAt)}`}
          </span>
        </span>
      </RowToggle>
      {open ? (
        <div id={`trace-plan-${plan.planId}`} className="border-t border-stone-200 bg-white px-4 py-4">
          {detail.isPending ? (
            <SectionSkeleton rows={3} />
          ) : detail.isError ? (
            <SectionErrorView
              error={detail.error}
              what="this plan's detail"
              onRetry={() => void detail.refetch()}
            />
          ) : detail.data === undefined ? null : (
            <PublicationPlanDetail detail={detail.data} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function PublicationPlanDetail({
  detail,
}: {
  detail: NonNullable<ReturnType<typeof useDistributionPlanDetail>["data"]>;
}) {
  const { plan, destinations, publications, events } = detail;
  const publicationsByDestination = new Map(publications.map((p) => [p.destinationId, p]));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Chip label={plan.planState.replace(/_/g, " ")} className={statusToneClass(plan.planState)} />
        <span className="font-mono text-[11px] text-stone-400">
          created {formatWhen(plan.createdAt)} · updated {formatWhen(plan.updatedAt)}
        </span>
      </div>
      <LabeledRows
        label="Declared plan (the §5 chain head)"
        record={{
          sourceAssetRef: plan.sourceAssetRef,
          transformation: plan.transformationPlan.description,
          ...(plan.transformationPlan.outputs.length > 0
            ? {
                transformationOutputs: plan.transformationPlan.outputs
                  .map((output) => `${output.variantLabel} (${output.assetRef})`)
                  .join(", "),
              }
            : {}),
          ...(plan.missionId ? { missionAnchor: plan.missionId } : {}),
          inputDigest: plan.inputDigest,
        }}
      />
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Destinations &amp; publications
        </p>
        {destinations.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-stone-600">
            No destinations were declared on this plan.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2.5">
            {destinations.map((destination) => (
              <DestinationPublicationRow
                key={destination.destinationId}
                destination={destination}
                publication={publicationsByDestination.get(destination.destinationId)}
              />
            ))}
          </ul>
        )}
      </div>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
          Append-only lineage ({events.length} event{events.length === 1 ? "" : "s"})
        </p>
        {events.length === 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-stone-600">No lineage events recorded.</p>
        ) : (
          <ul className="mos-scroll mt-2 flex max-h-56 flex-col gap-1 overflow-y-auto pr-1">
            {events.map((event) => (
              <li key={event.eventId} className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-xs text-stone-600">
                <span className="font-mono text-[10px] text-stone-400">#{event.eventSeq}</span>
                <span className="font-medium">{event.eventKind.replace(/_/g, " ")}</span>
                {event.destinationId ? (
                  <span className="font-mono text-[10px] text-stone-400">
                    → {shortRef(event.destinationId)}
                  </span>
                ) : null}
                <span className="ml-auto shrink-0 text-stone-400">
                  {formatWhen(provenanceString(event.provenance, "recordedAt"))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DestinationPublicationRow({
  destination,
  publication,
}: {
  destination: DistributionDestinationView;
  publication?: DistributionPublicationView;
}) {
  return (
    <li>
      <RegisterFrame
        register="observed"
        label={publication ? "Publication ledger record" : "Destination — no publication attempt yet"}
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip
              label={destination.destinationStatus.replace(/_/g, " ")}
              className={statusToneClass(destination.destinationStatus)}
            />
            <span className="font-mono text-[11px] text-stone-400">
              {formatWhen(destination.updatedAt)}
            </span>
          </span>
        }
        disclosure={
          <LabeledRows
            label="Recorded provenance"
            record={{
              destinationId: destination.destinationId,
              platform: destination.platformId,
              targetFormat: destination.targetFormat,
              assetRef: destination.assetRef,
              idempotencyKey: destination.idempotencyKey,
            }}
          />
        }
      >
        <p className="text-sm text-stone-700">
          Destination capability: platform{" "}
          <span className="font-medium text-stone-800">{destination.platformId}</span>, format{" "}
          <span className="font-mono text-xs">{destination.targetFormat}</span>, through account{" "}
          <span className="font-mono text-xs">{shortRef(destination.socialAccountId)}</span>.
        </p>
        {publication ? (
          <div className="flex flex-col gap-1.5">
            <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-stone-700">
              <Chip
                label={publication.publishState.replace(/_/g, " ")}
                className={statusToneClass(publication.publishState)}
              />
              {publication.duplicate ? (
                <Chip label="duplicate — replayed from the ledger fence" className="border-stone-300 bg-stone-100 text-stone-600" />
              ) : null}
              {publication.publishedAt ? (
                <span className="text-xs text-stone-500">published {formatWhen(publication.publishedAt)}</span>
              ) : null}
            </p>
            <p className="font-mono text-[11px] text-stone-400">
              attempt {shortRef(publication.publishAttemptId)}
              {publication.providerPublishId ? ` · provider publish ${shortRef(publication.providerPublishId)}` : ""}
              {publication.providerContentId ? ` · provider content ${shortRef(publication.providerContentId)}` : ""}
              {publication.failureCode ? ` · failure ${publication.failureCode}` : ""}
            </p>
          </div>
        ) : (
          <p className="text-sm leading-relaxed text-stone-600">
            No publication attempt is linked to this destination — the plan may not have been
            dispatched, or this destination was blocked before any attempt (the destination state
            above is the recorded truth).
          </p>
        )}
      </RegisterFrame>
    </li>
  );
}

// =====================================================================================
// LINK 7 — MEASUREMENT (OBSERVED FACTS)
// =====================================================================================

/**
 * The measurement authority: the client's metric observations (source +
 * quality always visible) — plus the 065 plans' measurement references (the
 * §5 measurement tail the distribution module records as data). All OBSERVED
 * FACTS.
 */
export function MeasurementLink({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const observations = useMetricObservations(clientId);
  const plans = useDistributionPlans(clientId);
  const observationList = observations.data ?? [];
  const planList = plans.data ?? [];
  const summary = observations.isPending
    ? "Loading metric observations…"
    : observations.isError
      ? "The metric observations couldn't load just now"
      : observationList.length === 0 && planList.length === 0
        ? "No measurements recorded on this client yet"
        : `${observationList.length} observation${observationList.length === 1 ? "" : "s"}${planList.length > 0 ? ` · ${planList.length} distribution plan${planList.length === 1 ? "" : "s"} with measurement tails` : ""}`;
  return (
    <TraceSection
      id="measurement"
      index={7}
      link="Measurement"
      title="What the numbers say was measured"
      summary={summary}
      registers={["observed"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Metric observations
          </p>
          {observations.isPending ? (
            <div className="mt-2">
              <SectionSkeleton rows={2} />
            </div>
          ) : observations.isError ? (
            <div className="mt-2">
              <SectionErrorView
                error={observations.error}
                what="metric observations"
                onRetry={() => void observations.refetch()}
              />
            </div>
          ) : observationList.length === 0 ? (
            <div className="mt-2">
              <WorkspaceEmptyState
                missing="No metric observations are recorded on this client yet."
                why="Measurements are the ground truth every analysis in this chain computes from — without observations, nothing can honestly be claimed about progress."
                next="Observations land as connected channels report and experiments run; each records its source, quality and observed time. A young client starts empty."
              />
            </div>
          ) : (
            <ul className="mt-2 flex max-h-72 flex-col gap-2.5 overflow-y-auto pr-1">
              {observationList.map((observation) => (
                <MeasurementObservationRow key={observation.observationId} observation={observation} />
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
            Distribution plan measurement references
          </p>
          {plans.isPending ? (
            <div className="mt-2">
              <SectionSkeleton rows={1} />
            </div>
          ) : plans.isError ? (
            <div className="mt-2">
              <SectionErrorView
                error={plans.error}
                what="the distribution plan list"
                onRetry={() => void plans.refetch()}
              />
            </div>
          ) : planList.length === 0 ? (
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              No distribution plans exist yet, so no measurement references either — a plan&apos;s
              measurement tail records the references the platform holds for what its publications
              measured.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {planList.map((plan) => (
                <MeasurementPlanRow key={plan.planId} planId={plan.planId} clientId={clientId} />
              ))}
            </ul>
          )}
        </div>
      </div>
      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/metrics`,
          "GET …/cross-platform-distribution/plans/:planId (on expand — the plan's measurement_reference lineage)",
        ]}
      />
    </TraceSection>
  );
}

function MeasurementObservationRow({ observation }: { observation: MetricObservationView }) {
  const dimensionEntries = Object.entries(observation.dimensions);
  return (
    <li>
      <RegisterFrame
        register="observed"
        label="Observed fact — measurement"
        meta={
          <span className="font-mono text-[11px] text-stone-400">
            observed {formatWhen(observation.observedAt)} · retrieved {formatWhen(observation.retrievedAt)}
          </span>
        }
        disclosure={
          <LabeledRows
            label="Provenance — how this was recorded"
            record={{
              source: `${observation.source.system}${observation.source.ref ? `:${observation.source.ref}` : ""}`,
              quality: observation.quality,
              ...(observation.aggregationMethod ? { aggregationMethod: observation.aggregationMethod } : {}),
              ...(observation.evidenceRef ? { evidenceRef: observation.evidenceRef } : {}),
              ...(provenanceString(observation.provenance, "actor")
                ? { recordedBy: provenanceString(observation.provenance, "actor") as string }
                : {}),
            }}
          />
        }
      >
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs text-stone-500">{observation.metricName}</span>
          <span className="font-mono text-base font-semibold tabular-nums text-stone-800">
            {formatMetricValue(observation.value)}
          </span>
          {observation.unit ? <span className="font-mono text-xs text-stone-500">{observation.unit}</span> : null}
        </p>
        {dimensionEntries.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {dimensionEntries.map(([key, value]) => (
              <span
                key={key}
                className="rounded-full border border-stone-200 bg-white px-2 py-0.5 font-mono text-[10px] text-stone-600"
              >
                {key}: {String(value)}
              </span>
            ))}
          </div>
        ) : null}
      </RegisterFrame>
    </li>
  );
}

/** One plan's measurement references — the measurement_reference rows of the
 *  plan's append-only lineage, composed through the plan detail on expand. */
function MeasurementPlanRow({ planId, clientId }: { planId: string; clientId: string }) {
  const [open, setOpen] = React.useState(false);
  const detail = useDistributionPlanDetail(open ? clientId : null, open ? planId : null);
  const references =
    detail.data?.events.filter((event) => event.eventKind === "measurement_reference") ?? [];
  return (
    <li className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/50">
      <RowToggle open={open} onToggle={() => setOpen((value) => !value)} controlsId={`trace-measurement-plan-${planId}`}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label="plan" className="border-stone-300 bg-white text-stone-700" />
            <span className="font-mono text-xs text-stone-500">{shortRef(planId)}</span>
          </span>
          <span className="text-xs text-stone-500">
            measurement references live in the plan&apos;s lineage tail — expand to load them
          </span>
        </span>
      </RowToggle>
      {open ? (
        <div id={`trace-measurement-plan-${planId}`} className="border-t border-stone-200 bg-white px-4 py-4">
          {detail.isPending ? (
            <SectionSkeleton rows={2} />
          ) : detail.isError ? (
            <SectionErrorView
              error={detail.error}
              what="this plan's measurement tail"
              onRetry={() => void detail.refetch()}
            />
          ) : references.length === 0 ? (
            <p className="text-sm leading-relaxed text-stone-600">
              No measurement references recorded on this plan yet — the module records them as data
              (POST …/measurements); it never computes measurement itself.
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {references.map((event) => {
                const payload = event.payload;
                const measurementRef =
                  typeof payload["measurementRef"] === "string" ? payload["measurementRef"] : null;
                const note = typeof payload["note"] === "string" ? payload["note"] : null;
                return (
                  <li key={event.eventId}>
                    <RegisterFrame
                      register="observed"
                      label="Observed fact — measurement reference"
                      meta={
                        <span className="font-mono text-[11px] text-stone-400">
                          lineage #{event.eventSeq} ·{" "}
                          {formatWhen(provenanceString(event.provenance, "recordedAt"))}
                        </span>
                      }
                    >
                      <p className="min-w-0 break-all font-mono text-xs text-stone-700">
                        {measurementRef ?? "(reference not carried in the payload)"}
                      </p>
                      {note ? <p className="text-sm leading-relaxed text-stone-600">{note}</p> : null}
                      {event.destinationId ? (
                        <p className="font-mono text-[11px] text-stone-400">
                          destination {shortRef(event.destinationId)}
                        </p>
                      ) : null}
                    </RegisterFrame>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

// =====================================================================================
// LINK 8 — ANALYSIS (DERIVED CLAIMS)
// =====================================================================================

/**
 * The MKT-067 surfaces, composed per experiment (expand→fetch): the
 * experiment's sequential analysis tail and allocation recommendation tail.
 * Analysis outputs are ALWAYS marked DERIVED — deterministically computed
 * from observations, with method + version + window disclosed — never as
 * observed facts.
 */
export function AnalysisLink({
  clientId,
  open,
  onOpenChange,
  focusExperimentId,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Set by the Experiment cross-link: this experiment's sub-row renders expanded. */
  focusExperimentId: string | null;
}) {
  const query = useExperimentsForClient(clientId);
  const list = query.data ?? [];
  const [openIds, setOpenIds] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    if (focusExperimentId !== null) {
      setOpenIds((previous) =>
        previous.has(focusExperimentId) ? previous : new Set([...previous, focusExperimentId]),
      );
    }
  }, [focusExperimentId]);
  const summary = query.isPending
    ? "Loading the experiment list…"
    : query.isError
      ? "The experiment list couldn't load just now"
      : list.length === 0
        ? "No experiments to analyse yet"
        : `${list.length} experiment${list.length === 1 ? "" : "s"} — analyses load per experiment on expand`;
  return (
    <TraceSection
      id="analysis"
      index={8}
      link="Analysis"
      title="What the data said — computed, not seen"
      summary={summary}
      registers={["derived"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="experiments" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No experiments exist to analyse on this client yet."
          why="Analysis is the deterministic computation over an experiment's observation window — without a declared experiment there is nothing to compute over."
          next="Once an experiment is declared and its observation window is evaluated through the experiment-analysis surface, the computed result appears here — always marked as derived, with its method, version and window disclosed."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((experiment) => (
            <AnalysisExperimentRow
              key={experiment.experimentId}
              clientId={clientId}
              experiment={experiment}
              open={openIds.has(experiment.experimentId)}
              onToggle={() =>
                setOpenIds((previous) => {
                  const next = new Set(previous);
                  if (next.has(experiment.experimentId)) next.delete(experiment.experimentId);
                  else next.add(experiment.experimentId);
                  return next;
                })
              }
            />
          ))}
        </ul>
      )}
      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/experiments (which experiments exist)`,
          "GET …/experiment-analysis/analyses/by-experiment/:experimentId (on expand)",
          "GET …/experiment-analysis/allocations/by-experiment/:experimentId (on expand)",
        ]}
      />
    </TraceSection>
  );
}

function AnalysisExperimentRow({
  clientId,
  experiment,
  open,
  onToggle,
}: {
  clientId: string;
  experiment: ExperimentView;
  open: boolean;
  onToggle: () => void;
}) {
  const analyses = useExperimentAnalyses(open ? clientId : null, experiment.experimentId);
  const allocations = useExperimentAllocations(open ? clientId : null, experiment.experimentId);
  const analysisList = analyses.data ?? [];
  const allocationList = allocations.data ?? [];
  return (
    <li className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/50">
      <RowToggle open={open} onToggle={onToggle} controlsId={`trace-analysis-${experiment.experimentId}`}>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-stone-500">
              experiment {shortRef(experiment.experimentId)}
            </span>
            <Chip
              label={experiment.status.replace(/_/g, " ")}
              className={statusToneClass(experiment.status)}
            />
            {!open && analysisList.length > 0 ? (
              <span className="text-xs text-stone-500">
                {analysisList.length} analysis{analysisList.length === 1 ? "" : "es"} recorded
              </span>
            ) : null}
          </span>
          <span className="truncate text-sm text-stone-700">&ldquo;{experiment.hypothesis}&rdquo;</span>
        </span>
      </RowToggle>
      {open ? (
        <div id={`trace-analysis-${experiment.experimentId}`} className="border-t border-stone-200 bg-white px-4 py-4">
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                Analyses (MKT-067) — computed
              </p>
              {analyses.isPending ? (
                <div className="mt-2">
                  <SectionSkeleton rows={2} />
                </div>
              ) : analyses.isError ? (
                <div className="mt-2">
                  <SectionErrorView
                    error={analyses.error}
                    what="this experiment's analyses"
                    onRetry={() => void analyses.refetch()}
                  />
                </div>
              ) : analysisList.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-3 text-sm leading-relaxed text-stone-600">
                  No analyses recorded for this experiment yet — an analysis is recorded when its
                  observation window is evaluated through the experiment-analysis surface.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2.5">
                  {analysisList.map((analysis) => (
                    <DerivedAnalysisRow key={analysis.analysisId} analysis={analysis} />
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                Allocation recommendations — computed
              </p>
              {allocations.isPending ? (
                <div className="mt-2">
                  <SectionSkeleton rows={1} />
                </div>
              ) : allocations.isError ? (
                <div className="mt-2">
                  <SectionErrorView
                    error={allocations.error}
                    what="this experiment's allocation recommendations"
                    onRetry={() => void allocations.refetch()}
                  />
                </div>
              ) : allocationList.length === 0 ? (
                <p className="mt-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-3 text-sm leading-relaxed text-stone-600">
                  No allocation recommendations recorded yet — the bounded allocator records one
                  when the experiment&apos;s arms are evaluated.
                </p>
              ) : (
                <ul className="mt-2 flex flex-col gap-2.5">
                  {allocationList.map((recommendation) => (
                    <DerivedAllocationRow key={recommendation.recommendationId} recommendation={recommendation} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function DerivedAnalysisRow({ analysis }: { analysis: ExperimentAnalysisView }) {
  const outcomeClass = analysisOutcomeClass(analysis.outcome);
  return (
    <li>
      <RegisterFrame
        register="derived"
        label="Derived claim — analysis"
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label={analysis.outcome.replace(/_/g, " ")} className={outcomeClass} />
            <span className="font-mono text-[11px] text-stone-400">
              window {analysis.observationWindowStart.slice(0, 10)} →{" "}
              {analysis.observationWindowEnd.slice(0, 10)}
            </span>
          </span>
        }
        disclosure={
          <LabeledRows
            label="Method, version and window — how this was computed"
            record={{
              analysisMethod: analysis.analysisMethod,
              analysisMethodVersion: analysis.analysisMethodVersion,
              vocabularyVersion: analysis.vocabularyVersion,
              observationWindow: `${analysis.observationWindowStart} → ${analysis.observationWindowEnd}`,
              inputDigest: analysis.inputDigest,
              ...(analysis.practicalThreshold
                ? {
                    practicalThreshold: `${formatMetricValue(analysis.practicalThreshold.value)} (${analysis.practicalThreshold.source})`,
                  }
                : {}),
              ...(analysis.confounders.length > 0 ? { confounders: analysis.confounders.join(", ") } : {}),
              ...(analysis.limitations.length > 0 ? { limitations: analysis.limitations.join("; ") } : {}),
            }}
          />
        }
      >
        <p className="text-sm leading-relaxed text-stone-600">
          Deterministically computed from the observation window&apos;s metric observations — this
          is what the method said, not what anyone observed.
        </p>
        <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {analysis.treatmentMean !== undefined ? (
            <p className="text-xs text-stone-600">
              treatment mean{" "}
              <span className="font-mono tabular-nums text-stone-800">{formatMetricValue(analysis.treatmentMean)}</span>
            </p>
          ) : null}
          {analysis.comparisonMean !== undefined ? (
            <p className="text-xs text-stone-600">
              comparison mean{" "}
              <span className="font-mono tabular-nums text-stone-800">{formatMetricValue(analysis.comparisonMean)}</span>
            </p>
          ) : null}
          {analysis.effectEstimate !== undefined ? (
            <p className="text-xs text-stone-600">
              effect{" "}
              <span className="font-mono tabular-nums text-stone-800">
                {formatMetricValue(analysis.effectEstimate)}
                {analysis.standardError !== undefined ? ` ± ${formatMetricValue(analysis.standardError)}` : ""}
              </span>
            </p>
          ) : null}
          <p className="text-xs text-stone-600">
            samples{" "}
            <span className="font-mono tabular-nums text-stone-800">
              {Object.values(analysis.sampleSizes).map((size) => formatMetricValue(size)).join(" / ")}
            </span>
          </p>
        </div>
        {analysis.recommendedNextAllocation ? (
          <p className="text-xs text-stone-500">
            recommended next allocation:{" "}
            <span className="font-mono">{analysis.recommendedNextAllocation.replace(/_/g, " ")}</span>
          </p>
        ) : null}
        {Object.keys(analysis.uncertainty).length > 0 ? (
          <LabeledRows record={analysis.uncertainty} label="Uncertainty" />
        ) : null}
      </RegisterFrame>
    </li>
  );
}

function analysisOutcomeClass(outcome: string): string {
  switch (outcome) {
    case "effect_positive":
      return "border-teal-800/20 bg-teal-50 text-teal-900";
    case "effect_negative":
    case "effect_negligible":
    case "inconclusive":
      return "border-stone-300 bg-stone-100 text-stone-700";
    case "insufficient_observations":
      return "border-amber-700/20 bg-amber-50 text-amber-900";
    default:
      return "border-stone-200 bg-stone-50 text-stone-600";
  }
}

function DerivedAllocationRow({
  recommendation,
}: {
  recommendation: AllocationRecommendationView;
}) {
  const shares = Object.entries(recommendation.allocation.shares);
  return (
    <li>
      <RegisterFrame
        register="derived"
        label="Derived claim — allocation recommendation"
        meta={
          <span className="font-mono text-[11px] text-stone-400">
            floor {(recommendation.explorationFloor * 100).toFixed(0)}% ({recommendation.explorationFloorSource})
          </span>
        }
        disclosure={
          <LabeledRows
            label="Method, version and inputs — how this was computed"
            record={{
              vocabularyVersion: recommendation.vocabularyVersion,
              explorationFloor: recommendation.explorationFloor,
              explorationFloorSource: recommendation.explorationFloorSource,
              eligibleArms: recommendation.allocation.eligibleArms.join(", "),
              ...(recommendation.allocation.zeroCapacityArms.length > 0
                ? {
                    zeroCapacityArms: recommendation.allocation.zeroCapacityArms
                      .map((arm) => `${arm.armKey} (${arm.reason})`)
                      .join(", "),
                  }
                : {}),
              inputDigest: recommendation.inputDigest,
            }}
          />
        }
      >
        <p className="text-sm leading-relaxed text-stone-600">
          A recommendation the bounded allocator computed — a claim about where attention should go
          next, not an observation.
        </p>
        <div className="flex flex-wrap gap-2">
          {shares.map(([armKey, share]) => (
            <span
              key={armKey}
              className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 font-mono text-xs tabular-nums text-stone-700"
            >
              {armKey}: {(share * 100).toFixed(1)}%
            </span>
          ))}
        </div>
        {recommendation.rationale ? (
          <p className="text-sm leading-relaxed text-stone-600">{recommendation.rationale}</p>
        ) : null}
      </RegisterFrame>
    </li>
  );
}

// =====================================================================================
// LINK 9 — DECISION (CAUSAL INTERPRETATION)
// =====================================================================================

/**
 * The decisions ledger — CAUSAL INTERPRETATIONS: what a human concluded.
 * Rows render from the client list; expansion composes the single-decision
 * read (GET /api/decisions/:decisionId) for the full basis, and the row links
 * into the existing decision ledger screen (the real drill-down).
 */
export function DecisionLink({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useDecisions(clientId);
  const list = query.data ?? [];
  const summary = query.isPending
    ? "Loading decisions…"
    : query.isError
      ? "The decisions couldn't load just now"
      : list.length === 0
        ? "No decisions recorded on this client yet"
        : `${list.length} decision${list.length === 1 ? "" : "s"} — human interpretations, with their basis`;
  return (
    <TraceSection
      id="decision"
      index={9}
      link="Decision"
      title="What someone decided"
      summary={summary}
      registers={["interpretation"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="decisions" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No decisions are recorded on this client yet."
          why="A decision is the interpretation someone made — chosen from the evidence, analyses and alternatives, with the expected impact declared. Keeping them is what lets later choices be checked against what was actually believed."
          next="Decisions are recorded through the platform's decision surfaces as work concludes; each links its evidence and its observed outcome."
        />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {list.map((decision) => (
            <DecisionInterpretationRow key={decision.decisionId} decision={decision} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/decisions`,
          "GET /api/decisions/:decisionId (on expand — the full basis)",
        ]}
      />
    </TraceSection>
  );
}

function DecisionInterpretationRow({ decision }: { decision: DecisionRecord }) {
  const [open, setOpen] = React.useState(false);
  const detail = useDecision(open ? decision.decisionId : null);
  return (
    <li>
      <RegisterFrame
        register="interpretation"
        label="Interpretation — human conclusion"
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label={decision.disposition} className={statusToneClass(decision.disposition)} />
            {decision.observedOutcome ? (
              <Chip label="outcome recorded" className="border-stone-200 bg-stone-50 text-stone-600" />
            ) : null}
            <span className="font-mono text-[11px] text-stone-400">
              {formatWhen(decision.updatedAt ?? decision.createdAt)}
            </span>
          </span>
        }
      >
        <p className="text-sm font-medium leading-snug text-stone-800">{decision.objective}</p>
        <p className="text-sm leading-relaxed text-stone-600">{decision.hypothesisSummary}</p>
        <div className="flex flex-wrap gap-2">
          <RowToggle open={open} onToggle={() => setOpen((value) => !value)} controlsId={`trace-decision-${decision.decisionId}`}>
            <span className="text-xs font-medium text-teal-800">
              {open ? "Hide the full basis" : "Show the full basis (single-decision read)"}
            </span>
          </RowToggle>
        </div>
        {open ? (
          <div
            id={`trace-decision-${decision.decisionId}-detail`}
            className="border-t border-dashed border-stone-200 pt-2.5"
          >
            {detail.isPending ? (
              <SectionSkeleton rows={2} />
            ) : detail.isError ? (
              <SectionErrorView
                error={detail.error}
                what="this decision's detail"
                onRetry={() => void detail.refetch()}
              />
            ) : detail.data === undefined ? null : (
              <DecisionBasis record={detail.data} />
            )}
          </div>
        ) : null}
      </RegisterFrame>
    </li>
  );
}

function DecisionBasis({ record }: { record: DecisionRecord }) {
  const navigate = useMosSession((state) => state.navigate);
  return (
    <div className="flex flex-col gap-3">
      <LabeledRows
        label="Basis — what this interpretation was drawn from"
        record={{
          proposer: `${record.proposer.actor} (${record.proposer.role})`,
          evidenceRefs: record.evidenceRefs.length > 0 ? record.evidenceRefs.map((ref) => shortRef(ref)).join(", ") : "none cited",
          ...(record.experimentRef ? { experimentRef: shortRef(record.experimentRef) } : {}),
          expectedImpact: record.expectedImpact.summary,
          ...(record.expectedImpact.direction ? { direction: record.expectedImpact.direction } : {}),
          ...(record.expectedImpact.magnitude ? { magnitude: record.expectedImpact.magnitude } : {}),
          alternatives: record.alternatives.length > 0 ? record.alternatives.join("; ") : "none recorded",
          ...(record.expectedCost ? { expectedCost: record.expectedCost } : {}),
        }}
      />
      {record.observedOutcome ? (
        <LabeledRows
          label="Observed outcome — what actually happened"
          record={{
            summary: record.observedOutcome.summary,
            ...(record.observedOutcome.asExpected !== undefined
              ? { asExpected: record.observedOutcome.asExpected }
              : {}),
            ...(record.observedOutcome.notes ? { notes: record.observedOutcome.notes } : {}),
          }}
        />
      ) : (
        <p className="text-xs leading-relaxed text-stone-500">
          No observed outcome recorded yet — the expectation above stands unverified.
        </p>
      )}
      <div>
        <CrossLinkButton onClick={() => navigate({ kind: "decision", decisionId: record.decisionId })}>
          Open the decision ledger
        </CrossLinkButton>
      </div>
    </div>
  );
}

// =====================================================================================
// LINK 10 — LEARNING (CAUSAL INTERPRETATION)
// =====================================================================================

/**
 * The learnings ledger — interpreted conclusions, linked to their relatives
 * (evidence refs, experiment refs) and to their append-only relationship
 * chain (contradictions, supersessions, retirements) on expand. Superseded
 * learnings stay visible as history — never deleted-looking.
 */
export function LearningLink({
  clientId,
  open,
  onOpenChange,
}: {
  clientId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const query = useLearnings(clientId);
  const list = query.data ?? [];
  const summary = query.isPending
    ? "Loading learnings…"
    : query.isError
      ? "The learnings couldn't load just now"
      : list.length === 0
        ? "No learnings recorded on this client yet"
        : `${list.length} learning${list.length === 1 ? "" : "s"} — interpreted conclusions, with their relatives`;
  return (
    <TraceSection
      id="learning"
      index={10}
      link="Learning"
      title="What we concluded — and keep"
      summary={summary}
      registers={["interpretation"]}
      open={open}
      onOpenChange={onOpenChange}
    >
      {query.isPending ? (
        <SectionSkeleton rows={2} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="learnings" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No learnings are recorded on this client yet."
          why="A learning is the conclusion someone kept — the durable statement with its evidence and its applicability, so the next question starts wiser instead of from zero. Learnings can be contradicted and superseded later, but never erased."
          next="Learnings are recorded when experiments conclude and decisions observe their outcomes; they cite the evidence behind them and their relationships accumulate as history."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2.5 overflow-y-auto pr-1">
          {list.map((learning) => (
            <LearningInterpretationRow key={learning.learningId} learning={learning} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={[
          `GET /api/clients/${clientId.slice(0, 8)}…/learnings`,
          "GET /api/learnings/:learningId/relationships (on expand — the relationship chain)",
        ]}
      />
    </TraceSection>
  );
}

function LearningInterpretationRow({ learning }: { learning: LearningRecord }) {
  const [open, setOpen] = React.useState(false);
  const relationships = useLearningRelationships(open ? learning.learningId : null);
  const relationshipList = relationships.data ?? [];
  return (
    <li>
      <RegisterFrame
        register="interpretation"
        label={learning.supersededBy ? "Interpretation — superseded" : "Interpretation — human conclusion"}
        meta={
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip label={learning.status} className={statusToneClass(learning.status)} />
            {learning.confidence !== undefined ? (
              <span className="font-mono text-xs text-stone-500">confidence {learning.confidence}</span>
            ) : null}
            <span className="font-mono text-[11px] text-stone-400">
              {formatWhen(learning.createdAt)}
            </span>
          </span>
        }
      >
        {learning.supersededBy ? (
          <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-stone-500">
            <Chip label="historical" className="border-stone-300 bg-stone-100 text-stone-500" />
            superseded by <span className="font-mono text-[11px] text-stone-600">{shortRef(learning.supersededBy)}</span> —
            kept in full as history, never deleted.
          </p>
        ) : null}
        <p className="text-sm leading-relaxed text-stone-800">{learning.statement}</p>
        <LabeledRows
          label="Basis — the relatives this learning cites"
          record={{
            evidenceRefs:
              learning.evidenceRefs.length > 0 ? learning.evidenceRefs.map((ref) => shortRef(ref)).join(", ") : "none cited",
            experimentRefs:
              learning.experimentRefs.length > 0
                ? learning.experimentRefs.map((ref) => shortRef(ref)).join(", ")
                : "none cited",
            ...(learning.applicability && Object.keys(learning.applicability).length > 0
              ? { applicability: learning.applicability }
              : {}),
          }}
        />
        <div>
          <RowToggle open={open} onToggle={() => setOpen((value) => !value)} controlsId={`trace-learning-${learning.learningId}`}>
            <span className="text-xs font-medium text-teal-800">
              {open ? "Hide the relationship chain" : "Show the relationship chain"}
            </span>
          </RowToggle>
        </div>
        {open ? (
          <div id={`trace-learning-${learning.learningId}-chain`} className="border-t border-dashed border-stone-200 pt-2.5">
            {relationships.isPending ? (
              <SectionSkeleton rows={1} />
            ) : relationships.isError ? (
              <SectionErrorView
                error={relationships.error}
                what="this learning's relationships"
                onRetry={() => void relationships.refetch()}
              />
            ) : relationshipList.length === 0 ? (
              <p className="text-sm leading-relaxed text-stone-600">
                No contradictions, supersessions or retirements recorded against this learning —
                its statement stands as originally concluded.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {relationshipList.map((relationship) => (
                  <li
                    key={relationship.relationshipId}
                    className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-sm text-stone-700"
                  >
                    <Chip
                      label={relationship.kind}
                      className={
                        relationship.kind === "contradicts"
                          ? "border-amber-700/20 bg-amber-50 text-amber-900"
                          : "border-stone-300 bg-stone-100 text-stone-700"
                      }
                    />
                    {relationship.toLearningId ? (
                      <span className="font-mono text-[11px] text-stone-500">
                        → learning {shortRef(relationship.toLearningId)}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-stone-400">
                      {formatWhen(relationship.provenance.recordedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </RegisterFrame>
    </li>
  );
}
