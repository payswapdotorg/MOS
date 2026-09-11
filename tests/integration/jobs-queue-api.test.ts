/**
 * MKT-031 integration test — the Field Agent work queue (UI-002; UI-AC-01..02
 * for field flows) against real PostgreSQL + a real API subprocess.
 *
 * Proves:
 *   - MY QUEUE (UI-AC-01 — authoritative state): the queue read returns the
 *     caller's OPEN offers (descriptor view, no Client data) and the jobs the
 *     caller ACCEPTED with live status and DERIVED obligations — the job
 *     outcome is due until submitted, open visits and evidence-due visits
 *     track the MKT-027 execution surface exactly, and the queue reflects
 *     state changes made through the DIRECT surfaces (the queue displays
 *     authoritative backend state; it never owns it);
 *   - TERRITORY/JOB DISCOVERY: the declared service areas round-trip and the
 *     matched jobs are the ELIGIBILITY-GATED descriptors (an ineligible
 *     profile sees nothing; descriptors carry no Client data);
 *   - ACCEPTANCE/DECLINE converge EXACTLY with the direct /jobs surface: the
 *     queue claim returns the same response shape and the same replay
 *     semantics (queue → direct replay and direct → queue replay both
 *     converge with replayed=true; ConflictError passes through as a clean
 *     409 — the losing candidate's claim is rejected by the SAME module
 *     decision, never a partial state);
 *   - UI-AC-02 (frontend bypass cannot change outcomes): the queue performs
 *     NO execution mutation — every obligation is satisfied through the
 *     existing direct surfaces, and the queue merely reflects it;
 *   - security posture: a foreign offer is the uniform 404 (no existence
 *     oracle) for BOTH claim surfaces; malformed/unknown identifiers are
 *     404; every authority-shaped DTO key is rejected with 422 before the
 *     module is reached; users without a Human Agent profile have no queue
 *     surface (403);
 *   - the queue acceptance lands in the append-only audit trail with the
 *     SAME action as the direct surface (one logical event).
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
  const owner = await makeUser(`${label}-owner@jobsqueue.test`);
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

/** Offers the given agent a job; returns the created offer id. */
async function offerTo(
  tenant: Tenant,
  jobId: string,
  agent: { agentId: string },
): Promise<string> {
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  return offer.body['offerId'] as string;
}

let tenantA: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('jobsqueue');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenantA = await makeTenant('alpha');
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
// MY QUEUE — the authoritative queue read (UI-AC-01)
// ---------------------------------------------------------------------------

test('MY QUEUE: the empty queue — agent summary only, no offers, no active jobs', async () => {
  const agent = await makeAgentWithProfile('empty-queue@jobsqueue.test');
  const queue = await apiCall(port(), '/api/jobs/queue', { token: agent.token });
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  const body = queue.body as Record<string, unknown>;
  const agentSummary = body['agent'] as Record<string, unknown>;
  assert.equal(agentSummary['agentId'], agent.agentId);
  assert.equal(agentSummary['authorizationState'], 'active');
  assert.deepEqual(agentSummary['territories'], []);
  assert.deepEqual(body['offers'], [], 'no offers yet');
  assert.deepEqual(body['activeJobs'], [], 'no accepted jobs yet');

  // A user without a Human Agent profile has no queue surface.
  const plain = await makeUser('plain-queue@jobsqueue.test');
  const forbidden = await apiCall(port(), '/api/jobs/queue', { token: plain.token });
  assert.equal(forbidden.status, 403);
});

test('MY QUEUE: the OPEN-offer decision queue carries the job DESCRIPTOR only (no Client data)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue offer probe' }));
  const agent = await makeAgentWithProfile('offer-queue@jobsqueue.test');
  const offerId = await offerTo(tenantA, job['jobId'] as string, agent);

  const queue = await apiCall(port(), '/api/jobs/queue', { token: agent.token });
  assert.equal(queue.status, 200);
  const body = queue.body as Record<string, unknown>;
  const offers = body['offers'] as Record<string, unknown>[];
  assert.equal(offers.length, 1);
  assert.equal(offers[0]!['offerId'], offerId);
  assert.equal(offers[0]!['status'], 'open');
  const jobView = offers[0]!['job'] as Record<string, unknown>;
  assert.equal(jobView['title'], 'Queue offer probe');
  const serialized = JSON.stringify(offers[0]);
  for (const forbiddenKey of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
    assert.ok(
      !serialized.includes(`"${forbiddenKey}"`),
      `the queue offer view must not carry '${forbiddenKey}' (descriptor view only)`,
    );
  }
  assert.deepEqual(body['activeJobs'], [], 'an open offer is not an execution obligation yet');
});

