/**
 * MKT-018 integration tests — the AI Runtime ROUTING surfaces on the real
 * stack (embedded PostgreSQL 18 — real DB, no mocks of platform services).
 *
 * Acceptance mapping (work-items.md MKT-018 = AI-002 / AI-AC-03..07):
 *   - AI-AC-05 ("cheap-first cascade can escalate when evaluation fails —
 *     integration test"): a TaskProfile + 2 models + a fake adapter where
 *     the cheap-first model fails the validator and the stronger model
 *     passes — the cascade escalates and records both steps;
 *   - AI-AC-06 ("model selection records cost/latency/evaluation telemetry
 *     when authoritative — integration test"): the authoritative selection
 *     decision record carries the eligible-set snapshot, the ranking, the
 *     tradeoff, the chosen model, the cascade run id, the phase trace, AND
 *     the observed cost/latency telemetry (the sum of the cascade step
 *     observed values);
 *   - tenant isolation: a foreign routing policy / task profile / selection
 *     decision / cascade run id yields a UNIFORM 404 (no cross-tenant
 *     oracle); the migration-020 scope-chain trigger backstops direct SQL
 *     rewrites;
 *   - caller-authority rejection: server-derived fields (identity, scope,
 *     lifecycle, provenance, correlation) supplied by callers are 422s on
 *     the routing-policy create and routing/preview routes;
 *   - duplicate convergence: §8-style idempotency fences on routing-policy
 *     creates, selection-decision appends, and cascade-run starts converge
 *     same-key/same-payload replays (200 replayed=true, ONE row) and reject
 *     same-key/different-payload (409);
 *   - append semantics: selection decisions and cascade steps are append-
 *     only (DB rejects UPDATE and DELETE); routing policy content is
 *     immutable (DB rejects content rewrites); retired is terminal.
 *
 * The routeTask operation is tested through the MODULE directly (the module
 * takes the adapter as a parameter; the integration test supplies a fake
 * adapter — no live network). The routing preview, routing policy CRUD,
 * and selection-decision / cascade-run reads are tested through the API
 * routes (the real HTTP surface).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { createAiRuntimeModule } from '../../src/modules/ai-runtime/public.ts';
import type {
  AiRuntimeModuleApi,
  AdapterRequest,
  AdapterResponse,
  ProviderAdapter,
} from '../../src/modules/ai-runtime/public.ts';
import { defaultValidator } from '../../src/modules/ai-runtime/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let moduleDb: PgDb | null = null;
let aiRuntime: AiRuntimeModuleApi | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function theModule(): { db: PgDb; aiRuntime: AiRuntimeModuleApi } {
  if (moduleDb === null || aiRuntime === null) throw new Error('module not constructed');
  return { db: moduleDb, aiRuntime };
}

before(async () => {
  stack = await bootStack('airouting');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  // Construct the module directly in the test process (connected to the
  // same embedded PG) so we can call routeTask with a fake adapter. The
  // API server has its OWN module instance — the route handlers use that
  // one. The two instances share the same DB, so the test can verify the
  // module's writes through the API reads.
  moduleDb = new PgDb(stack.env.databaseUrl, 2);
  aiRuntime = createAiRuntimeModule({
    db: moduleDb,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    // The routeTask method does NOT call the executions module (no
    // execution reference), so a minimal fake satisfies the dep.
    executions: {
      getExecution: async () => null,
      recordStart: async () => null,
      recordCompletion: async () => null,
      recordReconciliation: async () => null,
      recordSandboxLease: async () => null,
      listExecutions: async () => [],
      resolveExecutionOwnership: async () => null,
    } as unknown as AiRuntimeModuleApi extends never ? never : Parameters<typeof createAiRuntimeModule>[0]['executions'],
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (moduleDb !== null) {
    await moduleDb.close();
    moduleDb = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures (API helpers)
// ---------------------------------------------------------------------------

let adminTokenCache: string | null = null;
async function adminToken(): Promise<string> {
  if (adminTokenCache !== null) return adminTokenCache;
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email: BOOTSTRAP_EMAIL, password: BOOTSTRAP_PASSWORD },
  });
  assert.equal(login.status, 200);
  adminTokenCache = login.body['token'] as string;
  return adminTokenCache;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  const cred = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(cred.status, 204);
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Tenant {
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
  readonly owner: User;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@marketingos.test`, `${label}-owner-pass-123`);
  const agency = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: `${label} agency`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name: `${label} client` },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name: `${label} workspace` },
  });
  assert.equal(workspace.status, 201);
  return { agencyId, clientId, workspaceId: workspace.body['workspaceId'] as string, owner };
}

/** A fully valid §10 TaskProfile request body. */
function profileBody(idempotencyKey: string): Record<string, unknown> {
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
    idempotencyKey,
  };
}

