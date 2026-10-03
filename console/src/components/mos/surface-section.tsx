"use client";

// UX-010 — the progressive-disclosure hardening atoms, shared by the console
// surfaces (Connections, Content/Rights, Health, Treatments and the client
// workspace). Two presentation-only primitives:
//
//   SurfaceSection   a calm, collapsed-by-default section whose header row
//                    carries a small product label, the section title and a
//                    ONE-LINE LIVE summary (server-derived, never fabricated)
//                    — the first view of every surface is the stack of these
//                    summary rows, never a wall of dense cards. The records,
//                    forms and diagnostics render only on expand (the
//                    UX-003 WorkspaceSection discipline, with optional
//                    controlled open for the surface-level primary action).
//
//   SourcesDisclosure  the honest composition + route disclosure, demoted to
//                    a collapsed footer affordance — the route names and the
//                    authority vocabulary stay fully visible, but they live
//                    in the disclosure layer, never on the first screen.
//
// Zero authority state, no fabricated data, no raw JSON.

import * as React from "react";
import { ChevronDown } from "lucide-react";

type SummaryTone = "neutral" | "healthy" | "warning" | "failure";

const SUMMARY_TONE_CLASSES: Record<SummaryTone, string> = {
  healthy: "text-teal-900",
  warning: "text-amber-900",
  failure: "text-red-900",
  neutral: "text-stone-500",
};

/**
 * One collapsible surface section: the collapsed row is the summary level
 * (label + title + the live one-line summary); the expanded body is the
 * operating level (records, actions, diagnostics — exactly what the section
 * rendered before the hardening, truthful states untouched). Touch-friendly
 * (min 64px header), keyboard accessible, aria-wired, subtle transitions.
 */
export function SurfaceSection({
  id,
  label,
  title,
  summary,
  summaryTone = "neutral",
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  id: string;
  /** A small product-language label (e.g. "Channels", "Research"). */
  label: string;
  /** The plain-language section title. */
  title: string;
  /** One-line LIVE summary shown on the header row (loading/empty/error
   *  states included — never fabricated, never stale). */
  summary: string;
  summaryTone?: SummaryTone;
  defaultOpen?: boolean;
  /** Controlled open (optional — the surface-level primary action uses it
   *   to expand the section it operates). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const controlsId = `${id}-content`;
  return (
    <section
      id={`section-${id}`}
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-xl border border-stone-200 bg-white"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => {
          const next = !open;
          if (!isControlled) setUncontrolledOpen(next);
          onOpenChange?.(next);
        }}
        className="flex min-h-[64px] w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-stone-400">
            {label}
          </span>
          <span id={`${id}-heading`} className="block font-medium text-stone-800">
            {title}
          </span>
          <span
            className={`mt-1 block text-xs leading-relaxed ${SUMMARY_TONE_CLASSES[summaryTone]}`}
          >
            {summary}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`mt-1 size-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={controlsId} className="border-t border-stone-100 px-5 py-5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The collapsed sources-and-composition footer: the honest note about what
 * the surface composes and the exact API routes it reads — fully visible on
 * demand, never the first screen's vocabulary (the UX-010 jargon move).
 */
export function SourcesDisclosure({
  id = "sources",
  label = "Sources & composition",
  children,
}: {
  id?: string;
  label?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const controlsId = `${id}-content`;
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/60">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors hover:bg-stone-100/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-700"
      >
        <span className="text-xs font-medium text-stone-500">{label}</span>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div
          id={controlsId}
          className="border-t border-stone-200/70 px-5 py-4 text-sm leading-relaxed text-stone-600"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
