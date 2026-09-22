"use client";

// UX-003 — the Mission Workspace's shared presentation atoms: the collapsible
// section (progressive disclosure — the binding visual rule), the
// WORKER-CONTRACT empty state (what is missing / why it matters / what to do
// next, with an explicit working action where one exists), the honest
// source-line (every section names the API surface it composes), and the
// goal-status chip. Presentation ONLY — zero authority state, no fabricated
// data, no raw JSON.

import * as React from "react";
import { ChevronDown } from "lucide-react";

// --- The collapsible section (progressive disclosure) --------------------------

/**
 * One workspace section: a calm card whose header row carries the question,
 * a one-line LIVE summary (server-derived, never fabricated) and an
 * expand/collapse control. Touch-friendly (min 44px), keyboard accessible,
 * aria-wired. Sections render collapsed or expanded per `defaultOpen`; the
 * summary line always tells the truth at a glance.
 */
export function WorkspaceSection({
  id,
  question,
  title,
  summary,
  summaryTone = "neutral",
  defaultOpen = false,
  children,
}: {
  id: string;
  /** The seventeen-question word this section answers (aria + sub-label). */
  question: string;
  /** The plain-language section title. */
  title: string;
  /** One-line live summary shown on the header row (empty states included). */
  summary: string;
  summaryTone?: "neutral" | "healthy" | "warning" | "failure";
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const summaryToneClass =
    summaryTone === "healthy"
      ? "text-teal-900"
      : summaryTone === "warning"
        ? "text-amber-900"
        : summaryTone === "failure"
          ? "text-red-900"
          : "text-stone-500";
  return (
    <section
      id={`section-${id}`}
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-stone-200 bg-white"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-content`}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[64px] w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-stone-400">
            {question}
          </span>
          <span id={`${id}-heading`} className="block font-medium text-stone-800">
            {title}
          </span>
          <span className={`mt-1 block text-xs leading-relaxed ${summaryToneClass}`}>{summary}</span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`mt-1 size-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={`${id}-content`} className="border-t border-stone-100 px-5 py-5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

// --- The honest source line ------------------------------------------------------

/**
 * Every expanded section names the exact API surface it composed — the
 * workspace's honesty about where each answer comes from (the composition
 * discipline made visible, in small type, never raw JSON).
 */
export function SourceLine({ sources }: { sources: string[] }) {
  return (
    <p className="mt-4 text-[11px] leading-relaxed text-stone-400">
      Source: {sources.join(" · ")}
    </p>
  );
}

// --- The WORKER-CONTRACT empty state ---------------------------------------------

/**
 * The binding empty state: (1) what is missing, (2) why it matters, (3) what
 * to do next — plus an explicit working action where one exists. Rendered
 * inline in sections (not a modal); young missions see this everywhere, so
 * it stays calm and short.
 */
export function WorkspaceEmptyState({
  missing,
  why,
  next,
  action,
}: {
  missing: string;
  why: string;
  next: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-4">
      <p className="text-sm font-medium text-stone-700">{missing}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{why}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{next}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

// --- Buttons (the house style, touch-friendly) -----------------------------------

export function WorkspaceActionButton({
  onClick,
  children,
  tone = "teal",
  type = "button",
  disabled = false,
}: {
  onClick?: () => void;
  children: React.ReactNode;
  tone?: "teal" | "amber" | "plain";
  type?: "button" | "submit";
  disabled?: boolean;
}) {
  const toneClass =
    tone === "amber"
      ? "border-amber-700/30 bg-white text-amber-900 hover:bg-amber-100 focus-visible:ring-amber-700"
      : tone === "plain"
        ? "border-stone-300 bg-white text-stone-700 hover:bg-stone-100 focus-visible:ring-stone-400"
        : "border-teal-800/25 bg-white text-teal-900 hover:bg-teal-50 focus-visible:ring-teal-700";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex min-h-[44px] items-center rounded-lg border px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

// --- Chips ------------------------------------------------------------------------

const GOAL_TONE_CLASSES: Record<string, string> = {
  active: "border-teal-800/20 bg-teal-50 text-teal-900",
  achieved: "border-teal-800/20 bg-teal-50 text-teal-900",
  paused: "border-amber-700/20 bg-amber-50 text-amber-900",
  blocked: "border-amber-700/20 bg-amber-50 text-amber-900",
  failed: "border-red-800/20 bg-red-50 text-red-900",
};

/** A goal-status chip (the LIVE /goals status, shown as the server holds it). */
export function GoalStatusChip({ status }: { status: string | null }) {
  if (status === null) {
    return (
      <span className="shrink-0 rounded-full border border-stone-300 bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
        Status unavailable
      </span>
    );
  }
  const cls = GOAL_TONE_CLASSES[status.toLowerCase()] ?? "border-stone-300 bg-stone-100 text-stone-700";
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${cls}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** A plain status chip with an explicit class (used for platforms etc.). */
export function Chip({ label, className }: { label: string; className: string }) {
  return (
    <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  );
}

// --- Formatting helpers ------------------------------------------------------------

export function formatWhen(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A recordedAt (or actor) pulled from an untyped provenance record — string
 *  or nothing; never a cast, never a fabricated timestamp. */
export function provenanceString(
  provenance: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = provenance?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

export function formatDate(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** A metric value as a readable figure (grouping only — never rounded). */
export function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : String(value);
}

// --- The loading skeleton used inside expanded sections ---------------------------

export function SectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="h-4 w-3/4 animate-pulse rounded bg-stone-200/70" />
      ))}
    </div>
  );
}

// --- The honest error view (the UX-002 precedent: server words verbatim) ----------

export function SectionErrorView({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
}) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-amber-700/20 bg-amber-50 p-4">
      <p className="font-medium text-amber-900">{what} couldn&apos;t be loaded just now.</p>
      <p className="mt-1 break-words text-sm leading-relaxed text-amber-900/80">{message}</p>
      {onRetry ? (
        <div className="mt-3">
          <WorkspaceActionButton tone="amber" onClick={onRetry}>
            Try again
          </WorkspaceActionButton>
        </div>
      ) : null}
    </div>
  );
}

// --- The formatted disclosure (every key visible, never raw JSON) -----------------

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A record-shaped server payload as FORMATTED labeled rows — every key stays
 * visible (nested records as sub-rows, string arrays as a comma list,
 * numbers tabular), never a raw JSON dump and never a dropped key. The
 * mission-workhouse twin of the Client Workspace's AssumptionDisclosure,
 * in the UX-001/002 stone visual language.
 */
export function LabeledRows({
  record,
  label,
}: {
  record: Record<string, unknown>;
  label?: string;
}) {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return <p className="text-xs text-stone-500">Nothing recorded.</p>;
  }
  return (
    <div>
      {label ? <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{label}</p> : null}
      <dl className="mt-1 flex flex-col gap-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 font-mono text-[11px] text-stone-400">{key}</dt>
            <dd className="min-w-0 text-right text-xs leading-relaxed text-stone-700">
              <DisclosureValue value={value} />
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function DisclosureValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-stone-400">—</span>;
  if (typeof value === "boolean") return <span className="font-mono tabular-nums">{String(value)}</span>;
  if (typeof value === "number")
    return <span className="font-mono tabular-nums">{formatMetricValue(value)}</span>;
  if (typeof value === "string")
    return <span className="break-words">{value === "" ? "—" : value}</span>;
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry === "string")) {
      return <span className="break-words">{(value as string[]).join(", ")}</span>;
    }
    return <span className="break-words">{value.map((entry) => String(entry)).join(", ")}</span>;
  }
  if (isPlainRecord(value)) {
    return (
      <span className="block w-full">
        <LabeledRows record={value} />
      </span>
    );
  }
  // Unexpected shapes stay fully visible — honest fallback, never dropped.
  return <span className="break-all font-mono text-[11px]">{JSON.stringify(value)}</span>;
}
