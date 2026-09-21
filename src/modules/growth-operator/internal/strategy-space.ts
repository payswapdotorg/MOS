/**
 * The /growth-operator STRATEGY SPACE — the pure, deterministic selection
 * core (MKT-054: "bounded next-experiment/action selection ... from a
 * bounded strategy space, with explicit rationale and evidence
 * references").
 *
 * PURITY CONTRACT: every exported function here is PURE — the same inputs
 * always produce the same outputs, no I/O, no clock, no randomness. This is
 * what makes IDEMPOTENT REPLANNING hold: "the same mission state + evidence
 * snapshot → the same plan" (the deterministic idempotency key is derived
 * from exactly these inputs), and any plan change is a RECORDED deliberate
 * change (the inputs changed — new evidence, new learnings, new budget
 * state — and the decision record cites them).
 *
 * THE HUMAN-GROWTH INVARIANT LIVES HERE (architecture-v1.6.md §21;
 * architecture-lock-v1.6.md rules 43/44/45): the `human_amplification`
 * family is an OPTIONAL arm. It is CONSIDERED on every replan with its
 * recorded eligibility/budget inputs (the zero-human state is a RECORDED
 * strategy input — `consideredHuman` — never an absence), but it is NEVER
 * DELEGABLE by the MKT-054 controller: authentic human work rides the
 * existing /field-agents + /jobs authorities, which are not matrix
 * allowances of this module (they arrive with the optional MKT-076..078
 * Work Items). When the human arm is unavailable, unfunded or not yet
 * delegable, the selection RECORDS the honest non-selection rationale and
 * continues with the best NON-HUMAN family — never a fabricated human
 * result.
 */

import type {
  GrowthOperatorBudgetPolicy,
  GrowthOperatorHumanConsideration,
  GrowthOperatorTreatmentFamily,
} from '../public.ts';
import { GROWTH_OPERATOR_STRATEGY_VERSION } from '../public.ts';

/** The bounded budget defaults (the ZERO-HUMAN default posture). */
export const GROWTH_OPERATOR_DEFAULT_BUDGET: Readonly<GrowthOperatorBudgetPolicy> = {
  maxInFlightSteps: 1,
  maxDelegatedSteps: null,
  humanAmplificationBudget: 0,
  humanAmplificationEligibleCapacity: 0,
};

/** The NON-HUMAN delegable families (the always-available treatment set). */
export const NON_HUMAN_TREATMENT_FAMILIES: readonly GrowthOperatorTreatmentFamily[] = [
  'owned_channel_publish',
  'content_variant_test',
  'channel_reallocation',
  'measurement_enrichment',
];

/** The optional human arm (declared; considered; never delegated in MKT-054). */
export const HUMAN_TREATMENT_FAMILY: GrowthOperatorTreatmentFamily = 'human_amplification';

/**
 * The declared objective-family → treatment-family affinities (the frozen
 * go-strategy-v1 scoring base). A deterministic map over the MKT-053 §3
 * objective-family vocabulary: which treatment families the declared
 * business objective family favors, in order. Pure data — a change to it
 * is a NEW strategy version.
 */
export const OBJECTIVE_FAMILY_AFFINITIES: Readonly<
  Record<string, readonly GrowthOperatorTreatmentFamily[]>
> = {
  audience_growth: ['owned_channel_publish', 'content_variant_test', 'channel_reallocation', 'measurement_enrichment'],
  creator_growth: ['human_amplification', 'owned_channel_publish', 'content_variant_test', 'measurement_enrichment', 'channel_reallocation'],
  product_marketing: ['content_variant_test', 'channel_reallocation', 'owned_channel_publish', 'measurement_enrichment'],
  acquisition: ['channel_reallocation', 'content_variant_test', 'owned_channel_publish', 'measurement_enrichment'],
  lead_generation: ['content_variant_test', 'owned_channel_publish', 'channel_reallocation', 'measurement_enrichment'],
  revenue: ['channel_reallocation', 'content_variant_test', 'owned_channel_publish', 'measurement_enrichment'],
  commerce_discovery: ['channel_reallocation', 'content_variant_test', 'measurement_enrichment', 'owned_channel_publish'],
  hybrid: ['content_variant_test', 'channel_reallocation', 'owned_channel_publish', 'measurement_enrichment'],
};

