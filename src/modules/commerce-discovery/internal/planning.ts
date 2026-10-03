/**
 * The /commerce-discovery PLANNING CORE — the pure, deterministic
 * selection/guardrail/outcome engine (MKT-072: "discover viable
 * products/niches, test demand via social experiments, recommend listing
 * candidates and learn from actual orders" — auditable, evidence-linked
 * decisions with economic guardrails).
 *
 * PURITY CONTRACT: every exported function here is PURE — the same inputs
 * always produce the same outputs, no I/O, no clock, no randomness. This
 * is what makes IDEMPOTENT RECOMPOSITION hold: the same mission state +
 * evidence snapshot + declared bounds → the same plan (the deterministic
 * input digest is derived from exactly these inputs), and any plan change
 * is a RECORDED deliberate change (the inputs changed — new product
 * context, new candidates, new health verdicts — and the new version
 * cites them).
 *
 * FABRICATION RESISTANCE IS STRUCTURAL: the core can only cite record ids
 * present in its input snapshot — a citation of a record that was not
 * referenced is INEXPRESSIBLE (the citations are derived from the input
 * records, never composed from anything else).
 *
 * THE EVIDENCE-TIER RULE (§7): only EVIDENCE-BACKED product-intelligence
 * derived models INFLUENCE decisions; unverified records are counted as
 * present-but-non-influencing and disclosed — never silently scored as
 * established facts.
 *
 * THE ORDER-TRUTH RULE (§15/§16): the outcome core derives observed values
 * ONLY from the real provider-ingested commerce-event shapes — never a
 * simulated sale, never a causal claim (attribution is distinct from
 * causality).
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  ComposedCommerceDiscoveryPlan,
  CommerceDiscoveryDeclaredBounds,
  CommerceDiscoveryDerivedExperimentDesign,
  CommerceDiscoveryBreachReason,
  CommerceDiscoveryGuardrailVerdict,
  CommerceDiscoveryRecommendation,
  CommerceDiscoveryViabilityVerdict,
  DiscoveryCandidateProposalEntry,
  DiscoveryCitation,
  DiscoveryDemandTestPlan,
  DiscoveryDecisionEntry,
  DiscoveryEconomicGates,
  DiscoveryInput,
  DiscoveryNicheSelectionEntry,
} from '../public.ts';
import {
  COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE,
  COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  COMMERCE_DISCOVERY_STRATEGY_VERSION,
} from '../public.ts';

// ---------------------------------------------------------------------------
// The frozen scoring constants (cd-plan-v1 — part of the strategy version)
// ---------------------------------------------------------------------------

/** The base score every observed niche starts from. */
export const COMMERCE_DISCOVERY_BASE_NICHE_SCORE = 10;

/** The per-unique-content-candidate niche boost (bounded). */
export const COMMERCE_DISCOVERY_CANDIDATE_COUNT_BOOST = 3;
export const COMMERCE_DISCOVERY_CANDIDATE_COUNT_BOOST_MAX = 12;

/**
 * The deterministic audience-fit score modifiers (the §6 observed-signal
 * vocabulary — the signal state, never an inference).
 */
export const COMMERCE_DISCOVERY_AUDIENCE_FIT_MODIFIERS: Readonly<Record<string, number>> = {
  strong_fit: 8,
  moderate_fit: 4,
  weak_fit: 0,
  unclear: 0,
};

/** The deterministic freshness score modifiers. */
export const COMMERCE_DISCOVERY_FRESHNESS_MODIFIERS: Readonly<Record<string, number>> = {
  breaking: 5,
  recent: 4,
  established: 2,
  evergreen: 3,
  dated: 0,
};

/** The deterministic novelty score modifiers. */
export const COMMERCE_DISCOVERY_NOVELTY_MODIFIERS: Readonly<Record<string, number>> = {
  novel: 4,
  variation: 2,
  common: 0,
  saturated: -4,
};

/** The deterministic reuse-risk score modifiers. */
export const COMMERCE_DISCOVERY_REUSE_RISK_MODIFIERS: Readonly<Record<string, number>> = {
  low: 2,
  medium: 0,
  high: -6,
  unclear: 0,
};

/**
 * The evidence-backed product-signal model kinds that boost a niche (the
 * product-side input — only EVIDENCE-BACKED models count, the §7 rule).
 */
export const COMMERCE_DISCOVERY_PRODUCT_SIGNAL_MODEL_KINDS = [
  'icp_audience_hypotheses',
  'value_propositions',
  'market_language',
  'commercial_metrics',
] as const;

/** The per-evidence-backed-product-signal-model niche boost (bounded). */
export const COMMERCE_DISCOVERY_PRODUCT_SIGNAL_BOOST = 2;
export const COMMERCE_DISCOVERY_PRODUCT_SIGNAL_BOOST_MAX = 8;

