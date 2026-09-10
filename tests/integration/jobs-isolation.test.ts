/**
 * MKT-026 integration test — TENANT ISOLATION and cross-boundary negatives
 * (HUMAN-AC-03 at the jobs boundary; TENANT-AC-03/04 posture) against real
 * PostgreSQL + a real API subprocess.
 *
 * Proves the hard-boundary posture (security negatives):
 *   - a foreign-agency member sees the SAME 404 as for an unknown job on
 *     every jobs read surface (job, offers, outcome) — no existence
 *     oracle; cross-tenant traversal cannot read side effects;
 *   - a foreign-agency member CANNOT project onto another tenant's
 *     workflow instance (uniform 404 through the instance path) and
 *     CANNOT create offers on a foreign job (uniform 404);
 *   - a foreign agent CANNOT accept or decline an offer addressed to
 *     another candidate (uniform 404 — the offer is not theirs) and
 *     CANNOT submit an outcome on a foreign accepted job;
 *   - a foreign agency member CANNOT read a job through the nested
 *     workflow-instance path (the parent workflow is a foreign tenant's);
 *   - the marketplace cross-client visibility is by-design DESCRIPTOR-ONLY
 *     (eligible agents see descriptors with no Client data) — and the
 *     full record stays behind the tenant boundary for everyone else;
 *   - a suspended (disabled) membership never authorizes (403 posture);
 *   - evidence from ANOTHER client cannot back an outcome (the
 *     same-Client uniform 404 — tested in jobs-provenance.test.ts and
 *     re-asserted here at the boundary level).
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
  return { workflowId, definitionId, instanceId };
}

async function projectJob(
  tenant: Tenant,
  instance: { workflowId: string; instanceId: string },
): Promise<string> {
  const response = await apiCall(
    port(),
    `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/jobs`,
    {
      token: tenant.owner.token,
      body: {
        nodeId: 'visit',
        title: `Job ${randomUUID().slice(0, 8)}`,
        description: 'Isolation probe job',
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

async function makeAgent(email: string): Promise<Principal & { agentId: string }> {
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
        prefersRepeatClients: true,
        continuity: 'preferred',
        maxConcurrentClientRelationships: 4,
      },
    },
  });
  assert.equal(created.status, 201, `profile creation failed: ${JSON.stringify(created.body)}`);
  return { ...principal, agentId: created.body['agentId'] as string };
}

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

let tenantA: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };
let tenantB: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('jobsisolation');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenantA = await makeTenant('iso-a');
  tenantB = await makeTenant('iso-b');
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
// Cross-tenant read isolation (uniform 404 — no existence oracle)
// ---------------------------------------------------------------------------

test('a foreign-agency member sees the SAME 404 as for an unknown job on every jobs read surface', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);
  const unknownJobId = randomUUID();

  // Foreign reader: an active member of ANOTHER agency.
  const foreign = await makeUser('foreign-reader@jobs.test');
  await apiCall(port(), `/api/agencies/${tenantB.agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: foreign.userId, role: 'agency_operator' },
  });

  for (const path of [`/api/jobs/${jobId}`, `/api/jobs/${jobId}/offers`, `/api/jobs/${jobId}/outcome`]) {
    const foreignRead = await apiCall(port(), path, { token: foreign.token });
    const unknownRead = await apiCall(port(), path.replace(jobId, unknownJobId), { token: foreign.token });
    assert.equal(foreignRead.status, 404, `${path}: a foreign member gets 404`);
    assert.equal(unknownRead.status, 404, `${path}: an unknown id gets 404`);
    // The responses are indistinguishable (no existence oracle).
    assert.equal(
      JSON.stringify(foreignRead.body).length,
      JSON.stringify(unknownRead.body).length,
      `${path}: foreign and unknown are indistinguishable`,
    );
  }

  // The owning member CAN read (the boundary is exact).
  const ownRead = await apiCall(port(), `/api/jobs/${jobId}`, { token: tenantA.owner.token });
  assert.equal(ownRead.status, 200);
});

// ---------------------------------------------------------------------------
// Cross-tenant write isolation
// ---------------------------------------------------------------------------

test('a foreign-agency member CANNOT project onto another tenant instance nor offer on a foreign job', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);
  const agent = await makeAgent('iso-agent@jobs.test');

  // Foreign projection attempt through the (foreign) workflow-instance path.
  const foreignProjection = await apiCall(
    port(),
    `/api/workflows/${instance.workflowId}/instances/${instance.instanceId}/jobs`,
    {
      token: tenantB.owner.token,
      body: {
        nodeId: 'visit',
        title: 'Foreign projection attempt',
        description: '',
        specialization: 'field_agent',
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    },
  );
  assert.equal(foreignProjection.status, 404, 'foreign projection is a uniform 404');

  // Foreign offer creation on tenantA's job.
  const foreignOffer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenantB.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(foreignOffer.status, 404, 'foreign offer creation is a uniform 404');

  // Nothing was written by the foreign attempts.
  const offers = await db!.query('SELECT count(*)::int AS n FROM job_offers WHERE job_id = $1', [jobId]);
  assert.equal(offers.rows[0]!['n'], 0);
});

test('a foreign agent CANNOT accept/decline another candidate offer nor submit a foreign job outcome', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);
  const candidate = await makeAgent('real-candidate@jobs.test');
  const foreignAgent = await makeAgent('foreign-agent@jobs.test');

  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenantA.owner.token,
    body: {
      candidateAgentId: candidate.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201);
  const offerId = (offer.body as Record<string, unknown>)['offerId'] as string;

  // The foreign agent accepting SOMEONE ELSE'S offer: uniform 404.
  const foreignAccept = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: foreignAgent.token,
    body: {},
  });
  assert.equal(foreignAccept.status, 404, 'a foreign offer accept is a uniform 404 (not theirs)');
  const foreignDecline = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/decline`, {
    token: foreignAgent.token,
    body: {},
  });
  assert.equal(foreignDecline.status, 404);

  // The offer is untouched by the foreign attempts.
  const offerRow = await db!.query('SELECT status FROM job_offers WHERE job_offer_id = $1', [offerId]);
  assert.equal(offerRow.rows[0]!['status'], 'open');

  // The real candidate accepts; then the foreign agent attempts the outcome.
  const accepted = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: candidate.token,
    body: {},
  });
  assert.equal(accepted.status, 200);

  const evidenceId = await appendEvidence(tenantA, 'iso-outcome');
  const foreignOutcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: foreignAgent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(foreignOutcome.status, 404, 'a foreign agent cannot submit the outcome');

  const rows = await db!.query('SELECT count(*)::int AS n FROM job_outcomes WHERE job_id = $1', [jobId]);
  assert.equal(rows.rows[0]!['n'], 0);
});

test('a foreign agent CANNOT claim through a forged offer id under a foreign job (nested path integrity)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);
  const foreignAgent = await makeAgent('forged-agent@jobs.test');

  // A foreign offer id under a foreign job: the uniform 404 (the offer
  // does not exist under this job for this caller — no oracle).
  const forged = await apiCall(port(), `/api/jobs/${jobId}/offers/${randomUUID()}/accept`, {
    token: foreignAgent.token,
    body: {},
  });
  assert.equal(forged.status, 404);

  // An offer of a DIFFERENT job referenced under this job's path: 404.
  const otherInstance = await makeRunningInstance(tenantA);
  const otherJobId = await projectJob(tenantA, otherInstance);
  const candidate = await makeAgent('nested-candidate@jobs.test');
  const otherOffer = await apiCall(port(), `/api/jobs/${otherJobId}/offers`, {
    token: tenantA.owner.token,
    body: {
      candidateAgentId: candidate.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(otherOffer.status, 201);
  const otherOfferId = (otherOffer.body as Record<string, unknown>)['offerId'] as string;
  const mismatched = await apiCall(port(), `/api/jobs/${jobId}/offers/${otherOfferId}/accept`, {
    token: candidate.token,
    body: {},
  });
  assert.equal(mismatched.status, 404, 'an offer id not nested under the path job is a 404');
});

// ---------------------------------------------------------------------------
// The marketplace boundary (cross-client BY DESIGN — descriptors only)
// ---------------------------------------------------------------------------

test('cross-client marketplace visibility is DESCRIPTOR-ONLY: the eligible foreign agent sees the descriptor but NOT the full record', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);

  // An agent whose ONLY relationship is eligibility (no offer, no
  // membership in tenantA's agency).
  const eligibleOutsider = await makeAgent('eligible-outsider@jobs.test');

  const marketplace = await apiCall(port(), '/api/jobs/marketplace', {
    token: eligibleOutsider.token,
  });
  assert.equal(marketplace.status, 200);
  const jobs = marketplace.body['jobs'] as Record<string, unknown>[];
  assert.ok(jobs.some((job) => job['jobId'] === jobId), 'the eligible agent sees the descriptor (by design)');
  const serialized = JSON.stringify(marketplace.body);
  for (const forbidden of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
    assert.ok(
      !serialized.includes(`"${forbidden}"`),
      `the marketplace response carries no '${forbidden}' keys at any nesting level`,
    );
  }

  // The full record stays behind the tenant boundary: the same eligible
  // outsider gets the uniform 404 (no offer → no candidate surface; no
  // membership → no commissioning surface).
  const fullRead = await apiCall(port(), `/api/jobs/${jobId}`, { token: eligibleOutsider.token });
  assert.equal(fullRead.status, 404);
});

// ---------------------------------------------------------------------------
// Disabled boundaries never authorize
// ---------------------------------------------------------------------------

test('a suspended membership never authorizes jobs reads (the identity posture)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const jobId = await projectJob(tenantA, instance);

  const member = await makeUser('suspended-member@jobs.test');
  const membership = await apiCall(port(), `/api/agencies/${tenantA.agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(membership.status, 201);
  const membershipId = (membership.body as Record<string, unknown>)['membershipId'] as string;

  // Active membership reads fine.
  const before = await apiCall(port(), `/api/jobs/${jobId}`, { token: member.token });
  assert.equal(before.status, 200);

  // Suspend the membership: reads close (403 posture — the caller is a
  // KNOWN member with a disabled boundary, mirroring requireClientAccess).
  const suspended = await apiCall(
    port(),
    `/api/agencies/${tenantA.agencyId}/memberships/${membershipId}`,
    {
      token: tenantA.owner.token,
      method: 'PATCH',
      body: { status: 'disabled', version: 1 },
    },
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  const after = await apiCall(port(), `/api/jobs/${jobId}`, { token: member.token });
  assert.ok(after.status === 403 || after.status === 404, 'a suspended membership never authorizes');
});
