"use client";

// UX-001 — Outcome-first Home, rendered inside AppShell for
// view.kind === "home" (the new default). The six exact outcome labels are
// the primary surface; internal concepts (missions, operations) appear only
// as contextual drill-downs. Session handling is untouched: this view sits
// behind the existing MosAppInner gate (LoginScreen when there is no token).
// No Next.js routes were added; page.tsx and the router are untouched.

import { START_OUTCOMES, TODAY_OPERATIONS, useNavigate } from "@/components/mos/home/outcomes";
import OutcomeCard from "@/components/mos/home/OutcomeCard";
import MissionsSection from "@/components/mos/home/MissionsSection";

export default function HomeScreen() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-5 pb-12 pt-8 sm:px-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-stone-800 sm:text-3xl">
          What would you like to do?
        </h1>
        <p className="max-w-prose text-base text-stone-600">
          Pick an outcome below — each one leads to something real you can do, never a dead end.
        </p>
      </header>

      <nav aria-label="Outcomes" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {START_OUTCOMES.map((outcome) => (
          <OutcomeCard key={outcome.id} outcome={outcome} />
        ))}
      </nav>

      <MissionsSection />

      <TodayOperationsEntry />
    </div>
  );
}

function TodayOperationsEntry() {
  const navigate = useNavigate();
  return (
    <section aria-label={TODAY_OPERATIONS.label}>
      <button
        type="button"
        onClick={() => navigate(TODAY_OPERATIONS.view)}
        className="flex min-h-[64px] w-full items-center justify-between gap-4 rounded-xl border border-stone-200 bg-white px-5 py-4 text-left transition-colors hover:border-stone-300 hover:bg-stone-100/60 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="min-w-0">
          <span className="block font-medium text-stone-800">{TODAY_OPERATIONS.label}</span>
          <span className="block text-sm text-stone-600">{TODAY_OPERATIONS.blurb}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-stone-400">→</span>
      </button>
    </section>
  );
}
