/**
 * MKT-027 integration test — JOB-AC-04 (repeated visits preserve
 * relationship continuity subject to policy) as a WORKFLOW integration
 * test against real PostgreSQL + a real API subprocess: the repeated
 * visits arrive through the full governed path (Workflow instance →
 * Job projection → offer → acceptance → visit), and the continuity
 * chain is the DERIVED relationship history.
 *
 * Proves:
 *   - repeated visits for the SAME relationship (commissioning agency +
 *     client + target identity) link through the derived continuity
 *     chain: the second visit's lookup returns the first (completed)
 *     visit with its structured outcome, oldest first;
 *   - the chain is SUBJECT TO POLICY for the EXECUTING (accepted) agent:
 *     the gate consumes the agent's frozen /field-agents profile
 *     relationship-continuity block (the merged policy-data seam; the
 *     /policies authority is its declared successor). An opted-in agent
 *     ('preferred'/'required') sees the chain; an opted-out agent
 *     ('any'/prefersRepeatClients=false) gets the GATED view with NO
 *     prior-visit data;
 *   - the commissioning side (client-scope member) always sees the full
 *     chain — the client owns the data;
 *   - a DIFFERENT target identity is a different relationship (no chain);
 *   - a different CLIENT is a different relationship (no cross-tenant
 *     chain — uniform 404 for the foreign agent surface);
 *   - CANCELLED visits are not continuity history (only completed visits
 *     with their outcomes);
 *   - FOLLOW-UP: the second visit may declare the prior COMPLETED visit
 *     as its follow-up (same relationship only — DB-fenced); a
 *     non-completed or cross-relationship follow-up target is rejected;
 *   - continuity is DERIVED data that never rewrites history: the prior
 *     visit's row and outcome are byte-for-byte unchanged after lookups;
 *   - multiple completed visits accumulate oldest-first (visit 3 sees
 *     visits 1 and 2).
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
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
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

interface Principal {
  readonly token: string;
  readonly userId: string;
}

async function makeUser(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: PASSWORD },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { token: login.body['token'] as string, userId };
}

interface Tenant {
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@continuity.test`);
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${label}`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const client = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token: admin,
    body: { name: `Client ${label}` },
  });
  assert.equal(client.status, 201);
  const clientId = client.body['clientId'] as string;
  const workspace = await apiCall(port(), `/api/clients/${clientId}/workspaces`, {
    token: admin,
    body: { name: `Workspace ${label}` },
  });
  assert.equal(workspace.status, 201);
  const workspaceId = workspace.body['workspaceId'] as string;
  return { owner, agencyId, clientId, workspaceId };
}

function humanTaskNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'human_task',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: { required: true, approverPolicyRef: null },
    join: null,
    loop: null,
  };
}

function functionNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

function terminalNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'terminal',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string', description: null } }, required: [] },
    executionPolicyRef: null,
    retryPolicy: null,
    timeout: null,
    idempotencyKeyStrategy: null,
    humanApproval: null,
    join: null,
    loop: null,
  };
}

/**
 * The WORKFLOW leg of the JOB-AC-04 integration: one RUNNING instance of
 * a workflow whose human_task node projects into the Job. Every repeated
 * visit of the relationship arrives through its OWN governed instance →
 * projection → offer → acceptance.
 */