test('MY QUEUE: accepted jobs carry live status and DERIVED obligations that track the direct execution surfaces (UI-AC-01 + UI-AC-02)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue obligations probe' }));
  const jobId = job['jobId'] as string;
  const agent = await makeAgentWithProfile('obligations-queue@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, agent);

  // Accept through the QUEUE surface (the golden path).
  const accepted = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body['replayed'], false);
  const acceptedJob = accepted.body['job'] as Record<string, unknown>;
  assert.equal(acceptedJob['status'], 'accepted');
  assert.equal((acceptedJob['accepted'] as Record<string, unknown>)['agentId'], agent.agentId);
  // The full record is authorized for the winner (HUMAN-AC-03).
  assert.equal(acceptedJob['clientId'], tenantA.clientId);

  // The queue shows the accepted job with the outcome owed, no visits yet.
  const readQueue = async (): Promise<Record<string, unknown>[]> => {
    const queue = await apiCall(port(), '/api/jobs/queue', { token: agent.token });
    assert.equal(queue.status, 200);
    return (queue.body as Record<string, unknown>)['activeJobs'] as Record<string, unknown>[];
  };
  const jobs = await readQueue();
  assert.equal(jobs.length, 1);
  assert.equal((jobs[0]!['job'] as Record<string, unknown>)['jobId'], jobId);
  const obligations = jobs[0]!['obligations'] as Record<string, unknown>;
  assert.equal(obligations['jobOutcomeDue'], true, 'the accepted job still owes its outcome');
  assert.deepEqual(obligations['openVisitIds'], []);
  assert.deepEqual(obligations['evidenceDueVisitIds'], []);
  assert.deepEqual(jobs[0]!['visits'], []);

  // Execution flows through the DIRECT MKT-027 surface (UI-AC-02: the
  // queue displays authoritative state; the direct surfaces own the
  // mutations) and the queue obligations TRACK it.
  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:osu-branch-42' },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const visitId = opened.body['visitId'] as string;

  const withPlannedVisit = await readQueue();
  let obligationsNow = withPlannedVisit[0]!['obligations'] as Record<string, unknown>;
  assert.deepEqual(obligationsNow['openVisitIds'], [visitId], 'a planned visit is an open obligation');
  assert.deepEqual(
    obligationsNow['evidenceDueVisitIds'],
    [],
    'evidence is due only once execution is in progress',
  );

  const started = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));

  const withRunningVisit = await readQueue();
  obligationsNow = withRunningVisit[0]!['obligations'] as Record<string, unknown>;
  assert.deepEqual(obligationsNow['openVisitIds'], [visitId]);
  assert.deepEqual(obligationsNow['evidenceDueVisitIds'], [visitId], 'an in-progress visit with no evidence owes evidence');

  const captured = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'B',
      observedAt: new Date().toISOString(),
      content: { note: 'signed feedback form collected' },
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const evidenceId = captured.body['evidenceId'] as string;

  const withEvidence = await readQueue();
  obligationsNow = withEvidence[0]!['obligations'] as Record<string, unknown>;
  assert.deepEqual(obligationsNow['evidenceDueVisitIds'], [], 'captured evidence settles the evidence obligation');

  const completed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: 'Contact signed the feedback form.',
      observations: { forms_signed: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));

  const withDoneVisit = await readQueue();
  obligationsNow = withDoneVisit[0]!['obligations'] as Record<string, unknown>;
  assert.deepEqual(obligationsNow['openVisitIds'], [], 'the completed visit is no longer open');
  assert.equal(obligationsNow['jobOutcomeDue'], true, 'the job outcome is still owed');
  const visits = withDoneVisit[0]!['visits'] as Record<string, unknown>[];
  assert.equal(visits.length, 1);
  assert.equal(visits[0]!['status'], 'completed');
  assert.equal(visits[0]!['visitId'], visitId);

  // The job-level outcome settles the last obligation (direct surface).
  const outcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));

  const settled = await readQueue();
  obligationsNow = settled[0]!['obligations'] as Record<string, unknown>;
  assert.equal(obligationsNow['jobOutcomeDue'], false, 'a submitted outcome settles the job');
  assert.equal((settled[0]!['job'] as Record<string, unknown>)['status'], 'outcome_submitted');
  // The queue still lists the (terminal) job so the agent sees the final
  // authoritative state.
  assert.equal(settled.length, 1);
});

