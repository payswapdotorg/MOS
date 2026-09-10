/**
 * Routing policy — hard eligibility FIRST, then performance ranking, then
 * cost/latency tradeoff, then selection (spec/ai-runtime-and-routing.md §4).
 *
 * The routing core is the /ai-runtime module itself (AI-AC-03). The policy
 * is a declarative JSON object interpreted by these pure functions; the
 * routing-cascade executor (cascade.ts) calls them in this exact phase
 * order to produce a SelectionDecisionPayload (the AI-AC-04 proof).
 *
 * INVARIANTS (frozen architecture — non-negotiable):
 *   - Hard constraints are NOT soft quality penalties. An ineligible model
 *     never ranks (AI-AC-04). The eligible set is computed BEFORE ranking;
 *     the ranking function receives ONLY eligible models.
 *   - Capability clipping happens in ranking math ONLY, never by mutating
 *     the registry's capability record (AI-AC-07). The registry's declared
 *     signals are READ-ONLY here; the ranking normalizes the quality signal
 *     to a 0..1 score for comparison purposes, but the registry record is
 *     never modified.
 *   - The phase order is the §4 order: eligibility → ranking → tradeoff →
 *     selection. The phase trace recorded on a selection decision is an
 *     ordered array of phase labels (the AI-AC-04 unit-test proof).
 */

import type {
  EligibilityDecision,
  EligibilityReason,
  ModelRegistryRecord,
  RankingScore,
  RoutingPhase,
  RoutingPolicyRecord,
  SelectionDecisionPayload,
  TaskProfileRecord,
  TradeoffScore,
} from '../../public.ts';
// NOTE: ROUTING_PHASES and ELIGIBILITY_REASONS are NOT imported as values
// here to avoid a circular import (public.ts re-exports ROUTING_PHASE_ORDER
// and ELIGIBILITY_REASON_PRIORITY from this file). The constants are inlined
// at the bottom of this file; the types (RoutingPhase, EligibilityReason)
// are type-only imports and do not create a runtime cycle.

// ---------------------------------------------------------------------------
// Routing-policy interpretation (the declarative JSON object)
// ---------------------------------------------------------------------------

/**
 * The interpreted routing policy (parsed from the declarative JSON). The
 * policy content is permissive (the routing core reads known keys and
 * ignores unknown keys for forward compatibility); this shape is the
 * recognized subset.
 */
export interface InterpretedPolicy {
  /** Provider labels explicitly DENIED (hard policy filter). */
  readonly deniedProviderLabels: ReadonlySet<string>;
  /** Model keys explicitly DENIED (hard policy filter). */
  readonly deniedModelKeys: ReadonlySet<string>;
  /** Required capability labels (hard capability filter — models must have ALL). */
  readonly requiredCapabilities: ReadonlySet<string>;
  /** Required tool features (hard capability filter — models must have ALL). */
  readonly requiredToolFeatures: ReadonlySet<string>;
  /** Required privacy class floor (hard privacy filter — models with weaker privacy are INELIGIBLE). */
  readonly requiredPrivacyFloor: 'public' | 'internal' | 'confidential' | 'restricted' | null;
  /** Subscribed provider labels (hard subscription filter — when non-empty, only these providers are eligible). */
  readonly subscribedProviders: ReadonlySet<string>;
  /** Ranking weight for the quality component (default 0.5). */
  readonly qualityWeight: number;
  /** Ranking weight for the cost component (default 0.25). */
  readonly costWeight: number;
  /** Ranking weight for the latency component (default 0.25). */
  readonly latencyWeight: number;
  /** Max escalations allowed in a cascade (default 2). */
  readonly maxEscalations: number;
  /** Whether to fan out to N cheap candidates before escalating (default false). */
  readonly fanOut: boolean;
  /** Frontier escalation threshold (when escalation count exceeds this, escalate to frontier). */
  readonly frontierThreshold: number;
  /** Whether human escalation is enabled (per the task profile's escalation policy). */
  readonly humanEscalationEnabled: boolean;
}

const PRIVACY_CLASS_ORDER = ['public', 'internal', 'confidential', 'restricted'] as const;

