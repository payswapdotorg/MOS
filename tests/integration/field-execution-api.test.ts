/**
 * MKT-027 integration test — the field-execution surface (visit
 * lifecycle, structured outcomes, evidence capture) against real
 * PostgreSQL + a real API subprocess.
 *
 * Proves:
 *   - the visit lifecycle: the ACCEPTED agent opens/starts/completes a
 *     visit; the scope chain is INHERITED from the Job (server-derived);
 *     the per-job visit sequence advances; the transition history is
 *     append-only with full provenance;
 *   - JOB-AC-03 (field subset): the structured visit outcome preserves
 *     actor + evidence provenance (SERVER-DERIVED: recorded_actor,
 *     recorded_via, correlation, causation, submitted_by, submitted_at)
 *     on the append-only one-per-visit row — API response AND the raw
 *     PostgreSQL row; UNKNOWN outcomes stay unresolved (no row, clean
 *     404); the job-level MKT-026 state machine is never touched by
 *     field execution;
 *   - the authorization posture: only the ACCEPTED agent
 *     opens/transitions/captures (a foreign agent, the commissioning
 *     owner and strangers get the uniform 404 — no existence oracle);
 *     reads use the full-job posture (commissioning member | accepted
 *     agent); the acceptance window guards OPENING (a job whose outcome
 *     was submitted accepts no new visits);
 *   - EVID-AC-01 (field subset): captured evidence records carry source
 *     (system 'field-agent'), the observation timestamp, provenance
 *     (actor/recordedVia/correlation/causation) and traceable content —
 *     read back through the /evidence authority API and the raw row;
 *   - EVID-AC-02 (field subset): captured evidence is append-only (direct
 *     SQL UPDATE/DELETE rejected by the migration-015 triggers); visit
 *     outcomes and capture links are append-only (migration 024
 *     triggers); terminal visit rows are frozen;
 *   - EVID-AC-03 (field subset): a CLAIM submitted from the field stays a
 *     claim — the class and tier are read back unchanged, and NO surface
 *     can promote it;
 *   - the frozen visit state machine: completion requires in_progress
 *     (no skip-edges), replays converge, different submissions conflict,
 *     a completed visit can never be cancelled, a cancelled visit never
 *     restarts;
 *   - evidence reference validation: unknown, foreign and CROSS-CLIENT
 *     evidence ids are the SAME uniform 404; material-shaped observation
 *     keys are rejected (§21);
 *   - DTO authority-field rejection on every mutation surface (§23);
 *   - DB backstops (real PostgreSQL, direct SQL): the scope-chain
 *     trigger rejects a visit whose scope is not the job scope; the
 *     acceptance-window trigger rejects visits on non-ACCEPTED jobs;
 *     illegal status rewrites and terminal rows are rejected; the
 *     follow-up fence rejects cross-relationship links.
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
  const owner = await makeUser(`${label}-owner@fieldexec.test`);
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
      nodes: [functionNode('prep'), humanTaskNode('visit'), terminalNode('done')],
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
async function makeRunningInstance(tenant: Tenant): Promise<{ workflowId: string; instanceId: string }> {
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
        description: 'Visit the listed venues and collect signed feedback forms.',
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
        maxConcurrentClientRelationships: 4,
      },
    },
  });
  assert.equal(created.status, 201, `agent profile creation failed: ${JSON.stringify(created.body)}`);
  return { ...principal, agentId: created.body['agentId'] as string };
}

/** Appends one evidence record for the tenant's client through the /evidence API (commissioning side). */
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

/** Job + offer + acceptance: the field-execution starting point. */
async function makeAcceptedJob(
  tenant: Tenant,
  label: string,
  agentContinuity: 'any' | 'preferred' | 'required' = 'preferred',
): Promise<{ jobId: string; agent: Principal & { agentId: string } }> {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent(`${label}@fieldexec.test`, agentContinuity);
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
  return { jobId, agent };
}

let tenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };
let otherTenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('fieldexecapi');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenant = await makeTenant('fealpha');
  otherTenant = await makeTenant('febeta');
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
// The visit lifecycle + scope inheritance
// ---------------------------------------------------------------------------

