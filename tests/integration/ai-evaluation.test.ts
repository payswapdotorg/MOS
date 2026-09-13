/**
 * MKT-019 integration tests — the AI Runtime EVALUATION surfaces on the
 * real stack (embedded PostgreSQL 18 — real DB, no mocks of platform
 * services).
 *
 * Acceptance mapping (work-items.md MKT-019 = AI-003 / AI-AC-08 + the
 * evaluator regression matrix):
 *   - TASK-LEVEL EVALUATORS: the evaluator registry (register/list/read/
 *     retire with the ACTIVE-key fence, platform-admin RBAC), evaluation
 *     runs DERIVED from the TaskProfile's evaluator contract (the caller
 *     cannot select evaluators), built-in deterministic outcomes recorded
 *     as append-only §12 rows, caller-supplied ENGINES for the
 *     model-judge kinds (module-level composition — the API surface runs
 *     built-ins only);
 *   - EXECUTION-LINKED QUALITY TELEMETRY: evaluation records reference a
 *     same-Workspace Execution (server-side provenance — a foreign
 *     execution is a uniform 404) and the usage-telemetry row (the §24
 *     evaluator-outcome link, now wired: a telemetry evaluationRef must
 *     reference a REAL evaluation of the SAME Workspace);
 *   - HUMAN-REVIEW HOOKS: review-request records (pending → approved/
 *     rejected/dismissed, append-only transitions, exactly-once decision,
 *     terminal states) linked to execution/evaluation context;
 *   - AI-AC-08 (integration half): business-outcome-shaped request keys
 *     are 422s on every evaluation/review surface;
 *   - negative tests: caller-controlled provenance/outcomes rejected
 *     (422); cross-client/cross-workspace traversal rejected (uniform
 *     404); rewrite of an evaluation record rejected (DB append-only
 *     trigger); credential-shaped keys rejected (422); §8-style
 *     idempotency convergence (200 replayed / 409 different payload).
 *
 * The engine-based evaluation (factuality-grounding model judge) is
 * tested through the MODULE directly in-process (the engine is a
 * function, never an HTTP input — the same posture as the routing
 * adapter in ai-routing.test.ts).
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
import type { AiRuntimeModuleApi, EvaluationResultPayload } from '../../src/modules/ai-runtime/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;
let db: PgDb | null = null;
let aiRuntime: AiRuntimeModuleApi | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function theDb(): PgDb {
  if (db === null) throw new Error('db not constructed');
  return db;
}

function theModule(): AiRuntimeModuleApi {
  if (aiRuntime === null) throw new Error('module not constructed');
  return aiRuntime;
}

before(async () => {
  stack = await bootStack('aievaluation');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PASSWORD_MISMATCH_GUARD: 'unused',
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  } as Record<string, string>);
  db = new PgDb(stack.env.databaseUrl, 2);
  // Construct the module directly in the test process (connected to the
  // same embedded PG) so we can call evaluateTask with a caller-supplied
  // ENGINE (a function — never an HTTP input, the same posture as the
  // routing adapter). The API server has its OWN module instance; the two
  // share the same DB.
  aiRuntime = createAiRuntimeModule({
    db,
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    // The engine-based tests pass executionId: null, so a minimal
    // executions fake satisfies the dep (the execution-LINKAGE tests run
    // through the API server, which composes the REAL executions module).
    executions: {
      getExecution: async () => null,
      recordStart: async () => null,
      recordCompletion: async () => null,
      recordReconciliation: async () => null,
      recordSandboxLease: async () => null,
      listExecutions: async () => [],
      resolveExecutionOwnership: async () => null,
    } as unknown as Parameters<typeof createAiRuntimeModule>[0]['executions'],
    // The engine-based tests cite no evidence, so a minimal evidence fake
    // satisfies the dep (citation validation runs through the API server,
    // which composes the REAL evidence module).
    evidence: {
      appendEvidence: async () => {
        throw new Error('not used in this test');
      },
      getEvidence: async () => null,
      resolveEvidenceOwnership: async () => null,
      listEvidenceForClient: async () => [],
    } as unknown as Parameters<typeof createAiRuntimeModule>[0]['evidence'],
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (db !== null) {
    await db.close();
    db = null;
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

/** A fully valid §10 TaskProfile request body with configurable evaluatorIds. */
function profileBody(idempotencyKey: string, evaluatorIds: readonly string[] = ['brand-voice-rubric']): Record<string, unknown> {
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
    evaluatorIds,
    escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
    idempotencyKey,
  };
}

let evaluatorCounter = 0;

/** Registers an evaluator as the platform administrator and returns the record. */
async function registerEvaluator(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  evaluatorCounter += 1;
  const body = {
    evaluatorKey: `matrix-evaluator-${evaluatorCounter}`,
    displayName: `Matrix Evaluator ${evaluatorCounter}`,
    kind: 'schema-validity',
    evaluatorVersion: 1,
    config: {},
    ...overrides,
  };
  const response = await apiCall(port(), '/api/ai/evaluators', {
    token: await adminToken(),
    body,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as Record<string, unknown>;
}

/**
 * A per-test UNIQUE evaluator key base: the evaluator registry is
 * PLATFORM-level data shared by every tenant in this database, so two
 * tests registering the same key collide on the ACTIVE-key fence. Every
 * test registers its own uniquely-suffixed evaluator and references it
 * from its TaskProfile's evaluator contract.
 */
let uniqueKeySeq = 0;
function uniqueEvaluatorKey(base: string): string {
  uniqueKeySeq += 1;
  return `${base}-${uniqueKeySeq}`;
}

/** Creates a TaskProfile through the API and returns its record. */
async function createTaskProfile(
  workspaceId: string,
  token: string,
  idempotencyKey: string,
  evaluatorIds: readonly string[] = ['brand-voice-rubric'],
): Promise<Record<string, unknown>> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/ai/task-profiles`, {
    token,
    body: profileBody(idempotencyKey, evaluatorIds),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body as Record<string, unknown>)['taskProfile'] as Record<string, unknown>;
}

/** Runs one evaluation through the API (built-in evaluators only). */
async function runEvaluation(
  workspaceId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/workspaces/${workspaceId}/ai/evaluations`, { token, body });
}

