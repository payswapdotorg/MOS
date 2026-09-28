/**
 * MKT-070 unit tests — the pure deterministic planning core of
 * /product-marketing: the pm-plan-v1 product-signal derivation, the
 * platform-portfolio scoring (health-gated, product-signal-scored), the
 * frozen objective-family metric vocabulary + formulas, the
 * content-strategy profiles, the attribution plan (distinct from
 * causality) and the bounded experiment plan — plus the acceptance
 * properties at the pure-core level:
 *
 *   (a) DETERMINISM: the same inputs always compose the same plan (the
 *       same input digest, the same portfolio, the same metric plan);
 *   (b) THE ACCEPTANCE: a different product URL/code context produces a
 *       different (or differently-scored) platform portfolio + a
 *       different metric plan — with the influencing records cited;
 *   (c) PLATFORM-HEALTH RESPECT: a restricted/publishing_blocked/
 *       authorization_blocked account is EXCLUDED with the verdict
 *       evaluation cited (never silently); degraded states deprioritize;
 *   (d) FABRICATION RESISTANCE: every emitted citation references a
 *       record id present in the input snapshot (a citation of an
 *       unreferenced record is structurally impossible);
 *   (e) THE EVIDENCE TIER: unverified derived models and research
 *       insights NEVER influence (the §7 claim discipline);
 *   (f) GOAL WIRING BY REFERENCE: the metric plan carries the mission's
 *       mapped goal ids as references and re-computes nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_MARKETING_STRATEGY_VERSION,
  PRODUCT_MARKETING_VOCABULARY_VERSION,
  PRODUCT_MARKETING_PLANNER_FAMILY,
  PRODUCT_MARKETING_INCLUSION_TIERS,
  PRODUCT_MARKETING_CONTENT_PROFILES,
  PRODUCT_MARKETING_ATTRIBUTION_METHODS,
  PRODUCT_MARKETING_METRIC_NAMES,
  PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE,
  PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE,
  PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE,
  classifyPlatformForProductMarketing,
  type ProductMarketingPlatformClassTable,
  composeProductMarketingPlanCore,
  computePlannerInputDigest,
  deriveProductSignals,
  assertValidProductMarketingProvenance,
  assertValidComposeProductMarketingPlanInput,
  type PlannerInput,
  type PlannerCitation,
} from '../../src/modules/product-marketing/public.ts';

// ---------------------------------------------------------------------------
// The test-local platform-class table (mirrors the composition-root DATA —
// the module itself carries NO platform identifiers, the 056 fence).
// ---------------------------------------------------------------------------
const PLATFORM_CLASSES: ProductMarketingPlatformClassTable = {
  tiktok: 'short_video',
  youtube: 'long_video',
  instagram: 'image',
  'facebook-pages': 'image',
  x: 'text',
  twitter: 'text',
  linkedin: 'text',
};

// ---------------------------------------------------------------------------
// The input builders (record-derived facts ONLY — no verdict channel)
// ---------------------------------------------------------------------------

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_ID = '22222222-2222-4222-8222-222222222222';
const GOAL_ONE = '33333333-3333-4333-8333-333333333333';
const GOAL_TWO = '44444444-4444-4444-8444-444444444444';
const CONTEXT_ID = '55555555-5555-4555-8555-555555555555';
const RESEARCH_SESSION_ID = '77777777-7777-4777-8777-777777777777';

function uuid(seed: number): string {
  return `${seed.toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function missionSnapshot() {
  return {
    missionId: MISSION_ID,
    agencyId: AGENCY_ID,
    status: 'active',
    versionSeq: 1,
    objectiveFamily: 'product_marketing',
    objectiveExcerpt: 'Grow qualified traffic and conversions for the product.',
    productContext: {
      name: 'Consumer Product',
      url: 'https://product.example',
      summary: 'A consumer product with a public site.',
    },
    marketContext: { audience: 'general consumers', geography: 'global', summary: null },
    goalRefs: [
      { goalId: GOAL_ONE, goalStatus: 'active' },
      { goalId: GOAL_TWO, goalStatus: 'active' },
    ],
  };
}

/** A public-site consumer product context (the URL context). */
function consumerProductContext() {
  return {
    productContextId: CONTEXT_ID,
    currentVersionSeq: 1,
    name: 'Consumer Product',
    inputs: [
      {
        inputId: uuid(101),
        kind: 'product_site_url',
        reference: 'https://product.example',
        authorization: 'public',
        position: 1,
      },
    ],
    sourceFacts: [
      {
        sourceFactId: uuid(201),
        factKind: 'page_title',
        content: { text: 'Consumer Product — the everyday helper' },
      },
    ],
    derivedModels: [
      {
        derivedModelId: uuid(301),
        derivationKind: 'content_worthy_features',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(302),
        derivationKind: 'content_worthy_features',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(303),
        derivationKind: 'content_worthy_features',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(304),
        derivationKind: 'market_language',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(305),
        derivationKind: 'market_language',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(306),
        derivationKind: 'value_propositions',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(307),
        derivationKind: 'icp_audience_hypotheses',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(308),
        derivationKind: 'commercial_metrics',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      // An UNVERIFIED model: present, disclosed, never influencing (§7).
      {
        derivedModelId: uuid(309),
        derivationKind: 'commercial_metrics',
        verificationState: 'unverified',
        evidenceSourceFactIds: [],
      },
    ],
    riskFlags: [],
  };
}

/** A developer-tool code context (the code context — the acceptance pair). */
function developerToolContext() {
  return {
    productContextId: CONTEXT_ID,
    currentVersionSeq: 2,
    name: 'DevTool',
    inputs: [
      {
        inputId: uuid(111),
        kind: 'source_repository',
        reference: 'https://source.example/devtool',
        authorization: 'authorized',
        position: 1,
      },
    ],
    sourceFacts: [
      {
        sourceFactId: uuid(211),
        factKind: 'source_record',
        content: { summary: 'A repository read observation.' },
      },
    ],
    derivedModels: [
      {
        derivedModelId: uuid(311),
        derivationKind: 'content_worthy_features',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(211)],
      },
    ],
    riskFlags: [
      {
        riskFlagId: uuid(401),
        category: 'compliance',
        severity: 'high',
        evidenceSourceFactIds: [uuid(211)],
      },
    ],
  };
}