test('the accepted agent opens a visit with the scope chain INHERITED from the Job', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'lifecycle');
  const correlationId = randomUUID();

  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    correlationId,
    body: { targetIdentity: 'venue:osu-branch-42' },
  });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  const visit = opened.body as Record<string, unknown>;
  const visitId = visit['visitId'] as string;

  assert.equal(visit['jobId'], jobId);
  assert.equal(visit['visitSeq'], 1, 'the first visit of the job is sequence 1');
  assert.equal(visit['status'], 'planned');
  assert.equal(visit['targetIdentity'], 'venue:osu-branch-42');
  assert.equal(visit['workspaceId'], tenant.workspaceId, 'scope INHERITED from the job (server-derived)');
  assert.equal(visit['clientId'], tenant.clientId);
  assert.equal(visit['agencyId'], tenant.agencyId);
  assert.equal(visit['createdBy'], agent.userId, 'the open actor is the accepted agent');

  // Open-event provenance (SERVER-DERIVED and PRESERVED).
  const provenance = visit['provenance'] as Record<string, unknown>;
  assert.equal(provenance['recordedActor'], `user:${agent.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId, 'the ambient correlation is preserved');
  assert.equal(provenance['causationId'], jobId, 'the job is the causation identity');
  assert.ok(typeof provenance['recordedAt'] === 'string');

  // STORAGE truth: the row carries the inherited scope + provenance.
  const row = await db!.query(
    `SELECT job_id, visit_seq, workspace_id, client_id, agency_id, target_identity, status,
            created_by, recorded_actor, recorded_via, correlation_id, causation_id
     FROM job_visits WHERE visit_id = $1`,
    [visitId],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!['job_id'], jobId);
  assert.equal(row.rows[0]!['visit_seq'], 1);
  assert.equal(row.rows[0]!['client_id'], tenant.clientId);
  assert.equal(row.rows[0]!['status'], 'planned');
  assert.equal(row.rows[0]!['recorded_actor'], `user:${agent.userId}`);
  assert.equal(row.rows[0]!['recorded_via'], 'api');
  assert.equal(row.rows[0]!['correlation_id'], correlationId);
  assert.equal(row.rows[0]!['causation_id'], jobId);
});

test('start moves planned → in_progress with an append-only provenance-carrying history', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'start');
  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:kaneshie-market-7' },
  });
  assert.equal(opened.status, 201);
  const visitId = (opened.body as Record<string, unknown>)['visitId'] as string;

  const startCorrelation = randomUUID();
  const started = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    correlationId: startCorrelation,
    body: {},
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const body = started.body as Record<string, unknown>;
  assert.equal((body['visit'] as Record<string, unknown>)['status'], 'in_progress');
  assert.equal(body['replayed'], false);

  // Repeated start converges (idempotent replay).
  const restart = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(restart.status, 200);
  assert.equal(restart.body['replayed'], true);

  // The transition history is append-only with provenance: exactly ONE
  // planned → in_progress row (the replay re-recorded nothing).
  const history = await db!.query(
    `SELECT from_status, to_status, recorded_actor, recorded_via, correlation_id
     FROM job_visit_transitions WHERE visit_id = $1 ORDER BY created_at`,
    [visitId],
  );
  assert.equal(history.rows.length, 1, 'the replay does not duplicate history');
  assert.equal(history.rows[0]!['from_status'], 'planned');
  assert.equal(history.rows[0]!['to_status'], 'in_progress');
  assert.equal(history.rows[0]!['recorded_actor'], `user:${agent.userId}`);
  assert.equal(history.rows[0]!['correlation_id'], startCorrelation);

  // The visit row advanced to in_progress with started_at set.
  const row = await db!.query(
    'SELECT status, started_at FROM job_visits WHERE visit_id = $1',
    [visitId],
  );
  assert.equal(row.rows[0]!['status'], 'in_progress');
  assert.ok(row.rows[0]!['started_at'] !== null);
});

test('per-job visit sequence advances (a second visit of the same job is sequence 2)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'seq');
  const first = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:circle-2' },
  });
  assert.equal(first.status, 201);
  assert.equal((first.body as Record<string, unknown>)['visitSeq'], 1);

  const second = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:circle-2' },
  });
  assert.equal(second.status, 201);
  assert.equal((second.body as Record<string, unknown>)['visitSeq'], 2);

  const list = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: tenant.owner.token,
  });
  assert.equal(list.status, 200);
  const visits = (list.body as Record<string, unknown>)['visits'] as unknown[];
  assert.equal(visits.length, 2);
});

// ---------------------------------------------------------------------------
// JOB-AC-03 (field subset) — the structured outcome preserves provenance
// ---------------------------------------------------------------------------

test('JOB-AC-03: the structured visit outcome preserves actor + evidence provenance (API + raw row)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'outcome');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:madina-stall-11' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });

  // Evidence captured from the field DURING the visit (the agent surface).
  const captured = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { forms_signed: 3, contact_present: true },
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const capturedEvidenceId = (captured.body as Record<string, unknown>)['evidenceId'] as string;

  const outcomeCorrelation = randomUUID();
  const completed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    correlationId: outcomeCorrelation,
    body: {
      result: 'succeeded',
      followUpRequired: true,
      notes: 'Contact signed the feedback form; a second drop-off is needed.',
      observations: { forms_signed: 3, footfall_estimate: 42 },
      evidenceRef: capturedEvidenceId,
    },
  });
  assert.equal(completed.status, 201, JSON.stringify(completed.body));
  const body = completed.body as Record<string, unknown>;
  assert.equal((body['visit'] as Record<string, unknown>)['status'], 'completed');
  const outcome = body['outcome'] as Record<string, unknown>;

  assert.equal(outcome['result'], 'succeeded');
  assert.equal(outcome['followUpRequired'], true);
  assert.deepEqual(outcome['observations'], { forms_signed: 3, footfall_estimate: 42 });
  assert.equal(outcome['evidenceRef'], capturedEvidenceId);

  // SERVER-DERIVED and PRESERVED provenance (JOB-AC-03 field subset).
  const provenance = outcome['provenance'] as Record<string, unknown>;
  assert.equal(provenance['recordedActor'], `user:${agent.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], outcomeCorrelation);
  assert.equal(provenance['causationId'], jobId);
  assert.equal(provenance['submittedBy'], agent.userId);
  assert.ok(typeof provenance['submittedAt'] === 'string');

  // STORAGE truth: the append-only row carries exactly this provenance.
  const row = await db!.query(
    `SELECT result, follow_up_required, notes, observations, evidence_ref,
            recorded_actor, recorded_via, correlation_id, causation_id, submitted_by
     FROM job_visit_outcomes WHERE visit_id = $1`,
    [visitId],
  );
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0]!['result'], 'succeeded');
  assert.equal(row.rows[0]!['follow_up_required'], true);
  assert.deepEqual(row.rows[0]!['observations'], { forms_signed: 3, footfall_estimate: 42 });
  assert.equal(row.rows[0]!['evidence_ref'], capturedEvidenceId);
  assert.equal(row.rows[0]!['recorded_actor'], `user:${agent.userId}`);
  assert.equal(row.rows[0]!['recorded_via'], 'api');
  assert.equal(row.rows[0]!['correlation_id'], outcomeCorrelation);
  assert.equal(row.rows[0]!['causation_id'], jobId);
  assert.equal(row.rows[0]!['submitted_by'], agent.userId);

  // The job state machine was NEVER touched by field execution: the job
  // is still 'accepted' (the MKT-026 outcome submission is its own surface).
  const jobRow = await db!.query('SELECT status FROM jobs WHERE job_id = $1', [jobId]);
  assert.equal(jobRow.rows[0]!['status'], 'accepted');

  // The completion transition is recorded in the append-only history.
  const history = await db!.query(
    'SELECT from_status, to_status FROM job_visit_transitions WHERE visit_id = $1 ORDER BY created_at',
    [visitId],
  );
  assert.equal(history.rows.length, 2, 'start + complete');
  assert.equal(history.rows[1]!['from_status'], 'in_progress');
  assert.equal(history.rows[1]!['to_status'], 'completed');
});