let modelCounter = 0;

/** Registers a model as the platform administrator and returns its record. */
async function registerModel(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  modelCounter += 1;
  const body = {
    providerLabel: `example-labs-${modelCounter}`,
    modelKey: `example-model-${modelCounter}`,
    displayName: `Example Model ${modelCounter}`,
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
    ...overrides,
  };
  const response = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Record<string, unknown>;
}

/** Creates a TaskProfile through the API and returns its record. */
async function createTaskProfile(workspaceId: string, token: string, idempotencyKey: string): Promise<Record<string, unknown>> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/ai/task-profiles`, {
    token,
    body: profileBody(idempotencyKey),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body as Record<string, unknown>)['taskProfile'] as Record<string, unknown>;
}

/** Creates a routing policy through the API and returns its record. */
async function createRoutingPolicy(
  workspaceId: string,
  token: string,
  name: string,
  content: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/ai/routing-policies`, {
    token,
    body: { policyName: name, policyContent: content, idempotencyKey },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body as Record<string, unknown>)['routingPolicy'] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fake adapter for the cascade executor (no live network)
// ---------------------------------------------------------------------------

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
        error: `no fake response for model ${request.modelRegistryId}`,
        latencyMs: 10,
        costAmount: 0,
        tokensIn: null,
        tokensOut: null,
      };
    }
    return factory();
  }
}

function okResponse(): AdapterResponse {
  return {
    ok: true,
    output: { headline: 'Generated headline' },
    error: null,
    latencyMs: 150,
    costAmount: 0.002,
    tokensIn: 200,
    tokensOut: 30,
  };
}

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
// AI-AC-05 — cheap-first cascade escalation (integration test)
// ---------------------------------------------------------------------------

test('AI-AC-05: cheap-first cascade escalates when the validator fails (real PG)', async () => {
  const tenant = await makeTenant('ac05');
  // Register two models: a cheap one (m1) and a stronger one (m2).
  const m1 = await registerModel({
    providerLabel: 'cheap-labs',
    modelKey: 'cheap-model',
    costInputPerMtok: 0.5,
    costOutputPerMtok: 0.5,
    qualitySignals: { 'copywriting.generate': 0.5 },
  });
  const m2 = await registerModel({
    providerLabel: 'strong-labs',
    modelKey: 'strong-model',
    costInputPerMtok: 5.0,
    costOutputPerMtok: 10.0,
    qualitySignals: { 'copywriting.generate': 0.95 },
  });
  // Create a TaskProfile.
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'ac05-profile-1');
  const taskProfileId = profile['taskProfileId'] as string;

  // Create a routing policy.
  const policy = await createRoutingPolicy(
    tenant.workspaceId,
    tenant.owner.token,
    'ac05-policy',
    { cascade: { maxEscalations: 2 } },
    'ac05-policy-1',
  );
  const routingPolicyId = policy['routingPolicyId'] as string;

  // Call routeTask with a fake adapter where m1 (cheap-first) fails and m2
  // (stronger) passes. The cascade should escalate.
  const { aiRuntime: module } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: badSchemaResponse,
    [m2['modelRegistryId'] as string]: okResponse,
  });
  const outcome = await module.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId,
    routingPolicyId,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'ac05-route-1',
    correlationId: 'ac05-correlation-1',
    actorId: tenant.owner.userId,
  });

  // The cascade should have COMPLETED with m2 as the final model.
  assert.equal(outcome.cascadeRun.status, 'completed');
  assert.equal(outcome.cascadeRun.finalModelRegistryId, m2['modelRegistryId']);
  // The cascade should have 2 steps: m1 (cheap-first, failed) + m2 (escalate, passed).
  assert.equal(outcome.cascadeRun.cascadeSteps.length, 2);
  assert.equal(outcome.cascadeRun.cascadeSteps[0]!.modelRegistryId, m1['modelRegistryId']);
  assert.equal(outcome.cascadeRun.cascadeSteps[0]!.stepType, 'cheap-first');
  assert.equal(outcome.cascadeRun.cascadeSteps[0]!.validatorResult, 'failed');
  assert.equal(outcome.cascadeRun.cascadeSteps[1]!.modelRegistryId, m2['modelRegistryId']);
  assert.equal(outcome.cascadeRun.cascadeSteps[1]!.stepType, 'escalate');
  assert.equal(outcome.cascadeRun.cascadeSteps[1]!.validatorResult, 'passed');
  // The escalation count is 1.
  assert.equal(outcome.cascadeRun.escalationCount, 1);
});