function healthyEvaluations() {
  return [
    {
      evaluationId: uuid(501),
      socialAccountId: uuid(601),
      platformId: 'youtube',
      workspaceId: null,
      state: 'healthy',
      confidence: 'high',
      reasonCodes: ['no_negative_observable_signals'],
      evaluatedAt: '2026-09-20T10:00:00.000Z',
    },
    {
      evaluationId: uuid(502),
      socialAccountId: uuid(602),
      platformId: 'tiktok',
      workspaceId: null,
      state: 'healthy',
      confidence: 'high',
      reasonCodes: ['no_negative_observable_signals'],
      evaluatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];
}

function baseInput(): PlannerInput {
  return {
    mission: missionSnapshot(),
    productContext: consumerProductContext(),
    research: null,
    healthEvaluations: healthyEvaluations(),
    experimentAnalyses: [],
    allocationRecommendations: [],
    contentHypotheses: [],
  };
}

// ---------------------------------------------------------------------------
// (a) Determinism + the frozen vocabulary pins
// ---------------------------------------------------------------------------

test('MKT-070 (a): the same inputs always compose the same plan', () => {
  const first = composeProductMarketingPlanCore(baseInput(), PLATFORM_CLASSES);
  const second = composeProductMarketingPlanCore(baseInput(), PLATFORM_CLASSES);
  assert.deepEqual(second, first);
  assert.equal(first.strategyVersion, PRODUCT_MARKETING_STRATEGY_VERSION);
  assert.equal(first.strategyVersion, 'pm-plan-v1');
  assert.equal(computePlannerInputDigest(baseInput()), first.inputDigest);
});

test('MKT-070 vocabularies: the frozen closed sets are pinned', () => {
  assert.deepEqual(PRODUCT_MARKETING_PLANNER_FAMILY, 'product_marketing');
  assert.deepEqual(PRODUCT_MARKETING_INCLUSION_TIERS, ['primary', 'secondary', 'excluded']);
  assert.deepEqual(PRODUCT_MARKETING_CONTENT_PROFILES, [
    'broad_reach_visual',
    'technical_authority',
    'conversion_focused',
    'community_narrative',
  ]);
  assert.deepEqual(PRODUCT_MARKETING_ATTRIBUTION_METHODS, [
    'attribution_id_last_touch',
    'attribution_id_first_touch',
    'attribution_id_linear_multi_touch',
  ]);
  assert.deepEqual(PRODUCT_MARKETING_METRIC_NAMES, [
    'qualified_site_visits',
    'attributable_conversions',
    'engaged_platform_reach',
    'content_engagement_rate',
  ]);
  assert.equal(PRODUCT_MARKETING_VOCABULARY_VERSION, 'pm-vocab-v1');
  // The platform-class table is DATA (the frozen pm-platform-classes-v1).
  assert.equal(classifyPlatformForProductMarketing('tiktok', PLATFORM_CLASSES), 'short_video');
  assert.equal(classifyPlatformForProductMarketing('youtube', PLATFORM_CLASSES), 'long_video');
  assert.equal(classifyPlatformForProductMarketing('instagram', PLATFORM_CLASSES), 'image');
  assert.equal(classifyPlatformForProductMarketing('x', PLATFORM_CLASSES), 'text');
  assert.equal(classifyPlatformForProductMarketing('reference-social', PLATFORM_CLASSES), 'unknown');
  assert.ok(PLATFORM_CLASSES['facebook-pages'] === 'image');
});

test('MKT-070 guards: the provenance and compose-input fences', () => {
  assert.throws(
    () => assertValidProductMarketingProvenance({ actor: '', recordedVia: 'api', correlationId: 'c', causationId: null }),
    /invalid product-marketing provenance/,
  );
  assert.throws(
    () =>
      assertValidComposeProductMarketingPlanInput({
        missionId: 'not-a-uuid',
        productContextId: CONTEXT_ID,
        pursuitWorkspaceId: uuid(900),
        researchSessionId: null,
        reason: 'initial plan',
      }),
    /invalid compose-product-marketing-plan input/,
  );
  assert.throws(
    () =>
      assertValidComposeProductMarketingPlanInput({
        missionId: MISSION_ID,
        productContextId: CONTEXT_ID,
        pursuitWorkspaceId: uuid(900),
        researchSessionId: null,
        reason: '',
      }),
    /invalid compose-product-marketing-plan input/,
  );
});

// ---------------------------------------------------------------------------
// (b) THE ACCEPTANCE: the product URL/code context changes the portfolio
//     and the metric plan, with the influencing records cited
// ---------------------------------------------------------------------------

test('MKT-070 (b): a different product context produces a differently-composed plan', () => {
  const consumerPlan = composeProductMarketingPlanCore(baseInput(), PLATFORM_CLASSES);

  const devToolInput: PlannerInput = {
    ...baseInput(),
    productContext: developerToolContext(),
  };
  const devToolPlan = composeProductMarketingPlanCore(devToolInput, PLATFORM_CLASSES);

  // The digests differ (the observable world changed).
  assert.notEqual(devToolPlan.inputDigest, consumerPlan.inputDigest);

  // The platform portfolios differ in tier structure: the rich consumer
  // marketing evidence promotes BOTH platforms to primary; the code
  // context (thin marketing evidence) keeps ONE primary.
  const consumerPrimaries = consumerPlan.platformPortfolio.filter(
    (entry) => entry.inclusion === 'primary',
  );
  const devToolPrimaries = devToolPlan.platformPortfolio.filter(
    (entry) => entry.inclusion === 'primary',
  );
  assert.equal(consumerPrimaries.length, 2);
  assert.equal(devToolPrimaries.length, 1);

  // The class multipliers differ: the code context favors text/long-form
  // and penalizes short video — youtube (long_video) outscores tiktok
  // (short_video) in the dev-tool plan while both tie in the consumer
  // plan (unknown/neutral would also be honest).
  const devToolYoutube = devToolPlan.platformPortfolio.find(
    (entry) => entry.platformId === 'youtube',
  )!;
  const devToolTiktok = devToolPlan.platformPortfolio.find(
    (entry) => entry.platformId === 'tiktok',
  )!;
  assert.ok(devToolYoutube.score > devToolTiktok.score);
  assert.equal(devToolYoutube.inclusion, 'primary');
  assert.equal(devToolTiktok.inclusion, 'secondary');

  // The metric plans differ: the consumer context's rich evidence scales
  // the targets ABOVE the code context's thin evidence.
  const consumerVisits = consumerPlan.metricPlan.find(
    (metric) => metric.metric === 'qualified_site_visits',
  )!;
  const devToolVisits = devToolPlan.metricPlan.find(
    (metric) => metric.metric === 'qualified_site_visits',
  )!;
  assert.ok(consumerVisits.targetValue > devToolVisits.targetValue);

  // The influencing records are VISIBLE: the consumer plan cites the
  // evidence-backed content_worthy_features models; the dev-tool plan
  // cites the source_repository input and the compliance risk flag.
  const consumerModelCitations = consumerPlan.citations.filter(
    (citation) => citation.kind === 'product_derived_model',
  );
  assert.equal(consumerModelCitations.length, 8); // every evidence-backed model
  const devToolInputCitations = devToolPlan.citations.filter(
    (citation) => citation.kind === 'product_input',
  );
  assert.deepEqual(devToolInputCitations.map((citation) => citation.refId), [uuid(111)]);
  const devToolRiskCitations = devToolPlan.citations.filter(
    (citation) => citation.kind === 'product_risk_flag',
  );
  assert.deepEqual(devToolRiskCitations.map((citation) => citation.refId), [uuid(401)]);

  // The content strategies differ: broad_reach_visual vs technical_authority.
  assert.equal(consumerPlan.contentStrategy.profile, 'broad_reach_visual');
  assert.equal(devToolPlan.contentStrategy.profile, 'technical_authority');
});

test('MKT-070 (b): the code-context signal derives from the declared inputs (cited)', () => {
  const { signals } = deriveProductSignals(consumerProductContext(), null);
  assert.equal(signals.hasCodeContext, false);
  assert.equal(signals.hasCommerceContext, false);
  assert.equal(signals.hasPublicSiteContext, true);
  assert.equal(signals.contentWorthyFeatures, 3);

  const devSignals = deriveProductSignals(developerToolContext(), null);
  assert.equal(devSignals.signals.hasCodeContext, true);
  assert.equal(devSignals.signals.contentWorthyFeatures, 1);
  assert.equal(devSignals.signals.highSeverityRiskFlags, 1);
});

// ---------------------------------------------------------------------------
// (c) Platform-health respect: exclusions cite the verdict, never silent
// ---------------------------------------------------------------------------

test('MKT-070 (c): a publishing_blocked account is EXCLUDED with the verdict cited', () => {
  const input: PlannerInput = {
    ...baseInput(),
    healthEvaluations: [
      ...healthyEvaluations(),
      {
        evaluationId: uuid(503),
        socialAccountId: uuid(603),
        platformId: 'instagram',
        workspaceId: null,
        state: 'publishing_blocked',
        confidence: 'high',
        reasonCodes: ['restricted_publish_outcome_observed'],
        evaluatedAt: '2026-09-21T10:00:00.000Z',
      },
    ],
  };
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);
  const excluded = plan.platformPortfolio.find((entry) => entry.platformId === 'instagram')!;
  assert.equal(excluded.inclusion, 'excluded');
  assert.equal(excluded.score, 0);
  assert.equal(excluded.weightShareBps, 0);
  // The health verdict evaluation IS cited on the excluded entry.
  const verdict = excluded.citations.find(
    (citation) => citation.kind === 'platform_health_evaluation',
  )!;
  assert.equal(verdict.refId, uuid(503));
  assert.ok(excluded.rationale.includes('publishing_blocked'));
  // The mix weights only the non-excluded platforms (sum exactly 10000).
  const total = plan.platformPortfolio.reduce((sum, entry) => sum + entry.weightShareBps, 0);
  assert.equal(total, 10000);
});