test('JOB-AC-03: UNKNOWN visit outcomes stay unresolved — no row, a clean 404, nothing fabricated', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'unresolved');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:tema-4' },
    })).body as Record<string, unknown>
  )['visitId'] as string;

  const read = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/outcome`, {
    token: tenant.owner.token,
  });
  assert.equal(read.status, 404, 'unresolved stays unresolved');
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_visit_outcomes WHERE visit_id = $1', [visitId]);
  assert.equal(rows.rows[0]!['n'], 0);
});

test('completion replay: the SAME logical submission converges with the ORIGINALLY recorded provenance; a DIFFERENT submission is a 409', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'replay');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:achimota-9' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const evidenceId = await appendEvidence(tenant, 'visit-replay-evidence');

  const firstCorrelation = randomUUID();
  const first = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    correlationId: firstCorrelation,
    body: {
      result: 'no_contact',
      followUpRequired: true,
      notes: 'Contact absent.',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const firstOutcome = (first.body as Record<string, unknown>)['outcome'] as Record<string, unknown>;

  // Duplicate delivery with the same logical content, a different
  // correlation id: converges to the recorded outcome.
  const replay = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    correlationId: randomUUID(),
    body: {
      result: 'no_contact',
      followUpRequired: true,
      notes: 'Contact absent.',
      // Same content, keys in a different order: SEMANTIC equality.
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(replay.status, 200, 'the duplicate converges (200), never errors');
  assert.equal(replay.body['replayed'], true);
  assert.deepEqual(
    replay.body['outcome'],
    firstOutcome,
    'the replay returns the ORIGINALLY recorded outcome and provenance',
  );
  assert.equal(
    ((replay.body['outcome'] as Record<string, unknown>)['provenance'] as Record<string, unknown>)['correlationId'],
    firstCorrelation,
    'the originally recorded correlation is preserved — replays never rewrite history',
  );

  // Exactly one outcome row.
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_visit_outcomes WHERE visit_id = $1', [visitId]);
  assert.equal(rows.rows[0]!['n'], 1);

  // A DIFFERENT logical submission is a clean conflict (append-only).
  const different = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'partial',
      followUpRequired: false,
      notes: 'Contact absent.',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(different.status, 409, JSON.stringify(different.body));
});

// ---------------------------------------------------------------------------
// The frozen visit state machine (negative paths)
// ---------------------------------------------------------------------------

test('completion requires IN-PROGRESS: a planned visit cannot complete (no skip-edges)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'skipedge');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:adenta-1' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  const evidenceId = await appendEvidence(tenant, 'skipedge-evidence');

  const response = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));

  // Nothing was written (the outcome row exists only with the transition).
  const rows = await db!.query('SELECT count(*)::int AS n FROM job_visit_outcomes WHERE visit_id = $1', [visitId]);
  assert.equal(rows.rows[0]!['n'], 0);
  const statusRow = await db!.query('SELECT status FROM job_visits WHERE visit_id = $1', [visitId]);
  assert.equal(statusRow.rows[0]!['status'], 'planned');
});

test('cancel converges idempotently; a COMPLETED visit can never be cancelled (the outcome stands)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'cancel');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:legon-3' },
    })).body as Record<string, unknown>
  )['visitId'] as string;

  const cancelled = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/cancel`, {
    token: agent.token,
    body: { reason: 'contact asked to reschedule' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal((cancelled.body['visit'] as Record<string, unknown>)['status'], 'cancelled');

  const reCancel = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/cancel`, {
    token: agent.token,
    body: {},
  });
  assert.equal(reCancel.status, 200);
  assert.equal(reCancel.body['replayed'], true, 'repeated cancel converges');

  // A cancelled visit never restarts and never completes.
  const restart = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: {},
  });
  assert.equal(restart.status, 409);
  const evidenceId = await appendEvidence(tenant, 'cancel-evidence');
  const complete = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(complete.status, 409, 'terminal visits are frozen');
});

test('a completed visit can never be cancelled after the fact (frozen terminal history)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'frozen');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:dzorwulu-5' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const evidenceId = await appendEvidence(tenant, 'frozen-evidence');
  const completed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(completed.status, 201);

  const cancelAfterComplete = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/cancel`, {
    token: agent.token,
    body: { reason: 'attempt to erase history' },
  });
  assert.equal(cancelAfterComplete.status, 409, 'the completed outcome stands');
});

