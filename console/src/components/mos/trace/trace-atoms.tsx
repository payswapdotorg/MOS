"use client";

// UX-004 — the Scientific Trace's shared presentation atoms.
//
// THE EPISTEMIC DISTINCTION IS THE WORK ITEM: everything the trace renders is
// marked with one of three registers — OBSERVED FACT, DERIVED CLAIM /
// HYPOTHESIS, CAUSAL INTERPRETATION — and the registers differ by MORE than
// color. Each carries its own icon, label, border style and record structure,
// so the distinction survives color-blindness, greyscale and a squinting
// operator alike:
//
//   OBSERVED FACT      solid teal border  · Eye icon    · "Observed fact"
//                      structure: provenance + quality + confidence always
//                      visible (what a system saw, and how it was recorded)
//   DERIVED CLAIM /    DASHED amber border · FlaskConical icon ·
//   HYPOTHESIS         "Hypothesis — declared, unproven" / "Derived claim"
//                      structure: method + version + window always disclosed
//                      (what a method computed or a human proposed — never
//                      presented as something anyone observed)
//   CAUSAL             THICK-LEFT graphite border · PenLine icon ·
//   INTERPRETATION     "Interpretation — human conclusion"
//                      structure: basis + disposition always disclosed
//                      (what a person concluded from the above)
//
// A legend (RegisterLegend) explains the three registers in plain language
// ONCE, collapsibly, at the head of the trace — never repeated per section.
//
// Presentation ONLY — zero authority state, no fabricated data, no raw JSON.

import * as React from "react";
import { ChevronDown, Eye, FlaskConical, PenLine } from "lucide-react";

// --- The register system ------------------------------------------------------------

export type EpistemicRegister = "observed" | "derived" | "interpretation";

type RegisterMeta = {
  /** The plain-language name shown in the badge and legend. */
  name: string;
  /** The icon component (a fixed icon per register — recognition anchor). */
  icon: React.ComponentType<{ className?: string }>;
  /** The badge chip treatment. */
  badgeClass: string;
  /** The record frame border treatment (structure — not just color). */
  frameClass: string;
  /** The frame's header strip treatment. */
  frameHeaderClass: string;
};

export const EPISTEMIC_REGISTERS: Record<EpistemicRegister, RegisterMeta> = {
  observed: {
    name: "Observed fact",
    icon: Eye,
    badgeClass: "border-teal-800/25 bg-teal-50 text-teal-900",
    frameClass: "border border-solid border-teal-800/25 bg-white",
    frameHeaderClass: "border-b border-teal-800/15 bg-teal-50/70 px-4 py-2.5",
  },
  derived: {
    name: "Derived claim / hypothesis",
    icon: FlaskConical,
    badgeClass: "border-amber-700/30 bg-amber-50 text-amber-900",
    frameClass: "border border-dashed border-amber-700/40 bg-white",
    frameHeaderClass: "border-b border-amber-700/15 bg-amber-50/60 px-4 py-2.5",
  },
  interpretation: {
    name: "Causal interpretation",
    icon: PenLine,
    badgeClass: "border-stone-400 bg-white text-stone-800",
    frameClass: "border border-solid border-stone-300 border-l-4 border-l-stone-500 bg-white",
    frameHeaderClass: "border-b border-stone-200 bg-stone-50/70 px-4 py-2.5",
  },
};

/**
 * The register badge — the mark every register-marked record carries. The
 * visible label can narrow the register ("Hypothesis — declared, unproven",
 * "Derived claim", …) while the icon + treatment stay fixed per register.
 */
export function RegisterBadge({
  register,
  label,
}: {
  register: EpistemicRegister;
  /** Defaults to the register's plain-language name. */
  label?: string;
}) {
  const meta = EPISTEMIC_REGISTERS[register];
  const Icon = meta.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${meta.badgeClass}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label ?? meta.name}
    </span>
  );
}

/**
 * The register frame — the structural treatment around ONE register-marked
 * record. The header strip carries the badge plus the record's own meta
 * (id, timestamps); the register-specific disclosure block (provenance for
 * observed facts, method/version/window for derived claims, basis/disposition
 * for interpretations) is rendered by the caller through `disclosure`.
 */
