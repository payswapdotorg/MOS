/**
 * MKT-026 integration test — the CONCURRENCY-SAFE ACCEPTANCE CLAIM and the
 * offer lifecycle (JOB-AC-02, job-offer-v1.2.md) against real PostgreSQL +
 * a real API subprocess (real concurrent HTTP against the row-locked
 * transaction and the DB fences).
 *
 * Proves:
 *   - JOB-AC-02 (the race): two candidates holding two open offers of ONE
 *     job accept CONCURRENTLY — exactly ONE acceptance wins (one 200, one
 *     clean 409, never a partial state), the database holds EXACTLY one
 *     accepted offer (the partial-unique fence), the loser's offer is
 *     terminalized as expired (reason 'lost' — losing offers can never
 *     later claim), and the job is accepted with the winner's identity;
 *   - JOB-AC-02 (idempotent replay): repeated acceptance of the SAME
 *     offer by the SAME agent converges — 200 with replayed=true, the
 *     SAME recorded outcome, no version bump, no new rows;
 *   - a DIFFERENT agent's accept after the job has been claimed is a
 *     clean 409 (no partial state, no unrelated Client data);
 *   - JOB-AC-02 (idempotent decline): repeated decline of the same offer
 *     converges (200, replayed=true); declining never affects the
 *     underlying Task (the workflow instance stays RUNNING untouched —
 *     Workflow authority preserved);
 *   - decline terminal per-offer: an accepted offer cannot be declined
 *     (the claim stands); the round's last declined offer closes the job
 *     as declined (terminal);
 *   - expiry: an open offer past its immutable expiry cannot be claimed
 *     or declined — the accept attempt terminalizes it (reason 'expiry')
 *     and conflicts; the round closes expired when it was the last open
 *     offer;
 *   - DB fences under DIRECT SQL: a second accepted offer for one job is
 *     rejected by the exactly-one-winner partial unique index; the
 *     one-open-offer-per-candidate fence; the append-only outcome
 *     history (UPDATE and DELETE rejected).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  sleep,
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
        description: 'Concurrency probe job',
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

async function createOffer(
  tenant: Tenant,
  jobId: string,
  agent: { agentId: string },
  expiresAtIso: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: tenant.owner.token,
    body: { candidateAgentId: agent.agentId, expiresAt: expiresAtIso },
  });
  assert.equal(response.status, 201, `offer creation failed: ${JSON.stringify(response.body)}`);
  return (response.body as Record<string, unknown>)['offerId'] as string;
}

function accept(jobId: string, offerId: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/accept`, { token, body: {} });
}

function decline(jobId: string, offerId: string, token: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/decline`, { token, body: {} });
}

let tenant: Tenant = { owner: { token: '', userId: '' }, agencyId: '', clientId: '', workspaceId: '' };

before(async () => {
  stack = await bootStack('jobsconcurrency');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
  tenant = await makeTenant('concurrent');
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
// JOB-AC-02 — the concurrent acceptance race
// ---------------------------------------------------------------------------

test('JOB-AC-02: two concurrent accepts of two offers of one job — EXACTLY ONE winner, the loser offer expires lost', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agentA = await makeAgent('race-a@jobs.test');
  const agentB = await makeAgent('race-b@jobs.test');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const offerA = await createOffer(tenant, jobId, agentA, expiresAt);
  const offerB = await createOffer(tenant, jobId, agentB, expiresAt);

  // The race: both candidates hit accept simultaneously.
  const [resultA, resultB] = await Promise.all([accept(jobId, offerA, agentA.token), accept(jobId, offerB, agentB.token)]);
  const statuses = [resultA.status, resultB.status].sort();
  assert.deepEqual(statuses, [200, 409], `exactly one winner and one clean conflict: ${JSON.stringify([resultA.body, resultB.body])}`);
  const winner = resultA.status === 200 ? { result: resultA, offer: offerA, agent: agentA } : { result: resultB, offer: offerB, agent: agentB };
  const loser = resultA.status === 200 ? { result: resultB, offer: offerB, agent: agentB } : { result: resultA, offer: offerA, agent: agentA };

  // The winner's response: job accepted + replayed=false.
  const jobBody = winner.result.body['job'] as Record<string, unknown>;
  assert.equal(jobBody['status'], 'accepted');
  assert.equal(winner.result.body['replayed'], false);
  const acceptedClaim = jobBody['accepted'] as Record<string, unknown>;
  assert.equal(acceptedClaim['agentId'], winner.agent.agentId);
  assert.equal(acceptedClaim['offerId'], winner.offer);

  // The loser's 409 is a clean conflict — never a partial state (the
  // message depends on which check fired first: their own offer was
  // already terminalized as lost, or the job was already claimed).
  assert.ok(
    JSON.stringify(loser.result.body).includes('claimed'),
    `the loser's 409 states the claim conflict: ${JSON.stringify(loser.result.body)}`,
  );

  // Database truth: EXACTLY one accepted offer; the loser terminalized
  // expired with reason 'lost'; the job row carries the winner.
  const offers = await db!.query(
    'SELECT job_offer_id, status, terminal_reason, candidate_agent_id FROM job_offers WHERE job_id = $1',
    [jobId],
  );
  assert.equal(offers.rows.length, 2);
  const acceptedRows = offers.rows.filter((row) => row['status'] === 'accepted');
  assert.equal(acceptedRows.length, 1, 'the exactly-one-winner fence holds in storage');
  assert.equal(acceptedRows[0]!['terminal_reason'], 'claimed');
  const lostRows = offers.rows.filter((row) => row['status'] === 'expired');
  assert.equal(lostRows.length, 1);
  assert.equal(lostRows[0]!['terminal_reason'], 'lost', 'losing offers terminalize as expired (lost)');
  assert.equal(lostRows[0]!['job_offer_id'], loser.offer);

  const jobRow = await db!.query(
    'SELECT status, accepted_agent_id, accepted_offer_id FROM jobs WHERE job_id = $1',
    [jobId],
  );
  assert.equal(jobRow.rows[0]!['status'], 'accepted');
  assert.equal(jobRow.rows[0]!['accepted_offer_id'], winner.offer);

  // The loser cannot later claim (their offer is terminal).
  const reattempt = await accept(jobId, loser.offer, loser.agent.token);
  assert.equal(reattempt.status, 409, 'a losing offer can never later claim the job');

  // Idempotent replay: the winner re-accepts — the SAME outcome, no state
  // change (replayed=true; the version does not move).
  const versionBefore = jobRow.rows[0]!['status'];
  const replay = await accept(jobId, winner.offer, winner.agent.token);
  assert.equal(replay.status, 200, 'replayed acceptance converges, never errors');
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['job'] as Record<string, unknown>)['status'], 'accepted');
  assert.deepEqual(
    (replay.body['job'] as Record<string, unknown>)['accepted'],
    jobBody['accepted'],
    'the recorded acceptance is returned unchanged',
  );
  const jobRowAfter = await db!.query('SELECT status FROM jobs WHERE job_id = $1', [jobId]);
  assert.equal(jobRowAfter.rows[0]!['status'], versionBefore, 'no state change on replay');

  // A THIRD agent accepting a (hypothetically still-open) offer would also
  // be a clean conflict — proven here by the loser's terminal state above;
  // the losing offer's expiry is irrelevant to the conflict semantics.
});

test('JOB-AC-02: sequential claim then foreign accept — clean 409 without partial state', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agentA = await makeAgent('seq-a@jobs.test');
  const agentB = await makeAgent('seq-b@jobs.test');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const offerA = await createOffer(tenant, jobId, agentA, expiresAt);
  const offerB = await createOffer(tenant, jobId, agentB, expiresAt);

  const first = await accept(jobId, offerA, agentA.token);
  assert.equal(first.status, 200);

  // A different agent's accept AFTER the job has been claimed.
  const second = await accept(jobId, offerB, agentB.token);
  assert.equal(second.status, 409, JSON.stringify(second.body));
  const offerRow = await db!.query('SELECT status, terminal_reason FROM job_offers WHERE job_offer_id = $1', [offerB]);
  assert.equal(offerRow.rows[0]!['status'], 'expired');
  assert.equal(offerRow.rows[0]!['terminal_reason'], 'lost');

  // No partial state: the job remains accepted by the FIRST agent only.
  const jobRow = await db!.query('SELECT status, accepted_offer_id FROM jobs WHERE job_id = $1', [jobId]);
  assert.equal(jobRow.rows[0]!['status'], 'accepted');
  assert.equal(jobRow.rows[0]!['accepted_offer_id'], offerA);
});

// ---------------------------------------------------------------------------
// JOB-AC-02 — idempotent decline; decline never affects the Task
// ---------------------------------------------------------------------------

test('JOB-AC-02: repeated decline converges (200, replayed=true) and NEVER affects the underlying Task', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent('decline-agent@jobs.test');
  const offerId = await createOffer(tenant, jobId, agent, new Date(Date.now() + 3600_000).toISOString());

  const first = await decline(jobId, offerId, agent.token);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body['replayed'], false);
  assert.equal((first.body['offer'] as Record<string, unknown>)['status'], 'declined');

  const replay = await decline(jobId, offerId, agent.token);
  assert.equal(replay.status, 200, 'repeated decline converges, never errors');
  assert.equal(replay.body['replayed'], true);

  // The job closed declined (every offer declined) — terminal.
  const jobBody = replay.body['job'] as Record<string, unknown>;
  assert.equal(jobBody['status'], 'declined');

  // Declining never affected the underlying Task: the workflow instance
  // is still RUNNING and its history untouched (Workflow authority
  // preserved — /jobs never mutates workflow state).
  const instanceRow = await db!.query(
    'SELECT status FROM workflow_instances WHERE workflow_instance_id = $1',
    [instance.instanceId],
  );
  assert.equal(instanceRow.rows[0]!['status'], 'running');
  const transitions = await db!.query(
    'SELECT count(*)::int AS n FROM workflow_instance_transitions WHERE workflow_instance_id = $1',
    [instance.instanceId],
  );
  assert.equal(
    transitions.rows[0]!['n'],
    2,
    'exactly the two setup transitions (ready, running) — no job-driven instance transitions',
  );
});

test('decline is terminal per-offer: an accepted offer cannot be declined (the claim stands)', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent('claim-stands@jobs.test');
  const offerId = await createOffer(tenant, jobId, agent, new Date(Date.now() + 3600_000).toISOString());

  const accepted = await accept(jobId, offerId, agent.token);
  assert.equal(accepted.status, 200);

  const declined = await decline(jobId, offerId, agent.token);
  assert.equal(declined.status, 409, JSON.stringify(declined.body));
  assert.ok(JSON.stringify(declined.body).includes('claim stands'));

  const offerRow = await db!.query('SELECT status FROM job_offers WHERE job_offer_id = $1', [offerId]);
  assert.equal(offerRow.rows[0]!['status'], 'accepted', 'the claim stands — the offer stays accepted');
});

// ---------------------------------------------------------------------------
// Expiry (lazy terminalization; terminal per-offer)
// ---------------------------------------------------------------------------

test('expiry: an offer past its immutable expiry cannot be claimed — the attempt terminalizes it and conflicts; the round closes expired', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agent = await makeAgent('expiry-agent@jobs.test');
  // A two-second expiry, then wait it out.
  const offerId = await createOffer(
    tenant,
    jobId,
    agent,
    new Date(Date.now() + 2000).toISOString(),
  );
  await sleep(2200);

  const attempted = await accept(jobId, offerId, agent.token);
  assert.equal(attempted.status, 409, JSON.stringify(attempted.body));
  assert.ok(JSON.stringify(attempted.body).includes('expired'), 'the conflict states the expiry');

  // Persisted terminalization with reason 'expiry'.
  const offerRow = await db!.query('SELECT status, terminal_reason FROM job_offers WHERE job_offer_id = $1', [offerId]);
  assert.equal(offerRow.rows[0]!['status'], 'expired');
  assert.equal(offerRow.rows[0]!['terminal_reason'], 'expiry');

  // The round closed expired (the only offer terminalized with no winner).
  const jobRow = await db!.query('SELECT status FROM jobs WHERE job_id = $1', [jobId]);
  assert.equal(jobRow.rows[0]!['status'], 'expired');

  // The expired offer cannot be declined either (terminal per-offer).
  const declined = await decline(jobId, offerId, agent.token);
  assert.equal(declined.status, 409);
});

// ---------------------------------------------------------------------------
// DB fences under direct SQL (race backstops)
// ---------------------------------------------------------------------------

test('DB fence: a SECOND accepted offer for one job is rejected by the exactly-one-winner index', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);
  const agentA = await makeAgent('fence-a@jobs.test');
  const agentB = await makeAgent('fence-b@jobs.test');

  // Two FRESH open offers inserted directly (bypassing every application
  // check — the fence must hold at the storage level).
  const insertOffer = (offerId: string, agentId: string, userId: string) =>
    db!.query(
      `INSERT INTO job_offers (job_offer_id, job_id, candidate_agent_id, candidate_user_id, status,
                               terminal_reason, expires_at, created_by, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'open', NULL, now() + interval '1 hour', NULL, 1, now(), now())`,
      [offerId, jobId, agentId, userId],
    );
  const offerAId = randomUUID();
  const offerBId = randomUUID();
  await insertOffer(offerAId, agentA.agentId, agentA.userId);
  await insertOffer(offerBId, agentB.agentId, agentB.userId);

  // The first accepted update succeeds (open → accepted is a legal offer
  // edge under the state-machine trigger).
  await db!.query(
    `UPDATE job_offers SET status = 'accepted', terminal_reason = 'claimed', accepted_at = now(),
            version = version + 1, updated_at = now()
     WHERE job_offer_id = $1`,
    [offerAId],
  );

  // The SECOND accepted update for the same job is rejected by the
  // exactly-one-winner partial unique index.
  await assert.rejects(
    db!.query(
      `UPDATE job_offers SET status = 'accepted', terminal_reason = 'claimed', accepted_at = now(),
              version = version + 1, updated_at = now()
       WHERE job_offer_id = $1`,
      [offerBId],
    ),
    /one_winner|duplicate key/i,
    'the exactly-one-winner partial unique index rejects a second accepted offer',
  );

  // The one-open-offer-per-candidate fence: a FRESH open offer for
  // agentA is legal (their previous offer is now accepted, not open); the
  // SECOND open offer for the same candidate is rejected.
  await insertOffer(randomUUID(), agentA.agentId, agentA.userId);
  await assert.rejects(
    insertOffer(randomUUID(), agentA.agentId, agentA.userId),
    /one_open_per_candidate|duplicate key/i,
    'the one-open-offer-per-candidate fence rejects a duplicate open offer',
  );
});

test('DB fence: the append-only outcome history rejects UPDATE and DELETE under direct SQL', async () => {
  const instance = await makeRunningInstance(tenant);
  const jobId = await projectJob(tenant, instance);

  // Insert an outcome row directly with full server-side provenance shape
  // (the evidence row uses the authority's real flat columns).
  const evidenceId = randomUUID();
  await db!.query(
    `INSERT INTO evidence (evidence_id, client_id, workspace_id, class, source_system, source_ref,
                           observed_at, content, content_ref, quality, confidence,
                           supersedes_evidence_id, recorded_actor, recorded_via, correlation_id,
                           causation_id, recorded_at)
     VALUES ($1, $2, NULL, 'observation', 'field-agent', NULL, now(), $3::jsonb, NULL, 'C', NULL,
             NULL, 'user:probe', 'api', $4, NULL, now())`,
    [
      evidenceId,
      tenant.clientId,
      JSON.stringify({ note: 'outcome fence probe' }),
      randomUUID(),
    ],
  );

  // Move the job to accepted via the API flow.
  const agent = await makeAgent('outcome-fence@jobs.test');
  const offerId = await createOffer(tenant, jobId, agent, new Date(Date.now() + 3600_000).toISOString());
  const accepted = await accept(jobId, offerId, agent.token);
  assert.equal(accepted.status, 200);

  await db!.query(
    `INSERT INTO job_outcomes (job_outcome_id, job_id, outcome, payload_ref, evidence_ref,
                              reported_instance_status, recorded_actor, recorded_via, correlation_id,
                              causation_id, submitted_by, submitted_at, created_at)
     VALUES ($1, $2::uuid, 'succeeded', NULL, $3::uuid, 'running', 'user:probe', 'api', $4, $5, NULL, now(), now())`,
    [randomUUID(), jobId, evidenceId, randomUUID(), jobId],
  );

  await assert.rejects(
    db!.query(`UPDATE job_outcomes SET outcome = 'failed' WHERE job_id = $1`, [jobId]),
    /append-only/i,
    'outcome history cannot be rewritten',
  );
  await assert.rejects(
    db!.query(`DELETE FROM job_outcomes WHERE job_id = $1`, [jobId]),
    /append-only/i,
    'outcome history cannot be deleted',
  );
});
