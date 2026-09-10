/**
 * MKT-018 routing regression matrix — table-driven routing scenarios with
 * expected selections (the Tech Lead's required deliverable: "a routing
 * regression matrix (the Tech Lead will demand a table of routing scenarios
 * -> expected selection, each backed by a test)").
 *
 * Each row in the matrix is a routing scenario with:
 *   - a name;
 *   - a TaskProfile (the request contract);
 *   - a set of registry models (the candidate pool);
 *   - a routing policy (the declarative policy);
 *   - the expected eligible set (which models pass the hard-eligibility
 *     phase, with the reason for each ineligible model);
 *   - the expected chosen model (the highest-tradeoff-score eligible model);
 *   - the expected phase trace (eligibility → ranking → tradeoff → selection).
 *
 * Scenarios covered (the §4 hard-eligibility reasons + the §5 cascade
 * scenarios):
 *   1. hard-block (privacy) — a model with incompatible privacy is ineligible;
 *   2. hard-block (policy) — a denied provider/model is ineligible;
 *   3. hard-block (capability) — a model missing a required capability is ineligible;
 *   4. hard-block (quota) — a model whose cost exceeds the budget is ineligible;
 *   5. hard-block (subscription) — a model whose provider is not subscribed is ineligible;
 *   6. hard-block (availability) — an unavailable model is ineligible;
 *   7. cost/latency tradeoff — when two models are eligible, the cheaper/faster one is chosen;
 *   8. cascade escalation — when the cheap-first model fails the validator, the cascade escalates to the stronger model (AI-AC-05);
 *   9. fan-out — when the policy declares fanOut, the cascade tries N cheapest candidates as fan-out steps;
 *   10. frontier escalation — when the escalation budget is exhausted, the cascade escalates to the frontier model;
 *   11. human escalation — when all model options are exhausted and human escalation is enabled, the cascade escalates to a human step;
 *   12. empty eligible set — when no model is eligible, the chosen model is empty and the cascade fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretPolicy,
  selectModel,
  runCascade,
  defaultValidator,
  type AdapterRequest,
  type AdapterResponse,
  type InterpretedPolicy,
  type ModelRegistryRecord,
  type ProviderAdapter,
  type TaskProfileRecord,
} from '../../src/modules/ai-runtime/public.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';

function makeTaskProfile(overrides: Partial<TaskProfileRecord> = {}): TaskProfileRecord {
  return {
    taskProfileId: UUID_1,
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
    workspaceId: UUID_2,
    clientId: UUID_2,
    agencyId: UUID_2,
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

function makeModel(id: string, overrides: Partial<ModelRegistryRecord> = {}): ModelRegistryRecord {
  return {
    modelRegistryId: id,
    providerLabel: 'example-labs',
    modelKey: `model-${id}`,
    displayName: `Model ${id}`,
    capabilities: ['text-generation', 'tool-use'],
    toolFeatures: ['function-calling'],
    contextLimitTokens: 128_000,
    costInputPerMtok: 3.5,
    costOutputPerMtok: 10.0,
    latencyP50Ms: 900,
    latencyP95Ms: 2400,
    reliability: 0.98,
    qualitySignals: { 'copywriting.generate': 0.8 },
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

function makePolicy(content: Record<string, unknown> = {}): InterpretedPolicy {
  return interpretPolicy({
    routingPolicyId: UUID_3,
    policyName: 'default',
    policyContent: content,
    workspaceId: UUID_2,
    clientId: UUID_2,
    agencyId: UUID_2,
    status: 'active',
    idempotencyKey: 'policy-1',
    createFingerprint: 'a'.repeat(64),
    createdBy: null,
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

/** A fake adapter that returns a configured response per model. */
class FakeAdapter implements ProviderAdapter {
  readonly providerLabel = 'fake';
  private readonly responses: Map<string, () => AdapterResponse>;
  constructor(responses: Record<string, () => AdapterResponse>) {
    this.responses = new Map(Object.entries(responses));
  }
  async invoke(request: AdapterRequest): Promise<AdapterResponse> {
    const factory = this.responses.get(request.modelRegistryId);
    if (factory === undefined) {
      return {
        ok: false,
        output: null,
        error: `no fake response configured for model ${request.modelRegistryId}`,
        latencyMs: 10,
        costAmount: 0,
        tokensIn: null,
        tokensOut: null,
      };
    }
    return factory();
  }
}

/** A fake adapter response that produces a valid output (passes the default validator). */
function okResponse(output: Record<string, unknown> = { headline: 'test' }): AdapterResponse {
  return {
    ok: true,
    output,
    error: null,
    latencyMs: 100,
    costAmount: 0.001,
    tokensIn: 100,
    tokensOut: 20,
  };
}