// ---------------------------------------------------------------------------
// Authorization posture (uniform 404s; acceptance window)
// ---------------------------------------------------------------------------

test('only the ACCEPTED agent opens/transitions visits — foreign agents, the commissioning owner and strangers get the uniform 404', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'authz');
  const otherAgent = await makeAgent('foreign-agent@fieldexec.test');
  const stranger = await makeUser('stranger-visits@fieldexec.test');

  for (const token of [otherAgent.token, tenant.owner.token, stranger.token]) {
    const open = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token,
      body: { targetIdentity: 'venue:authz-1' },
    });
    assert.equal(open.status, 404, `open by a non-accepted caller must be the uniform 404 (got ${open.status})`);
  }

  // The accepted agent opens; the others cannot even start it.
  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:authz-1' },
  });
  assert.equal(opened.status, 201);
  const visitId = (opened.body as Record<string, unknown>)['visitId'] as string;

  for (const token of [otherAgent.token, tenant.owner.token, stranger.token]) {
    const start = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
      token,
      body: {},
    });
    assert.equal(start.status, 404, `start by a non-accepted caller must be the uniform 404 (got ${start.status})`);
    const evidence = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
      token,
      body: {
        class: 'observation',
        quality: 'C',
        observedAt: new Date().toISOString(),
        content: { x: 1 },
      },
    });
    assert.equal(evidence.status, 404, 'the commissioning side can never fabricate field evidence actors');
  }

  // Nothing was written by any rejected attempt.
  const rows = await db!.query(
    'SELECT count(*)::int AS n FROM job_visit_evidence WHERE visit_id = $1',
    [visitId],
  );
  assert.equal(rows.rows[0]!['n'], 0);
});

test('reads use the full-job posture: the commissioning member and the accepted agent read; strangers and CROSS-TENANT owners get the uniform 404', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'reads');
  const opened = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:reads-1' },
  });
  const visitId = (opened.body as Record<string, unknown>)['visitId'] as string;

  for (const token of [tenant.owner.token, agent.token]) {
    const read = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}`, { token });
    assert.equal(read.status, 200);
    const list = await apiCall(port(), `/api/jobs/${jobId}/visits`, { token });
    assert.equal(list.status, 200);
  }

  // A stranger AND the owner of ANOTHER tenant: the SAME uniform 404 (no
  // cross-tenant oracle — the identifiers are indistinguishable).
  const stranger = await makeUser('stranger-read@fieldexec.test');
  const strangerRead = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}`, {
    token: stranger.token,
  });
  assert.equal(strangerRead.status, 404);
  const foreignOwnerRead = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}`, {
    token: otherTenant.owner.token,
  });
  assert.equal(foreignOwnerRead.status, 404);
  const foreignContinuity = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/continuity`, {
    token: otherTenant.owner.token,
  });
  assert.equal(foreignContinuity.status, 404, 'the continuity surface is cross-tenant fenced too');
});

