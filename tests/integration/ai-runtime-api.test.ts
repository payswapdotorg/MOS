/**
 * MKT-017 integration tests — the AI Runtime REGISTRY surfaces on the real
 * stack (embedded PostgreSQL 18 + real API process — no mocks of platform
 * services).
 *
 * Acceptance mapping (work-item-matrix.md MKT-017 = AI-001 / AI-AC-01..02):
 *   - AI-AC-01 ("domain requests use provider-neutral TaskProfiles —
 *     static/API contract test", API half): a TaskProfile is created,
 *     listed, read and retired through the provider-neutral contract, and
 *     the API CONTRACT REJECTS provider/model/credential-shaped request
 *     fields (422) — domain requests can never carry a provider or model
 *     selection;
 *   - AI-AC-02 (API-side corroboration): the model registry manages
 *     provider/model identity as LABELS through the platform surface —
 *     registration, observations, retirement — with no SDK anywhere;
 *   - tenant isolation: foreign task-profile/usage-telemetry identifiers
 *     yield UNIFORM 404s (no cross-tenant oracle); a foreign task-profile
 *     reference inside a telemetry append is a 404; a foreign execution
 *     reference is a 404; direct SQL cannot smuggle cross-scope rows (the
 *     scope-chain trigger backstop);
 *   - caller-authority rejection: server-derived fields (identity, scope,
 *     lifecycle, provenance, correlation) supplied by callers are 422s;
 *   - duplicate convergence: §8-style idempotency fences on TaskProfile
 *     creates and telemetry appends converge same-key/same-payload replays
 *     (200 replayed=true, ONE row) and reject same-key/different-payload
 *     (409); the model (provider_label, model_key) ACTIVE-pair fence is a
 *     deterministic 409, freed by retirement;
 *   - append semantics: usage telemetry and model observations are
 *     append-only (DB rejects UPDATE and DELETE); TaskProfile/model content
 *     is immutable (DB rejects content rewrites); retired is terminal (DB
 *     rejects resurrection); the current model availability is DERIVED from
 *     the latest appended observation;
 *   - role enforcement: registry writes require owner/admin (403 for
 *     members), model management requires the platform administrator.
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

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SERVICE_TOKEN = 'integration-test-token';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('airuntime');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
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

// ---------------------------------------------------------------------------
// AI-AC-01 — the provider-neutral TaskProfile surface
// ---------------------------------------------------------------------------

test('AI-AC-01: TaskProfiles register, list, read and retire through the provider-neutral contract', async () => {
  const tenant = await makeTenant('ac01');

  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('profile-ac01-1'),
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body['replayed'], false);
  const profile = create.body['taskProfile'] as Record<string, unknown>;
  assert.equal(profile['taskClass'], 'copywriting.generate');
  assert.equal(profile['status'], 'active');
  assert.equal(profile['workspaceId'], tenant.workspaceId);
  assert.equal(profile['clientId'], tenant.clientId);
  assert.equal(profile['agencyId'], tenant.agencyId);
  assert.equal(profile['version'], 1);
  // The serialized record carries the full §10 neutral contract.
  for (const field of [
    'taskClass',
    'qualityTarget',
    'riskClass',
    'contextRequirements',
    'latencyTargetMs',
    'maxCostPerInvocation',
    'privacyClass',
    'toolRequirements',
    'outputSchema',
    'evaluatorIds',
    'escalationPolicy',
  ]) {
    assert.ok(field in profile, `the serialized TaskProfile carries '${field}'`);
  }
  // ...and NO provider/model/credential field.
  for (const forbidden of ['provider', 'model', 'modelId', 'credential', 'apiKey']) {
    assert.ok(!(forbidden in profile), `the serialized TaskProfile must not carry '${forbidden}'`);
  }

  // Second profile of the same task class (different quality target) is a
  // legitimate new registry row — task classes are not unique.
  const second = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: { ...profileBody('profile-ac01-2'), qualityTarget: 'draft-quality' },
  });
  assert.equal(second.status, 201);

  const list = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal((list.body['taskProfiles'] as unknown[]).length, 2);

  const read = await apiCall(port(), `/api/ai/task-profiles/${profile['taskProfileId']}`, {
    token: tenant.owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['taskProfileId'], profile['taskProfileId']);

  // Retire with a stale version is a 409; the correct version retires; the
  // tombstone stays readable and terminal.
  const badRetire = await apiCall(port(), `/api/ai/task-profiles/${profile['taskProfileId']}/retire`, {
    token: tenant.owner.token,
    body: { version: 99 },
  });
  assert.equal(badRetire.status, 409);
  const retire = await apiCall(port(), `/api/ai/task-profiles/${profile['taskProfileId']}/retire`, {
    token: tenant.owner.token,
    body: { version: 1 },
  });
  assert.equal(retire.status, 200);
  assert.equal((retire.body as Record<string, unknown>)['status'], 'retired');
  assert.equal((retire.body as Record<string, unknown>)['version'], 2);
  const reRetire = await apiCall(port(), `/api/ai/task-profiles/${profile['taskProfileId']}/retire`, {
    token: tenant.owner.token,
    body: { version: 2 },
  });
  assert.equal(reRetire.status, 409, 'retired is terminal — no resurrection, no re-retire');
  const readRetired = await apiCall(port(), `/api/ai/task-profiles/${profile['taskProfileId']}`, {
    token: tenant.owner.token,
  });
  assert.equal(readRetired.status, 200, 'retired history stays visible');
});

test('AI-AC-01 (API contract): provider/model/credential-shaped request fields are REJECTED — domain requests can never carry a provider or model selection', async () => {
  const tenant = await makeTenant('neutral');

  for (const forbidden of [
    { provider: 'openai' },
    { providerLabel: 'anthropic' },
    { model: 'gpt-4o' },
    { modelName: 'claude-3' },
    { modelId: '00000000-0000-4000-8000-000000000000' },
    { candidateModels: ['a', 'b'] },
    { routingStrategy: 'cheapest-sufficient' },
    { apiKey: 'sk-test' },
    { credentialId: '00000000-0000-4000-8000-000000000000' },
    { status: 'retired' },
    { taskProfileId: '00000000-0000-4000-8000-000000000000' },
    { version: 7 },
  ]) {
    const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
      token: tenant.owner.token,
      body: { ...profileBody(`neutral-${JSON.stringify(Object.keys(forbidden))}`), ...forbidden },
    });
    assert.equal(response.status, 422, `a TaskProfile carrying ${JSON.stringify(forbidden)} must be rejected`);
    assert.equal(
      ((response.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
      'INVALID_REQUEST',
    );
  }
});

// ---------------------------------------------------------------------------
// Model registry (AI-AC-02 API-side corroboration) + observations
// ---------------------------------------------------------------------------

test('the model registry manages provider/model LABELS with the observation-derived availability (AI-AC-02)', async () => {
  const model = await registerModel();
  const modelId = model['modelRegistryId'] as string;
  assert.equal(model['providerLabel'], `example-labs-${modelCounter}`);
  assert.equal(model['availabilityState'], 'available');
  assert.equal(model['status'], 'active');

  // The catalog lists the ACTIVE entry for any authenticated principal.
  const list = await apiCall(port(), '/api/ai/models', { token: (await makeTenant('catalog')).owner.token });
  assert.equal(list.status, 200);
  const listed = (list.body['models'] as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry['modelRegistryId'] === modelId,
  );
  assert.ok(listed !== undefined, 'the registered model is listed');
  assert.deepEqual(listed['capabilities'], ['text-generation', 'tool-use']);

  const read = await apiCall(port(), `/api/ai/models/${modelId}`, { token: await adminToken() });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['modelKey'], model['modelKey']);

  // Observations are append-only history; the CURRENT availability is
  // DERIVED from the latest appended observation.
  const first = await apiCall(port(), `/api/ai/models/${modelId}/observations`, {
    token: await adminToken(),
    body: { availabilityState: 'degraded', observedLatencyP95Ms: 4200, source: 'platform-probe', notes: 'elevated latency' },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((first.body['model'] as Record<string, unknown>)['availabilityState'], 'degraded');

  const second = await apiCall(port(), `/api/ai/models/${modelId}/observations`, {
    token: await adminToken(),
    body: { availabilityState: 'available', observedLatencyP95Ms: 2100, source: 'platform-probe' },
  });
  assert.equal(second.status, 201);
  assert.equal((second.body['model'] as Record<string, unknown>)['availabilityState'], 'available');

  const history = await apiCall(port(), `/api/ai/models/${modelId}/observations`, {
    token: await adminToken(),
  });
  assert.equal(history.status, 200);
  const observations = history.body['observations'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(observations.length, 2, 'both observations remain in the append-only history');
  assert.equal(observations[0]!['availabilityState'], 'degraded');
  assert.equal(observations[1]!['availabilityState'], 'available');

  // A caller cannot smuggle the current state directly — it is server-derived.
  const smuggle = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel: `example-labs-${modelCounter + 100}`,
      modelKey: 'smuggled-state',
      displayName: 'Smuggled State',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 1000,
      availabilityState: 'unavailable',
    },
  });
  assert.equal(smuggle.status, 422, 'availabilityState is server-derived (rejected as an authority field)');

  // SDK/credential-shaped registration fields are rejected (AI-AC-02).
  const sdkField = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel: 'sdk-smuggler',
      modelKey: 'sdk-model',
      displayName: 'SDK Model',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 1000,
      sdk: 'openai',
    },
  });
  assert.equal(sdkField.status, 422, 'an SDK-shaped registration field is rejected');
});

test('model lifecycle: the ACTIVE pair fence, terminal retirement and post-retirement history', async () => {
  const model = await registerModel();
  const modelId = model['modelRegistryId'] as string;
  const providerLabel = model['providerLabel'] as string;
  const modelKey = model['modelKey'] as string;

  // Duplicate ACTIVE pair registration is a deterministic 409.
  const duplicate = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel,
      modelKey,
      displayName: 'Duplicate Pair',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 1000,
    },
  });
  assert.equal(duplicate.status, 409);

  // Retire (CAS), then the pair frees for a NEW identity.
  const retire = await apiCall(port(), `/api/ai/models/${modelId}/retire`, {
    token: await adminToken(),
    body: { version: 1 },
  });
  assert.equal(retire.status, 200);
  assert.equal((retire.body as Record<string, unknown>)['status'], 'retired');

  const reRetire = await apiCall(port(), `/api/ai/models/${modelId}/retire`, {
    token: await adminToken(),
    body: { version: 2 },
  });
  assert.equal(reRetire.status, 409, 'retired models are terminal');

  // An observation on the RETIRED entry records history without mutating
  // the tombstone (the current state stays as retired froze it).
  const observation = await apiCall(port(), `/api/ai/models/${modelId}/observations`, {
    token: await adminToken(),
    body: { availabilityState: 'unavailable', source: 'usage-aggregate' },
  });
  assert.equal(observation.status, 201);
  const observedModel = observation.body['model'] as Record<string, unknown>;
  assert.equal(observedModel['status'], 'retired');
  assert.equal(observedModel['availabilityState'], 'available', 'the tombstone keeps the state it had at retirement — the observation records history only');
  assert.equal(observedModel['version'], 2, 'the retired tombstone was not CAS-bumped by the observation');

  // Re-registering the freed pair creates a NEW identity.
  const reborn = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel,
      modelKey,
      displayName: 'Reborn Entry',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 2000,
    },
  });
  assert.equal(reborn.status, 201);
  assert.notEqual((reborn.body as Record<string, unknown>)['modelRegistryId'], modelId);

  // Retired entries disappear from the ACTIVE catalog but stay readable.
  const catalog = await apiCall(port(), '/api/ai/models', { token: await adminToken() });
  const activeIds = (catalog.body['models'] as ReadonlyArray<Record<string, unknown>>).map(
    (entry) => entry['modelRegistryId'],
  );
  assert.ok(!activeIds.includes(modelId), 'the retired model left the ACTIVE catalog');
  const readRetired = await apiCall(port(), `/api/ai/models/${modelId}`, { token: await adminToken() });
  assert.equal(readRetired.status, 200, 'the retired model stays readable by id');
});

test('model management is platform-administrator territory (403 for tenant users)', async () => {
  const tenant = await makeTenant('modelrbac');
  const register = await apiCall(port(), '/api/ai/models', {
    token: tenant.owner.token,
    body: {
      providerLabel: 'unauthorized-labs',
      modelKey: 'unauthorized-model',
      displayName: 'Unauthorized',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 1000,
    },
  });
  assert.equal(register.status, 403);
});

// ---------------------------------------------------------------------------
// Usage telemetry — append semantics, convergence, references
// ---------------------------------------------------------------------------

test('usage telemetry appends the §24 record shape and converges duplicates (EXEC-style §8 fence)', async () => {
  const tenant = await makeTenant('usage');
  const model = await registerModel();

  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('usage-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  const correlationUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const append = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    correlationId: correlationUuid,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 1234,
      costAmount: 0.0125,
      tokensIn: 1500,
      tokensOut: 420,
      evaluationRef: 'eval:brand-voice-rubric:run-42',
      escalationCount: 0,
      idempotencyKey: 'usage-append-1',
    },
  });
  assert.equal(append.status, 201, JSON.stringify(append.body));
  assert.equal(append.body['replayed'], false);
  const record = append.body['usageTelemetry'] as Record<string, unknown>;
  assert.equal(record['outcome'], 'succeeded');
  assert.equal(record['latencyMs'], 1234);
  assert.equal(record['costAmount'], 0.0125);
  assert.equal(record['tokensIn'], 1500);
  assert.equal(record['correlationId'], correlationUuid, 'the correlation identity is SERVER-DERIVED from the request correlation context (never a body field)');
  assert.equal(record['workspaceId'], tenant.workspaceId);
  assert.equal(record['modelRegistryId'], model['modelRegistryId']);

  // Duplicate delivery of the SAME logical command converges (ONE row).
  const replay = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    correlationId: 'ffffffff-0000-4000-8000-000000000001',
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 1234,
      costAmount: 0.0125,
      tokensIn: 1500,
      tokensOut: 420,
      evaluationRef: 'eval:brand-voice-rubric:run-42',
      escalationCount: 0,
      idempotencyKey: 'usage-append-1',
    },
  });
  assert.equal(replay.status, 200, 'a duplicate converges with 200 replayed');
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    (replay.body['usageTelemetry'] as Record<string, unknown>)['usageId'],
    record['usageId'],
    'the replay converges to the SAME row identity',
  );

  // The same key with a DIFFERENT payload is a conflict, never an overwrite.
  const conflict = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'failed',
      latencyMs: 1234,
      costAmount: 0.0125,
      tokensIn: 1500,
      tokensOut: 420,
      evaluationRef: 'eval:brand-voice-rubric:run-42',
      escalationCount: 0,
      idempotencyKey: 'usage-append-1',
    },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    ((conflict.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    'IDEMPOTENCY_CONFLICT',
  );

  const list = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal((list.body['usageTelemetry'] as unknown[]).length, 1, 'exactly ONE telemetry row exists');

  const read = await apiCall(port(), `/api/ai/usage-telemetry/${record['usageId']}`, {
    token: tenant.owner.token,
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['usageId'], record['usageId']);

  // Unknown outcomes are first-class records (frozen UNKNOWN semantics —
  // never success, but recordable; a resolution appends a NEW record).
  const unknown = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'unknown',
      latencyMs: 999,
      costAmount: 0,
      idempotencyKey: 'usage-append-unknown',
    },
  });
  assert.equal(unknown.status, 201);
});

test('usage telemetry references validate: the execution link must belong to the SAME Workspace', async () => {
  const tenant = await makeTenant('execlink');
  const model = await registerModel();
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('execlink-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  // A genuine AI-kind execution in the SAME workspace is a valid link.
  const execution = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/executions`, {
    token: tenant.owner.token,
    body: {
      workflowInstanceId: '00000000-0000-7000-8000-0000000000e1',
      nodeId: 'node-exec-1',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'exec-1',
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  const executionId = (execution.body['execution'] as Record<string, unknown>)['executionId'] as string;

  const linked = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      executionId,
      outcome: 'succeeded',
      latencyMs: 800,
      costAmount: 0.01,
      idempotencyKey: 'execlink-1',
    },
  });
  assert.equal(linked.status, 201);
  assert.equal((linked.body['usageTelemetry'] as Record<string, unknown>)['executionId'], executionId);

  // A FOREIGN workspace's execution is a uniform 404 (no traversal oracle).
  const other = await makeTenant('execlink2');
  const foreignExecution = await apiCall(port(), `/api/workspaces/${other.workspaceId}/executions`, {
    token: other.owner.token,
    body: {
      workflowInstanceId: '00000000-0000-7000-8000-0000000000e2',
      nodeId: 'node-exec-2',
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey: 'exec-2',
    },
  });
  assert.equal(foreignExecution.status, 201);
  const foreignExecutionId = (foreignExecution.body['execution'] as Record<string, unknown>)['executionId'] as string;

  const foreignLink = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      executionId: foreignExecutionId,
      outcome: 'succeeded',
      latencyMs: 800,
      costAmount: 0.01,
      idempotencyKey: 'execlink-2',
    },
  });
  assert.equal(foreignLink.status, 404, 'a foreign execution reference is indistinguishable from an unknown one');

  // Unknown model references are 404s; authority fields are 422s.
  const unknownModel = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: '00000000-0000-4000-8000-000000000000',
      outcome: 'succeeded',
      latencyMs: 800,
      costAmount: 0.01,
      idempotencyKey: 'execlink-3',
    },
  });
  assert.equal(unknownModel.status, 404);

  for (const forbidden of [
    { correlationId: 'caller-supplied' },
    { usageId: '00000000-0000-4000-8000-000000000000' },
    { provider: 'openai' },
    { model: 'gpt-4o' },
    { apiKey: 'sk-test' },
  ]) {
    const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
      token: tenant.owner.token,
      body: {
        taskProfileId: profileId,
        modelRegistryId: model['modelRegistryId'],
        outcome: 'succeeded',
        latencyMs: 800,
        costAmount: 0.01,
        idempotencyKey: `execlink-authority-${JSON.stringify(Object.keys(forbidden))}`,
        ...forbidden,
      },
    });
    assert.equal(response.status, 422, `telemetry carrying ${JSON.stringify(forbidden)} must be rejected`);
  }
});

test('the service principal (the future runtime caller shape) can append telemetry', async () => {
  const tenant = await makeTenant('svc');
  const model = await registerModel();
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('svc-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  const append = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: SERVICE_TOKEN,
    correlationId: 'corr-service-1',
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'escalated',
      latencyMs: 2200,
      costAmount: 0.03,
      escalationCount: 1,
      idempotencyKey: 'svc-append-1',
    },
  });
  assert.equal(append.status, 201, JSON.stringify(append.body));
  assert.equal((append.body['usageTelemetry'] as Record<string, unknown>)['outcome'], 'escalated');
});

// ---------------------------------------------------------------------------
// Tenant isolation — cross-tenant rejection (uniform 404s)
// ---------------------------------------------------------------------------

test('cross-tenant identifiers yield UNIFORM 404s — no traversal/existence oracle (tenant isolation)', async () => {
  const tenantA = await makeTenant('isoa');
  const tenantB = await makeTenant('isob');

  const model = await registerModel();
  const createA = await apiCall(port(), `/api/workspaces/${tenantA.workspaceId}/ai/task-profiles`, {
    token: tenantA.owner.token,
    body: profileBody('iso-profile-a'),
  });
  assert.equal(createA.status, 201);
  const profileA = createA.body['taskProfile'] as Record<string, unknown>;
  const profileIdA = profileA['taskProfileId'] as string;

  const telemetryA = await apiCall(port(), `/api/workspaces/${tenantA.workspaceId}/ai/usage-telemetry`, {
    token: tenantA.owner.token,
    body: {
      taskProfileId: profileIdA,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 500,
      costAmount: 0.01,
      idempotencyKey: 'iso-telemetry-a',
    },
  });
  assert.equal(telemetryA.status, 201);
  const usageIdA = (telemetryA.body['usageTelemetry'] as Record<string, unknown>)['usageId'] as string;

  // Foreign reads: 404, indistinguishable from unknown identifiers.
  const foreignProfileRead = await apiCall(port(), `/api/ai/task-profiles/${profileIdA}`, {
    token: tenantB.owner.token,
  });
  assert.equal(foreignProfileRead.status, 404);
  const foreignUsageRead = await apiCall(port(), `/api/ai/usage-telemetry/${usageIdA}`, {
    token: tenantB.owner.token,
  });
  assert.equal(foreignUsageRead.status, 404);

  // Foreign writes through the API: the tenant-B workspace cannot append
  // telemetry referencing tenant-A's profile (uniform 404).
  const foreignTelemetry = await apiCall(port(), `/api/workspaces/${tenantB.workspaceId}/ai/usage-telemetry`, {
    token: tenantB.owner.token,
    body: {
      taskProfileId: profileIdA,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 500,
      costAmount: 0.01,
      idempotencyKey: 'iso-telemetry-b',
    },
  });
  assert.equal(foreignTelemetry.status, 404, 'a foreign task-profile reference is indistinguishable from an unknown one');

  // Cross-tenant listing stays empty for B (nothing leaked).
  const listB = await apiCall(port(), `/api/workspaces/${tenantB.workspaceId}/ai/task-profiles`, {
    token: tenantB.owner.token,
  });
  assert.equal(listB.status, 200);
  assert.equal((listB.body['taskProfiles'] as unknown[]).length, 0);

  // Foreign retire attempts are 404s BEFORE authorization (no oracle).
  const foreignRetire = await apiCall(port(), `/api/ai/task-profiles/${profileIdA}/retire`, {
    token: tenantB.owner.token,
    body: { version: 1 },
  });
  assert.equal(foreignRetire.status, 404);
});

test('role enforcement: registry writes require owner/admin; reads stay member-visible', async () => {
  const tenant = await makeTenant('roles');
  const member = await makeUser('roles-member@marketingos.test', 'roles-member-pass-123');
  // Grant the member an active non-writer membership.
  const grant = await apiCall(port(), `/api/agencies/${tenant.agencyId}/memberships`, {
    token: tenant.owner.token,
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));

  const denied = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: member.token,
    body: profileBody('roles-profile-1'),
  });
  assert.equal(denied.status, 403, 'members cannot write the registry');

  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('roles-profile-1'),
  });
  assert.equal(create.status, 201);

  const read = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: member.token,
  });
  assert.equal(read.status, 200, 'reads stay visible to active members');
  assert.equal((read.body['taskProfiles'] as unknown[]).length, 1);
});

test('the new-use boundary gate: a disabled Workspace refuses TaskProfile creation (409)', async () => {
  const tenant = await makeTenant('boundary');
  // Disable the workspace (owner|admin, CAS).
  const disable = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/status`, {
    method: 'PATCH',
    token: tenant.owner.token,
    body: { status: 'disabled', version: 1 },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('boundary-profile-1'),
  });
  assert.equal(create.status, 409, 'creating a TaskProfile is new use and requires an ACTIVE boundary');
});

// ---------------------------------------------------------------------------
// DB backstops — append-only history, immutability, scope chain
// ---------------------------------------------------------------------------

test('usage telemetry and model observations are append-only at the DATABASE level (UPDATE and DELETE rejected)', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('appendonly');
  const model = await registerModel();
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('appendonly-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  const telemetry = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 100,
      costAmount: 0.01,
      idempotencyKey: 'appendonly-1',
    },
  });
  assert.equal(telemetry.status, 201);
  const usageId = (telemetry.body['usageTelemetry'] as Record<string, unknown>)['usageId'] as string;

  const observation = await apiCall(port(), `/api/ai/models/${model['modelRegistryId']}/observations`, {
    token: await adminToken(),
    body: { availabilityState: 'degraded', source: 'platform-probe' },
  });
  assert.equal(observation.status, 201);
  const observationId = (observation.body['observation'] as Record<string, unknown>)['observationId'] as string;

  // Direct SQL rewrites of history are rejected by the database itself.
  await assert.rejects(
    st.pg.pool.query('UPDATE ai_usage_telemetry SET latency_ms = 999999 WHERE usage_id = $1', [usageId]),
    /append-only history/i,
    'UPDATE on usage telemetry must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('DELETE FROM ai_usage_telemetry WHERE usage_id = $1', [usageId]),
    /append-only history/i,
    'DELETE on usage telemetry must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('UPDATE ai_model_observations SET availability_state = $1 WHERE observation_id = $2', [
      'available',
      observationId,
    ]),
    /append-only history/i,
    'UPDATE on model observations must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('DELETE FROM ai_model_observations WHERE observation_id = $1', [observationId]),
    /append-only history/i,
    'DELETE on model observations must be DB-rejected',
  );
});

test('TaskProfile and model content is immutable at the DATABASE level; retired is terminal; corrections are new rows', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('immutable');
  const model = await registerModel();
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('immutable-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  await assert.rejects(
    st.pg.pool.query('UPDATE ai_task_profiles SET task_class = $1 WHERE task_profile_id = $2', [
      'hijacked.class',
      profileId,
    ]),
    /content is immutable/i,
    'rewriting the neutral contract must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('UPDATE ai_task_profiles SET max_cost_per_invocation = 0 WHERE task_profile_id = $1', [profileId]),
    /content is immutable/i,
    'rewriting the cost budget must be DB-rejected',
  );
  // Scope columns cannot be reassigned either (the identity trigger).
  await assert.rejects(
    st.pg.pool.query('UPDATE ai_task_profiles SET agency_id = $1 WHERE task_profile_id = $2', [
      '00000000-0000-4000-8000-000000000099',
      profileId,
    ]),
    /immutable|ownership/i,
    'reassigning Agency ownership must be DB-rejected',
  );

  await assert.rejects(
    st.pg.pool.query('UPDATE ai_model_registry SET cost_input_per_mtok = 0 WHERE model_registry_id = $1', [
      model['modelRegistryId'],
    ]),
    /declared signals are immutable/i,
    'rewriting declared model signals must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('UPDATE ai_model_registry SET display_name = $1 WHERE model_registry_id = $2', [
      'Hijacked',
      model['modelRegistryId'],
    ]),
    /declared signals are immutable/i,
    'rewriting the display name must be DB-rejected',
  );

  // Retire through the API, then attempt resurrection by direct SQL.
  const retire = await apiCall(port(), `/api/ai/task-profiles/${profileId}/retire`, {
    token: tenant.owner.token,
    body: { version: 1 },
  });
  assert.equal(retire.status, 200);
  await assert.rejects(
    st.pg.pool.query("UPDATE ai_task_profiles SET status = 'active' WHERE task_profile_id = $1", [profileId]),
    /retired and terminal/i,
    'resurrecting a retired profile must be DB-rejected',
  );

  const modelRetire = await apiCall(port(), `/api/ai/models/${model['modelRegistryId']}/retire`, {
    token: await adminToken(),
    body: { version: 1 },
  });
  assert.equal(modelRetire.status, 200);
  await assert.rejects(
    st.pg.pool.query("UPDATE ai_model_registry SET status = 'active' WHERE model_registry_id = $1", [
      model['modelRegistryId'],
    ]),
    /retired and terminal/i,
    'resurrecting a retired model must be DB-rejected',
  );
});

test('the scope-chain trigger blocks cross-scope telemetry rows even under direct SQL (tenant isolation backstop)', async () => {
  const { stack: st } = the();
  const tenantA = await makeTenant('scopea');
  const tenantB = await makeTenant('scopeb');
  const model = await registerModel();

  const createA = await apiCall(port(), `/api/workspaces/${tenantA.workspaceId}/ai/task-profiles`, {
    token: tenantA.owner.token,
    body: profileBody('scope-profile-a'),
  });
  assert.equal(createA.status, 201);
  const profileA = createA.body['taskProfile'] as Record<string, unknown>;

  const createB = await apiCall(port(), `/api/workspaces/${tenantB.workspaceId}/ai/task-profiles`, {
    token: tenantB.owner.token,
    body: profileBody('scope-profile-b'),
  });
  assert.equal(createB.status, 201);
  const profileB = createB.body['taskProfile'] as Record<string, unknown>;

  // A tenant-A telemetry row referencing tenant-B's profile: DB-rejected.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO ai_usage_telemetry
         (usage_id, workspace_id, client_id, agency_id, task_profile_id, model_registry_id,
          execution_id, correlation_id, outcome, latency_ms, cost_amount, idempotency_key, create_fingerprint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, 'scope-probe', 'succeeded', 1, 0, 'scope-probe-1', $6)`,
      [
        tenantA.workspaceId,
        tenantA.clientId,
        tenantA.agencyId,
        profileB['taskProfileId'],
        model['modelRegistryId'],
        'f'.repeat(64),
      ],
    ),
    /does not belong to workspace/i,
    'a foreign task-profile reference cannot be smuggled into another tenant row',
  );

  // A tenant-A telemetry row with tenant-B's Workspace scope chain:
  // DB-rejected by the workspace→client consistency check.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO ai_usage_telemetry
         (usage_id, workspace_id, client_id, agency_id, task_profile_id, model_registry_id,
          execution_id, correlation_id, outcome, latency_ms, cost_amount, idempotency_key, create_fingerprint)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NULL, 'scope-probe', 'succeeded', 1, 0, 'scope-probe-2', $6)`,
      [
        tenantA.workspaceId,
        tenantB.clientId,
        tenantA.agencyId,
        profileA['taskProfileId'],
        model['modelRegistryId'],
        'f'.repeat(64),
      ],
    ),
    /does not belong to/i,
    'an inconsistent scope chain cannot be written',
  );
});

test('duplicate TaskProfile create commands converge (§8-style fence) and key reuse conflicts', async () => {
  const tenant = await makeTenant('converge');

  const first = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('converge-key-1'),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body['replayed'], false);

  const replay = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('converge-key-1'),
  });
  assert.equal(replay.status, 200, 'a duplicate create converges with 200 replayed');
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    (replay.body['taskProfile'] as Record<string, unknown>)['taskProfileId'],
    (first.body['taskProfile'] as Record<string, unknown>)['taskProfileId'],
    'the replay converges to the SAME identity',
  );

  const conflict = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: { ...profileBody('converge-key-1'), qualityTarget: 'different-target' },
  });
  assert.equal(conflict.status, 409, 'a key reused for a different command is a conflict');
  assert.equal(
    ((conflict.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    'IDEMPOTENCY_CONFLICT',
  );

  const list = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
  });
  assert.equal((list.body['taskProfiles'] as unknown[]).length, 1, 'exactly ONE profile row exists');
});

test('material /ai-runtime mutations emit durable audit events (append-oriented audit trail)', async () => {
  const { stack: st } = the();
  const tenant = await makeTenant('audit');
  const model = await registerModel();

  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/task-profiles`, {
    token: tenant.owner.token,
    body: profileBody('audit-profile-1'),
  });
  assert.equal(create.status, 201);
  const profileId = (create.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  const telemetry = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: model['modelRegistryId'],
      outcome: 'succeeded',
      latencyMs: 100,
      costAmount: 0.01,
      idempotencyKey: 'audit-1',
    },
  });
  assert.equal(telemetry.status, 201);

  const auditRows = await st.pg.pool.query<{ action: string; target_id: string }>(
    `SELECT action, target_id FROM audit_events
      WHERE action LIKE 'ai_runtime.%' AND target_id = ANY($1) ORDER BY occurred_at`,
    [[profileId, model['modelRegistryId'], telemetry.body['usageTelemetry'] !== undefined ? ((telemetry.body['usageTelemetry'] as Record<string, unknown>)['usageId'] as string) : null]],
  );
  const actions = auditRows.rows.map((row) => row.action);
  assert.ok(actions.includes('ai_runtime.task_profile.created'), 'the profile creation is audited');
  assert.ok(actions.includes('ai_runtime.model.registered'), 'the model registration is audited');
  assert.ok(actions.includes('ai_runtime.usage_telemetry.appended'), 'the telemetry append is audited');
});
