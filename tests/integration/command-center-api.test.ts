/**
 * MKT-029 integration test — the Agency Command Center read surface (UI-001,
 * acceptance UI-AC-01..02) against real PostgreSQL + a real API subprocess.
 *
 * Proofs:
 *   - UI-AC-01 (browser/API authoritative state): the command-center API
 *     returns AUTHORITATIVE state matching the seeded multi-agency ground
 *     truth — the PORTFOLIO GOALS recaps across the agency's clients (all
 *     lifecycle states, client-attributed, agency-wide + per-client
 *     tallies), the WORKFLOW STATE recaps (per-workflow instance counts,
 *     agency-wide + per-client §5 tallies), the EVIDENCE QUALITY posture
 *     (agency-combined grade distribution by class + the low-grade D/E/F
 *     signal), the RISKS posture (the goal-declared risk constraints
 *     verbatim + the FAILED execution + the UNRESOLVED unknown/reconciling
 *     executions + the blocked/paused/low-grade tallies — a presentation
 *     of authoritative rows, never a risk engine) and the PENDING
 *     APPROVALS (the running undecided experiment + the blocked workflow
 *     instance, client-attributed) — every count cross-checked against
 *     DIRECT SQL ground truth;
 *   - UI-AC-01 (live aggregation, no staleness shortcuts): after the view
 *     is read, the AUTHORITIES' own mutation surfaces change the backend
 *     (a new portfolio goal, the experiment concluded with a decision, the
 *     blocked instance resumed) and the NEXT command-center read follows
 *     exactly — nothing is cached, projected or replayed;
 *   - UI-AC-02 (frontend bypass cannot change authorization/workflow
 *     outcomes):
 *       - the surface is READ-ONLY BY CONSTRUCTION: POST/PUT/PATCH/DELETE
 *         on the command-center path are 405 METHOD_NOT_ALLOWED (never
 *         reach any handler);
 *       - the surface has NO DTO: a POST body carrying authority fields
 *         (agency/client/workspace identifiers, statuses, provenance) is
 *         rejected by the verb, and authority-shaped QUERY parameters
 *         change nothing (byte-identical response);
 *       - the hard AGENCY tenant boundary: a caller from another agency
 *         probing a foreign command center gets the UNIFORM 404 —
 *         indistinguishable from an unknown or malformed agency
 *         identifier (no cross-agency existence oracle); anonymous calls
 *         are 401; a SUSPENDED membership is the intra-tenant 403 (never
 *         a 404 — the distinction proves the 404 is reserved for the
 *         existence-hiding boundary);
 *       - forged authority headers (x-agency-id, x-client-id,
 *         x-platform-role, x-status, x-recorded-actor) change nothing;
 *       - after every read/probe, the durable authority rows are
 *         BYTE-IDENTICAL to the pre-read SQL snapshots (no command-center
 *         input can alter any authority's outcome — the surface has no
 *         write path at all);
 *   - read posture: any ACTIVE member of the agency may read the center
 *     (client_collaborator included).
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
    constraints: [
      { kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' },
      { kind: 'resource', description: 'One lifecycle designer at 60% allocation.' },
    ],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
    ...overrides,
  };
}

async function makeGoal(
  clientId: string,
  token: string,
  objective: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: goalBody(objective, overrides),
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
    body: { name, description: 'The command-center fixture workflow.' },
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
            idempotencyKey: `command-center-${index}-${stepIndex}`,
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

/** Creates an external-request execution and drives it to the target state. */
async function makeExecutionInState(
  workspaceId: string,
  token: string,
  keyPrefix: string,
  finalState: 'failed' | 'unknown' | 'reconciling',
): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      externalRequestRef: `${keyPrefix}-external-request`,
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey: `${keyPrefix}-create`,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const executionId = (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
  let version = (created.body['execution'] as Record<string, unknown>)['version'] as number;

  for (const to of ['queued', 'starting', 'running'] as const) {
    const transition = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token,
      body: { to, version, idempotencyKey: `${keyPrefix}:${to}` },
    });
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    version = (transition.body['execution'] as Record<string, unknown>)['version'] as number;
  }

  if (finalState === 'failed') {
    const failed = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token,
      body: {
        to: 'failed',
        version,
        idempotencyKey: `${keyPrefix}:failed`,
        retryClassification: 'safe',
        reason: 'provider exhausted retries',
      },
    });
    assert.equal(failed.status, 200, JSON.stringify(failed.body));
    return executionId;
  }

  // unknown — the unresolved outcome the frozen v1.2 rule requires
  // reconciliation for (never success, never auto-retry).
  const unknown = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
    token,
    body: { to: 'unknown', version, idempotencyKey: `${keyPrefix}:unknown`, reason: 'lost heartbeat' },
  });
  assert.equal(unknown.status, 200, JSON.stringify(unknown.body));
  version = (unknown.body['execution'] as Record<string, unknown>)['version'] as number;
  if (finalState === 'reconciling') {
    const reconciling = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token,
      body: { to: 'reconciling', version, idempotencyKey: `${keyPrefix}:reconciling`, reason: 'reconciliation opened' },
    });
    assert.equal(reconciling.status, 200, JSON.stringify(reconciling.body));
  }
  return executionId;
}

