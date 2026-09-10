/**
 * MKT-017 unit tests — the provider-neutral TaskProfile contract, the
 * normalized model-registry record and the usage-telemetry input guards
 * (pure functions, no DB).
 *
 * Acceptance mapping (work-item-matrix.md MKT-017 = AI-001 / AI-AC-01..02):
 *   - AI-AC-01 (module-level proof half): TASK_PROFILE_CONTRACT_FIELDS is
 *     EXACTLY the implementation-contract §10 field list, and the input
 *     guards REJECT provider/model/credential-shaped keys — a TaskProfile
 *     can never carry a provider or model selection;
 *   - AI-AC-02 (module-level proof half): the model-registration guard
 *     REJECTS SDK/credential-shaped keys — the registry record is LABELS
 *     (data), never an SDK import, adapter configuration or credential;
 *   - registry invariants: the closed risk/privacy/outcome vocabularies,
 *     signal bounds (costs, latency, reliability), UUID reference ids and
 *     the §8-style idempotency-key bounds;
 *   - the frozen registry lifecycles: active → retired single edge, retired
 *     terminal — for TaskProfiles AND model-registry entries.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidIdempotencyKey,
  assertValidModelObservationInput,
  assertValidModelRegistrationInput,
  assertValidTaskProfileInput,
  assertValidUsageTelemetryInput,
  isLegalModelRegistryTransition,
  isLegalTaskProfileTransition,
  MODEL_AVAILABILITY_STATES,
  MODEL_REGISTRY_TRANSITIONS,
  TASK_PROFILE_CONTRACT_FIELDS,
  TASK_PROFILE_FORBIDDEN_INPUT_KEYS,
  TASK_PROFILE_PRIVACY_CLASSES,
  TASK_PROFILE_RISK_CLASSES,
  TASK_PROFILE_TRANSITIONS,
  USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS,
  USAGE_TELEMETRY_OUTCOMES,
  type ModelRegistrationInput,
  type TaskProfileInput,
  type UsageTelemetryInput,
} from '../../src/modules/ai-runtime/public.ts';

const PROFILE_UUID = '11111111-1111-4111-8111-111111111111';
const MODEL_UUID = '22222222-2222-4222-8222-222222222222';
const EXECUTION_UUID = '33333333-3333-4333-8333-333333333333';

/** A fully valid §10 TaskProfile input. */
function validProfile(): TaskProfileInput {
  return {
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
  };
}

/** A fully valid model-registration input. */
function validModel(): ModelRegistrationInput {
  return {
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
  };
}

/** A fully valid usage-telemetry input. */
function validUsage(): UsageTelemetryInput {
  return {
    taskProfileId: PROFILE_UUID,
    modelRegistryId: MODEL_UUID,
    executionId: EXECUTION_UUID,
    outcome: 'succeeded',
    latencyMs: 1234,
    costAmount: 0.0125,
    tokensIn: 1500,
    tokensOut: 420,
    evaluationRef: 'eval:brand-voice-rubric:run-42',
    escalationCount: 0,
    idempotencyKey: 'usage-append-1',
  };
}

/** Every guard throws InvalidRequestError (422) — never a silent pass. */
function assertRejected(fn: () => void, message = 'the guard must reject the invalid input'): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof Error, 'the guard throws an Error');
    assert.equal((error as { code?: string }).code, 'INVALID_REQUEST', message);
    return true;
  }, message);
}

// ---------------------------------------------------------------------------
// AI-AC-01 — the provider-neutral contract surface
// ---------------------------------------------------------------------------

test('TASK_PROFILE_CONTRACT_FIELDS is EXACTLY the implementation-contract §10 field list (AI-AC-01)', () => {
  assert.deepEqual([...TASK_PROFILE_CONTRACT_FIELDS].sort(), [
    'contextRequirements',
    'escalationPolicy',
    'evaluatorIds',
    'latencyTargetMs',
    'maxCostPerInvocation',
    'outputSchema',
    'privacyClass',
    'qualityTarget',
    'riskClass',
    'taskClass',
    'toolRequirements',
  ]);
  // The neutral surface carries NO provider/model/credential field.
  for (const neutral of ['provider', 'model', 'modelId', 'credential', 'apiKey', 'sdk']) {
    assert.ok(
      !TASK_PROFILE_CONTRACT_FIELDS.includes(neutral as never),
      `the TaskProfile contract must not carry '${neutral}'`,
    );
  }
});

test('a valid §10 TaskProfile passes the guard untouched (AI-AC-01)', () => {
  const profile = validProfile();
  assertValidTaskProfileInput(profile);
});

