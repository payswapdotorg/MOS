/**
 * MKT-026 integration test — the Job marketplace boundary (JOB-001,
 * JOB-AC-01 and the API-surface contract) against real PostgreSQL + a
 * real API subprocess.
 *
 * Proves:
 *   - JOB-AC-01: a Job is a governed PROJECTION of ONE Task — the
 *     projection references the workflow-authoritative instance + node,
 *     the scope chain is SERVER-DERIVED from the instance (every Job is
 *     scoped to exactly one commissioning Agency and Client), a second
 *     projection of the SAME Task is rejected by the DB task key (409),
 *     and only human_task nodes of RUNNING instances project (non-human
 *     nodes 422, non-running instances 409, unknown identifiers uniform
 *     404);
 *   - DB backstops (real PostgreSQL, direct SQL): the scope-chain trigger
 *     rejects a job whose scope is not the instance's scope; the
 *     task-reference trigger rejects a non-human_task node and a
 *     non-running instance; the frozen job state machine rejects illegal
 *     status rewrites and terminal rows are frozen;
 *   - the descriptor carries NO Client data: the marketplace listing is
 *     ELIGIBILITY-GATED (§3: only eligible agents receive descriptors,
 *     and the descriptors contain no client/agency/workspace/task
 *     identifiers);
 *   - offer creation requires an ELIGIBLE candidate (evaluated BEFORE any
 *     offer is exposed — 409 for ineligible candidates), a bounded future
 *     expiry, and the open-offer-per-candidate fence;
 *   - DTO authority-field rejection on every mutation surface (§23): the
 *     path-derived task reference, scope keys and every provenance-shaped
 *     key are rejected with 422;
 *   - the role posture: only agency owners/admins project Tasks and
 *     create offers; any ACTIVE member reads; agents act only on their
 *     own offers/outcomes;
 *   - every material mutation is audited (append-only /audit rows).
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

/** A tenant: owner principal + agency + client + workspace. */
interface Tenant {
  readonly owner: Principal;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string;
}

async function makeTenant(label: string): Promise<Tenant> {
  const owner = await makeUser(`${label}-owner@jobs.test`);
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

function definitionBody(): Record<string, unknown> {
  return {
    graph: {
      nodes: [humanTaskNode('visit'), functionNode('prep'), terminalNode('done')],
      edges: [
        { fromNode: 'prep', toNode: 'visit', edgeType: 'success', predicateRef: null, joinSemantics: null },
        { fromNode: 'visit', toNode: 'done', edgeType: 'success', predicateRef: null, joinSemantics: null },
      ],
    },
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'object', properties: {}, required: [] },
  };
}

/** Creates a workflow with an ACTIVE definition and a RUNNING instance. */
async function makeRunningInstance(tenant: Tenant): Promise<{
  workflowId: string;
  definitionId: string;
  instanceId: string;
}> {
  const workflow = await apiCall(port(), `/api/workspaces/${tenant.workspaceId}/workflows`, {
    token: tenant.owner.token,
    body: { name: `Workflow ${randomUUID().slice(0, 8)}`, description: '' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const created = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: tenant.owner.token,
    body: definitionBody(),
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

  // draft → ready → running.
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
  return { workflowId, definitionId, instanceId };
}

function projectionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    nodeId: 'visit',
    title: 'Field visit — downtown venues',
    description: 'Visit the listed venues and collect signed feedback forms.',
    specialization: 'field_agent',
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    dayOfWeek: 2,
    startMinute: 540,
    endMinute: 1020,
    ...overrides,
  };
}

async function projectJob(
  tenant: Tenant,
  instance: { workflowId: string; instanceId: string },
  body: Record<string, unknown> = projectionBody(),
): Promise<Record<string, unknown>> {
  const response = await apiCall(
    port(),
    `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/jobs`,
    { token: tenant.owner.token, body },
  );
  assert.equal(response.status, 201, `projection failed: ${JSON.stringify(response.body)}`);
  return response.body as Record<string, unknown>;
}

/** A complete field-agent profile declaration matching the job spec. */
function matchingFieldAgentProfile(): Record<string, unknown> {
  return {
    specializations: ['field_agent'],
    capabilities: [{ skill: 'canvassing', level: 'advanced' }],
    availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1080 }],
    location: { kind: 'city', value: 'accra' },
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: true,
      continuity: 'preferred',
      maxConcurrentClientRelationships: 4,
    },
  };
}