async function makeRunningInstance(tenant: Tenant): Promise<{ workflowId: string; instanceId: string }> {
  const workflow = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/workflows`, {
    token: tenant.owner.token,
    body: { name: `Workflow ${randomUUID().slice(0, 8)}`, description: '' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: {
      graph: {
        nodes: [functionNode('prep'), humanTaskNode('visit'), terminalNode('done')],
        edges: [
          { fromNode: 'prep', toNode: 'visit', edgeType: 'success', predicateRef: null, joinSemantics: null },
          { fromNode: 'visit', toNode: 'done', edgeType: 'success', predicateRef: null, joinSemantics: null },
        ],
      },
      inputSchema: { type: 'object', properties: {}, required: [] },
      outputSchema: { type: 'object', properties: {}, required: [] },
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const definitionId = created.body['workflowDefinitionId'] as string;
  let version = created.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: tenant.owner.token,
      method: 'PATCH',
      body: { status, version },
    });
    assert.equal(next.status, 200, JSON.stringify(next.body));
    version = next.body['version'] as number;
  }

  const instance = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${definitionId}/instances`,
    { token: tenant.owner.token, body: {} },
  );
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  const instanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/instances/${instanceId}/transitions`,
      {
        token: tenant.owner.token,
        body: { to, version: instanceVersion, idempotencyKey: `setup-${to}-${instanceId}` },
      },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }
  return { workflowId, instanceId };
}

async function projectJob(tenant: Tenant, instance: { workflowId: string; instanceId: string }): Promise<string> {
  const response = await apiCall(
    port(),
    `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/jobs`,
    {
      token: tenant.owner.token,
      body: {
        nodeId: 'visit',
        title: `Field visit job ${randomUUID().slice(0, 8)}`,
        description: 'Continuity relationship visit.',
        specialization: 'field_agent',
        requiredCapabilities: ['canvassing'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    },
  );
  assert.equal(response.status, 201, `projection failed: ${JSON.stringify(response.body)}`);
  return (response.body as Record<string, unknown>)['jobId'] as string;
}

async function makeAgent(
  email: string,
  continuity: 'any' | 'preferred' | 'required' = 'preferred',
): Promise<Principal & { agentId: string }> {
  const principal = await makeUser(email);
  const created = await apiCall(port(), '/api/field-agents', {
    token: principal.token,
    body: {
      specializations: ['field_agent'],
      capabilities: [{ skill: 'canvassing', level: 'advanced' }],
      availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
      location: { kind: 'city', value: 'accra' },
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: continuity !== 'any',
        continuity,
        maxConcurrentClientRelationships: 8,
      },
    },
  });
  assert.equal(created.status, 201, `agent profile creation failed: ${JSON.stringify(created.body)}`);
  return { ...principal, agentId: created.body['agentId'] as string };
}

/** The full governed path to an ACCEPTED job for one agent. */
async function makeAcceptedJob(
  tenant: Tenant,
  label: string,
  agent: Principal & { agentId: string },
): Promise<string> {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = (offer.body as Record<string, unknown>)['offerId'] as string;
  const accepted = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return jobId;
}

/** Appends evidence for the tenant's client through the /evidence API. */
async function appendEvidence(tenant: Tenant, label: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${tenant.clientId}/evidence`, {
    token: tenant.owner.token,
    body: {
      class: 'observation',
      sourceSystem: 'field-agent',
      sourceRef: label,
      observedAt: new Date().toISOString(),
      content: { note: `evidence for ${label}` },
      quality: 'C',
    },
  });
  assert.equal(response.status, 201, `evidence append failed: ${JSON.stringify(response.body)}`);
  return (response.body as Record<string, unknown>)['evidenceId'] as string;
}

/** Opens → starts → completes one visit with a structured outcome. */
async function executeVisit(
  tenant: Tenant,
  jobId: string,
  agent: Principal,
  targetIdentity: string,
  options: {
    readonly result?: 'succeeded' | 'partial' | 'no_contact' | 'failed';
    readonly followUpOfVisitId?: string;
  } = {},
): Promise<{ visitId: string; outcome: Record<string, unknown> }> {
  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: {
      targetIdentity,
      ...(options.followUpOfVisitId === undefined
        ? {}
        : { followUpOfVisitId: options.followUpOfVisitId }),
    },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const visitId = (opened.body as Record<string, unknown>)['visitId'] as string;
  const started = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const evidenceId = await appendEvidence(tenant, `visit-${visitId.slice(0, 8)}`);
  const completed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: options.result ?? 'succeeded',
      followUpRequired: options.result === 'no_contact',
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  return {
    visitId,
    outcome: (completed.body as Record<string, unknown>)['outcome'] as Record<string, unknown>,
  };
}

let tenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };
let otherTenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('fieldexeccont');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenant = await makeTenant('contalpha');
  otherTenant = await makeTenant('contbeta');
});