// ---------------------------------------------------------------------------
// TERRITORY/JOB DISCOVERY
// ---------------------------------------------------------------------------

test('DISCOVERY: declared service areas round-trip; matched jobs are the eligibility-gated descriptors', async () => {
  const instance = await makeRunningInstance(tenantA);
  await projectJob(tenantA, instance, projectionBody({ title: 'Discovery probe' }));
  const eligible = await makeAgentWithProfile('discovery-eligible@jobsqueue.test', {
    ...matchingFieldAgentProfile(),
    territories: [
      { kind: 'city', value: 'accra' },
      { kind: 'region', value: 'greater accra' },
    ],
  });
  const ineligible = await makeAgentWithProfile('discovery-ineligible@jobsqueue.test', {
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

  const discovery = await apiCall(port(), '/api/jobs/queue/discovery', { token: eligible.token });
  assert.equal(discovery.status, 200, JSON.stringify(discovery.body));
  const body = discovery.body as Record<string, unknown>;
  const serviceArea = body['serviceArea'] as Record<string, unknown>;
  assert.deepEqual(serviceArea['location'], { kind: 'city', value: 'accra' });
  assert.deepEqual(serviceArea['territories'], [
    { kind: 'city', value: 'accra' },
    { kind: 'region', value: 'greater accra' },
  ]);
  const jobs = body['jobs'] as Record<string, unknown>[];
  assert.equal(body['matched'], jobs.length);
  const descriptor = jobs.find((entry) => entry['title'] === 'Discovery probe');
  assert.ok(descriptor !== undefined, 'the eligible agent discovers the job');
  const serialized = JSON.stringify(descriptor);
  for (const forbiddenKey of ['clientId', 'agencyId', 'workspaceId', 'workflowInstanceId', 'nodeId']) {
    assert.ok(!serialized.includes(`"${forbiddenKey}"`), `the discovery view must not carry '${forbiddenKey}'`);
  }

  // The INELIGIBLE profile sees the service areas but NOT the job (the
  // existing marketplace gate — the queue adds no second matcher).
  const foreign = await apiCall(port(), '/api/jobs/queue/discovery', { token: ineligible.token });
  assert.equal(foreign.status, 200);
  const foreignJobs = (foreign.body as Record<string, unknown>)['jobs'] as Record<string, unknown>[];
  assert.equal(
    foreignJobs.find((entry) => entry['title'] === 'Discovery probe'),
    undefined,
    'the ineligible agent must not discover the job',
  );

  // No profile — no surface.
  const plain = await makeUser('discovery-plain@jobsqueue.test');
  const forbidden = await apiCall(port(), '/api/jobs/queue/discovery', { token: plain.token });
  assert.equal(forbidden.status, 403);
});

// ---------------------------------------------------------------------------
// ACCEPTANCE/DECLINE convergence with the direct surface
// ---------------------------------------------------------------------------

test('ACCEPT convergence: queue → direct replay converges (replayed=true) with the same response shape', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Convergence queue-first' }));
  const jobId = job['jobId'] as string;
  const agent = await makeAgentWithProfile('converge-a@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, agent);

  const viaQueue = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(viaQueue.status, 200, JSON.stringify(viaQueue.body));
  assert.equal(viaQueue.body['replayed'], false);
  const jobViaQueue = viaQueue.body['job'] as Record<string, unknown>;
  const offerViaQueue = viaQueue.body['offer'] as Record<string, unknown>;

  // The DIRECT surface now replays the SAME acceptance (convergence).
  const viaDirect = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(viaDirect.status, 200, JSON.stringify(viaDirect.body));
  assert.equal(viaDirect.body['replayed'], true, 'the direct surface replays the queue acceptance');
  assert.deepEqual(viaDirect.body['job'], jobViaQueue, 'identical job view on both surfaces');
  assert.deepEqual(viaDirect.body['offer'], offerViaQueue, 'identical offer view on both surfaces');

  // And the queue replays its own acceptance idempotently.
  const viaQueueAgain = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(viaQueueAgain.status, 200);
  assert.equal(viaQueueAgain.body['replayed'], true);
  assert.equal((viaQueueAgain.body['job'] as Record<string, unknown>)['status'], 'accepted');
});

test('ACCEPT convergence: direct → queue replay converges (replayed=true)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Convergence direct-first' }));
  const jobId = job['jobId'] as string;
  const agent = await makeAgentWithProfile('converge-b@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, agent);

  const viaDirect = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(viaDirect.status, 200, JSON.stringify(viaDirect.body));
  assert.equal(viaDirect.body['replayed'], false);

  const viaQueue = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(viaQueue.status, 200, JSON.stringify(viaQueue.body));
  assert.equal(viaQueue.body['replayed'], true, 'the queue replays the direct acceptance');
  assert.deepEqual(viaQueue.body['job'], viaDirect.body['job']);
  assert.deepEqual(viaQueue.body['offer'], viaDirect.body['offer']);
});