test('MKT-070 (c): restricted and authorization_blocked exclude; degraded deprioritizes', () => {
  const input: PlannerInput = {
    ...baseInput(),
    healthEvaluations: [
      {
        evaluationId: uuid(511),
        socialAccountId: uuid(611),
        platformId: 'youtube',
        workspaceId: null,
        state: 'restricted',
        confidence: 'high',
        reasonCodes: ['platform_confirmed_restriction_signal'],
        evaluatedAt: '2026-09-20T10:00:00.000Z',
      },
      {
        evaluationId: uuid(512),
        socialAccountId: uuid(612),
        platformId: 'tiktok',
        workspaceId: null,
        state: 'degraded',
        confidence: 'medium',
        reasonCodes: ['observed_metric_deviation_below_baseline'],
        evaluatedAt: '2026-09-20T10:00:00.000Z',
      },
      {
        evaluationId: uuid(513),
        socialAccountId: uuid(613),
        platformId: 'instagram',
        workspaceId: null,
        state: 'authorization_blocked',
        confidence: 'high',
        reasonCodes: ['authorization_unusable'],
        evaluatedAt: '2026-09-20T10:00:00.000Z',
      },
    ],
  };
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);
  const youtube = plan.platformPortfolio.find((entry) => entry.platformId === 'youtube')!;
  const instagram = plan.platformPortfolio.find((entry) => entry.platformId === 'instagram')!;
  const tiktok = plan.platformPortfolio.find((entry) => entry.platformId === 'tiktok')!;
  assert.equal(youtube.inclusion, 'excluded');
  assert.equal(instagram.inclusion, 'excluded');
  assert.equal(tiktok.inclusion, 'primary'); // the only surviving candidate
  assert.equal(tiktok.weightShareBps, 10000);
  assert.ok(tiktok.score < 10); // the degraded modifier deprioritizes
  assert.ok(tiktok.rationale.includes('degraded'));
});

