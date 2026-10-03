"use client";

// UX-008 — one experiment's human-treatment picture: the card composes the
// /experiments record (the declared design — every field visible) with the
// experiment's MKT-067 allocation recommendation tail and analysis tail
// (fetched live on expand — the expand→fetch house pattern, never a bulk
// prefetch). The human arm of the latest allocation renders with its
// truthful availability state (eligible with capacity / unfunded with zero
// capacity / not declared), its bounded budget (the declared arm row), the
// allocator's recorded consideration note VERBATIM, and the never-blocks
// picture — the computed shares proceeding over the non-human arms when
// the human arm is excluded or absent. The analysis tail carries the
// outcome attribution exactly where the authority already records it.
// Explicit loading / error / empty states for every data source; never a
// raw JSON dump; nothing invented, nothing hidden.

import * as React from "react";
import { ChevronDown } from "lucide-react";
import {
  useExperimentAllocations,
  useExperimentAnalyses,
} from "@/components/mos/hooks";
import {
  Chip,
  LabeledRows,
  SectionErrorView,
  SectionSkeleton,
  formatWhen,
  provenanceString,
} from "@/components/mos/mission/workspace-atoms";
import { SectionErrorViewInline } from "@/components/mos/connections/SocialConnections";
import type { ExperimentView } from "@/lib/mos-api";
import {
  AllocationShares,
  DeclaredArmRows,
  HumanArmConsiderationNote,
  HumanArmStateChip,
  OutcomeAttributionRow,
  TreatmentsBlockHeading,
  humanArmAvailability,
} from "./treatments-atoms";

/** The experiment-status chip tone (the sections-client mapping, verbatim). */
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

/**
 * One experiment card: the collapsed row carries the experiment's own
 * declared words (its hypothesis, its treatment vs comparison, its status);
 * expanding loads the allocation + analysis tails live and renders the
 * human-arm picture. Touch-friendly (min 44px header), keyboard accessible,
 * aria-wired (the house row-toggle pattern).
 */
