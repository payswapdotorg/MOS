/**
 * MKT-018 unit tests — the routing policy pure functions (AI-002, AI-AC-04
 * phase order + AI-AC-07 capability non-clipping).
 *
 * Acceptance mapping (work-items.md MKT-018 = AI-002 / AI-AC-03..07):
 *   - AI-AC-04 ("hard constraints are evaluated before performance ranking
 *     — unit test"): the phase order is eligibility → ranking → tradeoff →
 *     selection (the ROUTING_PHASE_ORDER constant), AND the selectModel
 *     function produces a phaseTrace in this exact order. An ineligible
 *     model never appears in the ranking or tradeoff arrays.
 *   - AI-AC-07 ("model capability is not artificially clipped merely for
 *     benchmark normalization — static/unit test"): the ranking function
 *     NORMALIZES the quality signal to a 0..1 score for comparison, but
 *     the registry record's `capabilities` and `qualitySignals` fields
 *     are NEVER mutated (the function returns new RankingScore objects,
 *     not mutations to the input models).
 *   - eligibility gates: each of the 6 hard-eligibility reasons (privacy,
 *     policy, capability, quota, subscription, availability) is
 *     exercised with a model that fails ONLY that phase.
 *   - ranking math: the normalization is correct (the highest-scoring
 *     model has score 1.0; the lowest has score 0.0; ties at the top all
 *     get 1.0).
 *   - tradeoff math: the weighted sum is correct; the weights are
 *     applied as declared.
 *   - DTO rejection: the routing-policy input guard REJECTS provider/model/
 *     credential-shaped keys (the AI-AC-01 module-side authority, extended
 *     to the routing policy).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidRoutingPolicyInput,
  computeEligibility,
  computeRanking,
  computeTradeoff,
  interpretPolicy,
  selectModel,
  ROUTING_PHASE_ORDER,
  ELIGIBILITY_REASON_PRIORITY,
  ELIGIBILITY_REASONS,
  ROUTING_PHASES,
  type InterpretedPolicy,
  type ModelRegistryRecord,
  type RoutingPolicyRecord,
  type TaskProfileRecord,
} from '../../src/modules/ai-runtime/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE_UUID_1 = '11111111-1111-4111-8111-111111111111';
const PROFILE_UUID_2 = '22222222-2222-4222-8222-222222222222';
const PROFILE_UUID_3 = '33333333-3333-4333-8333-333333333333';

function validTaskProfile(overrides: Partial<TaskProfileRecord> = {}): TaskProfileRecord {
  return {
    taskProfileId: PROFILE_UUID_1,
    taskClass: 'copywriting.generate',
    qualityTarget: 'publication-ready',
    riskClass: 'medium',
    contextRequirements: { minInputTokens: 200, maxInputTokens: 8000 },
    latencyTargetMs: 30_000,
    maxCostPerInvocation: 0.25,
    privacyClass: 'internal',
    toolRequirements: ['web-search'],
    outputSchema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
    evaluatorIds: ['brand-voice-rubric'],
    escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
    workspaceId: PROFILE_UUID_2,
    clientId: PROFILE_UUID_2,
    agencyId: PROFILE_UUID_2,
    status: 'active',
    idempotencyKey: 'profile-1',
    createFingerprint: 'a'.repeat(64),
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function validModel(overrides: Partial<ModelRegistryRecord> = {}): ModelRegistryRecord {
  return {
    modelRegistryId: PROFILE_UUID_3,
    providerLabel: 'example-labs',
    modelKey: 'example-model-xl',
    displayName: 'Example Model XL',
    capabilities: ['text-generation', 'tool-use'],
    toolFeatures: ['function-calling'],
    contextLimitTokens: 128_000,
    costInputPerMtok: 3.5,
    costOutputPerMtok: 10.0,
    latencyP50Ms: 900,
    latencyP95Ms: 2400,
    reliability: 0.98,
    qualitySignals: { 'copywriting.generate': 0.87 },
    privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
    availabilityState: 'available',
    status: 'active',
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function validPolicy(overrides: Partial<RoutingPolicyRecord> = {}): RoutingPolicyRecord {
  return {
    routingPolicyId: PROFILE_UUID_3,
    policyName: 'default',
    policyContent: {},
    workspaceId: PROFILE_UUID_2,
    clientId: PROFILE_UUID_2,
    agencyId: PROFILE_UUID_2,
    status: 'active',
    idempotencyKey: 'policy-1',
    createFingerprint: 'a'.repeat(64),
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AI-AC-04 — phase order (eligibility → ranking → tradeoff → selection)
// ---------------------------------------------------------------------------

test('AI-AC-04: ROUTING_PHASE_ORDER is exactly [eligibility, ranking, tradeoff, selection]', () => {
  assert.deepEqual(ROUTING_PHASE_ORDER, ['eligibility', 'ranking', 'tradeoff', 'selection']);
  assert.deepEqual([...ROUTING_PHASES], ['eligibility', 'ranking', 'tradeoff', 'selection']);
});

test('AI-AC-04: ELIGIBILITY_REASON_PRIORITY is exactly [privacy, policy, capability, quota, subscription, availability]', () => {
  assert.deepEqual(ELIGIBILITY_REASON_PRIORITY, [
    'privacy',
    'policy',
    'capability',
    'quota',
    'subscription',
    'availability',
  ]);
  assert.deepEqual([...ELIGIBILITY_REASONS], [
    'privacy',
    'policy',
    'capability',
    'quota',
    'subscription',
    'availability',
  ]);
});

test('AI-AC-04: selectModel produces a phaseTrace in the exact §4 phase order', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', qualitySignals: { 'copywriting.generate': 0.9 } }),
    validModel({ modelRegistryId: 'm2', qualitySignals: { 'copywriting.generate': 0.7 } }),
  ];
  const policy = interpretPolicy(validPolicy());
  const selection = selectModel({ taskProfile: profile, models, policy });
  assert.deepEqual(selection.phaseTrace, ['eligibility', 'ranking', 'tradeoff', 'selection']);
});

test('AI-AC-04: an ineligible model NEVER appears in the ranking or tradeoff arrays', () => {
  const profile = validTaskProfile({ privacyClass: 'restricted' });
  const models = [
    // m1 is INELIGIBLE on privacy (trainingUse: true on a restricted profile).
    validModel({
      modelRegistryId: 'm1',
      privacyCharacteristics: { dataResidency: 'eu', trainingUse: true },
      qualitySignals: { 'copywriting.generate': 0.99 },
    }),
    // m2 is ELIGIBLE.
    validModel({
      modelRegistryId: 'm2',
      privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
      qualitySignals: { 'copywriting.generate': 0.5 },
    }),
  ];
  const policy = interpretPolicy(validPolicy());
  const selection = selectModel({ taskProfile: profile, models, policy });

  // The eligible set includes both models (one eligible, one not).
  assert.equal(selection.eligibleSet.length, 2);
  const m1Decision = selection.eligibleSet.find((d) => d.modelRegistryId === 'm1');
  const m2Decision = selection.eligibleSet.find((d) => d.modelRegistryId === 'm2');
  assert.ok(m1Decision);
  assert.equal(m1Decision!.eligible, false);
  assert.equal(m1Decision!.reason, 'privacy');
  assert.ok(m2Decision);
  assert.equal(m2Decision!.eligible, true);
  assert.equal(m2Decision!.reason, null);

  // The ranking array contains ONLY eligible models.
  assert.equal(selection.ranking.length, 1);
  assert.equal(selection.ranking[0]!.modelRegistryId, 'm2');

  // The tradeoff array contains ONLY eligible models.
  assert.equal(selection.tradeoff.length, 1);
  assert.equal(selection.tradeoff[0]!.modelRegistryId, 'm2');

  // The chosen model is the eligible one (m2), NOT the higher-quality but
  // ineligible m1 (hard constraints are NOT soft quality penalties —
  // AI-AC-04).
  assert.equal(selection.chosenModelRegistryId, 'm2');
});

// ---------------------------------------------------------------------------
// AI-AC-04 — each hard-eligibility gate (privacy/policy/capability/quota/subscription/availability)
// ---------------------------------------------------------------------------

test('AI-AC-04 eligibility gate: PRIVACY — trainingUse on a restricted/confidential profile is ineligible', () => {
  const profile = validTaskProfile({ privacyClass: 'restricted' });
  const models = [
    validModel({ modelRegistryId: 'm1', privacyCharacteristics: { trainingUse: true } }),
  ];
  const decisions = computeEligibility({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'privacy');
});

test('AI-AC-04 eligibility gate: POLICY — a denied provider label is ineligible', () => {
  const profile = validTaskProfile();
  const models = [validModel({ modelRegistryId: 'm1', providerLabel: 'denied-labs' })];
  const policy = interpretPolicy(
    validPolicy({
      policyContent: {
        hardEligibility: { deniedProviderLabels: ['denied-labs'] },
      },
    }),
  );
  const decisions = computeEligibility({ taskProfile: profile, models, policy });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'policy');
});

test('AI-AC-04 eligibility gate: POLICY — a denied model key is ineligible', () => {
  const profile = validTaskProfile();
  const models = [validModel({ modelRegistryId: 'm1', modelKey: 'denied-model' })];
  const policy = interpretPolicy(
    validPolicy({
      policyContent: {
        hardEligibility: { deniedModelKeys: ['denied-model'] },
      },
    }),
  );
  const decisions = computeEligibility({ taskProfile: profile, models, policy });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'policy');
});

test('AI-AC-04 eligibility gate: CAPABILITY — a model missing a required capability is ineligible', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', capabilities: ['text-generation'] }),
  ];
  const policy = interpretPolicy(
    validPolicy({
      policyContent: {
        hardEligibility: { requiredCapabilities: ['text-generation', 'tool-use'] },
      },
    }),
  );
  const decisions = computeEligibility({ taskProfile: profile, models, policy });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'capability');
});

test('AI-AC-04 eligibility gate: CAPABILITY — a model missing a required tool feature is ineligible', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', toolFeatures: ['function-calling'] }),
  ];
  const policy = interpretPolicy(
    validPolicy({
      policyContent: {
        hardEligibility: { requiredToolFeatures: ['function-calling', 'parallel-tools'] },
      },
    }),
  );
  const decisions = computeEligibility({ taskProfile: profile, models, policy });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'capability');
});

test('AI-AC-04 eligibility gate: QUOTA — a model whose estimated cost exceeds the profile budget is ineligible', () => {
  // Profile budget: $0.001 per invocation. Model cost: $10/Mtok input +
  // $10/Mtok output. Estimated cost (1000 in + 500 out): (10*1000 + 10*500)
  // / 1_000_000 = 0.015 > 0.001.
  const profile = validTaskProfile({ maxCostPerInvocation: 0.001 });
  const models = [
    validModel({
      modelRegistryId: 'm1',
      costInputPerMtok: 10,
      costOutputPerMtok: 10,
    }),
  ];
  const decisions = computeEligibility({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'quota');
});

test('AI-AC-04 eligibility gate: SUBSCRIPTION — a model whose provider is not on the allow-list is ineligible', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', providerLabel: 'unsubscribed-labs' }),
  ];
  const policy = interpretPolicy(
    validPolicy({
      policyContent: {
        hardEligibility: { subscribedProviders: ['subscribed-labs'] },
      },
    }),
  );
  const decisions = computeEligibility({ taskProfile: profile, models, policy });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'subscription');
});

test('AI-AC-04 eligibility gate: AVAILABILITY — an unavailable model is ineligible', () => {
  const profile = validTaskProfile();
  const models = [validModel({ modelRegistryId: 'm1', availabilityState: 'unavailable' })];
  const decisions = computeEligibility({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(decisions[0]!.eligible, false);
  assert.equal(decisions[0]!.reason, 'availability');
});

test('AI-AC-04 eligibility gate: a model that passes ALL hard constraints is eligible', () => {
  const profile = validTaskProfile();
  const models = [validModel({ modelRegistryId: 'm1' })];
  const decisions = computeEligibility({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(decisions[0]!.eligible, true);
  assert.equal(decisions[0]!.reason, null);
});

test('AI-AC-04 eligibility gate: NULL cost signals do NOT cause quota ineligibility (NULL is unknown, not a failure)', () => {
  const profile = validTaskProfile({ maxCostPerInvocation: 0.001 });
  const models = [
    validModel({ modelRegistryId: 'm1', costInputPerMtok: null, costOutputPerMtok: null }),
  ];
  const decisions = computeEligibility({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(decisions[0]!.eligible, true);
  assert.equal(decisions[0]!.reason, null);
});

// ---------------------------------------------------------------------------
// AI-AC-07 — capability non-clipping (ranking math only, never mutates the registry)
// ---------------------------------------------------------------------------

test('AI-AC-07: computeRanking does NOT mutate the registry record qualitySignals', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', qualitySignals: { 'copywriting.generate': 0.9 } }),
    validModel({ modelRegistryId: 'm2', qualitySignals: { 'copywriting.generate': 0.5 } }),
  ];
  // Snapshot the qualitySignals before ranking.
  const m1Before = JSON.stringify(models[0]!.qualitySignals);
  const m2Before = JSON.stringify(models[1]!.qualitySignals);
  const m1CapabilitiesBefore = JSON.stringify(models[0]!.capabilities);
  const m2CapabilitiesBefore = JSON.stringify(models[1]!.capabilities);

  computeRanking({ taskProfile: profile, eligibleModels: models });

  // The registry records are UNMUTATED — the ranking normalizes the score
  // for comparison, but the declared signals stay as declared.
  assert.equal(JSON.stringify(models[0]!.qualitySignals), m1Before);
  assert.equal(JSON.stringify(models[1]!.qualitySignals), m2Before);
  assert.equal(JSON.stringify(models[0]!.capabilities), m1CapabilitiesBefore);
  assert.equal(JSON.stringify(models[1]!.capabilities), m2CapabilitiesBefore);
});

test('AI-AC-07: computeRanking normalizes scores to 0..1 (highest = 1.0, lowest = 0.0)', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', qualitySignals: { 'copywriting.generate': 0.9 } }),
    validModel({ modelRegistryId: 'm2', qualitySignals: { 'copywriting.generate': 0.5 } }),
    validModel({ modelRegistryId: 'm3', qualitySignals: { 'copywriting.generate': 0.7 } }),
  ];
  const ranking = computeRanking({ taskProfile: profile, eligibleModels: models });
  // Sorted descending by score.
  assert.equal(ranking[0]!.modelRegistryId, 'm1');
  assert.equal(ranking[0]!.score, 1.0); // highest
  assert.equal(ranking[ranking.length - 1]!.modelRegistryId, 'm2');
  assert.equal(ranking[ranking.length - 1]!.score, 0.0); // lowest
  // m3 is in between.
  const m3 = ranking.find((r) => r.modelRegistryId === 'm3');
  assert.ok(m3);
  assert.ok(m3!.score > 0 && m3!.score < 1);
});

test('AI-AC-07: computeRanking with all-equal scores gives every model 1.0 (no penalty for a tie at the top)', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', qualitySignals: { 'copywriting.generate': 0.8 } }),
    validModel({ modelRegistryId: 'm2', qualitySignals: { 'copywriting.generate': 0.8 } }),
  ];
  const ranking = computeRanking({ taskProfile: profile, eligibleModels: models });
  for (const r of ranking) {
    assert.equal(r.score, 1.0);
  }
});

test('AI-AC-07: computeRanking with no quality signal gives score 0 (the model is NOT excluded)', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({ modelRegistryId: 'm1', qualitySignals: {} }),
    validModel({ modelRegistryId: 'm2', qualitySignals: { 'copywriting.generate': 0.8 } }),
  ];
  const ranking = computeRanking({ taskProfile: profile, eligibleModels: models });
  const m1 = ranking.find((r) => r.modelRegistryId === 'm1');
  assert.ok(m1);
  assert.equal(m1!.score, 0); // no signal = 0, but the model is still in the ranking
  const m2 = ranking.find((r) => r.modelRegistryId === 'm2');
  assert.ok(m2);
  assert.equal(m2!.score, 1.0);
});

// ---------------------------------------------------------------------------
// Tradeoff math
// ---------------------------------------------------------------------------

test('computeTradeoff: the weighted sum is correct (quality + cost + latency)', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({
      modelRegistryId: 'm1',
      qualitySignals: { 'copywriting.generate': 0.9 },
      costInputPerMtok: 1.0, // cheapest
      latencyP50Ms: 100, // fastest
    }),
    validModel({
      modelRegistryId: 'm2',
      qualitySignals: { 'copywriting.generate': 0.5 },
      costInputPerMtok: 5.0, // more expensive
      latencyP50Ms: 500, // slower
    }),
  ];
  const ranking = computeRanking({ taskProfile: profile, eligibleModels: models });
  const policy: InterpretedPolicy = {
    deniedProviderLabels: new Set(),
    deniedModelKeys: new Set(),
    requiredCapabilities: new Set(),
    requiredToolFeatures: new Set(),
    requiredPrivacyFloor: null,
    subscribedProviders: new Set(),
    qualityWeight: 0.5,
    costWeight: 0.25,
    latencyWeight: 0.25,
    maxEscalations: 2,
    fanOut: false,
    frontierThreshold: 1,
    humanEscalationEnabled: false,
  };
  const tradeoff = computeTradeoff({
    taskProfile: profile,
    rankedModels: models,
    ranking,
    policy,
  });
  // m1: quality=1.0 (highest), cost=1.0 (cheapest), latency=1.0 (fastest).
  // Tradeoff = 0.5*1 + 0.25*1 + 0.25*1 = 1.0.
  const m1 = tradeoff.find((t) => t.modelRegistryId === 'm1');
  assert.ok(m1);
  assert.equal(m1!.qualityComponent, 1.0);
  assert.equal(m1!.costComponent, 1.0);
  assert.equal(m1!.latencyComponent, 1.0);
  assert.equal(m1!.score, 1.0);
  // m2: quality=0.0 (lowest), cost=0.0 (most expensive), latency=0.0 (slowest).
  // Tradeoff = 0.5*0 + 0.25*0 + 0.25*0 = 0.0.
  const m2 = tradeoff.find((t) => t.modelRegistryId === 'm2');
  assert.ok(m2);
  assert.equal(m2!.qualityComponent, 0.0);
  assert.equal(m2!.costComponent, 0.0);
  assert.equal(m2!.latencyComponent, 0.0);
  assert.equal(m2!.score, 0.0);
});

test('computeTradeoff: NULL cost/latency signals give 0.5 (neutral, never fabricated)', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({
      modelRegistryId: 'm1',
      qualitySignals: { 'copywriting.generate': 0.9 },
      costInputPerMtok: null,
      latencyP50Ms: null,
    }),
  ];
  const ranking = computeRanking({ taskProfile: profile, eligibleModels: models });
  const policy: InterpretedPolicy = {
    deniedProviderLabels: new Set(),
    deniedModelKeys: new Set(),
    requiredCapabilities: new Set(),
    requiredToolFeatures: new Set(),
    requiredPrivacyFloor: null,
    subscribedProviders: new Set(),
    qualityWeight: 0.5,
    costWeight: 0.25,
    latencyWeight: 0.25,
    maxEscalations: 2,
    fanOut: false,
    frontierThreshold: 1,
    humanEscalationEnabled: false,
  };
  const tradeoff = computeTradeoff({
    taskProfile: profile,
    rankedModels: models,
    ranking,
    policy,
  });
  const m1 = tradeoff[0]!;
  assert.equal(m1.costComponent, 0.5);
  assert.equal(m1.latencyComponent, 0.5);
});

// ---------------------------------------------------------------------------
// selectModel — the full §4 pipeline
// ---------------------------------------------------------------------------

test('selectModel: returns an empty chosen model when the eligible set is empty', () => {
  const profile = validTaskProfile({ privacyClass: 'restricted' });
  const models = [
    validModel({
      modelRegistryId: 'm1',
      privacyCharacteristics: { trainingUse: true }, // ineligible on privacy
    }),
  ];
  const selection = selectModel({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(selection.chosenModelRegistryId, '');
  assert.equal(selection.ranking.length, 0);
  assert.equal(selection.tradeoff.length, 0);
  assert.equal(selection.eligibleSet.length, 1);
  assert.equal(selection.eligibleSet[0]!.eligible, false);
});

test('selectModel: the chosen model is the highest-tradeoff-score eligible model', () => {
  const profile = validTaskProfile();
  const models = [
    validModel({
      modelRegistryId: 'm1',
      qualitySignals: { 'copywriting.generate': 0.9 },
      costInputPerMtok: 1.0,
      latencyP50Ms: 100,
    }),
    validModel({
      modelRegistryId: 'm2',
      qualitySignals: { 'copywriting.generate': 0.5 },
      costInputPerMtok: 5.0,
      latencyP50Ms: 500,
    }),
  ];
  const selection = selectModel({
    taskProfile: profile,
    models,
    policy: interpretPolicy(validPolicy()),
  });
  assert.equal(selection.chosenModelRegistryId, 'm1');
  assert.equal(selection.tradeoff[0]!.modelRegistryId, 'm1');
});

// ---------------------------------------------------------------------------
// DTO rejection — the routing-policy input guard (AI-AC-01 module-side authority)
// ---------------------------------------------------------------------------

test('DTO rejection: the routing policy input guard REJECTS SDK/adapter/credential-shaped keys', () => {
  // NOTE: a routing policy MAY carry provider/model LABELS as declarative
  // allow/deny lists (e.g., deniedProviderLabels: ['openai']) inside
  // policyContent — that is DATA, not a provider/model selection. The
  // forbidden keys are SDK/adapter/credential-shaped (the routing policy
  // is DATA, never an SDK import, adapter configuration or credential).
  for (const forbidden of ['sdk', 'sdkPackage', 'clientLibrary', 'adapter', 'adapterConfig', 'credential', 'credentialId', 'secretHandle', 'secret', 'secretMaterial', 'material', 'apiKey', 'api_key', 'token', 'password']) {
    assert.throws(
      () =>
        assertValidRoutingPolicyInput({
          policyName: 'test',
          policyContent: {},
          [forbidden]: 'value',
        } as unknown as Parameters<typeof assertValidRoutingPolicyInput>[0]),
      (error: Error) => error.message.includes('forbidden key'),
      `the routing policy guard must reject the '${forbidden}' key`,
    );
  }
});

test('DTO rejection: the routing policy input guard REJECTS server-derived authority fields', () => {
  for (const forbidden of [
    'routingPolicyId',
    'workspaceId',
    'clientId',
    'agencyId',
    'status',
    'version',
    'createFingerprint',
    'createdBy',
    'createdAt',
    'updatedAt',
  ]) {
    assert.throws(
      () =>
        assertValidRoutingPolicyInput({
          policyName: 'test',
          policyContent: {},
          [forbidden]: 'value',
        } as unknown as Parameters<typeof assertValidRoutingPolicyInput>[0]),
      (error: Error) => error.message.includes('forbidden key'),
      `the routing policy guard must reject the '${forbidden}' authority field`,
    );
  }
});

test('DTO rejection: the routing policy input guard accepts a valid policy', () => {
  assert.doesNotThrow(() =>
    assertValidRoutingPolicyInput({
      policyName: 'default-policy',
      policyContent: {
        hardEligibility: { deniedProviderLabels: ['bad-labs'] },
        tradeoff: { qualityWeight: 0.6, costWeight: 0.2, latencyWeight: 0.2 },
        cascade: { maxEscalations: 3 },
      },
    }),
  );
});

test('DTO rejection: the routing policy input guard REJECTS an invalid policy name', () => {
  assert.throws(
    () =>
      assertValidRoutingPolicyInput({
        policyName: '', // empty
        policyContent: {},
      }),
    (error: Error) => error.message.includes('policyName'),
  );
  assert.throws(
    () =>
      assertValidRoutingPolicyInput({
        policyName: 'a'.repeat(101), // too long
        policyContent: {},
      }),
    (error: Error) => error.message.includes('policyName'),
  );
});
