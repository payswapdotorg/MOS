/**
 * MKT-020 unit tests — the provider-neutral logical Agent/Capability
 * contracts: the declaration input guards, the capability descriptor
 * validation (including the deep nested forbidden-key walk over
 * descriptor parameters), the §8-style idempotency-key bounds and the
 * frozen registry lifecycle (pure functions, no DB).
 *
 * Acceptance mapping (work-item-matrix.md MKT-020 = AGENT-001 /
 * "provider-neutral capability tests"; spec/requirements.md AGENT-001;
 * spec/architecture.md §12 "Agent is a logical reusable capability. It
 * does not own tenant data, workflow state, deployment state or
 * infrastructure"):
 *   - provider neutrality (unit half): the declaration contract surface
 *     is EXACTLY the MKT-020 field list, and the input guards REJECT
 *     provider/model/SDK/credential-shaped keys AND
 *     infrastructure-coupling keys (sandbox/pool/queue/runtime/
 *     deployment) AND tenant/workflow/execution references — at the top
 *     level, on every capability descriptor AND at every nesting level
 *     of the descriptor parameters;
 *   - authority-field rejection: server-derived identity/scope/lifecycle/
 *     provenance fields can never be caller-supplied;
 *   - registry invariants: the closed agent-key/version-label/
 *     capability-kind label shapes, descriptor bounds, the at-least-one
 *     capability rule and the §8-style idempotency-key bounds;
 *   - the frozen registry lifecycle: active → retired single edge,
 *     retired terminal — no second retirement.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS,
  assertValidIdempotencyKey,
  assertValidLogicalAgentRegistrationInput,
  assertValidLogicalAgentRetireReason,
  containsForbiddenCapabilityKey,
  isLegalLogicalAgentTransition,
  LOGICAL_AGENT_CONTRACT_FIELDS,
  LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS,
  LOGICAL_AGENT_TRANSITIONS,
  type AgentCapabilityDescriptor,
  type LogicalAgentRegistrationInput,
} from '../../src/modules/agents/public.ts';

/** A fully valid provider-neutral capability descriptor. */
function validDescriptor(): AgentCapabilityDescriptor {
  return {
    capabilityKind: 'text-generation',
    parameters: {
      maxOutputTokens: 2048,
      outputFormat: 'markdown',
      languages: ['en', 'fr'],
    },
  };
}

/** A fully valid logical-agent registration input. */
function validRegistration(): LogicalAgentRegistrationInput {
  return {
    agentKey: 'copy-writer',
    displayName: 'Copy Writer',
    versionLabel: '1.0.0',
    description:
      'Declares reusable copywriting capabilities: brand-voice text generation with review escalation.',
    capabilities: [
      validDescriptor(),
      {
        capabilityKind: 'human-review',
        parameters: { reviewStage: 'final', sla: { maxHours: 24 } },
      },
    ],
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
// The provider-neutral contract surface
// ---------------------------------------------------------------------------

test('LOGICAL_AGENT_CONTRACT_FIELDS is EXACTLY the MKT-020 declaration field list', () => {
  assert.deepEqual([...LOGICAL_AGENT_CONTRACT_FIELDS].sort(), [
    'agentKey',
    'capabilities',
    'description',
    'displayName',
    'versionLabel',
  ]);
  // The neutral surface carries NO provider/model/credential/SDK field
  // and NO infrastructure/tenant/execution field.
  for (const forbidden of [
    'provider',
    'providerLabel',
    'model',
    'modelId',
    'sdk',
    'adapter',
    'credential',
    'apiKey',
    'sandboxId',
    'poolId',
    'queueId',
    'runtimeClass',
    'deploymentId',
    'executionId',
    'workflowId',
    'clientId',
    'workspaceId',
    'goalId',
  ]) {
    assert.ok(
      !(LOGICAL_AGENT_CONTRACT_FIELDS as readonly string[]).includes(forbidden),
      `the logical Agent contract surface must not carry '${forbidden}'`,
    );
  }
});

test('the registration forbidden-key contract rejects provider, credential, infrastructure, workflow/execution and tenant keys (AGENT-001)', () => {
  const contract = LOGICAL_AGENT_REGISTRATION_FORBIDDEN_INPUT_KEYS as readonly string[];
  // Provider/model authority.
  for (const key of ['provider', 'providerLabel', 'model', 'modelId', 'modelKey', 'modelRegistryId']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as a caller-supplied field`);
  }
  // SDK/adapter-shaped keys.
  for (const key of ['sdk', 'sdkPackage', 'clientLibrary', 'adapter', 'adapterConfig']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as a caller-supplied field`);
  }
  // Credential-shaped keys.
  for (const key of ['credential', 'secret', 'secretHandle', 'apiKey', 'token', 'password']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as a caller-supplied field`);
  }
  // Infrastructure coupling (the logical Agent owns NO infrastructure).
  for (const key of ['sandbox', 'sandboxId', 'pool', 'workerPool', 'queue', 'queueId', 'runtime', 'runtimeClass', 'deployment', 'deploymentId', 'endpoint', 'url', 'baseUrl']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as infrastructure coupling`);
  }
  // Workflow/execution state (owned by /workflows and /executions).
  for (const key of ['executionId', 'workflowId', 'workflowState', 'taskId']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as workflow/execution state`);
  }
  // Tenant data (the logical Agent owns NO tenant data, §12).
  for (const key of ['clientId', 'workspaceId', 'goalId']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as tenant data`);
  }
  // Server-derived authority fields.
  for (const key of ['agentId', 'scopeKind', 'agencyId', 'status', 'version', 'createFingerprint', 'createdBy', 'createdAt', 'updatedAt']) {
    assert.ok(contract.includes(key), `'${key}' is rejected as a server-derived authority field`);
  }
});