/** Creates an AI-kind execution in the workspace through the API. */
async function createExecution(workspaceId: string, token: string, idempotencyKey: string): Promise<string> {
  const execution = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      workflowInstanceId: '00000000-0000-7000-8000-0000000000e1',
      nodeId: `node-${idempotencyKey}`,
      executionKind: 'ai',
      runtimeClass: 'pooled-worker',
      idempotencyKey,
    },
  });
  assert.equal(execution.status, 201, JSON.stringify(execution.body));
  return (execution.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

// ---------------------------------------------------------------------------
// Evaluator registry — RBAC, fences, lifecycle
// ---------------------------------------------------------------------------

test('evaluator registration is platform-administrator territory (403 for tenant users)', async () => {
  const tenant = await makeTenant('evalrbac');
  const register = await apiCall(port(), '/api/ai/evaluators', {
    token: tenant.owner.token,
    body: {
      evaluatorKey: 'unauthorized-evaluator',
      displayName: 'Unauthorized',
      kind: 'schema-validity',
      evaluatorVersion: 1,
      config: {},
    },
  });
  assert.equal(register.status, 403);
});

test('the evaluator ACTIVE-key fence: a duplicate ACTIVE key is a 409; a retired key re-registers as a NEW identity', async () => {
  const first = await registerEvaluator({ evaluatorKey: 'fenced-evaluator' });
  const duplicate = await apiCall(port(), '/api/ai/evaluators', {
    token: await adminToken(),
    body: {
      evaluatorKey: 'fenced-evaluator',
      displayName: 'Duplicate',
      kind: 'schema-validity',
      evaluatorVersion: 2,
      config: {},
    },
  });
  assert.equal(duplicate.status, 409);

  // Retire the first (CAS), then re-register the freed key.
  const retire = await apiCall(port(), `/api/ai/evaluators/${first['evaluatorRegistryId']}/retire`, {
    token: await adminToken(),
    body: { version: first['version'] },
  });
  assert.equal(retire.status, 200);
  assert.equal((retire.body as Record<string, unknown>)['status'], 'retired');

  const reborn = await apiCall(port(), '/api/ai/evaluators', {
    token: await adminToken(),
    body: {
      evaluatorKey: 'fenced-evaluator',
      displayName: 'Reborn',
      kind: 'schema-validity',
      evaluatorVersion: 2,
      config: {},
    },
  });
  assert.equal(reborn.status, 201);
  assert.notEqual((reborn.body as Record<string, unknown>)['evaluatorRegistryId'], first['evaluatorRegistryId']);

  // The retired entry left the ACTIVE catalog but stays readable by id.
  const catalog = await apiCall(port(), '/api/ai/evaluators', { token: await adminToken() });
  const activeKeys = ((catalog.body as Record<string, unknown>)['evaluators'] as ReadonlyArray<Record<string, unknown>>).map(
    (entry) => entry['evaluatorKey'],
  );
  // 'fenced-evaluator' appears ONCE (the reborn ACTIVE entry), never twice.
  assert.equal(activeKeys.filter((k) => k === 'fenced-evaluator').length, 1);
  const readRetired = await apiCall(port(), `/api/ai/evaluators/${first['evaluatorRegistryId']}`, {
    token: await adminToken(),
  });
  assert.equal(readRetired.status, 200);

  // Retiring a retired (terminal) evaluator is a 409.
  const reRetire = await apiCall(port(), `/api/ai/evaluators/${first['evaluatorRegistryId']}/retire`, {
    token: await adminToken(),
    body: { version: 2 },
  });
  assert.equal(reRetire.status, 409);
});

// ---------------------------------------------------------------------------
// Task-level evaluators — the evaluation run derived from the TaskProfile
// ---------------------------------------------------------------------------

test('evaluateTask records the §12 outcome rows derived from the TaskProfile evaluator contract (real PG)', async () => {
  const tenant = await makeTenant('evalrun');
  // Two evaluators: a domain-rubric builtin + a schema-validity builtin.
  const rubricKey = uniqueEvaluatorKey('brand-voice-rubric');
  const schemaKey = uniqueEvaluatorKey('schema-validity');
  await registerEvaluator({
    evaluatorKey: rubricKey,
    kind: 'domain-rubric',
    config: { dimensions: [{ field: 'wordCount', min: 10, max: 80 }] },
  });
  await registerEvaluator({ evaluatorKey: schemaKey, kind: 'schema-validity' });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'evalrun-profile-1', [
    rubricKey,
    schemaKey,
  ]);
  const profileId = profile['taskProfileId'] as string;

  const run = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'Summer Sale', wordCount: 42 },
    idempotencyKey: 'evalrun-1',
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  assert.equal(run.body['replayed'], false);
  const evaluations = run.body['evaluations'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(evaluations.length, 2, 'every evaluator in the profile contract records one outcome row');

  const byKey = new Map(evaluations.map((e) => [e['evaluatorId'] as string, e]));
  const rubric = byKey.get(rubricKey)!;
  const schema = byKey.get(schemaKey)!;

  // The §12 payload: evaluatorId + evaluatorVersion + verdict + score +
  // dimensions + uncertainty.
  assert.equal(rubric['evaluatorVersion'], 1);
  assert.equal(rubric['verdict'], 'pass');
  assert.equal(rubric['score'], 1);
  assert.ok(Array.isArray(rubric['dimensions']));
  assert.equal((rubric['dimensions'] as ReadonlyArray<Record<string, unknown>>).length, 1);
  assert.equal(schema['verdict'], 'pass');
  assert.equal(schema['score'], 1);
  // The rows are append-only history — the direct-SQL proof is below.
  // The correlation identity is server-derived.
  assert.ok(typeof rubric['correlationId'] === 'string' && (rubric['correlationId'] as string).length >= 1);

  // The evaluation records are readable by id and listed per workspace.
  const readOne = await apiCall(port(), `/api/ai/evaluations/${rubric['evaluationId']}`, {
    token: tenant.owner.token,
  });
  assert.equal(readOne.status, 200);
  assert.equal((readOne.body as Record<string, unknown>)['evaluatorId'], rubricKey);
  const list = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/evaluations`, {
    token: tenant.owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal(((list.body as Record<string, unknown>)['evaluations'] as unknown[]).length, 2);
});

test('the evaluation request CANNOT select evaluators, fabricate outcomes, or carry business outcomes/credentials (422)', async () => {
  const tenant = await makeTenant('evalneg');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'domain-rubric', config: {} });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'evalneg-profile-1', [evaluatorKey]);
  const profileId = profile['taskProfileId'] as string;

  for (const forbidden of [
    { evaluatorIds: ['some-other-evaluator'] },
    { verdict: 'pass' },
    { score: 1 },
    { dimensions: [] },
    { evidenceRefs: [] },
    { uncertaintyOrLimitations: 'none' },
    { metricId: '00000000-0000-4000-8000-000000000000' },
    { kpiId: '00000000-0000-4000-8000-000000000000' },
    { experimentId: '00000000-0000-4000-8000-000000000000' },
    { businessOutcomeId: '00000000-0000-4000-8000-000000000000' },
    { lift: 0.2 },
    { provider: 'openai' },
    { model: 'gpt-x' },
    { apiKey: 'sk-secret' },
    { correlationId: 'caller-supplied' },
    { evaluationId: '00000000-0000-4000-8000-000000000000' },
    { createdBy: '00000000-0000-4000-8000-000000000000' },
  ]) {
    const attempt = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
      taskProfileId: profileId,
      output: { headline: 'x' },
      idempotencyKey: `evalneg-${JSON.stringify(forbidden).slice(0, 24)}`,
      ...forbidden,
    });
    assert.equal(attempt.status, 422, `the evaluation request must reject the forbidden key ${JSON.stringify(forbidden)} (got ${attempt.status})`);
  }
});

test('an unresolvable evaluator key in the TaskProfile contract is a uniform 404 (no unsatisfiable half-evaluation)', async () => {
  const tenant = await makeTenant('evalunknown');
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'evalunknown-profile-1', [
    'never-registered-evaluator',
  ]);
  const run = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profile['taskProfileId'] as string,
    output: { headline: 'x' },
    idempotencyKey: 'evalunknown-1',
  });
  assert.equal(run.status, 404);
});

test('the §8-style evaluation fence: same key + same payload converges (200 replayed, SAME rows); different payload is a 409', async () => {
  const tenant = await makeTenant('evalconv');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'evalconv-profile-1', [evaluatorKey]);
  const profileId = profile['taskProfileId'] as string;

  const first = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'Summer Sale' },
    idempotencyKey: 'evalconv-1',
  });
  assert.equal(first.status, 201);

  const replay = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'Summer Sale' },
    idempotencyKey: 'evalconv-1',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  const firstIds = (first.body['evaluations'] as ReadonlyArray<Record<string, unknown>>).map((e) => e['evaluationId']);
  const replayIds = (replay.body['evaluations'] as ReadonlyArray<Record<string, unknown>>).map((e) => e['evaluationId']);
  assert.deepEqual([...replayIds].sort(), [...firstIds].sort(), 'the replay converges to the SAME row identities');

  // The same key with a DIFFERENT payload (an output that records a
  // DIFFERENT outcome — the schema fails) is a conflict, never an
  // overwrite. (The §8-style fingerprint covers the RECORDED outcome: two
  // different outputs recording identical outcomes converge — the fence
  // protects the recorded history, which is identical.)
  const conflict = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { wrongField: 'no headline' },
    idempotencyKey: 'evalconv-1',
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    ((conflict.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    'IDEMPOTENCY_CONFLICT',
  );

  // ONE row per evaluator in the DB — the replay created no second rows.
  const rows = await theDb().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ai_evaluations WHERE workspace_id = $1',
    [tenant.workspaceId],
  );
  assert.equal(Number(rows.rows[0]?.count), 1);
});

// ---------------------------------------------------------------------------
// Execution-linked quality telemetry (AI-003 core)
// ---------------------------------------------------------------------------

test('evaluation records reference a same-Workspace Execution (server-side provenance); a foreign execution is a uniform 404', async () => {
  const tenant = await makeTenant('evallink');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'evallink-profile-1', [evaluatorKey]);
  const profileId = profile['taskProfileId'] as string;

  // A genuine AI-kind execution in the SAME workspace is a valid link.
  const executionId = await createExecution(tenant.workspaceId, tenant.owner.token, 'evallink-exec-1');
  const linked = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    executionId,
    output: { headline: 'Summer Sale' },
    idempotencyKey: 'evallink-1',
  });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  const record = (linked.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!;
  assert.equal(record['executionId'], executionId, 'the evaluation record references the Execution');

  // A FOREIGN workspace's execution is a uniform 404 (no traversal oracle).
  const other = await makeTenant('evallink2');
  const foreignExecutionId = await createExecution(other.workspaceId, other.owner.token, 'evallink-exec-2');
  const foreignLink = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    executionId: foreignExecutionId,
    output: { headline: 'Summer Sale' },
    idempotencyKey: 'evallink-2',
  });
  assert.equal(foreignLink.status, 404, 'a foreign execution reference is indistinguishable from an unknown one');

  // A FOREIGN TaskProfile is a uniform 404 too.
  const foreignProfile = await createTaskProfile(other.workspaceId, other.owner.token, 'evallink-profile-2');
  const foreignProfileRun = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: foreignProfile['taskProfileId'] as string,
    output: { headline: 'x' },
    idempotencyKey: 'evallink-3',
  });
  assert.equal(foreignProfileRun.status, 404);
});

test('the usage-telemetry link: an evaluation references the usage row it judges; a foreign usage row is a 404; the telemetry evaluationRef must be REAL (MKT-019 wiring)', async () => {
  const tenant = await makeTenant('usagelink');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const modelCounterFix = Date.now();
  const model = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel: `usagelink-labs-${modelCounterFix}`,
      modelKey: `usagelink-model-${modelCounterFix}`,
      displayName: 'UsageLink Model',
      capabilities: ['text-generation'],
      toolFeatures: [],
      contextLimitTokens: 128_000,
    },
  });
  assert.equal(model.status, 201);
  const modelId = (model.body as Record<string, unknown>)['modelRegistryId'] as string;

  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'usagelink-profile-1', [evaluatorKey]);
  const profileId = profile['taskProfileId'] as string;

  // 1. The invocation happens → the usage telemetry row is appended
  //    (evaluationRef: null — the evaluation has not run yet).
  const usage = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: modelId,
      outcome: 'succeeded',
      latencyMs: 800,
      costAmount: 0.01,
      idempotencyKey: 'usagelink-usage-1',
    },
  });
  assert.equal(usage.status, 201, JSON.stringify(usage.body));
  const usageId = (usage.body['usageTelemetry'] as Record<string, unknown>)['usageId'] as string;

  // 2. The evaluation runs, linked to the usage row (the §24
  //    evaluator-outcome backlink).
  const evaluation = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    usageId,
    output: { headline: 'Summer Sale' },
    idempotencyKey: 'usagelink-eval-1',
  });
  assert.equal(evaluation.status, 201, JSON.stringify(evaluation.body));
  const evaluationRecord = (evaluation.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!;
  assert.equal(evaluationRecord['usageId'], usageId, 'the evaluation record references the usage telemetry row');
  const evaluationId = evaluationRecord['evaluationId'] as string;

  // 3. A LATER telemetry append references the evaluation through the
  //    now-wired evaluationRef (validated: REAL evaluation, same
  //    workspace).
  const followUp = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: modelId,
      outcome: 'succeeded',
      latencyMs: 600,
      costAmount: 0.008,
      evaluationRef: evaluationId,
      idempotencyKey: 'usagelink-usage-2',
    },
  });
  assert.equal(followUp.status, 201, 'a REAL evaluation reference is accepted — the evaluator-outcome link is wired');

  // 4. A FABRICATED evaluation reference is a uniform 404 (never recorded).
  const fabricated = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/usage-telemetry`, {
    token: tenant.owner.token,
    body: {
      taskProfileId: profileId,
      modelRegistryId: modelId,
      outcome: 'succeeded',
      latencyMs: 600,
      costAmount: 0.008,
      evaluationRef: 'eval:brand-voice-rubric:run-42',
      idempotencyKey: 'usagelink-usage-3',
    },
  });
  assert.equal(fabricated.status, 404, 'a fabricated evaluationRef is rejected — the placeholder is now a validated reference');

  // 5. A FOREIGN workspace's evaluation is a uniform 404.
  const other = await makeTenant('usagelink2');
  const foreignUsage = await apiCall(port(), `/api/workspaces/${other.workspaceId}/ai/usage-telemetry`, {
    token: other.owner.token,
    body: {
      taskProfileId: (await createTaskProfile(other.workspaceId, other.owner.token, 'usagelink-profile-2'))['taskProfileId'],
      modelRegistryId: modelId,
      outcome: 'succeeded',
      latencyMs: 800,
      costAmount: 0.01,
      idempotencyKey: 'usagelink-usage-4',
    },
  });
  assert.equal(foreignUsage.status, 201);
  const foreignUsageId = (foreignUsage.body['usageTelemetry'] as Record<string, unknown>)['usageId'] as string;
  const foreignUsageLink = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    usageId: foreignUsageId,
    output: { headline: 'x' },
    idempotencyKey: 'usagelink-eval-2',
  });
  assert.equal(foreignUsageLink.status, 404, 'a foreign usage reference is indistinguishable from an unknown one');
});

