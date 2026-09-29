"use client";

// UX-008 — the Human Treatment surface's shared presentation atoms: the
// arm-kind chips (the frozen four-arm grammar — treatment / comparison /
// strategy_variant / human_treatment, the human arm rendered distinct), the
// human-arm availability chips (the truthful availability picture as the
// MKT-067 allocation authority records it: eligible with observable
// capacity / zero-capacity unfunded / absent by declaration — never an
// invented state, never a hidden failure), the declared-arm rows (the
// bounded budget: capacity, observations, mean, variance — every field
// exactly as recorded), the allocation share bar + chips (the never-blocks
// guarantee made VISIBLE: the non-human arms proceeding with their
// computed shares while the human arm is excluded or absent), the frozen
// analysis-outcome chips, and the small block heading. Presentation ONLY —
// zero authority state, no fabricated data, no raw JSON.

import * as React from "react";
import {
  Chip,
  LabeledRows,
  formatMetricValue,
} from "@/components/mos/mission/workspace-atoms";
import type {
  AllocationRecommendationView,
  ExperimentAnalysisView,
} from "@/lib/mos-api";

// --- The arm-kind chips (the frozen four-arm grammar) ---------------------------

/**
 * The MKT-067 arm-kind vocabulary, each rendered at its honest weight: the
 * human-treatment arm distinct in restrained teal (the optional experiment
 * arm this surface is about); the declared non-human kinds in calm stone.
 * An unknown future vocabulary value renders verbatim — never a crash,
 * never a reworded kind.
 */
const ARM_KIND_PRESENTATION: Record<string, string> = {
  human_treatment: "border-teal-800/20 bg-teal-50 text-teal-900",
  treatment: "border-stone-300 bg-white text-stone-700",
  comparison: "border-stone-300 bg-stone-100 text-stone-600",
  strategy_variant: "border-stone-300 bg-white text-stone-700",
};

export function ArmKindChip({ kind }: { kind: string }) {
  const cls = ARM_KIND_PRESENTATION[kind];
  return (
    <Chip
      label={kind.replace(/_/g, " ")}
      className={cls ?? "border-stone-300 bg-stone-100 text-stone-700"}
    />
  );
}

// --- The human-arm availability picture (as the authority records it) ------------

/**
 * The human arm's availability state in ONE allocation recommendation —
 * PRESENTATION GROUPING ONLY over the served record (the HealthTab
 * tails-grouping discipline): the consideration block and the declared
 * arms are read exactly as the authority recorded them, never re-derived.
 */
export type HumanArmAvailability =
  | { state: "eligible"; armKey: string; capacity: number; note: string }
  | { state: "zero_capacity"; armKey: string; capacity: 0; reason: string; note: string }
  | { state: "absent"; note: string };

/**
 * Derives the human arm's availability from ONE allocation recommendation
 * (the authority's own consideration block + declared arms + zero-capacity
 * records — every word rendered verbatim downstream, nothing invented).
 */
export function humanArmAvailability(
  recommendation: AllocationRecommendationView,
): HumanArmAvailability {
  // The consideration block ships as a record (the wire mirror's honest
  // shape) — read its fields with typed guards and honest fallbacks, never
  // a cast, never an invented value.
  const consideration = recommendation.allocation.humanTreatmentConsideration;
  const present = consideration["present"] === true;
  const excluded = consideration["excluded"] === true;
  const considerationCapacity =
    typeof consideration["capacity"] === "number" ? consideration["capacity"] : 0;
  const note =
    typeof consideration["note"] === "string" && consideration["note"] !== ""
      ? consideration["note"]
      : "The allocator recorded no human-arm consideration note on this recommendation.";
  const humanArm = recommendation.arms.find(
    (arm) => (arm as { kind?: unknown }).kind === "human_treatment",
  );
  const humanRecord = (humanArm ?? {}) as { armKey?: unknown };
  const humanArmKey =
    typeof humanRecord["armKey"] === "string" && humanRecord["armKey"] !== ""
      ? humanRecord["armKey"]
      : "—";
  if (present && !excluded) {
    return {
      state: "eligible",
      armKey: humanArmKey,
      capacity: considerationCapacity,
      note,
    };
  }
  if (present && excluded) {
    const zeroRecord = recommendation.allocation.zeroCapacityArms.find(
      (arm) => arm.kind === "human_treatment",
    );
    return {
      state: "zero_capacity",
      armKey: zeroRecord?.armKey ?? humanArmKey,
      capacity: 0,
      reason: zeroRecord?.reason ?? "zero observable capacity — excluded from allocation",
      note,
    };
  }
  return {
    state: "absent",
    note,
  };
}