export function HumanTreatmentExperimentCard({
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
  const controlsId = `treatments-experiment-${experiment.experimentId}-detail`;
  return (
    <li className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/50">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={onToggle}
        className="flex min-h-[64px] w-full items-start justify-between gap-4 px-4 py-3 text-left transition-colors hover:bg-stone-100/60 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <Chip
              label={experiment.status.replace(/_/g, " ")}
              className={experimentStatusClass(experiment.status)}
            />
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-stone-800">
            &ldquo;{experiment.hypothesis}&rdquo;
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-stone-500">
            {experiment.treatment} vs {experiment.comparison} · measures{" "}
            {experiment.primaryMetric.name}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`mt-1 size-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={controlsId} className="border-t border-stone-200 bg-white px-4 py-4">
          <ExperimentTreatmentDetail clientId={clientId} experiment={experiment} />
        </div>
      ) : null}
    </li>
  );
}

/** The expanded picture: declared design + the human arm + outcome attribution. */
function ExperimentTreatmentDetail({
  clientId,
  experiment,
}: {
  clientId: string;
  experiment: ExperimentView;
}) {
  // The expand→fetch house pattern: the tails load ONLY when this card is
  // expanded (this component mounts expanded-only), React Query shares the
  // cache with every other mount of the same experiment.
  const analyses = useExperimentAnalyses(clientId, experiment.experimentId);
  const allocations = useExperimentAllocations(clientId, experiment.experimentId);
  const analysisList = analyses.data ?? [];
  const allocationList = allocations.data ?? [];
  // The tails are oldest-first (the authority's ordering); the LATEST
  // recommendation/analysis is the last record — presentation selection
  // only, every record still rendered in its tail.
  const latestAllocation = allocationList[allocationList.length - 1] ?? null;

  const provenance = experiment.provenance as Record<string, unknown>;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <TreatmentsBlockHeading>The declared design (the /experiments record)</TreatmentsBlockHeading>
        <div className="mt-1.5">
          <LabeledRows
            record={{
              workspace:
                experiment.workspaceId !== undefined
                  ? experiment.workspaceId
                  : "client-wide",
              populationUnit: experiment.populationUnit,
              decisionTarget: experiment.decisionTarget,
              treatment: experiment.treatment,
              comparison: experiment.comparison,
              assignment: experiment.assignmentMethod,
              design: experiment.designType,
              primaryMetric: {
                name: experiment.primaryMetric.name,
                dimensions: experiment.primaryMetric.dimensions,
              },
              guardrails:
                experiment.guardrails.length > 0
                  ? experiment.guardrails.map((metric) => metric.name).join(", ")
                  : "none declared",
              analysisMethod:
                experiment.analysisMethodVersion !== undefined
                  ? `${experiment.analysisMethod} (v${experiment.analysisMethodVersion})`
                  : experiment.analysisMethod,
              expectedDirection: experiment.expectedDirection ?? "not declared",
              startCriteria: experiment.startCriteria ?? "not declared",
              stopCriteria: experiment.stopCriteria,
              minimumEvidenceRequirement: experiment.minimumEvidenceRequirement,
              uncertaintyRepresentation: experiment.uncertaintyRepresentation,
              resultState: experiment.resultState ?? "undecided",
              resultingDecision: experiment.resultingDecision ?? "not yet decided",
              concludedAt: experiment.concludedAt ?? "not concluded",
            }}
          />
        </div>
      </div>

      <div>
        <TreatmentsBlockHeading>
          The human arm of the latest allocation (MKT-067 — the bounded allocator)
        </TreatmentsBlockHeading>
        {allocations.isPending ? (
          <div className="mt-2">
            <SectionSkeleton rows={3} />
          </div>
        ) : allocations.isError ? (
          <div className="mt-2">
            <SectionErrorViewInline
              error={allocations.error}
              what="this experiment's allocation recommendations"
              onRetry={() => void allocations.refetch()}
            />
          </div>
        ) : allocationList.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-3 text-sm leading-relaxed text-stone-600">
            No allocation recommendation has been recorded for this experiment yet — the
            human-arm state is honestly unknown until the bounded allocator records one
            over the experiment&apos;s declared arms. Nothing is invented here.
          </p>
        ) : latestAllocation !== null ? (
          <div className="mt-2 flex flex-col gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <HumanArmStateChip availability={humanArmAvailability(latestAllocation)} />
              <span className="font-mono text-[11px] text-stone-400">
                floor {(latestAllocation.explorationFloor * 100).toFixed(1)}% (
                {latestAllocation.explorationFloorSource})
              </span>
            </div>
            <HumanArmConsiderationNote availability={humanArmAvailability(latestAllocation)} />
            <div>
              <p className="text-xs font-medium text-stone-600">
                The declared arms — the bounded budget (capacity per arm, as recorded)
              </p>
              <div className="mt-1.5">
                <DeclaredArmRows arms={latestAllocation.arms} />
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-stone-600">
                The computed allocation — the non-human arms proceed whatever the human
                arm&apos;s state (the never-blocks guarantee, as recorded)
              </p>
              <div className="mt-1.5">
                <AllocationShares recommendation={latestAllocation} />
              </div>
            </div>
            {latestAllocation.rationale ? (
              <div className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                  The allocator&apos;s recorded rationale — verbatim
                </p>
                <p className="mt-1 text-sm leading-relaxed text-stone-700">
                  {latestAllocation.rationale}
                </p>
              </div>
            ) : null}
            <div>
              <LabeledRows
                label="The recommendation's reproducibility snapshot"
                record={latestAllocation.inputSnapshot}
              />
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-stone-400">
                recommendation {latestAllocation.recommendationId.slice(0, 12)}… ·{" "}
                {latestAllocation.vocabularyVersion}
                {latestAllocation.analysisId !== undefined
                  ? ` · derived from analysis ${latestAllocation.analysisId.slice(0, 12)}…`
                  : " · no analysis linked"}
                {latestAllocation.workspaceId !== undefined
                  ? ` · workspace ${latestAllocation.workspaceId.slice(0, 12)}…`
                  : ""}
                {" · digest "}
                {latestAllocation.inputDigest.slice(0, 12)}… · recorded by{" "}
                {provenanceString(latestAllocation.provenance, "actor") ?? "the server"} via{" "}
                {provenanceString(latestAllocation.provenance, "recordedVia") ?? "api"}
                {" · "}
                {formatWhen(provenanceString(latestAllocation.provenance, "recordedAt"))}
              </p>
            </div>
            {allocationList.length > 1 ? (
              <div>
                <TreatmentsBlockHeading>
                  Earlier recommendations (the append-only tail, {allocationList.length - 1}{" "}
                  more — never rewritten)
                </TreatmentsBlockHeading>
                <ul className="mt-1.5 flex flex-col gap-1">
                  {[...allocationList.slice(0, -1)].reverse().map((recommendation) => (
                    <li
                      key={recommendation.recommendationId}
                      className="rounded border border-stone-200 bg-stone-50/50 px-3 py-1.5 font-mono text-[11px] leading-relaxed text-stone-500"
                    >
                      {recommendation.recommendationId.slice(0, 12)}… ·{" "}
                      {Object.entries(recommendation.allocation.shares)
                        .map(([armKey, share]) => `${armKey} ${(share * 100).toFixed(1)}%`)
                        .join(" · ") || "all-zero state"}
                      {recommendation.allocation.humanTreatmentConsideration.present
                        ? " · human arm declared"
                        : " · no human arm"}
                      {" · "}
                      {formatWhen(provenanceString(recommendation.provenance, "recordedAt"))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div>
        <TreatmentsBlockHeading>
          Outcome attribution (the MKT-067 analysis tail — where the authority records it)
        </TreatmentsBlockHeading>
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
            No analyses recorded for this experiment yet — the outcome attribution appears
            when the experiment&apos;s observation window is evaluated through the
            experiment-analysis surface. Until then there is honestly no outcome to show.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {[...analysisList].reverse().map((analysis) => (
              <OutcomeAttributionRow key={analysis.analysisId} analysis={analysis} />
            ))}
          </ul>
        )}
      </div>

      <p className="font-mono text-[11px] leading-relaxed text-stone-400">
        experiment {experiment.experimentId.slice(0, 12)}… · client{" "}
        {experiment.clientId.slice(0, 12)}… · recorded via{" "}
        {provenanceString(provenance, "recordedVia") ?? "api"} · actor{" "}
        {provenanceString(provenance, "actor") ?? "—"}
      </p>
    </div>
  );
}
