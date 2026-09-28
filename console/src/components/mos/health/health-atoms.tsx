"use client";

// UX-007 — the Platform Health surface's shared presentation atoms: the
// frozen-NINE state chip (each state rendered with its HONEST weight —
// healthy/degraded plain, restricted distinct as a platform-confirmed
// block, suspected_* explicitly labeled SUSPECTED with the observable
// basis, never a shadow-ban synonym), the confidence tier chip (an
// evidence-strength descriptor, never a probability), the reason-code
// chips (the closed ph-vocab-v1 vocabulary, readable), the §11 maneuver
// list AS DATA (each an honest next action; the FORBIDDEN actions are
// structurally absent and never appear), the evidence-basis entries
// (WHICH observable record produced the verdict), the baseline summaries
// (the 'ph-baseline-v1' disclosure) and the uncertainty statement (the
// authority's own words, verbatim). Presentation ONLY — zero authority
// state, no fabricated data, no raw JSON.

import * as React from "react";
import { AlertTriangle, CircleCheck, FileSearch } from "lucide-react";
import {
  Chip,
  LabeledRows,
  formatWhen,
  provenanceString,
} from "@/components/mos/mission/workspace-atoms";
import type {
  PlatformHealthBaselineSeriesView,
  PlatformHealthEvidenceBasisView,
  PlatformHealthEvaluationView,
  PlatformHealthRecommendationView,
} from "@/lib/mos-api";

// --- The frozen-NINE state chip (§11, with its honest weight) -------------------

/**
 * The NINE descriptive states rendered at their honest weight (the
 * ShareNet visual direction: restrained teal for the healthy plain state,
 * amber for warnings and every SUSPECTED verdict, red only for true
 * failure/block — restricted is the DISTINCT platform-confirmed block).
 * There is deliberately no "shadow-banned" rendering or synonym anywhere:
 * observable-only anomaly evidence is suspected_distribution_anomaly.
 */
const HEALTH_STATE_PRESENTATION: Record<
  string,
  { cls: string; suspected: boolean; platformConfirmed: boolean }
> = {
  healthy: { cls: "border-teal-800/20 bg-teal-50 text-teal-900", suspected: false, platformConfirmed: false },
  degraded: { cls: "border-amber-700/20 bg-amber-50 text-amber-900", suspected: false, platformConfirmed: false },
  restricted: { cls: "border-red-800/25 bg-red-50 text-red-900", suspected: false, platformConfirmed: true },
  suspected_distribution_anomaly: { cls: "border-amber-700/25 bg-amber-50 text-amber-900", suspected: true, platformConfirmed: false },
  suspected_automation_risk: { cls: "border-amber-700/25 bg-amber-50 text-amber-900", suspected: true, platformConfirmed: false },
  authorization_blocked: { cls: "border-red-800/25 bg-red-50 text-red-900", suspected: false, platformConfirmed: false },
  publishing_blocked: { cls: "border-red-800/25 bg-red-50 text-red-900", suspected: false, platformConfirmed: false },
  quota_limited: { cls: "border-amber-700/20 bg-amber-50 text-amber-900", suspected: false, platformConfirmed: false },
  human_review_required: { cls: "border-amber-700/25 bg-amber-50 text-amber-900", suspected: false, platformConfirmed: false },
};

export function HealthStateChip({ state }: { state: string }) {
  const presentation = HEALTH_STATE_PRESENTATION[state];
  if (presentation === undefined) {
    // A future vocabulary version renders the raw state verbatim — never
    // a crash, never a reworded state.
    return <Chip label={state} className="border-stone-300 bg-stone-100 text-stone-700" />;
  }
  return <Chip label={state.replace(/_/g, " ")} className={presentation.cls} />;
}

/**
 * The honest qualifier under a state badge: SUSPECTED verdicts carry their
 * observable basis (never a shadow-ban claim); `restricted` carries the
 * platform-confirmed distinction. The authority's own disclosure wording.
 */
export function HealthStateQualifier({ state }: { state: string }) {
  const presentation = HEALTH_STATE_PRESENTATION[state];
  if (presentation === undefined) return null;
  if (presentation.suspected) {
    return (
      <p className="text-xs leading-relaxed text-amber-900/80">
        Suspected from observable evidence only — an anomaly signal without a
        platform-confirmed restriction, never a shadow-ban claim.
      </p>
    );
  }
  if (presentation.platformConfirmed) {
    return (
      <p className="text-xs leading-relaxed text-red-900/80">
        Platform-confirmed — the provider&apos;s own restriction record, not an
        inference.
      </p>
    );
  }
  return null;
}