/**
 * The exploration bonus: each family's first N steps receive a flat score
 * bonus so every family gets its bounded exploration before exploitation
 * dominates (MKT-054's "bounded next-experiment/action selection" — the
 * bounded exploration guarantee).
 */
export const EXPLORATION_STEPS_PER_FAMILY = 2;

/** The score bonus granted while a family is inside its exploration window. */
export const EXPLORATION_BONUS = 4;

/** The score bonus for families whose last observed outcome succeeded. */
export const SUCCESS_STREAK_BONUS = 3;

/** The score penalty for families whose last observed outcome failed. */
export const FAILURE_COOLDOWN_PENALTY = 2;

// ---------------------------------------------------------------------------
// The evidence snapshot digest (the idempotent-replanning anchor)
// ---------------------------------------------------------------------------

/**
 * The inputs of the evidence-snapshot digest — everything observable the
 * replan decision is computed against. The digest is DETERMINISTIC: the
 * same observable world → the same digest → the same plan (and the same
 * deterministic idempotency key — replays converge, restarts never
 * double-dispatch).
 */
export interface GrowthOperatorSnapshotInput {
  /** The mission's current version-sequence pointer (the declared content generation). */
  readonly missionVersionSeq: number;
  /** The mapped goals' live statuses (ordered by mapping order). */
  readonly goalStatuses: readonly string[];
  /** The evidence ids of the pursuit client's evidence tail (the full ordered set). */
  readonly evidenceIds: readonly string[];
  /** The learning ids of the pursuit client's learning tail (the full ordered set). */
  readonly learningIds: readonly string[];
  /** The count of dispatched plan steps so far. */
  readonly dispatchedStepCount: number;
  /** The per-family dispatched step counts (the exploration/exploitation state). */
  readonly familyDispatchCounts: Readonly<Record<string, number>>;
  /** The per-family last observed outcomes (the honest outcome memory). */
  readonly familyLastOutcomes: Readonly<Record<string, string>>;
  /** The budget policy the selection must respect. */
  readonly budget: GrowthOperatorBudgetPolicy;
}

/**
 * Computes the deterministic evidence-snapshot digest — a canonical,
 * order-stable string over the observable inputs. Same world → same
 * digest. (Deliberately NOT a hash: a stable readable canonical form is
 * the auditable anchor, and the bounded inputs make collisions
 * meaningless — the digest is an equality token, not a security
 * primitive.)
 */
export function computeEvidenceSnapshotDigest(input: GrowthOperatorSnapshotInput): string {
  const goalPart = input.goalStatuses.join(',');
  const evidencePart = input.evidenceIds.join(',');
  const learningPart = input.learningIds.join(',');
  const familyCountsPart = Object.keys(input.familyDispatchCounts)
    .sort()
    .map((family) => `${family}:${input.familyDispatchCounts[family] ?? 0}`)
    .join(',');
  const familyOutcomePart = Object.keys(input.familyLastOutcomes)
    .sort()
    .map((family) => `${family}:${input.familyLastOutcomes[family] ?? ''}`)
    .join(',');
  return [
    `v=${GROWTH_OPERATOR_STRATEGY_VERSION}`,
    `m=${input.missionVersionSeq}`,
    `g=[${goalPart}]`,
    `e=[${evidencePart}]`,
    `l=[${learningPart}]`,
    `d=${input.dispatchedStepCount}`,
    `f=[${familyCountsPart}]`,
    `o=[${familyOutcomePart}]`,
    `b=${input.budget.maxInFlightSteps}/${input.budget.maxDelegatedSteps ?? '∞'}/` +
      `${input.budget.humanAmplificationBudget}/${input.budget.humanAmplificationEligibleCapacity}`,
  ].join('|');
}

// ---------------------------------------------------------------------------
// The treatment selection (pure, deterministic, versioned)
// ---------------------------------------------------------------------------