// ---------------------------------------------------------------------------
// Shared fixtures: agency A (TWO clients — the portfolio) + foreign agency B
// ---------------------------------------------------------------------------

const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const suspendedMember: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceB = '';

let goalA1Active = '';
let goalA1Achieved = '';
let goalA2Draft = '';
let goalB = '';
let workflowA1 = '';
let experimentA1Concluded = '';
let experimentA1Running = '';
let executionA1Failed = '';
let executionA1Unknown = '';
let executionA1Reconciling = '';

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

async function durableSnapshot(): Promise<string> {
  assert.ok(db !== null);
  const goals = await db.query(
    `SELECT * FROM goals WHERE client_id IN ($1, $2) ORDER BY goal_id`,
    [clientA1, clientA2],
  );
  const instances = await db.query(
    `SELECT wi.* FROM workflow_instances wi
       JOIN workflows w ON w.workflow_id = wi.workflow_id
       JOIN workspaces ws ON ws.workspace_id = w.workspace_id
      WHERE ws.client_id IN ($1, $2) ORDER BY wi.workflow_instance_id`,
    [clientA1, clientA2],
  );
  const evidence = await db.query(
    `SELECT * FROM evidence WHERE client_id IN ($1, $2) ORDER BY evidence_id`,
    [clientA1, clientA2],
  );
  const experiments = await db.query(
    `SELECT * FROM experiments WHERE client_id IN ($1, $2) ORDER BY experiment_id`,
    [clientA1, clientA2],
  );
  const executions = await db.query(
    `SELECT e.* FROM executions e
       JOIN workspaces ws ON ws.workspace_id = e.workspace_id
      WHERE ws.client_id IN ($1, $2) ORDER BY e.execution_id`,
    [clientA1, clientA2],
  );
  return JSON.stringify({
    goals: goals.rows,
    instances: instances.rows,
    evidence: evidence.rows,
    experiments: experiments.rows,
    executions: executions.rows,
  });
}

