"use client";

// UX-002 — the Reusable Mission Creation flow (the progressive
// outcome → target → product/source/store context → connections → strategy
// → budget/quota → autonomy → optional human treatment → review flow of
// docs/handoff/EXECUTION-PLAN.md §4). ONE flow, not six wizards: the five
// home outcome cards pre-seed the outcome step's frozen family, and the flow
// is equally reachable with no seed. Every step is truthful — the four
// real-backed steps capture the frozen create contract; the coming-next
// steps render what is actually true with an explicit, working next action.
// The single durable write is the real
//   POST /api/agencies/:agencyId/growth-missions
// performed from the review step (owner|admin; born draft, never
// auto-activated).

import { useMemo, useState } from "react";
import { useNavigate } from "@/components/mos/home/outcomes";
import { useMosSession } from "@/components/mos/session-store";
import { useCreateGrowthMission } from "@/components/mos/hooks";
import type { ObjectiveFamily } from "./families";
import {
  buildCreateBody,
  contextProblems,
  emptyDraft,
  outcomeProblems,
  targetProblems,
  type FieldProblem,
  type MissionDraft,
} from "./flow";
import { OutcomeStep } from "./OutcomeStep";
import { TargetStep, newTargetRow } from "./TargetStep";
import { ContextStep } from "./ContextStep";
import { ConnectionsStep } from "./ConnectionsStep";
import { ComingNextStep, type ComingNextConfig } from "./ComingNextStep";
import { ReviewStep } from "./ReviewStep";

const STEPS = [
  { id: "outcome", title: "Outcome" },
  { id: "target", title: "Target" },
  { id: "context", title: "Product, source or store" },
  { id: "connections", title: "Connections" },
  { id: "strategy", title: "Strategy" },
  { id: "budget", title: "Budget & quota" },
  { id: "autonomy", title: "Autonomy" },
  { id: "human", title: "Human help · optional" },
  { id: "review", title: "Review" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

function problemsFor(step: StepId, draft: MissionDraft): FieldProblem[] {
  switch (step) {
    case "outcome":
      return outcomeProblems(draft);
    case "target":
      return targetProblems(draft);
    case "context":
      return contextProblems(draft);
    default:
      return [];
  }
}

export function MissionCreateScreen({ seedFamily }: { seedFamily: ObjectiveFamily | null }) {
  const agencyId = useMosSession((state) => state.agencyId);
  const [draft, setDraft] = useState<MissionDraft>(() => emptyDraft(seedFamily));
  const [stepIndex, setStepIndex] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const step = STEPS[stepIndex];
  const problems = useMemo(() => problemsFor(step.id, draft), [step.id, draft]);
  const visibleProblems = showErrors ? problems : [];

  const create = useCreateGrowthMission(agencyId ?? "");
  const body = useMemo(() => buildCreateBody(draft), [draft]);

  if (agencyId === null) {
    return <AgencyNeededPanel />;
  }

  const canContinue = problems.length === 0;

  const goNext = () => {
    if (!canContinue) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStepIndex((index) => Math.min(index + 1, STEPS.length - 1));
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const goBack = () => {
    setShowErrors(false);
    setStepIndex((index) => Math.max(index - 1, 0));
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 pb-12 pt-8 sm:px-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-800">Create a mission</h1>
          <ExitFlowLink />
        </div>
        <p className="max-w-prose text-sm text-stone-600">
          A mission is guided work toward one outcome — it keeps moving while you&apos;re away and
          always shows what happens next.
        </p>
      </header>

      <StepRail index={stepIndex} total={STEPS.length} title={step.title} />

      <section
        aria-label={`Step ${stepIndex + 1}: ${step.title}`}
        className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6"
      >
        {step.id === "outcome" ? (
          <OutcomeStep
            draft={draft}
            seeded={seedFamily !== null}
            problems={visibleProblems}
            onObjectiveChange={(objective) => setDraft((d) => ({ ...d, objective }))}
            onFamilyChange={(objectiveFamily) => setDraft((d) => ({ ...d, objectiveFamily }))}
          />
        ) : null}
        {step.id === "target" ? (
          <TargetStep
            draft={draft}
            problems={visibleProblems}
            onAddMetric={() =>
              setDraft((d) => ({ ...d, targetMetrics: [...d.targetMetrics, newTargetRow()] }))
            }
            onRemoveMetric={(key) =>
              setDraft((d) => ({
                ...d,
                targetMetrics: d.targetMetrics.filter((row) => row.key !== key),
              }))
            }
            onUpdateMetric={(key, patch) =>
              setDraft((d) => ({
                ...d,
                targetMetrics: d.targetMetrics.map((row) =>
                  row.key === key ? { ...row, ...patch } : row,
                ),
              }))
            }
          />
        ) : null}
        {step.id === "context" ? (
          <ContextStep
            draft={draft}
            problems={visibleProblems}
            onProductChange={(patch) =>
              setDraft((d) => ({ ...d, productContext: { ...d.productContext, ...patch } }))
            }
            onMarketChange={(patch) =>
              setDraft((d) => ({ ...d, marketContext: { ...d.marketContext, ...patch } }))
            }
          />
        ) : null}
        {step.id === "connections" ? (
          <ConnectionsStep
            agencyId={agencyId}
            selectedClientId={selectedClientId}
            onSelectClient={setSelectedClientId}
          />
        ) : null}
        {step.id === "strategy" ? <ComingNextStep config={STRATEGY_CONFIG} /> : null}
        {step.id === "budget" ? <ComingNextStep config={BUDGET_CONFIG} /> : null}
        {step.id === "autonomy" ? <ComingNextStep config={AUTONOMY_CONFIG} /> : null}
        {step.id === "human" ? <ComingNextStep config={HUMAN_CONFIG} /> : null}
        {step.id === "review" ? (
          <ReviewStep
            draft={draft}
            isPending={create.isPending}
            error={create.error}
            onCreate={() => {
              if (body !== null) create.mutate(body);
            }}
          />
        ) : null}
      </section>

      {step.id !== "review" ? (
        <nav aria-label="Flow navigation" className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={goBack}
            disabled={stepIndex === 0}
            className="inline-flex min-h-[48px] items-center rounded-lg border border-stone-300 bg-white px-5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={create.isPending}
            className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-lg bg-teal-800 px-5 text-sm font-medium text-white transition-colors hover:bg-teal-900 focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-60 sm:flex-none sm:px-8"
          >
            {step.id === "outcome" ? "Set the target" : null}
            {step.id === "target" ? "Add context" : null}
            {step.id === "context" ? "See connections" : null}
            {step.id === "connections" ? "Continue" : null}
            {step.id === "strategy" ? "Continue" : null}
            {step.id === "budget" ? "Continue" : null}
            {step.id === "autonomy" ? "Continue" : null}
            {step.id === "human" ? "Review your mission" : null}
          </button>
        </nav>
      ) : (
        <nav aria-label="Flow navigation">
          <button
            type="button"
            onClick={goBack}
            disabled={create.isPending}
            className="inline-flex min-h-[48px] items-center rounded-lg border border-stone-300 bg-white px-5 text-sm font-medium text-stone-700 transition-colors hover:bg-stone-100 focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
        </nav>
      )}
    </div>
  );
}

function ExitFlowLink() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate({ kind: "home" })}
      className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-700"
      title="Leave the flow — nothing is saved until the mission is created"
    >
      Exit
      <span className="sr-only"> — leaves this flow; the draft is not kept</span>
    </button>
  );
}