async function makeAgentWithProfile(
  email: string,
  declaration: Record<string, unknown> = matchingFieldAgentProfile(),
): Promise<Principal & { agentId: string }> {
  const principal = await makeUser(email);
  const created = await apiCall(port(), '/api/field-agents', {
    token: principal.token,
    body: declaration,
  });
  assert.equal(created.status, 201, `agent profile creation failed: ${JSON.stringify(created.body)}`);
  return { ...principal, agentId: created.body['agentId'] as string };
}

let tenantA: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };
let instanceA: { workflowId: string; definitionId: string; instanceId: string } | null = null;

before(async () => {
  stack = await bootStack('jobsapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  const tenant = await makeTenant('alpha');
  tenantA = tenant;
  instanceA = await makeRunningInstance(tenantA);
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
// JOB-AC-01 — the governed Task projection
// ---------------------------------------------------------------------------

test('JOB-AC-01: a Job is a projection of ONE governed Task with a server-derived scope chain', async () => {
  assert.ok(instanceA !== null);
  const job = await projectJob(tenantA, instanceA);

  assert.equal(job['workflowInstanceId'], instanceA.instanceId, 'the Job references the workflow-authoritative instance');
  assert.equal(job['nodeId'], 'visit', 'the Job references the human_task node of the pinned definition');
  assert.equal(job['clientId'], tenantA.clientId, 'scope is server-derived from the instance owner chain');
  assert.equal(job['agencyId'], tenantA.agencyId);
  assert.equal(job['workspaceId'], tenantA.workspaceId);
  assert.equal(job['status'], 'projected');
  assert.equal(job['version'], 1);
  assert.equal(job['createdBy'], tenantA.owner.userId, 'provenance is server-derived from the principal');
  assert.equal(job['title'], 'Field visit — downtown venues');
  assert.deepEqual(job['eligibility'], {
    specialization: 'field_agent',
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    availability: { dayOfWeek: 2, startMinute: 540, endMinute: 1020 },
  });

  // The scope chain is DB-fenced: read the raw row and verify it equals
  // the instance scope (JOB-AC-01 database proof).
  const row = await db!.query(
    'SELECT workspace_id, client_id, agency_id FROM jobs WHERE job_id = $1',
    [job['jobId'] as string],
  );
  const scopeRow = await db!.query(
    'SELECT workspace_id, client_id, agency_id FROM workflow_instances WHERE workflow_instance_id = $1',
    [instanceA.instanceId],
  );
  assert.deepEqual(row.rows[0], scopeRow.rows[0], 'the job scope row equals the instance scope row exactly');

  // Read back through the API (commissioning member).
  const read = await apiCall(port(), `/api/jobs/${job['jobId']}`, { token: tenantA.owner.token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, job, 'the persisted job round-trips exactly');
});

test('JOB-AC-01: ONE Job per Task — a second projection of the same Task is rejected by the DB task key', async () => {
  assert.ok(instanceA !== null);
  // instanceA's 'visit' node is already projected by the previous test.
  const duplicate = await apiCall(
    port(),
    `/api/workflows/${instanceA.workflowId}/instances/${instanceA.instanceId}/jobs`,
    { token: tenantA.owner.token, body: projectionBody({ title: 'Second projection attempt' }) },
  );
  assert.equal(duplicate.status, 409, `duplicate projection must conflict: ${JSON.stringify(duplicate.body)}`);
  // Exactly ONE job row exists for the task occurrence.
  const rows = await db!.query(
    'SELECT count(*)::int AS n FROM jobs WHERE workflow_instance_id = $1 AND node_id = $2',
    [instanceA.instanceId, 'visit'],
  );
  assert.equal(rows.rows[0]!['n'], 1);
});

test('JOB-AC-01: only human_task nodes project — a function node is rejected (422)', async () => {
  assert.ok(instanceA !== null);
  const response = await apiCall(
    port(),
    `/api/workflows/${instanceA.workflowId}/instances/${instanceA.instanceId}/jobs`,
    { token: tenantA.owner.token, body: projectionBody({ nodeId: 'prep' }) },
  );
  assert.equal(response.status, 422, JSON.stringify(response.body));
});

test('JOB-AC-01: unknown nodes and unknown instances are a uniform 404', async () => {
  assert.ok(instanceA !== null);
  const unknownNode = await apiCall(
    port(),
    `/api/workflows/${instanceA.workflowId}/instances/${instanceA.instanceId}/jobs`,
    { token: tenantA.owner.token, body: projectionBody({ nodeId: 'does-not-exist' }) },
  );
  assert.equal(unknownNode.status, 404);

  const unknownInstance = await apiCall(
    port(),
    `/api/workflows/${instanceA.workflowId}/instances/${randomUUID()}/jobs`,
    { token: tenantA.owner.token, body: projectionBody() },
  );
  assert.equal(unknownInstance.status, 404);
});

test('JOB-AC-01: a non-RUNNING instance does not project (409 — the Task work is not live)', async () => {
  const instance = await makeRunningInstance(tenantA);
  // Terminalize: running → cancelled.
  await apiCall(port(), `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/transitions`, {
    token: tenantA.owner.token,
    body: { to: 'cancelled', version: 3, idempotencyKey: `cancel-${instance.instanceId}` },
  });
  const response = await apiCall(
    port(),
    `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/jobs`,
    { token: tenantA.owner.token, body: projectionBody() },
  );
  assert.equal(response.status, 409, JSON.stringify(response.body));
});

test('JOB-AC-01 DB backstops: scope mismatch, non-human node and illegal status are rejected under direct SQL', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);

  // (a) The scope-chain trigger: a job row whose client scope does not
  // equal the instance scope is rejected.
  const other = await makeTenant('scopeprobe');
  await assert.rejects(
    db!.query(
      `INSERT INTO jobs (job_id, workflow_instance_id, node_id, workspace_id, client_id, agency_id,
                         title, description, eligibility, created_by)
       VALUES ($1, $2, 'visit', $3, $4, $5, 'scope probe', '', '{}', NULL)`,
      [randomUUID(), instance.instanceId, other.workspaceId, other.clientId, other.agencyId],
    ),
    /does not belong to client|scope/i,
    'the scope-chain trigger rejects a cross-scope job row',
  );

  // (b) The task-reference trigger: a non-human_task node cannot project.
  await assert.rejects(
    db!.query(
      `INSERT INTO jobs (job_id, workflow_instance_id, node_id, workspace_id, client_id, agency_id,
                         title, description, eligibility, created_by)
       VALUES ($1, $2, 'prep', $3, $4, $5, 'node probe', '', '{}', NULL)`,
      [randomUUID(), instance.instanceId, tenantA.workspaceId, tenantA.clientId, tenantA.agencyId],
    ),
    /human_task/i,
    'the task-reference trigger rejects a non-human task node',
  );

  // (c) The frozen state machine: a projected → accepted jump is rejected
  // (skip-edge), and terminal rows are frozen.
  const created = await db!.query(
    `INSERT INTO jobs (job_id, workflow_instance_id, node_id, workspace_id, client_id, agency_id,
                       title, description, eligibility, created_by)
     VALUES ($1, $2, 'visit', $3, $4, $5, 'state probe', '', '{}', NULL) RETURNING job_id`,
    [randomUUID(), instance.instanceId, tenantA.workspaceId, tenantA.clientId, tenantA.agencyId],
  );
  const probeJobId = created.rows[0]!['job_id'] as string;
  await assert.rejects(
    db!.query(`UPDATE jobs SET status = 'accepted' WHERE job_id = $1`, [probeJobId]),
    /illegal job transition/i,
    'the projected → accepted skip-edge is DB-rejected',
  );
  await db!.query(`UPDATE jobs SET status = 'offered' WHERE job_id = $1`, [probeJobId]);
  await db!.query(`UPDATE jobs SET status = 'expired' WHERE job_id = $1`, [probeJobId]);
  await assert.rejects(
    db!.query(`UPDATE jobs SET status = 'offered' WHERE job_id = $1`, [probeJobId]),
    /terminal/i,
    'a terminal job row is frozen',
  );
});

// ---------------------------------------------------------------------------
// The marketplace surface (§3 — eligibility-gated access)
// ---------------------------------------------------------------------------

test('§3: the marketplace returns DESCRIPTORS to ELIGIBLE agents only — with NO Client data at any nesting level', async () => {
  assert.ok(instanceA !== null);
  const eligibleAgent = await makeAgentWithProfile('eligible-agent@jobs.test');
  const ineligibleAgent = await makeAgentWithProfile(
    'ineligible-agent@jobs.test',
    {
      specializations: ['chatter'],
      capabilities: [{ skill: 'community_reply', level: null }],
      availability: [{ dayOfWeek: 0, startMinute: 0, endMinute: 480 }],
      location: null,
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: false,
        continuity: 'any',
        maxConcurrentClientRelationships: null,
      },
    },
  );

  const forEligible = await apiCall(port(), '/api/jobs/marketplace', { token: eligibleAgent.token });
  assert.equal(forEligible.status, 200);
  const jobs = forEligible.body['jobs'] as Record<string, unknown>[];
  assert.ok(jobs.length >= 1, 'the eligible agent sees the projected job');
  const descriptor = jobs.find((job) => job['title'] === 'Field visit — downtown venues');
  assert.ok(descriptor !== undefined, 'the projected job descriptor is present');

  // The descriptor carries the minimum data only: NO client/agency/
  // workspace/task identifiers, no acceptance bookkeeping.
  const serialized = JSON.stringify(descriptor);
  for (const forbidden of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId', 'accepted']) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `the marketplace descriptor must not carry '${forbidden}' (Client data after the eligibility gate only)`,
    );
  }
  assert.equal(descriptor!['status'], 'projected');
  assert.deepEqual(descriptor!['eligibility'], {
    specialization: 'field_agent',
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    availability: { dayOfWeek: 2, startMinute: 540, endMinute: 1020 },
  });

  // The INELIGIBLE agent does not see the job AT ALL (eligibility is
  // evaluated BEFORE any Client data is exposed — fail closed).
  const forIneligible = await apiCall(port(), '/api/jobs/marketplace', { token: ineligibleAgent.token });
  assert.equal(forIneligible.status, 200);
  const ineligibleJobs = forIneligible.body['jobs'] as Record<string, unknown>[];
  assert.equal(
    ineligibleJobs.find((job) => job['title'] === 'Field visit — downtown venues'),
    undefined,
    'the ineligible agent must not receive the job descriptor',
  );

  // A user without a Human Agent profile has no marketplace surface.
  const plainUser = await makeUser('plain-user@jobs.test');
  const noProfile = await apiCall(port(), '/api/jobs/marketplace', { token: plainUser.token });
  assert.equal(noProfile.status, 403);
});