after(async () => {
  await db?.close();
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// JOB-AC-04 — repeated visits preserve relationship continuity
// (workflow integration: the full governed path)
// ---------------------------------------------------------------------------

test('JOB-AC-04: repeated visits for the same relationship link through the derived chain (workflow integration)', async () => {
  // ONE agent with a continuity preference (the policy input) serves the
  // SAME relationship (agency + client + target identity) across TWO
  // governed Jobs, each with its own RUNNING workflow instance.
  const agent = await makeAgent('continuity-a@continuity.test', 'preferred');
  const TARGET = 'venue:osu-relationship-1';

  const jobId1 = await makeAcceptedJob(tenant, 'cont-1', agent);
  const first = await executeVisit(tenant, jobId1, agent, TARGET, { result: 'succeeded' });

  const jobId2 = await makeAcceptedJob(tenant, 'cont-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  assert.equal(opened.status, 201);
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  // The ACCEPTED AGENT's continuity view: the chain is exposed (the agent
  // opted in — 'preferred'), and the prior visit carries its structured
  // outcome (JOB-AC-04 "repeated visits can preserve relationship
  // continuity").
  const agentView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: agent.token },
  );
  assert.equal(agentView.status, 200, JSON.stringify(agentView.body));
  const view = agentView.body as Record<string, unknown>;
  assert.equal(view['gated'], false, 'the opted-in agent sees the chain');
  assert.deepEqual(view['relationship'], {
    agencyId: tenant.agencyId,
    clientId: tenant.clientId,
    targetIdentity: TARGET,
  });
  const prior = view['priorVisits'] as Record<string, unknown>[];
  assert.equal(prior.length, 1, 'the prior completed visit is in the chain');
  assert.equal(prior[0]!['visitId'], first.visitId);
  assert.equal(prior[0]!['jobId'], jobId1);
  assert.equal(prior[0]!['status'], 'completed');
  const priorOutcome = prior[0]!['outcome'] as Record<string, unknown>;
  assert.equal(priorOutcome['result'], 'succeeded', 'the outcome is preserved in the chain');
  assert.equal(priorOutcome['evidenceRef'], first.outcome['evidenceRef']);

  // The COMMISSIONING side always sees the full chain (client scope owns
  // the data — the continuity data is not gated for the owner).
  const ownerView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: tenant.owner.token },
  );
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body['gated'], false);
  assert.equal((ownerView.body['priorVisits'] as unknown[]).length, 1);
});