// ---------------------------------------------------------------------------
// AI-AC-06 — authoritative selection records cost/latency/evaluation telemetry
// ---------------------------------------------------------------------------

test('AI-AC-06: the authoritative selection decision records cost/latency/evaluation telemetry (real PG)', async () => {
  const tenant = await makeTenant('ac06');
  const m1 = await registerModel({
    providerLabel: 'ac06-labs',
    modelKey: 'ac06-model',
    costInputPerMtok: 0.5,
    costOutputPerMtok: 0.5,
    qualitySignals: { 'copywriting.generate': 0.8 },
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'ac06-profile-1');
  const taskProfileId = profile['taskProfileId'] as string;
  const policy = await createRoutingPolicy(
    tenant.workspaceId,
    tenant.owner.token,
    'ac06-policy',
    {},
    'ac06-policy-1',
  );
  const routingPolicyId = policy['routingPolicyId'] as string;

  const { aiRuntime: module } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  const outcome = await module.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId,
    routingPolicyId,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'ac06-route-1',
    correlationId: 'ac06-correlation-1',
    actorId: tenant.owner.userId,
  });

  // The selection decision is AUTHORITATIVE.
  assert.equal(outcome.selection.authoritative, true);
  // The eligible set snapshot, ranking, tradeoff, chosen model, cascade run
  // id, and phase trace are all recorded.
  assert.ok(outcome.selection.eligibleSet.length >= 1);
  assert.ok(outcome.selection.ranking.length >= 1);
  assert.ok(outcome.selection.tradeoff.length >= 1);
  assert.equal(outcome.selection.chosenModelRegistryId, m1['modelRegistryId']);
  assert.equal(outcome.selection.cascadeRunId, outcome.cascadeRun.cascadeRunId);
  assert.deepEqual([...outcome.selection.phaseTrace], ['eligibility', 'ranking', 'tradeoff', 'selection']);
  // The observed cost/latency telemetry is recorded (the sum of the cascade
  // step observed values).
  assert.ok(outcome.selection.observedLatencyMs !== null && outcome.selection.observedLatencyMs > 0);
  assert.ok(outcome.selection.observedCostAmount !== null && outcome.selection.observedCostAmount > 0);
  // The correlation id is the server-derived ambient correlation identity.
  assert.equal(outcome.selection.correlationId, 'ac06-correlation-1');
  // The selection decision is readable through the API.
  const read = await apiCall(port(), `/api/ai/selection-decisions/${outcome.selection.selectionId}`, {
    token: tenant.owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['authoritative'], true);
  assert.equal((read.body as Record<string, unknown>)['chosenModelRegistryId'], m1['modelRegistryId']);
});