test('§3: the agent read surface — the ACCEPTED agent reads the full job; an unrelated agent gets the uniform 404', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Agent visibility probe' }));
  const agent = await makeAgentWithProfile('visibility-agent@jobs.test');

  // Unaccepted (just an unrelated agent so far): uniform 404.
  const before = await apiCall(port(), `/api/jobs/${job['jobId']}`, { token: agent.token });
  assert.equal(before.status, 404);

  // Create an offer and accept it through the module flow.
  const offer = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: agent.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const accepted = await apiCall(
    port(),
    `/api/jobs/${job['jobId']}/offers/${offer.body['offerId']}/accept`,
    { token: agent.token, body: {} },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  // The accepted agent now reads the FULL record (the authorized scope).
  const after = await apiCall(port(), `/api/jobs/${job['jobId']}`, { token: agent.token });
  assert.equal(after.status, 200);
  assert.equal((after.body as Record<string, unknown>)['clientId'], tenantA.clientId);
  assert.equal(
    ((after.body as Record<string, unknown>)['accepted'] as Record<string, unknown>)['agentId'],
    agent.agentId,
  );
});

// ---------------------------------------------------------------------------
// Offer creation (job-offer-v1.2) — eligibility before exposure
// ---------------------------------------------------------------------------

test('offer creation: only ELIGIBLE candidates receive offers (evaluated BEFORE any exposure); the commissioning role is enforced', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Eligibility probe' }));

  const eligible = await makeAgentWithProfile('eligible-offer@jobs.test');
  const ineligible = await makeAgentWithProfile('ineligible-offer@jobs.test', {
    specializations: ['chatter'],
    capabilities: [{ skill: 'community_reply', level: null }],
    availability: [{ dayOfWeek: 0, startMinute: 0, endMinute: 480 }],
    location: null,
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: null,
    },
  });

  const good = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: eligible.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(good.status, 201, JSON.stringify(good.body));
  assert.equal(good.body['status'], 'open');
  assert.equal(good.body['candidateAgentId'], eligible.agentId);
  assert.equal(good.body['candidateUserId'], eligible.userId, 'the candidate user link is server-derived');

  const bad = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: ineligible.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(bad.status, 409, `ineligible candidates cannot be offered: ${JSON.stringify(bad.body)}`);

  // The job moved projected → offered with the first offer.
  const read = await apiCall(port(), `/api/jobs/${job['jobId']}`, { token: tenantA.owner.token });
  assert.equal((read.body as Record<string, unknown>)['status'], 'offered');

  // Role posture: an agency OPERATOR (non-owner/admin) cannot create offers.
  const operator = await makeUser('operator-offer@jobs.test');
  await apiCall(port(), `/api/agencies/${tenantA.agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: operator.userId, role: 'agency_operator' },
  });
  const forbiddenRole = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: operator.token,
    body: { candidateAgentId: eligible.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(forbiddenRole.status, 403, JSON.stringify(forbiddenRole.body));

  // Duplicate OPEN offer for the same candidate is DB-fenced (409).
  const duplicate = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: eligible.agentId, expiresAt: new Date(Date.now() + 7200_000).toISOString() },
  });
  assert.equal(duplicate.status, 409);
});

test('offer creation: expiry must be a bounded future timestamp; unknown candidates/roles fail closed', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Expiry probe' }));
  const agent = await makeAgentWithProfile('expiry-agent@jobs.test');

  const past = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  });
  assert.equal(past.status, 422);

  const malformed = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: agent.agentId, expiresAt: 'not-a-timestamp' },
  });
  assert.equal(malformed.status, 422);

  const unknownCandidate = await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: randomUUID(), expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(unknownCandidate.status, 404);

  const unknownJob = await apiCall(port(), `/api/jobs/${randomUUID()}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: agent.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(unknownJob.status, 404);
});

