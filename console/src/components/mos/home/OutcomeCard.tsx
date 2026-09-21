"use client";

// UX-001 — one outcome entry. View destinations navigate through the session
// store; "soon" destinations expand a contract-compliant coming-next panel in
// place (progressive disclosure — no dead links, no raw JSON, no internal
// module names).

import { useState } from "react";
import ComingNextPanel from "@/components/mos/home/ComingNextPanel";
import { useNavigate, type Outcome } from "@/components/mos/home/outcomes";

export default function OutcomeCard({ outcome }: { outcome: Outcome }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const dest = outcome.destination;

  if (dest.kind === "view") {
    return (
      <button
        type="button"
        onClick={() => navigate(dest.view)}
        className="group flex min-h-[112px] flex-col justify-between rounded-xl border border-stone-200 bg-white p-5 text-left transition-colors hover:border-teal-700/40 hover:bg-stone-100/50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="text-lg font-medium text-stone-800">{outcome.label}</span>
        <span className="mt-3 flex items-end justify-between gap-3">
          <span className="text-sm text-stone-600">{outcome.blurb}</span>
          <span aria-hidden="true" className="shrink-0 text-stone-400 transition-transform group-hover:translate-x-0.5">→</span>
        </span>
      </button>
    );
  }

  return (
    <div className={`overflow-hidden rounded-xl border bg-white transition-colors ${open ? "border-stone-300" : "border-stone-200"}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`outcome-next-${outcome.id}`}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[112px] w-full flex-col justify-between p-5 text-left transition-colors hover:bg-stone-100/50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        <span className="text-lg font-medium text-stone-800">{outcome.label}</span>
        <span className="mt-3 flex items-end justify-between gap-3">
          <span className="text-sm text-stone-600">{outcome.blurb}</span>
          <span aria-hidden="true" className="shrink-0 text-stone-400">{open ? "↑" : "→"}</span>
        </span>
      </button>
      {open ? (
        <div id={`outcome-next-${outcome.id}`} className="border-t border-stone-100 p-5 pt-4">
          <ComingNextPanel
            title={dest.title}
            whatIsComing={dest.whatIsComing}
            whatYouCanDoNow={dest.whatYouCanDoNow}
          />
        </div>
      ) : null}
    </div>
  );
}