function privacyClassFloor(value: unknown): InterpretedPolicy['requiredPrivacyFloor'] {
  if (typeof value !== 'string') return null;
  return (PRIVACY_CLASS_ORDER as readonly string[]).includes(value)
    ? (value as InterpretedPolicy['requiredPrivacyFloor'])
    : null;
}

function labelSet(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  const out = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) out.add(item);
  }
  return out;
}

function weight(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

function nonNegInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

/** Interprets the declarative policy JSON into the recognized shape. */
export function interpretPolicy(policy: RoutingPolicyRecord | null): InterpretedPolicy {
  const content = policy === null ? {} : policy.policyContent;
  const hardEligibility =
    (content['hardEligibility'] as Record<string, unknown> | undefined) ?? {};
  // The 'ranking' section is intentionally not parsed here: the ranking
  // phase uses the model's declared qualitySignals (per-task-class), not
  // policy-declared ranking weights. The policy may carry a 'ranking'
  // section for documentation/forward-compatibility, but the routing core
  // does not currently consume it.
  const tradeoff =
    (content['tradeoff'] as Record<string, unknown> | undefined) ?? {};
  const cascade =
    (content['cascade'] as Record<string, unknown> | undefined) ?? {};
  return {
    deniedProviderLabels: labelSet(hardEligibility['deniedProviderLabels']),
    deniedModelKeys: labelSet(hardEligibility['deniedModelKeys']),
    requiredCapabilities: labelSet(hardEligibility['requiredCapabilities']),
    requiredToolFeatures: labelSet(hardEligibility['requiredToolFeatures']),
    requiredPrivacyFloor: privacyClassFloor(hardEligibility['requiredPrivacyFloor']),
    subscribedProviders: labelSet(hardEligibility['subscribedProviders']),
    qualityWeight: weight(tradeoff['qualityWeight'], 0.5),
    costWeight: weight(tradeoff['costWeight'], 0.25),
    latencyWeight: weight(tradeoff['latencyWeight'], 0.25),
    maxEscalations: nonNegInt(cascade['maxEscalations'], 2),
    fanOut: Boolean(cascade['fanOut']),
    frontierThreshold: nonNegInt(cascade['frontierThreshold'], 1),
    humanEscalationEnabled: Boolean(cascade['humanEscalationEnabled']),
  };
}

// ---------------------------------------------------------------------------
// Phase 1 — hard eligibility (privacy/policy/capability/quota/subscription/availability)
// ---------------------------------------------------------------------------

/**
 * Computes the hard-eligibility decisions for one task profile against a set
 * of registry models. The phases are evaluated in the §4 priority order
 * (privacy → policy → capability → quota → subscription → availability); the
 * FIRST failing phase determines the reason (the model is ineligible from
 * the moment the first hard constraint fails — the remaining phases are not
 * evaluated for that model).
 *
 * Quota and subscription are dynamic signals not present in the registry
 * record (they live in the routing policy or are runtime-resolved); when
 * the policy does not specify a quota/subscription filter, those phases
 * PASS (an unmeasured signal is never a fabrication — NULL is not a hard
 * failure).
 */
export function computeEligibility(input: {
  readonly taskProfile: TaskProfileRecord;
  readonly models: readonly ModelRegistryRecord[];
  readonly policy: InterpretedPolicy;
}): EligibilityDecision[] {
  const { taskProfile, models, policy } = input;
  const decisions: EligibilityDecision[] = [];
  for (const model of models) {
    // Phase 1a: PRIVACY — the model's privacy characteristics must satisfy
    // the task profile's privacy class. The model's privacy characteristics
    // is a JSON object (e.g. { dataResidency, trainingUse }); the task
    // profile's privacyClass is one of public/internal/confidential/restricted.
    // Heuristic: if the model's privacyCharacteristics declares a
    // `trainingUse: true` and the task profile's privacyClass is
    // 'restricted' or 'confidential', the model is INELIGIBLE on privacy.
    const privacyChar = model.privacyCharacteristics as Record<string, unknown>;
    const trainingUse = privacyChar['trainingUse'] === true;
    if (
      (taskProfile.privacyClass === 'restricted' || taskProfile.privacyClass === 'confidential') &&
      trainingUse
    ) {
      decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'privacy' });
      continue;
    }
    // Privacy floor: if the policy declares a floor and the model's declared
    // data residency is below the floor, the model is INELIGIBLE on privacy.
    // (The model's residency is a label; the floor is an order. We use a
    // simple label match — if the policy says `requiredPrivacyFloor:
    // 'restricted'` and the model declares `dataResidency: 'eu'` (which is
    // not 'restricted'), the model fails the floor. This is a conservative
    // heuristic; a full privacy-class matching is the policy author's
    // responsibility through `deniedProviderLabels`/`deniedModelKeys`.)
    if (policy.requiredPrivacyFloor !== null) {
      const modelResidency = privacyChar['dataResidency'];
      if (
        typeof modelResidency === 'string' &&
        policy.requiredPrivacyFloor === 'restricted' &&
        modelResidency !== 'restricted'
      ) {
        decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'privacy' });
        continue;
      }
    }

    // Phase 1b: POLICY — the policy's deny lists. A model whose provider
    // label OR model key is on the deny list is INELIGIBLE on policy.
    if (
      policy.deniedProviderLabels.has(model.providerLabel) ||
      policy.deniedModelKeys.has(model.modelKey)
    ) {
      decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'policy' });
      continue;
    }

    // Phase 1c: CAPABILITY — the model must have ALL required capabilities
    // AND ALL required tool features. The registry's `capabilities` and
    // `toolFeatures` are READ here; they are NEVER mutated (AI-AC-07 — the
    // capability record is recorded as declared; normalization happens in
    // ranking math only).
    const modelCapabilities = new Set(model.capabilities);
    const modelToolFeatures = new Set(model.toolFeatures);
    const hasAllCapabilities = [...policy.requiredCapabilities].every((c) => modelCapabilities.has(c));
    const hasAllToolFeatures = [...policy.requiredToolFeatures].every((t) => modelToolFeatures.has(t));
    if (!hasAllCapabilities || !hasAllToolFeatures) {
      decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'capability' });
      continue;
    }

    // Phase 1d: QUOTA — the policy may declare a `maxCostPerInvocation`
    // floor that overrides the task profile's; the model's cost must be
    // at or below the budget. A model with NULL cost is treated as
    // eligible (NULL is unknown, not a hard failure — the signal is never
    // fabricated).
    if (model.costInputPerMtok !== null && model.costOutputPerMtok !== null) {
      // Rough invocation cost estimate: 1000 input tokens + 500 output tokens
      // (the policy author can refine; this is a conservative heuristic).
      const estimatedCost =
        (model.costInputPerMtok * 1_000 + model.costOutputPerMtok * 500) / 1_000_000;
      if (estimatedCost > taskProfile.maxCostPerInvocation) {
        decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'quota' });
        continue;
      }
    }

    // Phase 1e: SUBSCRIPTION — the policy may declare a `subscribedProviders`
    // allow-list; a model whose provider is not on the allow-list is
    // INELIGIBLE on subscription. When the policy does NOT declare an allow-
    // list, all providers pass (the signal is unmeasured, not a failure).
    if (policy.subscribedProviders.size > 0 && !policy.subscribedProviders.has(model.providerLabel)) {
      decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'subscription' });
      continue;
    }

    // Phase 1f: AVAILABILITY — the model's current availability state must
    // be 'available' or 'degraded'. An 'unavailable' model is INELIGIBLE on
    // availability (the registry's availability_state is server-derived
    // from the latest appended observation — never caller-supplied).
    if (model.availabilityState === 'unavailable') {
      decisions.push({ modelRegistryId: model.modelRegistryId, eligible: false, reason: 'availability' });
      continue;
    }

    // All hard constraints passed: the model is ELIGIBLE.
    decisions.push({ modelRegistryId: model.modelRegistryId, eligible: true, reason: null });
  }
  return decisions;
}