test('MKT-070 (c): only the LATEST evaluation per account composes the mix', () => {
  const input: PlannerInput = {
    ...baseInput(),
    healthEvaluations: [
      {
        evaluationId: uuid(521),
        socialAccountId: uuid(601),
        platformId: 'youtube',
        workspaceId: null,
        state: 'restricted',
        confidence: 'high',
        reasonCodes: ['platform_confirmed_restriction_signal'],
        evaluatedAt: '2026-09-18T10:00:00.000Z',
      },
      {
        evaluationId: uuid(522),
        socialAccountId: uuid(601),
        platformId: 'youtube',
        workspaceId: null,
        state: 'healthy',
        confidence: 'high',
        reasonCodes: ['no_negative_observable_signals'],
        evaluatedAt: '2026-09-22T10:00:00.000Z',
      },
    ],
  };
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);
  assert.equal(plan.platformPortfolio.length, 1);
  assert.equal(plan.platformPortfolio[0]!.healthState, 'healthy');
  assert.equal(plan.platformPortfolio[0]!.evaluationId, uuid(522));
});

// ---------------------------------------------------------------------------
// (d) Fabrication resistance: citations only reference input records
// ---------------------------------------------------------------------------

test('MKT-070 (d): every emitted citation references a record present in the input snapshot', () => {
  const input: PlannerInput = {
    ...baseInput(),
    research: {
      researchSessionId: RESEARCH_SESSION_ID,
      currentVersionSeq: 1,
      topic: 'Consumer product positioning',
      insights: [
        {
          researchInsightId: uuid(701),
          derivationKind: 'audience_language',
          verificationState: 'evidence_backed',
        },
        {
          researchInsightId: uuid(702),
          derivationKind: 'content_gaps',
          verificationState: 'evidence_backed',
        },
      ],
    },
    contentHypotheses: [
      {
        contentHypothesisId: uuid(801),
        hypothesisKind: 'format_hypothesis',
        researchInsightIds: [uuid(701)],
      },
    ],
  };
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);

  const validIds: Record<PlannerCitation['kind'], ReadonlySet<string>> = {
    product_input: new Set(input.productContext.inputs.map((entry) => entry.inputId)),
    product_source_fact: new Set(input.productContext.sourceFacts.map((fact) => fact.sourceFactId)),
    product_derived_model: new Set(
      input.productContext.derivedModels.map((model) => model.derivedModelId),
    ),
    product_risk_flag: new Set(input.productContext.riskFlags.map((flag) => flag.riskFlagId)),
    research_insight: new Set((input.research?.insights ?? []).map((i) => i.researchInsightId)),
    platform_health_evaluation: new Set(
      input.healthEvaluations.map((evaluation) => evaluation.evaluationId),
    ),
    experiment_analysis: new Set(input.experimentAnalyses.map((a) => a.analysisId)),
    allocation_recommendation: new Set(
      input.allocationRecommendations.map((a) => a.recommendationId),
    ),
    content_hypothesis: new Set(input.contentHypotheses.map((h) => h.contentHypothesisId)),
  };
  for (const citation of plan.citations) {
    assert.ok(
      validIds[citation.kind]!.has(citation.refId),
      `citation ${citation.kind}:${citation.refId} must reference an input record`,
    );
  }
  // The research insights and the content hypothesis are both cited.
  assert.ok(plan.citations.some((c) => c.kind === 'research_insight' && c.refId === uuid(702)));
  assert.ok(plan.citations.some((c) => c.kind === 'content_hypothesis' && c.refId === uuid(801)));
  // Every decision entry's citations are a subset of the full set.
  const fullSet = new Set(plan.citations.map((c) => `${c.kind}:${c.refId}`));
  for (const decision of plan.decisions) {
    for (const citation of decision.citations) {
      assert.ok(fullSet.has(`${citation.kind}:${citation.refId}`));
    }
  }
});