test('the acceptance window guards OPENING: a job whose outcome was submitted accepts no new visits', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'window');
  // Submit the MKT-026 job outcome (the job round closes).
  const evidenceId = await appendEvidence(tenant, 'window-evidence');
  const jobOutcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: agent.token,
    body: { outcome: 'succeeded', evidenceRef: evidenceId },
  });
  assert.equal(jobOutcome.status, 201, JSON.stringify(jobOutcome.body));

  const open = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:window-1' },
  });
  assert.equal(open.status, 409, 'the acceptance window is closed');
});

test('a job that was never accepted has no visit surface (fail closed)', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent('never-accepted@fieldexec.test');

  const open = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:never-1' },
  });
  assert.equal(open.status, 404, 'no accepted agent — the uniform 404 posture');
});

// ---------------------------------------------------------------------------
// EVID-AC-01 (field subset) — captured evidence carries the full contract
// ---------------------------------------------------------------------------

test('EVID-AC-01: captured evidence records carry source, timestamp, provenance and traceable content', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evid1');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:evid-1' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });

  const observedAt = new Date(Date.now() - 60_000).toISOString();
  const captureCorrelation = randomUUID();
  const captured = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    correlationId: captureCorrelation,
    body: {
      class: 'observation',
      quality: 'B',
      observedAt,
      sourceRef: 'device-photo://img-042',
      content: { forms_signed: 2, venue_open: true },
      contentRef: 'object-store://field/visit-1/photo.jpg',
      confidence: 0.8,
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const evidenceId = (captured.body as Record<string, unknown>)['evidenceId'] as string;

  // The evidence record read back through the /evidence AUTHORITY surface
  // (the commissioning member owns the client-scope read).
  const readBack = await apiCall(port(), `/api/evidence/${evidenceId}`, {
    token: tenant.owner.token,
  });
  assert.equal(readBack.status, 200, JSON.stringify(readBack.body));
  const record = readBack.body as Record<string, unknown>;
  assert.equal(record['class'], 'observation');
  assert.equal(record['clientId'], tenant.clientId, 'the scope is SERVER-DERIVED from the job');
  assert.equal(record['workspaceId'], tenant.workspaceId);
  assert.deepEqual((record['source'] as Record<string, unknown>), {
    system: 'field-agent',
    ref: 'device-photo://img-042',
  }, "the source descriptor records WHERE the evidence originated ('field-agent')");
  assert.equal(record['observedAt'], observedAt, 'the observation timestamp is preserved');
  assert.deepEqual(record['content'], { forms_signed: 2, venue_open: true }, 'traceable content');
  assert.equal(record['quality'], 'B');
  assert.equal(record['confidence'], 0.8);

  // Provenance: actor-attributed, recorded through the field surface,
  // correlation-linked, visit-caused.
  const provenance = record['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${agent.userId}`, 'actor-attributed submission');
  assert.equal(provenance['recordedVia'], 'field-agent', 'the frozen field-capture surface label');
  assert.equal(provenance['correlationId'], captureCorrelation);
  assert.equal(provenance['causationId'], visitId, 'the visit is the causation identity');
  assert.ok(typeof provenance['recordedAt'] === 'string');

  // The visit-side capture link exists (the attribution index).
  const links = await db!.query(
    `SELECT visit_id, evidence_id, captured_by, recorded_via, causation_id
     FROM job_visit_evidence WHERE visit_id = $1`,
    [visitId],
  );
  assert.equal(links.rows.length, 1);
  assert.equal(links.rows[0]!['evidence_id'], evidenceId);
  assert.equal(links.rows[0]!['captured_by'], agent.userId);
  assert.equal(links.rows[0]!['recorded_via'], 'field-agent');
  assert.equal(links.rows[0]!['causation_id'], visitId);

  // The capture listing surface round-trips.
  const list = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: tenant.owner.token,
  });
  assert.equal(list.status, 200);
  const entries = (list.body as Record<string, unknown>)['evidence'] as unknown[];
  assert.equal(entries.length, 1);
});

