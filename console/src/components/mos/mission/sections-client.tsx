"use client";

// UX-003 — the client-scoped sections: EVIDENCE, HYPOTHESIS & EXPERIMENT
// (with the NEW MKT-067 experiment-analysis compositions on expand), PLATFORMS,
// HEALTH (the truthful coming state + what is observable now), CONTENT, RIGHTS,
// TRANSFORMATION, MEASUREMENT, DECISION and LEARNING.
//
// All of these compose the CLIENT WORKSPACE authorities through their real
// read surfaces (GET /api/clients/:clientId/…). When no client context
// resolves from the mission's goal mappings (the young-mission norm), every
// section renders the WORKER-CONTRACT empty state and makes ZERO
// client-scoped calls — the queries are disabled at null input.
//
// NEVER a second analytics layer: each section renders one authority's own
// records, formatted; progress is never computed here.

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  useContentAssets,
  useContentRights,
  useContentTransformations,
  useDecisions,
  useEvidence,
  useExperimentAllocations,
  useExperimentAnalyses,
  useExperimentsForClient,
  useLearnings,
  useMetricObservations,
  useSocialAccountEvents,
  useSocialAccounts,
} from "@/components/mos/hooks";
import type {
  AllocationRecommendationView,
  ContentAssetVersionView,
  ContentRightsRecordView,
  ContentTransformationView,
  DecisionRecord,
  EvidenceRecord,
  ExperimentAnalysisView,
  ExperimentView,
  LearningRecord,
  MetricObservationView,
  SocialAccountEventView,
  SocialAccountView,
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
  WorkspaceSection,
  formatMetricValue,
  formatWhen,
} from "./workspace-atoms";

// --- The shared no-client-context state --------------------------------------------

/**
 * The honest state for every client-scoped section when no client context
 * resolves from the goal mappings. Points at the REAL working action
 * (map a goal — the Progress section) instead of fabricating data.
 */
function NoClientContextState() {
  return (
    <WorkspaceEmptyState
      missing="This mission is not connected to any client's working surfaces yet."
      why="Evidence, experiments, metrics, decisions, learnings, channels and content all live inside a client — the mission composes them through the goal it maps to that client."
      next="Map a goal (Progress section above) — the client that owns it becomes this mission's context, and these sections fill in live."
      action={<ScrollToProgressButton />}
    />
  );
}

