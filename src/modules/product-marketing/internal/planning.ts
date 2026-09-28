/**
 * The /product-marketing PLANNING CORE — the pure, deterministic selection
 * engine (MKT-070: "choose social platform mix, target metrics, content
 * strategy, attribution and experiment plan for a product-marketing
 * mission" — auditable, evidence-linked decisions).
 *
 * PURITY CONTRACT: every exported function here is PURE — the same inputs
 * always produce the same outputs, no I/O, no clock, no randomness. This
 * is what makes IDEMPOTENT REPLANNING hold: the same mission state +
 * evidence snapshot → the same plan (the deterministic input digest is
 * derived from exactly these inputs), and any plan change is a RECORDED
 * deliberate change (the inputs changed — new product context, new health
 * verdicts, new analyses — and the new version cites them).
 *
 * FABRICATION RESISTANCE IS STRUCTURAL: the core can only cite record ids
 * present in its input snapshot — a citation of a record that was not
 * referenced is INEXPRESSIBLE (the citations are derived from the input
 * records, never composed from anything else).
 *
 * THE EVIDENCE-TIER RULE (§7): only EVIDENCE-BACKED product-intelligence
 * derived models and research insights INFLUENCE decisions; unverified
 * records are counted as present-but-non-influencing and disclosed —
 * never silently scored as established facts.
 */

import { InvalidRequestError } from '../../../platform/errors/errors.ts';
import type {
  ComposedProductMarketingPlan,
  PlannerAttributionPlan,
  PlannerCitation,
  PlannerContentHypothesisSnapshot,
  PlannerContentStrategy,
  PlannerDecisionEntry,
  PlannerExperimentPlan,
  PlannerHealthEvaluationSnapshot,
  PlannerInput,
  PlannerMetricPlanEntry,
  PlannerPlatformPortfolioEntry,
  PlannerProductContextSnapshot,
  PlannerResearchSnapshot,
} from '../public.ts';
import type {
  ProductMarketingAttributionMethod,
  ProductMarketingContentProfile,
  ProductMarketingInclusionTier,
  ProductMarketingMetricName,
  ProductMarketingPlatformClass,
} from '../public.ts';
import {
  PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
  PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
  PRODUCT_MARKETING_STRATEGY_VERSION,
} from '../public.ts';
import type { ProductMarketingPlatformClassTable } from '../public.ts';
import { classifyPlatformForProductMarketing } from '../public.ts';

// ---------------------------------------------------------------------------
// The frozen scoring constants (pm-plan-v1 — part of the strategy version)
// ---------------------------------------------------------------------------

/** The base score every non-excluded candidate platform starts from. */
export const PRODUCT_MARKETING_BASE_PLATFORM_SCORE = 10;

/**
 * The health states that EXCLUDE an account from the mix outright (the
 * §11 descriptive states a product-marketing plan must respect: a
 * restricted, publishing-blocked or authorization-blocked account is
 * excluded — with the verdict cited, never silently).
 */
export const PRODUCT_MARKETING_EXCLUDED_HEALTH_STATES = [
  'restricted',
  'publishing_blocked',
  'authorization_blocked',
] as const;

/**
 * The deterministic health-state score modifiers (deprioritization — the
 * verdict is always cited on the entry).
 */
export const PRODUCT_MARKETING_HEALTH_SCORE_MODIFIERS: Readonly<Record<string, number>> = {
  healthy: 0,
  degraded: -3,
  quota_limited: -4,
  suspected_distribution_anomaly: -5,
  suspected_automation_risk: -6,
  human_review_required: -7,
};

// ---------------------------------------------------------------------------
// The citation helper (the only way citations are ever built)
// ---------------------------------------------------------------------------

/** Builds one typed citation (the single citation constructor). */
export function cite(kind: PlannerCitation['kind'], refId: string): PlannerCitation {
  return { kind, refId };
}