/**
 * The human-arm availability chip — the truthful availability picture in
 * human terms: in play with observable capacity (teal), unfunded with zero
 * observable capacity (amber — a valid optional-treatment state, never a
 * hidden failure), or not declared in this allocation (stone).
 */
export function HumanArmStateChip({ availability }: { availability: HumanArmAvailability }) {
  switch (availability.state) {
    case "eligible":
      return (
        <Chip
          label={`human arm in play · capacity ${formatMetricValue(availability.capacity)}`}
          className="border-teal-800/20 bg-teal-50 text-teal-900"
        />
      );
    case "zero_capacity":
      return (
        <Chip
          label="human arm unfunded — zero capacity"
          className="border-amber-700/20 bg-amber-50 text-amber-900"
        />
      );
    case "absent":
      return (
        <Chip
          label="no human arm declared"
          className="border-stone-300 bg-stone-100 text-stone-700"
        />
      );
  }
}

/**
 * The never-blocks statement under the availability chip: the authority's
 * own consideration note VERBATIM (never reworded, never dropped) — the
 * recorded guarantee that absence of human capacity never blocks, crashes
 * or invalidates the non-human allocation. The zero-capacity exclusion
 * reason renders with it.
 */
export function HumanArmConsiderationNote({ availability }: { availability: HumanArmAvailability }) {
  const tone =
    availability.state === "eligible"
      ? "border-teal-800/15 bg-teal-50/50 text-teal-900/90"
      : availability.state === "zero_capacity"
        ? "border-amber-700/15 bg-amber-50/60 text-amber-900/90"
        : "border-stone-200 bg-stone-50/60 text-stone-600";
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${tone}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">
        The allocator&apos;s recorded human-arm consideration — verbatim
      </p>
      <p className="mt-1 text-sm leading-relaxed">{availability.note}</p>
      {availability.state === "zero_capacity" ? (
        <p className="mt-1.5 text-sm leading-relaxed">
          <span className="font-medium">Recorded exclusion reason:</span> {availability.reason}
        </p>
      ) : null}
    </div>
  );
}

// --- The declared arms (the bounded budget, every field as recorded) --------------

/**
 * The declared arms of one allocation recommendation — the bounded budget
 * picture: each arm's kind, its observable capacity (the bounded budget
 * this cycle), its observations, mean and variance, exactly as declared
 * and recorded. The human arm row carries its teal kind chip.
 */