function StepRail({ index, total, title }: { index: number; total: number; title: string }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
        Step {index + 1} of {total} · {title}
      </p>
      <div className="flex gap-1">
        {Array.from({ length: total }).map((_, position) => (
          <span
            key={position}
            className={`h-1 flex-1 rounded-full ${
              position < index
                ? "bg-teal-700/60"
                : position === index
                  ? "bg-teal-800"
                  : "bg-stone-200"
            }`}
          />
        ))}
      </div>
      <span className="sr-only" aria-hidden={false}>
        Step {index + 1} of {total}: {title}
      </span>
    </div>
  );
}

/** The blocked state when no agency is selected (blocker / evidence /
 *  required action / resume path — the WORKER-CONTRACT shape). */
function AgencyNeededPanel() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pb-12 pt-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-stone-800">Create a mission</h1>
      <div className="rounded-xl border border-stone-200 bg-white p-6">
        <p className="font-medium text-stone-800">An agency is needed before a mission can be created</p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Missions are kept inside an agency — that&apos;s where they live and who they act for —
          and none is selected for this session yet.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Choose your agency from the selector (in the sidebar, or the top bar on mobile). If you&apos;re
          a platform administrator, you can also address an agency by its identifier from
          Administration.
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-600">
          Once an agency is selected, return to Home and pick any outcome — this flow opens right
          away, and nothing about the mission is created until you finish it.
        </p>
      </div>
    </div>
  );
}

// --- The truthful coming-next step texts (no fabricated capability) -----------

const STRATEGY_CONFIG: ComingNextConfig = {
  title: "Strategy is composed for you",
  whatIsMissing:
    "How this mission pursues your outcome — which steps it takes, in what order, and through which channels — isn't a form you fill in here. The system plans it, step by step, once the mission is running.",
  whyItMatters:
    "A strategy fixed at creation time would go stale as conditions change. Planning per step means every move is chosen against what's true at that moment — and recorded, so you can review the reasoning.",
  whatToKnowNow:
    "Nothing about strategy is stored on this step. Your objective, targets and context from the earlier steps are exactly what the system plans from.",
};

const BUDGET_CONFIG: ComingNextConfig = {
  title: "Budgets and spending limits arrive in a planned update",
  whatIsMissing:
    "A guard that stops a mission when the budget or quota allowed to it is exhausted. Missions can be created today without one.",
  whyItMatters:
    "Spending limits protect you from runaway cost. The mission model already knows how to end a mission honestly as 'budget or quota exhausted' — the creation-time guard is the part that arrives later.",
  whatToKnowNow:
    "This mission is created as a draft and runs nothing until it's deliberately activated — so nothing can spend while it's a draft. No budget field is stored from this step.",
};

const AUTONOMY_CONFIG: ComingNextConfig = {
  title: "Autonomy is decided per step, not set here",
  whatIsMissing:
    "There's no dial for how much the system may do on its own — that isn't a creation-time setting in this platform.",
  whyItMatters:
    "The right amount of independence changes with every step. Instead of a fixed setting, the system decides per step what it can safely do itself and when it needs you, under the policies your agency sets.",
  whatToKnowNow:
    "Every step the system takes is recorded with its reasons. Nothing about autonomy is stored on this step.",
};

const HUMAN_CONFIG: ComingNextConfig = {
  title: "Human help is optional — and never required",
  whatIsMissing:
    "An optional arm where human creators or reviewers contribute work alongside the system's own work. It isn't added during creation.",
  whyItMatters:
    "Human work can lift results, and the mission must never depend on it: if no human is available, the mission keeps going, replans, pauses or stops truthfully — human absence is never treated as a failure.",
  whatToKnowNow:
    "This mission is created without any human treatment, and works without one. Adding human help later is a deliberate choice you'd make when working with the mission — never a requirement.",
};
