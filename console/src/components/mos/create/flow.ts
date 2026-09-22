// UX-002 — the mission-creation flow's draft model, client-side validation
// (mirroring the server contract exactly) and the request-body builder.
// PURE module: no React, no fetch. The draft is presentation state only —
// nothing here grants or persists anything; the single durable write is the
// real POST /api/agencies/:agencyId/growth-missions composed by the builder
// below, which sends ONLY the caller-declarable fields of the frozen
// contract (never missionId/agencyId/status/version/currentVersionSeq/
// createdActor/createdAt/updatedAt/provenance — those are server-derived
// and rejected).

import { isObjectiveFamily, type ObjectiveFamily } from "./families";

// --- The draft (presentation state, one shape for the whole flow) ----------

export type TargetMetricDraft = {
  /** Local list key (never sent). */
  key: string;
  metric: string;
  comparator: Comparator;
  targetValueRaw: string; // kept as typed text so "1," etc. never snap
  unit: string;
  description: string;
  intermediate: boolean;
};

export type MissionDraft = {
  objective: string;
  objectiveFamily: ObjectiveFamily | null;
  targetMetrics: TargetMetricDraft[];
  productContext: { name: string; url: string; summary: string };
  marketContext: { audience: string; geography: string; summary: string };
};

export function emptyDraft(family: ObjectiveFamily | null): MissionDraft {
  return {
    objective: "",
    objectiveFamily: family,
    targetMetrics: [],
    productContext: { name: "", url: "", summary: "" },
    marketContext: { audience: "", geography: "", summary: "" },
  };
}

// --- Server contract limits (mirrored verbatim from the route DTOs) --------

export const LIMITS = {
  objectiveMin: 1,
  objectiveMax: 5000,
  metricNameMax: 100,
  unitMax: 50,
  descriptionMax: 500,
  contextFieldMax: 500,
  maxMetrics: 50,
} as const;

export const COMPARATORS = [">=", ">", "<=", "<", "=="] as const;
export type Comparator = (typeof COMPARATORS)[number];

// --- Validation (honest pre-flight only; the server remains the authority) --

export type FieldProblem = { field: string; message: string };

function trimmedNonEmpty(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function maxLengthProblem(field: string, label: string, value: string, max: number): FieldProblem | null {
  if (value.length > max) {
    return { field, message: `${label} is over the ${max}-character limit (currently ${value.length}).` };
  }
  return null;
}

/** A metric row is sendable when its name is present and its value parses. */
export function metricRowProblem(row: TargetMetricDraft): FieldProblem | null {
  const name = trimmedNonEmpty(row.metric);
  if (name === null) {
    return { field: `metric-${row.key}`, message: "Give this target a name (what you measure)." };
  }
  if (name.length > LIMITS.metricNameMax) {
    return {
      field: `metric-${row.key}`,
      message: `Target names are limited to ${LIMITS.metricNameMax} characters.`,
    };
  }
  const value = Number(row.targetValueRaw);
  if (row.targetValueRaw.trim() === "" || !Number.isFinite(value)) {
    return { field: `metric-${row.key}`, message: "Enter a number for this target's value." };
  }
  return (
    maxLengthProblem(`metric-${row.key}`, "This target's unit", row.unit, LIMITS.unitMax) ??
    maxLengthProblem(`metric-${row.key}`, "This target's description", row.description, LIMITS.descriptionMax)
  );
}

/** The outcome step is complete when the objective + family are valid. */
export function outcomeProblems(draft: MissionDraft): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const objective = draft.objective.trim();
  if (objective === "") {
    problems.push({
      field: "objective",
      message: "Describe the outcome in your own words — one or two sentences is plenty.",
    });
  } else if (objective.length > LIMITS.objectiveMax) {
    problems.push({
      field: "objective",
      message: `The objective is over the ${LIMITS.objectiveMax}-character limit (currently ${objective.length}).`,
    });
  }
  if (draft.objectiveFamily === null) {
    problems.push({ field: "objectiveFamily", message: "Pick the kind of outcome this mission pursues." });
  }
  return problems;
}