/** One scored candidate of the selection. */
export interface GrowthOperatorTreatmentCandidate {
  readonly family: GrowthOperatorTreatmentFamily;
  readonly score: number;
  /** Whether the family is delegable by the MKT-054 controller. */
  readonly delegable: boolean;
}

/** The honest selection outcome of one replan. */
export interface GrowthOperatorSelection {
  /** The selected NON-HUMAN delegable family (the bounded next treatment). */
  readonly selectedFamily: GrowthOperatorTreatmentFamily;
  /** The deterministic selection rationale (explicit, honest, bounded). */
  readonly rationale: string;
  /** The scored candidates, best first (the disclosed scoring trail). */
  readonly candidates: readonly GrowthOperatorTreatmentCandidate[];
  /** The recorded human-amplification consideration (never an absence). */
  readonly consideredHuman: GrowthOperatorHumanConsideration;
  /**
   * True when the human arm was the TOP-scored family but was not
   * selected — the honest reallocation record.
   */
  readonly reallocatedFromHuman: boolean;
}

/** The selection inputs (the observable world, server-derived). */
export interface GrowthOperatorSelectionInput {
  /** The mission's declared objective family (the MKT-053 §3 vocabulary). */
  readonly objectiveFamily: string;
  readonly budget: GrowthOperatorBudgetPolicy;
  readonly familyDispatchCounts: Readonly<Record<string, number>>;
  readonly familyLastOutcomes: Readonly<Record<string, string>>;
  /** The mission's declared objective (verbatim, for the rationale). */
  readonly missionObjective: string;
  /** The number of delegated steps so far (the budget consumption). */
  readonly dispatchedStepCount: number;
}

/**
 * The human-amplification eligibility of this replan (PURE): the arm is
 * eligible only when it is BOTH funded (budget > 0) AND observable
 * capacity exists (eligible capacity > 0). In the current tree the
 * capacity is ZERO BY CONSTRUCTION (no human-growth marketplace
 * capability exists at this base — MKT-076..078 are future Work Items), so
 * the arm is never eligible and never selected: the zero-human path IS
 * the default path.
 */
export function humanConsiderationOf(input: {
  readonly budget: GrowthOperatorBudgetPolicy;
}): GrowthOperatorHumanConsideration {
  const funded = input.budget.humanAmplificationBudget > 0;
  const capacity = input.budget.humanAmplificationEligibleCapacity > 0;
  const eligible = funded && capacity;
  const reason = eligible
    ? 'human-amplification arm funded with observable eligible capacity — considered for selection (delegation of authentic human work rides the existing /jobs authority with the MKT-076..078 Work Items; the MKT-054 controller continues non-human while that arm is not delegable)'
    : !funded && !capacity
      ? 'zero-human state: human-amplification budget is 0 and no eligible human-treatment capacity is observable — continuing with non-human treatments (the normal strategy input, not an error)'
      : !funded
        ? 'human-amplification arm unfunded (budget = 0) — continuing with non-human treatments'
        : 'no eligible human-treatment capacity observable (declined/expired/unavailable offers are valid non-human states) — continuing with non-human treatments';
  return {
    eligible,
    budget: input.budget.humanAmplificationBudget,
    eligibleCapacity: input.budget.humanAmplificationEligibleCapacity,
    reason,
  };
}

/**
 * Scores one candidate family (PURE, deterministic): the objective-family
 * affinity rank + the bounded exploration bonus + the honest outcome
 * memory (a succeeded family is favored; a failed one cools down). No
 * time-based factors, no randomness — the same inputs always produce the
 * same scores.
 */