/**
 * The health states that PENALIZE a niche's platform risk (the §11
 * descriptive states — the verdict is always cited on the entry, never a
 * silent deprioritization).
 */
export const COMMERCE_DISCOVERY_RISKY_HEALTH_STATES = [
  'restricted',
  'publishing_blocked',
  'authorization_blocked',
  'suspected_distribution_anomaly',
] as const;

/** The per-risky-health-evaluation niche penalty (bounded). */
export const COMMERCE_DISCOVERY_HEALTH_PENALTY = 5;
export const COMMERCE_DISCOVERY_HEALTH_PENALTY_MAX = 10;

/** The per-prior-experiment-analysis niche boost (bounded — the tested-ground signal). */
export const COMMERCE_DISCOVERY_ANALYSIS_BOOST = 1;
export const COMMERCE_DISCOVERY_ANALYSIS_BOOST_MAX = 3;

/** The maximum number of ranked niche-selection entries emitted. */
export const COMMERCE_DISCOVERY_NICHE_SELECTION_LIMIT = 8;

/** The maximum number of candidate proposals emitted. */
export const COMMERCE_DISCOVERY_PROPOSAL_LIMIT = 12;

/** The score floor (scores never go below zero). */
const SCORE_FLOOR = 0;

// ---------------------------------------------------------------------------
// The citation helper (the only way citations are ever built)
// ---------------------------------------------------------------------------

/** Builds one typed citation (the single citation constructor). */
export function cite(kind: DiscoveryCitation['kind'], refId: string): DiscoveryCitation {
  return { kind, refId };
}