// ---------------------------------------------------------------------------
// Evidence citation validation (the /evidence authority — MKT-013 composed)
// ---------------------------------------------------------------------------

test('evaluation evidence citations are validated through the /evidence authority (real citations pass; fabricated/foreign ones 404)', async () => {
  const tenant = await makeTenant('cite');

  // Real evidence in the SAME client (created FIRST — the citation
  // evaluator's config declares it as the expected reference).
  const evidence = await apiCall(port(), `/api/clients/${tenant.clientId}/evidence`, {
    token: tenant.owner.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'meta-ads',
      sourceRef: 'report/2026-02-01',
      observedAt: '2026-02-01T10:30:00.000Z',
      content: { metric: 'spend', value: 99.5, currency: 'USD' },
      quality: 'D',
    },
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  const evidenceId = (evidence.body as Record<string, unknown>)['evidenceId'] as string;

  // The citation evaluator expects exactly that reference.
  const citationKey = uniqueEvaluatorKey('citation-evaluator');
  await registerEvaluator({
    evaluatorKey: citationKey,
    kind: 'evidence-citation-coverage',
    config: { expectedEvidenceRefs: [evidenceId], coverageThreshold: 1 },
  });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'cite-profile-1', [
    citationKey,
  ]);
  const profileId = profile['taskProfileId'] as string;

  // The citations from the output are recorded as the evaluation's
  // evidence refs — and every one is validated module-side.
  const run = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'x', evidenceRefs: [evidenceId] },
    idempotencyKey: 'cite-1',
  });
  assert.equal(run.status, 201, JSON.stringify(run.body));
  const record = (run.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!;
  assert.equal(record['verdict'], 'pass', 'full citation coverage passes');
  assert.deepEqual(record['evidenceRefs'], [evidenceId], 'the REAL citation is validated and recorded');

  // A FABRICATED citation is a uniform 404 — the module never records
  // references it cannot honor through the /evidence authority.
  const fabricated = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'x', evidenceRefs: ['made-up-evidence-ref'] },
    idempotencyKey: 'cite-2',
  });
  assert.equal(fabricated.status, 404, 'a fabricated evidence citation is rejected');

  // A FOREIGN client's evidence is a uniform 404.
  const other = await makeTenant('cite2');
  const foreignEvidence = await apiCall(port(), `/api/clients/${other.clientId}/evidence`, {
    token: other.owner.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'meta-ads',
      sourceRef: 'report/2026-02-02',
      observedAt: '2026-02-02T10:30:00.000Z',
      content: { metric: 'spend', value: 1.5, currency: 'USD' },
      quality: 'D',
    },
  });
  assert.equal(foreignEvidence.status, 201);
  const foreignEvidenceId = (foreignEvidence.body as Record<string, unknown>)['evidenceId'] as string;
  const foreignCitation = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profileId,
    output: { headline: 'x', evidenceRefs: [foreignEvidenceId] },
    idempotencyKey: 'cite-3',
  });
  assert.equal(foreignCitation.status, 404, 'a foreign Client\'s evidence citation is indistinguishable from an unknown one');
});

