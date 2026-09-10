/**
 * MKT-026 integration test — OUTCOME SUBMISSION PROVENANCE (JOB-AC-03)
 * against real PostgreSQL + a real API subprocess.
 *
 * Proves:
 *   - JOB-AC-03: the accepted agent submits an outcome (succeeded | failed
 *     + payload reference + evidence reference); actor and evidence
 *     provenance are PRESERVED on the append-only outcome row:
 *     recorded_actor = the accepted agent's principal, recorded_via,
 *     correlation_id (from the request's ambient correlation context),
 *     causation_id = the job id, submitted_by, submitted_at — ALL
 *     server-derived (the DTO surface rejects every provenance-shaped
 *     key; provenance is a separate module-API argument);
 *   - the evidence reference is validated THROUGH the /evidence public
 *     contract: unknown, foreign and CROSS-CLIENT evidence ids are the
 *     SAME uniform 404 (a foreign evidence id is not a traversal oracle),
 *     and the migration-023 same-Client trigger is the DB backstop;
 *   - only the ACCEPTED agent submits: another eligible agent and the
 *     commissioning owner both get the uniform 404 (the commissioning
 *     side can never fabricate an outcome actor);
 *   - the outcome REPORT preserves the Task reference and the observed
 *     workflow instance status at report time (reported_instance_status)
 *     WITHOUT touching workflow state — the instance stays RUNNING and
 *     its transition history is untouched (Workflow authority preserved;
 *     Jobs report, never own);
 *   - UNKNOWN outcomes stay unresolved: a job with no submitted outcome
 *     has NO outcome row and the outcome read is a clean 404 (nothing is
 *     fabricated or defaulted);
 *   - exactly one outcome per job: a duplicate of the SAME logical
 *     submission converges (200, replayed=true, the ORIGINALLY recorded
 *     provenance — even under a different correlation id), while a
 *     DIFFERENT submission is a 409 (the append-only history can never be
 *     rewritten);
 *   - outcome reads: the commissioning member and the accepted agent see
 *     the full provenance record; unrelated callers get the uniform 404.
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
        description: 'Provenance probe job',
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

/** Appends one evidence record for the tenant's client through the /evidence API. */
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

/** Creates job + offer + acceptance and returns everything needed for outcome tests. */
async function makeAcceptedJob(tenant: Tenant, label: string): Promise<{
  instanceId: string;
  jobId: string;
  agent: Principal & { agentId: string };
  offerId: string;
}> {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent(`${label}@jobs.test`);
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
  return { instanceId: instance.instanceId, jobId, agent, offerId };
}

let tenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };
let otherTenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('jobsprovenance');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenant = await makeTenant('prov');
  otherTenant = await makeTenant('provother');
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
// JOB-AC-03 — provenance preservation
// ---------------------------------------------------------------------------

test('JOB-AC-03: the accepted agent submits an outcome and actor + evidence provenance are PRESERVED (server-derived)', async () => {
  const { instanceId, jobId, agent } = await makeAcceptedJob(tenant, 'provenance-agent');
  const evidenceId = await appendEvidence(tenant, 'outcome-evidence');
  const correlationId = randomUUID();

  const response = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    correlationId,
    body: {
      outcome: 'succeeded',
      payloadRef: 'object-store://outcomes/visit-report-1',
      evidenceRef: evidenceId,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const outcome = (response.body as Record<string, unknown>)['outcome'] as Record<string, unknown>;
  const provenance = outcome['provenance'] as Record<string, unknown>;

  // SERVER-DERIVED and PRESERVED provenance (JOB-AC-03):
  assert.equal(provenance['recordedActor'], `user:${agent.userId}`, 'the actor is the accepted agent principal');
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId, 'the ambient correlation context is preserved');
  assert.equal(provenance['causationId'], jobId, 'the job is the causation identity');
  assert.equal(provenance['submittedBy'], agent.userId, 'the accepted agent identity is preserved');
  assert.ok(typeof provenance['submittedAt'] === 'string');

  // The report context: the outcome references the Task and the OBSERVED
  // instance status at report time.
  assert.equal(outcome['outcome'], 'succeeded');
  assert.equal(outcome['payloadRef'], 'object-store://outcomes/visit-report-1');
  assert.equal(outcome['evidenceRef'], evidenceId);
  assert.equal(outcome['reportedInstanceStatus'], 'running');

  // The job moved accepted → outcome_submitted.
  const jobBody = (response.body as Record<string, unknown>)['job'] as Record<string, unknown>;
  assert.equal(jobBody['status'], 'outcome_submitted');

  // STORAGE truth: the append-only row carries exactly this provenance.
  const row = await db!.query(
    `SELECT outcome, payload_ref, evidence_ref, reported_instance_status, recorded_actor,
            recorded_via, correlation_id, causation_id, submitted_by
     FROM job_outcomes WHERE job_id = $1`,
    [jobId],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!['outcome'], 'succeeded');
  assert.equal(row.rows[0]!['recorded_actor'], `user:${agent.userId}`);
  assert.equal(row.rows[0]!['recorded_via'], 'api');
  assert.equal(row.rows[0]!['correlation_id'], correlationId);
  assert.equal(row.rows[0]!['causation_id'], jobId);
  assert.equal(row.rows[0]!['submitted_by'], agent.userId);

  // Workflow authority preserved: the instance is untouched by the report.
  const instanceRow = await db!.query(
    'SELECT status FROM workflow_instances WHERE workflow_instance_id = $1',
    [instanceId],
  );
  assert.equal(instanceRow.rows[0]!['status'], 'running', 'the report does not mutate workflow state');
});

