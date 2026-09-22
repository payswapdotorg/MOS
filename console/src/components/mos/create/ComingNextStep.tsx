"use client";

// UX-002 — the truthful coming-next/optional steps of the flow: strategy,
// budget/quota, autonomy and optional human treatment. The UX-002
// discipline: NO DEAD CONTROLS and NO fabricated capability — none of these
// is a creation-time client setting in the platform, so this step renders
// what is true (what is missing, why it matters, what to do next) and always
// offers the explicit, working in-flow action (Continue). The texts are
// configured per step in the screen; this component only renders honestly.

import type { ReactNode } from "react";

export type ComingNextConfig = {
  title: string;
  whatIsMissing: string;
  whyItMatters: string;
  whatToKnowNow: string;
  /** An optional second honest action (e.g. open Today / Operations). */
  secondaryAction?: ReactNode;
};

export function ComingNextStep({ config }: { config: ComingNextConfig }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-xl border border-stone-200 bg-white p-5 sm:p-6">
        <h3 className="text-base font-medium text-stone-800">{config.title}</h3>
        <dl className="mt-4 flex flex-col gap-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">
              What&apos;s involved
            </dt>
            <dd className="mt-1 text-sm leading-relaxed text-stone-700">{config.whatIsMissing}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">
              Why it matters
            </dt>
            <dd className="mt-1 text-sm leading-relaxed text-stone-700">{config.whyItMatters}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">
              What&apos;s true right now
            </dt>
            <dd className="mt-1 text-sm leading-relaxed text-stone-700">
              {config.whatToKnowNow}
            </dd>
          </div>
        </dl>
        {config.secondaryAction ? <div className="mt-5">{config.secondaryAction}</div> : null}
      </div>
      <p className="text-sm leading-relaxed text-stone-600">
        Nothing is chosen or stored on this step — when you continue, the mission is created with
        exactly what you declared on the earlier steps.
      </p>
    </div>
  );
}