test('the candidate offers surface: the caller sees ONLY their own offers (descriptor view, no Client data)', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Own offers probe' }));
  const mine = await makeAgentWithProfile('mine-offers@jobs.test');
  const other = await makeAgentWithProfile('other-offers@jobs.test');

  await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: mine.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });

  const own = await apiCall(port(), '/api/jobs/offers', { token: mine.token });
  assert.equal(own.status, 200);
  const offers = own.body['offers'] as Record<string, unknown>[];
  assert.equal(offers.length, 1);
  const offerView = offers[0]!['job'] as Record<string, unknown>;
  assert.equal(offerView['title'], 'Own offers probe');
  const serialized = JSON.stringify(offers[0]);
  for (const forbidden of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
    assert.ok(!serialized.includes(`"${forbidden}"`), `the candidate offer view must not carry '${forbidden}'`);
  }

  const others = await apiCall(port(), '/api/jobs/offers', { token: other.token });
  assert.equal(others.status, 200);
  assert.equal((others.body['offers'] as unknown[]).length, 0, 'foreign offers are not visible at all');
});

// ---------------------------------------------------------------------------
// §23 authority-field rejection (DTO negative tests)
// ---------------------------------------------------------------------------

test('DTO rejection: the projection surface rejects the path-derived task reference and every scope key', async () => {
  assert.ok(instanceA !== null);
  for (const authorityField of ['workflowInstanceId', 'jobId', 'status', 'clientId', 'agencyId', 'workspaceId', 'version', 'createdBy']) {
    const response = await apiCall(
      port(),
      `/api/workflows/${instanceA.workflowId}/instances/${instanceA.instanceId}/jobs`,
      { token: tenantA.owner.token, body: projectionBody({ [authorityField]: 'injected' }) },
    );
    assert.equal(response.status, 422, `the authority field ${authorityField} must be rejected`);
  }
});