test('evidence capture is visit-state gated (in_progress only) and validated against the frozen vocabularies', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evidgated');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:evid-gated' },
    })).body as Record<string, unknown>
  )['visitId'] as string;

  // planned: evidence is captured DURING the visit.
  const plannedCapture = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { x: 1 },
    },
  });
  assert.equal(plannedCapture.status, 409, JSON.stringify(plannedCapture.body));

  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });

  const badClass = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'guess',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { x: 1 },
    },
  });
  assert.equal(badClass.status, 422);

  const badQuality = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'G',
      observedAt: new Date().toISOString(),
      content: { x: 1 },
    },
  });
  assert.equal(badQuality.status, 422);

  const emptyContent = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: {},
    },
  });
  assert.equal(emptyContent.status, 422, 'traceable content is required');

  // The §21 material-key guard (the /evidence append guard at the authority boundary).
  const materialKeys = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { nested: { password: 'sekret', note: 'x' } },
    },
  });
  assert.equal(materialKeys.status, 422, 'material-shaped keys never appear in evidence payloads');
});

// ---------------------------------------------------------------------------
// EVID-AC-03 (field subset) — claims stay claims (no self-authorized promotion)
// ---------------------------------------------------------------------------

test('EVID-AC-03: a CLAIM captured from the field STAYS a claim — no promotion path exists', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evid3');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:evid-3' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });

  // The agent submits their INTERPRETATION (a claim: inference).
  const captured = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'inference',
      quality: 'E',
      observedAt: new Date().toISOString(),
      content: { conclusion: 'footfall is trending up week-over-week' },
      confidence: 0.9,
    },
  });
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const evidenceId = (captured.body as Record<string, unknown>)['evidenceId'] as string;

  // Read back through the /evidence authority: the class is UNCHANGED
  // (still a claim) despite the high self-declared confidence — the
  // submitting agent cannot self-authorize provenance promotion.
  const readBack = await apiCall(port(), `/api/evidence/${evidenceId}`, {
    token: tenant.owner.token,
  });
  assert.equal(readBack.status, 200);
  const record = readBack.body as Record<string, unknown>;
  assert.equal(record['class'], 'inference', 'claims stay claims');
  assert.equal(record['confidence'], 0.9, 'confidence is preserved as claim metadata');
  assert.equal(record['quality'], 'E');

  // The claim can even BACK the structured visit outcome: referencing it
  // changes nothing about its class or tier (no promotion side effect).
  const completed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'partial',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(completed.status, 201, 'a claim is a valid evidence reference (claims stay claims)');
  const after = await apiCall(port(), `/api/evidence/${evidenceId}`, {
    token: tenant.owner.token,
  });
  assert.equal((after.body as Record<string, unknown>)['class'], 'inference');
});

// ---------------------------------------------------------------------------
// EVID-AC-02 (field subset) — append-only storage (direct SQL backstops)
// ---------------------------------------------------------------------------

test('EVID-AC-02: captured evidence, visit outcomes, capture links and transitions are append-only (SQL rewrites rejected)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evid2');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:evid-2' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const captured = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { forms_signed: 1 },
    },
  });
  const evidenceId = (captured.body as Record<string, unknown>)['evidenceId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { forms_signed: 1 },
      evidenceRef: evidenceId,
    },
  });

  // The /evidence record (migration 015 triggers): UPDATE and DELETE rejected.
  await assert.rejects(
    () => db!.query('UPDATE evidence SET class = $1 WHERE evidence_id = $2', ['source_fact', evidenceId]),
    (error: { message?: string }) => /append-only|immutable/i.test(String(error?.message ?? '')),
    'direct evidence UPDATE must be rejected by the DB trigger',
  );
  await assert.rejects(
    () => db!.query('DELETE FROM evidence WHERE evidence_id = $1', [evidenceId]),
    (error: { message?: string }) => /append-only|immutable/i.test(String(error?.message ?? '')),
    'direct evidence DELETE must be rejected by the DB trigger',
  );

  // The visit outcome (migration 024): UPDATE and DELETE rejected.
  await assert.rejects(
    () => db!.query('UPDATE job_visit_outcomes SET result = $1 WHERE visit_id = $2', ['failed', visitId]),
    (error: { message?: string }) => /append-only/i.test(String(error?.message ?? '')),
    'visit outcome UPDATE must be rejected',
  );
  await assert.rejects(
    () => db!.query('DELETE FROM job_visit_outcomes WHERE visit_id = $1', [visitId]),
    (error: { message?: string }) => /append-only/i.test(String(error?.message ?? '')),
    'visit outcome DELETE must be rejected',
  );

  // The capture link and the transition history: append-only.
  await assert.rejects(
    () => db!.query('UPDATE job_visit_evidence SET captured_by = NULL WHERE evidence_id = $1', [evidenceId]),
    (error: { message?: string }) => /append-only/i.test(String(error?.message ?? '')),
    'capture link UPDATE must be rejected',
  );
  await assert.rejects(
    () => db!.query('DELETE FROM job_visit_transitions WHERE visit_id = $1', [visitId]),
    (error: { message?: string }) => /append-only/i.test(String(error?.message ?? '')),
    'transition history DELETE must be rejected',
  );

  // The completed visit row is TERMINAL and frozen (even a direct SQL
  // rewrite of the status column is rejected).
  await assert.rejects(
    () => db!.query('UPDATE job_visits SET status = $1 WHERE visit_id = $2', ['cancelled', visitId]),
    (error: { message?: string }) =>
      /terminal|frozen|illegal visit transition/i.test(String(error?.message ?? '')),
    'a completed visit is frozen history',
  );
});