function dedupeCitations(citations: readonly PlannerCitation[]): readonly PlannerCitation[] {
  const seen = new Set<string>();
  const out: PlannerCitation[] = [];
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
// The deterministic input digest (the idempotent-replanning anchor)
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
 * BOUNDED string over the observable planning inputs. Same world → same
 * digest (the full id lists are hashed to fixed-width tokens; the lists
 * themselves ride the version's input snapshot).
 */
export function computePlannerInputDigest(input: PlannerInput): string {
  const mission = input.mission;
  const context = input.productContext;
  const research = input.research;
  const evaluations = input.healthEvaluations;
  const analyses = input.experimentAnalyses;
  const allocations = input.allocationRecommendations;
  const hypotheses = input.contentHypotheses;

  return [
    `v=${PRODUCT_MARKETING_STRATEGY_VERSION}`,
    `m=${mission.missionId}:${mission.versionSeq}:${mission.objectiveFamily}:${mission.status}`,
    `g=[${sortedIds(mission.goalRefs.map((goal) => goal.goalId)).join(',')}]`,
    `pc=${context.productContextId}:${context.currentVersionSeq}`,
    `pi=[${sortedIds(context.inputs.map((entry) => entry.inputId)).join(',')}]`,
    `pf=${context.sourceFacts.length}:${stableIdListHash(sortedIds(context.sourceFacts.map((fact) => fact.sourceFactId)))}`,
    `pm=${context.derivedModels.length}:${stableIdListHash(sortedIds(context.derivedModels.map((model) => model.derivedModelId)))}`,
    `pr=${context.riskFlags.length}:${stableIdListHash(sortedIds(context.riskFlags.map((flag) => flag.riskFlagId)))}`,
    research === null
      ? 'rs=null'
      : `rs=${research.researchSessionId}:${research.currentVersionSeq}:${research.insights.length}:${stableIdListHash(sortedIds(research.insights.map((insight) => insight.researchInsightId)))}`,
    `he=${evaluations.length}:${stableIdListHash(sortedIds(evaluations.map((entry) => `${entry.socialAccountId}:${entry.evaluationId}`)))}`,
    `ea=${analyses.length}:${stableIdListHash(sortedIds(analyses.map((entry) => entry.analysisId)))}`,
    `ar=${allocations.length}:${stableIdListHash(sortedIds(allocations.map((entry) => entry.recommendationId)))}`,
    `ch=${hypotheses.length}:${stableIdListHash(sortedIds(hypotheses.map((entry) => entry.contentHypothesisId)))}`,
  ].join('|');
}

// ---------------------------------------------------------------------------
// The product signals (the URL/code context → deterministic signals)
// ---------------------------------------------------------------------------

/**
 * The deterministic product signals derived from the cited
 * /product-intelligence context (pm-plan-v1). Every signal is derived
 * ONLY from record-derived facts; only EVIDENCE-BACKED derived models
 * count toward the influence signals (the §7 discipline).
 */
export interface ProductSignals {
  /** A declared source_repository/source_workspace input exists (the CODE-context signal). */
  readonly hasCodeContext: boolean;
  /** A declared catalog_inventory/current_analytics input exists (the commerce signal). */
  readonly hasCommerceContext: boolean;
  /** A declared product_site_url/product_document input exists (the public-site signal). */
  readonly hasPublicSiteContext: boolean;
  /** EVIDENCE-BACKED derived-model counts by derivation kind (influence signals). */
  readonly contentWorthyFeatures: number;
  readonly marketLanguageModels: number;
  readonly icpAudienceHypotheses: number;
  readonly valuePropositions: number;
  readonly commercialMetricsModels: number;
  /** Risk flags at high/critical severity (the risk-pressure signal). */
  readonly highSeverityRiskFlags: number;
  /** EVIDENCE-BACKED research-insight count of the attached session. */
  readonly researchInsights: number;
}

/**
 * Derives the deterministic product signals from the product context and
 * the optional research session (PURE). The cited records are returned
 * alongside so every signal's evidence basis is citable.
 */
export function deriveProductSignals(
  context: PlannerProductContextSnapshot,
  research: PlannerResearchSnapshot | null,
): {
  readonly signals: ProductSignals;
  /** The evidence-backed derived models that influence decisions (citable, with their backing facts). */
  readonly influencingModels: readonly {
    derivedModelId: string;
    derivationKind: string;
    evidenceSourceFactIds: readonly string[];
  }[];
  /** The evidence-backed research insights that influence decisions (citable). */
  readonly influencingInsights: readonly { researchInsightId: string }[];
  /** The declared inputs that produced the context signals (citable). */
  readonly contextInputs: readonly { inputId: string; kind: string }[];
  /** The high-severity risk flags (citable, with their backing facts). */
  readonly highSeverityFlags: readonly {
    riskFlagId: string;
    category: string;
    severity: string;
    evidenceSourceFactIds: readonly string[];
  }[];
} {
  const influencingModels = context.derivedModels
    .filter((model) => model.verificationState === 'evidence_backed')
    .map((model) => ({
      derivedModelId: model.derivedModelId,
      derivationKind: model.derivationKind,
      evidenceSourceFactIds: [...model.evidenceSourceFactIds],
    }));
  const influencingInsights =
    research === null
      ? []
      : research.insights
          .filter((insight) => insight.verificationState === 'evidence_backed')
          .map((insight) => ({ researchInsightId: insight.researchInsightId }));

  const countKind = (kind: string): number =>
    influencingModels.filter((model) => model.derivationKind === kind).length;

  const CODE_INPUT_KINDS = new Set(['source_repository', 'source_workspace']);
  const COMMERCE_INPUT_KINDS = new Set(['catalog_inventory', 'current_analytics']);
  const SITE_INPUT_KINDS = new Set(['product_site_url', 'product_document']);

  const contextInputs = context.inputs.map((input) => ({ inputId: input.inputId, kind: input.kind }));
  const highSeverityFlags = context.riskFlags
    .filter((flag) => flag.severity === 'high' || flag.severity === 'critical')
    .map((flag) => ({
      riskFlagId: flag.riskFlagId,
      category: flag.category,
      severity: flag.severity,
      evidenceSourceFactIds: [...flag.evidenceSourceFactIds],
    }));

  const signals: ProductSignals = {
    hasCodeContext: context.inputs.some((input) => CODE_INPUT_KINDS.has(input.kind)),
    hasCommerceContext: context.inputs.some((input) => COMMERCE_INPUT_KINDS.has(input.kind)),
    hasPublicSiteContext: context.inputs.some((input) => SITE_INPUT_KINDS.has(input.kind)),
    contentWorthyFeatures: countKind('content_worthy_features'),
    marketLanguageModels: countKind('market_language'),
    icpAudienceHypotheses: countKind('icp_audience_hypotheses'),
    valuePropositions: countKind('value_propositions'),
    commercialMetricsModels: countKind('commercial_metrics'),
    highSeverityRiskFlags: highSeverityFlags.length,
    researchInsights: influencingInsights.length,
  };

  return { signals, influencingModels, influencingInsights, contextInputs, highSeverityFlags };
}

// ---------------------------------------------------------------------------
// The platform-portfolio composition (the auditable platform mix)
// ---------------------------------------------------------------------------

/**
 * Selects the LATEST evaluation per account (deterministic: evaluatedAt
 * DESC, evaluationId ASC as the stable tiebreak — the input list is the
 * client's full evaluation tail).
 */
export function latestEvaluationPerAccount(
  evaluations: readonly PlannerHealthEvaluationSnapshot[],
): readonly PlannerHealthEvaluationSnapshot[] {
  const latest = new Map<string, PlannerHealthEvaluationSnapshot>();
  for (const evaluation of evaluations) {
    const current = latest.get(evaluation.socialAccountId);
    if (
      current === undefined ||
      evaluation.evaluatedAt > current.evaluatedAt ||
      (evaluation.evaluatedAt === current.evaluatedAt &&
        evaluation.evaluationId < current.evaluationId)
    ) {
      latest.set(evaluation.socialAccountId, evaluation);
    }
  }
  return [...latest.values()].sort(
    (a, b) => (a.platformId < b.platformId ? -1 : a.platformId > b.platformId ? 1 : 0),
  );
}

/** The context multiplier of one platform class under the product signals (PURE). */
function contextMultiplier(
  platformClass: string,
  signals: ProductSignals,
): { multiplier: number; basis: string } {
  if (signals.hasCodeContext) {
    const table: Readonly<Record<string, number>> = {
      text: 1.5,
      long_video: 1.1,
      image: 0.8,
      short_video: 0.7,
      unknown: 1.0,
    };
    return {
      multiplier: table[platformClass] ?? 1.0,
      basis: 'code-context product (cited source_repository/source_workspace input)',
    };
  }
  if (signals.hasCommerceContext) {
    const table: Readonly<Record<string, number>> = {
      short_video: 1.3,
      image: 1.2,
      long_video: 1.0,
      text: 0.9,
      unknown: 1.0,
    };
    return {
      multiplier: table[platformClass] ?? 1.0,
      basis: 'commerce-context product (cited catalog_inventory/current_analytics input)',
    };
  }
  return { multiplier: 1.0, basis: 'neutral product context' };
}

/** Computes the deterministic platform portfolio (PURE — the heart of the mix decision). */
function composePlatformPortfolio(
  input: PlannerInput,
  signals: ProductSignals,
  citedInputs: readonly { inputId: string; kind: string }[],
  platformClasses: ProductMarketingPlatformClassTable,
): readonly PlannerPlatformPortfolioEntry[] {
  const candidates = latestEvaluationPerAccount(input.healthEvaluations);
  // The internal mutable draft (the output entries are readonly — the
  // tier pass assigns inclusion + shares before the frozen mapping).
  const entries: {
    platformId: string;
    socialAccountId: string;
    evaluationId: string;
    healthState: string;
    platformClass: ProductMarketingPlatformClass;
    inclusion: ProductMarketingInclusionTier;
    score: number;
    weightShareBps: number;
    rationale: string;
    citations: readonly PlannerCitation[];
  }[] = [];

  for (const evaluation of candidates) {
    const platformClass = classifyPlatformForProductMarketing(evaluation.platformId, platformClasses);
    const healthCitation = cite('platform_health_evaluation', evaluation.evaluationId);
    const citations: PlannerCitation[] = [healthCitation];
    for (const contextInput of citedInputs) {
      citations.push(cite('product_input', contextInput.inputId));
    }

    if ((PRODUCT_MARKETING_EXCLUDED_HEALTH_STATES as readonly string[]).includes(evaluation.state)) {
      entries.push({
        platformId: evaluation.platformId,
        socialAccountId: evaluation.socialAccountId,
        evaluationId: evaluation.evaluationId,
        healthState: evaluation.state,
        platformClass,
        inclusion: 'excluded',
        score: 0,
        weightShareBps: 0,
        rationale:
          `Excluded: the cited platform-health evaluation records state '${evaluation.state}' ` +
          `(confidence ${evaluation.confidence}, reason codes: ${evaluation.reasonCodes.join(', ') || 'none'}) — ` +
          `a restricted, publishing-blocked or authorization-blocked account is excluded from the product-marketing mix with the verdict cited, never silently.`,
        citations,
      });
      continue;
    }

    const healthModifier =
      PRODUCT_MARKETING_HEALTH_SCORE_MODIFIERS[evaluation.state] ?? 0;
    const { multiplier, basis } = contextMultiplier(platformClass, signals);
    const score = Math.max(
      1,
      Math.round((PRODUCT_MARKETING_BASE_PLATFORM_SCORE + healthModifier) * multiplier),
    );

    entries.push({
      platformId: evaluation.platformId,
      socialAccountId: evaluation.socialAccountId,
      evaluationId: evaluation.evaluationId,
      healthState: evaluation.state,
      platformClass,
      inclusion: 'secondary', // reassigned by the tier pass below
      score,
      weightShareBps: 0,
      rationale:
        `Scored ${score}: base ${PRODUCT_MARKETING_BASE_PLATFORM_SCORE} with health modifier ` +
        `${healthModifier >= 0 ? '+' : ''}${healthModifier} (cited evaluation state '${evaluation.state}', ` +
        `confidence ${evaluation.confidence}) × class multiplier ${multiplier.toFixed(2)} for platform class ` +
        `'${platformClass}' under a ${basis}.`,
      citations,
    });
  }

  // The tier pass: rank by score DESC (platformId ASC as the stable
  // tiebreak), then the evidence-richness rule fixes the primary count.
  const nonExcluded = entries
    .filter((entry) => entry.inclusion !== 'excluded')
    .sort(
      (a, b) => b.score - a.score || (a.platformId < b.platformId ? -1 : 1),
    );
  const primaryCount = Math.min(
    nonExcluded.length,
    1 +
      (signals.contentWorthyFeatures >= 2 ? 1 : 0) +
      (signals.researchInsights >= 2 ? 1 : 0) +
      (!signals.hasCodeContext && signals.marketLanguageModels >= 2 ? 1 : 0),
  );

  // The weight shares: primaries hold 80% of the mix, secondaries 20%
  // (integer basis points; the LAST entry of each tier absorbs the
  // rounding remainder so the total is always exactly 10000 — a tier with
  // no counterpart absorbs the full mix).
  const primaries = nonExcluded.slice(0, primaryCount);
  const secondaries = nonExcluded.slice(primaryCount);
  const assignShares = (
    tierEntries: readonly (typeof entries)[number][],
    totalBps: number,
    inclusion: 'primary' | 'secondary',
  ): void => {
    if (tierEntries.length === 0) return;
    const per = Math.floor(totalBps / tierEntries.length);
    let assigned = 0;
    tierEntries.forEach((entry, index) => {
      const isLast = index === tierEntries.length - 1;
      const share = isLast ? totalBps - assigned : per;
      assigned += share;
      entry.inclusion = inclusion;
      entry.weightShareBps = share;
    });
  };
  const primaryTotal =
    primaries.length === 0 ? 0 : secondaries.length === 0 ? 10000 : 8000;
  assignShares(primaries, primaryTotal, 'primary');
  assignShares(secondaries, 10000 - primaryTotal, 'secondary');

  // The deterministic output order: excluded entries first (the honest
  // disclosures), then primaries by rank, then secondaries by rank.
  return [
    ...entries.filter((entry) => entry.inclusion === 'excluded'),
    ...primaries,
    ...secondaries,
  ];
}

// ---------------------------------------------------------------------------
// The metric plan (the frozen objective-family vocabulary, goal-wired)
// ---------------------------------------------------------------------------

/** Rounds to an integer, half away from zero (deterministic). */
function roundHalfAway(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Computes the deterministic metric plan (PURE — pm-metrics-v1 formulas). */
function composeMetricPlan(
  input: PlannerInput,
  signals: ProductSignals,
  portfolio: readonly PlannerPlatformPortfolioEntry[],
  influencingModels: readonly {
    derivedModelId: string;
    derivationKind: string;
    evidenceSourceFactIds: readonly string[];
  }[],
  highSeverityFlags: readonly {
    riskFlagId: string;
    evidenceSourceFactIds: readonly string[];
  }[],
): readonly PlannerMetricPlanEntry[] {
  const goalRefs = input.mission.goalRefs.map((goal) => goal.goalId);
  const primaryCount = portfolio.filter((entry) => entry.inclusion === 'primary').length;
  const nonExcludedCount = portfolio.filter((entry) => entry.inclusion !== 'excluded').length;

  // The deterministic health/risk factors (cited to the evaluations/flags):
  // any non-excluded platform below 'healthy' reduces the reach posture.
  const anyNonHealthy = portfolio.some(
    (entry) => entry.inclusion !== 'excluded' && entry.healthState !== 'healthy',
  );
  const healthFactor = anyNonHealthy ? 0.7 : 1.0;
  const riskFactor = signals.highSeverityRiskFlags > 0 ? 0.8 : 1.0;

  // The model citations carry their BACKING FACTS (the audit trail the
  // acceptance demands: WHICH product-intelligence facts produced the
  // decision — every cited model's retained source facts ride along).
  const modelCitations = (kinds: readonly string[]): readonly PlannerCitation[] => {
    const out: PlannerCitation[] = [];
    for (const model of influencingModels.filter((entry) => kinds.includes(entry.derivationKind))) {
      out.push(cite('product_derived_model', model.derivedModelId));
      for (const factId of model.evidenceSourceFactIds) {
        out.push(cite('product_source_fact', factId));
      }
    }
    return dedupeCitations(out);
  };
  const riskCitations: readonly PlannerCitation[] = highSeverityFlags.map((flag) =>
    cite('product_risk_flag', flag.riskFlagId),
  );
  const evaluationCitations: readonly PlannerCitation[] = portfolio
    .filter((entry) => entry.inclusion !== 'excluded' && entry.healthState !== 'healthy')
    .map((entry) => cite('platform_health_evaluation', entry.evaluationId));

  const cap = (value: number): number => Math.min(value, 4);

  const qualifiedSiteVisits = roundHalfAway(
    (500 + 250 * cap(signals.contentWorthyFeatures) + 150 * cap(signals.valuePropositions)) *
      healthFactor *
      riskFactor,
  );
  const attributableConversions = roundHalfAway(
    (40 + 20 * cap(signals.commercialMetricsModels) + 10 * cap(signals.icpAudienceHypotheses)) *
      (signals.hasCommerceContext ? 1.5 : 1.0) *
      riskFactor,
  );
  const engagedReach = roundHalfAway(
    2000 * Math.max(primaryCount, 1) * (1 + 0.25 * cap(signals.marketLanguageModels)),
  );
  const engagementRate = roundHalfAway((4 + 0.5 * cap(signals.icpAudienceHypotheses)) * 10) / 10;

  return [
    {
      metric: 'qualified_site_visits',
      comparator: '>=',
      targetValue: qualifiedSiteVisits,
      unit: 'count',
      intermediate: false,
      goalRefs,
      rationale:
        `pm-plan-v1 formula: (500 + 250×content_worthy_features[${cap(signals.contentWorthyFeatures)}] + ` +
        `150×value_propositions[${cap(signals.valuePropositions)}]) × health_factor ${healthFactor.toFixed(2)} × ` +
        `risk_factor ${riskFactor.toFixed(2)} = ${qualifiedSiteVisits}. The scaling records are cited; the metric ` +
        `is wired to the mission's existing mapped goals BY REFERENCE (progress is owned by the Goal authority).`,
      citations: [
        ...modelCitations(['content_worthy_features', 'value_propositions']),
        ...evaluationCitations,
        ...riskCitations,
      ],
    },
    {
      metric: 'attributable_conversions',
      comparator: '>=',
      targetValue: attributableConversions,
      unit: 'count',
      intermediate: false,
      goalRefs,
      rationale:
        `pm-plan-v1 formula: (40 + 20×commercial_metrics[${cap(signals.commercialMetricsModels)}] + ` +
        `10×icp_audience_hypotheses[${cap(signals.icpAudienceHypotheses)}]) × commerce_factor ` +
        `${signals.hasCommerceContext ? '1.50' : '1.00'} × risk_factor ${riskFactor.toFixed(2)} = ` +
        `${attributableConversions}. The scaling records are cited; the terminal decision basis stays the ` +
        `mission's declared business objective family.`,
      citations: [
        ...modelCitations(['commercial_metrics', 'icp_audience_hypotheses']),
        ...riskCitations,
      ],
    },
    {
      metric: 'engaged_platform_reach',
      comparator: '>=',
      targetValue: engagedReach,
      unit: 'count',
      intermediate: true,
      goalRefs,
      rationale:
        `pm-plan-v1 formula: 2000 × primary_platforms[${Math.max(primaryCount, 1)}] × ` +
        `(1 + 0.25×market_language[${cap(signals.marketLanguageModels)}]) = ${engagedReach} — an INTERMEDIATE ` +
        `optimization signal over ${nonExcludedCount} non-excluded platform(s), never a terminal-decision basis.`,
      citations: modelCitations(['market_language']),
    },
    {
      metric: 'content_engagement_rate',
      comparator: '>=',
      targetValue: engagementRate,
      unit: 'percent',
      intermediate: true,
      goalRefs,
      rationale:
        `pm-plan-v1 formula: 4 + 0.5×icp_audience_hypotheses[${cap(signals.icpAudienceHypotheses)}] = ` +
        `${engagementRate}% — an INTERMEDIATE optimization signal, never a terminal-decision basis.`,
      citations: modelCitations(['icp_audience_hypotheses']),
    },
  ];
}

// ---------------------------------------------------------------------------
// The content strategy (the profile selection + the pillars)
// ---------------------------------------------------------------------------

/** Computes the deterministic content strategy (PURE). */
function composeContentStrategy(
  input: PlannerInput,
  signals: ProductSignals,
  citedInputs: readonly { inputId: string; kind: string }[],
  influencingModels: readonly {
    derivedModelId: string;
    derivationKind: string;
    evidenceSourceFactIds: readonly string[];
  }[],
  influencingInsights: readonly { researchInsightId: string }[],
  hypotheses: readonly PlannerContentHypothesisSnapshot[],
): PlannerContentStrategy {
  // The model citations carry their BACKING FACTS (the audit trail the
  // acceptance demands: WHICH product-intelligence facts produced the
  // decision — every cited model's retained source facts ride along).
  const modelCitations = (kinds: readonly string[]): readonly PlannerCitation[] => {
    const out: PlannerCitation[] = [];
    for (const model of influencingModels.filter((entry) => kinds.includes(entry.derivationKind))) {
      out.push(cite('product_derived_model', model.derivedModelId));
      for (const factId of model.evidenceSourceFactIds) {
        out.push(cite('product_source_fact', factId));
      }
    }
    return dedupeCitations(out);
  };
  const inputCitations: readonly PlannerCitation[] = citedInputs.map((contextInput) =>
    cite('product_input', contextInput.inputId),
  );
  // The research insights + content hypotheses influence the strategy
  // through the pillars AND the portfolio tier structure (the
  // evidence-richness primary-count rule) — they are cited on the
  // content-strategy decision whenever present and evidence-backed.
  const insightCitations: readonly PlannerCitation[] = influencingInsights.map((insight) =>
    cite('research_insight', insight.researchInsightId),
  );
  const hypothesisCitations: readonly PlannerCitation[] = hypotheses.map((hypothesis) =>
    cite('content_hypothesis', hypothesis.contentHypothesisId),
  );

  let profile: ProductMarketingContentProfile;
  let rationale: string;
  let citations: readonly PlannerCitation[];

  if (signals.hasCodeContext) {
    profile = 'technical_authority';
    rationale =
      'technical_authority profile: the cited product context declares an authorized source_repository/' +
      'source_workspace input (the code-context signal) — the strategy prioritizes developer-relevant ' +
      'long-form and text-class distribution with verifiable technical claims.';
    citations = [
      ...inputCitations,
      ...modelCitations(['content_worthy_features']),
      ...insightCitations,
      ...hypothesisCitations,
    ];
  } else if (signals.hasCommerceContext) {
    profile = 'conversion_focused';
    rationale =
      'conversion_focused profile: the cited product context declares catalog_inventory/current_analytics ' +
      'inputs (the commerce signal) with commercial-metrics models — the strategy prioritizes ' +
      'product-demonstration content and offer-led formats.';
    citations = [
      ...inputCitations,
      ...modelCitations(['commercial_metrics', 'value_propositions']),
      ...insightCitations,
      ...hypothesisCitations,
    ];
  } else if (signals.contentWorthyFeatures + signals.marketLanguageModels >= 2) {
    profile = 'broad_reach_visual';
    rationale =
      `broad_reach_visual profile: the cited product context carries rich marketing evidence ` +
      `(${signals.contentWorthyFeatures} evidence-backed content_worthy_features and ` +
      `${signals.marketLanguageModels} market_language models) — the strategy prioritizes ` +
      'high-reach visual formats built from the cited content-worthy features.';
    citations = [
      ...modelCitations(['content_worthy_features', 'market_language', 'icp_audience_hypotheses']),
      ...insightCitations,
      ...hypothesisCitations,
    ];
  } else {
    profile = 'community_narrative';
    rationale =
      'community_narrative profile (the honest default): the cited product context carries neither the ' +
      'code signal, the commerce signal, nor sufficient evidence-backed marketing models for a ' +
      'reach-led profile — the strategy prioritizes community-building narrative content while the ' +
      'evidence base grows.';
    citations = [
      ...modelCitations(['icp_audience_hypotheses']),
      ...insightCitations,
      ...hypothesisCitations,
    ];
  }

  const pillars: string[] = [];
  const modelKinds = new Set(influencingModels.map((model) => model.derivationKind));
  if (modelKinds.has('content_worthy_features')) pillars.push('content_worthy_features');
  if (modelKinds.has('value_propositions')) pillars.push('value_propositions');
  if (modelKinds.has('market_language')) pillars.push('market_language');
  if (influencingInsights.length > 0) pillars.push('research_insights');
  if (hypotheses.length > 0) pillars.push('content_hypotheses');
  if (pillars.length === 0) pillars.push('declared_mission_objective');

  const formatPriorities: string[] =
    profile === 'technical_authority'
      ? ['text_thread', 'long_form_video', 'document_walkthrough']
      : profile === 'conversion_focused'
        ? ['product_demo_short_video', 'carousel_image', 'offer_post']
        : profile === 'broad_reach_visual'
          ? ['short_video', 'image', 'carousel_image']
          : ['narrative_post', 'community_reply', 'image'];

  return {
    profile,
    pillars,
    formatPriorities,
    rationale:
      rationale +
      (influencingInsights.length > 0
        ? ` The attached research session contributes ${influencingInsights.length} evidence-backed insight(s) (cited).`
        : ' No evidence-backed research insight influences this profile (no session attached or none evidence-backed).') +
      (hypotheses.length > 0
        ? ` ${hypotheses.length} current content-intelligence hypothesis/hypotheses inform the pillars (cited).`
        : ' No current content-intelligence hypothesis informs the pillars (the honest cold start).'),
    citations,
  };
}

// ---------------------------------------------------------------------------
// The attribution plan (what will be measured + how — never causal truth)
// ---------------------------------------------------------------------------

/** Computes the deterministic attribution plan (PURE). */
function composeAttributionPlan(
  portfolio: readonly PlannerPlatformPortfolioEntry[],
): PlannerAttributionPlan {
  const primaries = portfolio.filter((entry) => entry.inclusion === 'primary');
  const method: ProductMarketingAttributionMethod =
    primaries.length >= 2 ? 'attribution_id_linear_multi_touch' : 'attribution_id_last_touch';
  const nonExcluded = portfolio.filter((entry) => entry.inclusion !== 'excluded');

  const measuredSurfaces = nonExcluded.map((entry) => ({
    surface: `platform:${entry.platformId}`,
    description:
      `the account ${entry.socialAccountId} platform analytics series (the 'social.' metric namespace ` +
      `observations) with the propagated attribution id attached to every published item`,
  }));

  const citations: readonly PlannerCitation[] = primaries.map((entry) =>
    cite('platform_health_evaluation', entry.evaluationId),
  );

  return {
    method,
    measuredSurfaces,
    disclosure: PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
    rationale:
      `pm-attribution-v1: ${primaries.length >= 2 ? 'two or more primary platforms — linear multi-touch' : 'one primary platform — last-touch'} ` +
      `credit over the propagated attribution ids (the deterministic method selection over the cited ` +
      `portfolio verdicts). The plan declares WHAT will be measured and HOW attribution will be computed — ` +
      `attribution is distinct from causality; no causal truth is claimed.`,
    citations,
  };
}

// ---------------------------------------------------------------------------
// The bounded experiment plan (DATA toward the Growth Operator)
// ---------------------------------------------------------------------------

/** Computes the deterministic bounded experiment plan (PURE). */
function composeExperimentPlan(
  input: PlannerInput,
  contentStrategy: PlannerContentStrategy,
): PlannerExperimentPlan {
  const analyses = input.experimentAnalyses;
  const allocations = input.allocationRecommendations;
  const primaryMetric: ProductMarketingMetricName = 'qualified_site_visits';

  const analysisCitations: readonly PlannerCitation[] = analyses.map((analysis) =>
    cite('experiment_analysis', analysis.analysisId),
  );
  const allocationCitations: readonly PlannerCitation[] = allocations.map((allocation) =>
    cite('allocation_recommendation', allocation.recommendationId),
  );

  const hypothesis =
    `The '${contentStrategy.profile}' content strategy on the planned platform mix increases ` +
    `${primaryMetric} for the declared product-marketing objective versus the current mix.`;

  const latestAnalysis = analyses[0] ?? null;
  const latestAllocation = allocations[0] ?? null;

  const rationale =
    analyses.length === 0 || latestAnalysis === null
      ? 'cold start: no prior experiment-analysis result exists for the pursuit client — the bounded ' +
        'experiment is exploratory with the recorded defaults (nothing fabricated: the empty analysis ' +
        'set is the honest basis).'
      : `informed by ${analyses.length} prior experiment-analysis result(s) (newest first, cited): the newest ` +
        `records outcome '${latestAnalysis.outcome}' with recommended next allocation ` +
        `'${latestAnalysis.recommendedNextAllocation}'` +
        (latestAnalysis.effectEstimate === null ? '' : ` and effect estimate ${latestAnalysis.effectEstimate}`) +
        '.' +
        (latestAllocation === null
          ? ' No allocation recommendation informs the arm split (none recorded).'
          : ` The latest allocation recommendation (cited) leaves exploration over the eligible arms ` +
            `${latestAllocation.eligibleArms.join(', ')}.`);

  return {
    hypothesis,
    primaryMetric,
    treatmentArm: 'strategy_mix_v1',
    comparisonArm: 'current_mix',
    assignmentMethod: 'random',
    analysisMethod: 'two_sample_means_v1',
    stopCriteria:
      'minimum 30 observations per arm (the recorded experiment-analysis default) or a negative ' +
      'effect at the 0.95 uncertainty level — the honest stop, never a silent retry',
    boundedBy: 'growth-operator',
    disclosure: PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
    rationale:
      rationale +
      ' The plan is DATA: the Growth Operator declares the bounded next experiment through the EXISTING ' +
      '/experiments authority (its bounded-experiment rules); this planner creates no experiment.',
    citations: [...analysisCitations, ...allocationCitations],
  };
}

// ---------------------------------------------------------------------------
// The plan composition (the single pure entry point)
// ---------------------------------------------------------------------------

/**
 * Composes the complete product-marketing plan (PURE, deterministic — the
 * heart of auditable planning): derives the product signals from the
 * cited records, composes the platform portfolio (health-gated,
 * product-signal-scored under the composition-supplied platform-class
 * DATA), the metric plan (the frozen family vocabulary, goal-wired by
 * reference), the content strategy, the attribution plan and the bounded
 * experiment plan — every decision carrying its citation basis built
 * EXCLUSIVELY from the input snapshot's record ids.
 */
export function composeProductMarketingPlanCore(
  input: PlannerInput,
  platformClasses: ProductMarketingPlatformClassTable,
): ComposedProductMarketingPlan {
  const { signals, influencingModels, influencingInsights, contextInputs, highSeverityFlags } =
    deriveProductSignals(input.productContext, input.research);

  const platformPortfolio = composePlatformPortfolio(input, signals, contextInputs, platformClasses);
  const metricPlan = composeMetricPlan(
    input,
    signals,
    platformPortfolio,
    influencingModels,
    highSeverityFlags,
  );
  const contentStrategy = composeContentStrategy(
    input,
    signals,
    contextInputs,
    influencingModels,
    influencingInsights,
    input.contentHypotheses,
  );
  const attributionPlan = composeAttributionPlan(platformPortfolio);
  const experimentPlan = composeExperimentPlan(input, contentStrategy);

  const decisions: readonly PlannerDecisionEntry[] = [
    ...platformPortfolio.map(
      (entry): PlannerDecisionEntry => ({
        decisionKey: `platform:${entry.platformId}:${entry.socialAccountId}`,
        summary: `${entry.inclusion} (${entry.weightShareBps} bps, score ${entry.score})`,
        rationale: entry.rationale,
        citations: entry.citations,
      }),
    ),
    ...metricPlan.map(
      (entry): PlannerDecisionEntry => ({
        decisionKey: `metric:${entry.metric}`,
        summary: `${entry.metric} ${entry.comparator} ${entry.targetValue} ${entry.unit}`,
        rationale: entry.rationale,
        citations: entry.citations,
      }),
    ),
    {
      decisionKey: 'content_strategy',
      summary: contentStrategy.profile,
      rationale: contentStrategy.rationale,
      citations: contentStrategy.citations,
    },
    {
      decisionKey: 'attribution_plan',
      summary: attributionPlan.method,
      rationale: attributionPlan.rationale,
      citations: attributionPlan.citations,
    },
    {
      decisionKey: 'experiment_plan',
      summary: `${experimentPlan.primaryMetric} bounded experiment (growth-operator bounded)`,
      rationale: experimentPlan.rationale,
      citations: experimentPlan.citations,
    },
  ];

  const citations = dedupeCitations([
    ...platformPortfolio.flatMap((entry) => entry.citations),
    ...metricPlan.flatMap((entry) => entry.citations),
    ...contentStrategy.citations,
    ...attributionPlan.citations,
    ...experimentPlan.citations,
  ]);

  return {
    strategyVersion: PRODUCT_MARKETING_STRATEGY_VERSION,
    inputDigest: computePlannerInputDigest(input),
    platformPortfolio,
    metricPlan,
    contentStrategy,
    attributionPlan,
    experimentPlan,
    decisions,
    citations,
  };
}

// ---------------------------------------------------------------------------
// The input guards (the house validation discipline)
// ---------------------------------------------------------------------------

/** Validates the server-derived provenance (never a request field). */
export function assertValidProductMarketingProvenance(
  provenance: ProductMarketingProvenanceShape,
): void {
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
    throw new InvalidRequestError('invalid product-marketing provenance', problems);
  }
}

interface ProductMarketingProvenanceShape {
  readonly actor: unknown;
  readonly recordedVia: unknown;
  readonly correlationId: unknown;
  readonly causationId: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validates the compose input (the durable references + the REQUIRED reason). */
export function assertValidComposeProductMarketingPlanInput(input: {
  readonly missionId: unknown;
  readonly productContextId: unknown;
  readonly pursuitWorkspaceId: unknown;
  readonly researchSessionId: unknown;
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
  if (
    input.researchSessionId !== null &&
    (typeof input.researchSessionId !== 'string' || !UUID_PATTERN.test(input.researchSessionId))
  ) {
    problems.push('researchSessionId: null or a uuid');
  }
  if (typeof input.reason !== 'string' || input.reason.length < 1 || input.reason.length > 4000) {
    problems.push('reason: required, 1..4000 characters');
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('invalid compose-product-marketing-plan input', problems);
  }
}
