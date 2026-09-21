"use client";

// UX-001 — WORKER-CONTRACT-compliant "coming next" state: what is coming, why
// it matters, what the user can do right now — always an explicit, working
// in-app action (SPA navigation via the session store, no routes).

import type { MosView } from "@/components/mos/session-store";
import { useNavigate } from "@/components/mos/home/outcomes";

type ComingNextAction = { label: string; view: MosView };

const DEFAULT_ACTION: ComingNextAction = {
  label: "Open Today / Operations",
  view: { kind: "command-center" },
};

export default function ComingNextPanel({
  title,
  whatIsComing,
  whatYouCanDoNow,
  action = DEFAULT_ACTION,
}: {
  title: string;
  whatIsComing: string;
  whatYouCanDoNow: string;
  action?: ComingNextAction;
}) {
  const navigate = useNavigate();
  return (
    <div className="rounded-lg bg-stone-100/70 p-4">
      <p className="font-medium text-stone-800">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">{whatIsComing}</p>
      <p className="mt-2 text-sm leading-relaxed text-stone-600">{whatYouCanDoNow}</p>
      <button
        type="button"
        onClick={() => navigate(action.view)}
        className="mt-4 inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
      >
        {action.label}
      </button>
    </div>
  );
}
