"use client";

// UX-002 — step 2 of the flow: the TARGET(S). Real, persisted inputs: the
// targetMetrics array of the frozen create contract (metric 1..100,
// comparator >=|>|<=|<|==, numeric targetValue, optional unit ≤50 and
// description ≤500, and the explicit intermediate flag). Optional — a
// mission can be created as a draft with no targets and refined later in a
// new recorded version. No suggested metrics are invented.

import { Minus, Plus } from "lucide-react";
import { COMPARATORS, LIMITS, metricRowProblem, type Comparator, type FieldProblem, type MissionDraft, type TargetMetricDraft } from "./flow";

let rowKeyCounter = 0;
function nextRowKey(): string {
  rowKeyCounter += 1;
  return `metric-row-${Date.now()}-${rowKeyCounter}`;
}

export function newTargetRow(): TargetMetricDraft {
  return {
    key: nextRowKey(),
    metric: "",
    comparator: ">=",
    targetValueRaw: "",
    unit: "",
    description: "",
    intermediate: false,
  };
}

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:border-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/30";

export function TargetStep({
  draft,
  problems,
  onAddMetric,
  onRemoveMetric,
  onUpdateMetric,
}: {
  draft: MissionDraft;
  problems: FieldProblem[];
  onAddMetric: () => void;
  onRemoveMetric: (key: string) => void;
  onUpdateMetric: (key: string, patch: Partial<TargetMetricDraft>) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="text-sm font-medium text-stone-800">Give this mission concrete targets</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-600">
          A target says what &ldquo;done&rdquo; looks like in numbers — for example a number of people,
          sign-ups, or sales to reach. Targets are optional: you can create this mission as a draft
          now and add them later.
        </p>
      </div>

      {draft.targetMetrics.length === 0 ? (
        <div className="rounded-xl border border-dashed border-stone-300 bg-stone-50/60 p-5">
          <p className="text-sm text-stone-700">No targets yet — that&apos;s fine for a draft.</p>
          <p className="mt-1 text-sm leading-relaxed text-stone-600">
            If you already know what success looks like, add a target below. If not, the mission will
            still be created and you can record targets in a later version.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {draft.targetMetrics.map((row, index) => {
            const rowProblem = problems.find((problem) => problem.field === `metric-${row.key}`);
            return (
              <li
                key={row.key}
                className="rounded-xl border border-stone-200 bg-white p-4"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                    Target {index + 1}
                    {row.intermediate ? " · intermediate" : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => onRemoveMetric(row.key)}
                    className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-xs font-medium text-stone-600 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-900 focus-visible:ring-2 focus-visible:ring-teal-700"
                    aria-label={`Remove target ${index + 1}`}
                  >
                    <Minus className="size-3.5" aria-hidden="true" /> Remove
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-6">
                  <div className="sm:col-span-3">
                    <label
                      htmlFor={`metric-name-${row.key}`}
                      className="mb-1 block text-xs font-medium text-stone-700"
                    >
                      What you measure
                    </label>
                    <input
                      id={`metric-name-${row.key}`}
                      type="text"
                      value={row.metric}
                      maxLength={LIMITS.metricNameMax}
                      onChange={(event) => onUpdateMetric(row.key, { metric: event.target.value })}
                      placeholder="e.g. newsletter subscribers"
                      className={inputClass}
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <label
                      htmlFor={`metric-comparator-${row.key}`}
                      className="mb-1 block text-xs font-medium text-stone-700"
                    >
                      Test
                    </label>
                    <select
                      id={`metric-comparator-${row.key}`}
                      value={row.comparator}
                      onChange={(event) =>
                        onUpdateMetric(row.key, {
                          comparator: event.target.value as Comparator,
                        })
                      }
                      className={inputClass}
                    >
                      {COMPARATORS.map((comparator) => (
                        <option key={comparator} value={comparator}>
                          {comparator}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label
                      htmlFor={`metric-value-${row.key}`}
                      className="mb-1 block text-xs font-medium text-stone-700"
                    >
                      Goal value
                    </label>
                    <input
                      id={`metric-value-${row.key}`}
                      type="number"
                      inputMode="decimal"
                      step="any"
                      value={row.targetValueRaw}
                      onChange={(event) => onUpdateMetric(row.key, { targetValueRaw: event.target.value })}
                      placeholder="e.g. 1000"
                      aria-invalid={rowProblem !== undefined}
                      className={inputClass}
                    />
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`metric-unit-${row.key}`}
                      className="mb-1 block text-xs font-medium text-stone-700"
                    >
                      Unit <span className="font-normal text-stone-400">(optional)</span>
                    </label>
                    <input
                      id={`metric-unit-${row.key}`}
                      type="text"
                      value={row.unit}
                      maxLength={LIMITS.unitMax}
                      onChange={(event) => onUpdateMetric(row.key, { unit: event.target.value })}
                      placeholder="e.g. people, %, USD"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`metric-description-${row.key}`}
                      className="mb-1 block text-xs font-medium text-stone-700"
                    >
                      Short description <span className="font-normal text-stone-400">(optional)</span>
                    </label>
                    <input
                      id={`metric-description-${row.key}`}
                      type="text"
                      value={row.description}
                      maxLength={LIMITS.descriptionMax}
                      onChange={(event) => onUpdateMetric(row.key, { description: event.target.value })}
                      placeholder="what this number means to you"
                      className={inputClass}
                    />
                  </div>
                </div>
                <label className="mt-3 flex min-h-[44px] cursor-pointer items-center gap-2.5 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={row.intermediate}
                    onChange={(event) => onUpdateMetric(row.key, { intermediate: event.target.checked })}
                    className="size-4 accent-teal-700"
                  />
                  Intermediate target — a milestone on the way, not the final result
                </label>
                {rowProblem ? (
                  <p role="alert" className="mt-2 text-sm text-amber-900">
                    {rowProblem.message}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div>
        <button
          type="button"
          onClick={onAddMetric}
          disabled={draft.targetMetrics.length >= LIMITS.maxMetrics}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-teal-800/25 bg-white px-4 text-sm font-medium text-teal-900 transition-colors hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden="true" />
          {draft.targetMetrics.length === 0 ? "Add a target" : "Add another target"}
        </button>
        {draft.targetMetrics.length >= LIMITS.maxMetrics ? (
          <p className="mt-2 text-xs text-stone-500">
            A mission can carry at most {LIMITS.maxMetrics} targets.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export { metricRowProblem };