// ---------------------------------------------------------------------------
// (e) The evidence tier: unverified records never influence
// ---------------------------------------------------------------------------

test('MKT-070 (e): unverified derived models never influence (the §7 claim discipline)', () => {
  const input = baseInput();
  // uuid(309) is an UNVERIFIED commercial_metrics model — it must not
  // scale the attributable_conversions target (only uuid(308) counts).
  const conversions = composeProductMarketingPlanCore(input, PLATFORM_CLASSES).metricPlan.find(
    (metric) => metric.metric === 'attributable_conversions',
  )!;
  assert.equal(conversions.targetValue, 40 + 20 * 1 + 10 * 1); // one verified model each
  // And the unverified record is never cited.
  assert.ok(!input.productContext.derivedModels.every((model) => model.verificationState === 'evidence_backed'));
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);
  assert.ok(!plan.citations.some((c) => c.refId === uuid(309)));
});

// ---------------------------------------------------------------------------
// (f) Goal wiring by reference + the honest disclosures
// ---------------------------------------------------------------------------

test('MKT-070 (f): the metric plan wires the mission goals BY REFERENCE', () => {
  const plan = composeProductMarketingPlanCore(baseInput(), PLATFORM_CLASSES);
  for (const metric of plan.metricPlan) {
    assert.deepEqual(metric.goalRefs, [GOAL_ONE, GOAL_TWO]);
  }
  // Intermediate metrics are flagged (never terminal-decision bases).
  const reach = plan.metricPlan.find((metric) => metric.metric === 'engaged_platform_reach')!;
  assert.equal(reach.intermediate, true);
  const visits = plan.metricPlan.find((metric) => metric.metric === 'qualified_site_visits')!;
  assert.equal(visits.intermediate, false);
});