// ---------------------------------------------------------------------------
// Human-review hook — records intent/outcome, never executes
// ---------------------------------------------------------------------------

test('the review-request hook: pending → approved with an append-only transition; a second decision is a terminal 409', async () => {
  const tenant = await makeTenant('review');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'review-profile-1', [evaluatorKey]);
  const executionId = await createExecution(tenant.workspaceId, tenant.owner.token, 'review-exec-1');
  const evaluation = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profile['taskProfileId'] as string,
    executionId,
    output: { wrongField: 'no headline' },
    idempotencyKey: 'review-eval-1',
  });
  assert.equal(evaluation.status, 201);
  const evaluationId = (evaluation.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['evaluationId'] as string;

  // Record the review intent (linked to the execution AND the evaluation).
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: {
      executionId,
      evaluationId,
      reason: 'schema-validity evaluator failed — human review required',
      idempotencyKey: 'review-1',
    },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const request = create.body['reviewRequest'] as Record<string, unknown>;
  assert.equal(request['state'], 'pending');
  assert.equal(request['executionId'], executionId);
  assert.equal(request['evaluationId'], evaluationId);
  assert.equal(request['decidedBy'], undefined, 'no decision fields exist on a pending request');
  assert.deepEqual(request['transitions'], []);

  // Duplicate delivery of the SAME logical create converges.
  const replay = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: {
      executionId,
      evaluationId,
      reason: 'schema-validity evaluator failed — human review required',
      idempotencyKey: 'review-1',
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    (replay.body['reviewRequest'] as Record<string, unknown>)['reviewRequestId'],
    request['reviewRequestId'],
  );

  // The human acts (through /jobs — outside this module's authority) and
  // the OUTCOME is recorded: approve.
  const decide = await apiCall(port(), `/api/ai/review-requests/${request['reviewRequestId']}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'approve', note: 'headline acceptable after human edit' },
  });
  assert.equal(decide.status, 200, JSON.stringify(decide.body));
  const decided = decide.body as Record<string, unknown>;
  assert.equal(decided['state'], 'approved');
  assert.equal(decided['decidedBy'], tenant.owner.userId, 'the deciding human is the server-derived actor');
  assert.ok(typeof decided['decidedAt'] === 'string');
  const transitions = decided['transitions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(transitions.length, 1, 'the decision appended EXACTLY ONE transition row');
  assert.equal(transitions[0]!['fromState'], 'pending');
  assert.equal(transitions[0]!['toState'], 'approved');
  assert.equal(transitions[0]!['decidedBy'], tenant.owner.userId);

  // A second decision (same or different) is a terminal 409 — the
  // decision is append-only history.
  const second = await apiCall(port(), `/api/ai/review-requests/${request['reviewRequestId']}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'dismiss', note: 'changed my mind' },
  });
  assert.equal(second.status, 409);

  // The state filter surfaces the terminal state.
  const listModule = await theModule().listReviewRequests(tenant.workspaceId, 'approved', 500);
  assert.ok(listModule.some((r) => r.reviewRequestId === request['reviewRequestId']));
  const listPending = await theModule().listReviewRequests(tenant.workspaceId, 'pending', 500);
  assert.ok(!listPending.some((r) => r.reviewRequestId === request['reviewRequestId']));
});