test('JOB-AC-04: the continuity view is DERIVED data — the prior visit row and outcome are unchanged after lookups', async () => {
  const agent = await makeAgent('continuity-derived@continuity.test', 'required');
  const TARGET = 'venue:derived-relationship-2';

  const jobId1 = await makeAcceptedJob(tenant, 'derived-1', agent);
  const first = await executeVisit(tenant, jobId1, agent, TARGET);

  // Snapshot the prior visit row + outcome BEFORE the lookups.
  const visitBefore = await db!.query(
    `SELECT visit_id, job_id, visit_seq, status, target_identity, completed_at, version, updated_at
     FROM job_visits WHERE visit_id = $1`,
    [first.visitId],
  );
  const outcomeBefore = await db!.query(
    `SELECT visit_outcome_id, result, follow_up_required, notes, observations, evidence_ref,
            recorded_actor, correlation_id, submitted_by
     FROM job_visit_outcomes WHERE visit_id = $1`,
    [first.visitId],
  );

  const jobId2 = await makeAcceptedJob(tenant, 'derived-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  // Repeated lookups (agent + commissioning).
  for (const token of [agent.token, tenant.owner.token, agent.token]) {
    const view = await apiCall(port(), `/api/jobs/${jobId2}/visits/${visitId2}/continuity`, {
      token,
    });
    assert.equal(view.status, 200);
    assert.equal(view.body['gated'], token === agent.token ? false : false);
  }

  // The prior history is byte-for-byte unchanged (derived data never
  // rewrites history).
  const visitAfter = await db!.query(
    `SELECT visit_id, job_id, visit_seq, status, target_identity, completed_at, version, updated_at
     FROM job_visits WHERE visit_id = $1`,
    [first.visitId],
  );
  const outcomeAfter = await db!.query(
    `SELECT visit_outcome_id, result, follow_up_required, notes, observations, evidence_ref,
            recorded_actor, correlation_id, submitted_by
     FROM job_visit_outcomes WHERE visit_id = $1`,
    [first.visitId],
  );
  assert.deepEqual(visitAfter.rows, visitBefore.rows, 'the prior visit row is unchanged');
  assert.deepEqual(outcomeAfter.rows, outcomeBefore.rows, 'the prior outcome row is unchanged');
});

test('JOB-AC-04 SUBJECT TO POLICY: an opted-OUT agent is gated — the chain is NOT exposed to the executing agent', async () => {
  // The agent's frozen profile policy block says continuity 'any' (no
  // preference): the POLICY CHECKPOINT fails closed — the executing agent
  // gets the gated marker with NO prior-visit data.
  const optedOut = await makeAgent('continuity-any@continuity.test', 'any');
  const TARGET = 'venue:gated-relationship-3';

  const jobId1 = await makeAcceptedJob(tenant, 'gated-1', optedOut);
  await executeVisit(tenant, jobId1, optedOut, TARGET);

  const jobId2 = await makeAcceptedJob(tenant, 'gated-2', optedOut);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: optedOut.token,
    body: { targetIdentity: TARGET },
  });
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  const agentView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: optedOut.token },
  );
  assert.equal(agentView.status, 200);
  const view = agentView.body as Record<string, unknown>;
  assert.equal(view['gated'], true, 'the policy gate fails closed for the opted-out agent');
  assert.deepEqual(view['priorVisits'], [], 'the gated view carries NO prior-visit data');
  assert.ok(typeof view['gatedReason'] === 'string');

  // The COMMISSIONING side still sees the full chain — the policy gates
  // the AGENT surface, not the client's own data.
  const ownerView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: tenant.owner.token },
  );
  assert.equal(ownerView.status, 200);
  assert.equal(ownerView.body['gated'], false);
  assert.equal((ownerView.body['priorVisits'] as unknown[]).length, 1);
});

test('JOB-AC-04: a different target identity is a DIFFERENT relationship (no chain)', async () => {
  const agent = await makeAgent('continuity-target@continuity.test', 'preferred');

  const jobId1 = await makeAcceptedJob(tenant, 'target-1', agent);
  await executeVisit(tenant, jobId1, agent, 'venue:target-a');

  const jobId2 = await makeAcceptedJob(tenant, 'target-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:target-b' },
  });
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  const view = await apiCall(port(), `/api/jobs/${jobId2}/visits/${visitId2}/continuity`, {
    token: agent.token,
  });
  assert.equal(view.status, 200);
  assert.equal(view.body['gated'], false);
  assert.deepEqual(
    view.body['priorVisits'],
    [],
    'a different target identity has no continuity history',
  );
});

test('JOB-AC-04: a different CLIENT is a different relationship — no cross-tenant chain', async () => {
  const agent = await makeAgent('continuity-cross@continuity.test', 'preferred');
  const TARGET = 'venue:cross-tenant-4';

  // A completed visit for THIS tenant's relationship.
  const jobId1 = await makeAcceptedJob(tenant, 'cross-1', agent);
  await executeVisit(tenant, jobId1, agent, TARGET);

  // The same target identity under ANOTHER tenant's client.
  const jobId2 = await makeAcceptedJob(otherTenant, 'cross-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  const view = await apiCall(port(), `/api/jobs/${jobId2}/visits/${visitId2}/continuity`, {
    token: agent.token,
  });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body['priorVisits'], [], 'the chain never crosses clients');
  assert.deepEqual(view.body['relationship'], {
    agencyId: otherTenant.agencyId,
    clientId: otherTenant.clientId,
    targetIdentity: TARGET,
  });
});