/**
 * The confidence tier — a coarse, evidence-count-derived ranking (the
 * authority's tiers: high / medium / low). Rendered neutral on purpose:
 * the tier records how strong the observable evidence behind the verdict
 * is, never a probability, so it never takes a healthy/warn tone.
 */
export function ConfidenceChip({ confidence }: { confidence: string }) {
  return (
    <span className="shrink-0 rounded-full border border-stone-300 bg-white px-2.5 py-0.5 font-mono text-[11px] font-medium text-stone-600">
      confidence {confidence}
    </span>
  );
}

// --- The reason codes (the closed vocabulary, readable) ---------------------------

/** The ph-vocab-v1 reason codes as readable chips (underscores → spaces,
 *  the vocabulary verbatim otherwise). */
export function ReasonCodeChips({ reasonCodes }: { reasonCodes: string[] }) {
  if (reasonCodes.length === 0) {
    return <p className="text-xs text-stone-500">No reason codes recorded.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {reasonCodes.map((code) => (
        <Chip
          key={code}
          label={code.replace(/_/g, " ")}
          className="border-stone-200 bg-stone-50 text-stone-600"
        />
      ))}
    </div>
  );
}

// --- The compliant maneuver recommendations (§11 as data) -------------------------

/**
 * The §11 maneuver list AS DATA — each recommendation rendered as an
 * honest next action (the maneuver, its description and the state
 * rationale, all verbatim from the authority). The FORBIDDEN actions
 * (anti-abuse evasion, fake engagement, restriction bypass,
 * impersonation) are structurally absent from the recommendation
 * vocabulary and never appear here.
 */
export function ManeuverList({
  recommendations,
}: {
  recommendations: PlatformHealthRecommendationView[];
}) {
  if (recommendations.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No maneuver recommended — a healthy state needs no compliant adaptation.
        (Recommendations are data on the evaluation record; nothing is
        invented here.)
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {recommendations.map((recommendation) => (
        <li key={recommendation.maneuver} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip
              label={recommendation.maneuver.replace(/_/g, " ")}
              className="border-teal-800/20 bg-teal-50 text-teal-900"
            />
          </div>
          <p className="mt-1 text-sm leading-relaxed text-stone-700">{recommendation.description}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-stone-500">{recommendation.rationale}</p>
        </li>
      ))}
    </ul>
  );
}

// --- The evidence basis (WHICH observable record produced the verdict) ------------

/** One evidence-basis entry's record reference, by the entry's own kind. */
function basisRef(entry: PlatformHealthEvidenceBasisView): string {
  switch (entry.kind) {
    case "account_record":
      return `social account ${entry.socialAccountId.slice(0, 8)}…`;
    case "grant_record":
      return `grant ${entry.grantId.slice(0, 8)}…`;
    case "connection_record":
      return `connection ${entry.connectionId.slice(0, 8)}…`;
    case "publish_attempt":
      return `publish attempt ${entry.attemptId.slice(0, 8)}…`;
    case "status_poll":
      return `status poll ${entry.observationId.slice(0, 8)}…`;
    case "restriction_signal":
      return `restriction signal ${entry.signalKind}`;
    case "metric_observation":
      return `metric observation ${entry.observationId.slice(0, 8)}… (${entry.metricName})`;
  }
}

/**
 * The structured per-constituent evidence basis: every entry names the
 * observable record kind, its reference and the observed fact — the
 * authority's own words about what it saw, never an interpretation
 * beyond the record.
 */
export function EvidenceBasisList({ basis }: { basis: PlatformHealthEvidenceBasisView[] }) {
  if (basis.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No evidence-basis entries recorded on this evaluation.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {basis.map((entry, index) => (
        <li key={`${entry.kind}:${index}`} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="font-mono text-[11px] font-medium text-stone-500">
              {entry.kind.replace(/_/g, " ")}
            </span>
            <span className="font-mono text-[11px] text-stone-400">{basisRef(entry)}</span>
          </div>
          <p className="mt-0.5 break-words text-sm leading-relaxed text-stone-700">{entry.observedFact}</p>
        </li>
      ))}
    </ul>
  );
}

// --- The baseline summaries (the 'ph-baseline-v1' disclosure) ---------------------