test('the review-request hook: reject and dismiss decisions land in their terminal states; a foreign review request is a uniform 404', async () => {
  const tenant = await makeTenant('review2');

  const create = async (key: string): Promise<string> => {
    const response = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
      token: tenant.owner.token,
      body: { reason: `uncertain evaluation ${key}`, idempotencyKey: key },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return (response.body['reviewRequest'] as Record<string, unknown>)['reviewRequestId'] as string;
  };

  const rejectId = await create('review2-reject');
  const reject = await apiCall(port(), `/api/ai/review-requests/${rejectId}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'reject', note: 'off-brand' },
  });
  assert.equal(reject.status, 200);
  assert.equal((reject.body as Record<string, unknown>)['state'], 'rejected');

  const dismissId = await create('review2-dismiss');
  const dismiss = await apiCall(port(), `/api/ai/review-requests/${dismissId}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'dismiss', note: '' },
  });
  assert.equal(dismiss.status, 200);
  assert.equal((dismiss.body as Record<string, unknown>)['state'], 'dismissed');
  assert.equal((dismiss.body as Record<string, unknown>)['decisionNote'], undefined, 'an empty note is recorded as null');

  // A FOREIGN workspace's review request is a uniform 404 on read and
  // decide (no traversal oracle).
  const other = await makeTenant('review3');
  const foreignCreate = await apiCall(port(), `/api/workspaces/${other.workspaceId}/ai/review-requests`, {
    token: other.owner.token,
    body: { reason: 'foreign review', idempotencyKey: 'review3-foreign' },
  });
  assert.equal(foreignCreate.status, 201);
  const foreignId = (foreignCreate.body['reviewRequest'] as Record<string, unknown>)['reviewRequestId'] as string;
  const foreignRead = await apiCall(port(), `/api/ai/review-requests/${foreignId}`, {
    token: tenant.owner.token,
  });
  assert.equal(foreignRead.status, 404);
  const foreignDecide = await apiCall(port(), `/api/ai/review-requests/${foreignId}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'approve', note: 'nope' },
  });
  assert.equal(foreignDecide.status, 404);
});

test('the review-request create rejects lifecycle/decision/outcome/credential keys (422) and foreign context links (404)', async () => {
  const tenant = await makeTenant('reviewneg');
  for (const forbidden of [
    { state: 'approved' },
    { decidedBy: '00000000-0000-4000-8000-000000000000' },
    { decidedAt: '2026-01-01T00:00:00.000Z' },
    { decisionNote: 'pre-decided' },
    { metricId: '00000000-0000-4000-8000-000000000000' },
    { experimentId: '00000000-0000-4000-8000-000000000000' },
    { businessOutcomeId: '00000000-0000-4000-8000-000000000000' },
    { apiKey: 'sk-secret' },
    { token: 'bearer-forgery' },
    { correlationId: 'caller-supplied' },
  ]) {
    const attempt = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
      token: tenant.owner.token,
      body: { reason: 'x', idempotencyKey: `reviewneg-${JSON.stringify(forbidden).slice(0, 24)}`, ...forbidden },
    });
    assert.equal(attempt.status, 422, `the review-request create must reject ${JSON.stringify(forbidden)} (got ${attempt.status})`);
  }

  // A foreign execution link is a uniform 404.
  const other = await makeTenant('reviewneg2');
  const foreignExecutionId = await createExecution(other.workspaceId, other.owner.token, 'reviewneg-exec');
  const foreignLink = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: { executionId: foreignExecutionId, reason: 'x', idempotencyKey: 'reviewneg-link' },
  });
  assert.equal(foreignLink.status, 404);

  // A foreign evaluation link is a uniform 404 (the other tenant needs its
  // own evaluator registered for the evaluation to run at all).
  const foreignEvaluatorKey = uniqueEvaluatorKey('reviewneg-evaluator');
  await registerEvaluator({ evaluatorKey: foreignEvaluatorKey, kind: 'schema-validity', config: {} });
  const foreignEval = await runEvaluation(other.workspaceId, other.owner.token, {
    taskProfileId: (await createTaskProfile(other.workspaceId, other.owner.token, 'reviewneg-profile', [foreignEvaluatorKey]))['taskProfileId'] as string,
    output: { headline: 'x' },
    idempotencyKey: 'reviewneg-eval',
  });
  assert.equal(foreignEval.status, 201, JSON.stringify(foreignEval.body));
  const foreignEvaluationId = (foreignEval.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['evaluationId'] as string;
  const foreignEvalLink = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: { evaluationId: foreignEvaluationId, reason: 'x', idempotencyKey: 'reviewneg-eval-link' },
  });
  assert.equal(foreignEvalLink.status, 404);
});

// ---------------------------------------------------------------------------
// Caller-supplied engines (model-judge kinds) — module-level composition
// ---------------------------------------------------------------------------

test('evaluateTask with a caller-supplied ENGINE records the model-judge outcome verbatim (advisory evidence)', async () => {
  const tenant = await makeTenant('engine');
  // Register the model-judge evaluator (factuality-grounding has NO
  // built-in — the engine is REQUIRED).
  const judge = await apiCall(port(), '/api/ai/evaluators', {
    token: await adminToken(),
    body: {
      evaluatorKey: 'factuality-judge-engine',
      displayName: 'Factuality Judge',
      kind: 'factuality-grounding',
      evaluatorVersion: 1,
      config: {},
    },
  });
  assert.equal(judge.status, 201, JSON.stringify(judge.body));
  const judgeId = (judge.body as Record<string, unknown>)['evaluatorRegistryId'] as string;

  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'engine-profile-1', [
    'factuality-judge-engine',
  ]);
  const ownership = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}`, {
    token: tenant.owner.token,
    method: 'GET',
  });
  void ownership;

  const outcome = await theModule().evaluateTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: profile['taskProfileId'] as string,
    executionId: null,
    usageId: null,
    output: { headline: 'Claims grounded in cited sources' },
    adapterError: null,
    engines: {
      'factuality-judge-engine': async (): Promise<EvaluationResultPayload> => ({
        verdict: 'pass',
        score: 0.83,
        dimensions: [
          { dimension: 'claim-grounding', verdict: 'pass', score: 0.83, notes: '5 of 6 claims grounded' },
        ],
        evidenceRefs: [],
        uncertaintyOrLimitations: 'model-judge advisory opinion — recorded as produced',
      }),
    },
    idempotencyKey: 'engine-1',
    correlationId: '11111111-1111-4111-8111-111111111111',
    actorId: tenant.owner.userId,
  });
  assert.equal(outcome.replayed, false);
  assert.equal(outcome.evaluations.length, 1);
  const record = outcome.evaluations[0]!;
  assert.equal(record.evaluatorRegistryId, judgeId);
  assert.equal(record.evaluatorKey, 'factuality-judge-engine');
  assert.equal(record.verdict, 'pass');
  assert.equal(record.score, 0.83);
  assert.equal(record.dimensions.length, 1);
  assert.equal(record.dimensions[0]!.dimension, 'claim-grounding');
  assert.equal(record.uncertaintyOrLimitations, 'model-judge advisory opinion — recorded as produced');

  // Replay through the MODULE converges too.
  const replay = await theModule().evaluateTask({
    workspaceId: tenant.workspaceId,
    clientId: tenant.clientId,
    agencyId: tenant.agencyId,
    taskProfileId: profile['taskProfileId'] as string,
    executionId: null,
    usageId: null,
    output: { headline: 'Claims grounded in cited sources' },
    adapterError: null,
    engines: {
      'factuality-judge-engine': async (): Promise<EvaluationResultPayload> => ({
        verdict: 'pass',
        score: 0.83,
        dimensions: [
          { dimension: 'claim-grounding', verdict: 'pass', score: 0.83, notes: '5 of 6 claims grounded' },
        ],
        evidenceRefs: [],
        uncertaintyOrLimitations: 'model-judge advisory opinion — recorded as produced',
      }),
    },
    idempotencyKey: 'engine-1',
    correlationId: '22222222-2222-4222-8222-222222222222',
    actorId: tenant.owner.userId,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluations[0]!.evaluationId, record.evaluationId);
});

