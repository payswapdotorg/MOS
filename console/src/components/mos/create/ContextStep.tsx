"use client";

// UX-002 — step 3 of the flow: the PRODUCT / SOURCE / STORE CONTEXT. Real,
// persisted inputs of the frozen create contract: productContext
// { name?, url?, summary? } and marketContext { audience?, geography?,
// summary? } — each field optional, ≤500 characters. All of it is honest
// free text the user declares about what they sell and who they sell to.

import { LIMITS, type FieldProblem, type MissionDraft } from "./flow";

const inputClass =
  "w-full rounded-lg border border-stone-300 bg-white px-3.5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus-visible:border-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700/30";

function Field({
  id,
  label,
  hint,
  value,
  onChange,
  placeholder,
  problem,
  multiline,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  problem?: FieldProblem;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-stone-800">
        {label}
      </label>
      {multiline ? (
        <textarea
          id={id}
          value={value}
          rows={2}
          maxLength={LIMITS.contextFieldMax}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-invalid={problem !== undefined}
          className={`${inputClass} resize-y`}
        />
      ) : (
        <input
          id={id}
          type={id.endsWith("url") ? "url" : "text"}
          value={value}
          maxLength={LIMITS.contextFieldMax}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          aria-invalid={problem !== undefined}
          className={inputClass}
        />
      )}
      {problem ? (
        <p role="alert" className="text-sm text-amber-900">
          {problem.message}
        </p>
      ) : (
        hint ? <p className="text-xs text-stone-500">{hint}</p> : null
      )}
    </div>
  );
}

export function ContextStep({
  draft,
  problems,
  onProductChange,
  onMarketChange,
}: {
  draft: MissionDraft;
  problems: FieldProblem[];
  onProductChange: (patch: Partial<MissionDraft["productContext"]>) => void;
  onMarketChange: (patch: Partial<MissionDraft["marketContext"]>) => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-sm font-medium text-stone-800">What is this mission working with?</h3>
        <p className="mt-1 text-sm leading-relaxed text-stone-600">
          Tell the mission about the product, source or store involved, and who it&apos;s for.
          Everything here is optional — skip it if the mission is about something broader.
        </p>
      </div>

      <fieldset className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-medium text-stone-800">Product, source or store</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="product-name"
            label="Name"
            value={draft.productContext.name}
            onChange={(name) => onProductChange({ name })}
            placeholder="e.g. Helio Repair Kits"
            problem={problems.find((problem) => problem.field === "product-name")}
          />
          <Field
            id="product-url"
            label="Link"
            hint="A page about it, if there is one."
            value={draft.productContext.url}
            onChange={(url) => onProductChange({ url })}
            placeholder="https://example.com/product"
            problem={problems.find((problem) => problem.field === "product-url")}
          />
        </div>
        <Field
          id="product-summary"
          label="What is it, briefly?"
          value={draft.productContext.summary}
          onChange={(summary) => onProductChange({ summary })}
          placeholder="one or two sentences — what it is, what makes it worth buying"
          problem={problems.find((problem) => problem.field === "product-summary")}
          multiline
        />
      </fieldset>

      <fieldset className="flex flex-col gap-4 rounded-xl border border-stone-200 bg-white p-4 sm:p-5">
        <legend className="px-1 text-sm font-medium text-stone-800">Market and audience</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            id="market-audience"
            label="Who is it for?"
            value={draft.marketContext.audience}
            onChange={(audience) => onMarketChange({ audience })}
            placeholder="e.g. small-shop owners in their first year"
            problem={problems.find((problem) => problem.field === "market-audience")}
          />
          <Field
            id="market-geography"
            label="Where?"
            hint="Places or languages that matter, if any."
            value={draft.marketContext.geography}
            onChange={(geography) => onMarketChange({ geography })}
            placeholder="e.g. Ghana and West Africa"
            problem={problems.find((problem) => problem.field === "market-geography")}
          />
        </div>
        <Field
          id="market-summary"
          label="Anything else about the market?"
          value={draft.marketContext.summary}
          onChange={(summary) => onMarketChange({ summary })}
          placeholder="context that helps — seasonality, competitors, constraints"
          problem={problems.find((problem) => problem.field === "market-summary")}
          multiline
        />
      </fieldset>
    </div>
  );
}
