"use client";

/**
 * Shared MOS presentation atoms: honest empty states, error rendering,
 * loading skeletons, status badges, provenance/figure displays.
 * Nothing here fabricates data — every component renders what the MOS API
 * returned or an explicit "no data" state.
 */

import * as React from "react";
import { AlertTriangle, Inbox, ShieldAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MosApiError, type ProfitFigure, type SourceRef } from "@/lib/mos-api";

/** Renders a MOS API error honestly (code + message + validation details). */
export function MosErrorView({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
}) {
  if (error instanceof MosApiError) {
    const denied = error.status === 403 || error.status === 404;
    return (
      <Alert role="alert" variant="destructive" className="my-2 break-words">
        {denied ? <ShieldAlert className="size-4" /> : <AlertTriangle className="size-4" />}
        <AlertTitle>
          {denied ? "Access denied by the MOS server" : `Could not load ${what}`}
        </AlertTitle>
        <AlertDescription className="space-y-1">
          <p className="font-mono text-xs">
            {error.status} · {error.code}
          </p>
          <p>{error.message}</p>
          {error.details.length > 0 ? (
            <ul className="list-disc pl-4 font-mono text-xs">
              {error.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          ) : null}
          {onRetry ? (
            <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert role="alert" variant="destructive" className="my-2">
      <AlertTriangle className="size-4" />
      <AlertTitle>Could not load {what}</AlertTitle>
      <AlertDescription>
        <p>{error instanceof Error ? error.message : String(error)}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-1" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Honest empty state — never a fake placeholder that looks like data. */
export function EmptyState({
  title,
  hint,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Optional real affordance rendered inside the empty state (e.g. the
   *  "create your first client" button — DEP-006 D4). */
  action?: React.ReactNode;
}) {
  return (
    <div
      role="status"
      className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center"
    >
      <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-md text-xs text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "default",
  live: "default",
  achieved: "default",
  accepted: "default",
  completed: "default",
  draft: "secondary",
  planned: "secondary",
  proposed: "secondary",
  open: "secondary",
  disabled: "outline",
  suspended: "outline",
  abandoned: "outline",
  rejected: "destructive",
  failed: "destructive",
  blocked: "destructive",
  error: "destructive",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const tone = STATUS_TONE[(status ?? "").toLowerCase()] ?? "secondary";
  return (
    <Badge variant={tone as "default" | "secondary" | "outline" | "destructive"}>
      {status ?? "—"}
    </Badge>
  );
}

/** Counts as chips (server-vocabulary keys, sorted for stable display). */
export function CountChips({
  counts,
  labelSingular,
}: {
  counts: Record<string, number>;
  labelSingular?: string;
}) {
  const entries = Object.entries(counts).filter(([, value]) => value !== 0);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No {labelSingular ?? "entries"} recorded.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {entries.map(([key, value]) => (
        <Badge key={key} variant="secondary" className="font-mono text-xs">
          {key}: {value}
        </Badge>
      ))}
    </div>
  );
}

/** Server source references, rendered as pills. */
export function SourceRefList({ refs, empty = "none" }: { refs: SourceRef[]; empty?: string }) {
  if (refs.length === 0) {
    return <span className="font-mono text-xs text-muted-foreground">{empty}</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((ref) => (
        <Badge key={`${ref.kind}:${ref.id}`} variant="outline" className="font-mono text-[10px]">
          {ref.kind}:{ref.id.slice(0, 8)}
        </Badge>
      ))}
    </span>
  );
}

/** A labeled key/value row list for compact provenance display. */
export function KeyValueRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {rows.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {key}
          </dt>
          <dd className="break-words text-sm">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The soul of Profit Intelligence: every material figure WITH its
 * provenance (calculation version, assumption keys, source refs) or its
 * honest not-derivable reason.
 */
export function FigureDisplay({
  label,
  figure,
}: {
  label: string;
  figure: ProfitFigure | undefined;
}) {
  if (figure === undefined) {
    return (
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="text-sm text-muted-foreground">not returned</p>
      </div>
    );
  }
  const derivable = figure.notDerivableReason === undefined;
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {derivable ? (
        <p className="font-mono text-lg font-semibold tabular-nums">
          {figure.currency} {figure.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      ) : (
        <p className="text-sm italic text-muted-foreground">
          Not derivable — {figure.notDerivableReason}
        </p>
      )}
      <p className="font-mono text-[10px] text-muted-foreground">
        {figure.provenance} · {figure.calculationVersion}
        {figure.assumptionKeys.length > 0 ? ` · assumptions: ${figure.assumptionKeys.join(", ")}` : ""}
      </p>
      {figure.sourceRefs.length > 0 ? <SourceRefList refs={figure.sourceRefs} /> : null}
    </div>
  );
}

/** Long-list wrapper: max height + styled scrollbar (UI rule). */
export function ScrollList({
  children,
  className = "",
  label,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={`mos-scroll max-h-96 overflow-y-auto pr-1 ${className}`}
    >
      {children}
    </div>
  );
}

export function formatWhen(value: string | undefined | null): string {
  if (value === undefined || value === null || value === "") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A goal time horizon ({startsOn, endsOn}) as a readable range. */
export function formatHorizon(
  horizon: { startsOn: string; endsOn: string } | undefined,
): string {
  if (horizon === undefined) return "—";
  return `${horizon.startsOn} → ${horizon.endsOn}`;
}

// --- Assumption disclosure (DEP-003b D3) --------------------------------------
//
// The disclosure CONTENT is the product's soul: policy / calculation
// assumption records must render with EVERY key visible — never a raw JSON
// dump, never a dropped key. Formatting only: definition-list rows with the
// key on the left, values right-aligned (numbers tabular), vocabulary lists
// as chips, two-number arrays as ranges.

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "number");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** One assumption value, formatted by its kind (no data transformed). */
function AssumptionValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="font-mono text-xs text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return <span className="font-mono text-sm tabular-nums">{String(value)}</span>;
  }
  if (typeof value === "string") {
    return <span className="break-all font-mono text-xs">{value}</span>;
  }
  if (isNumberArray(value)) {
    return (
      <span className="font-mono text-sm tabular-nums">
        {value.length === 2 ? `${value[0]} – ${value[1]}` : value.join(", ")}
      </span>
    );
  }
  if (isStringArray(value)) {
    return (
      <span className="inline-flex max-w-full flex-wrap justify-end gap-1">
        {value.map((entry) => (
          <Badge key={entry} variant="outline" className="font-mono text-[10px]">
            {entry}
          </Badge>
        ))}
      </span>
    );
  }
  if (isPlainRecord(value)) {
    return <NestedAssumptionRows record={value} />;
  }
  // Unexpected shapes stay fully visible — honest fallback, never dropped.
  return <span className="break-all font-mono text-xs">{JSON.stringify(value)}</span>;
}

/** A nested record of assumptions — same row style, one level deeper. */
function NestedAssumptionRows({ record }: { record: Record<string, unknown> }) {
  return (
    <div className="mt-0.5">
      {Object.entries(record).map(([key, value]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 border-b border-dashed py-1">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{key}</span>
          <span className="min-w-0 text-right">
            <AssumptionValue value={value} />
          </span>
        </div>
      ))}
    </div>
  );
}

function AssumptionRow({ rowKey, value }: { rowKey: string; value: unknown }) {
  if (isPlainRecord(value)) {
    return (
      <div className="min-w-0 py-1 sm:col-span-2">
        <div className="border-b border-dashed pb-0.5">
          <dt className="font-mono text-xs font-medium">{rowKey}</dt>
        </div>
        <dd className="pl-2">
          <NestedAssumptionRows record={value} />
        </dd>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-dashed py-1.5">
      <dt className="shrink-0 font-mono text-xs text-muted-foreground">{rowKey}</dt>
      <dd className="min-w-0 text-right">
        <AssumptionValue value={value} />
      </dd>
    </div>
  );
}

/**
 * A formatted assumption/policy disclosure: every key of the record as a
 * definition-list row (two-column grid), nested records as sub-tables,
 * vocabularies as chips, numbers right-aligned.
 */
export function AssumptionDisclosure({
  assumptions,
  label,
}: {
  assumptions: Record<string, unknown>;
  label: string;
}) {
  const entries = Object.entries(assumptions);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">No assumptions recorded.</p>;
  }
  return (
    <dl aria-label={label} className="grid gap-x-8 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <AssumptionRow key={key} rowKey={key} value={value} />
      ))}
    </dl>
  );
}

export function shortId(value: string | undefined | null): string {
  if (value === undefined || value === null) return "—";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