/** Context step: all fields optional, but limits still apply when filled. */
export function contextProblems(draft: MissionDraft): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const checks: Array<[FieldProblem["field"], string, string]> = [
    ["product-name", "The product name", draft.productContext.name],
    ["product-url", "The product link", draft.productContext.url],
    ["product-summary", "The product summary", draft.productContext.summary],
    ["market-audience", "The audience description", draft.marketContext.audience],
    ["market-geography", "The geography", draft.marketContext.geography],
    ["market-summary", "The market summary", draft.marketContext.summary],
  ];
  for (const [field, label, value] of checks) {
    const problem = maxLengthProblem(field, label, value, LIMITS.contextFieldMax);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

export function targetProblems(draft: MissionDraft): FieldProblem[] {
  const problems: FieldProblem[] = [];
  if (draft.targetMetrics.length > LIMITS.maxMetrics) {
    problems.push({
      field: "targetMetrics",
      message: `A mission can carry at most ${LIMITS.maxMetrics} targets.`,
    });
    return problems;
  }
  for (const row of draft.targetMetrics) {
    const problem = metricRowProblem(row);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}

// --- The request body (EXACTLY the frozen create contract) ------------------

export type GrowthMissionCreateBody = {
  objective: string;
  objectiveFamily: ObjectiveFamily;
  productContext?: { name?: string; url?: string; summary?: string };
  marketContext?: { audience?: string; geography?: string; summary?: string };
  targetMetrics?: Array<{
    metric: string;
    comparator: Comparator;
    targetValue: number;
    unit?: string;
    description?: string;
    intermediate: boolean;
  }>;
};

/**
 * Builds the POST body from a validated draft. Empty optional strings are
 * OMITTED (never sent as ""), so the server sees exactly what the user
 * filled in — and only caller-declarable fields ever appear.
 */
export function buildCreateBody(draft: MissionDraft): GrowthMissionCreateBody | null {
  if (draft.objectiveFamily === null) return null;
  const objective = draft.objective.trim();
  if (objective === "" || objective.length > LIMITS.objectiveMax) return null;

  const body: GrowthMissionCreateBody = {
    objective,
    objectiveFamily: draft.objectiveFamily,
  };

  const productName = trimmedNonEmpty(draft.productContext.name);
  const productUrl = trimmedNonEmpty(draft.productContext.url);
  const productSummary = trimmedNonEmpty(draft.productContext.summary);
  if (productName !== null || productUrl !== null || productSummary !== null) {
    body.productContext = {
      ...(productName === null ? {} : { name: productName }),
      ...(productUrl === null ? {} : { url: productUrl }),
      ...(productSummary === null ? {} : { summary: productSummary }),
    };
  }

  const audience = trimmedNonEmpty(draft.marketContext.audience);
  const geography = trimmedNonEmpty(draft.marketContext.geography);
  const marketSummary = trimmedNonEmpty(draft.marketContext.summary);
  if (audience !== null || geography !== null || marketSummary !== null) {
    body.marketContext = {
      ...(audience === null ? {} : { audience }),
      ...(geography === null ? {} : { geography }),
      ...(marketSummary === null ? {} : { summary: marketSummary }),
    };
  }

  const metrics: NonNullable<GrowthMissionCreateBody["targetMetrics"]> = [];
  for (const row of draft.targetMetrics) {
    const metric = trimmedNonEmpty(row.metric);
    if (metric === null) return null; // unreachable behind validation; honest fail
    const targetValue = Number(row.targetValueRaw);
    if (!Number.isFinite(targetValue)) return null;
    const unit = trimmedNonEmpty(row.unit);
    const description = trimmedNonEmpty(row.description);
    metrics.push({
      metric,
      comparator: row.comparator,
      targetValue,
      ...(unit === null ? {} : { unit }),
      ...(description === null ? {} : { description }),
      intermediate: row.intermediate,
    });
  }
  if (metrics.length > 0) body.targetMetrics = metrics;

  return body;
}

/** Is a family string a valid seed coming from a view/navigation? */
export function validSeed(family: string | undefined): ObjectiveFamily | null {
  return family !== undefined && isObjectiveFamily(family) ? family : null;
}