test('the descriptor forbidden-key contract rejects provider, credential, infrastructure and tenant keys', () => {
  const contract = AGENT_CAPABILITY_DESCRIPTOR_FORBIDDEN_INPUT_KEYS as readonly string[];
  for (const key of ['provider', 'model', 'sdk', 'adapter', 'apiKey', 'sandboxId', 'queueId', 'runtimeClass', 'executionId', 'clientId', 'workspaceId']) {
    assert.ok(contract.includes(key), `'${key}' is rejected inside a capability descriptor`);
  }
});

// ---------------------------------------------------------------------------
// The registration input guard
// ---------------------------------------------------------------------------

test('the guard accepts a fully valid provider-neutral registration', () => {
  assert.doesNotThrow(() => assertValidLogicalAgentRegistrationInput(validRegistration()));
});

test('the guard rejects every forbidden authority/neutrality key at the top level', () => {
  for (const key of [
    'agentId',
    'scopeKind',
    'agencyId',
    'status',
    'version',
    'createdBy',
    'provider',
    'model',
    'modelId',
    'sdk',
    'adapter',
    'credential',
    'apiKey',
    'token',
    'sandboxId',
    'queueId',
    'runtimeClass',
    'deploymentId',
    'endpoint',
    'executionId',
    'workflowId',
    'clientId',
    'workspaceId',
    'goalId',
  ]) {
    const payload = {
      ...validRegistration(),
      [key]: 'caller-supplied-value',
    } as unknown as LogicalAgentRegistrationInput;
    assertRejected(
      () => assertValidLogicalAgentRegistrationInput(payload),
      `the guard must reject the caller-supplied '${key}'`,
    );
  }
});

test('the guard rejects malformed identity labels (agentKey, versionLabel, displayName, description)', () => {
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), agentKey: 'X' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), agentKey: 'Upper Case' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), agentKey: '' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), versionLabel: '' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), versionLabel: 'v 1' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), displayName: '' }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), description: '' }),
  );
});

test('the guard requires at least one declared capability and bounds the count', () => {
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), capabilities: [] }),
  );
  const tooMany = Array.from({ length: 65 }, () => validDescriptor());
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({ ...validRegistration(), capabilities: tooMany }),
  );
});

test('the guard rejects descriptors that are not exactly { capabilityKind, parameters }', () => {
  // Extra key (provider-shaped and neutral-shaped alike): the descriptor
  // is EXACTLY the two declared keys.
  for (const extra of ['provider', 'modelRegistryId', 'notes', 'id']) {
    const descriptor = { ...validDescriptor(), [extra]: 'x' } as unknown as AgentCapabilityDescriptor;
    assertRejected(() =>
      assertValidLogicalAgentRegistrationInput({
        ...validRegistration(),
        capabilities: [descriptor],
      }),
      `the guard must reject a descriptor carrying the extra key '${extra}'`,
    );
  }
  // Missing key.
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [{ capabilityKind: 'text-generation' } as unknown as AgentCapabilityDescriptor],
    }),
  );
  // Bad kind label.
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [{ ...validDescriptor(), capabilityKind: 'Text Generation' }],
    }),
  );
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [{ ...validDescriptor(), capabilityKind: 'x' }],
    }),
  );
  // Parameters not an object.
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [{ ...validDescriptor(), parameters: ['not-an-object'] as unknown as Record<string, unknown> }],
    }),
  );
});