test('MKT-070 (f): the attribution plan is distinct from causality and bounded by the operator', () => {
  const plan = composeProductMarketingPlanCore(baseInput(), PLATFORM_CLASSES);
  // Two primaries → linear multi-touch over the propagated attribution ids.
  assert.equal(plan.attributionPlan.method, 'attribution_id_linear_multi_touch');
  assert.equal(plan.attributionPlan.disclosure, PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE);
  assert.ok(
    plan.attributionPlan.disclosure.includes('attribution is distinct from causality'),
    'the non-causal disclosure ships on the plan',
  );
  assert.ok(plan.attributionPlan.measuredSurfaces.length >= 2);

  // One primary → last-touch.
  const single: PlannerInput = {
    ...baseInput(),
    healthEvaluations: [healthyEvaluations()[0]!],
  };
  const singlePlan = composeProductMarketingPlanCore(single, PLATFORM_CLASSES);
  assert.equal(singlePlan.attributionPlan.method, 'attribution_id_last_touch');

  // The experiment plan is DATA toward the Growth Operator (bounded).
  assert.equal(plan.experimentPlan.boundedBy, 'growth-operator');
  assert.equal(plan.experimentPlan.analysisMethod, 'two_sample_means_v1');
  assert.equal(plan.experimentPlan.primaryMetric, 'qualified_site_visits');
  assert.equal(plan.experimentPlan.disclosure, PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE);
  assert.ok(plan.experimentPlan.stopCriteria.includes('30 observations per arm'));
  // The cold-start basis is honest (no fabricated analysis citations).
  assert.equal(plan.experimentPlan.citations.length, 0);
  assert.ok(plan.experimentPlan.rationale.includes('cold start'));
  assert.equal(
    PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE.includes('evidence-backed'),
    true,
  );
});