/**
 * The per-series baseline disclosure: the account's own history the
 * deviation rule compared against (prior points, median, the recent
 * values), the cross-platform control series, and the honest
 * insufficient-baseline cold start — every number exactly as the
 * evaluation record carries it.
 */
export function BaselineSummaries({ baseline }: { baseline: PlatformHealthBaselineSeriesView[] }) {
  if (baseline.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No metric series were considered for this account (nothing was
        observed in the composed window).
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {baseline.map((series) => (
        <li
          key={`${series.scope}:${series.metricName}`}
          className="rounded-lg border border-stone-200 bg-white px-3 py-2"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs text-stone-700">{series.metricName}</span>
            <Chip
              label={series.scope === "control" ? "cross-platform control" : series.scope}
              className="border-stone-200 bg-stone-50 text-stone-600"
            />
            {series.insufficientBaseline ? (
              <Chip label="insufficient baseline" className="border-amber-700/25 bg-amber-50 text-amber-900" />
            ) : null}
            {series.flaggedBelowBaseline ? (
              <Chip label="flagged below baseline" className="border-amber-700/25 bg-amber-50 text-amber-900" />
            ) : null}
          </div>
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-stone-500">
            {series.priorPoints} prior point{series.priorPoints === 1 ? "" : "s"} · median{" "}
            {series.baselineMedian === null ? "—" : series.baselineMedian} · recent{" "}
            {series.recentValues.length > 0 ? series.recentValues.join(", ") : "—"} ·{" "}
            {series.suspectExcluded} suspect-quality point
            {series.suspectExcluded === 1 ? "" : "s"} excluded
          </p>
        </li>
      ))}
    </ul>
  );
}

// --- The uncertainty statement (the authority's own words) ------------------------

/**
 * The explicit uncertainty statement — rendered verbatim, never
 * reworded, never a fabricated probability. This is the honest core of
 * the verdict: what the evidence does and does not support.
 */
export function UncertaintyStatement({ uncertainty }: { uncertainty: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/60 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
        Uncertainty — the authority&apos;s own words
      </p>
      <p className="mt-1 text-sm leading-relaxed text-stone-700">{uncertainty}</p>
    </div>
  );
}

// --- The per-evaluation header row (shared by the latest + tail rows) --------------

/** The compact evaluation identity row: state chip + confidence + when. */
export function EvaluationSummaryRow({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <HealthStateChip state={evaluation.state} />
      <ConfidenceChip confidence={evaluation.confidence} />
      <span className="ml-auto shrink-0 text-xs text-stone-400">{formatWhen(evaluation.createdAt)}</span>
    </div>
  );
}

// --- The small heading used inside the evaluation picture --------------------------

/** A small block heading inside the drill-down (the GrantTail style). */
export function BlockHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{children}</p>
  );
}

/** The healthy/unhealthy first-glance icon pairing for the state chip row. */
export function StateGlanceIcon({ state }: { state: string }) {
  if (state === "healthy") {
    return <CircleCheck className="size-4 shrink-0 text-teal-800" aria-hidden="true" />;
  }
  const presentation = HEALTH_STATE_PRESENTATION[state];
  if (presentation === undefined || presentation.suspected) {
    return <AlertTriangle className="size-4 shrink-0 text-amber-700" aria-hidden="true" />;
  }
  return <AlertTriangle className="size-4 shrink-0 text-red-800" aria-hidden="true" />;
}

/** The evidence-citation drill-down affordance label. */
export function CitationHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-stone-400">
      <FileSearch className="size-3.5" aria-hidden="true" />
      the evaluation&apos;s own FK-anchored citation links, fetched live
    </span>
  );
}

/** The provenance + version footer of one evaluation record. */
export function EvaluationMetaRows({ evaluation }: { evaluation: PlatformHealthEvaluationView }) {
  const provenance = evaluation.provenance as unknown as Record<string, unknown>;
  return (
    <div className="space-y-1.5">
      <LabeledRows
        label="Provenance (server-derived)"
        record={{
          actor: provenance.actor ?? "—",
          recordedVia: provenance.recordedVia ?? "—",
          recordedAt: provenanceString(provenance, "recordedAt") ?? evaluation.createdAt,
          correlationId: String(provenance.correlationId ?? "—"),
        }}
      />
      <p className="font-mono text-[11px] text-stone-400">
        evaluation {evaluation.evaluationId.slice(0, 12)}… · {evaluation.vocabularyVersion} ·{" "}
        {evaluation.baselineVersion} · append-only history (a new evaluation is a new record)
      </p>
    </div>
  );
}