test('the guard rejects provider/credential/infrastructure keys at EVERY nesting level of descriptor parameters', () => {
  // Top level of parameters.
  for (const key of ['provider', 'model', 'apiKey', 'secret', 'sandboxId', 'queueId', 'runtimeClass', 'executionId', 'clientId', 'workspaceId']) {
    const descriptor = {
      ...validDescriptor(),
      parameters: { [key]: 'x' },
    };
    assertRejected(
      () =>
        assertValidLogicalAgentRegistrationInput({
          ...validRegistration(),
          capabilities: [descriptor],
        }),
      `the guard must reject the forbidden parameter key '${key}'`,
    );
  }
  // Nested one level down.
  for (const key of ['provider', 'apiKey', 'sandboxId', 'deploymentId']) {
    const descriptor = {
      ...validDescriptor(),
      parameters: { nested: { [key]: 'x' } },
    };
    assertRejected(
      () =>
        assertValidLogicalAgentRegistrationInput({
          ...validRegistration(),
          capabilities: [descriptor],
        }),
      `the guard must reject the nested forbidden parameter key '${key}'`,
    );
  }
  // Inside an array element.
  const arrayDescriptor = {
    ...validDescriptor(),
    parameters: { fallbacks: [{ model: 'provider-model-x', reason: 'cheap' }] },
  };
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [arrayDescriptor],
    }),
  );
  // Deep inside a nested object.
  const deepDescriptor = {
    ...validDescriptor(),
    parameters: { policy: { escalation: { secretHandle: 'smuggled' } } },
  };
  assertRejected(() =>
    assertValidLogicalAgentRegistrationInput({
      ...validRegistration(),
      capabilities: [deepDescriptor],
    }),
  );
});

test('containsForbiddenCapabilityKey walks nested arrays/objects and passes legitimate parameter contracts', () => {
  // Legitimate neutral parameter content passes.
  assert.equal(containsForbiddenCapabilityKey(validDescriptor().parameters), false);
  assert.equal(
    containsForbiddenCapabilityKey({ nested: { deep: [{ list: [1, 'two', true, null] }] } }),
    false,
  );
  // Case-insensitive exact-match authority shapes are caught.
  assert.equal(containsForbiddenCapabilityKey({ APIKEY: 'x' }), true);
  assert.equal(containsForbiddenCapabilityKey({ nested: { SandboxId: 'x' } }), true);
  // Compound legitimate keys are NOT collaterally rejected.
  assert.equal(containsForbiddenCapabilityKey({ maxTokens: 100, providerPolicyName: 'neutral' }), false);
  // The deep-walk depth cap fails closed.
  let deep: unknown = { value: 1 };
  for (let i = 0; i < 20; i++) deep = { nested: deep };
  assert.equal(containsForbiddenCapabilityKey(deep), true);
});

// ---------------------------------------------------------------------------
// Idempotency + retire-reason bounds
// ---------------------------------------------------------------------------

test('the §8-style idempotency key and retire reason bounds are enforced', () => {
  assert.doesNotThrow(() => assertValidIdempotencyKey('register-1'));
  assertRejected(() => assertValidIdempotencyKey(''));
  assertRejected(() => assertValidIdempotencyKey('x'.repeat(201)));
  assert.doesNotThrow(() => assertValidLogicalAgentRetireReason('superseded by v2'));
  assert.doesNotThrow(() => assertValidLogicalAgentRetireReason(''));
  assertRejected(() => assertValidLogicalAgentRetireReason('x'.repeat(513)));
});

// ---------------------------------------------------------------------------
// The frozen registry lifecycle
// ---------------------------------------------------------------------------

test('the lifecycle is the single edge active → retired with retired TERMINAL (no second retirement)', () => {
  assert.deepEqual(LOGICAL_AGENT_TRANSITIONS, {
    active: ['retired'],
    retired: [],
  });
  assert.equal(isLegalLogicalAgentTransition('active', 'retired'), true);
  assert.equal(isLegalLogicalAgentTransition('active', 'active'), false);
  assert.equal(isLegalLogicalAgentTransition('retired', 'active'), false);
  assert.equal(isLegalLogicalAgentTransition('retired', 'retired'), false);
});