// ---------------------------------------------------------------------------
// Evidence reference validation (uniform 404s) + §21
// ---------------------------------------------------------------------------

test('visit outcome evidence references: unknown, foreign and CROSS-CLIENT ids are the SAME uniform 404', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'evidref');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:evid-ref' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const foreignEvidenceId = await appendEvidence(otherTenant, 'foreign-visit-evidence');

  const unknown = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: randomUUID(),
    },
  });
  assert.equal(unknown.status, 404, 'unknown evidence id → uniform 404');

  const foreign = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: foreignEvidenceId,
    },
  });
  assert.equal(foreign.status, 404, 'cross-client evidence id → the SAME uniform 404 (no oracle)');

  const malformed = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: 'not-a-uuid',
    },
  });
  assert.equal(malformed.status, 422, 'a malformed evidence id is a DTO-shape rejection (422)');

  // Nothing was written by any rejected attempt: the visit is still in_progress.
  const statusRow = await db!.query('SELECT status FROM job_visits WHERE visit_id = $1', [visitId]);
  assert.equal(statusRow.rows[0]!['status'], 'in_progress');
});

test('§21: material-shaped observation keys are rejected in the structured outcome', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'matkeys');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:mat-keys' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const evidenceId = await appendEvidence(tenant, 'mat-keys-evidence');

  const response = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { forms_signed: 1, nested: { password: 'do-not-store' } },
      evidenceRef: evidenceId,
    },
  });
  assert.equal(response.status, 422, 'secrets never appear in observation payloads');
});

// ---------------------------------------------------------------------------
// DTO authority-field rejection (§23)
// ---------------------------------------------------------------------------

test('DTO authority-field rejection: provenance/scope/status fields are 422 on every mutation surface', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'dto');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:dto-1' },
    })).body as Record<string, unknown>
  )['visitId'] as string;
  await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, { token: agent.token, body: {} });
  const evidenceId = await appendEvidence(tenant, 'dto-evidence');

  const openWithStatus = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:dto-2', status: 'completed' },
  });
  assert.equal(openWithStatus.status, 422);

  const openWithClient = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:dto-3', clientId: tenant.clientId },
  });
  assert.equal(openWithClient.status, 422);

  const startWithProvenance = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/start`, {
    token: agent.token,
    body: { recordedActor: 'user:spoofed' },
  });
  assert.equal(startWithProvenance.status, 422);

  const completeWithSubmittedBy = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/complete`, {
    token: agent.token,
    body: {
      result: 'succeeded',
      followUpRequired: false,
      notes: '',
      observations: { attempts: 1 },
      evidenceRef: evidenceId,
      submittedBy: agent.userId,
      submittedAt: '2020-01-01T00:00:00.000Z',
    },
  });
  assert.equal(completeWithSubmittedBy.status, 422, 'provenance-shaped fields are rejected');

  const captureWithSource = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { x: 1 },
      source: { system: 'spoofed', ref: null },
    },
  });
  assert.equal(captureWithSource.status, 422, 'the source descriptor is server-stamped');

  const captureWithSupersede = await apiCall(port(), `/api/jobs/${jobId}/visits/${visitId}/evidence`, {
    token: agent.token,
    body: {
      class: 'observation',
      quality: 'C',
      observedAt: new Date().toISOString(),
      content: { x: 1 },
      supersedes: evidenceId,
    },
  });
  assert.equal(captureWithSupersede.status, 422, 'field capture never supersedes');
});

// ---------------------------------------------------------------------------
// DB backstops (real PostgreSQL, direct SQL)
// ---------------------------------------------------------------------------