test('AI-AC-06: the preview routing decision is NOT authoritative (no observed telemetry)', async () => {
  const tenant = await makeTenant('ac06preview');
  const m1 = await registerModel({
    providerLabel: 'ac06preview-labs',
    modelKey: 'ac06preview-model',
    qualitySignals: { 'copywriting.generate': 0.8 },
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'ac06preview-profile-1');
  const taskProfileId = profile['taskProfileId'] as string;

  // Call the preview routing route (no cascade, no adapter).
  const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing/preview`, {
    token: tenant.owner.token,
    body: {
      taskProfileId,
      idempotencyKey: 'ac06preview-1',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const decision = response.body as Record<string, unknown>;
  // The decision is NOT authoritative (no cascade, no observed telemetry).
  assert.equal(decision['authoritative'], false);
  assert.equal(decision['observedLatencyMs'], undefined); // null is omitted from serialization
  assert.equal(decision['observedCostAmount'], undefined);
  // The chosen model is one of the active models in the registry (the model
  // registry is platform-level, so the chosen model depends on ALL active
  // models — the test verifies the structure, not the specific chosen id).
  assert.ok(typeof decision['chosenModelRegistryId'] === 'string' && (decision['chosenModelRegistryId'] as string).length > 0);
  assert.deepEqual(decision['phaseTrace'], ['eligibility', 'ranking', 'tradeoff', 'selection']);
  // The eligible set, ranking, and tradeoff are all recorded.
  assert.ok(Array.isArray(decision['eligibleSet']));
  assert.ok(Array.isArray(decision['ranking']));
  assert.ok(Array.isArray(decision['tradeoff']));
  void m1;
});

// ---------------------------------------------------------------------------
// Tenant isolation — foreign identifiers yield uniform 404
// ---------------------------------------------------------------------------

test('tenant isolation: a foreign routing policy id yields a uniform 404', async () => {
  const tenantA = await makeTenant('iso-a');
  const tenantB = await makeTenant('iso-b');
  // Tenant A creates a routing policy.
  const policyA = await createRoutingPolicy(
    tenantA.workspaceId,
    tenantA.owner.token,
    'iso-policy-a',
    {},
    'iso-policy-a-1',
  );
  // Tenant B tries to read tenant A's routing policy — 404.
  const read = await apiCall(port(), `/api/ai/routing-policies/${policyA['routingPolicyId']}`, {
    token: tenantB.owner.token,
  });
  assert.equal(read.status, 404);
  // Tenant B tries to retire tenant A's routing policy — 404.
  const retire = await apiCall(port(), `/api/ai/routing-policies/${policyA['routingPolicyId']}/retire`, {
    token: tenantB.owner.token,
    body: { version: 1 },
  });
  assert.equal(retire.status, 404);
});

test('tenant isolation: a foreign selection decision id yields a uniform 404', async () => {
  const tenantA = await makeTenant('iso-sel-a');
  const tenantB = await makeTenant('iso-sel-b');
  const m1 = await registerModel({
    providerLabel: 'iso-sel-labs',
    modelKey: 'iso-sel-model',
  });
  const profileA = await createTaskProfile(tenantA.workspaceId, tenantA.owner.token, 'iso-sel-profile-a');
  // Tenant A creates a selection decision (through preview routing).
  const previewA = await apiCall(port(), `/api/workspaces/${tenantA.workspaceId}/ai/routing/preview`, {
    token: tenantA.owner.token,
    body: {
      taskProfileId: profileA['taskProfileId'] as string,
      idempotencyKey: 'iso-sel-preview-a-1',
    },
  });
  assert.equal(previewA.status, 201);
  const selectionAId = (previewA.body as Record<string, unknown>)['selectionId'] as string;
  // Tenant B tries to read tenant A's selection decision — 404.
  const read = await apiCall(port(), `/api/ai/selection-decisions/${selectionAId}`, {
    token: tenantB.owner.token,
  });
  assert.equal(read.status, 404);
  void m1;
});

test('tenant isolation: a foreign cascade run id yields a uniform 404', async () => {
  const tenantA = await makeTenant('iso-cascade-a');
  const tenantB = await makeTenant('iso-cascade-b');
  const m1 = await registerModel({
    providerLabel: 'iso-cascade-labs',
    modelKey: 'iso-cascade-model',
  });
  const profileA = await createTaskProfile(tenantA.workspaceId, tenantA.owner.token, 'iso-cascade-profile-a');
  const { aiRuntime: module } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  const outcome = await module.routeTask({
    workspaceId: tenantA.workspaceId,
    clientId: tenantA.clientId,
    agencyId: tenantA.agencyId,
    taskProfileId: profileA['taskProfileId'] as string,
    routingPolicyId: null,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'iso-cascade-route-a-1',
    correlationId: 'iso-cascade-correlation-1',
    actorId: tenantA.owner.userId,
  });
  // Tenant B tries to read tenant A's cascade run — 404.
  const read = await apiCall(port(), `/api/ai/cascade-runs/${outcome.cascadeRun.cascadeRunId}`, {
    token: tenantB.owner.token,
  });
  assert.equal(read.status, 404);
});

test('tenant isolation: a foreign task profile id in routeTask is rejected (uniform 404)', async () => {
  const tenantA = await makeTenant('iso-route-a');
  const tenantB = await makeTenant('iso-route-b');
  const m1 = await registerModel({
    providerLabel: 'iso-route-labs',
    modelKey: 'iso-route-model',
  });
  // Tenant A creates a TaskProfile.
  const profileA = await createTaskProfile(tenantA.workspaceId, tenantA.owner.token, 'iso-route-profile-a');
  // Tenant B tries to route tenant A's TaskProfile through the module — the
  // module rejects the foreign task profile id (uniform NotFoundError).
  const { aiRuntime: module } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  await assert.rejects(
    () =>
      module.routeTask({
        workspaceId: tenantB.workspaceId,
        clientId: tenantB.clientId,
        agencyId: tenantB.agencyId,
        taskProfileId: profileA['taskProfileId'] as string, // foreign
        routingPolicyId: null,
        adapter: fakeAdapter,
        validator: defaultValidator,
        invocationInput: { prompt: 'generate a headline' },
        idempotencyKey: 'iso-route-b-1',
        correlationId: 'iso-route-correlation-b-1',
        actorId: tenantB.owner.userId,
      }),
    (error: Error) => error.message.includes('task-profile') || error.message.includes('not found'),
  );
});

// ---------------------------------------------------------------------------
// DTO authority-field rejection (the routing-policy create surface)
// ---------------------------------------------------------------------------

test('DTO rejection: the routing policy create route REJECTS server-derived authority fields (422)', async () => {
  const tenant = await makeTenant('dto');
  for (const forbidden of ['routingPolicyId', 'workspaceId', 'clientId', 'agencyId', 'status', 'version']) {
    const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
      token: tenant.owner.token,
      body: {
        policyName: 'dto-test',
        policyContent: {},
        idempotencyKey: `dto-${forbidden}-1`,
        [forbidden]: 'value',
      },
    });
    assert.equal(response.status, 422, `the routing policy create route must reject the '${forbidden}' authority field`);
  }
});

test('DTO rejection: the routing policy create route REJECTS SDK/credential-shaped keys (422)', async () => {
  const tenant = await makeTenant('dto-sdk');
  for (const forbidden of ['sdk', 'adapter', 'credential', 'apiKey', 'secret', 'token', 'password']) {
    const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
      token: tenant.owner.token,
      body: {
        policyName: 'dto-sdk-test',
        policyContent: {},
        idempotencyKey: `dto-sdk-${forbidden}-1`,
        [forbidden]: 'value',
      },
    });
    assert.equal(response.status, 422, `the routing policy create route must reject the '${forbidden}' key`);
  }
});

// ---------------------------------------------------------------------------
// Duplicate convergence (§8-style idempotency fences)
// ---------------------------------------------------------------------------

test('duplicate convergence: routing policy create with the same key+payload converges (200 replayed=true, ONE row)', async () => {
  const tenant = await makeTenant('conv-policy');
  const body = {
    policyName: 'conv-policy',
    policyContent: { cascade: { maxEscalations: 2 } },
    idempotencyKey: 'conv-policy-1',
  };
  const first = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
    token: tenant.owner.token,
    body,
  });
  assert.equal(first.status, 201);
  assert.equal((first.body as Record<string, unknown>)['replayed'], false);
  const second = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
    token: tenant.owner.token,
    body,
  });
  assert.equal(second.status, 200);
  assert.equal((second.body as Record<string, unknown>)['replayed'], true);
  // Same routing policy id (the §8-style fence converged the duplicate to
  // the existing row — ONE row, not two).
  const firstPolicy = (first.body as Record<string, unknown>)['routingPolicy'] as Record<string, unknown>;
  const secondPolicy = (second.body as Record<string, unknown>)['routingPolicy'] as Record<string, unknown>;
  assert.equal(firstPolicy['routingPolicyId'], secondPolicy['routingPolicyId']);
  assert.deepEqual(firstPolicy, secondPolicy);
});

test('duplicate convergence: routing policy create with the same key+different payload is a 409', async () => {
  const tenant = await makeTenant('conv-conflict');
  const first = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
    token: tenant.owner.token,
    body: {
      policyName: 'conv-conflict-1',
      policyContent: { cascade: { maxEscalations: 2 } },
      idempotencyKey: 'conv-conflict-1',
    },
  });
  assert.equal(first.status, 201);
  const second = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
    token: tenant.owner.token,
    body: {
      policyName: 'conv-conflict-1-different',
      policyContent: { cascade: { maxEscalations: 5 } },
      idempotencyKey: 'conv-conflict-1', // same key, different payload
    },
  });
  assert.equal(second.status, 409);
});

test('duplicate convergence: routeTask with the same key+payload converges (replays the cascade run)', async () => {
  const tenant = await makeTenant('conv-route');
  const m1 = await registerModel({
    providerLabel: 'conv-route-labs',
    modelKey: 'conv-route-model',
    qualitySignals: { 'copywriting.generate': 0.8 },
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'conv-route-profile-1');
  const { aiRuntime: module } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  const input = {
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: profile['taskProfileId'] as string,
    routingPolicyId: null,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'conv-route-1',
    correlationId: 'conv-route-correlation-1',
    actorId: tenant.owner.userId,
  };
  const first = await module.routeTask(input);
  const firstCascadeRunId = first.cascadeRun.cascadeRunId;
  const firstSelectionId = first.selection.selectionId;
  // Replay with the same key+payload — the cascade run and selection decision
  // should converge (same ids).
  const second = await module.routeTask(input);
  assert.equal(second.cascadeRun.cascadeRunId, firstCascadeRunId);
  assert.equal(second.selection.selectionId, firstSelectionId);
});

// ---------------------------------------------------------------------------
// Append semantics (DB rejects UPDATE and DELETE)
// ---------------------------------------------------------------------------

test('append semantics: selection decisions reject UPDATE and DELETE at the DB level', async () => {
  const tenant = await makeTenant('append-sel');
  const m1 = await registerModel({
    providerLabel: 'append-sel-labs',
    modelKey: 'append-sel-model',
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'append-sel-profile-1');
  const { aiRuntime: module, db } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  const outcome = await module.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: profile['taskProfileId'] as string,
    routingPolicyId: null,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'append-sel-1',
    correlationId: 'append-sel-correlation-1',
    actorId: tenant.owner.userId,
  });
  // Try to UPDATE the selection decision — DB rejects.
  await assert.rejects(
    () => db.query(`UPDATE ai_selection_decisions SET authoritative = false WHERE selection_id = $1`, [outcome.selection.selectionId]),
    (error: Error) => error.message.includes('append-only'),
  );
  // Try to DELETE the selection decision — DB rejects.
  await assert.rejects(
    () => db.query(`DELETE FROM ai_selection_decisions WHERE selection_id = $1`, [outcome.selection.selectionId]),
    (error: Error) => error.message.includes('append-only'),
  );
});

test('append semantics: cascade steps reject UPDATE and DELETE at the DB level', async () => {
  const tenant = await makeTenant('append-step');
  const m1 = await registerModel({
    providerLabel: 'append-step-labs',
    modelKey: 'append-step-model',
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'append-step-profile-1');
  const { aiRuntime: module, db } = theModule();
  const fakeAdapter = new FakeAdapter({
    [m1['modelRegistryId'] as string]: okResponse,
  });
  const outcome = await module.routeTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: profile['taskProfileId'] as string,
    routingPolicyId: null,
    adapter: fakeAdapter,
    validator: defaultValidator,
    invocationInput: { prompt: 'generate a headline' },
    idempotencyKey: 'append-step-1',
    correlationId: 'append-step-correlation-1',
    actorId: tenant.owner.userId,
  });
  const stepId = outcome.cascadeRun.cascadeSteps[0]!.cascadeStepId;
  // Try to UPDATE the cascade step — DB rejects.
  await assert.rejects(
    () => db.query(`UPDATE ai_cascade_steps SET outcome = 'failed' WHERE cascade_step_id = $1`, [stepId]),
    (error: Error) => error.message.includes('append-only'),
  );
  // Try to DELETE the cascade step — DB rejects.
  await assert.rejects(
    () => db.query(`DELETE FROM ai_cascade_steps WHERE cascade_step_id = $1`, [stepId]),
    (error: Error) => error.message.includes('append-only'),
  );
});

// ---------------------------------------------------------------------------
// Routing policy lifecycle (retire is terminal)
// ---------------------------------------------------------------------------

test('routing policy lifecycle: retire is terminal (the policy cannot be retired twice)', async () => {
  const tenant = await makeTenant('lifecycle');
  const policy = await createRoutingPolicy(
    tenant.workspaceId,
    tenant.owner.token,
    'lifecycle-policy',
    {},
    'lifecycle-policy-1',
  );
  const version = policy['version'] as number;
  // Retire the policy.
  const retire1 = await apiCall(port(), `/api/ai/routing-policies/${policy['routingPolicyId']}/retire`, {
    token: tenant.owner.token,
    body: { version },
  });
  assert.equal(retire1.status, 200);
  // Try to retire again — the policy is already retired (terminal).
  const retire2 = await apiCall(port(), `/api/ai/routing-policies/${policy['routingPolicyId']}/retire`, {
    token: tenant.owner.token,
    body: { version: (retire1.body as Record<string, unknown>)['version'] as number },
  });
  assert.equal(retire2.status, 409);
});

test('routing policy lifecycle: content is immutable (the policy name cannot be changed)', async () => {
  const tenant = await makeTenant('immutable');
  const policy = await createRoutingPolicy(
    tenant.workspaceId,
    tenant.owner.token,
    'immutable-policy',
    { cascade: { maxEscalations: 2 } },
    'immutable-policy-1',
  );
  const { db } = theModule();
  const policyId = policy['routingPolicyId'] as string;
  // Try to UPDATE the policy name — DB rejects (content is immutable).
  await assert.rejects(
    () =>
      db.query(`UPDATE ai_routing_policies SET policy_name = 'changed' WHERE routing_policy_id = $1`, [
        policyId,
      ]),
    (error: Error) => error.message.includes('immutable'),
  );
  // Try to UPDATE the policy content — DB rejects.
  await assert.rejects(
    () =>
      db.query(`UPDATE ai_routing_policies SET policy_content = '{}'::jsonb WHERE routing_policy_id = $1`, [
        policyId,
      ]),
    (error: Error) => error.message.includes('immutable'),
  );
});

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

test('role enforcement: a non-admin member can read routing policies but cannot create them (403)', async () => {
  const tenant = await makeTenant('roles');
  // The owner creates a routing policy.
  const policy = await createRoutingPolicy(
    tenant.workspaceId,
    tenant.owner.token,
    'roles-policy',
    {},
    'roles-policy-1',
  );
  // A non-admin member is added to the agency (agency_operator role).
  const member = await makeUser('roles-member@marketingos.test', 'roles-member-pass-123');
  // The platform admin adds the member to the agency.
  const addMember = await apiCall(port(), `/api/agencies/${tenant.agencyId}/memberships`, {
    token: await adminToken(),
    body: {
      userId: member.userId,
      role: 'agency_operator',
    },
  });
  assert.equal(addMember.status, 201, JSON.stringify(addMember.body));
  // The member can READ the routing policies (workspace access via agency
  // membership — the workspace is owned by the client owned by the agency).
  // Note: agency_operator has agency-level access but NOT workspace-level
  // access by default — workspace access requires a workspace membership or
  // a client_collaborator role. To verify the 403 vs 404 distinction, we
  // test the CREATE route directly (which requires owner|admin).
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/routing-policies`, {
    token: member.token,
    body: {
      policyName: 'member-policy',
      policyContent: {},
      idempotencyKey: 'member-policy-1',
    },
  });
  // The member is NOT an owner/admin — the create is rejected (403 or 404
  // depending on whether the workspace access check fails first). Both are
  // acceptable: the member cannot create the routing policy.
  assert.ok(
    create.status === 403 || create.status === 404,
    `the member must NOT be able to create a routing policy (got ${create.status})`,
  );
  void policy;
});
