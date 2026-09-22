"use client";

// UX-002 — the honest completion state. After a successful 201 the flow
// navigates here and reads the mission back LIVE (GET /api/growth-missions/
// :missionId — the composed honest read-back), so what is shown is what the
// server holds, not a client echo. It states plainly: born `draft`, version
// 1, first history event; activation is a deliberate later step that always
// requires a reason (never done by this flow); the mission now appears
// under "Continue a mission" on Home.

import { FAMILY_PRESENTATION, isObjectiveFamily } from "./families";
import { useNavigate } from "@/components/mos/home/outcomes";
import { useMosQuery } from "@/components/mos/hooks";
import type { GrowthMissionDetailView } from "@/lib/mos-api";
import { TODAY_OPERATIONS } from "@/components/mos/home/outcomes";

function shortMissionId(id: string): string {
  return id.length <= 10 ? id : `${id.slice(0, 8)}…`;
}

export function MissionCreatedScreen({ missionId }: { missionId: string }) {
  const navigate = useNavigate();
  const query = useMosQuery<GrowthMissionDetailView>(
    ["growth-mission", missionId],
    `/api/growth-missions/${missionId}`,
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 pb-12 pt-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-800">
            Your mission is created
          </h1>
          {query.data?.mission.status ? (
            <span className="rounded-full border border-stone-300 bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700">
              {query.data.mission.status.replace(/_/g, " ")}
            </span>
          ) : null}
        </div>
        <p className="max-w-prose text-sm leading-relaxed text-stone-600">
          It is kept as a draft and runs nothing yet — that&apos;s deliberate. Activating a
          mission is a separate, deliberate step that always asks for a reason, and this flow
          never does it for you.
        </p>
      </header>

      {query.isPending ? (
        <div className="flex flex-col gap-3 rounded-xl border border-stone-200 bg-white p-6" aria-busy="true">
          <div className="h-4 w-3/4 animate-pulse rounded bg-stone-200/70" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-stone-200/70" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-stone-200/70" />
        </div>
      ) : query.isError ? (
        <div className="rounded-xl border border-amber-700/20 bg-amber-50 p-5">
          <p className="font-medium text-amber-900">The mission was created, but its details couldn&apos;t be loaded just now.</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-900/80">
            You can try again below, or go back to Home — the mission is already listed under
            &ldquo;Continue a mission&rdquo; there.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-amber-700/30 bg-white px-4 text-sm font-medium text-amber-900 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => navigate({ kind: "home" })}
              className="inline-flex min-h-[44px] items-center rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700"
            >
              Back to Home
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-5 rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
          <section className="flex flex-col gap-2 border-t border-stone-100 pt-4 first:border-t-0 first:pt-0">
            <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">What was created</h2>
            <blockquote className="rounded-lg bg-stone-50/80 p-4 text-sm leading-relaxed text-stone-800">
              &ldquo;{query.data?.currentVersion.objective}&rdquo;
            </blockquote>
            <p className="text-xs text-stone-500">
              Mission {shortMissionId(query.data?.mission.missionId ?? missionId)} · version{" "}
              {query.data?.mission.currentVersionSeq ?? 1} ·{" "}
              {isObjectiveFamily(query.data?.currentVersion.objectiveFamily ?? "")
                ? FAMILY_PRESENTATION[query.data.currentVersion.objectiveFamily].label
                : "outcome recorded"}
            </p>
          </section>

          <section className="flex flex-col gap-2 border-t border-stone-100 pt-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">Targets</h2>
            {(query.data?.currentVersion.targetMetrics ?? []).length === 0 ? (
              <p className="text-sm leading-relaxed text-stone-600">
                None were declared — that&apos;s fine for a draft. Targets can be recorded in a
                later version of the mission.
              </p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {(query.data?.currentVersion.targetMetrics ?? []).map((metric, index) => (
                  <li key={`${metric.metric}-${index}`} className="text-sm text-stone-700">
                    <span className="font-medium text-stone-800">{metric.metric}</span>{" "}
                    <span className="tabular-nums">
                      {metric.comparator} {metric.targetValue}
                      {metric.unit ? ` ${metric.unit}` : ""}
                    </span>
                    {metric.intermediate ? <span className="text-stone-500"> · intermediate</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2 border-t border-stone-100 pt-4">
            <h2 className="text-xs font-medium uppercase tracking-wide text-stone-500">What happens next</h2>
            <ul className="flex flex-col gap-1.5 text-sm leading-relaxed text-stone-600">
              <li>
                The mission is listed on your Home screen under{" "}
                <span className="font-medium text-stone-800">Continue a mission</span> — that list
                is live, read from the server every time.
              </li>
              <li>
                {Array.isArray(query.data?.history) && (query.data?.history.length ?? 0) > 0
                  ? `${query.data?.history.length} recorded update${
                      (query.data?.history.length ?? 0) === 1 ? "" : "s"
                    } so far — every change to the mission is recorded like that, with actor and reason.`
                  : "Every change to the mission is recorded with actor and reason."}
              </li>
              <li>
                Working with a mission step by step — reviewing its progress, mapping goals,
                activating or pausing it — arrives with the mission workspace, a planned update.
              </li>
            </ul>
          </section>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => navigate({ kind: "home" })}
          className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-lg bg-teal-800 px-5 text-sm font-medium text-white transition-colors hover:bg-teal-900 focus-visible:ring-2 focus-visible:ring-teal-700 sm:flex-none sm:px-8"
        >
          Back to Home
        </button>
        <button
          type="button"
          onClick={() => navigate(TODAY_OPERATIONS.view)}
          className="inline-flex min-h-[48px] flex-1 items-center justify-center rounded-lg border border-teal-800/25 bg-white px-5 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700 sm:flex-none"
        >
          {TODAY_OPERATIONS.label}
        </button>
      </div>
    </div>
  );
}