test('JOB-AC-03: the outcome read surface exposes the preserved provenance to the commissioning member and the accepted agent', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'read-provenance');
  const evidenceId = await appendEvidence(tenant, 'read-evidence');
  const correlationId = randomUUID();
  const submitted = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    correlationId,
    body: { outcome: 'failed', evidenceRef: evidenceId },
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const recorded = (submitted.body as Record<string, unknown>)['outcome'] as Record<string, unknown>;

  for (const reader of [tenant.owner.token, agent.token]) {
    const read = await apiCall(port(), `/api/jobs/${jobId}/outcome`, { token: reader });
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, recorded, 'the outcome record (with provenance) round-trips exactly');
  }

  // Unrelated callers: uniform 404.
  const stranger = await makeUser('stranger-outcome@jobs.test');
  const strangerRead = await apiCall(port(), `/api/jobs/${jobId}/outcome`, { token: stranger.token });
  assert.equal(strangerRead.status, 404);
});

test('JOB-AC-03: UNKNOWN outcomes stay unresolved — no outcome row, a clean 404 read, nothing fabricated', async () => {
  const { jobId } = await makeAcceptedJob(tenant, 'unresolved-agent');
  // No outcome submitted.
  const read = await apiCall(port(), `/api/jobs/${jobId}/outcome`, { token: tenant.owner.token });
  assert.equal(read.status, 404, 'unresolved stays unresolved');
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_outcomes WHERE job_id = $1', [jobId]);
  assert.equal(rows.rows[0]!['n'], 0);
});

test('JOB-AC-03: only the ACCEPTED agent submits — other agents and the commissioning owner get the uniform 404', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'accepted-only');
  const evidenceId = await appendEvidence(tenant, 'accepted-only-evidence');
  const otherAgent = await makeAgent('not-accepted@jobs.test');

  const byOther = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: otherAgent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(byOther.status, 404, 'a different agent cannot submit the outcome');

  const byOwner = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: tenant.owner.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(byOwner.status, 404, 'the commissioning side can never fabricate an outcome actor');

  // The accepted agent still can.
  const byAccepted = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(byAccepted.status, 201);
});

test('evidence reference validation: unknown, foreign and CROSS-CLIENT evidence ids are the SAME uniform 404', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evidence-agent');
  const foreignEvidenceId = await appendEvidence(otherTenant, 'foreign-evidence');

  const unknown = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: randomUUID() },
  });
  assert.equal(unknown.status, 404, 'unknown evidence id → uniform 404');

  const foreign = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: foreignEvidenceId },
  });
  assert.equal(foreign.status, 404, 'cross-client evidence id → the SAME uniform 404 (no oracle)');

  const malformed = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: 'not-a-uuid' },
  });
  assert.equal(malformed.status, 422, 'a malformed evidence id is a DTO-shape rejection (422)');

  // Nothing was written by any rejected attempt.
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_outcomes WHERE job_id = $1', [jobId]);
  assert.equal(rows.rows[0]!['n'], 0);
});

test('JOB-AC-03 replay: the SAME logical submission converges with the ORIGINALLY recorded provenance; a DIFFERENT submission is a 409', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'replay-agent');
  const evidenceId = await appendEvidence(tenant, 'replay-evidence');
  const firstCorrelation = randomUUID();
  const secondCorrelation = randomUUID();

  const first = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    correlationId: firstCorrelation,
    body: {
      outcome: 'succeeded',
      payloadRef: 'object-store://outcomes/report-9',
      evidenceRef: evidenceId,
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstOutcome = (first.body as Record<string, unknown>)['outcome'] as Record<string, unknown>;

  // Duplicate delivery with the SAME logical content but a DIFFERENT
  // correlation id: converges to the recorded outcome (replayed=true), and
  // the ORIGINALLY recorded provenance is preserved (not the replay's).
  const replay = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    correlationId: secondCorrelation,
    body: {
      outcome: 'succeeded',
      payloadRef: 'object-store://outcomes/report-9',
      evidenceRef: evidenceId,
    },
  });
  assert.equal(replay.status, 200, 'the duplicate converges (200), never errors');
  assert.equal(replay.body['replayed'], true);
  const replayOutcome = (replay.body as Record<string, unknown>)['outcome'] as Record<string, unknown>;
  assert.deepEqual(
    replayOutcome,
    firstOutcome,
    'the replay returns the ORIGINALLY recorded outcome and provenance',
  );
  assert.equal(
    (replayOutcome['provenance'] as Record<string, unknown>)['correlationId'],
    firstCorrelation,
    'the originally recorded correlation is preserved — replays never rewrite history',
  );

  // Exactly one outcome row exists.
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_outcomes WHERE job_id = $1', [jobId]);
  assert.equal(rows.rows[0]!['n'], 1);

  // A DIFFERENT logical submission is a clean conflict (append-only).
  const different = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'failed', evidenceRef: evidenceId },
  });
  assert.equal(different.status, 409, JSON.stringify(different.body));
});

test('outcome submission is fail-closed: a non-accepted agent never reaches the submission surface', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent('state-gated@jobs.test');
  const evidenceId = await appendEvidence(tenant, 'state-gated-evidence');

  // The job is merely offered (no acceptance): the agent has no submission
  // surface (uniform 404 — not even the accepted agent yet).
  const beforeAcceptance = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(beforeAcceptance.status, 404);

  // After the round closes declined: a clean 409.
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: {
      candidateAgentId: agent.agentId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201);
  await apiCall(port(), `/api/jobs/${jobId}/offers/${(offer.body as Record<string, unknown>)['offerId']}/decline`, {
    token: agent.token,
    body: {},
  });
  const afterDeclined = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(
    afterDeclined.status,
    404,
    'a declined round leaves no accepted agent — the uniform 404 posture (fail closed)',
  );
});
