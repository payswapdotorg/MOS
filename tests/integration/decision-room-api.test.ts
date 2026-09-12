/**
 * MKT-030 integration test — the Client Decision Room read surface (UI-001,
 * acceptance UI-AC-01..02) against real PostgreSQL + a real API subprocess.
 *
 * Proofs:
 *   - UI-AC-01 (client E2E): the decision-room API returns AUTHORITATIVE
 *     state matching the seeded multi-client ground truth — the WHAT
 *     HAPPENED goal/workflow-instance recaps (statuses, success criteria,
 *     per-workflow and client-wide §5 tallies), the WHY learning rationale
 *     (applicability + the DERIVED supersession chain), the EVIDENCE
 *     QUALITY grade distribution by class, the EXPERIMENTS with their
 *     declared hypothesis/design/analysis and the RESULTING DECISION
 *     surfaced verbatim, the RECOMMENDATIONS (applicable learnings +
 *     declared experiment decisions only) and the APPROVALS (the running
 *     undecided experiment + the blocked workflow instance) — every count
 *     cross-checked against DIRECT SQL ground truth;
 *   - UI-AC-02 (frontend bypass cannot change authorization/workflow
 *     outcomes):
 *       - the surface is READ-ONLY BY CONSTRUCTION: POST/PUT/PATCH/DELETE
 *         on the decision-room path are 405 METHOD_NOT_ALLOWED (never
 *         reach any handler);
 *       - the surface has NO DTO: a POST body carrying authority fields
 *         (agency/client/workspace identifiers, statuses, provenance) is
 *         rejected by the verb, and authority-shaped QUERY parameters
 *         change nothing (byte-identical response);
 *       - the hard tenant boundary: a client of another agency probing a
 *         foreign decision room gets the UNIFORM 404 — indistinguishable
 *         from an unknown or malformed identifier (no cross-client
 *         oracle); anonymous calls are 401;
 *       - forged authority headers (x-agency-id, x-client-id,
 *         x-platform-role, x-status, x-recorded-actor) change nothing;
 *       - after every read/probe, the durable authority rows are
 *         BYTE-IDENTICAL to the pre-read SQL snapshots (no decision-room
 *         input can alter any authority's outcome — the room has no write
 *         path at all);
 *   - read posture: any ACTIVE member of the owning agency may read the
 *     room (client_collaborator included).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

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

async function makeUser(email: string, displayName: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function makeClient(agencyId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create client: ${JSON.stringify(response.body)}`);
  return response.body['clientId'] as string;
}

async function makeWorkspace(clientId: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: await adminToken(),
    body: { name },
  });
  assert.equal(response.status, 201, `create workspace: ${JSON.stringify(response.body)}`);
  return response.body['workspaceId'] as string;
}

// ---------------------------------------------------------------------------
// Seeding helpers over the authorities' own API surfaces
// ---------------------------------------------------------------------------

function goalBody(objective: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective,
    successCriteria: [
      {
        metric: 'activation_rate',
        comparator: '>=',
        targetValue: 0.4,
        unit: '%',
        description: 'New accounts activated within 14 days',
      },
    ],
    metrics: [{ name: 'activation_rate', unit: '%', description: 'observed only' }],
    constraints: [{ kind: 'time', description: 'Within Q2 2026.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    ...overrides,
  };
}

async function makeGoal(
  clientId: string,
  token: string,
  objective: string,
  workspaceId?: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: goalBody(objective, workspaceId === undefined ? {} : { workspaceId }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['goalId'] as string;
}

async function setGoalStatus(goalId: string, token: string, status: string, version: number): Promise<number> {
  const response = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token,
    method: 'PATCH',
    body: { status, version },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body['version'] as number;
}

function nodeBody(nodeId: string, nodeType: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType,
    inputMapping: {},
    outputSchema: {
      type: 'object',
      properties: { out: { type: 'string', description: null } },
      required: [],
    },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function definitionBody(): Record<string, unknown> {
  return {
    graph: {
      nodes: [nodeBody('a', 'function'), nodeBody('t', 'terminal')],
      edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
    },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
  };
}

async function makeWorkflowWithRunningInstances(
  workspaceId: string,
  token: string,
  name: string,
  finalStates: ReadonlyArray<'running' | 'blocked' | 'succeeded'>,
): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name, description: 'The decision-room fixture workflow.' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const workflowId = created.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: definitionBody(),
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let version = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/status`,
      { token, method: 'PATCH', body: { status, version } },
    );
    assert.equal(next.status, 200, JSON.stringify(next.body));
    version = next.body['version'] as number;
  }

  for (const [index, finalState] of finalStates.entries()) {
    const instance = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/instances`,
      { token, body: {} },
    );
    assert.equal(instance.status, 201, JSON.stringify(instance.body));
    const instanceId = instance.body['workflowInstanceId'] as string;
    let instanceVersion = instance.body['version'] as number;
    const steps: ReadonlyArray<string> =
      finalState === 'blocked'
        ? ['ready', 'running', 'blocked']
        : finalState === 'succeeded'
          ? ['ready', 'running', 'succeeded']
          : ['ready', 'running'];
    for (const [stepIndex, to] of steps.entries()) {
      const transition = await apiCall(
        port(),
        `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
        {
          token,
          body: {
            to,
            version: instanceVersion,
            idempotencyKey: `decision-room-${index}-${stepIndex}`,
            reason: `fixture walk to ${to}`,
          },
        },
      );
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
      instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
    }
  }
  return workflowId;
}

async function appendEvidence(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, { token, body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

function experimentBody(hypothesis: string): Record<string, unknown> {
  return {
    hypothesis,
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    populationUnit: 'New client accounts created after 2026-01-01, account level.',
    treatment: '5-touch onboarding email sequence with behavioral triggers.',
    comparison: 'Current 3-touch onboarding email sequence (status quo).',
    assignmentMethod: 'Simple random assignment at account creation, 50/50.',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [{ name: 'unsubscribe_rate', dimensions: {} }],
    analysisMethod: 'Two-proportion z-test on account-level activation.',
    analysisMethodVersion: 'v2',
    expectedDirection: 'increase',
    startCriteria: 'Start once 500 accounts/week enrollment is confirmed.',
    stopCriteria: 'Stop at 2000 accounts per arm or after 6 weeks, whichever comes first.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
    uncertaintyRepresentation: 'interval',
  };
}

async function makeConcludedExperiment(clientId: string, token: string, hypothesis: string): Promise<string> {
  const declared = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: experimentBody(hypothesis),
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;
  for (const body of [
    { transition: 'mark_ready' },
    { transition: 'start' },
    { transition: 'begin_analysis' },
    {
      transition: 'conclude',
      conclusion: {
        resultState: 'causal_supported',
        uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
        assumptions: ['Stable delivery infrastructure during the window'],
        sampleLimitations: ['Only standard-tier accounts observed'],
        confounders: [],
        resultingDecision: 'Roll out the 5-touch sequence to all new clients.',
        evidenceRefs: [],
      },
    },
  ] as ReadonlyArray<Record<string, unknown>>) {
    const applied = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token,
      body,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }
  return experimentId;
}

async function makeRunningExperiment(clientId: string, token: string, hypothesis: string): Promise<string> {
  const declared = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: experimentBody(hypothesis),
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;
  for (const body of [{ transition: 'mark_ready' }, { transition: 'start' }] as ReadonlyArray<
    Record<string, unknown>
  >) {
    const applied = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token,
      body,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }
  return experimentId;
}

function learningBody(statement: string, experimentRefs: readonly string[]): Record<string, unknown> {
  return {
    statement,
    applicability: { channel: 'email', cohort: 'new_accounts' },
    evidenceRefs: [],
    experimentRefs,
    confidence: 0.82,
  };
}

async function appendLearning(
  clientId: string,
  token: string,
  statement: string,
  experimentRefs: readonly string[],
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/learnings`, {
    token,
    body: learningBody(statement, experimentRefs),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['learningId'] as string;
}

async function supersedeLearning(fromId: string, toId: string, token: string): Promise<void> {
  const response = await apiCall(port(), `/api/learnings/${fromId}/relationships`, {
    token,
    body: { kind: 'supersedes', toLearningId: toId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

// ---------------------------------------------------------------------------
// Shared fixtures: agency A (two clients, one workspace) + foreign agency B
// ---------------------------------------------------------------------------

const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceB = '';

let goalA1Active = '';
let goalA1Achieved = '';
let goalA2 = '';
let goalB = '';
let workflowA1 = '';
let experimentA1Concluded = '';
let experimentA1Running = '';
let learningA1First = '';
let learningA1Superseded = '';
let learningA1Successor = '';

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-status': 'succeeded',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

/** Pre-read and post-read durable snapshots (UI-AC-02 byte-stability). */
let snapshotBefore = '';