test('DTO rejection: the outcome surface rejects every provenance-shaped key (JOB-AC-03 posture)', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'DTO outcome probe' }));
  const agent = await makeAgentWithProfile('dto-outcome@jobs.test');
  const offer = (
    await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
      token: tenantA.owner.token,
      body: { candidateAgentId: agent.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    })
  ).body as Record<string, unknown>;
  const accepted = await apiCall(
    port(),
    `/api/jobs/${job['jobId']}/offers/${offer['offerId']}/accept`,
    { token: agent.token, body: {} },
  );
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));

  // The caller IS the accepted agent: the authorize step passes and the
  // validation step rejects every provenance-shaped key BEFORE the module
  // is reached (the server derives all of these — §23).
  for (const provenanceKey of [
    'recordedActor',
    'recordedVia',
    'correlationId',
    'causationId',
    'provenance',
    'submittedBy',
    'submittedAt',
    'jobOutcomeId',
  ]) {
    const response = await apiCall(port(), `/api/jobs/${job['jobId']}/outcome`, {
      token: agent.token,
      body: { outcome: 'succeeded', evidenceRef: randomUUID(), [provenanceKey]: 'injected' },
    });
    assert.equal(
      response.status,
      422,
      `the provenance-shaped key ${provenanceKey} must be rejected before any traversal`,
    );
  }
});

