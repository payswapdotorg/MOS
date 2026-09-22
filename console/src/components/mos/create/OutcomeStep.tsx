"use client";

// UX-002 — step 1 of the flow: the OUTCOME. Two real, persisted inputs:
// the objective (the user's own words, stored verbatim, 1..5000) and the
// frozen §3 objective family. When the flow was started from one of the
// five home outcome cards, the family arrives pre-seeded — the user can
// still change it (the seed is a convenience, never a lock).

import { FAMILY_PRESENTATION, OBJECTIVE_FAMILIES, type ObjectiveFamily } from "./families";
import { LIMITS, type FieldProblem, type MissionDraft } from "./flow";

export function OutcomeStep({
  draft,
  seeded,
  problems,
  onObjectiveChange,
  onFamilyChange,
}: {
  draft: MissionDraft;
  seeded: boolean;
  problems: FieldProblem[];
  onObjectiveChange: (value: string) => void;
  onFamilyChange: (value: ObjectiveFamily) => void;
}) {
  const objectiveProblem = problems.find((problem) => problem.field === "objective");
  const familyProblem = problems.find((problem) => problem.field === "objectiveFamily");
  const objectiveLength = draft.objective.trim().length;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="mission-objective" className="text-sm font-medium text-stone-800">
          What outcome do you want?
        </label>
        <p className="text-sm leading-relaxed text-stone-600">
          Say it in your own words — your exact words are stored with the mission, never reworded.
        </p>
        <textarea
          id="mission-objective"
          value={draft.objective}
          onChange={(event) => onObjectiveChange(event.target.value)}
          rows={4}
          maxLength={LIMITS.objectiveMax}
          placeholder="e.g. Grow a following of small-shop owners who genuinely care about our tools, and turn that trust into steady sign-ups."
          aria-describedby={objectiveProblem ? "mission-objective-problem" : "mission-objective-hint"}
          aria-invalid={objectiveProblem !== undefined}
          className="min-h-[110px] w-full resize-y rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-base leading-relaxed text-stone-800 placeholder:text-stone-400 focus-visible:border-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/30"
        />
        <div className="flex items-start justify-between gap-3">
          {objectiveProblem ? (
            <p id="mission-objective-problem" className="text-sm text-amber-900">
              {objectiveProblem.message}
            </p>
          ) : (
            <p id="mission-objective-hint" className="text-xs text-stone-500">
              One or two sentences is plenty. You can refine it later as a new recorded version.
            </p>
          )}
          <p className="shrink-0 text-xs tabular-nums text-stone-400">
            {objectiveLength}/{LIMITS.objectiveMax}
          </p>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-stone-800">What kind of outcome is it?</legend>
        <p className="text-sm leading-relaxed text-stone-600">
          {seeded && draft.objectiveFamily !== null
            ? `Pre-filled from the outcome you picked — change it if this isn't quite right.`
            : "Pick the closest fit. This is how the system reads your mission."}
        </p>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {OBJECTIVE_FAMILIES.map((family) => {
            const presentation = FAMILY_PRESENTATION[family];
            const selected = draft.objectiveFamily === family;
            return (
              <label
                key={family}
                className={`flex min-h-[64px] cursor-pointer items-start gap-3 rounded-xl border p-3.5 transition-colors ${
                  selected
                    ? "border-teal-700/50 bg-teal-50/50"
                    : "border-stone-200 bg-white hover:border-stone-300 hover:bg-stone-100/50"
                }`}
              >
                <input
                  type="radio"
                  name="mission-family"
                  value={family}
                  checked={selected}
                  onChange={() => onFamilyChange(family)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border-2 ${
                    selected ? "border-teal-700" : "border-stone-300"
                  }`}
                >
                  {selected ? <span className="size-2 rounded-full bg-teal-700" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-stone-800">{presentation.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-stone-600">
                    {presentation.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        {familyProblem ? (
          <p role="alert" className="text-sm text-amber-900">
            {familyProblem.message}
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}
