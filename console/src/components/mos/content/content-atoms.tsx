"use client";

// UX-006 — the Content/Rights surface's shared presentation atoms: the
// card shell (operational first screen + drill-down disclosure — the
// UX-005 ConnectionCard discipline), the authority-state chips (the REAL
// vocabularies, verbatim), the evidence provenance rows (the SourceRefList
// discipline), the hypothesis block (the §6 evidence/hypothesis separation,
// never merged), the gate outcome panel (the honest WHY an asset is gated
// with its reasons and next action) and the small form field atoms.
// Presentation ONLY — zero authority state, no fabricated data, no raw JSON.

import * as React from "react";
import { ChevronDown, FileSearch } from "lucide-react";
import {
  Chip,
  LabeledRows,
  SectionSkeleton,
  SourceLine,
  WorkspaceActionButton,
  formatWhen,
  provenanceString,
} from "@/components/mos/mission/workspace-atoms";
import { ConfirmGate } from "@/components/mos/connections/connections-atoms";
import type {
  ContentHypothesisView,
  ContentRightsGateResultView,
  EvidenceRecord,
} from "@/lib/mos-api";

// --- The card shell ----------------------------------------------------------------

/**
 * One content record card: the operational first screen (what the record
 * is, its live state, its next action) with a drill-down disclosure for
 * the provenance/history detail — the surface is operational first, not
 * diagnostic. The detail rides as a render-prop receiving the open state,
 * so the section can mount its per-card detail queries ONLY when expanded
 * (the UX-003/004 expand→fetch house pattern — never a bulk prefetch).
 * Touch-friendly, keyboard accessible, aria-wired.
 */