// ---------------------------------------------------------------------------
// Phase 2 — performance ranking (uses declared quality signals; never mutates the registry)
// ---------------------------------------------------------------------------

/**
 * Computes the performance ranking for the ELIGIBLE models. The ranking
 * uses the model's declared `qualitySignals[taskClass]` as the primary
 * score (a number 0..1, or undefined = 0). The ranking math NORMALIZES the
 * scores to a 0..1 range across the eligible set (so the highest-scoring
 * model has score 1.0) — this normalization is RANKING MATH ONLY; the
 * registry's `qualitySignals` record is NEVER mutated (AI-AC-07: capability
 * clipping happens in ranking math only, never by mutating the registry's
 * capability record).
 *
 * Models with no quality signal for the task class receive score 0 (they
 * are NOT excluded — they remain eligible and may still be selected on
 * cost/latency grounds; the quality component contributes 0 to their
 * tradeoff score).
 */
export function computeRanking(input: {
  readonly taskProfile: TaskProfileRecord;
  readonly eligibleModels: readonly ModelRegistryRecord[];
}): RankingScore[] {
  const { taskProfile, eligibleModels } = input;
  const rawScores: { modelRegistryId: string; raw: number }[] = [];
  for (const model of eligibleModels) {
    const qualitySignals = model.qualitySignals as Record<string, unknown>;
    const raw = qualitySignals[taskProfile.taskClass];
    const rawNumber = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    rawScores.push({ modelRegistryId: model.modelRegistryId, raw: rawNumber });
  }
  if (rawScores.length === 0) return [];
  const max = Math.max(...rawScores.map((s) => s.raw));
  const min = Math.min(...rawScores.map((s) => s.raw));
  const range = max - min;
  return rawScores
    .map((s) => {
      // Normalize to 0..1: if all raw scores are equal, every model gets 1.0
      // (the highest possible normalized score — no model is penalized for
      // a tie at the top). Otherwise, normalize linearly.
      const normalized = range === 0 ? (s.raw > 0 ? 1 : 0) : (s.raw - min) / range;
      return {
        modelRegistryId: s.modelRegistryId,
        score: normalized,
        components: { raw: s.raw, normalized },
      } satisfies RankingScore;
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Phase 3 — cost/latency tradeoff (weighted sum of normalized components)
// ---------------------------------------------------------------------------

/**
 * Computes the cost/latency tradeoff score for the RANKED models. The
 * tradeoff is a weighted sum of:
 *   - qualityComponent: the ranking score (0..1, from Phase 2);
 *   - costComponent: 1 - normalizedCost (cheaper is better — the cheapest
 *     model has costComponent 1.0);
 *   - latencyComponent: 1 - normalizedLatency (faster is better — the
 *     fastest model has latencyComponent 1.0).
 *
 * Models with NULL cost or NULL latency receive a 0.5 costComponent or
 * latencyComponent (the unknown signal is never a fabrication — a neutral
 * middle value is the conservative choice, neither rewarding nor
 * penalizing the unknown).
 */
export function computeTradeoff(input: {
  readonly taskProfile: TaskProfileRecord;
  readonly rankedModels: readonly ModelRegistryRecord[];
  readonly ranking: readonly RankingScore[];
  readonly policy: InterpretedPolicy;
}): TradeoffScore[] {
  const { rankedModels, ranking, policy } = input;
  if (rankedModels.length === 0) return [];

  // Normalize cost: 1 - (cost - minCost) / (maxCost - minCost), so the
  // cheapest model has costComponent 1.0. Models with NULL cost receive 0.5.
  const costs = rankedModels
    .map((m) => m.costInputPerMtok)
    .filter((c): c is number => c !== null);
  const minCost = costs.length > 0 ? Math.min(...costs) : 0;
  const maxCost = costs.length > 0 ? Math.max(...costs) : 0;
  const costRange = maxCost - minCost;

  // Normalize latency: 1 - (latency - minLatency) / (maxLatency - minLatency).
  const latencies = rankedModels
    .map((m) => m.latencyP50Ms)
    .filter((l): l is number => l !== null);
  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
  const latencyRange = maxLatency - minLatency;

  return rankedModels.map((model) => {
    // Find the ranking score for this model.
    const rankEntry = ranking.find((r) => r.modelRegistryId === model.modelRegistryId);
    const qualityComponent = rankEntry === undefined ? 0 : rankEntry.score;

    // Cost component: cheaper is better.
    let costComponent: number;
    if (model.costInputPerMtok === null) {
      costComponent = 0.5;
    } else if (costRange === 0) {
      costComponent = 1.0;
    } else {
      costComponent = 1 - (model.costInputPerMtok - minCost) / costRange;
    }

    // Latency component: faster is better.
    let latencyComponent: number;
    if (model.latencyP50Ms === null) {
      latencyComponent = 0.5;
    } else if (latencyRange === 0) {
      latencyComponent = 1.0;
    } else {
      latencyComponent = 1 - (model.latencyP50Ms - minLatency) / latencyRange;
    }

    const score =
      policy.qualityWeight * qualityComponent +
      policy.costWeight * costComponent +
      policy.latencyWeight * latencyComponent;

    return {
      modelRegistryId: model.modelRegistryId,
      score,
      costComponent,
      latencyComponent,
      qualityComponent,
    } satisfies TradeoffScore;
  });
}

// ---------------------------------------------------------------------------
// Phase 4 — selection (the highest-tradeoff-score eligible model)
// ---------------------------------------------------------------------------

/**
 * The full routing-decision payload: the eligible set, the ranking, the
 * tradeoff, the chosen model and the phase trace. The phase trace is the
 * AI-AC-04 proof (eligibility → ranking → tradeoff → selection in this
 * exact order). The chosen model is the highest-tradeoff-score eligible
 * model (the first in the tradeoff array — sorted descending).
 *
 * If the eligible set is EMPTY, the chosen model is the empty string ''.
 * The caller MUST handle this case (the cascade cannot run; the routing
 * decision records an empty eligible set and the chosen model is null).
 */
export function selectModel(input: {
  readonly taskProfile: TaskProfileRecord;
  readonly models: readonly ModelRegistryRecord[];
  readonly policy: InterpretedPolicy;
}): SelectionDecisionPayload {
  const phaseTrace: RoutingPhase[] = [];

  // Phase 1: eligibility.
  phaseTrace.push('eligibility');
  const eligibilityDecisions = computeEligibility(input);
  const eligibleModels = input.models.filter((m) =>
    eligibilityDecisions.some(
      (d) => d.modelRegistryId === m.modelRegistryId && d.eligible,
    ),
  );

  // Phase 2: ranking.
  phaseTrace.push('ranking');
  const ranking = computeRanking({
    taskProfile: input.taskProfile,
    eligibleModels,
  });

  // Phase 3: tradeoff.
  phaseTrace.push('tradeoff');
  const rankedModels = eligibleModels; // ranking does not reorder models; it computes scores
  const tradeoff = computeTradeoff({
    taskProfile: input.taskProfile,
    rankedModels,
    ranking,
    policy: input.policy,
  });

  // Phase 4: selection.
  phaseTrace.push('selection');
  const sortedTradeoff = [...tradeoff].sort((a, b) => b.score - a.score);
  const chosenModelRegistryId =
    sortedTradeoff.length > 0 ? sortedTradeoff[0]!.modelRegistryId : '';

  return {
    eligibleSet: eligibilityDecisions,
    ranking,
    tradeoff: sortedTradeoff,
    chosenModelRegistryId,
    phaseTrace,
  };
}

// ---------------------------------------------------------------------------
// Phase-order proof export (AI-AC-04 — the unit-test contract)
// ---------------------------------------------------------------------------

/**
 * The ordered routing phases (§4). Used by the AI-AC-04 unit test to
 * assert the phase order explicitly (the phases execute in this exact
 * order: eligibility → ranking → tradeoff → selection). Inlined here
 * (not imported from public.ts) to avoid a circular import.
 */
export const ROUTING_PHASE_ORDER: readonly RoutingPhase[] = [
  'eligibility',
  'ranking',
  'tradeoff',
  'selection',
];

/**
 * The ordered hard-eligibility reasons (§4 priority order: privacy → policy
 * → capability → quota → subscription → availability). Used by the AI-AC-04
 * unit test to assert the eligibility-phase priority order. Inlined here
 * (not imported from public.ts) to avoid a circular import.
 */
export const ELIGIBILITY_REASON_PRIORITY: readonly EligibilityReason[] = [
  'privacy',
  'policy',
  'capability',
  'quota',
  'subscription',
  'availability',
];