test('the TaskProfile guard rejects every provider/model-shaped key — domain requests can never carry a provider or model selection (AI-AC-01)', () => {
  for (const forbidden of ['provider', 'providerName', 'providerLabel', 'model', 'modelName', 'modelId', 'modelKey', 'modelRegistryId', 'candidateModels', 'routingStrategy']) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), [forbidden]: 'openai' } as unknown as TaskProfileInput),
      `a TaskProfile carrying '${forbidden}' must be rejected`,
    );
    assert.ok(
      TASK_PROFILE_FORBIDDEN_INPUT_KEYS.includes(forbidden as never),
      `'${forbidden}' is declared in the forbidden-key contract`,
    );
  }
});

test('the TaskProfile guard rejects credential-shaped keys — no credentials inside a TaskProfile (AI-AC-01)', () => {
  for (const forbidden of ['credential', 'credentialId', 'secretHandle', 'secret', 'apiKey', 'token', 'password']) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), [forbidden]: 'x' } as unknown as TaskProfileInput),
      `a TaskProfile carrying '${forbidden}' must be rejected`,
    );
  }
});

test('the TaskProfile guard rejects server-derived authority fields (identity, scope, lifecycle, provenance)', () => {
  for (const forbidden of ['taskProfileId', 'workspaceId', 'clientId', 'agencyId', 'status', 'version', 'createFingerprint', 'createdBy', 'createdAt', 'updatedAt']) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), [forbidden]: 'x' } as unknown as TaskProfileInput),
      `a TaskProfile carrying the authority field '${forbidden}' must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// TaskProfile field validation
// ---------------------------------------------------------------------------

test('taskClass must be a normalized label — provider-shaped task classes are rejected by shape (AI-AC-01)', () => {
  for (const bad of ['', 'X', 'x', 'Generate Campaign Copy', 'copywriting generate', 'a'.repeat(101)]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), taskClass: bad }),
      `taskClass '${bad}' must be rejected`,
    );
  }
  // Dots are the established task-kind vocabulary (the pooled runtime uses
  // 'data.transform' style labels) — valid here too.
  assertValidTaskProfileInput({ ...validProfile(), taskClass: 'a.b' });
});

test('qualityTarget and riskClass validate against their contracts', () => {
  assertRejected(() => assertValidTaskProfileInput({ ...validProfile(), qualityTarget: '' }));
  assertRejected(() => assertValidTaskProfileInput({ ...validProfile(), qualityTarget: 'x'.repeat(101) }));
  for (const bad of ['none', 'extreme', '', 'MEDIUM'] as unknown as TaskProfileInput['riskClass'][]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), riskClass: bad }),
      `riskClass '${String(bad)}' must be rejected`,
    );
  }
  assert.deepEqual([...TASK_PROFILE_RISK_CLASSES], ['low', 'medium', 'high']);
});

test('privacyClass validates against the closed vocabulary', () => {
  for (const bad of ['public ', 'secret', 'PII', ''] as unknown as TaskProfileInput['privacyClass'][]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), privacyClass: bad }),
      `privacyClass '${String(bad)}' must be rejected`,
    );
  }
  assert.deepEqual([...TASK_PROFILE_PRIVACY_CLASSES], ['public', 'internal', 'confidential', 'restricted']);
});

test('contextRequirements, outputSchema and escalationPolicy must be bounded JSON objects', () => {
  for (const bad of [null, 'text', [], 42]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), contextRequirements: bad } as unknown as TaskProfileInput),
      'contextRequirements must be an object',
    );
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), outputSchema: bad } as unknown as TaskProfileInput),
      'outputSchema must be an object',
    );
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), escalationPolicy: bad } as unknown as TaskProfileInput),
      'escalationPolicy must be an object',
    );
  }
  const oversized = { blob: 'x'.repeat(40_000) };
  assertRejected(() => assertValidTaskProfileInput({ ...validProfile(), outputSchema: oversized }));
});

test('latency and cost budgets enforce their bounds', () => {
  for (const bad of [0, -1, 1.5, 86_400_001]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), latencyTargetMs: bad }),
      `latencyTargetMs ${bad} must be rejected`,
    );
  }
  for (const bad of [-0.01, Number.POSITIVE_INFINITY, 1_000_000_001]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), maxCostPerInvocation: bad }),
      `maxCostPerInvocation ${bad} must be rejected`,
    );
  }
  // 0 cost (a free/deterministic-first cascade stage) is legitimate.
  assertValidTaskProfileInput({ ...validProfile(), maxCostPerInvocation: 0 });
});

test('toolRequirements and evaluatorIds validate as normalized label arrays', () => {
  for (const bad of ['Mixed-Case', 'x', 'a b', ''] as unknown as string[]) {
    assertRejected(
      () => assertValidTaskProfileInput({ ...validProfile(), toolRequirements: [bad] }),
      `toolRequirements label '${String(bad)}' must be rejected`,
    );
  }
  assertRejected(
    () => assertValidTaskProfileInput({ ...validProfile(), evaluatorIds: ['bad label'] }),
    'evaluatorIds labels must be normalized',
  );
  // An empty requirement list is a legitimate neutral contract (no tools).
  assertValidTaskProfileInput({ ...validProfile(), toolRequirements: [] });
  assertValidTaskProfileInput({ ...validProfile(), evaluatorIds: [] });
});

// ---------------------------------------------------------------------------
// Registry lifecycles (frozen)
// ---------------------------------------------------------------------------

test('TASK_PROFILE_TRANSITIONS is the frozen registry lifecycle: active → retired, retired terminal', () => {
  assert.deepEqual([...Object.keys(TASK_PROFILE_TRANSITIONS)].sort(), ['active', 'retired']);
  assert.deepEqual([...TASK_PROFILE_TRANSITIONS.active], ['retired']);
  assert.deepEqual([...TASK_PROFILE_TRANSITIONS.retired], []);
  assert.equal(isLegalTaskProfileTransition('active', 'retired'), true);
  assert.equal(isLegalTaskProfileTransition('retired', 'active'), false);
  assert.equal(isLegalTaskProfileTransition('active', 'active'), false);
});

test('MODEL_REGISTRY_TRANSITIONS is the same frozen lifecycle', () => {
  assert.deepEqual([...Object.keys(MODEL_REGISTRY_TRANSITIONS)].sort(), ['active', 'retired']);
  assert.deepEqual([...MODEL_REGISTRY_TRANSITIONS.active], ['retired']);
  assert.deepEqual([...MODEL_REGISTRY_TRANSITIONS.retired], []);
  assert.equal(isLegalModelRegistryTransition('active', 'retired'), true);
  assert.equal(isLegalModelRegistryTransition('retired', 'active'), false);
});

// ---------------------------------------------------------------------------
// AI-AC-02 (module-level proof half) — the model registry record is DATA
// ---------------------------------------------------------------------------

test('a valid normalized model registration passes the guard untouched (AI-AC-02)', () => {
  assertValidModelRegistrationInput(validModel());
});

test('the model-registration guard rejects SDK/adapter/credential-shaped keys — a registry record is labels, never an SDK import (AI-AC-02)', () => {
  for (const forbidden of ['sdk', 'sdkPackage', 'clientLibrary', 'adapter', 'adapterConfig', 'credential', 'credentialId', 'secretHandle', 'apiKey', 'token', 'password']) {
    assertRejected(
      () => assertValidModelRegistrationInput({ ...validModel(), [forbidden]: 'openai' } as unknown as ModelRegistrationInput),
      `a model registration carrying '${forbidden}' must be rejected`,
    );
  }
});

test('providerLabel and modelKey validate as normalized DATA labels (AI-AC-02)', () => {
  for (const bad of ['OpenAI', 'open ai', 'x', '', 'a'.repeat(65)]) {
    assertRejected(
      () => assertValidModelRegistrationInput({ ...validModel(), providerLabel: bad }),
      `providerLabel '${bad}' must be rejected`,
    );
  }
  for (const bad of ['', 'X', 'Mixed Case', 'a'.repeat(129)]) {
    assertRejected(
      () => assertValidModelRegistrationInput({ ...validModel(), modelKey: bad }),
      `modelKey '${bad}' must be rejected`,
    );
  }
  // Model keys may carry vendor-style punctuation as DATA labels.
  assertValidModelRegistrationInput({ ...validModel(), modelKey: 'example-4o-mini:2024-10-01' });
});

test('model signals enforce their bounds (unknown signals are null, never fabricated)', () => {
  assertValidModelRegistrationInput({ ...validModel(), costInputPerMtok: null, latencyP50Ms: null, reliability: null });
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), costInputPerMtok: -1 }));
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), reliability: 1.01 }));
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), reliability: -0.01 }));
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), contextLimitTokens: 0 }));
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), capabilities: ['Bad Label'] }));
  assertRejected(() => assertValidModelRegistrationInput({ ...validModel(), qualitySignals: 'x' as never }));
});

test('the observation guard validates the closed availability vocabulary and signal bounds', () => {
  assertValidModelObservationInput({
    availabilityState: 'degraded',
    observedLatencyP50Ms: 500,
    observedLatencyP95Ms: null,
    source: 'platform-probe',
    notes: 'elevated error rate',
  });
  for (const bad of ['up', 'down', ''] as unknown as ('available' | 'degraded' | 'unavailable')[]) {
    assertRejected(
      () => assertValidModelObservationInput({ availabilityState: bad, observedLatencyP50Ms: null, observedLatencyP95Ms: null, source: 'platform-probe', notes: '' }),
      `availabilityState '${String(bad)}' must be rejected`,
    );
  }
  assert.deepEqual([...MODEL_AVAILABILITY_STATES], ['available', 'degraded', 'unavailable']);
  assertRejected(() =>
    assertValidModelObservationInput({ availabilityState: 'available', observedLatencyP50Ms: -1, observedLatencyP95Ms: null, source: 'platform-probe', notes: '' }),
  );
  assertRejected(() =>
    assertValidModelObservationInput({ availabilityState: 'available', observedLatencyP50Ms: null, observedLatencyP95Ms: null, source: 'Bad Source', notes: '' }),
  );
  assertRejected(() =>
    assertValidModelObservationInput({ availabilityState: 'available', observedLatencyP50Ms: null, observedLatencyP95Ms: null, source: 'platform-probe', notes: 'x'.repeat(513) }),
  );
});

// ---------------------------------------------------------------------------
// Usage telemetry input guard
// ---------------------------------------------------------------------------

test('a valid usage-telemetry input passes the guard untouched', () => {
  assertValidUsageTelemetryInput(validUsage());
  assertValidUsageTelemetryInput({ ...validUsage(), executionId: null, tokensIn: null, tokensOut: null, evaluationRef: null, escalationCount: 3 });
});

test('the telemetry guard rejects provider/model authority keys — the model ref is the registry entry id only', () => {
  for (const forbidden of ['provider', 'providerLabel', 'model', 'modelName', 'modelKey', 'routingStrategy']) {
    assertRejected(
      () => assertValidUsageTelemetryInput({ ...validUsage(), [forbidden]: 'openai' } as unknown as UsageTelemetryInput),
      `usage telemetry carrying '${forbidden}' must be rejected`,
    );
    assert.ok(
      USAGE_TELEMETRY_FORBIDDEN_INPUT_KEYS.includes(forbidden as never),
      `'${forbidden}' is declared in the forbidden-key contract`,
    );
  }
});

test('the telemetry guard rejects the server-derived authority fields (identity, scope, correlation, provenance)', () => {
  for (const forbidden of ['usageId', 'workspaceId', 'clientId', 'agencyId', 'correlationId', 'causationId', 'createFingerprint', 'createdBy', 'createdAt']) {
    assertRejected(
      () => assertValidUsageTelemetryInput({ ...validUsage(), [forbidden]: 'x' } as unknown as UsageTelemetryInput),
      `usage telemetry carrying the authority field '${forbidden}' must be rejected`,
    );
  }
});

test('the telemetry guard rejects credential-shaped keys', () => {
  for (const forbidden of ['credential', 'credentialId', 'secretHandle', 'secret', 'apiKey', 'token', 'password']) {
    assertRejected(
      () => assertValidUsageTelemetryInput({ ...validUsage(), [forbidden]: 'x' } as unknown as UsageTelemetryInput),
      `usage telemetry carrying '${forbidden}' must be rejected`,
    );
  }
});

test('telemetry references must be server-shaped identifiers and the outcome must be the closed vocabulary', () => {
  for (const bad of ['not-a-uuid', '', '12345']) {
    assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), taskProfileId: bad }), `taskProfileId '${bad}' must be rejected`);
    assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), modelRegistryId: bad }), `modelRegistryId '${bad}' must be rejected`);
    assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), executionId: bad }), `executionId '${bad}' must be rejected`);
  }
  for (const bad of ['ok', 'success', 'SUCCEEDED', 'retried'] as unknown as UsageTelemetryInput['outcome'][]) {
    assertRejected(
      () => assertValidUsageTelemetryInput({ ...validUsage(), outcome: bad }),
      `outcome '${String(bad)}' must be rejected`,
    );
  }
  assert.deepEqual([...USAGE_TELEMETRY_OUTCOMES], ['succeeded', 'failed', 'escalated', 'unknown']);
});

test('telemetry observed signals enforce their bounds', () => {
  for (const bad of [-1, 1.5]) {
    assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), latencyMs: bad }));
    assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), escalationCount: bad }));
  }
  assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), costAmount: -0.001 }));
  assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), tokensIn: -1 }));
  assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), evaluationRef: '' }));
  // Unknown-token semantics: outcome 'unknown' is a first-class record —
  // never success, but recordable.
  assertValidUsageTelemetryInput({ ...validUsage(), outcome: 'unknown', tokensIn: null, tokensOut: null });
});

test('the §8-style idempotency key enforces its bounds', () => {
  assertValidIdempotencyKey('k');
  assertValidIdempotencyKey('a'.repeat(200));
  assertRejected(() => assertValidIdempotencyKey(''));
  assertRejected(() => assertValidIdempotencyKey('a'.repeat(201)));
  assertRejected(() => assertValidUsageTelemetryInput({ ...validUsage(), idempotencyKey: '' }));
});