export function RegisterFrame({
  register,
  label,
  meta,
  disclosure,
  children,
}: {
  register: EpistemicRegister;
  label?: string;
  /** The record's own meta line (short id, observed/recorded time, status). */
  meta?: React.ReactNode;
  /** The register-structure disclosure block (always visible when given). */
  disclosure?: React.ReactNode;
  children: React.ReactNode;
}) {
  const frameMeta = EPISTEMIC_REGISTERS[register];
  return (
    <div className={`overflow-hidden rounded-xl ${frameMeta.frameClass}`}>
      <div className={`flex min-w-0 flex-wrap items-center gap-2 ${frameMeta.frameHeaderClass}`}>
        <RegisterBadge register={register} label={label} />
        {meta ? <span className="min-w-0 flex-1 text-xs text-stone-500">{meta}</span> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2.5 px-4 py-3.5">
        {children}
        {disclosure ? (
          <div className="border-t border-dashed border-stone-200 pt-2.5">{disclosure}</div>
        ) : null}
      </div>
    </div>
  );
}

// --- The legend (once per trace, collapsible) ----------------------------------------

/**
 * The plain-language legend of the three registers — shown ONCE at the head
 * of the trace, collapsible so it never crowds the chain. Default open: a
 * first-time operator must be able to read the distinction before the
 * records that depend on it.
 */
export function RegisterLegend() {
  const [open, setOpen] = React.useState(true);
  return (
    <section
      aria-labelledby="trace-register-legend-heading"
      className="overflow-hidden rounded-xl border border-stone-200 bg-stone-50/70"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls="trace-register-legend-content"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-[56px] w-full items-center justify-between gap-4 px-5 py-3.5 text-left transition-colors hover:bg-stone-100/60 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0 flex-1">
          <span id="trace-register-legend-heading" className="block text-sm font-medium text-stone-800">
            How to read this trace — three kinds of content
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">
            Everything below is marked as an observed fact, a derived claim, or a human
            interpretation.
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`size-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id="trace-register-legend-content" className="border-t border-stone-200 bg-white px-5 py-4">
          <ul className="flex flex-col gap-3">
            <li className="flex flex-col gap-1">
              <RegisterBadge register="observed" />
              <p className="text-sm leading-relaxed text-stone-600">
                What a system actually saw — evidence records, metric observations, publication
                ledger rows. Each one shows its source, quality and confidence. Nobody computed
                these; they were recorded.
              </p>
            </li>
            <li className="flex flex-col gap-1">
              <RegisterBadge register="derived" />
              <p className="text-sm leading-relaxed text-stone-600">
                What a method computed or a person proposed — hypotheses being tested, experiment
                analyses, allocation recommendations. Each one discloses its method, version and
                window. These are claims, not observations: they may be wrong, and the dashed
                border means they are still awaiting ground truth.
              </p>
            </li>
            <li className="flex flex-col gap-1">
              <RegisterBadge register="interpretation" />
              <p className="text-sm leading-relaxed text-stone-600">
                What a human concluded — decisions and learnings. Each one shows the basis it was
                drawn from and the disposition it received. An interpretation is a judgement, not
                a measurement; treat it as the person&apos;s best reading, not as a fact.
              </p>
            </li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// --- The chain section (one numbered link of the ten) ---------------------------------

/**
 * One link of the ten-link chain: a numbered, collapsible section whose
 * header carries the link name, a plain-language title, the register(s) that
 * live inside it and a one-line live summary (server-derived, never
 * fabricated). Supports UNCONTROLLED use (defaultOpen) and CONTROLLED use
 * (open + onOpenChange) — the controlled form powers the trace's real
 * cross-links (a hypothesis row opening its experiment, an experiment opening
 * its analysis). Touch-friendly (min 64px header), aria-wired.
 */
export function TraceSection({
  id,
  index,
  link,
  title,
  registers,
  summary,
  summaryTone = "neutral",
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange,
  children,
}: {
  id: string;
  /** The link's position in the chain (1–10) — shown as the chain marker. */
  index: number;
  /** The chain-link name (Question, Research, …). */
  link: string;
  /** The plain-language question this link answers. */
  title: string;
  /** The register(s) this link's records carry (chip row on the header). */
  registers?: EpistemicRegister[];
  summary: string;
  summaryTone?: "neutral" | "healthy" | "warning" | "failure";
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (value: boolean) => {
    setUncontrolledOpen(value);
    onOpenChange?.(value);
  };
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
      id={`trace-section-${id}`}
      aria-labelledby={`trace-${id}-heading`}
      className="overflow-hidden rounded-xl border border-stone-200 bg-white"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`trace-${id}-content`}
        onClick={() => setOpen(!open)}
        className="flex min-h-[64px] w-full items-start justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-stone-50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="flex min-w-0 flex-1 items-start gap-3.5">
          <span
            aria-hidden="true"
            className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-stone-300 bg-stone-50 font-mono text-xs font-medium text-stone-600"
          >
            {index}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span id={`trace-${id}-heading`} className="text-[11px] font-medium uppercase tracking-wide text-stone-400">
                {link}
              </span>
              <span className="font-medium text-stone-800">{title}</span>
            </span>
            <span className={`mt-1 block text-xs leading-relaxed ${summaryToneClass}`}>{summary}</span>
            {registers && registers.length > 0 ? (
              <span className="mt-1.5 flex flex-wrap gap-1.5">
                {registers.map((register) => (
                  <RegisterBadge key={register} register={register} />
                ))}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className={`mt-1 size-5 shrink-0 text-stone-400 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div id={`trace-${id}-content`} className="border-t border-stone-100 px-5 py-5">
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** The chain connector between two adjacent links (the top-to-bottom reading). */
export function ChainConnector() {
  return (
    <div aria-hidden="true" className="flex justify-center py-0.5">
      <span className="h-4 w-px bg-stone-300" />
    </div>
  );
}

// --- The truthful coming state (a link whose surface is not built yet) ------------------

/**
 * The truthful coming-state card for links whose platform surface does not
 * exist yet (Question and Research while the MKT-062 research module is in
 * flight): what WILL live here, why it matters, and the dependency disclosed
 * plainly. NEVER a fabricated preview of data that does not exist.
 */
export function ComingStateCard({
  missing,
  why,
  coming,
  dependency,
}: {
  missing: string;
  why: string;
  coming: string;
  dependency: string;
}) {
  return (
    <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
        Coming — not built yet
      </p>
      <p className="mt-1.5 text-sm font-medium leading-relaxed text-stone-700">{missing}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{why}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{coming}</p>
      <p className="mt-3 border-t border-dashed border-stone-300 pt-2.5 text-xs leading-relaxed text-stone-500">
        {dependency}
      </p>
    </div>
  );
}

/** A short reference id, formatted for inline cross-links (never raw). */
export function shortRef(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  return value.length > 10 ? `${value.slice(0, 10)}…` : value;
}