/** A fake adapter response that produces an invalid output (fails the default validator). */
function badSchemaResponse(): AdapterResponse {
  return {
    ok: true,
    output: { wrongField: 'test' }, // missing required 'headline'
    error: null,
    latencyMs: 100,
    costAmount: 0.001,
    tokensIn: 100,
    tokensOut: 20,
  };
}

// ---------------------------------------------------------------------------
// Routing regression matrix (table-driven)
// ---------------------------------------------------------------------------

interface MatrixRow {
  readonly name: string;
  readonly profile: TaskProfileRecord;
  readonly models: readonly ModelRegistryRecord[];
  readonly policy: InterpretedPolicy;
  readonly expectedEligible: ReadonlyArray<{ readonly modelId: string; readonly eligible: boolean; readonly reason: string | null }>;
  readonly expectedChosen: string;
  readonly expectedPhaseTrace: readonly string[];
}

const matrix: readonly MatrixRow[] = [
  {
    name: 'hard-block (privacy) — a model with trainingUse=true on a restricted profile is ineligible',
    profile: makeTaskProfile({ privacyClass: 'restricted' }),
    models: [
      makeModel('m1', { privacyCharacteristics: { trainingUse: true } }),
      makeModel('m2', { privacyCharacteristics: { trainingUse: false } }),
    ],
    policy: makePolicy(),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'privacy' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (policy) — a denied provider label is ineligible',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { providerLabel: 'denied-labs' }),
      makeModel('m2', { providerLabel: 'allowed-labs' }),
    ],
    policy: makePolicy({ hardEligibility: { deniedProviderLabels: ['denied-labs'] } }),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'policy' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (policy) — a denied model key is ineligible',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { modelKey: 'denied-model' }),
      makeModel('m2', { modelKey: 'allowed-model' }),
    ],
    policy: makePolicy({ hardEligibility: { deniedModelKeys: ['denied-model'] } }),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'policy' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (capability) — a model missing a required capability is ineligible',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { capabilities: ['text-generation'] }), // missing tool-use
      makeModel('m2', { capabilities: ['text-generation', 'tool-use'] }),
    ],
    policy: makePolicy({ hardEligibility: { requiredCapabilities: ['text-generation', 'tool-use'] } }),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'capability' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (quota) — a model whose estimated cost exceeds the budget is ineligible',
    profile: makeTaskProfile({ maxCostPerInvocation: 0.001 }),
    models: [
      makeModel('m1', { costInputPerMtok: 10, costOutputPerMtok: 10 }), // ~0.015/invocation
      makeModel('m2', { costInputPerMtok: 0.5, costOutputPerMtok: 0.5 }), // ~0.00075/invocation
    ],
    policy: makePolicy(),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'quota' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (subscription) — a model whose provider is not subscribed is ineligible',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { providerLabel: 'unsubscribed-labs' }),
      makeModel('m2', { providerLabel: 'subscribed-labs' }),
    ],
    policy: makePolicy({ hardEligibility: { subscribedProviders: ['subscribed-labs'] } }),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'subscription' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'hard-block (availability) — an unavailable model is ineligible',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { availabilityState: 'unavailable' }),
      makeModel('m2', { availabilityState: 'available' }),
    ],
    policy: makePolicy(),
    expectedEligible: [
      { modelId: 'm1', eligible: false, reason: 'availability' },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2',
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'cost/latency tradeoff — when two models are eligible, the cheaper/faster one is chosen (when quality is equal)',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', {
        costInputPerMtok: 5.0, // more expensive
        latencyP50Ms: 500, // slower
        qualitySignals: { 'copywriting.generate': 0.8 },
      }),
      makeModel('m2', {
        costInputPerMtok: 1.0, // cheaper
        latencyP50Ms: 100, // faster
        qualitySignals: { 'copywriting.generate': 0.8 }, // same quality
      }),
    ],
    policy: makePolicy(),
    expectedEligible: [
      { modelId: 'm1', eligible: true, reason: null },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm2', // cheaper + faster + same quality
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'cost/latency tradeoff — when two models are eligible with different quality, the higher-quality one is chosen when the tradeoff weights favor quality',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', {
        costInputPerMtok: 1.0,
        latencyP50Ms: 100,
        qualitySignals: { 'copywriting.generate': 0.9 }, // higher quality
      }),
      makeModel('m2', {
        costInputPerMtok: 0.5, // cheaper
        latencyP50Ms: 50, // faster
        qualitySignals: { 'copywriting.generate': 0.5 }, // lower quality
      }),
    ],
    policy: makePolicy({ tradeoff: { qualityWeight: 0.8, costWeight: 0.1, latencyWeight: 0.1 } }),
    expectedEligible: [
      { modelId: 'm1', eligible: true, reason: null },
      { modelId: 'm2', eligible: true, reason: null },
    ],
    expectedChosen: 'm1', // higher quality wins with quality-weight-favoring policy
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
  {
    name: 'empty eligible set — when no model is eligible, the chosen model is empty',
    profile: makeTaskProfile({ privacyClass: 'restricted' }),
    models: [
      makeModel('m1', { privacyCharacteristics: { trainingUse: true } }), // ineligible
    ],
    policy: makePolicy(),
    expectedEligible: [{ modelId: 'm1', eligible: false, reason: 'privacy' }],
    expectedChosen: '', // empty
    expectedPhaseTrace: ['eligibility', 'ranking', 'tradeoff', 'selection'],
  },
];

