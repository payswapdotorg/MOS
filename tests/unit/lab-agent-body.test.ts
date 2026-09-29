/**
 * LAB-011 unit tests — the PURE contract guards + deterministic helpers
 * of /lab-agent-body: the FULL §14 body-contract discipline (every
 * field fence + closed vocabulary + uniqueness bound), the
 * message-schema subset validator (the deterministic input/output
 * contract enforcement), the reserved control-channel fence and
 * stripper, the run-input fences (the model identity as DATA), the
 * opaque body-version reference format, and the frozen vocabulary
 * constants (the closed sets the migration CHECK-fences).
 *
 * The dispatch's named acceptance proofs (spec/effective-backlog-v1.7.md
 * LAB-011: "model-agnostic Agent Body execution with tools, memory,
 * permissions, budgets and evaluation hooks... no second model
 * router"):
 *   (a) the FULL §14 field set is declared, bounded, closed-vocabulary
 *       data (assertValidLabAgentBodyContract);
 *   (b) the model-agnostic run surface — the model identity arrives as
 *       DATA (a uuid-shaped /ai-runtime registry id) with NO selection
 *       vocabulary anywhere near it (assertValidRunLabAgentInstanceInput
 *       + the structural no-router proof of the boundary suite);
 *   (c) tools/permissions — the tool + permission declarations are
 *       closed-vocabulary fenced;
 *   (d) budgets — every cap is bounded and non-negative;
 *   (e) evaluation hooks — the declarations are bounded + the outcome
 *       slot vocabulary is the honest 'pending' singleton;
 *   (f) memory interfaces — declared kind + capacity fences;
 *   (g) safety/policy constraints — the §21 hard-rejection subset is
 *       MANDATORY and the unsafe action verbs are structurally absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_AGENT_BODY_ACTION_KINDS,
  LAB_AGENT_BODY_ACTION_VERBS,
  LAB_AGENT_BODY_CONTRACT_VERSION,
  LAB_AGENT_BODY_EVENT_KINDS,
  LAB_AGENT_BODY_HOOK_OUTCOMES,
  LAB_AGENT_BODY_MEMORY_KINDS,
  LAB_AGENT_BODY_MEMORY_WRITES_KEY,
  LAB_AGENT_BODY_MESSAGE_FIELD_TYPES,
  LAB_AGENT_BODY_REFERENCE_PATTERN,
  LAB_AGENT_BODY_RUN_FAILURE_REASONS,
  LAB_AGENT_BODY_RUN_STATUSES,
  LAB_AGENT_BODY_SAFETY_CONSTRAINTS,
  LAB_AGENT_BODY_STATUSES,
  LAB_AGENT_BODY_TOOL_CALLS_KEY,
  LAB_AGENT_BODY_TOOL_REFUSAL_REASONS,
  LAB_AGENT_BODY_MEMORY_REFUSAL_REASONS,
  assertValidLabAgentBodyContract,
  assertValidLabAgentMessageSchema,
  assertValidRunLabAgentInstanceInput,
  formatLabAgentBodyVersionReference,
  parseLabAgentBodyVersionReference,
  stripRuntimeControlChannels,
  validateLabAgentMessageAgainstContract,
  type LabAgentBodyContract,
  type LabAgentMessageContractSchema,
  type RunLabAgentInstanceInput,
} from '../../src/modules/lab-agent-body/public.ts';
import { InvalidRequestError } from '../../src/platform/errors/errors.ts';

const BODY_ID = '01923f7e-8b1d-7abc-9def-0123456789ab';
const MODEL_ID = '01923f7e-8b1d-7abc-9def-0123456789cd';

function schema(required: string[], fields: Record<string, string>): LabAgentMessageContractSchema {
  return {
    type: 'object',
    required,
    properties: Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { type: type as never }])),
  };
}

function validContract(): LabAgentBodyContract {
  return {
    roleContract: { role: 'generalist-strategist', description: 'The §15 single-agent baseline occupant.' },
    inputContract: schema(['niche'], { niche: 'string', platform: 'string' }),
    outputContract: schema(['summary'], { summary: 'string', confidence: 'number' }),
    tools: [
      { toolId: 'corpus-lookup', actionKind: 'read', description: 'Reads corpus references.' },
      { toolId: 'content-drafter', actionKind: 'compose', description: 'Drafts content.' },
    ],
    permissions: ['read', 'compose'],
    memoryInterfaces: [
      { memoryId: 'strategy-notes', kind: 'body_scoped', capacityEntries: 8 },
      { memoryId: 'run-scratch', kind: 'run_scoped', capacityEntries: 4 },
    ],
    communicationInterface: [
      { channelId: 'org-bus', direction: 'outbound', messageKind: 'strategy-proposal' },
      { channelId: 'operator-requests', direction: 'inbound', messageKind: 'task-brief' },
    ],
    actionInterface: ['draft_content', 'cite_evidence', 'analyze_audience'],
    capabilities: ['capability:niche-research@v1', 'capability:copy-polish@v2'],
    budget: { maxModelInvocations: 3, maxToolInvocations: 10, maxTokensIn: 100_000, maxTokensOut: 50_000, maxCostUnits: 2.5 },
    latencyLimits: { deadlineMs: 60_000 },
    evaluationHooks: [{ hookId: 'reward-hook' }, { hookId: 'safety-hook' }],
    safetyConstraints: ['no_fake_engagement', 'no_deceptive_attribution'],
  };
}

function validRunInput(): RunLabAgentInstanceInput {
  return {
    scope: { agencyId: '00000000-0000-0000-0000-000000000001', clientId: '00000000-0000-0000-0000-000000000002' },
    bodyVersionReference: formatLabAgentBodyVersionReference(BODY_ID, 1),
    modelRegistryId: MODEL_ID,
    inputMessage: { niche: 'home fitness', platform: 'youtube' },
    backend: { providerLabel: 'acme-labs', invokeModel: async () => ({ ok: true, output: {}, error: null, latencyMs: 1, costUnits: 0, tokensIn: 1, tokensOut: 1 }) },
    toolExecutor: { executeTool: async () => ({ ok: true, result: {}, error: null }) },
    addressedChannel: null,
  };
}

function assertInvalid(fn: () => void, fragment: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError containing '${fragment}'`);
  assert.ok(
    String((caught as InvalidRequestError).message).includes(fragment),
    `message "${String((caught as InvalidRequestError).message)}" should contain '${fragment}'`,
  );
}

// ---------------------------------------------------------------------------
// (h) The frozen vocabularies + the structural safety fences.
// ---------------------------------------------------------------------------

test('LAB-011: the frozen agent-body vocabularies are the closed sets (lifecycle, action kinds, memory kinds, run states, failures, events)', () => {
  assert.equal(LAB_AGENT_BODY_CONTRACT_VERSION, 'lab-agent-body-contract-v1');
  assert.deepEqual(LAB_AGENT_BODY_STATUSES, ['draft', 'active', 'retired']);
  assert.deepEqual(LAB_AGENT_BODY_ACTION_KINDS, ['read', 'analyze', 'compose', 'transform', 'communicate', 'simulate']);
  assert.deepEqual(LAB_AGENT_BODY_MEMORY_KINDS, ['run_scoped', 'body_scoped']);
  assert.deepEqual(LAB_AGENT_BODY_RUN_STATUSES, ['running', 'succeeded', 'failed']);
  assert.deepEqual(LAB_AGENT_BODY_EVENT_KINDS, [
    'run_started', 'model_invocation', 'tool_invocation', 'tool_refusal',
    'memory_write', 'memory_refused', 'evaluation_hook', 'run_completed', 'run_failed',
  ]);
  assert.deepEqual(LAB_AGENT_BODY_RUN_FAILURE_REASONS, [
    'input_contract_violation', 'model_unavailable', 'model_invocation_failed',
    'permission_refused', 'tool_error', 'budget_exceeded', 'latency_exceeded',
    'output_contract_violation',
  ]);
  assert.deepEqual(LAB_AGENT_BODY_TOOL_REFUSAL_REASONS, ['undeclared_tool', 'action_not_permitted']);
  assert.deepEqual(LAB_AGENT_BODY_MEMORY_REFUSAL_REASONS, ['memory_not_declared', 'memory_capacity_exceeded']);
  assert.deepEqual(LAB_AGENT_BODY_HOOK_OUTCOMES, ['pending']);
  assert.deepEqual(LAB_AGENT_BODY_MESSAGE_FIELD_TYPES, ['string', 'number', 'integer', 'boolean', 'object', 'array']);
});

test('LAB-011: the §21 safety-constraint vocabulary is the hard-rejection set and the unsafe action verbs are STRUCTURALLY ABSENT', () => {
  assert.deepEqual(LAB_AGENT_BODY_SAFETY_CONSTRAINTS, [
    'no_fake_engagement', 'no_impersonation', 'no_rights_circumvention',
    'no_anti_abuse_evasion', 'no_deceptive_attribution',
  ]);
  // The /platform-health structural-absence pattern: the forbidden
  // publication/engagement verbs can never be declared or emitted.
  for (const unsafe of ['publish_directly', 'engage_inauthentically', 'impersonate', 'bypass_platform_restriction', 'fabricate_testimonial']) {
    assert.ok(!(LAB_AGENT_BODY_ACTION_VERBS as readonly string[]).includes(unsafe), `the unsafe verb '${unsafe}' is structurally absent`);
    assert.ok(!(LAB_AGENT_BODY_ACTION_KINDS as readonly string[]).includes(unsafe), `the unsafe action kind '${unsafe}' is structurally absent`);
  }
  assert.deepEqual(LAB_AGENT_BODY_ACTION_VERBS, [
    'draft_content', 'request_review', 'cite_evidence', 'analyze_audience',
    'plan_calendar', 'simulate_distribution', 'request_approval', 'send_internal_message',
  ]);
});

// ---------------------------------------------------------------------------
// (a) The FULL §14 body-contract discipline.
// ---------------------------------------------------------------------------

test('LAB-011: a valid FULL §14 body contract passes (the complete declared field set)', () => {
  assertValidLabAgentBodyContract(validContract());
});

test('LAB-011: the mandatory fences — empty permissions, empty safety constraints and duplicate declarations are rejected', () => {
  const noPermissions = validContract();
  (noPermissions as unknown as { permissions: string[] }).permissions = [];
  assertInvalid(() => assertValidLabAgentBodyContract(noPermissions), 'permissions');

  const noSafety = validContract();
  (noSafety as unknown as { safetyConstraints: string[] }).safetyConstraints = [];
  assertInvalid(() => assertValidLabAgentBodyContract(noSafety), 'safetyConstraints');

  const duplicateTool = validContract();
  (duplicateTool as unknown as { tools: Array<{ toolId: string }> }).tools[1]!.toolId = 'corpus-lookup';
  assertInvalid(() => assertValidLabAgentBodyContract(duplicateTool), 'duplicated');

  const duplicateMemory = validContract();
  (duplicateMemory as unknown as { memoryInterfaces: Array<{ memoryId: string }> }).memoryInterfaces[1]!.memoryId = 'strategy-notes';
  assertInvalid(() => assertValidLabAgentBodyContract(duplicateMemory), 'duplicated');

  const duplicateHook = validContract();
  (duplicateHook as unknown as { evaluationHooks: Array<{ hookId: string }> }).evaluationHooks[1]!.hookId = 'reward-hook';
  assertInvalid(() => assertValidLabAgentBodyContract(duplicateHook), 'duplicated');
});

test('LAB-011: closed-vocabulary violations — unknown action kinds, safety labels, memory kinds and action verbs are rejected', () => {
  const badActionKind = validContract();
  (badActionKind as unknown as { tools: Array<{ actionKind: string }> }).tools[0]!.actionKind = 'publish';
  assertInvalid(() => assertValidLabAgentBodyContract(badActionKind), 'actionKind');

  const badSafety = validContract();
  (badSafety as unknown as { safetyConstraints: string[] }).safetyConstraints = ['engage_anyway'];
  assertInvalid(() => assertValidLabAgentBodyContract(badSafety), 'safety-constraint vocabulary');

  const badMemoryKind = validContract();
  (badMemoryKind as unknown as { memoryInterfaces: Array<{ kind: string }> }).memoryInterfaces[0]!.kind = 'global_shared';
  assertInvalid(() => assertValidLabAgentBodyContract(badMemoryKind), 'kind');

  const badVerb = validContract();
  (badVerb as unknown as { actionInterface: string[] }).actionInterface = ['publish_directly'];
  assertInvalid(() => assertValidLabAgentBodyContract(badVerb), 'safe action-verb vocabulary');
});

test('LAB-011: the budget and latency bounds — zero/negative/oversized caps and deadlines are rejected', () => {
  const zeroInvocations = validContract();
  (zeroInvocations as unknown as { budget: { maxModelInvocations: number } }).budget.maxModelInvocations = 0;
  assertInvalid(() => assertValidLabAgentBodyContract(zeroInvocations), 'maxModelInvocations');

  const negativeCost = validContract();
  (negativeCost as unknown as { budget: { maxCostUnits: number } }).budget.maxCostUnits = -0.01;
  assertInvalid(() => assertValidLabAgentBodyContract(negativeCost), 'maxCostUnits');

  const zeroDeadline = validContract();
  (zeroDeadline as unknown as { latencyLimits: { deadlineMs: number } }).latencyLimits.deadlineMs = 0;
  assertInvalid(() => assertValidLabAgentBodyContract(zeroDeadline), 'deadlineMs');

  const zeroCapacity = validContract();
  (zeroCapacity as unknown as { memoryInterfaces: Array<{ capacityEntries: number }> }).memoryInterfaces[0]!.capacityEntries = 0;
  assertInvalid(() => assertValidLabAgentBodyContract(zeroCapacity), 'capacityEntries');
});

// ---------------------------------------------------------------------------
// (b) The message-schema subset (the deterministic input/output contract).
// ---------------------------------------------------------------------------

test('LAB-011: a valid message-schema subset passes and the reserved control-channel keys are REJECTED as properties (the collision fence)', () => {
  assertValidLabAgentMessageSchema(schema(['a'], { a: 'string' }), 'schema');
  const collision = schema(['a'], { a: 'string' }) as unknown as { properties: Record<string, unknown> };
  collision.properties[LAB_AGENT_BODY_TOOL_CALLS_KEY] = { type: 'array' };
  assertInvalid(() => assertValidLabAgentMessageSchema(collision as never, 'schema'), 'reserved control-channel key');
  const collision2 = schema(['a'], { a: 'string' }) as unknown as { properties: Record<string, unknown> };
  collision2.properties[LAB_AGENT_BODY_MEMORY_WRITES_KEY] = { type: 'array' };
  assertInvalid(() => assertValidLabAgentMessageSchema(collision2 as never, 'schema'), 'reserved control-channel key');
});

test('LAB-011: validateLabAgentMessageAgainstContract — required keys, field types and the key bound are enforced deterministically', () => {
  const contract = schema(['niche'], { niche: 'string', confidence: 'number', tags: 'array' });
  assert.deepEqual(validateLabAgentMessageAgainstContract(contract, { niche: 'fitness' }, 'm'), { ok: true });
  const missing = validateLabAgentMessageAgainstContract(contract, { platform: 'youtube' }, 'm');
  assert.equal(missing.ok, false);
  assert.ok(missing.ok === false && missing.violations.some((v) => v.includes("missing the required key 'niche'")));
  const wrongType = validateLabAgentMessageAgainstContract(contract, { niche: 'fitness', confidence: 'high' }, 'm');
  assert.ok(wrongType.ok === false && wrongType.violations.some((v) => v.includes("['confidence'] must be of type number")));
  const notObject = validateLabAgentMessageAgainstContract(contract, 'nope', 'm');
  assert.equal(notObject.ok, false);
});

test('LAB-011: stripRuntimeControlChannels removes the reserved keys and keeps the output-contract message (the final-output rule)', () => {
  const response = {
    summary: 'the answer',
    [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'corpus-lookup', arguments: {} }],
    [LAB_AGENT_BODY_MEMORY_WRITES_KEY]: [{ memoryId: 'strategy-notes', entryKey: 'k', entryValue: {} }],
  };
  const stripped = stripRuntimeControlChannels(response);
  assert.deepEqual(stripped, { summary: 'the answer' });
});

// ---------------------------------------------------------------------------
// (c) The run-input fences (the model identity as DATA — no selection).
// ---------------------------------------------------------------------------

test('LAB-011: a valid agent-instance run input passes (the model identity arrives as caller DATA)', () => {
  assertValidRunLabAgentInstanceInput(validRunInput());
});

test('LAB-011: the run-input fences — malformed references, non-uuid model identities, control-channel inputs and missing ports are rejected', () => {
  const badRef = validRunInput();
  (badRef as { bodyVersionReference: string }).bodyVersionReference = `${BODY_ID}@1`;
  assertInvalid(() => assertValidRunLabAgentInstanceInput(badRef), 'bodyVersionReference');

  const badModel = validRunInput();
  (badModel as { modelRegistryId: string }).modelRegistryId = 'gpt-best';
  assertInvalid(() => assertValidRunLabAgentInstanceInput(badModel), 'modelRegistryId');

  const controlChannel = validRunInput();
  (controlChannel as { inputMessage: Record<string, unknown> }).inputMessage = {
    niche: 'fitness',
    [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [],
  };
  assertInvalid(() => assertValidRunLabAgentInstanceInput(controlChannel), 'reserved control-channel keys');

  const noBackend = validRunInput();
  (noBackend as { backend: unknown }).backend = null;
  assertInvalid(() => assertValidRunLabAgentInstanceInput(noBackend), 'backend');

  const noExecutor = validRunInput();
  (noExecutor as { toolExecutor: unknown }).toolExecutor = {};
  assertInvalid(() => assertValidRunLabAgentInstanceInput(noExecutor), 'toolExecutor');
});

// ---------------------------------------------------------------------------
// (d) The opaque body-version reference (the /lab citation format).
// ---------------------------------------------------------------------------

test('LAB-011: the opaque body-version reference formats and parses (`<bodyId>#v<version>` — what /lab agentBodyVersions cites)', () => {
  const reference = formatLabAgentBodyVersionReference(BODY_ID, 3);
  assert.equal(reference, `${BODY_ID}#v3`);
  assert.ok(LAB_AGENT_BODY_REFERENCE_PATTERN.test(reference));
  assert.deepEqual(parseLabAgentBodyVersionReference(reference), { bodyId: BODY_ID, bodyVersion: 3 });
  assert.ok(!LAB_AGENT_BODY_REFERENCE_PATTERN.test(`${BODY_ID}#v0`), 'version 0 is not a legal reference');
  assert.ok(!LAB_AGENT_BODY_REFERENCE_PATTERN.test(`${BODY_ID}#v10000`), 'the reference shape is bounded to 4 digits (the 1..1000 chain bound is the module/DB fence)');
  assert.ok(!LAB_AGENT_BODY_REFERENCE_PATTERN.test(`${BODY_ID}#v01`), 'leading zeros are not legal version references');
  assert.ok(!LAB_AGENT_BODY_REFERENCE_PATTERN.test('not-a-reference'));
});

// ---------------------------------------------------------------------------
// (e) The structural no-secret surface (the lab-corpus (g) analogue).
// ---------------------------------------------------------------------------

test('LAB-011: the create/run input surfaces expose NO credential-shaped field (the no-secret discipline)', () => {
  const createKeys = ['scope', 'contract'];
  const runKeys = Object.keys(validRunInput()).sort();
  assert.deepEqual(runKeys, ['addressedChannel', 'backend', 'bodyVersionReference', 'inputMessage', 'modelRegistryId', 'scope', 'toolExecutor']);
  for (const key of [...createKeys, ...runKeys]) {
    assert.ok(!/credential|secret|apikey|api_key|token|password|material/i.test(key), `input field '${key}' must not be a secret-bearing surface`);
  }
  // The model identity is a DATA reference (a registry id), never a
  // provider configuration: the run input carries no provider field.
  assert.ok(!runKeys.includes('provider'), 'no provider field exists on the run input — the identity is registry data');
});