function dedupeCitations(citations: readonly DiscoveryCitation[]): readonly DiscoveryCitation[] {
  const seen = new Set<string>();
  const out: DiscoveryCitation[] = [];
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.refId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(citation);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The deterministic input digest (the idempotent-recomposition anchor)
// ---------------------------------------------------------------------------

/** The stable bounded hash of an id list (FNV-1a 32-bit — the strategy-space precedent). */
function stableIdListHash(ids: readonly string[]): string {
  let hash = 0x811c9dc5;
  const joined = ids.join(',');
  for (let index = 0; index < joined.length; index++) {
    hash ^= joined.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sortedIds(ids: readonly string[]): readonly string[] {
  return [...ids].sort();
}

/**
 * Computes the DETERMINISTIC input digest — a canonical, order-stable,
 * BOUNDED string over the observable discovery inputs + the declared
 * bounds. Same world → same digest (the full id lists are hashed to
 * fixed-width tokens; the lists themselves ride the version's input
 * snapshot).
 */
export function computeDiscoveryInputDigest(input: DiscoveryInput): string {
  const mission = input.mission;
  const context = input.productContext;
  const candidates = input.contentCandidates;
  const hypotheses = input.contentHypotheses;
  const evaluations = input.healthEvaluations;
  const analyses = input.experimentAnalyses;
  const declared = input.declared;

  return [
    `v=${COMMERCE_DISCOVERY_STRATEGY_VERSION}`,
    `m=${mission.missionId}:${mission.versionSeq}:${mission.objectiveFamily}:${mission.status}`,
    `g=[${sortedIds(mission.goalRefs.map((goal) => goal.goalId)).join(',')}]`,
    `pc=${context.productContextId}:${context.currentVersionSeq}`,
    `pm=${context.derivedModels.length}:${stableIdListHash(sortedIds(context.derivedModels.map((model) => model.derivedModelId)))}`,
    `pr=${context.riskFlags.length}:${stableIdListHash(sortedIds(context.riskFlags.map((flag) => flag.riskFlagId)))}`,
    `cc=${candidates.length}:${stableIdListHash(sortedIds(candidates.map((entry) => entry.contentCandidateId)))}`,
    `ch=${hypotheses.length}:${stableIdListHash(sortedIds(hypotheses.map((entry) => entry.contentHypothesisId)))}`,
    `he=${evaluations.length}:${stableIdListHash(sortedIds(evaluations.map((entry) => `${entry.socialAccountId}:${entry.evaluationId}`)))}`,
    `ea=${analyses.length}:${stableIdListHash(sortedIds(analyses.map((entry) => entry.analysisId)))}`,
    `d=${declared.spendCurrency}:${declared.testBudgetMinorUnits}:${declared.maxDemandTests}:${declared.minOrderCountForViability}`,
  ].join('|');
}

// ---------------------------------------------------------------------------
// The niche selection core (the market/niche ranking — every entry cited)
// ---------------------------------------------------------------------------

interface NicheScore {
  readonly niche: string;
  readonly subNiches: readonly string[];
  readonly score: number;
  readonly audienceFit: string;
  readonly freshness: string;
  readonly rationale: string;
  readonly citations: readonly DiscoveryCitation[];
}

function boundedAdd(total: number, addend: number, max: number): number {
  return Math.min(total + addend, max);
}

/**
 * Derives the deterministic niche scores from the record-derived snapshot
 * (cd-plan-v1): content candidates grouped by niche (audience-fit,
 * freshness, novelty and reuse-risk modifiers + the candidate-count
 * boost), the EVIDENCE-BACKED product-signal models boosting every niche
 * (the product-side input — the §7 rule: unverified models never
 * influence), the risky health evaluations penalizing (cited, never
 * silent), and the prior experiment analyses as the tested-ground signal.
 */
export function deriveNicheScores(input: DiscoveryInput): readonly NicheScore[] {
  // The evidence-backed product-signal models (the §7 evidence tier).
  const productSignalModels = input.productContext.derivedModels.filter(
    (model) =>
      model.verificationState === 'evidence_backed' &&
      (COMMERCE_DISCOVERY_PRODUCT_SIGNAL_MODEL_KINDS as readonly string[]).includes(
        model.derivationKind,
      ),
  );
  const productSignalCitations = productSignalModels.map((model) =>
    cite('product_derived_model', model.derivedModelId),
  );
  const productSignalBoost = Math.min(
    productSignalModels.length * COMMERCE_DISCOVERY_PRODUCT_SIGNAL_BOOST,
    COMMERCE_DISCOVERY_PRODUCT_SIGNAL_BOOST_MAX,
  );

  // The risky health evaluations (the platform-risk penalty — cited).
  const riskyEvaluations = input.healthEvaluations.filter((evaluation) =>
    (COMMERCE_DISCOVERY_RISKY_HEALTH_STATES as readonly string[]).includes(evaluation.state),
  );
  const healthPenalty = Math.min(
    riskyEvaluations.length * COMMERCE_DISCOVERY_HEALTH_PENALTY,
    COMMERCE_DISCOVERY_HEALTH_PENALTY_MAX,
  );
  const healthCitations = riskyEvaluations.map((evaluation) =>
    cite('platform_health_evaluation', evaluation.evaluationId),
  );

  // The prior experiment analyses (the tested-ground signal — cited).
  const analysisBoost = Math.min(
    input.experimentAnalyses.length * COMMERCE_DISCOVERY_ANALYSIS_BOOST,
    COMMERCE_DISCOVERY_ANALYSIS_BOOST_MAX,
  );
  const analysisCitations = input.experimentAnalyses.map((analysis) =>
    cite('experiment_analysis', analysis.analysisId),
  );

  // Group the content candidates by niche (deterministic order).
  const byNiche = new Map<string, DiscoveryInput['contentCandidates'][number][]>();
  for (const candidate of input.contentCandidates) {
    const key = candidate.niche.toLowerCase();
    const existing = byNiche.get(key);
    if (existing === undefined) {
      byNiche.set(key, [candidate]);
    } else {
      existing.push(candidate);
    }
  }

  const scores: NicheScore[] = [];
  for (const nicheCandidates of byNiche.values()) {
    const citations: DiscoveryCitation[] = nicheCandidates.map((candidate) =>
      cite('content_candidate', candidate.contentCandidateId),
    );

    let score = COMMERCE_DISCOVERY_BASE_NICHE_SCORE;
    score = boundedAdd(
      score,
      nicheCandidates.length * COMMERCE_DISCOVERY_CANDIDATE_COUNT_BOOST,
      COMMERCE_DISCOVERY_CANDIDATE_COUNT_BOOST_MAX,
    );

    // The deterministic signal modifiers (best-observed per niche).
    let audienceFit = 'unclear';
    let freshness = 'dated';
    for (const candidate of nicheCandidates) {
      if (
        (COMMERCE_DISCOVERY_AUDIENCE_FIT_MODIFIERS[candidate.audienceFit] ?? 0) >
        (COMMERCE_DISCOVERY_AUDIENCE_FIT_MODIFIERS[audienceFit] ?? 0)
      ) {
        audienceFit = candidate.audienceFit;
      }
      if (
        (COMMERCE_DISCOVERY_FRESHNESS_MODIFIERS[candidate.freshness] ?? 0) >
        (COMMERCE_DISCOVERY_FRESHNESS_MODIFIERS[freshness] ?? 0)
      ) {
        freshness = candidate.freshness;
      }
      score += COMMERCE_DISCOVERY_NOVELTY_MODIFIERS[candidate.novelty] ?? 0;
      score += COMMERCE_DISCOVERY_REUSE_RISK_MODIFIERS[candidate.reuseRisk] ?? 0;
    }
    score += COMMERCE_DISCOVERY_AUDIENCE_FIT_MODIFIERS[audienceFit] ?? 0;
    score += COMMERCE_DISCOVERY_FRESHNESS_MODIFIERS[freshness] ?? 0;

    // The product-side + risk + tested-ground signals (cited).
    score += productSignalBoost;
    score -= healthPenalty;
    score += analysisBoost;
    citations.push(...productSignalCitations, ...healthCitations, ...analysisCitations);

    const subNiches = [
      ...new Set(
        nicheCandidates
          .map((candidate) => candidate.subNiche)
          .filter((subNiche): subNiche is string => subNiche !== null),
      ),
    ].sort();

    const topicEntities = [
      ...new Set(nicheCandidates.map((candidate) => candidate.topicEntity)),
    ].sort();

    scores.push({
      niche: nicheCandidates[0]!.niche,
      subNiches,
      score: Math.max(score, SCORE_FLOOR),
      audienceFit,
      freshness,
      rationale:
        `niche '${nicheCandidates[0]!.niche}' scored from ${nicheCandidates.length} observed content ` +
        `candidate(s) (best audience-fit '${audienceFit}', best freshness '${freshness}')` +
        (topicEntities.length > 0 ? ` around ${topicEntities.slice(0, 3).join(', ')}` : '') +
        `, boosted by ${productSignalModels.length} evidence-backed product-signal model(s)` +
        (riskyEvaluations.length > 0
          ? `, penalized by ${riskyEvaluations.length} risky platform-health evaluation(s)`
          : '') +
        (input.experimentAnalyses.length > 0
          ? `, with ${input.experimentAnalyses.length} prior experiment analysis record(s) as tested ground`
          : ''),
      citations,
    });
  }

  // Deterministic order: score DESC, then niche ASC.
  return [...scores].sort((a, b) => b.score - a.score || a.niche.localeCompare(b.niche));
}

/**
 * Composes the ranked niche selection (the weight shares over the ranked
 * top set — basis points, deterministic).
 */
function composeNicheSelection(scores: readonly NicheScore[]): readonly DiscoveryNicheSelectionEntry[] {
  const ranked = scores.slice(0, COMMERCE_DISCOVERY_NICHE_SELECTION_LIMIT);
  const totalScore = ranked.reduce((sum, entry) => sum + entry.score, 0);
  let allocated = 0;
  return ranked.map((entry, index) => {
    let weightShareBps = 0;
    if (totalScore > 0) {
      if (index === ranked.length - 1) {
        // The last entry absorbs the remainder (the deterministic sum
        // guarantee: the ranked set sums to exactly 10000).
        weightShareBps = 10000 - allocated;
      } else {
        weightShareBps = Math.floor((entry.score / totalScore) * 10000);
        allocated += weightShareBps;
      }
    }
    return {
      niche: entry.niche,
      subNiches: entry.subNiches,
      score: entry.score,
      weightShareBps,
      audienceFit: entry.audienceFit,
      freshness: entry.freshness,
      rationale: entry.rationale,
      citations: entry.citations,
    };
  });
}

// ---------------------------------------------------------------------------
// The candidate-proposal derivation (recommendations as DATA)
// ---------------------------------------------------------------------------

/**
 * Derives the listing-candidate proposals from the ranked niches and the
 * cited signals (cd-plan-v1): the top-ranked niches × the evidence-backed
 * product-signal models + the CURRENT content hypotheses → bounded,
 * scored, cited proposals — recorded DATA toward the human listing
 * decision, never an auto-listing.
 */
function deriveCandidateProposals(
  input: DiscoveryInput,
  scores: readonly NicheScore[],
): readonly DiscoveryCandidateProposalEntry[] {
  const proposals: DiscoveryCandidateProposalEntry[] = [];
  const productSignalModels = input.productContext.derivedModels.filter(
    (model) =>
      model.verificationState === 'evidence_backed' &&
      (COMMERCE_DISCOVERY_PRODUCT_SIGNAL_MODEL_KINDS as readonly string[]).includes(
        model.derivationKind,
      ),
  );
  const productName = input.productContext.name ?? 'the product';

  for (const niche of scores.slice(0, 3)) {
    // One proposal per top niche, product-signal-angled.
    const angleModel =
      productSignalModels.find((model) => model.derivationKind === 'value_propositions') ??
      productSignalModels[0];
    const hypothesis = input.contentHypotheses[0];
    const citations: DiscoveryCitation[] = [...niche.citations];
    if (angleModel !== undefined) {
      citations.push(cite('product_derived_model', angleModel.derivedModelId));
    }
    if (hypothesis !== undefined) {
      citations.push(cite('content_hypothesis', hypothesis.contentHypothesisId));
    }
    proposals.push({
      label: `${productName} for ${niche.niche}`,
      niche: niche.niche,
      subNiche: niche.subNiches[0] ?? null,
      angle:
        angleModel !== undefined
          ? `position ${productName} through the evidence-backed ${angleModel.derivationKind.replace(/_/g, ' ')} signal inside the '${niche.niche}' niche`
          : `position ${productName} inside the '${niche.niche}' niche on the observed content signals`,
      score: niche.score,
      rationale:
        `derived from the ranked niche score ${niche.score} (audience-fit '${niche.audienceFit}', ` +
        `freshness '${niche.freshness}') with ` +
        (angleModel !== undefined
          ? `the evidence-backed product-signal model ${angleModel.derivedModelId}`
          : 'no evidence-backed product-signal model') +
        (hypothesis !== undefined
          ? ` and the current content hypothesis ${hypothesis.contentHypothesisId}`
          : ''),
      citations,
    });
    if (proposals.length >= COMMERCE_DISCOVERY_PROPOSAL_LIMIT) break;
  }

  return proposals;
}

// ---------------------------------------------------------------------------
// The demand-test plan + the derived experiment design (cd-plan-v1)
// ---------------------------------------------------------------------------

/**
 * Composes the derived demand-test plan — the experiment design TEMPLATE
 * the demand-test arm instantiates through the /experiments authority.
 */
function composeDemandTestPlan(
  input: DiscoveryInput,
  scores: readonly NicheScore[],
): DiscoveryDemandTestPlan {
  const topNiche = scores[0];
  const citations: DiscoveryCitation[] = topNiche === undefined ? [] : [...topNiche.citations];
  for (const analysis of input.experimentAnalyses) {
    citations.push(cite('experiment_analysis', analysis.analysisId));
  }
  return {
    designTemplate: {
      designType: 'randomized',
      primaryMetric: 'observed_order_count',
      guardrailMetrics: ['observed_order_value'],
      analysisMethod: 'two-sample means comparison',
      analysisMethodVersion: COMMERCE_DISCOVERY_STRATEGY_VERSION,
      expectedDirection: 'increase',
      minimumEvidenceRequirement: 'A — randomized experiment',
      uncertaintyRepresentation: 'interval',
    },
    stopCriteriaTemplate:
      `stop when the recorded demand-test spend reaches the declared test budget of ` +
      `${input.declared.testBudgetMinorUnits} minor units ${input.declared.spendCurrency} or the ` +
      `minimum order count gate of ${input.declared.minOrderCountForViability} is observed`,
    boundedBy: 'experiments-authority',
    disclosure: COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE,
    rationale:
      'the demand-test design template is derived deterministically from the ranked selection and the declared bounds; every demand test is created THROUGH the existing experiments authority (no second experiment engine)' +
      (input.experimentAnalyses.length > 0
        ? ` with ${input.experimentAnalyses.length} prior analysis record(s) as context`
        : ''),
    citations: dedupeCitations(citations),
  };
}

/**
 * Derives ONE concrete experiment design for a candidate demand test (the
 * cd-plan-v1 template instantiated with the candidate + the declared
 * bounds). Deterministic and total: the same candidate + bounds always
 * produce the same design payload.
 */
export function deriveDemandTestDesign(input: {
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly missionId: string;
  readonly candidate: {
    readonly label: string;
    readonly niche: string;
    readonly demandHypothesis: string;
  };
  readonly declared: CommerceDiscoveryDeclaredBounds;
}): CommerceDiscoveryDerivedExperimentDesign {
  const dimensions = {
    mission: input.missionId,
    candidate: input.candidate.label,
    niche: input.candidate.niche,
  };
  return {
    clientId: input.clientId,
    workspaceId: input.workspaceId,
    hypothesis: `Demand test for ${input.candidate.label}: ${input.candidate.demandHypothesis}`,
    decisionTarget: `Whether to recommend listing ${input.candidate.label} in niche ${input.candidate.niche}`,
    populationUnit: 'audience member in the selected niche',
    treatment: `social content featuring ${input.candidate.label}`,
    comparison: 'social content without the product feature',
    assignmentMethod: 'random assignment per audience member',
    designType: 'randomized',
    primaryMetric: { name: 'observed_order_count', dimensions },
    guardrails: [{ name: 'observed_order_value', dimensions }],
    analysisMethod: 'two-sample means comparison',
    analysisMethodVersion: COMMERCE_DISCOVERY_STRATEGY_VERSION,
    expectedDirection: 'increase',
    startCriteria: null,
    stopCriteria:
      `stop when the recorded demand-test spend reaches the declared test budget of ` +
      `${input.declared.testBudgetMinorUnits} minor units ${input.declared.spendCurrency} or the ` +
      `minimum order count gate of ${input.declared.minOrderCountForViability} is observed`,
    minimumEvidenceRequirement: 'A — randomized experiment',
    uncertaintyRepresentation: 'interval',
  };
}

// ---------------------------------------------------------------------------
// The guardrail core (cd-guardrails-v1 — the acceptance's core)
// ---------------------------------------------------------------------------

/** The pure guardrail evaluation input (declared bounds vs REAL observations). */
export interface GuardrailEvaluationInput {
  readonly declared: {
    readonly spendCurrency: string;
    readonly testBudgetMinorUnits: number;
    readonly maxDemandTests: number;
  };
  readonly observed: {
    readonly spendMinorUnits: number;
    readonly demandTestCount: number;
    readonly orderCount: number;
  };
}

/** The pure guardrail evaluation output. */
export interface GuardrailEvaluationOutput {
  readonly verdict: CommerceDiscoveryGuardrailVerdict;
  readonly breachReasons: readonly CommerceDiscoveryBreachReason[];
  readonly rationale: string;
}

/**
 * Evaluates the frozen cd-guardrails-v1 ruleset deterministically:
 *   - observed spend > declared test budget → 'spend_exceeds_test_budget';
 *   - observed demand-test count > declared max → 'demand_tests_exceed_limit';
 *   - any breach → verdict 'breached' (the module transitions the program
 *     to 'guardrail_blocked' — never a silent continue).
 * The observed order count is carried as the economic context of the
 * rationale (no order-count breach exists: orders are outcomes, not
 * spend).
 */
export function evaluateGuardrailsCore(input: GuardrailEvaluationInput): GuardrailEvaluationOutput {
  const breachReasons: CommerceDiscoveryBreachReason[] = [];
  if (input.observed.spendMinorUnits > input.declared.testBudgetMinorUnits) {
    breachReasons.push('spend_exceeds_test_budget');
  }
  if (input.observed.demandTestCount > input.declared.maxDemandTests) {
    breachReasons.push('demand_tests_exceed_limit');
  }
  const verdict = breachReasons.length > 0 ? 'breached' : 'within_bounds';
  return {
    verdict,
    breachReasons,
    rationale:
      `observed spend ${input.observed.spendMinorUnits} minor units ${input.declared.spendCurrency} ` +
      `against the declared budget ${input.declared.testBudgetMinorUnits}; observed demand-test count ` +
      `${input.observed.demandTestCount} against the declared maximum ${input.declared.maxDemandTests}; ` +
      `observed order count ${input.observed.orderCount} (economic context) — verdict ${verdict}` +
      (breachReasons.length > 0 ? ` (breaches: ${breachReasons.join(', ')})` : ''),
  };
}

// ---------------------------------------------------------------------------
// The outcome core (the learning loop over the REAL commerce events)
// ---------------------------------------------------------------------------

/** One real commerce order event as derived from the /integrations projection. */
export interface DiscoveryOrderEventInput {
  readonly commerceEventId: string;
  readonly eventKind: string;
  readonly providerSubjectId: string;
  readonly receivedAt: string;
  /** The normalized order payload (status, currency, total — the authority's shape). */
  readonly order: {
    readonly orderStatus: string;
    readonly currency: string;
    readonly total: number;
  };
}

/** The pure outcome derivation output. */
export interface DerivedOutcome {
  readonly observedOrderCount: number;
  readonly observedCancelledOrderCount: number;
  readonly observedOrderValues: Readonly<Record<string, number>>;
  readonly viabilityVerdict: CommerceDiscoveryViabilityVerdict;
  readonly listingRecommendation: CommerceDiscoveryRecommendation;
  readonly rationale: string;
}

/**
 * DERIVES the learning-loop outcome from the REAL order events (never a
 * simulated sale): the distinct non-cancelled order count (the LATEST
 * event per provider order subject wins — order.updated/order.fulfilled
 * supersede order.created; cancelled orders are disclosed separately),
 * the per-currency value sums with NO cross-currency aggregation, the
 * viability verdict against the declared economic gates and the listing
 * recommendation AS DATA.
 */
export function deriveOutcomeCore(input: {
  readonly declared: { readonly minOrderCountForViability: number };
  readonly candidateLabel: string;
  readonly orderEvents: readonly DiscoveryOrderEventInput[];
}): DerivedOutcome {
  // The latest event per provider order subject (deterministic: receivedAt
  // DESC, then commerceEventId DESC as the tie-break).
  const latestBySubject = new Map<string, DiscoveryOrderEventInput>();
  for (const event of [...input.orderEvents].sort(
    (a, b) =>
      b.receivedAt.localeCompare(a.receivedAt) ||
      b.commerceEventId.localeCompare(a.commerceEventId),
  )) {
    if (!latestBySubject.has(event.providerSubjectId)) {
      latestBySubject.set(event.providerSubjectId, event);
    }
  }

  let observedOrderCount = 0;
  let observedCancelledOrderCount = 0;
  const orderValues = new Map<string, number>();
  for (const event of latestBySubject.values()) {
    if (event.order.orderStatus.toLowerCase() === 'cancelled') {
      observedCancelledOrderCount += 1;
      continue;
    }
    observedOrderCount += 1;
    const currency = event.order.currency.toUpperCase();
    orderValues.set(currency, (orderValues.get(currency) ?? 0) + event.order.total);
  }

  let viabilityVerdict: CommerceDiscoveryViabilityVerdict;
  let listingRecommendation: CommerceDiscoveryRecommendation;
  if (input.orderEvents.length === 0) {
    viabilityVerdict = 'insufficient_observations';
    listingRecommendation = 'recommend_iteration';
  } else if (observedOrderCount >= input.declared.minOrderCountForViability) {
    viabilityVerdict = 'viable';
    listingRecommendation = 'recommend_listing';
  } else {
    viabilityVerdict = 'not_viable';
    listingRecommendation = 'do_not_list';
  }

  const currencySummary =
    orderValues.size === 0
      ? 'no order value observed'
      : [...orderValues.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, value]) => `${currency} ${value}`)
          .join(', ');

  return {
    observedOrderCount,
    observedCancelledOrderCount,
    observedOrderValues: Object.fromEntries([...orderValues.entries()].sort(([a], [b]) => a.localeCompare(b))),
    viabilityVerdict,
    listingRecommendation,
    rationale:
      `${observedOrderCount} distinct non-cancelled order(s) observed for candidate '${input.candidateLabel}' ` +
      `across ${input.orderEvents.length} cited commerce event(s) ` +
      `(${observedCancelledOrderCount} cancelled, disclosed separately; ${currencySummary}; ` +
      `no cross-currency aggregation) — the viability gate of ` +
      `${input.declared.minOrderCountForViability} minimum observed order(s) is ` +
      `${viabilityVerdict === 'viable' ? 'passed' : viabilityVerdict === 'not_viable' ? 'not met' : 'undecidable (no observations)'}; ` +
      `the listing recommendation '${listingRecommendation}' is recorded data toward a human decision ` +
      `(attribution is distinct from causality — no causal claim is made)`,
  };
}

// ---------------------------------------------------------------------------
// The composed plan (the complete deterministic selection output)
// ---------------------------------------------------------------------------

/**
 * Composes the complete discovery plan from the record-derived input
 * snapshot (cd-plan-v1): the ranked niche selection, the candidate
 * proposals, the demand-test plan, the composed economic gates and the
 * auditable decision entries — every emitted row carrying its citations
 * (which records produced it).
 */
export function composeCommerceDiscoveryPlanCore(
  input: DiscoveryInput,
): ComposedCommerceDiscoveryPlan {
  const nicheScores = deriveNicheScores(input);
  const nicheSelection = composeNicheSelection(nicheScores);
  const candidateProposals = deriveCandidateProposals(input, nicheScores);
  const demandTestPlan = composeDemandTestPlan(input, nicheScores);

  const economicGates: DiscoveryEconomicGates = {
    spendCurrency: input.declared.spendCurrency,
    testBudgetMinorUnits: input.declared.testBudgetMinorUnits,
    maxDemandTests: input.declared.maxDemandTests,
    minOrderCountForViability: input.declared.minOrderCountForViability,
    disclosure: COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  };

  const decisions: DiscoveryDecisionEntry[] = [
    {
      decisionKey: 'niche_selection',
      summary:
        nicheSelection.length === 0
          ? 'no niche selected (no content candidates observed)'
          : `top niche '${nicheSelection[0]!.niche}' with weight ${nicheSelection[0]!.weightShareBps} bps`,
      rationale:
        nicheSelection.length === 0
          ? 'the pursuit client has no observed content-intelligence candidates — the selection is honestly empty and the discovery program records candidates manually until observations exist'
          : nicheSelection[0]!.rationale,
      citations: nicheSelection.length === 0 ? [] : [...nicheSelection[0]!.citations],
    },
    {
      decisionKey: 'candidate_proposals',
      summary: `${candidateProposals.length} listing-candidate proposal(s) derived`,
      rationale:
        candidateProposals.length === 0
          ? 'no proposals derivable (no ranked niches or no evidence-backed product signals)'
          : candidateProposals
              .map((proposal) => `${proposal.label} (score ${proposal.score})`)
              .join('; '),
      citations: dedupeCitations(candidateProposals.flatMap((proposal) => proposal.citations)),
    },
    {
      decisionKey: 'economic_gates',
      summary: `budget ${input.declared.testBudgetMinorUnits} minor units ${input.declared.spendCurrency}, max ${input.declared.maxDemandTests} demand tests, viability gate ${input.declared.minOrderCountForViability} order(s)`,
      rationale:
        'the declared bounded-spend bounds compose the economic gates every demand-test launch is pre-gated against and every guardrail evaluation is evaluated on (fail-closed: no launch without a current version; no launch that exceeds the remaining budget)',
      citations: [],
    },
  ];

  const citations = dedupeCitations([
    ...nicheSelection.flatMap((entry) => entry.citations),
    ...candidateProposals.flatMap((proposal) => proposal.citations),
    ...demandTestPlan.citations,
  ]);

  return {
    strategyVersion: COMMERCE_DISCOVERY_STRATEGY_VERSION,
    inputDigest: computeDiscoveryInputDigest(input),
    nicheSelection,
    candidateProposals,
    demandTestPlan,
    economicGates,
    decisions,
    citations,
  };
}

// ---------------------------------------------------------------------------
// The input guards (pure validation)
// ---------------------------------------------------------------------------

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Za-z]{3,8}$/;

