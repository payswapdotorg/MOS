/**
 * MKT-072 unit tests — the pure deterministic core of /commerce-discovery:
 * the cd-plan-v1 niche scoring + selection, the candidate-proposal
 * derivation, the demand-test design template, the economic-gate
 * composition, the deterministic input digest, the cd-guardrails-v1
 * evaluation ruleset and the outcome derivation over the REAL
 * commerce-event shapes — plus the acceptance properties at the
 * pure-core level:
 *
 *   (a) DETERMINISM: the same inputs always compose the same plan (the
 *       same input digest, the same selection, the same proposals);
 *   (b) THE ACCEPTANCE: a different product/niche context produces a
 *       different (or differently-scored) niche selection + proposals —
 *       with the influencing records cited;
 *   (c) THE EVIDENCE TIER: unverified derived models NEVER influence
 *       (the §7 claim discipline);
 *   (d) HEALTH RISK: a restricted/publishing_blocked evaluation PENALIZES
 *       with the verdict cited (never silently);
 *   (e) FABRICATION RESISTANCE: every emitted citation references a
 *       record id present in the input snapshot;
 *   (f) THE GUARDRAILS: the bounded-spend evaluation ruleset (spend /
 *       count breaches; the honest within_bounds verdict);
 *   (g) THE ORDER TRUTH: the outcome derivation counts only the REAL
 *       cited order events (latest event per order, cancelled disclosed,
 *       per-currency values with NO cross-currency aggregation, the
 *       viability gate and the recommendation as data);
 *   (h) THE INPUT GUARDS: the declared bounds + provenance + compose
 *       input validation (fail-closed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMERCE_DISCOVERY_STRATEGY_VERSION,
  COMMERCE_DISCOVERY_VOCABULARY_VERSION,
  COMMERCE_DISCOVERY_MISSION_FAMILY,
  COMMERCE_DISCOVERY_STATUSES,
  COMMERCE_DISCOVERY_TERMINAL_STATUSES,
  COMMERCE_DISCOVERY_TRANSITIONS,
  COMMERCE_DISCOVERY_EVENT_KINDS,
  COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS,
  COMMERCE_DISCOVERY_BREACH_REASONS,
  COMMERCE_DISCOVERY_VIABILITY_VERDICTS,
  COMMERCE_DISCOVERY_RECOMMENDATIONS,
  COMMERCE_DISCOVERY_METRIC_NAMES,
  COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE,
  COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE,
  COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE,
  COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE,
  isLegalCommerceDiscoveryTransition,
  isTerminalCommerceDiscoveryStatus,
  composeCommerceDiscoveryPlanCore,
  computeDiscoveryInputDigest,
  evaluateGuardrailsCore,
  deriveOutcomeCore,
  deriveDemandTestDesign,
  assertValidCommerceDiscoveryProvenance,
  assertValidComposeCommerceDiscoveryPlanInput,
  assertValidDeclaredBounds,
  type DiscoveryInput,
} from '../../src/modules/commerce-discovery/public.ts';

// ---------------------------------------------------------------------------
// The input builders (record-derived facts ONLY — no verdict channel)
// ---------------------------------------------------------------------------

const MISSION_ID = '11111111-1111-4111-8111-111111111111';
const AGENCY_ID = '22222222-2222-4222-8222-222222222222';
const GOAL_ONE = '33333333-3333-4333-8333-333333333333';
const CONTEXT_ID = '55555555-5555-4555-8555-555555555555';

function uuid(seed: number): string {
  return `${seed.toString().padStart(8, '0')}-0000-4000-8000-000000000000`;
}

function missionSnapshot() {
  return {
    missionId: MISSION_ID,
    agencyId: AGENCY_ID,
    status: 'active',
    versionSeq: 1,
    objectiveFamily: 'commerce_discovery',
    objectiveExcerpt: 'Discover viable products for the store.',
    productContext: {
      name: 'Consumer Product',
      url: 'https://product.example',
      summary: 'A consumer product with a public site.',
    },
    marketContext: { audience: 'general consumers', geography: 'global', summary: null },
    goalRefs: [{ goalId: GOAL_ONE, goalStatus: 'active' }],
  };
}

/** The consumer product context (rich, evidence-backed product signals). */
function consumerContext() {
  return {
    productContextId: CONTEXT_ID,
    currentVersionSeq: 1,
    name: 'Consumer Product',
    derivedModels: [
      {
        derivedModelId: uuid(301),
        derivationKind: 'value_propositions',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(302),
        derivationKind: 'icp_audience_hypotheses',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(303),
        derivationKind: 'market_language',
        verificationState: 'evidence_backed',
        evidenceSourceFactIds: [uuid(201)],
      },
      {
        derivedModelId: uuid(304),
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

function kitchenNicheCandidates() {
  return [
    {
      contentCandidateId: uuid(401),
      topicEntity: 'kitchen organization',
      niche: 'Kitchen & Home',
      subNiche: 'Small kitchens',
      contentFormat: 'short_video',
      audienceFit: 'strong_fit',
      freshness: 'recent',
      novelty: 'novel',
      reuseRisk: 'low',
      observedPerformance: { views: 12000 },
    },
    {
      contentCandidateId: uuid(402),
      topicEntity: 'meal prep',
      niche: 'Kitchen & Home',
      subNiche: 'Batch cooking',
      contentFormat: 'short_video',
      audienceFit: 'moderate_fit',
      freshness: 'established',
      novelty: 'variation',
      reuseRisk: 'medium',
      observedPerformance: { views: 8000 },
    },
    {
      contentCandidateId: uuid(403),
      topicEntity: 'outdoor gear',
      niche: 'Outdoor & Field',
      subNiche: null,
      contentFormat: 'image_post',
      audienceFit: 'weak_fit',
      freshness: 'dated',
      novelty: 'common',
      reuseRisk: 'high',
      observedPerformance: { views: 3000 },
    },
  ];
}

function healthyEvaluations() {
  return [
    {
      evaluationId: uuid(501),
      socialAccountId: uuid(601),
      platformId: 'tiktok',
      state: 'healthy',
      confidence: 'high',
      reasonCodes: [],
      evaluatedAt: '2026-09-01T10:00:00.000Z',
    },
  ];
}

function hypotheses() {
  return [
    {
      contentHypothesisId: uuid(701),
      hypothesisKind: 'format_hypothesis',
    },
  ];
}

function analyses() {
  return [
    {
      analysisId: uuid(801),
      experimentId: uuid(802),
      outcome: 'inconclusive',
    },
  ];
}

const DECLARED = {
  spendCurrency: 'USD',
  testBudgetMinorUnits: 500000,
  maxDemandTests: 10,
  minOrderCountForViability: 3,
} as const;

function discoveryInput(overrides: Partial<DiscoveryInput> = {}): DiscoveryInput {
  return {
    mission: missionSnapshot(),
    productContext: consumerContext(),
    contentCandidates: kitchenNicheCandidates(),
    contentHypotheses: hypotheses(),
    healthEvaluations: healthyEvaluations(),
    experimentAnalyses: analyses(),
    declared: DECLARED,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (1) The frozen vocabularies + lifecycle table
// ---------------------------------------------------------------------------

test('MKT-072: the frozen vocabularies are pinned (cd-vocab-v1 / cd-plan-v1)', () => {
  assert.equal(COMMERCE_DISCOVERY_STRATEGY_VERSION, 'cd-plan-v1');
  assert.equal(COMMERCE_DISCOVERY_VOCABULARY_VERSION, 'cd-vocab-v1');
  assert.equal(COMMERCE_DISCOVERY_MISSION_FAMILY, 'commerce_discovery');
  assert.deepEqual(COMMERCE_DISCOVERY_STATUSES, [
    'active',
    'guardrail_blocked',
    'concluded',
    'stopped_by_user',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_TERMINAL_STATUSES, ['concluded', 'stopped_by_user']);
  assert.deepEqual(COMMERCE_DISCOVERY_EVENT_KINDS, [
    'discovery_created',
    'version_recorded',
    'state_transition',
    'candidate_recorded',
    'demand_test_launched',
    'demand_test_concluded',
    'outcome_recorded',
    'guardrail_evaluated',
    'guardrail_resolved',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_GUARDRAIL_VERDICTS, ['within_bounds', 'breached']);
  assert.deepEqual(COMMERCE_DISCOVERY_BREACH_REASONS, [
    'spend_exceeds_test_budget',
    'demand_tests_exceed_limit',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_VIABILITY_VERDICTS, [
    'viable',
    'not_viable',
    'insufficient_observations',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_RECOMMENDATIONS, [
    'recommend_listing',
    'recommend_iteration',
    'do_not_list',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_METRIC_NAMES, [
    'observed_order_count',
    'observed_order_value',
  ]);
  // The transition table: terminal states have no outgoing transitions.
  assert.deepEqual(COMMERCE_DISCOVERY_TRANSITIONS.active, [
    'guardrail_blocked',
    'concluded',
    'stopped_by_user',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_TRANSITIONS.guardrail_blocked, [
    'active',
    'concluded',
    'stopped_by_user',
  ]);
  assert.deepEqual(COMMERCE_DISCOVERY_TRANSITIONS.concluded, []);
  assert.deepEqual(COMMERCE_DISCOVERY_TRANSITIONS.stopped_by_user, []);
  assert.equal(isLegalCommerceDiscoveryTransition('active', 'guardrail_blocked'), true);
  assert.equal(isLegalCommerceDiscoveryTransition('concluded', 'active'), false);
  assert.equal(isTerminalCommerceDiscoveryStatus('concluded'), true);
  assert.equal(isTerminalCommerceDiscoveryStatus('guardrail_blocked'), false);
  // The disclosures ship on the public contract.
  assert.ok(COMMERCE_DISCOVERY_ORDER_TRUTH_DISCLOSURE.includes('never simulated'));
  assert.ok(COMMERCE_DISCOVERY_RECOMMENDATION_DISCLOSURE.includes('never an auto-listing'));
  assert.ok(COMMERCE_DISCOVERY_ATTRIBUTION_DISCLOSURE.includes('distinct from causality'));
  assert.ok(COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE.includes('never a silent continue'));
  assert.ok(COMMERCE_DISCOVERY_EXPERIMENT_DISCLOSURE.includes('no experiment lifecycle'));
});

// ---------------------------------------------------------------------------
// (2) Determinism + the digest
// ---------------------------------------------------------------------------

test('MKT-072: DETERMINISM — the same inputs compose the same plan + digest', () => {
  const first = composeCommerceDiscoveryPlanCore(discoveryInput());
  const second = composeCommerceDiscoveryPlanCore(discoveryInput());
  assert.deepEqual(first, second);
  assert.equal(
    computeDiscoveryInputDigest(discoveryInput()),
    computeDiscoveryInputDigest(discoveryInput()),
  );
  assert.equal(first.strategyVersion, 'cd-plan-v1');
  assert.ok(first.inputDigest.length >= 1);
});

test('MKT-072: the digest changes when the declared bounds change (the honest seam is part of the digest)', () => {
  const base = computeDiscoveryInputDigest(discoveryInput());
  const raised = computeDiscoveryInputDigest(
    discoveryInput({ declared: { ...DECLARED, testBudgetMinorUnits: 600000 } }),
  );
  const otherMission = computeDiscoveryInputDigest(
    discoveryInput({
      mission: { ...missionSnapshot(), versionSeq: 2 },
    }),
  );
  assert.notEqual(base, raised);
  assert.notEqual(base, otherMission);
});

// ---------------------------------------------------------------------------
// (3) The acceptance: a different niche context changes the selection, cited
// ---------------------------------------------------------------------------

test('MKT-072: THE ACCEPTANCE — a different niche context produces a different ranked selection with the influencing records cited', () => {
  const kitchen = composeCommerceDiscoveryPlanCore(discoveryInput());
  assert.ok(kitchen.nicheSelection.length >= 2);
  assert.equal(kitchen.nicheSelection[0]!.niche, 'Kitchen & Home');
  // The weight shares of the ranked set sum to exactly 10000 bps.
  assert.equal(
    kitchen.nicheSelection.reduce((sum, entry) => sum + entry.weightShareBps, 0),
    10000,
  );
  // The Kitchen entry cites the content candidates that produced it.
  const kitchenEntry = kitchen.nicheSelection[0]!;
  assert.ok(
    kitchenEntry.citations.some((c) => c.kind === 'content_candidate' && c.refId === uuid(401)),
  );
  assert.ok(
    kitchenEntry.citations.some((c) => c.kind === 'content_candidate' && c.refId === uuid(402)),
  );
  // The evidence-backed product-signal models boost the entry (cited).
  assert.ok(
    kitchenEntry.citations.some(
      (c) => c.kind === 'product_derived_model' && c.refId === uuid(301),
    ),
  );

  // A DIFFERENT niche landscape: Outdoor dominates, Kitchen disappears.
  const outdoor = composeCommerceDiscoveryPlanCore(
    discoveryInput({
      contentCandidates: [
        {
          contentCandidateId: uuid(411),
          topicEntity: 'field gear',
          niche: 'Outdoor & Field',
          subNiche: null,
          contentFormat: 'short_video',
          audienceFit: 'strong_fit',
          freshness: 'breaking',
          novelty: 'novel',
          reuseRisk: 'low',
          observedPerformance: { views: 90000 },
        },
        {
          contentCandidateId: uuid(412),
          topicEntity: 'hiking',
          niche: 'Outdoor & Field',
          subNiche: 'Trail cooking',
          contentFormat: 'live_stream',
          audienceFit: 'strong_fit',
          freshness: 'recent',
          novelty: 'novel',
          reuseRisk: 'low',
          observedPerformance: { views: 50000 },
        },
      ],
    }),
  );
  assert.equal(outdoor.nicheSelection[0]!.niche, 'Outdoor & Field');
  assert.ok(outdoor.nicheSelection[0]!.score > kitchen.nicheSelection[0]!.score);
  assert.notEqual(outdoor.inputDigest, kitchen.inputDigest);
  // The proposals follow the changed landscape (data, never an auto-listing).
  assert.ok(outdoor.candidateProposals.length >= 1);
  assert.ok(outdoor.candidateProposals[0]!.label.includes('Outdoor & Field'));
});

test('MKT-072: a health-risky evaluation PENALIZES with the verdict cited (never silently)', () => {
  const healthy = composeCommerceDiscoveryPlanCore(discoveryInput());
  const restricted = composeCommerceDiscoveryPlanCore(
    discoveryInput({
      healthEvaluations: [
        {
          evaluationId: uuid(502),
          socialAccountId: uuid(601),
          platformId: 'tiktok',
          state: 'restricted',
          confidence: 'high',
          reasonCodes: ['platform_confirmed_restriction'],
          evaluatedAt: '2026-09-01T10:00:00.000Z',
        },
        ...healthyEvaluations(),
      ],
    }),
  );
  const healthyScore =
    healthy.nicheSelection.find((entry) => entry.niche === 'Kitchen & Home')!.score;
  const restrictedScore =
    restricted.nicheSelection.find((entry) => entry.niche === 'Kitchen & Home')!.score;
  assert.ok(restrictedScore < healthyScore, 'the restricted verdict penalizes the niche');
  assert.ok(
    restricted.nicheSelection[0]!.citations.some(
      (c) => c.kind === 'platform_health_evaluation' && c.refId === uuid(502),
    ),
    'the penalizing verdict is cited',
  );
});

test('MKT-072: THE EVIDENCE TIER — unverified derived models never influence (§7)', () => {
  const plan = composeCommerceDiscoveryPlanCore(discoveryInput());
  // The unverified commercial_metrics model (uuid(309)) is NEVER cited.
  assert.ok(
    !plan.citations.some((c) => c.kind === 'product_derived_model' && c.refId === uuid(309)),
  );
  // Only the four evidence-backed product-signal models are cited.
  const citedModels = plan.citations.filter((c) => c.kind === 'product_derived_model');
  assert.equal(citedModels.length, 4);
});

test('MKT-072: FABRICATION RESISTANCE — every emitted citation references an input snapshot id', () => {
  const input = discoveryInput();
  const plan = composeCommerceDiscoveryPlanCore(input);
  const valid = new Set<string>([
    ...input.productContext.derivedModels.map((m) => m.derivedModelId),
    ...input.contentCandidates.map((c) => c.contentCandidateId),
    ...input.contentHypotheses.map((h) => h.contentHypothesisId),
    ...input.healthEvaluations.map((e) => e.evaluationId),
    ...input.experimentAnalyses.map((a) => a.analysisId),
  ]);
  for (const citation of plan.citations) {
    assert.ok(valid.has(citation.refId), `citation ${citation.kind}:${citation.refId} resolves`);
  }
  // An empty candidate landscape produces the honest empty selection.
  const empty = composeCommerceDiscoveryPlanCore(
    discoveryInput({ contentCandidates: [], contentHypotheses: [] }),
  );
  assert.deepEqual(empty.nicheSelection, []);
  assert.deepEqual(empty.candidateProposals, []);
  assert.ok(
    empty.decisions.some(
      (entry) =>
        entry.decisionKey === 'niche_selection' &&
        entry.summary.includes('no niche selected'),
    ),
  );
});

test('MKT-072: the composed economic gates + the demand-test plan carry the declared bounds', () => {
  const plan = composeCommerceDiscoveryPlanCore(discoveryInput());
  assert.deepEqual({ ...plan.economicGates }, {
    spendCurrency: 'USD',
    testBudgetMinorUnits: 500000,
    maxDemandTests: 10,
    minOrderCountForViability: 3,
    disclosure: COMMERCE_DISCOVERY_GUARDRAIL_DISCLOSURE,
  });
  assert.equal(plan.demandTestPlan.boundedBy, 'experiments-authority');
  assert.equal(plan.demandTestPlan.designTemplate.designType, 'randomized');
  assert.equal(plan.demandTestPlan.designTemplate.primaryMetric, 'observed_order_count');
  assert.ok(plan.demandTestPlan.stopCriteriaTemplate.includes('500000'));
  assert.ok(plan.demandTestPlan.disclosure.includes('experiments authority'));
});

// ---------------------------------------------------------------------------
// (4) The derived experiment design (the demand-test arm template)
// ---------------------------------------------------------------------------

test('MKT-072: the derived demand-test design is deterministic + family-composed', () => {
  const base = deriveDemandTestDesign({
    clientId: uuid(901),
    workspaceId: null,
    missionId: MISSION_ID,
    candidate: {
      label: 'Tactical Apron',
      niche: 'Kitchen & Home',
      demandHypothesis: 'short-form kitchen organization videos drive apron orders',
    },
    declared: DECLARED,
  });
  assert.deepEqual(base, deriveDemandTestDesign({
    clientId: uuid(901),
    workspaceId: null,
    missionId: MISSION_ID,
    candidate: {
      label: 'Tactical Apron',
      niche: 'Kitchen & Home',
      demandHypothesis: 'short-form kitchen organization videos drive apron orders',
    },
    declared: DECLARED,
  }));
  assert.equal(base.designType, 'randomized');
  assert.equal(base.primaryMetric.name, 'observed_order_count');
  assert.equal(base.primaryMetric.dimensions.mission, MISSION_ID);
  assert.equal(base.uncertaintyRepresentation, 'interval');
  assert.ok(base.stopCriteria.includes('500000 minor units USD'));
  assert.ok(base.decisionTarget.includes('Tactical Apron'));
  assert.ok(base.hypothesis.includes('short-form kitchen organization'));
});

// ---------------------------------------------------------------------------
// (5) The guardrail ruleset (cd-guardrails-v1 — the acceptance's core)
// ---------------------------------------------------------------------------

test('MKT-072: THE GUARDRAILS — the bounded-spend ruleset evaluates the real observations', () => {
  const declared = {
    spendCurrency: 'USD',
    testBudgetMinorUnits: 500000,
    maxDemandTests: 10,
  };
  // Within bounds.
  const within = evaluateGuardrailsCore({
    declared,
    observed: { spendMinorUnits: 400000, demandTestCount: 5, orderCount: 3 },
  });
  assert.equal(within.verdict, 'within_bounds');
  assert.deepEqual(within.breachReasons, []);
  // Spend breach.
  const spendBreach = evaluateGuardrailsCore({
    declared,
    observed: { spendMinorUnits: 500001, demandTestCount: 5, orderCount: 3 },
  });
  assert.equal(spendBreach.verdict, 'breached');
  assert.deepEqual(spendBreach.breachReasons, ['spend_exceeds_test_budget']);
  // Count breach.
  const countBreach = evaluateGuardrailsCore({
    declared,
    observed: { spendMinorUnits: 100, demandTestCount: 11, orderCount: 0 },
  });
  assert.equal(countBreach.verdict, 'breached');
  assert.deepEqual(countBreach.breachReasons, ['demand_tests_exceed_limit']);
  // Both breaches, deterministically ordered.
  const both = evaluateGuardrailsCore({
    declared,
    observed: { spendMinorUnits: 999999, demandTestCount: 99, orderCount: 0 },
  });
  assert.deepEqual(both.breachReasons, [
    'spend_exceeds_test_budget',
    'demand_tests_exceed_limit',
  ]);
  // Zero-budget program: any spend breaches.
  const zeroBudget = evaluateGuardrailsCore({
    declared: { spendCurrency: 'USD', testBudgetMinorUnits: 0, maxDemandTests: 5 },
    observed: { spendMinorUnits: 1, demandTestCount: 1, orderCount: 0 },
  });
  assert.equal(zeroBudget.verdict, 'breached');
  assert.ok(zeroBudget.rationale.includes('observed order count 0'));
});

// ---------------------------------------------------------------------------
// (6) The outcome derivation (the order truth — never a simulated sale)
// ---------------------------------------------------------------------------

test('MKT-072: THE ORDER TRUTH — the outcome derivation over the real order events', () => {
  const derived = deriveOutcomeCore({
    declared: { minOrderCountForViability: 2 },
    candidateLabel: 'Tactical Apron',
    orderEvents: [
      {
        commerceEventId: uuid(1001),
        eventKind: 'order.created',
        providerSubjectId: 'ord_2001',
        receivedAt: '2026-05-04T11:00:00.000Z',
        order: { orderStatus: 'paid', currency: 'USD', total: 189 },
      },
      {
        commerceEventId: uuid(1002),
        eventKind: 'order.updated',
        providerSubjectId: 'ord_2001',
        receivedAt: '2026-05-05T11:00:00.000Z',
        order: { orderStatus: 'fulfilled', currency: 'USD', total: 189 },
      },
      {
        commerceEventId: uuid(1003),
        eventKind: 'order.created',
        providerSubjectId: 'ord_2002',
        receivedAt: '2026-05-06T11:00:00.000Z',
        order: { orderStatus: 'paid', currency: 'EUR', total: 99 },
      },
      {
        commerceEventId: uuid(1004),
        eventKind: 'order.created',
        providerSubjectId: 'ord_2003',
        receivedAt: '2026-05-07T11:00:00.000Z',
        order: { orderStatus: 'cancelled', currency: 'USD', total: 50 },
      },
    ],
  });
  // The LATEST event per order subject wins: ord_2001 counted once (the
  // updated event), ord_2002 counted, ord_2003 cancelled + disclosed.
  assert.equal(derived.observedOrderCount, 2);
  assert.equal(derived.observedCancelledOrderCount, 1);
  // Per-currency values with NO cross-currency aggregation.
  assert.deepEqual(derived.observedOrderValues, { EUR: 99, USD: 189 });
  // The viability gate (2 minimum orders) is PASSED → viable + recommend.
  assert.equal(derived.viabilityVerdict, 'viable');
  assert.equal(derived.listingRecommendation, 'recommend_listing');
  assert.ok(derived.rationale.includes('no cross-currency aggregation'));
  assert.ok(derived.rationale.includes('distinct from causality'));
});

test('MKT-072: the outcome derivation — not_viable + do_not_list under the gate; insufficient with no observations', () => {
  const notViable = deriveOutcomeCore({
    declared: { minOrderCountForViability: 5 },
    candidateLabel: 'Field Notebook',
    orderEvents: [
      {
        commerceEventId: uuid(1001),
        eventKind: 'order.created',
        providerSubjectId: 'ord_2001',
        receivedAt: '2026-05-04T11:00:00.000Z',
        order: { orderStatus: 'paid', currency: 'USD', total: 189 },
      },
    ],
  });
  assert.equal(notViable.observedOrderCount, 1);
  assert.equal(notViable.viabilityVerdict, 'not_viable');
  assert.equal(notViable.listingRecommendation, 'do_not_list');

  const insufficient = deriveOutcomeCore({
    declared: { minOrderCountForViability: 5 },
    candidateLabel: 'Field Notebook',
    orderEvents: [],
  });
  assert.equal(insufficient.viabilityVerdict, 'insufficient_observations');
  assert.equal(insufficient.listingRecommendation, 'recommend_iteration');
});

// ---------------------------------------------------------------------------
// (7) The input guards (fail-closed)
// ---------------------------------------------------------------------------

/** The InvalidRequestError detail matcher (the problems ride error.details). */
function throwsWithDetail(body: () => unknown, detailPattern: RegExp): void {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof Error, 'the guard throws');
    const details = (error as { details?: ReadonlyArray<string> }).details ?? [];
    assert.ok(
      details.some((detail) => detailPattern.test(detail)),
      `a problem matches ${detailPattern} (got: ${details.join('; ')})`,
    );
    return;
  }
  assert.fail(`the guard did not throw (expected ${detailPattern})`);
}

test('MKT-072: the declared-bounds guard rejects malformed bounds (the honest seams)', () => {
  throwsWithDetail(
    () => assertValidDeclaredBounds({ spendCurrency: 'US', testBudgetMinorUnits: 1, maxDemandTests: 1, minOrderCountForViability: 1 }),
    /spendCurrency/,
  );
  throwsWithDetail(
    () => assertValidDeclaredBounds({ spendCurrency: 'USD', testBudgetMinorUnits: -1, maxDemandTests: 1, minOrderCountForViability: 1 }),
    /testBudgetMinorUnits/,
  );
  throwsWithDetail(
    () => assertValidDeclaredBounds({ spendCurrency: 'USD', testBudgetMinorUnits: 1, maxDemandTests: 0, minOrderCountForViability: 1 }),
    /maxDemandTests/,
  );
  throwsWithDetail(
    () => assertValidDeclaredBounds({ spendCurrency: 'USD', testBudgetMinorUnits: 1, maxDemandTests: 1, minOrderCountForViability: 0 }),
    /minOrderCountForViability/,
  );
  // The honest bounds pass.
  assert.doesNotThrow(() => assertValidDeclaredBounds(DECLARED));
});

test('MKT-072: the compose-input + provenance guards (fail-closed)', () => {
  const valid = {
    missionId: MISSION_ID,
    productContextId: CONTEXT_ID,
    pursuitWorkspaceId: uuid(901),
    storeConnectionId: uuid(902),
    declared: DECLARED,
    reason: 'initial discovery composition',
  };
  assert.doesNotThrow(() => assertValidComposeCommerceDiscoveryPlanInput(valid));
  throwsWithDetail(
    () => assertValidComposeCommerceDiscoveryPlanInput({ ...valid, missionId: 'not-a-uuid' }),
    /missionId/,
  );
  throwsWithDetail(
    () => assertValidComposeCommerceDiscoveryPlanInput({ ...valid, reason: '' }),
    /reason/,
  );
  throwsWithDetail(
    () =>
      assertValidComposeCommerceDiscoveryPlanInput({
        ...valid,
        declared: { ...DECLARED, testBudgetMinorUnits: 1.5 },
      }),
    /testBudgetMinorUnits/,
  );
  throwsWithDetail(
    () =>
      assertValidCommerceDiscoveryProvenance({
        actor: '',
        recordedVia: 'api',
        correlationId: 'x',
        causationId: null,
      }),
    /actor/,
  );
  throwsWithDetail(
    () =>
      assertValidCommerceDiscoveryProvenance({
        actor: 'user:x',
        recordedVia: '',
        correlationId: 'x',
        causationId: null,
      }),
    /recordedVia/,
  );
  assert.doesNotThrow(() =>
    assertValidCommerceDiscoveryProvenance({
      actor: 'user:x',
      recordedVia: 'api',
      correlationId: 'x',
      causationId: null,
    }),
  );
});