export function DeclaredArmRows({ arms }: { arms: AllocationRecommendationView["arms"] }) {
  if (arms.length === 0) {
    return <p className="text-xs text-stone-500">No arms declared on this recommendation.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {arms.map((arm, index) => {
        const record = arm as Record<string, unknown>;
        const armKey =
          typeof record["armKey"] === "string" ? record["armKey"] : `arm ${index + 1}`;
        const kind = typeof record["kind"] === "string" ? record["kind"] : "—";
        const capacity = typeof record["capacity"] === "number" ? record["capacity"] : 0;
        const sampleSize = typeof record["sampleSize"] === "number" ? record["sampleSize"] : 0;
        const mean = typeof record["mean"] === "number" ? record["mean"] : 0;
        const variance = typeof record["variance"] === "number" ? record["variance"] : 0;
        return (
          <li key={armKey} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs font-medium text-stone-700">{armKey}</span>
              <ArmKindChip kind={kind} />
              {capacity <= 0 ? (
                <Chip
                  label="zero capacity — excluded"
                  className="border-amber-700/20 bg-amber-50 text-amber-900"
                />
              ) : null}
            </div>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-stone-500">
              capacity {formatMetricValue(capacity)} · observations{" "}
              {formatMetricValue(sampleSize)} · mean {mean} · variance {variance}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

// --- The allocation shares (the never-blocks guarantee made visible) --------------

/** A stable stone palette for the share bar segments (never a rainbow). */
const SHARE_SEGMENT_CLASSES = [
  "bg-stone-300",
  "bg-stone-400",
  "bg-stone-500",
  "bg-stone-600",
  "bg-stone-700/60",
] as const;

/**
 * The computed allocation as a proportional bar + per-arm chips: every
 * eligible arm's share as recorded (the bar is the visual aid; the chips
 * carry the exact numbers). When the human arm is excluded or absent this
 * IS the never-blocks picture — the non-human arms proceeding with their
 * computed shares, nothing hidden, nothing failed.
 */
export function AllocationShares({ recommendation }: { recommendation: AllocationRecommendationView }) {
  const arms = recommendation.arms;
  const kindByArmKey = new Map<string, string>();
  for (const arm of arms) {
    const record = arm as Record<string, unknown>;
    if (typeof record["armKey"] === "string" && typeof record["kind"] === "string") {
      kindByArmKey.set(record["armKey"], record["kind"]);
    }
  }
  const shares = Object.entries(recommendation.allocation.shares);
  const zeroCapacity = recommendation.allocation.zeroCapacityArms;
  const eligibleWithoutShare = recommendation.allocation.eligibleArms.filter(
    (armKey) => !(armKey in recommendation.allocation.shares),
  );
  return (
    <div className="space-y-2">
      {shares.length > 0 ? (
        <div
          role="img"
          aria-label="The computed allocation shares, one segment per eligible arm"
          className="flex h-2.5 w-full overflow-hidden rounded-full border border-stone-200 bg-stone-100"
        >
          {shares.map(([armKey, share], index) => (
            <div
              key={armKey}
              className={
                kindByArmKey.get(armKey) === "human_treatment"
                  ? "bg-teal-700/70"
                  : SHARE_SEGMENT_CLASSES[index % SHARE_SEGMENT_CLASSES.length]
              }
              style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs leading-relaxed text-stone-500">
          The honest all-zero state — every declared arm has zero observable capacity, so
          no allocation was fabricated (a valid state, never an error).
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {shares.map(([armKey, share]) => (
          <span
            key={armKey}
            className={`rounded-full border px-2.5 py-0.5 font-mono text-xs tabular-nums ${
              kindByArmKey.get(armKey) === "human_treatment"
                ? "border-teal-800/20 bg-teal-50 text-teal-900"
                : "border-stone-200 bg-stone-50 text-stone-700"
            }`}
          >
            {armKey}: {(share * 100).toFixed(1)}%
          </span>
        ))}
        {eligibleWithoutShare.map((armKey) => (
          <span
            key={armKey}
            className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-0.5 font-mono text-xs text-stone-500"
          >
            {armKey}: no share recorded
          </span>
        ))}
        {zeroCapacity.map((arm) => (
          <span
            key={arm.armKey}
            className="rounded-full border border-amber-700/20 bg-amber-50 px-2.5 py-0.5 font-mono text-xs text-amber-900"
          >
            {arm.armKey}: excluded (zero capacity)
          </span>
        ))}
      </div>
    </div>
  );
}

// --- The frozen analysis-outcome chips (the outcome attribution) ------------------

/**
 * The frozen MKT-067 outcome vocabulary at its honest weight: a positive
 * effect in restrained teal, negative/negligible/inconclusive calm stone,
 * insufficient observations amber (the honest not-yet-decidable state).
 * A future vocabulary value renders verbatim.
 */
const ANALYSIS_OUTCOME_PRESENTATION: Record<string, string> = {
  effect_positive: "border-teal-800/20 bg-teal-50 text-teal-900",
  effect_negative: "border-stone-300 bg-stone-100 text-stone-700",
  effect_negligible: "border-stone-300 bg-stone-100 text-stone-700",
  inconclusive: "border-stone-300 bg-stone-100 text-stone-700",
  insufficient_observations: "border-amber-700/20 bg-amber-50 text-amber-900",
};

export function AnalysisOutcomeChip({ outcome }: { outcome: string }) {
  const cls = ANALYSIS_OUTCOME_PRESENTATION[outcome];
  return (
    <Chip
      label={outcome.replace(/_/g, " ")}
      className={cls ?? "border-stone-300 bg-stone-100 text-stone-700"}
    />
  );
}

/** A record-shaped payload guard (the LabeledRows discipline). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One recorded analysis — the outcome attribution where the authority
 * already records it: the frozen outcome + recommended next allocation,
 * the observation window, the computed means/effect/samples, the
 * practical threshold, the uncertainty + sequential state disclosures
 * (every key visible), the confounders/limitations and the cited record
 * references. Never a raw JSON dump.
 */
export function OutcomeAttributionRow({ analysis }: { analysis: ExperimentAnalysisView }) {
  const sequential = isPlainRecord(analysis.sequentialState) ? analysis.sequentialState : {};
  return (
    <li className="rounded-lg border border-stone-200 bg-white px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AnalysisOutcomeChip outcome={analysis.outcome} />
        {analysis.recommendedNextAllocation ? (
          <Chip
            label={`next: ${analysis.recommendedNextAllocation.replace(/_/g, " ")}`}
            className="border-stone-300 bg-white text-stone-700"
          />
        ) : null}
        <span className="ml-auto shrink-0 text-xs text-stone-400">
          window {analysis.observationWindowStart.slice(0, 10)} →{" "}
          {analysis.observationWindowEnd.slice(0, 10)}
        </span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-stone-400">
        {analysis.analysisMethod} v{analysis.analysisMethodVersion} · {analysis.vocabularyVersion} ·
        analysis {analysis.analysisId.slice(0, 12)}… · digest {analysis.inputDigest.slice(0, 12)}…
      </p>
      <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {analysis.treatmentMean !== undefined ? (
          <p className="text-xs text-stone-600">
            treatment mean{" "}
            <span className="font-mono tabular-nums text-stone-800">
              {formatMetricValue(analysis.treatmentMean)}
            </span>
          </p>
        ) : null}
        {analysis.comparisonMean !== undefined ? (
          <p className="text-xs text-stone-600">
            comparison mean{" "}
            <span className="font-mono tabular-nums text-stone-800">
              {formatMetricValue(analysis.comparisonMean)}
            </span>
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
            {Object.entries(analysis.sampleSizes)
              .map(([arm, size]) => `${arm} ${formatMetricValue(size)}`)
              .join(" / ")}
          </span>
        </p>
      </div>
      {analysis.practicalThreshold !== undefined ? (
        <p className="mt-1.5 text-xs text-stone-500">
          Practical threshold {formatMetricValue(analysis.practicalThreshold.value)} (
          {analysis.practicalThreshold.source}
          {analysis.practicalThreshold.description
            ? `: ${analysis.practicalThreshold.description}`
            : ""}
          )
        </p>
      ) : null}
      {Object.keys(analysis.uncertainty).length > 0 ? (
        <div className="mt-2">
          <LabeledRows record={analysis.uncertainty} label="Uncertainty" />
        </div>
      ) : null}
      {Object.keys(sequential).length > 0 ? (
        <div className="mt-2">
          <LabeledRows record={sequential} label="Sequential state" />
        </div>
      ) : null}
      {analysis.confounders.length > 0 ? (
        <p className="mt-2 text-xs text-stone-500">Confounders: {analysis.confounders.join(", ")}</p>
      ) : null}
      {analysis.limitations.length > 0 ? (
        <p className="mt-1 text-xs text-stone-500">Limitations: {analysis.limitations.join("; ")}</p>
      ) : null}
      {analysis.evidenceRefs.length > 0 ||
      analysis.metricObservationRefs.length > 0 ||
      analysis.learningRefs.length > 0 ? (
        <p className="mt-2 font-mono text-[11px] leading-relaxed text-stone-400">
          {analysis.evidenceRefs.length > 0
            ? `evidence ${analysis.evidenceRefs.map((ref) => ref.slice(0, 8)).join(", ")}`
            : null}
          {analysis.metricObservationRefs.length > 0
            ? ` · metric observations ${analysis.metricObservationRefs.length}`
            : ""}
          {analysis.learningRefs.length > 0 ? ` · learnings ${analysis.learningRefs.length}` : ""}
        </p>
      ) : null}
    </li>
  );
}

// --- The small block heading (the health-atoms BlockHeading style) ----------------

export function TreatmentsBlockHeading({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{children}</p>;
}