/** Validates the DECLARED bounded-spend bounds (the honest seams). */
export function assertValidDeclaredBounds(declared: {
  readonly spendCurrency: unknown;
  readonly testBudgetMinorUnits: unknown;
  readonly maxDemandTests: unknown;
  readonly minOrderCountForViability: unknown;
}): void {
  const problems: string[] = [];
  if (
    typeof declared.spendCurrency !== 'string' ||
    !CURRENCY_PATTERN.test(declared.spendCurrency)
  ) {
    problems.push('declared.spendCurrency: required, 3..8 letters (no FX authority exists — a spend in another currency is honestly refused)');
  }
  if (
    typeof declared.testBudgetMinorUnits !== 'number' ||
    !Number.isInteger(declared.testBudgetMinorUnits) ||
    declared.testBudgetMinorUnits < 0 ||
    declared.testBudgetMinorUnits > 2000000000
  ) {
    problems.push('declared.testBudgetMinorUnits: required integer 0..2000000000 (minor units)');
  }
  if (
    typeof declared.maxDemandTests !== 'number' ||
    !Number.isInteger(declared.maxDemandTests) ||
    declared.maxDemandTests < 1 ||
    declared.maxDemandTests > 50
  ) {
    problems.push('declared.maxDemandTests: required integer 1..50');
  }
  if (
    typeof declared.minOrderCountForViability !== 'number' ||
    !Number.isInteger(declared.minOrderCountForViability) ||
    declared.minOrderCountForViability < 1 ||
    declared.minOrderCountForViability > 1000
  ) {
    problems.push('declared.minOrderCountForViability: required integer 1..1000');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid commerce-discovery declared bounds', problems);
  }
}