test('DTO rejection: accept/decline reject authority fields; malformed job/offer identifiers are uniform 404s', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'DTO claim probe' }));
  const agent = await makeAgentWithProfile('dto-claim@jobs.test');
  const offer = (
    await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
      token: tenantA.owner.token,
      body: { candidateAgentId: agent.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    })
  ).body as Record<string, unknown>;

  const injected = await apiCall(
    port(),
    `/api/jobs/${job['jobId']}/offers/${offer['offerId']}/accept`,
    { token: agent.token, body: { status: 'accepted', candidateUserId: agent.userId } },
  );
  assert.equal(injected.status, 422, 'authority fields are rejected on the claim surface');

  const malformed = await apiCall(port(), `/api/jobs/not-a-uuid/offers/${offer['offerId']}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(malformed.status, 404);
});

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

test('every material jobs mutation lands in the append-only audit trail', async () => {
  assert.ok(instanceA !== null);
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Audit probe' }));
  const agent = await makeAgentWithProfile('audit-agent@jobs.test');
  await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, {
    token: tenantA.owner.token,
    body: { candidateAgentId: agent.agentId, expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  // The offer id from the listing:
  const offers = (
    await apiCall(port(), `/api/jobs/${job['jobId']}/offers`, { token: tenantA.owner.token })
  ).body['offers'] as Record<string, unknown>[];
  const offerId = offers[0]!['offerId'] as string;
  await apiCall(port(), `/api/jobs/${job['jobId']}/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });

  const audit = await db!.query(
    `SELECT action, target_type, client_id FROM audit_events
     WHERE target_id IN ($1, $2) ORDER BY recorded_at`,
    [job['jobId'] as string, offerId],
  );
  const actions = audit.rows.map((row) => row['action'] as string);
  assert.ok(actions.includes('jobs.task.projected'));
  assert.ok(actions.includes('jobs.offer.created'));
  assert.ok(actions.includes('jobs.offer.accepted'));
  for (const row of audit.rows) {
    assert.equal(row['client_id'], tenantA.clientId, 'audit rows carry the job client scope');
  }
});