test('evaluateTask without an engine for a model-judge kind is a ConflictError (never a silent half-evaluation)', async () => {
  const tenant = await makeTenant('noengine');
  const judge = await apiCall(port(), '/api/ai/evaluators', {
    token: await adminToken(),
    body: {
      evaluatorKey: 'factuality-judge-noengine',
      displayName: 'Factuality Judge',
      kind: 'factuality-grounding',
      evaluatorVersion: 1,
      config: {},
    },
  });
  assert.equal(judge.status, 201);
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'noengine-profile-1', [
    'factuality-judge-noengine',
  ]);
  await assert.rejects(
    theModule().evaluateTask({
      workspaceId: tenant.workspaceId,
      clientId: tenant.clientId,
      agencyId: tenant.agencyId,
      taskProfileId: profile['taskProfileId'] as string,
      executionId: null,
      usageId: null,
      output: { headline: 'x' },
      adapterError: null,
      idempotencyKey: 'noengine-1',
      correlationId: '33333333-3333-4333-8333-333333333333',
      actorId: tenant.owner.userId,
    }),
    /no evaluator implementation available/,
  );
});

// ---------------------------------------------------------------------------
// DB backstops — append-only history, terminal states, scope chains
// ---------------------------------------------------------------------------

test('the DB rejects rewrites of evaluation history (append-only trigger) and review transitions', async () => {
  const tenant = await makeTenant('dbbackstop');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const profile = await createTaskProfile(tenant.workspaceId, tenant.owner.token, 'dbbackstop-profile-1', [evaluatorKey]);
  const evaluation = await runEvaluation(tenant.workspaceId, tenant.owner.token, {
    taskProfileId: profile['taskProfileId'] as string,
    output: { headline: 'x' },
    idempotencyKey: 'dbbackstop-eval-1',
  });
  assert.equal(evaluation.status, 201);
  const evaluationId = (evaluation.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['evaluationId'] as string;

  // UPDATE on an evaluation record is DB-rejected (append-only history).
  await assert.rejects(
    theDb().query("UPDATE ai_evaluations SET verdict = 'pass' WHERE evaluation_id = $1", [evaluationId]),
    /append-only history/,
  );
  // DELETE is DB-rejected too.
  await assert.rejects(
    theDb().query('DELETE FROM ai_evaluations WHERE evaluation_id = $1', [evaluationId]),
    /append-only history/,
  );

  // The review transition history is append-only.
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: { reason: 'x', idempotencyKey: 'dbbackstop-review-1' },
  });
  assert.equal(create.status, 201);
  const reviewRequestId = (create.body['reviewRequest'] as Record<string, unknown>)['reviewRequestId'] as string;
  const decide = await apiCall(port(), `/api/ai/review-requests/${reviewRequestId}/decide`, {
    token: tenant.owner.token,
    body: { decision: 'approve', note: 'ok' },
  });
  assert.equal(decide.status, 200);
  await assert.rejects(
    theDb().query('UPDATE ai_review_request_transitions SET to_state = $1 WHERE review_request_id = $2', [
      'rejected',
      reviewRequestId,
    ]),
    /append-only history/,
  );

  // The review-request reason/context are immutable (content trigger).
  await assert.rejects(
    theDb().query('UPDATE ai_review_requests SET reason = $1 WHERE review_request_id = $2', [
      'rewritten reason',
      reviewRequestId,
    ]),
    /reason is immutable/,
  );
});