test('MKT-070 (f): informed experiment plans cite the analysis + allocation records', () => {
  const input: PlannerInput = {
    ...baseInput(),
    experimentAnalyses: [
      {
        analysisId: uuid(901),
        experimentId: uuid(910),
        outcome: 'positive',
        recommendedNextAllocation: 'increase_treatment',
        effectEstimate: 12.5,
      },
    ],
    allocationRecommendations: [
      {
        recommendationId: uuid(902),
        experimentId: uuid(910),
        eligibleArms: ['strategy_mix_v1', 'current_mix'],
        shares: { strategy_mix_v1: 0.6, current_mix: 0.4 },
      },
    ],
  };
  const plan = composeProductMarketingPlanCore(input, PLATFORM_CLASSES);
  assert.ok(plan.experimentPlan.rationale.includes("outcome 'positive'"));
  assert.ok(plan.experimentPlan.citations.some((c) => c.kind === 'experiment_analysis' && c.refId === uuid(901)));
  assert.ok(
    plan.experimentPlan.citations.some(
      (c) => c.kind === 'allocation_recommendation' && c.refId === uuid(902),
    ),
  );
});

test('MKT-070: the digest changes only when the observable world changes', () => {
  const base = baseInput();
  const digestOne = computePlannerInputDigest(base);
  // Shuffling list order does not change the digest (order-stable).
  const shuffled: PlannerInput = {
    ...base,
    healthEvaluations: [...base.healthEvaluations].reverse(),
    mission: { ...base.mission, goalRefs: [...base.mission.goalRefs].reverse() },
  };
  assert.equal(computePlannerInputDigest(shuffled), digestOne);
  // A new evaluation record changes it.
  const evolved: PlannerInput = {
    ...base,
    healthEvaluations: [
      ...base.healthEvaluations,
      {
        evaluationId: uuid(599),
        socialAccountId: uuid(699),
        platformId: 'instagram',
        workspaceId: null,
        state: 'healthy',
        confidence: 'high',
        reasonCodes: [],
        evaluatedAt: '2026-09-23T10:00:00.000Z',
      },
    ],
  };
  assert.notEqual(computePlannerInputDigest(evolved), digestOne);
});
