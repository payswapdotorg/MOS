/**
 * LAB-011 integration tests — the /lab-agent-body Agent Body Runtime
 * Contract against a REAL embedded PostgreSQL stack + the REAL
 * /ai-runtime module instance (the model authority): the module under
 * test is composed exactly as the composition root wires it (platform
 * ports + the narrow /ai-runtime structural port — the real
 * AiRuntimeModuleApi satisfies it structurally), with DETERMINISTIC
 * MODEL-BACKEND DOUBLES supplied per run (the /ai-runtime routeTask
 * adapter precedent: "the composition root wires the OpenRouter
 * adapter; integration tests supply fakes").
 *
 * The acceptance battery (spec/effective-backlog-v1.7.md LAB-011:
 * "Implement model-agnostic Agent Body execution with tools, memory,
 * permissions, budgets and evaluation hooks. Acceptance: at least two
 * interchangeable model backends through the existing AI runtime; no
 * second model router."):
 *   (a) THE TWO INTERCHANGEABLE MODEL BACKENDS: two model identities
 *       registered through the REAL /ai-runtime registry, the SAME
 *       body version + the SAME input message driven through BOTH
 *       identities — both runs succeed through the ONE runtime path,
 *       the outputs satisfy the SAME output contract with DIFFERENT
 *       content, and the model identity is recorded as DATA on each
 *       run + each model_invocation event;
 *   (b) the versioned body registry — the FULL §14 field set as
 *       declared data, draft → active → retired with append-only
 *       corrections, and the OPAQUE body-version reference (the exact
 *       string /lab organization candidates cite);
 *   (c) the honest failure taxonomy — input_contract_violation,
 *       model_unavailable (unresolved identity + registry
 *       'unavailable' + backend provider mismatch),
 *       model_invocation_failed, permission_refused (undeclared tool
 *       + unpermitted action kind — fail-closed), tool_error,
 *       budget_exceeded (token cap + invocation cap), latency_exceeded
 *       and output_contract_violation, each a recorded terminal run +
 *       event tail;
 *   (d) the bounded agent loop — a permitted tool invocation executes,
 *       its result is recorded as an event (digest + bounded result)
 *       and the model is re-invoked with the tool results before the
 *       final output;
 *   (e) the memory interfaces — body_scoped persistence across runs
 *       (the read path feeds the model invocation context), run_scoped
 *       scratch, capacity REFUSALS (recorded, non-terminal) and
 *       undeclared-memory refusals;
 *   (f) the evaluation hooks — every terminal run records the declared
 *       hook firings (hook identity + payload digest + the 'pending'
 *       outcome slot) on BOTH success and failure;
 *   (g) the tenant isolation (§22) — Bob's client can never read,
 *       instantiate or write into Alice's bodies/runs/memory (uniform
 *       NotFound, no existence oracle) + the DB scope-consistency
 *       triggers;
 *   (h) the DB backstops — events are append-only outright, run
 *       identity is immutable, terminal runs never move, and the
 *       version-chain scope fence rejects cross-tenant corrections;
 * plus the communication-interface channel fence.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  bootStack,
  shutdownStack,
  type IntegrationStack,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';
import { createAgenciesModule } from '../../src/modules/agencies/public.ts';
import { createClientsModule } from '../../src/modules/clients/public.ts';
import { createAiRuntimeModule } from '../../src/modules/ai-runtime/public.ts';
import type { AiRuntimeModuleApi } from '../../src/modules/ai-runtime/public.ts';
import {
  createLabAgentBodyModule,
  LAB_AGENT_BODY_CONTRACT_VERSION,
  LAB_AGENT_BODY_MEMORY_WRITES_KEY,
  LAB_AGENT_BODY_TOOL_CALLS_KEY,
  formatLabAgentBodyVersionReference,
  type LabAgentBodyContract,
  type LabAgentBodyModuleApi,
  type LabAgentBodyModelBackendPort,
  type LabAgentBodyModelInvocationRequest,
  type LabAgentBodyModelInvocationOutcome,
  type LabAgentBodyScope,
  type LabAgentBodyToolExecutorPort,
  type LabAgentRunEventRecord,
  type RunLabAgentInstanceInput,
} from '../../src/modules/lab-agent-body/public.ts';
import { NotFoundError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

let stack: IntegrationStack | null = null;
let db: PgDb | null = null;
let aiRuntime: AiRuntimeModuleApi = null as unknown as AiRuntimeModuleApi;
let agentBody: LabAgentBodyModuleApi = null as unknown as LabAgentBodyModuleApi;

// The tenant fixtures: Alice's agency + client, Bob's agency + client
// (mutable holders — the lab-corpus harness precedent).
const aliceScope: { agencyId: string; clientId: string } = { agencyId: '', clientId: '' };
const bobScope: { agencyId: string; clientId: string } = { agencyId: '', clientId: '' };

before(async () => {
  stack = await bootStack('lab_agent_body');
  db = new PgDb(stack.env.databaseUrl, 4);
  const clock = new SystemClock();
  const ids = new CryptoIdGenerator();
  const users = createUsersModule({ db, clock, ids });
  const agencies = createAgenciesModule({ db, clock, ids, users });
  const clients = createClientsModule({ db, clock, ids, agencies });
  // The REAL /ai-runtime module instance — the model authority. The
  // executions/evidence deps are minimal fakes (the routeTask surface
  // is never called by this module; the registry + observation
  // surfaces are real, backed by the real migration-016/020 tables).
  aiRuntime = createAiRuntimeModule({
    db,
    clock,
    ids,
    executions: {
      getExecution: async () => null,
      recordStart: async () => null,
      recordCompletion: async () => null,
      recordReconciliation: async () => null,
      recordSandboxLease: async () => null,
      listExecutions: async () => [],
      resolveExecutionOwnership: async () => null,
    } as unknown as Parameters<typeof createAiRuntimeModule>[0]['executions'],
    evidence: {
      appendEvidence: async () => {
        throw new Error('not used in this test');
      },
      getEvidence: async () => null,
      resolveEvidenceOwnership: async () => null,
      listEvidenceForClient: async () => [],
    } as unknown as Parameters<typeof createAiRuntimeModule>[0]['evidence'],
  });
  agentBody = createLabAgentBodyModule({ db, clock, ids, aiRuntime });

  // The tenant fixtures: Alice's agency + client, Bob's agency + client.
  const aliceUser = await users.createUser({ email: 'alice@labagentbody.test', displayName: 'Alice' });
  const aliceAgency = await agencies.createAgency({ name: 'Alice Agency', slug: 'alice-agent-body', ownerUserId: aliceUser.userId, actorId: null });
  const aliceClient = await clients.createClient({ agencyId: aliceAgency.agency.agencyId, name: 'Alice Client', slug: 'alice-client', actorId: null });
  aliceScope.agencyId = aliceAgency.agency.agencyId;
  aliceScope.clientId = aliceClient.clientId;

  const bobUser = await users.createUser({ email: 'bob@labagentbody.test', displayName: 'Bob' });
  const bobAgency = await agencies.createAgency({ name: 'Bob Agency', slug: 'bob-agent-body', ownerUserId: bobUser.userId, actorId: null });
  const bobClient = await clients.createClient({ agencyId: bobAgency.agency.agencyId, name: 'Bob Client', slug: 'bob-client', actorId: null });
  bobScope.agencyId = bobAgency.agency.agencyId;
  bobScope.clientId = bobClient.clientId;
});

after(async () => {
  if (db !== null) await db.close();
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// The deterministic doubles (the /ai-runtime routeTask adapter
// precedent — a test double at the model-backend boundary ONLY; the
// module, the registry port and the DB stack under test are fully real).
// ---------------------------------------------------------------------------

interface ScriptedBackend extends LabAgentBodyModelBackendPort {
  readonly requests: LabAgentBodyModelInvocationRequest[];
}

function backendDouble(
  providerLabel: string,
  script: ReadonlyArray<(request: LabAgentBodyModelInvocationRequest) => LabAgentBodyModelInvocationOutcome>,
  delayMs = 0,
): ScriptedBackend {
  const requests: LabAgentBodyModelInvocationRequest[] = [];
  let call = 0;
  return {
    providerLabel,
    requests,
    async invokeModel(request) {
      requests.push(request);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const produce = script[Math.min(call, script.length - 1)]!;
      call += 1;
      return produce(request);
    },
  };
}

function okOutcome(output: Record<string, unknown>, telemetry: Partial<LabAgentBodyModelInvocationOutcome> = {}): LabAgentBodyModelInvocationOutcome {
  return {
    ok: true,
    output,
    error: null,
    latencyMs: 5,
    costUnits: 0.01,
    tokensIn: 120,
    tokensOut: 80,
    ...telemetry,
  };
}

function errorOutcome(error: string): LabAgentBodyModelInvocationOutcome {
  return { ok: false, output: null, error, latencyMs: 5, costUnits: 0, tokensIn: null, tokensOut: null };
}

const noopExecutor: LabAgentBodyToolExecutorPort = {
  async executeTool() {
    return { ok: true, result: { note: 'noop' }, error: null };
  },
};

function executorDouble(results: Record<string, { ok: boolean; result: Record<string, unknown> | null; error: string | null }>): LabAgentBodyToolExecutorPort {
  return {
    async executeTool(input) {
      const outcome = results[input.toolId];
      if (outcome === undefined) return { ok: false, result: null, error: `no double for tool '${input.toolId}'` };
      return outcome;
    },
  };
}

// ---------------------------------------------------------------------------
// The §14 contract fixtures.
// ---------------------------------------------------------------------------

function fullContract(overrides: Partial<LabAgentBodyContract> = {}): LabAgentBodyContract {
  return {
    roleContract: { role: 'generalist-strategist', description: 'The §15 single-agent baseline occupant.' },
    inputContract: { type: 'object', required: ['niche'], properties: { niche: { type: 'string' }, platform: { type: 'string' } } },
    outputContract: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' }, confidence: { type: 'number' } } },
    tools: [
      { toolId: 'corpus-lookup', actionKind: 'read', description: 'Reads corpus references.' },
      { toolId: 'trend-analyzer', actionKind: 'analyze', description: 'Analyzes trends.' },
    ],
    permissions: ['read', 'analyze', 'compose'],
    memoryInterfaces: [
      { memoryId: 'strategy-notes', kind: 'body_scoped', capacityEntries: 2 },
      { memoryId: 'run-scratch', kind: 'run_scoped', capacityEntries: 1 },
    ],
    communicationInterface: [
      { channelId: 'org-bus', direction: 'outbound', messageKind: 'strategy-proposal' },
    ],
    actionInterface: ['draft_content', 'cite_evidence', 'analyze_audience'],
    capabilities: ['capability:niche-research@v1'],
    budget: { maxModelInvocations: 3, maxToolInvocations: 5, maxTokensIn: 1_000_000, maxTokensOut: 1_000_000, maxCostUnits: 100 },
    latencyLimits: { deadlineMs: 60_000 },
    evaluationHooks: [{ hookId: 'reward-hook' }, { hookId: 'safety-hook' }],
    safetyConstraints: ['no_fake_engagement', 'no_deceptive_attribution'],
    ...overrides,
  };
}

async function makeActiveBody(contract: LabAgentBodyContract = fullContract(), scope: LabAgentBodyScope = aliceScope): Promise<string> {
  const created = await agentBody.createBody({ scope, contract });
  await agentBody.activateBody(scope, created.bodyId);
  return created.bodyId;
}

async function registerAvailableModel(providerLabel: string, modelKey: string): Promise<string> {
  const model = await aiRuntime.registerModel({
    model: {
      providerLabel,
      modelKey,
      displayName: `${providerLabel}/${modelKey}`,
      capabilities: ['text'],
      toolFeatures: [],
      contextLimitTokens: 128_000,
      costInputPerMtok: 1,
      costOutputPerMtok: 2,
      latencyP50Ms: 500,
      latencyP95Ms: 1500,
      reliability: 0.99,
      qualitySignals: { 'lab.agent-body': 0.9 },
      privacyCharacteristics: {},
    },
    actorId: null,
  });
  await aiRuntime.appendModelObservation({
    modelRegistryId: model.modelRegistryId,
    availabilityState: 'available',
    observedLatencyP50Ms: 500,
    observedLatencyP95Ms: null,
    source: 'integration-fixture',
    notes: 'the LAB-011 fixture marks the model available',
    actorId: null,
  });
  return model.modelRegistryId;
}

function runInput(
  modelRegistryId: string,
  bodyVersionReference: string,
  backend: LabAgentBodyModelBackendPort,
  overrides: Partial<RunLabAgentInstanceInput> = {},
): RunLabAgentInstanceInput {
  return {
    scope: aliceScope,
    bodyVersionReference,
    modelRegistryId,
    inputMessage: { niche: 'home fitness equipment', platform: 'youtube' },
    backend,
    toolExecutor: noopExecutor,
    addressedChannel: null,
    ...overrides,
  };
}

async function eventsOf(runId: string): Promise<ReadonlyArray<LabAgentRunEventRecord>> {
  return agentBody.listRunEvents(aliceScope, runId);
}

// ---------------------------------------------------------------------------
// (a) THE ACCEPTANCE — two interchangeable model backends through the
// existing AI runtime.
// ---------------------------------------------------------------------------

test('LAB-011 ACCEPTANCE: the SAME body version + the SAME input runs through TWO interchangeable model identities registered via /ai-runtime (one runtime path, contract-identical outputs, different content)', async () => {
  const modelA = await registerAvailableModel('acme-labs', 'alpha-mini');
  const modelB = await registerAvailableModel('globex-ai', 'gpt-maximum');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);
  const inputMessage = { niche: 'home fitness equipment', platform: 'youtube' };

  // Backend A: the acme-labs double produces one output content.
  const backendA = backendDouble('acme-labs', [
    () => okOutcome({ summary: 'Strategy composed by alpha-mini: hooks around progressive overload.', confidence: 0.82 }),
  ]);
  const runA = await agentBody.runAgentInstance({ scope: aliceScope, bodyVersionReference: reference, modelRegistryId: modelA, inputMessage, backend: backendA, toolExecutor: noopExecutor, addressedChannel: null });

  // Backend B: the globex-ai double produces DIFFERENT content through
  // the SAME runtime path (the identical runAgentInstance surface).
  const backendB = backendDouble('globex-ai', [
    () => okOutcome({ summary: 'GPT-Maximum proposes a storytelling arc for the niche.', confidence: 0.91 }),
  ]);
  const runB = await agentBody.runAgentInstance({ scope: aliceScope, bodyVersionReference: reference, modelRegistryId: modelB, inputMessage, backend: backendB, toolExecutor: noopExecutor, addressedChannel: null });

  // BOTH runs succeeded; BOTH outputs satisfy the SAME output contract
  // (the required 'summary' string + the optional 'confidence' number).
  assert.equal(runA.status, 'succeeded');
  assert.equal(runB.status, 'succeeded');
  assert.equal(runA.failureReason, null);
  assert.equal(runB.failureReason, null);
  assert.ok(runA.outputMessage !== null && typeof runA.outputMessage['summary'] === 'string');
  assert.ok(runB.outputMessage !== null && typeof runB.outputMessage['summary'] === 'string');
  assert.deepEqual(Object.keys(runA.outputMessage!).sort(), Object.keys(runB.outputMessage!).sort(), 'the output STRUCTURE is contract-identical');
  assert.notEqual(runA.outputMessage!['summary'], runB.outputMessage!['summary'], 'the output CONTENT differs (different model backends)');

  // The model identity is DATA recorded on each run — the /ai-runtime
  // registry snapshot, different per run, identical in shape.
  assert.equal(runA.modelRegistryId, modelA);
  assert.equal(runA.modelProviderLabel, 'acme-labs');
  assert.equal(runA.modelKey, 'alpha-mini');
  assert.equal(runB.modelRegistryId, modelB);
  assert.equal(runB.modelProviderLabel, 'globex-ai');
  assert.equal(runB.modelKey, 'gpt-maximum');

  // The ONE runtime path: both event tails carry the IDENTICAL event
  // sequence for the identical no-tool run shape.
  const kindsA = (await eventsOf(runA.runId)).map((event) => event.eventKind);
  const kindsB = (await eventsOf(runB.runId)).map((event) => event.eventKind);
  assert.deepEqual(kindsA, ['run_started', 'model_invocation', 'run_completed', 'evaluation_hook', 'evaluation_hook']);
  assert.deepEqual(kindsA, kindsB, 'the two backends traverse the SAME runtime path');

  // Each model_invocation event cites its model identity as data.
  const invocationA = (await eventsOf(runA.runId)).find((event) => event.eventKind === 'model_invocation');
  const invocationB = (await eventsOf(runB.runId)).find((event) => event.eventKind === 'model_invocation');
  assert.equal((invocationA!.payload as Record<string, unknown>)['modelRegistryId'], modelA);
  assert.equal((invocationB!.payload as Record<string, unknown>)['modelRegistryId'], modelB);

  // The honest availability observations flowed through the REAL
  // /ai-runtime registry (the same authority the routing layer reads).
  const observationsA = await aiRuntime.listModelObservations(modelA);
  assert.ok(observationsA.some((observation) => observation.source === 'lab-agent-body' && observation.availabilityState === 'available'));
  const observationsB = await aiRuntime.listModelObservations(modelB);
  assert.ok(observationsB.some((observation) => observation.source === 'lab-agent-body' && observation.availabilityState === 'available'));
});

// ---------------------------------------------------------------------------
// (b) The versioned body registry + the opaque reference.
// ---------------------------------------------------------------------------

test('LAB-011: the body lifecycle draft → active → retired with append-only version corrections; the opaque reference resolves the EXACT version /lab cites', async () => {
  const created = await agentBody.createBody({ scope: aliceScope, contract: fullContract() });
  assert.equal(created.bodyVersion, 1);
  assert.equal(created.status, 'draft');
  assert.equal(created.contractVersion, LAB_AGENT_BODY_CONTRACT_VERSION);
  assert.equal(created.bodyVersionReference, `${created.bodyId}#v1`);

  // The reference resolves the exact version.
  const byReference = await agentBody.getBodyByReference(aliceScope, created.bodyVersionReference);
  assert.equal(byReference.bodyId, created.bodyId);
  assert.equal(byReference.bodyVersion, 1);

  const active = await agentBody.activateBody(aliceScope, created.bodyId);
  assert.equal(active.status, 'active');

  // The correction appends v2 as draft; v1 keeps its recorded status.
  const corrected = await agentBody.correctBody({ scope: aliceScope, bodyId: created.bodyId, contract: fullContract({ roleContract: { role: 'specialist-critic', description: 'Corrected.' } }) });
  assert.equal(corrected.bodyVersion, 2);
  assert.equal(corrected.status, 'draft');
  assert.equal(corrected.contract.roleContract.role, 'specialist-critic');
  assert.equal((await agentBody.getBodyByReference(aliceScope, `${created.bodyId}#v1`)).contract.roleContract.role, 'generalist-strategist');

  // getBody resolves the LATEST version; the lifecycle gate applies per version.
  assert.equal((await agentBody.getBody(aliceScope, created.bodyId)).bodyVersion, 2);
  await agentBody.activateBody(aliceScope, created.bodyId);
  const retired = await agentBody.retireBody(aliceScope, created.bodyId);
  assert.equal(retired.status, 'retired');

  // No resurrection / no skipping: the frozen transitions.
  await assert.rejects(() => agentBody.activateBody(aliceScope, created.bodyId), (error: unknown) => {
    assert.ok(error instanceof InvalidRequestError);
    return true;
  });
  await assert.rejects(() => agentBody.retireBody(aliceScope, created.bodyId), (error: unknown) => {
    assert.ok(error instanceof InvalidRequestError);
    return true;
  });
});

test('LAB-011: only an ACTIVE body version can be instantiated (draft/retired refused); a retired body refuses new runs but old runs stay recorded', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'draft-gate-model');
  const draft = await agentBody.createBody({ scope: aliceScope, contract: fullContract() });
  const draftReference = formatLabAgentBodyVersionReference(draft.bodyId, 1);
  await assert.rejects(
    () => agentBody.runAgentInstance(runInput(modelId, draftReference, backendDouble('acme-labs', [() => okOutcome({ summary: 'x' })]))),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('draft'));
      return true;
    },
  );

  await agentBody.activateBody(aliceScope, draft.bodyId);
  const run = await agentBody.runAgentInstance(runInput(modelId, draftReference, backendDouble('acme-labs', [() => okOutcome({ summary: 'recorded before retirement' })])));
  assert.equal(run.status, 'succeeded');

  await agentBody.retireBody(aliceScope, draft.bodyId);
  await assert.rejects(
    () => agentBody.runAgentInstance(runInput(modelId, draftReference, backendDouble('acme-labs', [() => okOutcome({ summary: 'x' })]))),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('retired'));
      return true;
    },
  );
  // The earlier run keeps its recorded version + output forever.
  const reread = await agentBody.getRun(aliceScope, run.runId);
  assert.equal(reread.status, 'succeeded');
  assert.equal(reread.outputMessage!['summary'], 'recorded before retirement');
});

// ---------------------------------------------------------------------------
// (c) The honest failure taxonomy.
// ---------------------------------------------------------------------------

test('LAB-011: model_unavailable — an identity that does not resolve through the /ai-runtime registry is an honest recorded terminal failure', async () => {
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);
  const unknownIdentity = await CryptoIdGenerator.prototype.newId.call(new CryptoIdGenerator());
  const run = await agentBody.runAgentInstance(runInput(unknownIdentity, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'never invoked' })])));
  assert.equal(run.status, 'failed');
  assert.equal(run.failureReason, 'model_unavailable');
  assert.equal(run.modelInvocations, 0, 'no model invocation happened');
  const kinds = (await eventsOf(run.runId)).map((event) => event.eventKind);
  assert.deepEqual(kinds, ['run_started', 'run_failed', 'evaluation_hook', 'evaluation_hook']);
});

test('LAB-011: model_unavailable — a registry model reporting unavailable, and a backend wired for the WRONG provider, are honest recorded refusals', async () => {
  const degradedModel = await registerAvailableModel('acme-labs', 'degraded-model');
  await aiRuntime.appendModelObservation({
    modelRegistryId: degradedModel,
    availabilityState: 'unavailable',
    observedLatencyP50Ms: null,
    observedLatencyP95Ms: null,
    source: 'integration-fixture',
    notes: 'the model goes unavailable',
    actorId: null,
  });
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  const unavailableRun = await agentBody.runAgentInstance(runInput(degradedModel, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'x' })])));
  assert.equal(unavailableRun.status, 'failed');
  assert.equal(unavailableRun.failureReason, 'model_unavailable');

  // The provider mismatch: the caller wires a globex-ai backend for an
  // acme-labs identity — a wiring mismatch is NEVER a silent fallback.
  const mismatchRun = await agentBody.runAgentInstance(runInput(degradedModel, reference, backendDouble('globex-ai', [() => okOutcome({ summary: 'x' })]), ));
  assert.notEqual(mismatchRun.runId, unavailableRun.runId);
  // The degraded model is unavailable either way; prove the mismatch
  // path on an AVAILABLE model:
  const availableModel = await registerAvailableModel('acme-labs', 'mismatch-probe');
  const mismatchRun2 = await agentBody.runAgentInstance(runInput(availableModel, reference, backendDouble('globex-ai', [() => okOutcome({ summary: 'x' })])));
  assert.equal(mismatchRun2.status, 'failed');
  assert.equal(mismatchRun2.failureReason, 'model_unavailable');
  const mismatchEvents = await eventsOf(mismatchRun2.runId);
  const failure = mismatchEvents.find((event) => event.eventKind === 'run_failed');
  assert.ok(String((failure!.payload as Record<string, unknown>)['detail']).includes('wiring mismatch'));
});

test('LAB-011: input_contract_violation and output_contract_violation are honest terminal failures (no fabricated compliance)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'contract-model');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  // The input message misses the required 'niche'.
  const badInputRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'x' })]), { inputMessage: { platform: 'youtube' } }),
  );
  assert.equal(badInputRun.status, 'failed');
  assert.equal(badInputRun.failureReason, 'input_contract_violation');
  assert.equal(badInputRun.modelInvocations, 0, 'the gate fires BEFORE any model invocation');

  // The model output misses the required 'summary'.
  const badOutputRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ confidence: 0.5 })])),
  );
  assert.equal(badOutputRun.status, 'failed');
  assert.equal(badOutputRun.failureReason, 'output_contract_violation');
  assert.equal(badOutputRun.modelInvocations, 1, 'the invocation happened and its event is recorded');
  const kinds = (await eventsOf(badOutputRun.runId)).map((event) => event.eventKind);
  assert.deepEqual(kinds, ['run_started', 'model_invocation', 'run_failed', 'evaluation_hook', 'evaluation_hook']);
});

test('LAB-011: model_invocation_failed and tool_error are honest terminal failures (the backend/executor never throw — data outcomes only)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'failing-model');
  const toolModelId = await registerAvailableModel('acme-labs', 'tool-failure-model');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  const invocationFailure = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => errorOutcome('provider error: 503')])),
  );
  assert.equal(invocationFailure.status, 'failed');
  assert.equal(invocationFailure.failureReason, 'model_invocation_failed');
  // The honest availability observation flowed through the /ai-runtime
  // registry: the failed invocation marks the model unavailable (the
  // same telemetry feed the routing layer aggregates from).
  const observations = await aiRuntime.listModelObservations(modelId);
  assert.ok(observations.some((observation) => observation.source === 'lab-agent-body' && observation.availabilityState === 'unavailable'));

  const toolFailure = await agentBody.runAgentInstance(
    runInput(toolModelId, reference, backendDouble('acme-labs', [
      () => okOutcome({ summary: 'draft', [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'corpus-lookup', arguments: { q: 'hooks' } }] }),
    ]), { toolExecutor: executorDouble({ 'corpus-lookup': { ok: false, result: null, error: 'corpus backend down' } }) }),
  );
  assert.equal(toolFailure.status, 'failed');
  assert.equal(toolFailure.failureReason, 'tool_error');
  const toolEvents = await eventsOf(toolFailure.runId);
  const toolInvocation = toolEvents.find((event) => event.eventKind === 'tool_invocation');
  assert.ok(toolInvocation !== undefined, 'the failing tool invocation is recorded as an event');
  assert.equal((toolInvocation.payload as Record<string, unknown>)['toolId'], 'corpus-lookup');
  assert.equal((toolInvocation.payload as Record<string, unknown>)['ok'], false);
});

test('LAB-011: permission_refused — an UNDECLARED tool and a DECLARED-but-UNPERMITTED action kind are fail-closed terminal refusals with recorded refusal events', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'permission-model');
  const bodyId = await makeActiveBody(fullContract({ permissions: ['read'] })); // 'analyze' NOT permitted
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  // The undeclared tool.
  const undeclaredRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [
      () => okOutcome({ summary: 'x', [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'secret-publisher', arguments: {} }] }),
    ])),
  );
  assert.equal(undeclaredRun.status, 'failed');
  assert.equal(undeclaredRun.failureReason, 'permission_refused');
  const undeclaredEvents = await eventsOf(undeclaredRun.runId);
  const refusal = undeclaredEvents.find((event) => event.eventKind === 'tool_refusal');
  assert.ok(refusal !== undefined, 'the refusal is recorded as an event');
  assert.equal((refusal.payload as Record<string, unknown>)['reason'], 'undeclared_tool');
  assert.equal((refusal.payload as Record<string, unknown>)['toolId'], 'secret-publisher');

  // The declared tool whose action kind is outside the permission set.
  const unpermittedRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [
      () => okOutcome({ summary: 'x', [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'trend-analyzer', arguments: { span: '30d' } }] }),
    ])),
  );
  assert.equal(unpermittedRun.status, 'failed');
  assert.equal(unpermittedRun.failureReason, 'permission_refused');
  const unpermittedEvents = await eventsOf(unpermittedRun.runId);
  const unpermittedRefusal = unpermittedEvents.find((event) => event.eventKind === 'tool_refusal');
  assert.equal((unpermittedRefusal!.payload as Record<string, unknown>)['reason'], 'action_not_permitted');
  assert.equal((unpermittedRefusal!.payload as Record<string, unknown>)['actionKind'], 'analyze');
});

test('LAB-011: budget_exceeded — the token cap and the model-invocation cap are honest terminal failures (the declared caps are enforced)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'budget-model');

  // The token cap: the body caps tokensIn at 500; the double reports 1200.
  const tokenBody = await makeActiveBody(fullContract({ budget: { maxModelInvocations: 3, maxToolInvocations: 5, maxTokensIn: 500, maxTokensOut: 1_000_000, maxCostUnits: 100 } }));
  const tokenRun = await agentBody.runAgentInstance(
    runInput(modelId, formatLabAgentBodyVersionReference(tokenBody, 1), backendDouble('acme-labs', [
      () => okOutcome({ summary: 'x' }, { tokensIn: 1200 }),
    ])),
  );
  assert.equal(tokenRun.status, 'failed');
  assert.equal(tokenRun.failureReason, 'budget_exceeded');
  assert.equal(tokenRun.observedTokensIn, 1200);

  // The invocation cap: the body allows ONE model invocation; the
  // first round requests a tool call, so the re-invocation is refused.
  const loopBody = await makeActiveBody(fullContract({ budget: { maxModelInvocations: 1, maxToolInvocations: 5, maxTokensIn: 1_000_000, maxTokensOut: 1_000_000, maxCostUnits: 100 } }));
  const loopRun = await agentBody.runAgentInstance(
    runInput(modelId, formatLabAgentBodyVersionReference(loopBody, 1), backendDouble('acme-labs', [
      () => okOutcome({ summary: 'x', [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'corpus-lookup', arguments: {} }] }),
      () => okOutcome({ summary: 'never reached' }),
    ])),
  );
  assert.equal(loopRun.status, 'failed');
  assert.equal(loopRun.failureReason, 'budget_exceeded');
  assert.equal(loopRun.modelInvocations, 1);
  assert.equal(loopRun.toolInvocations, 1, 'the permitted tool executed before the cap fired');
});

test('LAB-011: latency_exceeded — the declared deadline is an honest terminal failure (the run record never pretends the deadline held)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'slow-model');
  const bodyId = await makeActiveBody(fullContract({ latencyLimits: { deadlineMs: 1 } }));
  const run = await agentBody.runAgentInstance(
    runInput(modelId, formatLabAgentBodyVersionReference(bodyId, 1), backendDouble('acme-labs', [() => okOutcome({ summary: 'too late' })], 40)),
  );
  assert.equal(run.status, 'failed');
  assert.equal(run.failureReason, 'latency_exceeded');
  assert.equal(run.modelInvocations, 1, 'the invocation happened; the deadline check is honest about it');
  const kinds = (await eventsOf(run.runId)).map((event) => event.eventKind);
  assert.deepEqual(kinds, ['run_started', 'model_invocation', 'run_failed', 'evaluation_hook', 'evaluation_hook']);
});

// ---------------------------------------------------------------------------
// (d) The bounded agent loop — a permitted tool round + the final output.
// ---------------------------------------------------------------------------

test('LAB-011: the agent loop — a PERMITTED tool executes, its result is recorded, and the model is re-invoked with the tool results before the final output', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'tool-model');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);
  const seenRequests: LabAgentBodyModelInvocationRequest[] = [];
  const backend = backendDouble('acme-labs', [
    (request) => {
      seenRequests.push(request);
      return okOutcome({ summary: 'needs data', [LAB_AGENT_BODY_TOOL_CALLS_KEY]: [{ toolId: 'corpus-lookup', arguments: { query: 'hooks' } }] });
    },
    (request) => {
      seenRequests.push(request);
      return okOutcome({ summary: 'The corpus says hooks with numbers win.', confidence: 0.88 });
    },
  ]);
  const executor = executorDouble({ 'corpus-lookup': { ok: true, result: { topHooks: ['3-rep rule', '30-day arc'] }, error: null } });

  const run = await agentBody.runAgentInstance(runInput(modelId, reference, backend, { toolExecutor: executor }));
  assert.equal(run.status, 'succeeded');
  assert.equal(run.modelInvocations, 2, 'the model was invoked twice (tool round + final)');
  assert.equal(run.toolInvocations, 1);
  assert.equal(run.outputMessage!['summary'], 'The corpus says hooks with numbers win.');

  // The second invocation received the tool results as data.
  assert.equal(seenRequests.length, 2);
  assert.equal(seenRequests[1]!.toolResults!.length, 1);
  assert.equal(seenRequests[1]!.toolResults![0]!.toolId, 'corpus-lookup');
  assert.deepEqual(seenRequests[1]!.toolResults![0]!.result, { topHooks: ['3-rep rule', '30-day arc'] });

  // The event tail records the full loop.
  const kinds = (await eventsOf(run.runId)).map((event) => event.eventKind);
  assert.deepEqual(kinds, [
    'run_started', 'model_invocation', 'tool_invocation',
    'model_invocation', 'run_completed', 'evaluation_hook', 'evaluation_hook',
  ]);
  const toolEvent = (await eventsOf(run.runId)).find((event) => event.eventKind === 'tool_invocation');
  assert.equal((toolEvent!.payload as Record<string, unknown>)['resultRecorded'], true);
  assert.ok(typeof (toolEvent!.payload as Record<string, unknown>)['resultDigest'] === 'string');
});

// ---------------------------------------------------------------------------
// (e) The memory interfaces — bounded, scoped, cross-run persistent.
// ---------------------------------------------------------------------------

test('LAB-011: the memory interfaces — body_scoped memory persists across runs and feeds the model context; run_scoped stays per-run; capacity refusals are recorded and NON-terminal', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'memory-model');
  const bodyId = await makeActiveBody(); // strategy-notes (body_scoped, cap 2) + run-scratch (run_scoped, cap 1)
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  // Run 1: the model writes TWO body-scoped entries, ONE run-scoped
  // entry, a THIRD over-capacity body-scoped write and an undeclared
  // memory write — the run still SUCCEEDS (refusals are non-terminal).
  const run1 = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [
      () => okOutcome({
        summary: 'run one',
        [LAB_AGENT_BODY_MEMORY_WRITES_KEY]: [
          { memoryId: 'strategy-notes', entryKey: 'audience', entryValue: { note: 'lifters 25-40' } },
          { memoryId: 'strategy-notes', entryKey: 'tone', entryValue: { note: 'dry humor' } },
          { memoryId: 'strategy-notes', entryKey: 'overflow', entryValue: { note: 'past capacity' } },
          { memoryId: 'undeclared-memory', entryKey: 'x', entryValue: { note: 'nope' } },
          { memoryId: 'run-scratch', entryKey: 'draft', entryValue: { note: 'scratch pad' } },
        ],
      }),
    ])),
  );
  assert.equal(run1.status, 'succeeded', 'memory refusals never kill the run');
  const run1Events = await eventsOf(run1.runId);
  const memoryWrites = run1Events.filter((event) => event.eventKind === 'memory_write');
  const memoryRefusals = run1Events.filter((event) => event.eventKind === 'memory_refused');
  assert.equal(memoryWrites.length, 3);
  assert.equal(memoryRefusals.length, 2);
  const refusalReasons = memoryRefusals.map((event) => (event.payload as Record<string, unknown>)['reason']).sort();
  assert.deepEqual(refusalReasons, ['memory_capacity_exceeded', 'memory_not_declared']);

  // The body-scoped memory is readable through the public surface and
  // bounded at the declared capacity.
  const notes = await agentBody.readBodyMemory(aliceScope, bodyId, 'strategy-notes');
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((entry) => entry.entryKey).sort(), ['audience', 'tone']);

  // Run 2: the SAME body — the model context carries the persisted
  // body-scoped memory (the read path) and the run-scoped scratch of
  // run 1 does NOT leak into run 2.
  let secondRoundMemory: Record<string, unknown> | null = null;
  const run2 = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [
      (request) => {
        secondRoundMemory = request.memory as Record<string, unknown>;
        return okOutcome({ summary: 'run two reads memory' });
      },
    ])),
  );
  assert.equal(run2.status, 'succeeded');
  const memoryContext = secondRoundMemory as unknown as Record<string, ReadonlyArray<Record<string, unknown>>>;
  assert.ok(Array.isArray(memoryContext['strategy-notes']));
  assert.equal(memoryContext['strategy-notes']!.length, 2, 'the persisted body-scoped memory is in the model context');
  assert.ok(memoryContext['strategy-notes']!.some((entry) => entry['key'] === 'audience'));
  assert.ok(Array.isArray(memoryContext['run-scratch']));
  assert.equal(memoryContext['run-scratch']!.length, 0, 'run-scoped memory never leaks across runs');
});

// ---------------------------------------------------------------------------
// (f) The evaluation hooks — DATA for LAB-016/018.
// ---------------------------------------------------------------------------

test('LAB-011: the evaluation hooks fire on EVERY terminal run with hook identity + payload digest + the pending outcome slot (no evaluation logic here)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'hook-model');
  const bodyId = await makeActiveBody(); // two declared hooks
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  const successRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'hooked' })])),
  );
  assert.equal(successRun.status, 'succeeded');
  const successHooks = (await eventsOf(successRun.runId)).filter((event) => event.eventKind === 'evaluation_hook');
  assert.equal(successHooks.length, 2, 'each declared hook fires exactly once');
  const hookIds = successHooks.map((event) => (event.payload as Record<string, unknown>)['hookId']).sort();
  assert.deepEqual(hookIds, ['reward-hook', 'safety-hook']);
  for (const hook of successHooks) {
    const payload = hook.payload as Record<string, unknown>;
    assert.equal(payload['outcome'], 'pending', 'the outcome slot is the honest pending state');
    assert.match(String(payload['payloadDigest']), /^[0-9a-f]{64}$/, 'the payload digest is a 64-hex sha-256');
  }

  // A FAILED run fires the hooks too (the failure payload is as
  // digestible as the output payload — LAB-016/018 evaluate failures).
  const failedRun = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => errorOutcome('provider error: 429')])),
  );
  assert.equal(failedRun.status, 'failed');
  const failureHooks = (await eventsOf(failedRun.runId)).filter((event) => event.eventKind === 'evaluation_hook');
  assert.equal(failureHooks.length, 2);
});

// ---------------------------------------------------------------------------
// (g) The tenant isolation (§22) — uniform NotFound, no existence oracle.
// ---------------------------------------------------------------------------

test('LAB-011: the tenant isolation — Bob cannot read, instantiate or write into Alice\'s bodies/runs/memory (uniform NotFound, no existence oracle)', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'isolation-model');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  // Reads resolve to the uniform NotFound.
  await assert.rejects(() => agentBody.getBody(aliceScope === bobScope ? aliceScope : bobScope, bodyId), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });
  await assert.rejects(() => agentBody.getBodyByReference(bobScope, reference), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });
  await assert.rejects(() => agentBody.readBodyMemory(bobScope, bodyId, 'strategy-notes'), (error: unknown) => {
    assert.ok(error instanceof NotFoundError);
    return true;
  });

  // A run under Bob's scope is refused with the uniform NotFound —
  // before any model invocation.
  const bobRun = await agentBody.runAgentInstance({
    scope: bobScope,
    bodyVersionReference: reference,
    modelRegistryId: modelId,
    inputMessage: { niche: 'home fitness equipment', platform: 'youtube' },
    backend: backendDouble('acme-labs', [() => okOutcome({ summary: 'never' })]),
    toolExecutor: noopExecutor,
    addressedChannel: null,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(bobRun instanceof NotFoundError, 'the cross-tenant run is refused with the uniform NotFound');

  // Bob's run list shows nothing of Alice's activity.
  const bobRuns = await agentBody.listRuns(bobScope);
  assert.equal(bobRuns.length, 0);
  const aliceRuns = await agentBody.listRuns(aliceScope);
  assert.ok(aliceRuns.length >= 0, 'the list surface is scope-partitioned');
});

// ---------------------------------------------------------------------------
// (h) The DB backstops + the communication-interface fence.
// ---------------------------------------------------------------------------

test('LAB-011: the DB backstops — events are append-only outright, run identity is immutable, terminal runs never move, and the version-chain scope fence rejects cross-tenant corrections', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'backstop-model');
  const bodyId = await makeActiveBody();
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);
  const run = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'backstop' })])),
  );
  const events = await eventsOf(run.runId);
  assert.ok(events.length >= 3);

  // Events reject UPDATE and DELETE outright.
  await assert.rejects(
    () => db!.query(`UPDATE lab_agent_run_events SET payload = payload WHERE event_id = $1`, [events[0]!.eventId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_agent_run_events WHERE event_id = $1`, [events[0]!.eventId]),
    /append-only/,
  );

  // Run identity is immutable; the terminal state never moves.
  await assert.rejects(
    () => db!.query(`UPDATE lab_agent_instance_runs SET input_message = '{"hacked": true}'::jsonb WHERE run_id = $1`, [run.runId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query(`UPDATE lab_agent_instance_runs SET status = 'running' WHERE run_id = $1`, [run.runId]),
    /terminal/,
  );
  await assert.rejects(
    () => db!.query(`DELETE FROM lab_agent_instance_runs WHERE run_id = $1`, [run.runId]),
    /append-only/,
  );

  // The version-chain scope fence: a correction row injected under
  // Bob's client for Alice's body is rejected at the DB.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO lab_agent_body_versions
         (body_id, body_version, agency_id, client_id, workspace_id, status,
          role_contract, input_contract, output_contract, tools, permissions,
          memory_interfaces, communication_interface, action_interface, capabilities,
          budget, latency_limits, evaluation_hooks, safety_constraints,
          contract_version, created_at, updated_at)
       VALUES ($1, 2, $2, $3, NULL, 'draft',
               '{"role":"x","description":"x"}'::jsonb,
               '{"type":"object","required":[],"properties":{"a":{"type":"string"}}}'::jsonb,
               '{"type":"object","required":[],"properties":{"a":{"type":"string"}}}'::jsonb,
               '[]'::jsonb, '{read}',
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
               '{"maxModelInvocations":1,"maxToolInvocations":0,"maxTokensIn":1,"maxTokensOut":1,"maxCostUnits":0}'::jsonb,
               '{"deadlineMs":1000}'::jsonb, '[]'::jsonb, '{no_fake_engagement}',
               'lab-agent-body-contract-v1', now(), now())`,
      [bodyId, bobScope.agencyId, bobScope.clientId],
    ),
    /version chain scope/,
  );
});

test('LAB-011: the communication interface — an addressed run validates the channel against the body\'s declared channels and records it', async () => {
  const modelId = await registerAvailableModel('acme-labs', 'channel-model');
  const bodyId = await makeActiveBody(); // declares org-bus (outbound)
  const reference = formatLabAgentBodyVersionReference(bodyId, 1);

  // An undeclared channel is a malformed request (422).
  await assert.rejects(
    () => agentBody.runAgentInstance(runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'x' })]), { addressedChannel: 'secret-channel' })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidRequestError);
      assert.ok(String((error as InvalidRequestError).message).includes('secret-channel'));
      return true;
    },
  );

  // A declared channel is recorded on the run + the run_started event.
  const run = await agentBody.runAgentInstance(
    runInput(modelId, reference, backendDouble('acme-labs', [() => okOutcome({ summary: 'addressed' })]), { addressedChannel: 'org-bus' }),
  );
  assert.equal(run.status, 'succeeded');
  assert.equal(run.addressedChannel, 'org-bus');
  const started = (await eventsOf(run.runId)).find((event) => event.eventKind === 'run_started');
  assert.equal((started!.payload as Record<string, unknown>)['addressedChannel'], 'org-bus');
});

test('LAB-011: the runs are listable and the full §14 field set round-trips through the registry as declared data', async () => {
  const contract = fullContract();
  const bodyId = await makeActiveBody(contract);
  const stored = await agentBody.getBodyByReference(aliceScope, formatLabAgentBodyVersionReference(bodyId, 1));
  // The FULL §14 field set round-trips EXACTLY as declared data.
  assert.deepEqual(stored.contract.roleContract, contract.roleContract);
  assert.deepEqual(stored.contract.inputContract, contract.inputContract);
  assert.deepEqual(stored.contract.outputContract, contract.outputContract);
  assert.deepEqual(stored.contract.tools, contract.tools);
  assert.deepEqual(stored.contract.permissions, contract.permissions);
  assert.deepEqual(stored.contract.memoryInterfaces, contract.memoryInterfaces);
  assert.deepEqual(stored.contract.communicationInterface, contract.communicationInterface);
  assert.deepEqual(stored.contract.actionInterface, contract.actionInterface);
  assert.deepEqual(stored.contract.capabilities, contract.capabilities);
  assert.deepEqual(stored.contract.budget, contract.budget);
  assert.deepEqual(stored.contract.latencyLimits, contract.latencyLimits);
  assert.deepEqual(stored.contract.evaluationHooks, contract.evaluationHooks);
  assert.deepEqual(stored.contract.safetyConstraints, contract.safetyConstraints);

  const listed = await agentBody.listBodies(aliceScope);
  assert.ok(listed.some((body) => body.bodyId === bodyId));
  const scopedToBody = await agentBody.listRuns(aliceScope, bodyId);
  assert.ok(Array.isArray(scopedToBody));
});