test('JOB-AC-04: CANCELLED visits are not continuity history (only completed visits chain)', async () => {
  const agent = await makeAgent('continuity-cancelled@continuity.test', 'preferred');
  const TARGET = 'venue:cancelled-relationship-5';

  // A cancelled visit (never executed to completion).
  const jobId1 = await makeAcceptedJob(tenant, 'cancelled-1', agent);
  const opened1 = await apiCall(port(), `/api/jobs/${jobId1}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const cancelledVisitId = (opened1.body as Record<string, unknown>)['visitId'] as string;
  const cancelled = await apiCall(
    port(),
    `/api/jobs/${jobId1}/visits/${cancelledVisitId}/cancel`,
    { token: agent.token, body: { reason: 'rescheduled by contact' } },
  );
  assert.equal(cancelled.status, 200);

  const jobId2 = await makeAcceptedJob(tenant, 'cancelled-2', agent);
  const opened2 = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const visitId2 = (opened2.body as Record<string, unknown>)['visitId'] as string;

  const view = await apiCall(port(), `/api/jobs/${jobId2}/visits/${visitId2}/continuity`, {
    token: agent.token,
  });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body['priorVisits'], [], 'cancelled visits are not continuity history');
});

test('JOB-AC-04: multiple completed visits accumulate OLDEST-FIRST (visit 3 sees visits 1 and 2)', async () => {
  const agent = await makeAgent('continuity-multi@continuity.test', 'preferred');
  const TARGET = 'venue:multi-relationship-6';

  const jobId1 = await makeAcceptedJob(tenant, 'multi-1', agent);
  const visit1 = await executeVisit(tenant, jobId1, agent, TARGET, { result: 'no_contact' });

  const jobId2 = await makeAcceptedJob(tenant, 'multi-2', agent);
  const visit2 = await executeVisit(tenant, jobId2, agent, TARGET, { result: 'succeeded' });

  const jobId3 = await makeAcceptedJob(tenant, 'multi-3', agent);
  const opened3 = await apiCall(port(), `/api/jobs/${jobId3}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const visitId3 = (opened3.body as Record<string, unknown>)['visitId'] as string;

  const view = await apiCall(port(), `/api/jobs/${jobId3}/visits/${visitId3}/continuity`, {
    token: agent.token,
  });
  assert.equal(view.status, 200);
  const prior = view.body['priorVisits'] as Record<string, unknown>[];
  assert.equal(prior.length, 2);
  assert.equal(prior[0]!['visitId'], visit1.visitId, 'oldest first');
  assert.equal(prior[1]!['visitId'], visit2.visitId);
  assert.equal(
    (prior[0]!['outcome'] as Record<string, unknown>)['result'],
    'no_contact',
    'each prior visit carries its outcome',
  );
});

// ---------------------------------------------------------------------------
// FOLLOW-UP (the explicit causal link inside the relationship)
// ---------------------------------------------------------------------------

test('FOLLOW-UP: the next visit may declare the prior COMPLETED visit as its follow-up', async () => {
  const agent = await makeAgent('followup-a@continuity.test', 'preferred');
  const TARGET = 'venue:followup-relationship-7';

  const jobId1 = await makeAcceptedJob(tenant, 'followup-1', agent);
  const first = await executeVisit(tenant, jobId1, agent, TARGET, { result: 'no_contact' });

  // The follow-up visit (a NEW job for the same relationship) explicitly
  // links to the prior completed visit.
  const jobId2 = await makeAcceptedJob(tenant, 'followup-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET, followUpOfVisitId: first.visitId },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const visit = opened.body as Record<string, unknown>;
  assert.equal(visit['followUpOfVisitId'], first.visitId, 'the follow-up link is recorded');

  // The chain exposes the prior visit with its outcome (the follow-up
  // link lives on the CURRENT visit — asserted on the open response
  // above; the prior entry is the relationship history).
  const view = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${(visit['visitId'] as string)}/continuity`,
    { token: agent.token },
  );
  assert.equal(view.status, 200);
  const prior = view.body['priorVisits'] as Record<string, unknown>[];
  assert.equal(prior.length, 1);
  assert.equal(prior[0]!['visitId'], first.visitId);
  assert.equal(
    (prior[0]!['outcome'] as Record<string, unknown>)['result'],
    'no_contact',
    'the follow-up motivation is visible in the chain (the prior no-contact outcome)',
  );

  // The current visit's follow-up link round-trips through the read surface.
  const readBack = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${(visit['visitId'] as string)}`,
    { token: agent.token },
  );
  assert.equal(readBack.status, 200);
  assert.equal(
    (readBack.body as Record<string, unknown>)['followUpOfVisitId'],
    first.visitId,
    'the explicit follow-up link is durable on the visit record',
  );
});

test('FOLLOW-UP: a non-completed target is rejected; a cross-relationship target is the uniform 404', async () => {
  const agent = await makeAgent('followup-b@continuity.test', 'preferred');

  const jobId1 = await makeAcceptedJob(tenant, 'followup-3', agent);
  const opened1 = await apiCall(port(), `/api/jobs/${jobId1}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:followup-a' },
  });
  const plannedVisitId = (opened1.body as Record<string, unknown>)['visitId'] as string;

  // A PLANNED visit cannot be a follow-up target.
  const jobId2 = await makeAcceptedJob(tenant, 'followup-4', agent);
  const followPlanned = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:followup-a', followUpOfVisitId: plannedVisitId },
  });
  assert.equal(followPlanned.status, 409, 'follow-ups reference COMPLETED visits only');

  // A completed visit of a DIFFERENT relationship: the uniform 404 (no
  // existence oracle — indistinguishable from unknown).
  const jobId3 = await makeAcceptedJob(tenant, 'followup-5', agent);
  const other = await executeVisit(tenant, jobId3, agent, 'venue:followup-other');
  const followForeign = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: {
      targetIdentity: 'venue:followup-a',
      followUpOfVisitId: other.visitId,
    },
  });
  assert.equal(followForeign.status, 404, 'a different-relationship follow-up is the uniform 404');

  // A foreign tenant's visit: the SAME uniform 404.
  const otherAgent = await makeAgent('followup-foreign@continuity.test', 'preferred');
  const foreignJob = await makeAcceptedJob(otherTenant, 'followup-foreign', otherAgent);
  const foreign = await executeVisit(otherTenant, foreignJob, otherAgent, 'venue:followup-a');
  const followCrossTenant = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: {
      targetIdentity: 'venue:followup-a',
      followUpOfVisitId: foreign.visitId,
    },
  });
  assert.equal(followCrossTenant.status, 404, 'a cross-tenant follow-up is the uniform 404');

  // Unknown visit id: the uniform 404.
  const followUnknown = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: {
      targetIdentity: 'venue:followup-a',
      followUpOfVisitId: randomUUID(),
    },
  });
  assert.equal(followUnknown.status, 404);
});

test('the continuity surface is fenced to the authorized Job scope (strangers get the uniform 404)', async () => {
  const agent = await makeAgent('continuity-scope@continuity.test', 'preferred');
  const TARGET = 'venue:scope-relationship-8';

  const jobId1 = await makeAcceptedJob(tenant, 'scope-1', agent);
  await executeVisit(tenant, jobId1, agent, TARGET);

  const jobId2 = await makeAcceptedJob(tenant, 'scope-2', agent);
  const opened = await apiCall(port(), `/api/jobs/${jobId2}/visits`, {
    token: agent.token,
    body: { targetIdentity: TARGET },
  });
  const visitId2 = (opened.body as Record<string, unknown>)['visitId'] as string;

  const stranger = await makeUser('stranger-continuity@continuity.test');
  const strangerView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: stranger.token },
  );
  assert.equal(strangerView.status, 404);

  // A foreign agent (eligible pool member without this job) also gets 404.
  const foreignAgent = await makeAgent('continuity-foreign-agent@continuity.test', 'preferred');
  const foreignAgentView = await apiCall(
    port(),
    `/api/jobs/${jobId2}/visits/${visitId2}/continuity`,
    { token: foreignAgent.token },
  );
  assert.equal(foreignAgentView.status, 404);
});