test('ACCEPT conflict passthrough: the losing candidate claim is a clean 409 (the module decides, never a partial state)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue conflict probe' }));
  const jobId = job['jobId'] as string;
  const winner = await makeAgentWithProfile('conflict-winner@jobsqueue.test');
  const loser = await makeAgentWithProfile('conflict-loser@jobsqueue.test');
  const winnerOffer = await offerTo(tenantA, jobId, winner);
  const loserOffer = await offerTo(tenantA, jobId, loser);

  const first = await apiCall(port(), `/api/jobs/queue/offers/${winnerOffer}/accept`, {
    token: winner.token,
    body: {},
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await apiCall(port(), `/api/jobs/queue/offers/${loserOffer}/accept`, {
    token: loser.token,
    body: {},
  });
  assert.equal(
    second.status,
    409,
    `the losing claim must conflict through the queue: ${JSON.stringify(second.body)}`,
  );
  // Exactly one winner — the durable state is not partial.
  const row = await db!.query('SELECT status, accepted_user_id FROM jobs WHERE job_id = $1', [jobId]);
  assert.equal(row.rows[0]!['status'], 'accepted');
  assert.equal(row.rows[0]!['accepted_user_id'], winner.userId);
});

test('DECLINE from the queue: per-offer right, replay convergence, terminal offers can never claim', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue decline probe' }));
  const jobId = job['jobId'] as string;
  const agent = await makeAgentWithProfile('decline-queue@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, agent);

  const declined = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/decline`, {
    token: agent.token,
    body: {},
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  assert.equal(declined.body['replayed'], false);
  assert.equal((declined.body['offer'] as Record<string, unknown>)['status'], 'declined');
  // The round's last open offer was declined with no winner → the Job
  // closes 'declined' (never affects the underlying Task).
  assert.equal((declined.body['job'] as Record<string, unknown>)['status'], 'declined');

  const replay = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/decline`, {
    token: agent.token,
    body: {},
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body['replayed'], true, 'repeated decline converges idempotently');

  const reclaim = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(reclaim.status, 409, 'a declined offer can never later claim');

  // The declined job left the execution queue (the round closed).
  const queue = await apiCall(port(), '/api/jobs/queue', { token: agent.token });
  assert.equal(queue.status, 200);
  const activeJobs = (queue.body as Record<string, unknown>)['activeJobs'] as Record<string, unknown>[];
  assert.equal(activeJobs.length, 0);
});