test('the scope-chain trigger rejects a cross-workspace evaluation row even under direct SQL', async () => {
  const tenantA = await makeTenant('scopechain-a');
  const tenantB = await makeTenant('scopechain-b');
  const evaluatorKey = uniqueEvaluatorKey('brand-voice-rubric');
  await registerEvaluator({ evaluatorKey, kind: 'schema-validity', config: {} });
  const profileA = await createTaskProfile(tenantA.workspaceId, tenantA.owner.token, 'scopechain-profile-a', [evaluatorKey]);
  const evaluationB = await runEvaluation(tenantB.workspaceId, tenantB.owner.token, {
    taskProfileId: (await createTaskProfile(tenantB.workspaceId, tenantB.owner.token, 'scopechain-profile-b', [evaluatorKey]))['taskProfileId'] as string,
    output: { headline: 'x' },
    idempotencyKey: 'scopechain-eval-b',
  });
  assert.equal(evaluationB.status, 201);

  // A direct-SQL insert claiming tenantA's workspace with tenantB's
  // task profile is trigger-rejected (tenant isolation holds even under
  // direct SQL rewrites).
  await assert.rejects(
    theDb().query(
      `INSERT INTO ai_evaluations
         (evaluation_id, workspace_id, client_id, agency_id, task_profile_id, execution_id, usage_id,
          evaluator_registry_id, evaluator_key, evaluator_version, verdict, score, dimensions,
          evidence_refs, uncertainty_or_limitations, correlation_id, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 'scopechain-forged', 1, 'pass', NULL, '[]'::jsonb,
               '[]'::jsonb, '', 'scopechain-forged', 'scopechain-forged-key', $7)`,
      [
        '99999999-9999-4999-8999-999999999999',
        tenantA.workspaceId,
        tenantA.clientId,
        tenantA.agencyId,
        (evaluationB.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['taskProfileId'] as string,
        (evaluationB.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['evaluatorRegistryId'] as string,
        'b'.repeat(64),
      ],
    ),
    /does not belong to workspace/,
  );

  // A direct-SQL insert with an INCONSISTENT scope chain is rejected.
  await assert.rejects(
    theDb().query(
      `INSERT INTO ai_evaluations
         (evaluation_id, workspace_id, client_id, agency_id, task_profile_id, execution_id, usage_id,
          evaluator_registry_id, evaluator_key, evaluator_version, verdict, score, dimensions,
          evidence_refs, uncertainty_or_limitations, correlation_id, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, 'scopechain-forged', 1, 'pass', NULL, '[]'::jsonb,
               '[]'::jsonb, '', 'scopechain-forged', 'scopechain-forged-key-2', $7)`,
      [
        '88888888-8888-4888-8888-888888888888',
        tenantA.workspaceId,
        tenantB.clientId,
        tenantB.agencyId,
        profileA['taskProfileId'] as string,
        (evaluationB.body['evaluations'] as ReadonlyArray<Record<string, unknown>>)[0]!['evaluatorRegistryId'] as string,
        'c'.repeat(64),
      ],
    ),
    /does not belong to/,
  );
});

test('the review-request decision is EXACTLY-ONE under concurrency (the transitions fence)', async () => {
  const tenant = await makeTenant('race');
  const create = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/ai/review-requests`, {
    token: tenant.owner.token,
    body: { reason: 'concurrent decisions race', idempotencyKey: 'race-1' },
  });
  assert.equal(create.status, 201);
  const reviewRequestId = (create.body['reviewRequest'] as Record<string, unknown>)['reviewRequestId'] as string;

  // Two concurrent decisions: exactly one wins, the other is a 409.
  const decisions = await Promise.allSettled([
    theModule().decideReview({
      reviewRequestId,
      decision: 'approve',
      note: 'first',
      correlationId: '44444444-4444-4444-8444-444444444444',
      actorId: tenant.owner.userId,
    }),
    theModule().decideReview({
      reviewRequestId,
      decision: 'reject',
      note: 'second',
      correlationId: '55555555-5555-4555-8555-555555555555',
      actorId: tenant.owner.userId,
    }),
  ]);
  const settled = decisions.map((d) => (d.status === 'fulfilled' ? d.value.state : 'rejected'));
  const approved = settled.filter((s) => s === 'approved').length;
  const rejected = settled.filter((s) => s === 'rejected').length;
  const rejectedState = settled.filter((s) => s === 'rejected' || s === 'approved').length;
  assert.equal(approved + rejected, 2);
  assert.equal(rejectedState, 2);
  assert.ok(approved <= 1, `exactly one decision may win (got ${approved} approved)`);
  // The winning state is one of the two decisions; the transitions table
  // holds exactly ONE row.
  const rows = await theDb().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM ai_review_request_transitions WHERE review_request_id = $1',
    [reviewRequestId],
  );
  assert.equal(Number(rows.rows[0]?.count), 1, 'exactly one transition row exists');
});