export function scoreCandidate(
  family: GrowthOperatorTreatmentFamily,
  input: GrowthOperatorSelectionInput,
): number {
  const affinities = OBJECTIVE_FAMILY_AFFINITIES[input.objectiveFamily] ?? OBJECTIVE_FAMILY_AFFINITIES['hybrid']!;
  const affinityIndex = affinities.indexOf(family);
  // The affinity score: rank 0 → highest (families outside the declared
  // affinity list score 0).
  const affinityScore = affinityIndex >= 0 ? (affinities.length - affinityIndex) * 2 : 0;
  const dispatched = input.familyDispatchCounts[family] ?? 0;
  const explorationScore = dispatched < EXPLORATION_STEPS_PER_FAMILY ? EXPLORATION_BONUS : 0;
  const lastOutcome = input.familyLastOutcomes[family] ?? '';
  const outcomeScore = lastOutcome === 'delegated_work_succeeded' ? SUCCESS_STREAK_BONUS
    : lastOutcome === 'delegated_work_failed' ? -FAILURE_COOLDOWN_PENALTY
    : 0;
  return affinityScore + explorationScore + outcomeScore;
}

/**
 * Selects the bounded NEXT treatment (PURE, deterministic — the heart of
 * idempotent replanning): scores every NON-HUMAN family + the human arm,
 * records the human consideration, and selects the best DELEGABLE
 * NON-HUMAN family. When the human arm tops the scoring but is not
 * delegable (the current tree — MKT-076..078 pending), the selection
 * REALLOCATES to the best non-human family and records that honestly in
 * the rationale: the controller continues, never fabricates a human
 * result, never treats the unavailability as a failure.
 *
 * The selection does NOT consider the budget cap (the caller applies the
 * exhaustion check first — exhaustion is a truthful terminal input, not a
 * strategy signal).
 */
export function selectNextTreatment(input: GrowthOperatorSelectionInput): GrowthOperatorSelection {
  const consideredHuman = humanConsiderationOf({ budget: input.budget });

  // Score every family (the human arm included — the disclosed trail).
  const candidates: GrowthOperatorTreatmentCandidate[] = [
    ...NON_HUMAN_TREATMENT_FAMILIES.map((family) => ({
      family,
      score: scoreCandidate(family, input),
      delegable: true,
    })),
    {
      family: HUMAN_TREATMENT_FAMILY,
      score: scoreCandidate(HUMAN_TREATMENT_FAMILY, input),
      delegable: false, // MKT-054: the human arm is not delegable (rules 43/44 — the /jobs seam is MKT-076..078).
    },
  ];
  // The deterministic order: score DESC, then family ASC (stable ties).
  candidates.sort((a, b) => b.score - a.score || (a.family < b.family ? -1 : 1));

  const topScored = candidates[0]!;
  const reallocatedFromHuman = topScored.family === HUMAN_TREATMENT_FAMILY;
  const selected = candidates.find((candidate) => candidate.delegable)!;

  const humanPart = reallocatedFromHuman
    ? `The human-amplification arm topped the scoring for this objective family but is not delegable by the MKT-054 controller — reallocating to the best non-human treatment '${selected.family}' (${consideredHuman.reason}).`
    : `The human-amplification arm was considered and recorded (${consideredHuman.reason}).`;
  const rationale =
    `Strategy ${GROWTH_OPERATOR_STRATEGY_VERSION} selected '${selected.family}' for the declared ` +
    `objective family '${input.objectiveFamily}' (objective: "${input.missionObjective}"): ` +
    `affinity-ranked with bounded exploration (${input.familyDispatchCounts[selected.family] ?? 0} prior ` +
    `dispatches of this family) and honest outcome memory; scored ${selected.score}. ${humanPart}`;

  return {
    selectedFamily: selected.family,
    rationale,
    candidates,
    consideredHuman,
    reallocatedFromHuman,
  };
}

/**
 * The deterministic plan-step idempotency key (the NO-DOUBLE-DISPATCH
 * anchor): derived from the strategy version + the evidence-snapshot
 * digest + the next step sequence. The same mission state + evidence
 * snapshot → the same key → the DB UNIQUE (mission_id, idempotency_key)
 * fence converges replays and restarts to ONE step.
 */
export function computePlanStepIdempotencyKey(
  evidenceSnapshotDigest: string,
  nextStepSeq: number,
): string {
  return `go-plan-${evidenceSnapshotDigest}-s${nextStepSeq}`.slice(0, 200);
}