async function durableSnapshot(clientId: string): Promise<string> {
  assert.ok(db !== null);
  const goals = await db.query(`SELECT * FROM goals WHERE client_id = $1 ORDER BY goal_id`, [clientId]);
  const instances = await db.query(
    `SELECT wi.* FROM workflow_instances wi
       JOIN workflows w ON w.workflow_id = wi.workflow_id
       JOIN workspaces ws ON ws.workspace_id = w.workspace_id
      WHERE ws.client_id = $1 ORDER BY wi.workflow_instance_id`,
    [clientId],
  );
  const evidence = await db.query(
    `SELECT * FROM evidence WHERE client_id = $1 ORDER BY evidence_id`,
    [clientId],
  );
  const experiments = await db.query(
    `SELECT * FROM experiments WHERE client_id = $1 ORDER BY experiment_id`,
    [clientId],
  );
  const learnings = await db.query(
    `SELECT * FROM learnings WHERE client_id = $1 ORDER BY learning_id`,
    [clientId],
  );
  return JSON.stringify({
    goals: goals.rows,
    instances: instances.rows,
    evidence: evidence.rows,
    experiments: experiments.rows,
    learnings: learnings.rows,
  });
}

async function getDecisionRoom(
  clientId: string,
  token: string | undefined,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/reporting/decision-room/${clientId}`, {
    ...(token === undefined ? {} : { token }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
}

/** The response minus the ticking generatedAt marker (for byte comparisons). */
function stableBody(body: Record<string, unknown>): Record<string, unknown> {
  const { generatedAt: _generatedAt, ...rest } = body;
  return rest;
}

before(async () => {
  stack = await bootStack('decisionroom');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  Object.assign(ownerA, await makeUser('owner-a@decision-room.test', 'Agency A Owner', 'decision-room-pass-1'));
  Object.assign(
    collaboratorA,
    await makeUser('collab-a@decision-room.test', 'Agency A Collaborator', 'decision-room-pass-2'),
  );
  Object.assign(ownerB, await makeUser('owner-b@decision-room.test', 'Agency B Owner', 'decision-room-pass-3'));

  agencyA = await makeAgency('Decision Room Agency A', ownerA);
  agencyB = await makeAgency('Decision Room Agency B', ownerB);
  const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: await adminToken(),
    body: { userId: collaboratorA.userId, role: 'client_collaborator' },
  });
  assert.equal(membership.status, 201);

  clientA1 = await makeClient(agencyA, 'Decision Room Client A One');
  clientA2 = await makeClient(agencyA, 'Decision Room Client A Two');
  clientB = await makeClient(agencyB, 'Decision Room Client B');
  workspaceA1 = await makeWorkspace(clientA1, 'Decision Room Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Decision Room Workspace B');

  // WHAT HAPPENED — goals in mixed lifecycle states across all three
  // clients (the room for clientA1 must present ONLY clientA1's goals).
  goalA1Active = await makeGoal(clientA1, ownerA.token, 'Increase new-account activation to 40%.', workspaceA1);
  let version = 1;
  version = await setGoalStatus(goalA1Active, ownerA.token, 'active', version);
  void version;
  goalA1Achieved = await makeGoal(clientA1, ownerA.token, 'Reduce onboarding churn in the first 30 days.');
  let achievedVersion = 1;
  achievedVersion = await setGoalStatus(goalA1Achieved, ownerA.token, 'active', achievedVersion);
  await setGoalStatus(goalA1Achieved, ownerA.token, 'achieved', achievedVersion);
  goalA2 = await makeGoal(clientA2, ownerA.token, 'Grow the client A2 waitlist.');
  goalB = await makeGoal(clientB, ownerB.token, 'Foreign client B goal.');

  // WHAT HAPPENED (workflow side) — one workflow with three instances:
  // running, blocked (awaiting continuation) and succeeded (terminal history).
  workflowA1 = await makeWorkflowWithRunningInstances(workspaceA1, ownerA.token, 'Onboarding Sequence', [
    'running',
    'blocked',
    'succeeded',
  ]);

  // EVIDENCE QUALITY — four records under clientA1 across classes/grades
  // (plus foreign records that must never appear in the room).
  await appendEvidence(clientA1, ownerA.token, {
    class: 'source_fact',
    sourceSystem: 'internal',
    sourceRef: 'activation-report/2026-02',
    observedAt: '2026-02-15T10:00:00.000Z',
    content: { metric: 'activation_rate', value: 0.31 },
    quality: 'A',
  });
  await appendEvidence(clientA1, ownerA.token, {
    class: 'source_fact',
    sourceSystem: 'internal',
    sourceRef: 'activation-report/2026-03',
    observedAt: '2026-03-15T10:00:00.000Z',
    content: { metric: 'activation_rate', value: 0.33 },
    quality: 'C',
  });
  await appendEvidence(clientA1, ownerA.token, {
    class: 'observation',
    sourceSystem: 'internal',
    observedAt: '2026-03-20T10:00:00.000Z',
    content: { metric: 'unsubscribe_rate', value: 0.011 },
    quality: 'B',
  });
  await appendEvidence(clientA1, ownerA.token, {
    class: 'inference',
    sourceSystem: 'internal',
    observedAt: '2026-03-21T10:00:00.000Z',
    content: { metric: 'activation_rate', note: 'model-interpreted uplift signal' },
    quality: 'E',
  });
  await appendEvidence(clientB, ownerB.token, {
    class: 'source_fact',
    sourceSystem: 'internal',
    observedAt: '2026-03-22T10:00:00.000Z',
    content: { metric: 'activation_rate', value: 0.28 },
    quality: 'A',
  });

  // EXPERIMENTS — one CONCLUDED with a declared resulting decision + one
  // RUNNING/undecided (awaiting decision) + a foreign concluded experiment.
  experimentA1Concluded = await makeConcludedExperiment(
    clientA1,
    ownerA.token,
    'A 5-touch onboarding email sequence increases new-account activation vs the 3-touch sequence.',
  );
  experimentA1Running = await makeRunningExperiment(
    clientA1,
    ownerA.token,
    'A two-step SMS reminder recovers stalled onboarding completions.',
  );
  await makeConcludedExperiment(
    clientB,
    ownerB.token,
    'Foreign experiment that must never appear in the client A1 room.',
  );

  // WHY — three learnings: an active one, one later superseded by an
  // explicit successor (the supersession chain the room must present).
  learningA1First = await appendLearning(
    clientA1,
    ownerA.token,
    'Personalized subject lines lift open rates for onboarding email.',
    [experimentA1Concluded],
  );
  learningA1Superseded = await appendLearning(
    clientA1,
    ownerA.token,
    'A 5-touch sequence modestly increases activation (early read).',
    [experimentA1Concluded],
  );
  learningA1Successor = await appendLearning(
    clientA1,
    ownerA.token,
    'A 5-touch onboarding sequence increases new-account activation versus the 3-touch sequence.',
    [experimentA1Concluded],
  );
  await supersedeLearning(learningA1Superseded, learningA1Successor, ownerA.token);

  // The pre-read durable ground truth (UI-AC-02 byte-stability baseline).
  snapshotBefore = await durableSnapshot(clientA1);
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// UI-AC-01 — the authoritative state, matching seeded ground truth
// ---------------------------------------------------------------------------

test('the decision room returns the authoritative WHAT HAPPENED state: goals and workflow instances (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;

  assert.deepEqual(body['scope'], {
    kind: 'client-decision-room',
    clientId: clientA1,
    agencyId: agencyA,
  });
  assert.ok(typeof body['generatedAt'] === 'string');

  const whatHappened = body['whatHappened'] as Record<string, unknown>;
  const goals = whatHappened['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 2, 'exactly clientA1 goals appear (clientA2 and clientB goals never leak)');
  const goalIds = goals.map((goal) => goal['goalId']).sort();
  assert.deepEqual(goalIds, [goalA1Active, goalA1Achieved].sort());
  // The cross-client and cross-agency goal identifiers appear NOWHERE in
  // the room (neither clientA2's nor clientB's business data leaks).
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(goalA2), 'clientA2 goal id must never appear');
  assert.ok(!serialized.includes(goalB), 'clientB goal id must never appear');
  assert.ok(!serialized.includes(clientB), 'the foreign client id must never appear');
  assert.deepEqual(whatHappened['goalStatusCounts'], {
    draft: 0,
    active: 1,
    achieved: 1,
    abandoned: 0,
  });
  const active = goals.find((goal) => goal['goalId'] === goalA1Active)!;
  assert.equal(active['objective'], 'Increase new-account activation to 40%.');
  assert.equal(active['status'], 'active');
  assert.equal(active['workspaceId'], workspaceA1);
  const criteria = active['successCriteria'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(criteria[0]!['metric'], 'activation_rate');
  assert.equal(criteria[0]!['comparator'], '>=');
  assert.equal(criteria[0]!['targetValue'], 0.4);

  const workflows = whatHappened['workflows'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], workflowA1);
  assert.equal(workflows[0]!['name'], 'Onboarding Sequence');
  const instanceCounts = workflows[0]!['instanceCounts'] as Record<string, number>;
  assert.equal(instanceCounts['running'], 1);
  assert.equal(instanceCounts['blocked'], 1);
  assert.equal(instanceCounts['succeeded'], 1);
  assert.equal(instanceCounts['draft'], 0);
  assert.equal((workflows[0]!['instances'] as readonly unknown[]).length, 3);
  assert.deepEqual(whatHappened['instanceStatusCounts'], instanceCounts);
});

test('the decision room returns the authoritative WHY state: learnings with applicability + the supersession chain (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);
  const why = (response.body['why'] as Record<string, unknown>)['learnings'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(why.length, 3, 'exactly clientA1 learnings appear');
  const superseded = why.find((learning) => learning['learningId'] === learningA1Superseded)!;
  assert.equal(superseded['status'], 'superseded', 'the DERIVED state arrives from the relationship history');
  assert.equal(superseded['supersededBy'], learningA1Successor, 'the supersession chain is presented');
  const successor = why.find((learning) => learning['learningId'] === learningA1Successor)!;
  assert.equal(successor['status'], 'active');
  assert.equal(successor['supersededBy'], undefined, 'a null successor pointer is omitted');
  assert.deepEqual(successor['applicability'], { channel: 'email', cohort: 'new_accounts' });
  assert.deepEqual(successor['experimentRefs'], [experimentA1Concluded]);
  assert.deepEqual((response.body['why'] as Record<string, unknown>)['learningStatusCounts'], {
    active: 2,
    superseded: 1,
    contradicted: 0,
    retired: 0,
  });
});

test('the decision room returns the authoritative EVIDENCE QUALITY posture: grade distribution by class (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);
  const quality = response.body['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 4);
  assert.equal(quality['window'], 'evidence-authority-bounded-newest-first-listing');
  const byClass = quality['byClass'] as ReadonlyArray<Record<string, unknown>>;
  const sourceFact = byClass.find((entry) => entry['class'] === 'source_fact')!;
  assert.deepEqual(sourceFact['gradeCounts'], { A: 1, B: 0, C: 1, D: 0, E: 0, F: 0 });
  const observation = byClass.find((entry) => entry['class'] === 'observation')!;
  assert.deepEqual(observation['gradeCounts'], { A: 0, B: 1, C: 0, D: 0, E: 0, F: 0 });
  const inference = byClass.find((entry) => entry['class'] === 'inference')!;
  assert.deepEqual(inference['gradeCounts'], { A: 0, B: 0, C: 0, D: 0, E: 1, F: 0 });
  assert.ok(!byClass.some((entry) => entry['class'] === 'attribution'), 'empty classes carry no posture');
});

test('the decision room returns the authoritative EXPERIMENTS with the RESULTING DECISION surfaced verbatim (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);
  const experimentsView = response.body['experiments'] as Record<string, unknown>;
  const experiments = experimentsView['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(experiments.length, 2, 'exactly clientA1 experiments appear (clientB never leaks)');
  const concluded = experiments.find((entry) => entry['experimentId'] === experimentA1Concluded)!;
  assert.equal(concluded['status'], 'concluded');
  assert.equal(concluded['designType'], 'randomized');
  assert.equal(concluded['analysisMethod'], 'Two-proportion z-test on account-level activation.');
  assert.equal(concluded['analysisMethodVersion'], 'v2');
  assert.equal(concluded['primaryMetricName'], 'activation_rate');
  assert.equal(concluded['resultState'], 'causal_supported');
  assert.equal(
    concluded['resultingDecision'],
    'Roll out the 5-touch sequence to all new clients.',
    'the decision is surfaced from the /experiments contract, never re-derived',
  );
  const running = experiments.find((entry) => entry['experimentId'] === experimentA1Running)!;
  assert.equal(running['status'], 'running');
  assert.equal(running['resultState'], 'undecided');
  assert.equal(running['resultingDecision'], undefined);
  assert.deepEqual(experimentsView['experimentStatusCounts'], {
    draft: 0,
    ready: 0,
    running: 1,
    analyzing: 0,
    concluded: 1,
    stopped: 0,
    invalidated: 0,
  });
});

test('RECOMMENDATIONS present exactly the applicable learnings + the declared experiment decision — no invented lift (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);
  const recommendations = response.body['recommendations'] as Record<string, unknown>;
  assert.equal(
    recommendations['basis'],
    'applicable_learnings_and_declared_experiment_decisions',
  );
  const items = recommendations['items'] as ReadonlyArray<Record<string, unknown>>;
  const learningItems = items.filter((item) => item['kind'] === 'applicable_learning');
  const decisionItems = items.filter((item) => item['kind'] === 'experiment_decision');
  assert.equal(learningItems.length, 2, 'the two ACTIVE learnings only (superseded excluded)');
  assert.deepEqual(
    learningItems.map((item) => item['learningId']).sort(),
    [learningA1First, learningA1Successor].sort(),
  );
  assert.equal(decisionItems.length, 1, 'the concluded experiment with a declared decision');
  const decision = decisionItems[0]!;
  assert.equal(decision['experimentId'], experimentA1Concluded);
  assert.equal(decision['resultingDecision'], 'Roll out the 5-touch sequence to all new clients.');
  assert.equal(decision['resultState'], 'causal_supported');
  assert.equal(decision['designType'], 'randomized');
  // The frozen contract: no lift is ever synthesized.
  for (const forbidden of ['lift', 'causalLift', 'incrementalEffect', 'uplift']) {
    assert.ok(!(forbidden in decision), `the recommendation vocabulary has no '${forbidden}' field`);
  }
});

test('APPROVALS surface the pending states durable state exposes: the running undecided experiment + the blocked instance (UI-AC-01)', async () => {
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);
  const approvals = (response.body['approvals'] as Record<string, unknown>)['items'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(approvals.length, 2);
  const experimentApproval = approvals.find((item) => item['kind'] === 'experiment_awaiting_decision')!;
  assert.equal(experimentApproval['experimentId'], experimentA1Running);
  assert.equal(experimentApproval['status'], 'running');
  const instanceApproval = approvals.find(
    (item) => item['kind'] === 'workflow_instance_awaiting_continuation',
  )!;
  assert.equal(instanceApproval['instanceStatus'], 'blocked');
  assert.equal(instanceApproval['workflowId'], workflowA1);
});

test('every view count matches DIRECT SQL ground truth over the durable authority rows (UI-AC-01)', async () => {
  assert.ok(db !== null);
  const response = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(response.status, 200);

  const goals = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM goals WHERE client_id = $1',
    [clientA1],
  );
  const viewGoals = (response.body['whatHappened'] as Record<string, unknown>)['goals'] as unknown[];
  assert.ok(Array.isArray(viewGoals));
  assert.equal(viewGoals.length, Number(goals.rows[0]!.count));

  const instances = await db.query<{ count: string; status: string }>(
    `SELECT wi.status, COUNT(*)::text AS count
       FROM workflow_instances wi
       JOIN workflows w ON w.workflow_id = wi.workflow_id
       JOIN workspaces ws ON ws.workspace_id = w.workspace_id
      WHERE ws.client_id = $1 GROUP BY wi.status`,
    [clientA1],
  );
  const blocked = instances.rows.find((row) => row.status === 'blocked');
  assert.equal(blocked?.count, '1');
  const succeeded = instances.rows.find((row) => row.status === 'succeeded');
  assert.equal(succeeded?.count, '1');

  const evidence = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM evidence WHERE client_id = $1',
    [clientA1],
  );
  assert.equal((response.body['evidenceQuality'] as Record<string, unknown>)['totalRecords'], Number(evidence.rows[0]!.count));

  const experiments = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM experiments WHERE client_id = $1',
    [clientA1],
  );
  assert.equal(
    ((response.body['experiments'] as Record<string, unknown>)['experiments'] as unknown[]).length,
    Number(experiments.rows[0]!.count),
  );

  const learnings = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM learnings WHERE client_id = $1',
    [clientA1],
  );
  assert.equal(
    ((response.body['why'] as Record<string, unknown>)['learnings'] as unknown[]).length,
    Number(learnings.rows[0]!.count),
  );
});

test('any ACTIVE member of the owning agency may read the room (client_collaborator read posture)', async () => {
  const response = await getDecisionRoom(clientA1, collaboratorA.token);
  assert.equal(response.status, 200);
  assert.equal(
    (response.body['scope'] as Record<string, unknown>)['clientId'],
    clientA1,
  );
});

// ---------------------------------------------------------------------------
// UI-AC-02 — the hard tenant boundary (uniform 404, no cross-client oracle)
// ---------------------------------------------------------------------------

test('a client of another agency CANNOT see a foreign decision room: uniform 404, indistinguishable from unknown (UI-AC-02)', async () => {
  const unknownClientId = randomUUID();
  const foreign = await getDecisionRoom(clientA1, ownerB.token);
  const unknown = await getDecisionRoom(unknownClientId, ownerB.token);
  const malformed = await getDecisionRoom('not-a-uuid', ownerB.token);
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal((foreign.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  assert.equal((unknown.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  assert.equal((malformed.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  // Indistinguishable posture: the three bodies differ ONLY by the echoed
  // caller-supplied identifier (never by existence information).
  const strip = (body: Record<string, unknown>): string =>
    JSON.stringify(body).replaceAll(clientA1, 'X').replaceAll(unknownClientId, 'X').replaceAll('not-a-uuid', 'X');
  assert.equal(strip(foreign.body), strip(unknown.body));
  assert.equal(strip(unknown.body), strip(malformed.body));
  // And the mirror direction: an agency A caller probing agency B's client.
  const reverse = await getDecisionRoom(clientB, ownerA.token);
  assert.equal(reverse.status, 404);
  assert.equal((reverse.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  // Anonymous calls never reach the surface (401, fail closed).
  const anonymous = await getDecisionRoom(clientA1, undefined);
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------------------
// UI-AC-02 — read-only by construction: mutating verbs + authority fields
// ---------------------------------------------------------------------------

test('mutating verbs are rejected: POST/PUT/PATCH/DELETE on the decision-room path are 405 METHOD_NOT_ALLOWED (UI-AC-02)', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await apiCall(port(), `/api/reporting/decision-room/${clientA1}`, {
      token: ownerA.token,
      method,
      body: { agencyId: agencyB, clientId: clientB, workspaceId: workspaceB, status: 'succeeded' },
    });
    assert.equal(response.status, 405, `${method} must be rejected`);
    assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'METHOD_NOT_ALLOWED');
  }
});

test('authority fields cannot be injected: a POST body of authority fields is rejected by the verb; authority-shaped QUERY parameters change nothing (UI-AC-02)', async () => {
  // The surface has NO DTO at all: the mutating verb is rejected before any
  // body could be interpreted (authority fields are structurally unreachable).
  const post = await apiCall(port(), `/api/reporting/decision-room/${clientA1}`, {
    token: ownerA.token,
    method: 'POST',
    body: { agencyId: agencyB, clientId: clientB, workspaceId: workspaceB, provenance: { actor: 'forged' } },
  });
  assert.equal(post.status, 405);

  // GET ignores every query parameter: the scope is server-derived only.
  const baseline = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(baseline.status, 200);
  const poisoned = await apiCall(
    port(),
    `/api/reporting/decision-room/${clientA1}?agencyId=${agencyB}&clientId=${clientB}&workspaceId=${workspaceB}&status=succeeded`,
    { token: ownerA.token },
  );
  assert.equal(poisoned.status, 200);
  assert.deepEqual(stableBody(poisoned.body), stableBody(baseline.body));
});

test('forged authority headers change nothing (frontend checks are never authoritative)', async () => {
  const baseline = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(baseline.status, 200);
  const forged = await getDecisionRoom(clientA1, ownerA.token, {
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
    },
  });
  assert.equal(forged.status, 200);
  assert.deepEqual(stableBody(forged.body), stableBody(baseline.body));
});

// ---------------------------------------------------------------------------
// UI-AC-02 — no decision-room input can alter any authority's outcome
// ---------------------------------------------------------------------------

test('after every read and probe, the durable authority rows are byte-identical (UI-AC-02)', async () => {
  // A final authoritative read + a final cross-tenant probe, then the
  // snapshot comparison.
  const read = await getDecisionRoom(clientA1, ownerA.token);
  assert.equal(read.status, 200);
  const probe = await getDecisionRoom(clientA1, ownerB.token);
  assert.equal(probe.status, 404);

  const snapshotAfter = await durableSnapshot(clientA1);
  assert.equal(
    snapshotAfter,
    snapshotBefore,
    'the decision room mutated nothing: goals, workflow instances, evidence, experiments and learnings are byte-stable',
  );
});