async function getCommandCenter(
  agencyId: string,
  token: string | undefined,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/reporting/command-center/${agencyId}`, {
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
  stack = await bootStack('commandcenter');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  Object.assign(ownerA, await makeUser('owner-a@command-center.test', 'Agency A Owner', 'command-center-pass-1'));
  Object.assign(
    collaboratorA,
    await makeUser('collab-a@command-center.test', 'Agency A Collaborator', 'command-center-pass-2'),
  );
  Object.assign(
    suspendedMember,
    await makeUser('suspended-a@command-center.test', 'Agency A Suspended Member', 'command-center-pass-4'),
  );
  Object.assign(ownerB, await makeUser('owner-b@command-center.test', 'Agency B Owner', 'command-center-pass-3'));

  agencyA = await makeAgency('Command Center Agency A', ownerA);
  agencyB = await makeAgency('Command Center Agency B', ownerB);
  for (const [user, role] of [
    [collaboratorA, 'client_collaborator'],
    [suspendedMember, 'client_collaborator'],
  ] as const) {
    const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
      token: await adminToken(),
      body: { userId: user.userId, role },
    });
    assert.equal(membership.status, 201);
  }
  // Suspend the third member's membership (the intra-tenant 403 posture).
  const memberships = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: ownerA.token,
  });
  assert.equal(memberships.status, 200);
  const suspendedRow = (memberships.body['memberships'] as ReadonlyArray<Record<string, unknown>>).find(
    (row) => row['userId'] === suspendedMember.userId,
  )!;
  const suspended = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${suspendedRow['membershipId'] as string}`,
    {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'disabled', version: suspendedRow['version'] as number },
    },
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  // The PORTFOLIO: agency A owns TWO clients (each one workspace); the
  // foreign agency B owns one client whose data must never appear.
  clientA1 = await makeClient(agencyA, 'Command Center Client A One');
  clientA2 = await makeClient(agencyA, 'Command Center Client A Two');
  clientB = await makeClient(agencyB, 'Command Center Client B');
  workspaceA1 = await makeWorkspace(clientA1, 'Command Center Workspace A1');
  workspaceA2 = await makeWorkspace(clientA2, 'Command Center Workspace A2');
  workspaceB = await makeWorkspace(clientB, 'Command Center Workspace B');

  // PORTFOLIO GOALS — mixed lifecycle states across the portfolio (the
  // center for agency A must present ONLY agency A's goals, client-attributed).
  goalA1Active = await makeGoal(clientA1, ownerA.token, 'Increase new-account activation to 40%.', {
    workspaceId: workspaceA1,
  });
  let version = 1;
  version = await setGoalStatus(goalA1Active, ownerA.token, 'active', version);
  void version;
  goalA1Achieved = await makeGoal(clientA1, ownerA.token, 'Reduce onboarding churn in the first 30 days.', {
    constraints: [{ kind: 'time', description: 'Within Q2 2026.' }],
  });
  let achievedVersion = 1;
  achievedVersion = await setGoalStatus(goalA1Achieved, ownerA.token, 'active', achievedVersion);
  await setGoalStatus(goalA1Achieved, ownerA.token, 'achieved', achievedVersion);
  goalA2Draft = await makeGoal(clientA2, ownerA.token, 'Grow the client A2 waitlist.', {
    workspaceId: workspaceA2,
    constraints: [{ kind: 'resource', description: 'Growth pod at 20% allocation.' }],
  });
  goalB = await makeGoal(clientB, ownerB.token, 'Foreign client B goal.');

  // WORKFLOW STATE — one workflow in clientA1's workspace with three
  // instances: running, blocked (awaiting continuation) and succeeded.
  workflowA1 = await makeWorkflowWithRunningInstances(workspaceA1, ownerA.token, 'Onboarding Sequence', [
    'running',
    'blocked',
    'succeeded',
  ]);

  // EVIDENCE QUALITY — five records across the portfolio (2 low-grade:
  // the D and the E) plus a foreign record that must never appear.
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
    class: 'inference',
    sourceSystem: 'internal',
    observedAt: '2026-03-21T10:00:00.000Z',
    content: { metric: 'activation_rate', note: 'model-interpreted uplift signal' },
    quality: 'E',
  });
  await appendEvidence(clientA2, ownerA.token, {
    class: 'source_fact',
    sourceSystem: 'internal',
    sourceRef: 'waitlist-report/2026-03',
    observedAt: '2026-03-16T10:00:00.000Z',
    content: { metric: 'waitlist_signups', value: 412 },
    quality: 'D',
  });
  await appendEvidence(clientA2, ownerA.token, {
    class: 'observation',
    sourceSystem: 'internal',
    observedAt: '2026-03-20T10:00:00.000Z',
    content: { metric: 'unsubscribe_rate', value: 0.011 },
    quality: 'B',
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
    'Foreign experiment that must never appear in the agency A command center.',
  );

  // RISKS (execution side) — one FAILED, one UNKNOWN and one RECONCILING
  // execution in clientA1's workspace (the canonical operational-risk
  // signals; the foreign workspace B execution below must never appear).
  executionA1Failed = await makeExecutionInState(workspaceA1, ownerA.token, 'cc-failed', 'failed');
  executionA1Unknown = await makeExecutionInState(workspaceA1, ownerA.token, 'cc-unknown', 'unknown');
  executionA1Reconciling = await makeExecutionInState(workspaceA1, ownerA.token, 'cc-reconciling', 'reconciling');
  await makeExecutionInState(workspaceB, ownerB.token, 'cc-foreign', 'failed');

  // The pre-read durable ground truth (UI-AC-02 byte-stability baseline).
  snapshotBefore = await durableSnapshot();
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

test('the command center returns the authoritative PORTFOLIO GOALS state across the agency clients (UI-AC-01)', async () => {
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const body = response.body;

  assert.deepEqual(body['scope'], {
    kind: 'agency-command-center',
    agencyId: agencyA,
    clientCount: 2,
  });
  assert.ok(typeof body['generatedAt'] === 'string');

  const portfolio = body['portfolioGoals'] as Record<string, unknown>;
  const goals = portfolio['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 3, 'exactly agency A portfolio goals appear (clientB never leaks)');
  const goalIds = goals.map((goal) => goal['goalId']).sort();
  assert.deepEqual(goalIds, [goalA1Active, goalA1Achieved, goalA2Draft].sort());
  // The cross-agency goal and client identifiers appear NOWHERE in the view.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(goalB), 'the foreign agency goal id must never appear');
  assert.ok(!serialized.includes(clientB), 'the foreign client id must never appear');
  assert.ok(!serialized.includes(agencyB), 'the foreign agency id must never appear');
  assert.ok(!serialized.includes(workspaceB), 'the foreign workspace id must never appear');

  assert.deepEqual(portfolio['goalStatusCounts'], {
    draft: 1,
    active: 1,
    achieved: 1,
    abandoned: 0,
  });

  // Client attribution: every recap carries its owning client.
  const active = goals.find((goal) => goal['goalId'] === goalA1Active)!;
  assert.equal(active['clientId'], clientA1);
  assert.equal(active['objective'], 'Increase new-account activation to 40%.');
  assert.equal(active['status'], 'active');
  assert.equal(active['workspaceId'], workspaceA1);
  const criteria = active['successCriteria'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(criteria[0]!['metric'], 'activation_rate');
  assert.equal(criteria[0]!['comparator'], '>=');
  assert.equal(criteria[0]!['targetValue'], 0.4);
  // The declared constraints ride verbatim (the risk constraint feeds RISKS).
  const constraints = active['constraints'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(constraints, [
    { kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' },
    { kind: 'resource', description: 'One lifecycle designer at 60% allocation.' },
  ]);
  const draft = goals.find((goal) => goal['goalId'] === goalA2Draft)!;
  assert.equal(draft['clientId'], clientA2);
  assert.equal(draft['workspaceId'], workspaceA2, 'a workspace-scoped portfolio goal carries its scope');

  const perClient = portfolio['perClient'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(perClient.length, 2);
  const tallyA1 = perClient.find((tally) => tally['clientId'] === clientA1)!;
  assert.equal(tallyA1['total'], 2);
  assert.deepEqual(tallyA1['goalStatusCounts'], { draft: 0, active: 1, achieved: 1, abandoned: 0 });
  const tallyA2 = perClient.find((tally) => tally['clientId'] === clientA2)!;
  assert.equal(tallyA2['total'], 1);
  assert.deepEqual(tallyA2['goalStatusCounts'], { draft: 1, active: 0, achieved: 0, abandoned: 0 });
});

test('the command center returns the authoritative WORKFLOW STATE with per-client tallies (UI-AC-01)', async () => {
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200);
  const workflowState = response.body['workflowState'] as Record<string, unknown>;
  const workflows = workflowState['workflows'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], workflowA1);
  assert.equal(workflows[0]!['clientId'], clientA1, 'the workflow recap carries the owning client');
  assert.equal(workflows[0]!['workspaceId'], workspaceA1);
  assert.equal(workflows[0]!['name'], 'Onboarding Sequence');
  const instanceCounts = workflows[0]!['instanceCounts'] as Record<string, number>;
  assert.equal(instanceCounts['running'], 1);
  assert.equal(instanceCounts['blocked'], 1);
  assert.equal(instanceCounts['succeeded'], 1);
  assert.equal(instanceCounts['draft'], 0);
  assert.equal((workflows[0]!['instances'] as readonly unknown[]).length, 3);

  assert.deepEqual(workflowState['instanceStatusCounts'], instanceCounts);

  // The per-client drill-down: clientA1 carries all instances, clientA2
  // (no workflow containers) tallies zeros but STAYS visible.
  const perClient = workflowState['perClient'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(perClient.length, 2);
  const tallyA1 = perClient.find((tally) => tally['clientId'] === clientA1)!;
  assert.equal(tallyA1['total'], 3);
  assert.equal((tallyA1['instanceStatusCounts'] as Record<string, number>)['blocked'], 1);
  const tallyA2 = perClient.find((tally) => tally['clientId'] === clientA2)!;
  assert.equal(tallyA2['total'], 0);
  assert.equal((tallyA2['instanceStatusCounts'] as Record<string, number>)['running'], 0);
});

test('the command center returns the authoritative EVIDENCE QUALITY posture across the portfolio (UI-AC-01)', async () => {
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200);
  const quality = response.body['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 5, 'clientA1 (3) + clientA2 (2); clientB never counts');
  assert.equal(quality['lowGradeRecords'], 2, 'the D + E records are the low-grade signal');
  assert.equal(quality['window'], 'evidence-authority-bounded-newest-first-listing-per-client');
  const byClass = quality['byClass'] as ReadonlyArray<Record<string, unknown>>;
  // source_fact combines BOTH clients: A + C (clientA1) + D (clientA2).
  const sourceFact = byClass.find((entry) => entry['class'] === 'source_fact')!;
  assert.equal(sourceFact['total'], 3);
  assert.deepEqual(sourceFact['gradeCounts'], { A: 1, B: 0, C: 1, D: 1, E: 0, F: 0 });
  const observation = byClass.find((entry) => entry['class'] === 'observation')!;
  assert.deepEqual(observation['gradeCounts'], { A: 0, B: 1, C: 0, D: 0, E: 0, F: 0 });
  const inference = byClass.find((entry) => entry['class'] === 'inference')!;
  assert.deepEqual(inference['gradeCounts'], { A: 0, B: 0, C: 0, D: 0, E: 1, F: 0 });
  assert.ok(!byClass.some((entry) => entry['class'] === 'attribution'), 'empty classes carry no posture');

  const perClient = quality['perClient'] as ReadonlyArray<Record<string, unknown>>;
  const postureA1 = perClient.find((posture) => posture['clientId'] === clientA1)!;
  assert.equal(postureA1['totalRecords'], 3);
  assert.equal(postureA1['lowGradeRecords'], 1);
  const postureA2 = perClient.find((posture) => posture['clientId'] === clientA2)!;
  assert.equal(postureA2['totalRecords'], 2);
  assert.equal(postureA2['lowGradeRecords'], 1);
});

test('the command center returns the authoritative RISKS posture: declared constraints + failed + unresolved executions (UI-AC-01)', async () => {
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200);
  const risks = response.body['risks'] as Record<string, unknown>;
  assert.equal(
    risks['basis'],
    'declared_goal_risk_constraints_and_operational_and_evidence_quality_signals',
  );

  const items = risks['items'] as ReadonlyArray<Record<string, unknown>>;
  const constraintItems = items.filter((item) => item['kind'] === 'goal_risk_constraint');
  assert.equal(constraintItems.length, 1, 'ONLY the kind:risk constraint appears (resource excluded)');
  assert.equal(constraintItems[0]!['goalId'], goalA1Active);
  assert.equal(constraintItems[0]!['clientId'], clientA1);
  assert.equal(constraintItems[0]!['description'], 'Email fatigue above 4 touches per fortnight.');

  const failed = items.filter((item) => item['kind'] === 'execution_failed');
  assert.equal(failed.length, 1, 'exactly the portfolio FAILED execution (the foreign one never appears)');
  assert.equal(failed[0]!['executionId'], executionA1Failed);
  assert.equal(failed[0]!['clientId'], clientA1);
  assert.equal(failed[0]!['workspaceId'], workspaceA1);

  const unresolved = items.filter((item) => item['kind'] === 'execution_unresolved');
  assert.equal(unresolved.length, 2, 'the unknown + reconciling executions');
  const unknown = unresolved.find((item) => item['executionId'] === executionA1Unknown)!;
  assert.equal(unknown['status'], 'unknown');
  const reconciling = unresolved.find((item) => item['executionId'] === executionA1Reconciling)!;
  assert.equal(reconciling['status'], 'reconciling');

  assert.deepEqual(risks['summary'], {
    goalRiskConstraintCount: 1,
    blockedInstanceCount: 1,
    pausedInstanceCount: 0,
    failedExecutionCount: 1,
    unknownExecutionCount: 1,
    reconcilingExecutionCount: 1,
    lowGradeEvidenceRecords: 2,
  });

  // The frozen vocabulary: a presentation of authoritative rows — NO
  // score/severity/priority field is ever synthesized.
  const serialized = JSON.stringify(risks);
  for (const forbidden of ['"score"', '"severity"', '"priority"', '"riskLevel"']) {
    assert.ok(!serialized.includes(forbidden), `the risk vocabulary has no ${forbidden} field`);
  }
});

test('PENDING APPROVALS surface the running undecided experiment + the blocked instance, client-attributed (UI-AC-01)', async () => {
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200);
  const approvals = (response.body['pendingApprovals'] as Record<string, unknown>)['items'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(approvals.length, 2);
  const experimentApproval = approvals.find((item) => item['kind'] === 'experiment_awaiting_decision')!;
  assert.equal(experimentApproval['experimentId'], experimentA1Running);
  assert.equal(experimentApproval['clientId'], clientA1);
  assert.equal(experimentApproval['status'], 'running');
  const instanceApproval = approvals.find(
    (item) => item['kind'] === 'workflow_instance_awaiting_continuation',
  )!;
  assert.equal(instanceApproval['instanceStatus'], 'blocked');
  assert.equal(instanceApproval['workflowId'], workflowA1);
  assert.equal(instanceApproval['clientId'], clientA1);
  // The concluded experiment (with its decision) is NOT pending.
  assert.ok(!approvals.some((item) => item['experimentId'] === experimentA1Concluded));
});

test('every view count matches DIRECT SQL ground truth over the durable authority rows (UI-AC-01)', async () => {
  assert.ok(db !== null);
  const response = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(response.status, 200);

  const goals = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM goals WHERE client_id IN ($1, $2)',
    [clientA1, clientA2],
  );
  const viewGoals = (response.body['portfolioGoals'] as Record<string, unknown>)['goals'] as unknown[];
  assert.equal(viewGoals.length, Number(goals.rows[0]!.count));

  const instances = await db.query<{ count: string; status: string }>(
    `SELECT wi.status, COUNT(*)::text AS count
       FROM workflow_instances wi
       JOIN workflows w ON w.workflow_id = wi.workflow_id
       JOIN workspaces ws ON ws.workspace_id = w.workspace_id
      WHERE ws.client_id IN ($1, $2) GROUP BY wi.status`,
    [clientA1, clientA2],
  );
  const blocked = instances.rows.find((row) => row.status === 'blocked');
  assert.equal(blocked?.count, '1');
  const succeeded = instances.rows.find((row) => row.status === 'succeeded');
  assert.equal(succeeded?.count, '1');
  const viewInstances = (response.body['workflowState'] as Record<string, unknown>)['workflows'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(
    viewInstances.reduce((total, workflow) => total + (workflow['instances'] as readonly unknown[]).length, 0),
    instances.rows.reduce((total, row) => total + Number(row.count), 0),
  );

  const evidence = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM evidence WHERE client_id IN ($1, $2)',
    [clientA1, clientA2],
  );
  assert.equal(
    (response.body['evidenceQuality'] as Record<string, unknown>)['totalRecords'],
    Number(evidence.rows[0]!.count),
  );
  const lowGrade = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM evidence WHERE client_id IN ($1, $2) AND quality IN ('D','E','F')`,
    [clientA1, clientA2],
  );
  assert.equal(
    (response.body['evidenceQuality'] as Record<string, unknown>)['lowGradeRecords'],
    Number(lowGrade.rows[0]!.count),
  );

  const executions = await db.query<{ count: string; status: string }>(
    `SELECT e.status, COUNT(*)::text AS count
       FROM executions e
       JOIN workspaces ws ON ws.workspace_id = e.workspace_id
      WHERE ws.client_id IN ($1, $2) GROUP BY e.status`,
    [clientA1, clientA2],
  );
  assert.equal(executions.rows.find((row) => row.status === 'failed')?.count, '1');
  assert.equal(executions.rows.find((row) => row.status === 'unknown')?.count, '1');
  assert.equal(executions.rows.find((row) => row.status === 'reconciling')?.count, '1');
});

test('any ACTIVE member of the agency may read the center (client_collaborator read posture)', async () => {
  const response = await getCommandCenter(agencyA, collaboratorA.token);
  assert.equal(response.status, 200);
  assert.equal((response.body['scope'] as Record<string, unknown>)['agencyId'], agencyA);
  assert.equal(
    ((response.body['portfolioGoals'] as Record<string, unknown>)['goals'] as readonly unknown[]).length,
    3,
  );
});

// ---------------------------------------------------------------------------
// UI-AC-02 — the hard AGENCY tenant boundary (uniform 404, no existence leak)
// ---------------------------------------------------------------------------

test('a caller from another agency CANNOT see a foreign command center: uniform 404, indistinguishable from unknown (UI-AC-02)', async () => {
  const unknownAgencyId = randomUUID();
  const foreign = await getCommandCenter(agencyA, ownerB.token);
  const unknown = await getCommandCenter(unknownAgencyId, ownerB.token);
  const malformed = await getCommandCenter('not-a-uuid', ownerB.token);
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal((foreign.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  assert.equal((unknown.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  assert.equal((malformed.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  // Indistinguishable posture: the three bodies differ ONLY by the echoed
  // caller-supplied identifier (never by existence information).
  const strip = (body: Record<string, unknown>): string =>
    JSON.stringify(body).replaceAll(agencyA, 'X').replaceAll(unknownAgencyId, 'X').replaceAll('not-a-uuid', 'X');
  assert.equal(strip(foreign.body), strip(unknown.body));
  assert.equal(strip(unknown.body), strip(malformed.body));
  // And the mirror direction: an agency A caller probing agency B's center.
  const reverse = await getCommandCenter(agencyB, ownerA.token);
  assert.equal(reverse.status, 404);
  assert.equal((reverse.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  // Anonymous calls never reach the surface (401, fail closed).
  const anonymous = await getCommandCenter(agencyA, undefined);
  assert.equal(anonymous.status, 401);
});

test('a SUSPENDED membership is the intra-tenant 403 — never a 404 (the 404 is reserved for the existence-hiding boundary)', async () => {
  const response = await getCommandCenter(agencyA, suspendedMember.token);
  assert.equal(response.status, 403);
  assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
});

// ---------------------------------------------------------------------------
// UI-AC-02 — read-only by construction: mutating verbs + authority fields
// ---------------------------------------------------------------------------

test('mutating verbs are rejected: POST/PUT/PATCH/DELETE on the command-center path are 405 METHOD_NOT_ALLOWED (UI-AC-02)', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await apiCall(port(), `/api/reporting/command-center/${agencyA}`, {
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
  const post = await apiCall(port(), `/api/reporting/command-center/${agencyA}`, {
    token: ownerA.token,
    method: 'POST',
    body: { agencyId: agencyB, clientId: clientB, workspaceId: workspaceB, provenance: { actor: 'forged' } },
  });
  assert.equal(post.status, 405);

  // GET ignores every query parameter: the scope is server-derived only.
  const baseline = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(baseline.status, 200);
  const poisoned = await apiCall(
    port(),
    `/api/reporting/command-center/${agencyA}?agencyId=${agencyB}&clientId=${clientB}&workspaceId=${workspaceB}&status=succeeded&clientCount=99`,
    { token: ownerA.token },
  );
  assert.equal(poisoned.status, 200);
  assert.deepEqual(stableBody(poisoned.body), stableBody(baseline.body));
});

test('forged authority headers change nothing (frontend checks are never authoritative)', async () => {
  const baseline = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(baseline.status, 200);
  const forged = await getCommandCenter(agencyA, ownerA.token, {
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
// UI-AC-02 — no command-center input can alter any authority's outcome
// ---------------------------------------------------------------------------

test('after every read and probe, the durable authority rows are byte-identical (UI-AC-02)', async () => {
  // A final authoritative read + a final cross-agency probe, then the
  // snapshot comparison.
  const read = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(read.status, 200);
  const probe = await getCommandCenter(agencyA, ownerB.token);
  assert.equal(probe.status, 404);

  const snapshotAfter = await durableSnapshot();
  assert.equal(
    snapshotAfter,
    snapshotBefore,
    'the command center mutated nothing: goals, workflow instances, evidence, experiments and executions are byte-stable',
  );
});

// ---------------------------------------------------------------------------
// UI-AC-01 — LIVE AGGREGATION: the backend mutates through the authorities'
// own surfaces and the NEXT command-center read follows exactly (no cache,
// no projection, no staleness shortcuts)
// ---------------------------------------------------------------------------

test('the view FOLLOWS backend mutations made through the authorities own surfaces (live aggregation, no staleness)', async () => {
  // Pre-mutation read: the baseline asserted by the tests above.
  const before = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(before.status, 200);

  // MUTATION 1 — a NEW portfolio goal under clientA2 (the /goals authority).
  const newGoal = await makeGoal(clientA2, ownerA.token, 'Convert the Q2 waitlist into activated accounts.');
  void newGoal;

  // MUTATION 2 — the RUNNING undecided experiment is CONCLUDED with a
  // declared decision (the /experiments authority: begin_analysis → conclude).
  for (const body of [
    { transition: 'begin_analysis' },
    {
      transition: 'conclude',
      conclusion: {
        resultState: 'causal_supported',
        uncertainty: { kind: 'interval', lower: 0.008, upper: 0.021, level: 0.95 },
        assumptions: ['Reminder delivery stayed within the send window'],
        sampleLimitations: [],
        confounders: [],
        resultingDecision: 'Ship the two-step SMS reminder to all stalled onboardings.',
        evidenceRefs: [],
      },
    },
  ] as ReadonlyArray<Record<string, unknown>>) {
    const applied = await apiCall(port(), `/api/experiments/${experimentA1Running}/transitions`, {
      token: ownerA.token,
      body,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }

  // MUTATION 3 — the BLOCKED workflow instance is RESUMED (the /workflows
  // authority: blocked → running). The instance's current CAS version is
  // resolved from the AUTHORITY's own read surface (never from the command
  // center — the view carries no version tokens).
  const instanceList = await apiCall(port(), `/api/workflows/${workflowA1}/instances`, {
    token: ownerA.token,
  });
  assert.equal(instanceList.status, 200);
  const blockedRow = (instanceList.body['instances'] as ReadonlyArray<Record<string, unknown>>).find(
    (instance) => instance['status'] === 'blocked',
  )!;
  const resumed = await apiCall(
    port(),
    `/api/workflows/${workflowA1}/instances/${blockedRow['workflowInstanceId'] as string}/transitions`,
    {
      token: ownerA.token,
      body: {
        to: 'running',
        version: blockedRow['version'] as number,
        idempotencyKey: 'command-center-live-follow-resume',
        reason: 'operator resumed the awaiting instance',
      },
    },
  );
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));

  // The NEXT read follows the authoritative state exactly.
  const after = await getCommandCenter(agencyA, ownerA.token);
  assert.equal(after.status, 200, JSON.stringify(after.body));

  // Portfolio goals grew by exactly the new goal (4 total; draft 2).
  const portfolio = after.body['portfolioGoals'] as Record<string, unknown>;
  const goals = portfolio['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 4);
  assert.ok(goals.some((goal) => goal['objective'] === 'Convert the Q2 waitlist into activated accounts.'));
  assert.deepEqual(portfolio['goalStatusCounts'], { draft: 2, active: 1, achieved: 1, abandoned: 0 });
  const tallyA2 = (portfolio['perClient'] as ReadonlyArray<Record<string, unknown>>).find(
    (tally) => tally['clientId'] === clientA2,
  )!;
  assert.equal(tallyA2['total'], 2);

  // The blocked instance is now running: agency-wide tallies follow.
  const workflowState = after.body['workflowState'] as Record<string, unknown>;
  const instanceStatusCounts = workflowState['instanceStatusCounts'] as Record<string, number>;
  assert.equal(instanceStatusCounts['blocked'], 0);
  assert.equal(instanceStatusCounts['running'], 2);
  assert.equal(instanceStatusCounts['succeeded'], 1);

  // The concluded experiment left the pending approvals (only the resumed
  // — now running — instance remains absent from approvals; nothing is
  // pending any more).
  const approvals = (after.body['pendingApprovals'] as Record<string, unknown>)['items'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(approvals.length, 0, 'the experiment concluded and the instance resumed — nothing pending');
  assert.ok(!approvals.some((item) => item['experimentId'] === experimentA1Running));

  // The risk posture follows too: the low-grade/operational counts are
  // unchanged (goal risk constraints grew by the new goal's declared
  // risk constraint — the fixture body carries one).
  const risks = after.body['risks'] as Record<string, unknown>;
  const summary = risks['summary'] as Record<string, number>;
  assert.equal(summary['goalRiskConstraintCount'], 2, 'the new goal declared its own risk constraint');
  assert.equal(summary['blockedInstanceCount'], 0);
  assert.equal(summary['failedExecutionCount'], 1);

  // And the mutations went through the AUTHORITIES' own mutation surfaces —
  // never the command center (read-only by construction; proven above).
  const postMutationRead = await getCommandCenter(agencyA, collaboratorA.token);
  assert.equal(postMutationRead.status, 200);
  assert.equal(
    ((postMutationRead.body['portfolioGoals'] as Record<string, unknown>)['goals'] as readonly unknown[]).length,
    4,
    'a second reader sees the same live state (no per-reader caching)',
  );
});