export function ContentRecordCard({
  id,
  children,
  detail,
  detailLabel = "Provenance, evidence links and history",
  defaultOpen = false,
}: {
  id: string;
  children: React.ReactNode;
  detail: React.ReactNode | ((open: boolean) => React.ReactNode);
  detailLabel?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const detailNode = typeof detail === "function" ? detail(open) : detail;
  return (
    <li id={id} className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <div className="px-5 py-4">{children}</div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-detail`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 border-t border-stone-100 px-5 py-2.5 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <span className="text-left text-xs font-medium text-stone-500">{detailLabel}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={`${id}-detail`} className="border-t border-stone-100 bg-stone-50/40 px-5 py-4">
          {detailNode}
        </div>
      ) : null}
    </li>
  );
}

// --- The authority-state chips -------------------------------------------------------

/** The MKT-063 rights-state vocabulary, verbatim:
 *  owned | license | platform_permitted | cleared | review | blocked | unknown. */
export function RightsStateChip({ state }: { state: string }) {
  const cls =
    state === "owned" || state === "license" || state === "platform_permitted" || state === "cleared"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : state === "blocked"
        ? "border-red-800/20 bg-red-50 text-red-900"
        : state === "review" || state === "unknown"
          ? "border-amber-700/20 bg-amber-50 text-amber-900"
          : "border-stone-300 bg-stone-100 text-stone-700";
  return <Chip label={state.replace(/_/g, " ")} className={cls} />;
}

/** The MKT-064 asset lifecycle vocabulary, verbatim:
 *  draft | materialized | derived. */
export function AssetLifecycleChip({ state }: { state: string }) {
  const cls =
    state === "materialized"
      ? "border-teal-800/20 bg-teal-50 text-teal-900"
      : state === "derived"
        ? "border-stone-300 bg-stone-100 text-stone-700"
        : "border-amber-700/20 bg-amber-50 text-amber-900";
  return <Chip label={state} className={cls} />;
}

/** The MKT-062 §6 candidate signal chips (audience-fit / freshness /
 *  novelty / reuse-risk — the frozen ci-vocab-v1 states, verbatim). */
export function CandidateSignalChip({ kind, value }: { kind: string; value: string }) {
  const warn =
    value.startsWith("no_") ||
    value === "stale" ||
    value === "high" ||
    value === "misfit" ||
    value === "weak_fit";
  const cls = warn
    ? "border-amber-700/20 bg-amber-50 text-amber-900"
    : "border-stone-200 bg-stone-50 text-stone-600";
  return <Chip label={`${kind.replace(/_/g, " ")}: ${value.replace(/_/g, " ")}`} className={cls} />;
}

// --- The evidence provenance rows (the SourceRefList discipline) ---------------------

/**
 * The candidate's /evidence observation links, resolved from the client's
 * own evidence ledger: each row shows the class, the source system + ref,
 * the observation time and the quality grade — the record's provenance,
 * never an invented source.
 */
export function EvidenceProvenanceRows({
  evidenceIds,
  evidenceById,
}: {
  evidenceIds: string[];
  evidenceById: Map<string, EvidenceRecord>;
}) {
  if (evidenceIds.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-stone-600">
        No evidence links recorded on this record.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {evidenceIds.map((evidenceId) => {
        const record = evidenceById.get(evidenceId);
        if (record === undefined) {
          return (
            <li
              key={evidenceId}
              className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs text-stone-500"
            >
              Evidence <span className="font-mono">{evidenceId.slice(0, 8)}…</span> — not present
              in the client&apos;s current evidence ledger (a superseded or removed record stays
              cited here; the citation renders, never a fabricated row).
            </li>
          );
        }
        return (
          <li key={evidenceId} className="rounded-lg border border-stone-200 bg-white px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip label={record.class} className="border-teal-800/20 bg-teal-50 text-teal-900" />
              <span className="font-mono text-[11px] text-stone-500">
                {record.source.system}
                {record.source.ref ? ` · ${record.source.ref}` : ""}
              </span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-stone-400">
                {formatWhen(record.observedAt)}
              </span>
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-stone-500">
              <span>quality {record.quality}</span>
              {record.confidence !== undefined ? <span>confidence {record.confidence}</span> : null}
              {record.supersededBy !== undefined ? (
                <span className="text-amber-900">
                  superseded by {record.supersededBy.slice(0, 8)}… (kept as readable history)
                </span>
              ) : null}
              <span className="font-mono">evidence:{record.evidenceId.slice(0, 8)}…</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// --- The hypothesis block (the §6 evidence/hypothesis separation) --------------------

/**
 * The DERIVED side: the hypotheses citing a candidate — visibly separate
 * from the evidence links (a different register, the non-causal framing
 * disclosed, never merged into the observed facts). The §6 rule ships on
 * every hypothesis view.
 */
export function HypothesisBlock({
  hypotheses,
  onRecord,
  recordLabel = "Record a hypothesis citing this candidate",
}: {
  hypotheses: ContentHypothesisView[];
  onRecord?: () => void;
  recordLabel?: string;
}) {
  const current = hypotheses.filter((h) => h.supersededByContentHypothesisId == null);
  const superseded = hypotheses.filter((h) => h.supersededByContentHypothesisId != null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-amber-800/80">
          Hypotheses citing this candidate — derived claims, NOT observed evidence
        </p>
      </div>
      {current.length === 0 ? (
        <p className="text-sm leading-relaxed text-stone-600">
          No hypothesis cites this candidate yet. Observed performance does not by itself
          establish causality — a hypothesis is an input to experiments, never a conclusion.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {current.map((hypothesis) => (
            <li
              key={hypothesis.contentHypothesisId}
              className="rounded-lg border border-amber-700/20 bg-amber-50/40 px-3 py-2"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Chip
                  label={hypothesis.hypothesisKind.replace(/_/g, " ")}
                  className="border-amber-700/25 bg-white text-amber-900"
                />
                <span className="ml-auto shrink-0 text-[11px] text-stone-400">
                  {formatWhen(provenanceString(hypothesis.provenance, "recordedAt"))}
                </span>
              </div>
              {typeof hypothesis.statement["summary"] === "string" ? (
                <p className="mt-1 text-sm leading-relaxed text-stone-700">
                  {hypothesis.statement["summary"]}
                </p>
              ) : (
                <div className="mt-1">
                  <LabeledRows record={hypothesis.statement} />
                </div>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-900/70">
                hypothesis-not-causal: observed competitor/platform performance does not by
                itself establish causality for this account — this record is an input to
                experiments, never a conclusion.
              </p>
            </li>
          ))}
        </ul>
      )}
      {superseded.length > 0 ? (
        <p className="text-[11px] leading-relaxed text-stone-400">
          {superseded.length} superseded hypothesis record
          {superseded.length === 1 ? "" : "s"} stay
          {" "}
          in the append-only history (readable through the hypotheses surface).
        </p>
      ) : null}
      {onRecord ? (
        <div className="pt-1">
          <WorkspaceActionButton tone="amber" onClick={onRecord} ariaLabel={recordLabel}>
            {recordLabel}
          </WorkspaceActionButton>
        </div>
      ) : null}
    </div>
  );
}

// --- The gate outcome panel (the honest WHY an asset is gated) ------------------------

/**
 * The publication-gate evaluation result, verbatim: the outcome, every
 * reason code + detail, the per-ingredient breakdown and the explicit next
 * action for the gated outcomes. An EVALUATION, never a publication.
 */
export function GateOutcomePanel({
  gate,
  onDismiss,
}: {
  gate: ContentRightsGateResultView;
  onDismiss: () => void;
}) {
  const tone =
    gate.outcome === "allow"
      ? "border-teal-800/20 bg-teal-50/70"
      : gate.outcome === "review_required"
        ? "border-amber-700/20 bg-amber-50/70"
        : "border-red-800/20 bg-red-50/70";
  const textTone =
    gate.outcome === "allow" ? "text-teal-900" : "text-amber-900";
  return (
    <div
      role="status"
      className={`rounded-xl border p-4 ${tone}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Chip label={gate.outcome.replace(/_/g, " ")} className={`${textTone} border-current/20 bg-white`} />
        <span className="font-mono text-xs text-stone-500">
          {gate.assetRef} → {gate.destinationPlatform}
          {gate.composite ? " · composite" : ""}
        </span>
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {gate.reasons.map((reason) => (
          <li key={reason.code} className="text-sm leading-relaxed text-stone-700">
            <span className="font-mono text-xs text-stone-500">{reason.code}</span>
            {" — "}
            {reason.detail}
          </li>
        ))}
      </ul>
      {gate.ingredientEvaluations.length > 0 ? (
        <div className="mt-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
            Per-ingredient evaluations
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {gate.ingredientEvaluations.map((ingredient) => (
              <li
                key={ingredient.assetRef}
                className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs text-stone-600"
              >
                <span className="font-mono">{ingredient.assetRef}</span>
                <span className={ingredient.outcome === "allow" ? "text-teal-900" : ingredient.outcome === "blocked" ? "text-red-900" : "text-amber-900"}>
                  {ingredient.outcome.replace(/_/g, " ")}
                </span>
                {ingredient.reasonCodes.length > 0 ? (
                  <span className="text-stone-400">{ingredient.reasonCodes.join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="mt-2 text-xs leading-relaxed text-stone-500">
        {gate.outcome === "allow"
          ? "The recorded rights and destination policy permit autonomous publication to this destination. Publishing itself is the distribution authority's move (MKT-065) — this gate only evaluated it."
          : gate.outcome === "review_required"
            ? "Next action: the rights record needs a determination or a recorded human clearance before this destination is permitted — record the transition (or the per-platform permission) on the rights record below."
            : "Next action: the missing piece above is unmet — an absent rights record must be registered, a blocked state needs a new determination, and a destination that is not permitted needs the licence scope or the destination changed. The gate never auto-approves."}
      </p>
      <p className="mt-1.5 font-mono text-[11px] text-stone-400">
        policy decision {gate.policyDecisionId.slice(0, 12)}… · evaluated{" "}
        {formatWhen(gate.evaluatedAt)} · {gate.vocabularyVersion}
      </p>
      <div className="mt-2">
        <WorkspaceActionButton tone="plain" onClick={onDismiss} ariaLabel="Dismiss the gate evaluation">
          Dismiss
        </WorkspaceActionButton>
      </div>
    </div>
  );
}

// --- The honest per-source outcome line (research runs) -------------------------------

export function ResearchOutcomeChip({ outcome }: { outcome: string }) {
  const ok = outcome === "facts_extracted";
  const refused =
    outcome === "unauthorized_refused" || outcome === "read_refused" || outcome === "read_error";
  const cls = ok
    ? "border-teal-800/20 bg-teal-50 text-teal-900"
    : refused || outcome.startsWith("fetch_")
      ? "border-red-800/20 bg-red-50 text-red-900"
      : "border-amber-700/20 bg-amber-50 text-amber-900";
  return <Chip label={outcome.replace(/_/g, " ")} className={cls} />;
}

// --- Small form atoms ----------------------------------------------------------------

/** A labeled text input in the content surface's house style. */
export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = "text",
  required = false,
  invalid = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  type?: string;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-stone-500"
      >
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        required={required}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:ring-2 focus-visible:ring-teal-700 ${
          invalid ? "border-red-800/40" : "border-stone-300"
        }`}
      />
      {hint ? (
        <p className="mt-1 text-xs leading-relaxed text-stone-500">{hint}</p>
      ) : null}
    </div>
  );
}

/** A labeled select in the content surface's house style. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  hint,
  required = false,
  invalid = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wide text-stone-500"
      >
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={id}
        value={value}
        required={required}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1 w-full rounded-lg border bg-white px-3 py-2 text-sm text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-700 ${
          invalid ? "border-red-800/40" : "border-stone-300"
        }`}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p className="mt-1 text-xs leading-relaxed text-stone-500">{hint}</p>
      ) : null}
    </div>
  );
}

/** A link-styled in-page anchor (scrolls to a record card by element id). */
export function InPageLink({ targetId, children }: { targetId: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => {
        document.getElementById(targetId)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
      className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700"
    >
      <FileSearch className="size-4" aria-hidden="true" />
      {children}
    </button>
  );
}

export { Chip, ConfirmGate, SectionSkeleton, SourceLine, LabeledRows, formatWhen, provenanceString };