function ScrollToProgressButton() {
  return (
    <WorkspaceActionButton
      onClick={() => {
        document.getElementById("section-progress")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      Go to Progress
    </WorkspaceActionButton>
  );
}

// --- EVIDENCE -----------------------------------------------------------------------

export function EvidenceSection({ clientId }: { clientId: string | null }) {
  const query = useEvidence(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="evidence"
      question="Evidence"
      title="What has been observed"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No evidence recorded on this client yet"
                : `${list.length} evidence record${list.length === 1 ? "" : "s"} on the mission's client`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="evidence" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No evidence records exist on this client yet."
          why="Evidence is what was actually observed — the observations every analysis, decision and learning builds on. Without it, conclusions are just opinion."
          next="Evidence is recorded through the platform's evidence surfaces as work runs; a young client starts empty and fills in as observations land."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((record) => (
            <EvidenceRow key={record.evidenceId} record={record} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/evidence`]}
      />
    </WorkspaceSection>
  );
}

function EvidenceRow({ record }: { record: EvidenceRecord }) {
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={record.class} className="border-stone-300 bg-white text-stone-700" />
        <Chip label={record.quality} className="border-stone-200 bg-stone-50 text-stone-600" />
        {record.confidence !== undefined ? (
          <span className="font-mono text-xs text-stone-500">confidence {record.confidence}</span>
        ) : null}
        {record.supersededBy ? (
          <Chip label="superseded" className="border-stone-300 bg-stone-100 text-stone-500" />
        ) : null}
        <span className="ml-auto text-xs text-stone-400">{formatWhen(record.observedAt)}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        source {record.source.system}
        {record.source.ref ? `:${record.source.ref}` : ""}
      </p>
      <div className="mt-1.5">
        <EvidenceContent content={record.content} />
      </div>
    </li>
  );
}

/** The evidence content, formatted by its kind — never a raw JSON dump. */
function EvidenceContent({ content }: { content: Record<string, unknown> }) {
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
      <div className="space-y-1.5">
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
    const rest = Object.fromEntries(
      Object.entries(content).filter(([key]) => key !== "statement"),
    );
    return (
      <div className="space-y-1.5">
        <p className="text-sm leading-relaxed text-stone-700">{statement}</p>
        {Object.keys(rest).length > 0 ? <LabeledRows record={rest} /> : null}
      </div>
    );
  }
  return <LabeledRows record={content} />;
}

// --- HYPOTHESIS & EXPERIMENT (with the MKT-067 compositions) ------------------------

export function ExperimentsSection({ clientId }: { clientId: string | null }) {
  const query = useExperimentsForClient(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="experiments"
      question="Hypothesis · Experiment"
      title="What is being tested"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No experiments declared on this client yet"
                : `${list.length} experiment${list.length === 1 ? "" : "s"} declared on the mission's client`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="experiments" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No experiments have been declared on this client yet."
          why="Experiments carry the hypotheses the mission tests — what is tried, against what comparison, measured how. Without them there is nothing to measure or decide from."
          next="Experiments are declared through the platform's experiment surfaces as the mission's strategy composes; the Growth Operator records what it tests in the mission's history."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((experiment) => (
            <ExperimentRow key={experiment.experimentId} experiment={experiment} clientId={clientId} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={
          clientId === null
            ? []
            : [
                `GET /api/clients/${clientId.slice(0, 8)}…/experiments`,
                "GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId (on expand)",
                "GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId (on expand)",
              ]
        }
      />
    </WorkspaceSection>
  );
}

function ExperimentRow({
  experiment,
  clientId,
}: {
  experiment: ExperimentView;
  clientId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const statusToneClass = experimentStatusClass(experiment.status);
  return (
    <li className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50/50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`experiment-${experiment.experimentId}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[56px] w-full items-start justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-stone-100/70 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-relaxed text-stone-800">
            &ldquo;{experiment.hypothesis}&rdquo;
          </span>
          <span className="mt-1 block text-xs text-stone-500">
            {experiment.treatment} vs {experiment.comparison} · measures {experiment.primaryMetric.name}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Chip label={experiment.status.replace(/_/g, " ")} className={statusToneClass} />
          <ChevronDown
            aria-hidden="true"
            className={`size-4 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <div id={`experiment-${experiment.experimentId}-detail`} className="border-t border-stone-200 bg-white px-4 py-4">
          <ExperimentDetail experiment={experiment} clientId={clientId} />
        </div>
      ) : null}
    </li>
  );
}

function experimentStatusClass(status: string): string {
  switch (status) {
    case "running":
      return "border-teal-800/20 bg-teal-50 text-teal-900";
    case "concluded":
      return "border-stone-300 bg-stone-100 text-stone-700";
    case "stopped":
    case "invalidated":
      return "border-amber-700/20 bg-amber-50 text-amber-900";
    default:
      return "border-stone-200 bg-stone-50 text-stone-600";
  }
}

/** One experiment's full composition: its declared design + the MKT-067
 *  analysis tail + allocation tail (fetched live on expand — the
 *  expand→fetch house pattern, never a bulk prefetch). */
function ExperimentDetail({
  experiment,
  clientId,
}: {
  experiment: ExperimentView;
  clientId: string;
}) {
  const analyses = useExperimentAnalyses(clientId, experiment.experimentId);
  const allocations = useExperimentAllocations(clientId, experiment.experimentId);
  const analysisList = analyses.data ?? [];
  const allocationList = allocations.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <LabeledRows
        label="Declared design"
        record={{
          populationUnit: experiment.populationUnit,
          decisionTarget: experiment.decisionTarget,
          assignment: experiment.assignmentMethod,
          design: experiment.designType,
          analysisMethod: experiment.analysisMethod,
          uncertaintyRepresentation: experiment.uncertaintyRepresentation,
          ...(experiment.resultState !== null ? { resultState: experiment.resultState } : {}),
          ...(experiment.concludedAt ? { concludedAt: experiment.concludedAt } : {}),
        }}
      />
      {experiment.guardrails.length > 0 ? (
        <p className="text-xs text-stone-500">
          Guardrails: {experiment.guardrails.map((metric) => metric.name).join(", ")}
        </p>
      ) : null}

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Experiment analyses (MKT-067)
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
          <ul className="mt-2 flex flex-col gap-2">
            {analysisList.map((analysis) => (
              <AnalysisRow key={analysis.analysisId} analysis={analysis} />
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
          Allocation recommendations
        </p>
        {allocations.isPending ? (
          <div className="mt-2">
            <SectionSkeleton rows={2} />
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
            No allocation recommendations recorded yet — the bounded allocator records one when the
            experiment&apos;s arms are evaluated.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {allocationList.map((recommendation) => (
              <AllocationRow key={recommendation.recommendationId} recommendation={recommendation} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AnalysisRow({ analysis }: { analysis: ExperimentAnalysisView }) {
  const outcome = analysis.outcome;
  const outcomeClass = analysisOutcomeClass(outcome);
  const sequential = analysis.sequentialState;
  const sequentialRecord =
    typeof sequential === "object" && sequential !== null && !Array.isArray(sequential)
      ? (sequential as Record<string, unknown>)
      : {};
  return (
    <li className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {outcome !== null && outcome !== undefined ? (
          <Chip label={outcome.replace(/_/g, " ")} className={outcomeClass} />
        ) : null}
        <Chip
          label="sequential look recorded"
          className="border-stone-200 bg-stone-50 text-stone-600"
        />
        {analysis.recommendedNextAllocation ? (
          <Chip
            label={`next: ${analysis.recommendedNextAllocation.replace(/_/g, " ")}`}
            className="border-stone-300 bg-white text-stone-700"
          />
        ) : null}
        <span className="ml-auto text-xs text-stone-400">
          {analysis.observationWindowStart.slice(0, 10)} → {analysis.observationWindowEnd.slice(0, 10)}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        {analysis.analysisMethod} v{analysis.analysisMethodVersion} · digest {analysis.inputDigest.slice(0, 12)}…
      </p>
      <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
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
              {analysis.standardError !== undefined
                ? ` ± ${formatMetricValue(analysis.standardError)}`
                : ""}
            </span>
          </p>
        ) : null}
        <p className="text-xs text-stone-600">
          samples{" "}
          <span className="font-mono tabular-nums text-stone-800">
            {Object.values(analysis.sampleSizes)
              .map((size) => formatMetricValue(size))
              .join(" / ")}
          </span>
        </p>
      </div>
      {analysis.practicalThreshold !== undefined ? (
        <p className="mt-1.5 text-xs text-stone-500">
          Practical threshold {formatMetricValue(analysis.practicalThreshold.value)} (
          {analysis.practicalThreshold.source}
          {analysis.practicalThreshold.description ? `: ${analysis.practicalThreshold.description}` : ""})
        </p>
      ) : null}
      {Object.keys(analysis.uncertainty).length > 0 ? (
        <div className="mt-2">
          <LabeledRows record={analysis.uncertainty} label="Uncertainty" />
        </div>
      ) : null}
      {Object.keys(sequentialRecord).length > 0 ? (
        <div className="mt-2">
          <LabeledRows record={sequentialRecord} label="Sequential state" />
        </div>
      ) : null}
      {analysis.confounders.length > 0 ? (
        <p className="mt-2 text-xs text-stone-500">Confounders: {analysis.confounders.join(", ")}</p>
      ) : null}
      {analysis.limitations.length > 0 ? (
        <p className="mt-1 text-xs text-stone-500">Limitations: {analysis.limitations.join("; ")}</p>
      ) : null}
    </li>
  );
}

function analysisOutcomeClass(outcome: string | null): string {
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

function AllocationRow({
  recommendation,
}: {
  recommendation: AllocationRecommendationView;
}) {
  const shares = Object.entries(recommendation.allocation.shares);
  return (
    <li className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label="allocation" className="border-stone-300 bg-white text-stone-700" />
        <span className="font-mono text-xs text-stone-500">
          floor {(recommendation.explorationFloor * 100).toFixed(0)}% ({recommendation.explorationFloorSource})
        </span>
        {recommendation.rationale ? (
          <span className="ml-auto max-w-full basis-full break-words text-xs text-stone-400">
            {recommendation.rationale}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {shares.map(([armKey, share]) => (
          <span
            key={armKey}
            className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 font-mono text-xs tabular-nums text-stone-700"
          >
            {armKey}: {(share * 100).toFixed(1)}%
          </span>
        ))}
      </div>
      <div className="mt-2">
        <LabeledRows
          label="Allocation detail"
          record={{
            eligibleArms: recommendation.allocation.eligibleArms.join(", "),
            explorationShare: recommendation.allocation.explorationShare,
            zeroCapacityArms: recommendation.allocation.zeroCapacityArms.map(
              (arm) => `${arm.armKey} (${arm.reason})`,
            ),
          }}
        />
      </div>
      {Object.keys(recommendation.allocation.humanTreatmentConsideration).length > 0 ? (
        <div className="mt-2">
          <LabeledRows
            record={recommendation.allocation.humanTreatmentConsideration}
            label="Human-treatment arm consideration"
          />
        </div>
      ) : null}
    </li>
  );
}

// --- PLATFORMS ------------------------------------------------------------------------

export function PlatformsSection({ clientId }: { clientId: string | null }) {
  const query = useSocialAccounts(clientId);
  const list = query.data ?? [];
  const connected = list.filter((account) => account.status === "connected");
  return (
    <WorkspaceSection
      id="platforms"
      question="Platforms"
      title="Channels the mission can reach"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No channels connected on this client yet"
                : `${connected.length} of ${list.length} channel binding${list.length === 1 ? "" : "s"} connected`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="channels" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No channels are connected on this client yet."
          why="A mission reaches people through connected channels — their live connection state decides what can actually be published."
          next="Channels are connected through the platform's provider connection flow (the console's Connections Center is a planned update — UX-005). Until then, the platform records connections made through provider OAuth rounds."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((account) => (
            <SocialAccountRow key={account.socialAccountId} account={account} clientId={clientId} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/social-accounts`]}
      />
    </WorkspaceSection>
  );
}

function SocialAccountRow({
  account,
  clientId,
}: {
  account: SocialAccountView;
  clientId: string;
}) {
  const [open, setOpen] = React.useState(false);
  const events = useSocialAccountEvents(open ? clientId : null, account.socialAccountId);
  const statusClass =
    account.status === "connected"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : account.status === "revoked"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : "border-stone-300 bg-stone-100 text-stone-600";
  return (
    <li className="overflow-hidden rounded-lg border border-stone-200 bg-stone-50/50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`social-account-${account.socialAccountId}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-stone-100/70 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-stone-800">
            {account.displayIdentity ?? account.externalAccountId}
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">
            {account.platformId} · updated {formatWhen(account.updatedAt)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <Chip label={account.status} className={statusClass} />
          <ChevronDown
            aria-hidden="true"
            className={`size-4 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>
      {open ? (
        <div id={`social-account-${account.socialAccountId}-detail`} className="border-t border-stone-200 bg-white px-4 py-4">
          <AccountEvents events={events} />
        </div>
      ) : null}
    </li>
  );
}

function AccountEvents({
  events,
}: {
  events: ReturnType<typeof useSocialAccountEvents>;
}) {
  if (events.isPending) return <SectionSkeleton rows={2} />;
  if (events.isError) {
    return (
      <SectionErrorView
        error={events.error}
        what="this channel's events"
        onRetry={() => void events.refetch()}
      />
    );
  }
  const list = events.data ?? [];
  if (list.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No events recorded for this channel yet — its append-only event tail records every
        connection-lifecycle change (authorize, refresh, disconnect, revoke).
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {list.slice(0, 5).map((event) => (
        <AccountEventRow key={event.eventId} event={event} />
      ))}
      {list.length > 5 ? (
        <li className="text-xs text-stone-500">
          … {list.length - 5} earlier event{list.length - 5 === 1 ? "" : "s"} recorded.
        </li>
      ) : null}
    </ul>
  );
}

function AccountEventRow({ event }: { event: SocialAccountEventView }) {
  return (
    <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-stone-700">
      <span className="font-medium">{event.eventType.replace(/_/g, " ")}</span>
      {event.reason ? <span className="text-xs text-stone-500">{event.reason}</span> : null}
      <span className="ml-auto shrink-0 text-xs text-stone-400">{formatWhen(event.recordedAt)}</span>
    </li>
  );
}

// --- HEALTH ------------------------------------------------------------------------------

/**
 * PLATFORM HEALTH (MKT-066) IS NOT BUILT YET: this section renders the
 * TRUTHFUL coming state (what health will show, why it matters) plus what
 * is observable NOW through the social-accounts events surface. It NEVER
 * invents "shadow ban"-style hidden moderation state the providers do not
 * expose.
 */
export function HealthSection({ clientId }: { clientId: string | null }) {
  const accounts = useSocialAccounts(clientId);
  const list = accounts.data ?? [];
  const connected = list.filter((account) => account.status === "connected").slice(0, 5);

  return (
    <WorkspaceSection
      id="health"
      question="Health"
      title="How the channels are doing"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : "Platform Health is a planned surface — showing what is observable now"
      }
      summaryTone="warning"
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-lg border border-stone-200 bg-stone-50/70 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
              Coming: platform health
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
              Platform Health (a planned update to this workspace) will show each channel&apos;s
              descriptive state with its evidence basis, confidence and uncertainty, and the next
              compliant action — what a platform actually told us, never a guess.
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-stone-600">
              It matters because a channel can look connected while quietly failing to deliver.
              Health will make that visible honestly — and it will never claim hidden moderation
              (like &ldquo;shadow bans&rdquo;) that providers do not expose; if the evidence is
              missing, it will say so.
            </p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
              Observable now
            </p>
            {accounts.isPending ? (
              <div className="mt-2">
                <SectionSkeleton rows={2} />
              </div>
            ) : accounts.isError ? (
              <div className="mt-2">
                <SectionErrorView
                  error={accounts.error}
                  what="the channel list"
                  onRetry={() => void accounts.refetch()}
                />
              </div>
            ) : connected.length === 0 ? (
              <p className="mt-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-3 text-sm leading-relaxed text-stone-600">
                Nothing is observable yet — no connected channels on this client. Once a channel is
                connected, its live connection state and append-only event tail (the changes the
                provider or an operator recorded) are what health can honestly be composed from
                today.
              </p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {connected.map((account) => (
                  <ConnectedAccountHealthRow
                    key={account.socialAccountId}
                    account={account}
                    clientId={clientId}
                  />
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs leading-relaxed text-stone-500">
              What you see here is each channel&apos;s live connection state and its latest recorded
              events — the observable facts. Anything the provider does not expose is simply not
              claimed.
            </p>
          </div>
        </div>
      )}
      <SourceLine
        sources={
          clientId === null
            ? ["platform health: not built yet (MKT-066)"]
            : [
                `GET /api/clients/${clientId.slice(0, 8)}…/social-accounts (live states)`,
                "GET /api/clients/:clientId/social-accounts/:accountId/events (per channel, on expand)",
              ]
        }
      />
    </WorkspaceSection>
  );
}

function ConnectedAccountHealthRow({
  account,
  clientId,
}: {
  account: SocialAccountView;
  clientId: string;
}) {
  const events = useSocialAccountEvents(clientId, account.socialAccountId);
  const list = events.data ?? [];
  const latest = list.length > 0 ? list[list.length - 1] : null;
  return (
    <li className="rounded-lg border border-stone-200 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-stone-800">
          {account.displayIdentity ?? account.externalAccountId}
        </span>
        <Chip label="connected" className="border-teal-800/20 bg-teal-50 text-teal-900" />
      </div>
      <p className="mt-1 text-xs text-stone-500">{account.platformId}</p>
      {events.isPending ? (
        <div className="mt-1.5">
          <SectionSkeleton rows={1} />
        </div>
      ) : events.isError ? (
        <p className="mt-1.5 text-xs text-amber-900/80">
          This channel&apos;s events couldn&apos;t be loaded just now — its connection state above
          is still the live truth.
        </p>
      ) : latest ? (
        <p className="mt-1.5 text-sm text-stone-700">
          Latest recorded event:{" "}
          <span className="font-medium">{latest.eventType.replace(/_/g, " ")}</span>
          {latest.reason ? <span className="text-stone-500"> — {latest.reason}</span> : null}
          <span className="ml-2 text-xs text-stone-400">{formatWhen(latest.recordedAt)}</span>
        </p>
      ) : (
        <p className="mt-1.5 text-sm text-stone-600">
          No events recorded yet — the connection state above is the whole observable truth for
          this channel.
        </p>
      )}
    </li>
  );
}

// --- CONTENT ---------------------------------------------------------------------------

export function ContentSection({ clientId }: { clientId: string | null }) {
  const query = useContentAssets(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="content"
      question="Content"
      title="Material the mission can work with"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No content assets recorded on this client yet"
                : `${list.length} asset version${list.length === 1 ? "" : "s"} recorded`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="content assets" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No content assets are recorded on this client yet."
          why="A mission promotes material — a post, a video, a product shot — and each piece carries its own versioned record here, from source to transformed output."
          next="Assets are recorded through the platform's content pipeline as material is sourced and transformed; the console's full Content + Rights view is a planned update (UX-006)."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((version) => (
            <ContentAssetRow key={version.versionId} version={version} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/content-assets`]}
      />
    </WorkspaceSection>
  );
}

function ContentAssetRow({ version }: { version: ContentAssetVersionView }) {
  const lifecycleClass =
    version.lifecycleState === "materialized"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : "border-stone-300 bg-stone-100 text-stone-600";
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-stone-800">
          {version.displayName ?? version.assetRef}
        </span>
        <Chip label={`v${version.version} ${version.lifecycleState}`} className={lifecycleClass} />
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        {version.mediaKind} · {version.contentType} · ref {version.assetRef.slice(0, 16)}…
      </p>
      <p className="mt-0.5 text-xs text-stone-500">
        Recorded {formatWhen(version.createdAt)}
        {version.objectSize !== undefined ? ` · ${(version.objectSize / 1024).toFixed(1)} KB stored` : ""}
      </p>
    </li>
  );
}

// --- RIGHTS -----------------------------------------------------------------------------

export function RightsSection({ clientId }: { clientId: string | null }) {
  const query = useContentRights(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="rights"
      question="Rights"
      title="Permission to use the material"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No rights records on this client yet"
                : `${list.length} rights record${list.length === 1 ? "" : "s"}`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="content rights" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No rights records exist on this client yet."
          why="Before anything is published, each asset needs its rights state — owned, licensed, cleared, review or blocked. Without a record, publication is not permitted."
          next="Rights records are determined through the platform's rights surfaces as assets are sourced; the gate evaluates them before any autonomous publication."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((record) => (
            <RightsRow key={record.rightsRecordId} record={record} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/content-rights`]}
      />
    </WorkspaceSection>
  );
}

function RightsRow({ record }: { record: ContentRightsRecordView }) {
  const stateClass =
    record.state === "owned" || record.state === "cleared" || record.state === "platform_permitted"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : record.state === "blocked"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : record.state === "review" || record.state === "unknown"
          ? "border-amber-700/20 bg-amber-50 text-amber-900"
          : "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={record.state} className={stateClass} />
        <span className="font-mono text-xs text-stone-500">{record.assetKind}</span>
        <span className="ml-auto text-xs text-stone-400">{formatWhen(record.updatedAt)}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        asset {record.contentAssetRef.slice(0, 16)}…
        {record.licenceLabel ? ` · ${record.licenceLabel}` : ""}
      </p>
      {record.validUntil ? (
        <p className="mt-0.5 text-xs text-stone-500">Valid until {record.validUntil.slice(0, 10)}</p>
      ) : null}
    </li>
  );
}

// --- TRANSFORMATION -----------------------------------------------------------------------

export function TransformationSection({ clientId }: { clientId: string | null }) {
  const query = useContentTransformations(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="transformation"
      question="Transformation"
      title="How material is being reshaped"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No transformations requested on this client yet"
                : `${list.length} transformation${list.length === 1 ? "" : "s"} recorded`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView
          error={query.error}
          what="transformations"
          onRetry={() => void query.refetch()}
        />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No transformations have been requested on this client yet."
          why="One source asset becomes many channel-ready pieces through recorded transformations — a clip, a crop, a caption — each with its ingredients and output versioned."
          next="Transformations are requested through the platform's content pipeline as the mission composes material; each one records its lineage here."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((transformation) => (
            <TransformationRow key={transformation.transformationId} transformation={transformation} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={
          clientId === null
            ? []
            : [`GET /api/clients/${clientId.slice(0, 8)}…/content-assets/transformations`]
        }
      />
    </WorkspaceSection>
  );
}

function TransformationRow({ transformation }: { transformation: ContentTransformationView }) {
  const statusClass =
    transformation.status === "completed" || transformation.status === "succeeded"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : transformation.status === "failed"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : "border-stone-300 bg-stone-100 text-stone-600";
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 font-medium text-stone-800">
          {transformation.transformationKind}
        </span>
        <Chip label={transformation.status} className={statusClass} />
      </div>
      <p className="mt-1 text-xs text-stone-500">
        {transformation.engineId ? `engine ${transformation.engineId} · ` : ""}
        requested {formatWhen(transformation.createdAt)}
        {transformation.completedAt ? ` · completed ${formatWhen(transformation.completedAt)}` : ""}
      </p>
      {transformation.failureReason ? (
        <p className="mt-1 text-sm text-red-900/80">{transformation.failureReason}</p>
      ) : null}
      {transformation.outputVersionId ? (
        <p className="mt-0.5 font-mono text-[11px] text-stone-400">
          output version {transformation.outputVersionId.slice(0, 12)}…
        </p>
      ) : null}
    </li>
  );
}

// --- MEASUREMENT --------------------------------------------------------------------------

export function MetricsSection({ clientId }: { clientId: string | null }) {
  const query = useMetricObservations(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="measurement"
      question="Measurement"
      title="What the numbers say"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No metric observations on this client yet"
                : `${list.length} observation${list.length === 1 ? "" : "s"} recorded`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="metric observations" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No metric observations are recorded on this client yet."
          why="Measurements are the ground truth every analysis and decision builds on — without observations, nothing can honestly be claimed about progress."
          next="Observations land as connected channels report and experiments run; each one records its source, quality and observed time."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((observation) => (
            <MetricObservationRow key={observation.observationId} observation={observation} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/metrics`]}
      />
    </WorkspaceSection>
  );
}

function MetricObservationRow({ observation }: { observation: MetricObservationView }) {
  const dimensionEntries = Object.entries(observation.dimensions);
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs text-stone-500">{observation.metricName}</span>
        <span className="font-mono text-base font-semibold tabular-nums text-stone-800">
          {formatMetricValue(observation.value)}
        </span>
        {observation.unit ? (
          <span className="font-mono text-xs text-stone-500">{observation.unit}</span>
        ) : null}
        <span className="ml-auto text-xs text-stone-400">{formatWhen(observation.observedAt)}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        source {observation.source.system}
        {observation.source.ref ? `:${observation.source.ref}` : ""} · quality {observation.quality}
      </p>
      {dimensionEntries.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
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
    </li>
  );
}

// --- DECISION ------------------------------------------------------------------------------

export function DecisionsSection({ clientId }: { clientId: string | null }) {
  const query = useDecisions(clientId);
  const list = query.data ?? [];
  const navigate = useMosSession((state) => state.navigate);
  return (
    <WorkspaceSection
      id="decisions"
      question="Decision"
      title="What was decided"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No decisions recorded on this client yet"
                : `${list.length} decision${list.length === 1 ? "" : "s"} in the ledger`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="decisions" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No decisions are recorded on this client yet."
          why="Decisions carry what was chosen, why, and with what expected impact — the thread from evidence to action that keeps later choices honest."
          next="Decisions are recorded through the platform's decision surfaces as the mission's strategy concludes experiments; each one links its evidence and observed outcome."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((decision) => (
            <li key={decision.decisionId}>
              <button
                type="button"
                onClick={() => navigate({ kind: "decision", decisionId: decision.decisionId })}
                className="w-full rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3 text-left transition-colors hover:bg-stone-100/70 focus-visible:ring-2 focus-visible:ring-teal-700"
              >
                <DecisionRow decision={decision} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/decisions`]}
      />
    </WorkspaceSection>
  );
}

function DecisionRow({ decision }: { decision: DecisionRecord }) {
  const dispositionClass =
    decision.disposition === "accepted"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : decision.disposition === "rejected"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={decision.disposition} className={dispositionClass} />
        <span className="font-mono text-xs text-stone-400">
          {decision.decisionId.slice(0, 8)}…
        </span>
        {decision.observedOutcome ? (
          <Chip label="outcome recorded" className="border-stone-200 bg-stone-50 text-stone-600" />
        ) : null}
      </div>
      <p className="mt-1.5 text-sm font-medium leading-snug text-stone-800">{decision.objective}</p>
      <p className="mt-1 text-sm leading-relaxed text-stone-600">{decision.hypothesisSummary}</p>
      <p className="mt-1 text-xs text-teal-800">Open the decision ledger →</p>
    </div>
  );
}

// --- LEARNING -------------------------------------------------------------------------------

export function LearningsSection({ clientId }: { clientId: string | null }) {
  const query = useLearnings(clientId);
  const list = query.data ?? [];
  return (
    <WorkspaceSection
      id="learnings"
      question="Learning"
      title="What was learned"
      summary={
        clientId === null
          ? "Waiting for a client context (map a goal first)"
          : query.isPending
            ? "Loading…"
            : query.isError
              ? "Couldn't load just now"
              : list.length === 0
                ? "No learnings recorded on this client yet"
                : `${list.length} learning${list.length === 1 ? "" : "s"} recorded`
      }
    >
      {clientId === null ? (
        <NoClientContextState />
      ) : query.isPending ? (
        <SectionSkeleton rows={3} />
      ) : query.isError ? (
        <SectionErrorView error={query.error} what="learnings" onRetry={() => void query.refetch()} />
      ) : list.length === 0 ? (
        <WorkspaceEmptyState
          missing="No learnings are recorded on this client yet."
          why="Learnings are what stuck — the durable statements with their evidence and applicability, so the next mission starts wiser instead of from zero."
          next="Learnings are recorded when experiments conclude and decisions observe their outcomes; they cite the evidence behind them."
        />
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {list.map((learning) => (
            <LearningRow key={learning.learningId} learning={learning} />
          ))}
        </ul>
      )}
      <SourceLine
        sources={clientId === null ? [] : [`GET /api/clients/${clientId.slice(0, 8)}…/learnings`]}
      />
    </WorkspaceSection>
  );
}

function LearningRow({ learning }: { learning: LearningRecord }) {
  const statusClass =
    learning.status === "accepted" || learning.status === "active"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : learning.status === "superseded"
        ? "border-stone-300 bg-stone-100 text-stone-500"
        : "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <li className="rounded-lg border border-stone-200 bg-stone-50/50 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={learning.status} className={statusClass} />
        {learning.confidence !== undefined ? (
          <span className="font-mono text-xs text-stone-500">confidence {learning.confidence}</span>
        ) : null}
        <span className="ml-auto font-mono text-xs text-stone-400">
          {learning.learningId.slice(0, 8)}…
        </span>
      </div>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-800">{learning.statement}</p>
      {learning.evidenceRefs.length > 0 ? (
        <p className="mt-1 font-mono text-[11px] text-stone-400">
          evidence {learning.evidenceRefs.map((ref) => ref.slice(0, 8)).join(", ")}
        </p>
      ) : null}
    </li>
  );
}
