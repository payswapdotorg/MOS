"use client";

// UX-002 — the review step: everything the mission WILL be, composed from
// the draft, exactly as it will be sent (only caller-declarable fields).
// The create button performs the single real write:
//   POST /api/agencies/:agencyId/growth-missions
// born draft, version 1, first history event — never auto-activated.

import { FAMILY_PRESENTATION } from "./families";
import { buildCreateBody, type MissionDraft } from "./flow";
import { MosApiError } from "@/lib/mos-api";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-stone-100 pt-4 first:border-t-0 first:pt-0">
      <h4 className="text-xs font-medium uppercase tracking-wide text-stone-500">{title}</h4>
      {children}
    </section>
  );
}

export function ReviewStep({
  draft,
  isPending,
  error,
  onCreate,
}: {
  draft: MissionDraft;
  isPending: boolean;
  error: unknown;
  onCreate: () => void;
}) {
  const body = buildCreateBody(draft);
  const family = draft.objectiveFamily;
  const metrics = draft.targetMetrics.filter((row) => row.metric.trim() !== "");
  const hasProduct =
    body?.productContext !== undefined && Object.keys(body.productContext).length > 0;
  const hasMarket =
    body?.marketContext !== undefined && Object.keys(body.marketContext).length > 0;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Review your mission</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-600">
          This is exactly what will be created — your words, kept as you wrote them.
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-5">
        <Section title="Your objective">
          <blockquote className="rounded-lg bg-stone-50/80 p-4 text-sm leading-relaxed text-stone-800">
            &ldquo;{draft.objective.trim()}&rdquo;
          </blockquote>
          {family !== null ? (
            <p className="text-xs text-stone-500">
              Kind of outcome: {FAMILY_PRESENTATION[family].label}
            </p>
          ) : null}
        </Section>

        <Section title="Targets">
          {metrics.length === 0 ? (
            <p className="text-sm leading-relaxed text-stone-600">
              None yet — the mission starts as a draft, and targets can be recorded in a later
              version.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {metrics.map((row) => (
                <li key={row.key} className="text-sm text-stone-700">
                  <span className="font-medium text-stone-800">{row.metric.trim()}</span>{" "}
                  <span className="tabular-nums">
                    {row.comparator} {row.targetValueRaw.trim()}
                    {row.unit.trim() === "" ? "" : ` ${row.unit.trim()}`}
                  </span>
                  <span className="text-stone-500">
                    {row.intermediate ? " · intermediate" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(hasProduct || hasMarket) && (
          <Section title="Context you added">
            <div className="flex flex-col gap-1.5 text-sm text-stone-700">
              {body?.productContext?.name ? <div>Product: {body.productContext.name}</div> : null}
              {body?.productContext?.url ? <div>Link: {body.productContext.url}</div> : null}
              {body?.productContext?.summary ? (
                <div>What it is: {body.productContext.summary}</div>
              ) : null}
              {body?.marketContext?.audience ? (
                <div>Audience: {body.marketContext.audience}</div>
              ) : null}
              {body?.marketContext?.geography ? (
                <div>Geography: {body.marketContext.geography}</div>
              ) : null}
              {body?.marketContext?.summary ? (
                <div>Market notes: {body.marketContext.summary}</div>
              ) : null}
            </div>
          </Section>
        )}

        <Section title="How it starts">
          <p className="text-sm leading-relaxed text-stone-600">
            The mission is created as a <span className="font-medium text-stone-800">draft</span>{" "}
            — it doesn&apos;t run anything yet. No strategy, budget, autonomy or human-help
            settings are stored at creation; the system composes those itself once the mission is
            activated, and every decision it makes is recorded for you to review.
          </p>
          <p className="text-sm leading-relaxed text-stone-600">
            Activation is a deliberate later step that always asks for a reason — this flow never
            activates anything for you.
          </p>
        </Section>
      </div>

      {error instanceof MosApiError ? (
        <div role="alert" className="rounded-xl border border-red-800/20 bg-red-50 p-4">
          <p className="font-medium text-red-900">
            The server refused to create this mission.
          </p>
          <p className="mt-1 break-words text-sm text-red-900/90">
            {error.status} · {error.code} — {error.message}
          </p>
          {error.details.length > 0 ? (
            <ul className="mt-1 list-disc pl-5 text-xs text-red-900/80">
              {error.details.map((detail) => (
                <li key={detail} className="break-words">
                  {detail}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-2 text-sm leading-relaxed text-red-900/80">
            Nothing was created — your draft is still here, so you can adjust and try again.
          </p>
        </div>
      ) : error !== null && error !== undefined ? (
        <div role="alert" className="rounded-xl border border-red-800/20 bg-red-50 p-4">
          <p className="font-medium text-red-900">The mission couldn&apos;t be created just now.</p>
          <p className="mt-1 break-words text-sm text-red-900/90">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-red-900/80">
            Your draft is still here — you can try again.
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={onCreate}
        disabled={isPending || body === null}
        className="inline-flex min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-teal-800 px-5 text-sm font-medium text-white transition-colors hover:bg-teal-900 focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
      >
        {isPending ? (
          <>
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
            />
            Creating your mission…
          </>
        ) : (
          "Create mission"
        )}
      </button>
    </div>
  );
}