test('DECLINE conflict: an accepted offer cannot be declined from the queue (the claim stands)', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Decline-after-accept probe' }));
  const agent = await makeAgentWithProfile('decline-late@jobsqueue.test');
  const offerId = await offerTo(tenantA, job['jobId'] as string, agent);

  const accepted = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(accepted.status, 200);

  const declined = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/decline`, {
    token: agent.token,
    body: {},
  });
  assert.equal(declined.status, 409, 'the accepted claim stands — decline conflicts');
});

// ---------------------------------------------------------------------------
// Security posture (the uniform 404 + §23 authority-field rejection)
// ---------------------------------------------------------------------------

test('the uniform 404: a foreign offer, an unknown identifier and a malformed identifier are indistinguishable on BOTH claim surfaces', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Uniform 404 probe' }));
  const jobId = job['jobId'] as string;
  const owner = await makeAgentWithProfile('foreign-owner@jobsqueue.test');
  const intruder = await makeAgentWithProfile('foreign-intruder@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, owner);

  // The intruder cannot claim the foreign offer through the queue.
  const queueAccept = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: intruder.token,
    body: {},
  });
  assert.equal(queueAccept.status, 404);
  const queueDecline = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/decline`, {
    token: intruder.token,
    body: {},
  });
  assert.equal(queueDecline.status, 404);

  // ... nor through the direct surface (identical posture).
  const directAccept = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, {
    token: intruder.token,
    body: {},
  });
  assert.equal(directAccept.status, 404);

  // Unknown and malformed identifiers are the same 404.
  const unknown = await apiCall(port(), `/api/jobs/queue/offers/${randomUUID()}/accept`, {
    token: intruder.token,
    body: {},
  });
  assert.equal(unknown.status, 404);
  const malformed = await apiCall(port(), '/api/jobs/queue/offers/not-a-uuid/accept', {
    token: intruder.token,
    body: {},
  });
  assert.equal(malformed.status, 404);
});

test('DTO rejection: the queue claim surfaces reject every authority-shaped key (§23) before the module is reached', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue DTO probe' }));
  const agent = await makeAgentWithProfile('dto-queue@jobsqueue.test');
  const offerId = await offerTo(tenantA, job['jobId'] as string, agent);

  for (const authorityField of [
    'status',
    'candidateUserId',
    'candidateAgentId',
    'jobId',
    'offerId',
    'version',
    'provenance',
    'recordedActor',
    'correlationId',
    'causationId',
    'clientId',
    'agencyId',
    'workspaceId',
  ]) {
    for (const surface of ['accept', 'decline']) {
      const response = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/${surface}`, {
        token: agent.token,
        body: { [authorityField]: 'injected' },
      });
      assert.equal(
        response.status,
        422,
        `the authority field ${authorityField} must be rejected on ${surface}: ${JSON.stringify(response.body)}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Audit trail (one logical event, regardless of the surface)
// ---------------------------------------------------------------------------

test('a queue acceptance lands in the append-only audit trail with the SAME action as the direct surface', async () => {
  const instance = await makeRunningInstance(tenantA);
  const job = await projectJob(tenantA, instance, projectionBody({ title: 'Queue audit probe' }));
  const jobId = job['jobId'] as string;
  const agent = await makeAgentWithProfile('audit-queue@jobsqueue.test');
  const offerId = await offerTo(tenantA, jobId, agent);

  const accepted = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(accepted.status, 200);

  const audit = await db!.query(
    `SELECT action, client_id FROM audit_events
     WHERE target_id IN ($1, $2) ORDER BY recorded_at`,
    [jobId, offerId],
  );
  const actions = audit.rows.map((row) => row['action'] as string);
  assert.ok(actions.includes('jobs.offer.accepted'), 'the queue acceptance is audited');
  assert.ok(actions.includes('jobs.task.projected'), 'the projection is audited');
  assert.ok(actions.includes('jobs.offer.created'), 'the offer creation is audited');
  for (const row of audit.rows) {
    assert.equal(row['client_id'], tenantA.clientId, 'audit rows carry the job client scope');
  }
  // One logical acceptance — one audit row (the queue replay does not
  // duplicate the event).
  const replay = await apiCall(port(), `/api/jobs/queue/offers/${offerId}/accept`, {
    token: agent.token,
    body: {},
  });
  assert.equal(replay.status, 200);
  const acceptanceRows = await db!.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'jobs.offer.accepted'`,
    [offerId],
  );
  assert.equal(acceptanceRows.rows[0]!['n'], 1, 'the replayed acceptance converges to one audit row');
});