/** Validates the compose input (the durable references + the declared bounds + the REQUIRED reason). */
export function assertValidComposeCommerceDiscoveryPlanInput(input: {
  readonly missionId: unknown;
  readonly productContextId: unknown;
  readonly pursuitWorkspaceId: unknown;
  readonly storeConnectionId: unknown;
  readonly declared: unknown;
  readonly reason: unknown;
}): void {
  const problems: string[] = [];
  if (typeof input.missionId !== 'string' || !UUID_PATTERN.test(input.missionId)) {
    problems.push('missionId: required uuid');
  }
  if (typeof input.productContextId !== 'string' || !UUID_PATTERN.test(input.productContextId)) {
    problems.push('productContextId: required uuid');
  }
  if (
    typeof input.pursuitWorkspaceId !== 'string' ||
    !UUID_PATTERN.test(input.pursuitWorkspaceId)
  ) {
    problems.push('pursuitWorkspaceId: required uuid');
  }
  if (typeof input.storeConnectionId !== 'string' || !UUID_PATTERN.test(input.storeConnectionId)) {
    problems.push('storeConnectionId: required uuid');
  }
  if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
    problems.push('reason: required, 1..4000 characters');
  }
  if (
    typeof input.declared !== 'object' ||
    input.declared === null ||
    typeof (input.declared as { spendCurrency?: unknown }).spendCurrency !== 'string'
  ) {
    problems.push('declared: required bounded-spend bounds object');
  } else {
    try {
      assertValidDeclaredBounds(input.declared as Parameters<typeof assertValidDeclaredBounds>[0]);
    } catch (error) {
      if (error instanceof InvalidRequestError) {
        problems.push(...(error.details ?? []).map((detail) => `declared.${detail}`));
      } else {
        throw error;
      }
    }
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid compose-commerce-discovery-plan input', problems);
  }
}

/** Validates the server-derived provenance (never a request field). */
export function assertValidCommerceDiscoveryProvenance(provenance: {
  readonly actor: unknown;
  readonly recordedVia: unknown;
  readonly correlationId: unknown;
  readonly causationId: unknown;
}): void {
  const problems: string[] = [];
  if (
    typeof provenance.actor !== 'string' ||
    provenance.actor.length === 0 ||
    provenance.actor.length > 100
  ) {
    problems.push('provenance.actor: required, 1..100 characters');
  }
  if (
    typeof provenance.recordedVia !== 'string' ||
    provenance.recordedVia.length === 0 ||
    provenance.recordedVia.length > 100
  ) {
    problems.push('provenance.recordedVia: required, 1..100 characters');
  }
  if (typeof provenance.correlationId !== 'string' || provenance.correlationId.length === 0) {
    problems.push('provenance.correlationId: required');
  }
  if (provenance.causationId !== null && typeof provenance.causationId !== 'string') {
    problems.push('provenance.causationId: null or a string');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid commerce-discovery provenance', problems);
  }
}