// Run the matrix as table-driven tests.
for (const row of matrix) {
  test(`routing regression matrix: ${row.name}`, () => {
    const selection = selectModel({
      taskProfile: row.profile,
      models: row.models,
      policy: row.policy,
    });
    // Eligible set matches.
    assert.equal(selection.eligibleSet.length, row.expectedEligible.length);
    for (const expected of row.expectedEligible) {
      const actual = selection.eligibleSet.find((d) => d.modelRegistryId === expected.modelId);
      assert.ok(actual, `expected eligible decision for ${expected.modelId}`);
      assert.equal(actual!.eligible, expected.eligible);
      assert.equal(actual!.reason, expected.reason);
    }
    // Chosen model.
    assert.equal(selection.chosenModelRegistryId, row.expectedChosen);
    // Phase trace.
    assert.deepEqual([...selection.phaseTrace], row.expectedPhaseTrace);
  });
}

// ---------------------------------------------------------------------------
// Cascade regression matrix (table-driven) — AI-AC-05
// ---------------------------------------------------------------------------

interface CascadeMatrixRow {
  readonly name: string;
  readonly profile: TaskProfileRecord;
  readonly models: readonly ModelRegistryRecord[];
  readonly policy: InterpretedPolicy;
  readonly adapter: ProviderAdapter;
  readonly expectedStatus: 'completed' | 'escalated' | 'failed' | 'unknown';
  readonly expectedFinalModel: string | null;
  readonly expectedStepCount: number;
  readonly expectedEscalationCount: number;
}

const cascadeMatrix: readonly CascadeMatrixRow[] = [
  {
    name: 'cascade escalation (AI-AC-05) — the cheap-first model fails the validator, the cascade escalates to the stronger model',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 2 } }),
    adapter: new FakeAdapter({
      m1: badSchemaResponse, // cheap-first fails the validator
      m2: okResponse, // stronger model passes
    }),
    expectedStatus: 'completed',
    expectedFinalModel: 'm2',
    expectedStepCount: 2, // m1 (cheap-first) + m2 (escalate)
    expectedEscalationCount: 1,
  },
  {
    name: 'cascade completes on the cheap-first model when the validator passes',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 2 } }),
    adapter: new FakeAdapter({
      m1: okResponse, // cheap-first passes
      m2: okResponse,
    }),
    expectedStatus: 'completed',
    expectedFinalModel: 'm1',
    expectedStepCount: 1, // only m1 (cheap-first)
    expectedEscalationCount: 0,
  },
  {
    name: 'cascade fails when no model passes the validator and human escalation is disabled',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 2, humanEscalationEnabled: false } }),
    adapter: new FakeAdapter({
      m1: badSchemaResponse,
      m2: badSchemaResponse,
    }),
    expectedStatus: 'failed',
    expectedFinalModel: null,
    expectedStepCount: 2,
    expectedEscalationCount: 1,
  },
  {
    name: 'cascade escalates to human when all models fail and human escalation is enabled',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 2, humanEscalationEnabled: true } }),
    adapter: new FakeAdapter({
      m1: badSchemaResponse,
      m2: badSchemaResponse,
    }),
    expectedStatus: 'escalated',
    expectedFinalModel: null,
    expectedStepCount: 3, // m1 (cheap-first) + m2 (escalate) + human step
    expectedEscalationCount: 1,
  },
  {
    name: 'fan-out — when the policy declares fanOut, the cascade tries the N cheapest candidates as fan-out steps',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 1.0, qualitySignals: { 'copywriting.generate': 0.7 } }),
      makeModel('m3', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 2, fanOut: true } }),
    adapter: new FakeAdapter({
      m1: badSchemaResponse, // fan-out candidate 1 fails
      m2: okResponse, // fan-out candidate 2 passes
      m3: okResponse,
    }),
    expectedStatus: 'completed',
    expectedFinalModel: 'm2',
    expectedStepCount: 2, // m1 (fan-out) + m2 (fan-out)
    expectedEscalationCount: 0, // fan-out failures do not count as escalations
  },
  {
    name: 'frontier escalation — when the escalation budget is exhausted, the cascade escalates to the frontier model',
    profile: makeTaskProfile(),
    models: [
      makeModel('m1', { costInputPerMtok: 0.5, qualitySignals: { 'copywriting.generate': 0.5 } }),
      makeModel('m2', { costInputPerMtok: 1.0, qualitySignals: { 'copywriting.generate': 0.7 } }),
      makeModel('m3', { costInputPerMtok: 5.0, qualitySignals: { 'copywriting.generate': 0.9 } }),
    ],
    policy: makePolicy({ cascade: { maxEscalations: 1, frontierThreshold: 1, humanEscalationEnabled: false } }),
    adapter: new FakeAdapter({
      m1: badSchemaResponse, // cheap-first fails
      m3: badSchemaResponse, // escalate (highest tradeoff) fails
      m2: okResponse, // frontier (next untried in cheap-first order) passes
    }),
    expectedStatus: 'completed',
    expectedFinalModel: 'm2',
    expectedStepCount: 3, // m1 (cheap-first) + m3 (escalate) + m2 (frontier)
    expectedEscalationCount: 2, // 1 escalate + 1 frontier
  },
  {
    name: 'empty eligible set — the cascade fails with no steps',
    profile: makeTaskProfile({ privacyClass: 'restricted' }),
    models: [
      makeModel('m1', { privacyCharacteristics: { trainingUse: true } }), // ineligible
    ],
    policy: makePolicy(),
    adapter: new FakeAdapter({}),
    expectedStatus: 'failed',
    expectedFinalModel: null,
    expectedStepCount: 0,
    expectedEscalationCount: 0,
  },
];