test('DB backstop: a visit whose scope is NOT the job scope is rejected by the trigger', async () => {
  const { jobId, agent: _agent } = await makeAcceptedJob(tenant, 'dbbscope');
  const visitId = randomUUID();
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO job_visits
           (visit_id, job_id, visit_seq, workspace_id, client_id, agency_id,
            target_identity, status, recorded_actor, recorded_via, correlation_id, causation_id,
            version, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $3, $3, 'venue:db-scope', 'planned', 'user:test', 'api', 'corr-1', NULL, 1, now(), now())`,
        [visitId, jobId, otherTenant.clientId],
      ),
    (error: { message?: string }) => /must equal its job scope/i.test(String(error?.message ?? '')),
    'the scope-chain trigger rejects cross-scope visits',
  );
});

test('DB backstop: visits on NON-ACCEPTED jobs are rejected by the acceptance-window trigger', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  // The job is merely 'projected' — no acceptance exists.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO job_visits
           (visit_id, job_id, visit_seq, workspace_id, client_id, agency_id,
            target_identity, status, recorded_actor, recorded_via, correlation_id, causation_id,
            version, created_at, updated_at)
         VALUES ($1, $2, 1, $3, $4, $5, 'venue:db-window', 'planned', 'user:test', 'api', 'corr-2', NULL, 1, now(), now())`,
        [randomUUID(), jobId, tenant.workspaceId, tenant.clientId, tenant.agencyId],
      ),
    (error: { message?: string }) => /acceptance window/i.test(String(error?.message ?? '')),
    'the acceptance-window trigger fences visits to accepted jobs',
  );
});

test('DB backstop: follow-up links across relationships or lifecycle states are rejected', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'dbbfollow');
  const first = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:db-follow-a' },
  });
  const firstVisitId = (first.body as Record<string, unknown>)['visitId'] as string;

  // follow-up to a NON-COMPLETED visit: the API rejects with 409.
  const followPlanned = await apiCall(port(), `/api/jobs/${jobId}/visits`, {
    token: agent.token,
    body: { targetIdentity: 'venue:db-follow-a', followUpOfVisitId: firstVisitId },
  });
  assert.equal(followPlanned.status, 409, 'follow-ups reference COMPLETED visits only');

  // The DB trigger rejects the same attempt at the storage level.
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO job_visits
           (visit_id, job_id, visit_seq, workspace_id, client_id, agency_id,
            target_identity, status, follow_up_of_visit_id, recorded_actor, recorded_via,
            correlation_id, causation_id, version, created_at, updated_at)
         VALUES ($1, $2, 3, $3, $4, $5, 'venue:db-follow-a', 'planned', $6, 'user:test', 'api',
                 'corr-3', NULL, 1, now(), now())`,
        [randomUUID(), jobId, tenant.workspaceId, tenant.clientId, tenant.agencyId, firstVisitId],
      ),
    (error: { message?: string }) => /COMPLETED visits only/i.test(String(error?.message ?? '')),
    'the follow-up trigger fences lifecycle states',
  );
});

test('DB backstop: the visit identity/scope/target columns are immutable through ANY mutation path', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'dbbimmutable');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:db-immutable' },
    })).body as Record<string, unknown>
  )['visitId'] as string;

  // NOTE: trigger firing order is alphabetical — the frozen-state-machine
  // trigger may reject a column-change UPDATE before the identity-
  // immutability trigger (a self-transition). ANY rejection proves the
  // columns cannot be reassigned through a direct SQL path.
  await assert.rejects(
    () => db!.query('UPDATE job_visits SET target_identity = $1 WHERE visit_id = $2', [
      'venue:swapped',
      visitId,
    ]),
    (error: { message?: string }) =>
      /relationship target identity is immutable|illegal|frozen/i.test(String(error?.message ?? '')),
  );
  await assert.rejects(
    () => db!.query('UPDATE job_visits SET client_id = $1 WHERE visit_id = $2', [
      otherTenant.clientId,
      visitId,
    ]),
    (error: { message?: string }) =>
      /Client ownership is immutable|must equal its job scope|illegal|frozen/i.test(
        String(error?.message ?? ''),
      ),
  );
  await assert.rejects(
    () => db!.query('UPDATE job_visits SET recorded_actor = $1 WHERE visit_id = $2', [
      'user:spoofed',
      visitId,
    ]),
    (error: { message?: string }) =>
      /recorded provenance is immutable|illegal|frozen/i.test(String(error?.message ?? '')),
  );
});

test('DB backstop: the illegal planned → completed status rewrite is rejected (frozen machine)', async () => {
  const { jobId, agent } = await makeAcceptedJob(tenant, 'dbbmachine');
  const visitId = (
    (await apiCall(port(), `/api/jobs/${jobId}/visits`, {
      token: agent.token,
      body: { targetIdentity: 'venue:db-machine' },
    })).body as Record<string, unknown>
  )['visitId'] as string;

  await assert.rejects(
    () => db!.query('UPDATE job_visits SET status = $1 WHERE visit_id = $2', ['completed', visitId]),
    (error: { message?: string }) =>
      /illegal visit transition|frozen MKT-027 visit state machine/i.test(String(error?.message ?? '')),
    'no skip-edges at the storage level',
  );
});