// Run the cascade matrix as table-driven tests.
for (const row of cascadeMatrix) {
  test(`cascade regression matrix: ${row.name}`, async () => {
    const selection = selectModel({
      taskProfile: row.profile,
      models: row.models,
      policy: row.policy,
    });
    const eligibleModels = row.models.filter((m) =>
      selection.eligibleSet.some((d) => d.modelRegistryId === m.modelRegistryId && d.eligible),
    );
    const cascadeResult = await runCascade({
      taskProfile: row.profile,
      policy: row.policy,
      eligibleModels,
      selection,
      adapter: row.adapter,
      validator: defaultValidator,
      invocationInput: { prompt: 'generate a headline' },
    });
    assert.equal(cascadeResult.status, row.expectedStatus, `cascade status mismatch for: ${row.name}`);
    assert.equal(
      cascadeResult.finalModelRegistryId,
      row.expectedFinalModel,
      `final model mismatch for: ${row.name}`,
    );
    assert.equal(cascadeResult.steps.length, row.expectedStepCount, `step count mismatch for: ${row.name}`);
    assert.equal(
      cascadeResult.escalationCount,
      row.expectedEscalationCount,
      `escalation count mismatch for: ${row.name}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Sanity: the matrix exercises every §4 hard-eligibility reason
// ---------------------------------------------------------------------------

test('the routing regression matrix exercises every §4 hard-eligibility reason', () => {
  const exercisedReasons = new Set<string>();
  for (const row of matrix) {
    for (const e of row.expectedEligible) {
      if (!e.eligible && e.reason !== null) {
        exercisedReasons.add(e.reason);
      }
    }
  }
  // Every §4 hard-eligibility reason is exercised.
  for (const reason of ['privacy', 'policy', 'capability', 'quota', 'subscription', 'availability']) {
    assert.ok(exercisedReasons.has(reason), `the matrix must exercise the '${reason}' hard-eligibility reason`);
  }
});

test('the cascade regression matrix exercises every §5 cascade scenario', () => {
  const exercisedScenarios = new Set<string>();
  for (const row of cascadeMatrix) {
    exercisedScenarios.add(row.name.split(' — ')[0]!.trim());
  }
  // The cascade matrix exercises: cascade escalation, cascade completes,
  // cascade fails, human escalation, fan-out, frontier escalation, empty
  // eligible set.
  for (const scenario of [
    'cascade escalation',
    'cascade completes',
    'cascade fails',
    'cascade escalates to human',
    'fan-out',
    'frontier escalation',
    'empty eligible set',
  ]) {
    assert.ok(
      [...exercisedScenarios].some((s) => s.includes(scenario)),
      `the cascade matrix must exercise the '${scenario}' scenario`,
    );
  }
});
