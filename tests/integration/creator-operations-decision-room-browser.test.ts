/**
 * MKT-039 integration test — the CREATOR OPERATIONS BROWSER-LEVEL
 * DECISION-ROOM drive (work-item-v1.3-overrides.md MKT-039 acceptance:
 * "E2E-AC-02 plus browser/API authorization tests" — this is the browser
 * half, following the repo's established browser-test pattern: the
 * MKT-030/MKT-031 decision-room UI test precedent of driving the surface a
 * frontend consumes over real HTTP against a real API subprocess; the API
 * authorization half lives in creator-operations-authorization.test.ts and
 * the end-to-end experience in creator-operations-experience-e2e.test.ts).
 *
 * THE BROWSER STORY (the frozen UI authority only — no new UI authority, no
 * alternate workflow state):
 *
 *   - a Creator Operations scenario brings real creator evidence, a Goal, a
 *     pack-template Workflow instance and a RUNNING (undecided) experiment
 *     into the Client's durable state (every write through the frozen
 *     authorities: the pack subject/approval/observation surfaces, /goals,
 *     /workflows, /experiments);
 *   - THE HUMAN APPROVER SEES: a client-side approver (a client_collaborator
 *     of the owning agency — the decision room's client-side reader) opens
 *     the Client Decision Room and sees the creator-operation EVIDENCE:
 *     WHAT HAPPENED (the creator goal + the running pack-template workflow
 *     instance), EVIDENCE QUALITY (the creator evidence chain the pack
 *     mapped into /evidence), the EXPERIMENT awaiting decision and the
 *     APPROVALS entry carrying it (UI-AC-01: the room displays
 *     authoritative backend state; it never owns it);
 *   - THE ROOM IS READ-ONLY BY CONSTRUCTION (UI-AC-02): mutating verbs are
 *     405 METHOD_NOT_ALLOWED, authority-shaped bodies/queries/headers
 *     change nothing (byte-identical responses), the hard tenant boundary
 *     is the uniform 404 (foreign ≡ unknown ≡ malformed), anonymous is
 *     401, and after every read and probe the durable authority rows are
 *     BYTE-IDENTICAL (no decision-room input can alter any authority's
 *     outcome — there is no write path at all);
 *   - THE CLIENT DECISION IS RECORDED THROUGH THE FROZEN AUTHORITY ONLY:
 *     the client-side approver CANNOT record it (403 — insufficient role on
 *     the /experiments transition surface; no UI surface can grant
 *     authority); the owning principal records the Client Decision through
 *     the frozen /experiments authority (conclude with the resulting
 *     decision citing the SAME creator evidence the room showed), the
 *     Learning is appended through the frozen /learnings authority citing
 *     that evidence + the CONCLUDED experiment, and the shared workflow
 *     instance reaches its terminal state through the frozen /workflows
 *     authority;
 *   - THE APPROVER SEES THE RECORDED DECISION: the room now surfaces the
 *     concluded experiment with the RESULTING DECISION verbatim, the
 *     RECOMMENDATION carrying it (experiment_decision) + the applicable
 *     learning, the WHY section (the learning with its evidence refs), the
 *     terminal instance in WHAT HAPPENED, and NOTHING pending in APPROVALS.
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

const FAN_MESSAGE = 'Is the VIP bundle still available this week?';
const APPROVED_REPLY = 'Yes! The VIP bundle is live this week — grab it from the pinned post.';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

interface Principal {
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

async function makeUser(email: string): Promise<Principal> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: PASSWORD } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

// ---------------------------------------------------------------------------
// Shared topology: agency A (the owner + the client-side approver
// collaborator; one client + workspace) and agency B (the cross-tenant
// probe side).
// ---------------------------------------------------------------------------

let ownerA: Principal = null as unknown as Principal;
let approverA: Principal = null as unknown as Principal;
let ownerB: Principal = null as unknown as Principal;
let agencyA = '';
let agencyB = '';
let clientA = '';
let clientB = '';
let workspaceA = '';
let conversationId = '';

// The creator scenario's shared identities (the frozen authority chain).
let goalId = '';
let workflowId = '';
let workflowInstanceId = '';
let experimentId = '';
let inboundEvidenceId = '';
let sendEvidenceId = '';
let sendObservationId = '';
let learningId = '';

const CLIENT_DECISION =
  'Adopt: extend AI-assisted, human-approved creator conversation triage to all top-fan enquiries — the approved reply executed end-to-end with complete creator evidence lineage.';

const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-status': 'succeeded',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

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

/** Pre-read and post-read durable snapshots (UI-AC-02 byte-stability). */
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
  const creatorMessages = await db.query(
    `SELECT * FROM creator_conversation_messages WHERE conversation_id = $1 ORDER BY message_id`,
    [conversationId],
  );
  const creatorApprovals = await db.query(
    `SELECT * FROM creator_operation_approvals WHERE resource_id = $1 ORDER BY approval_id`,
    [conversationId],
  );
  return JSON.stringify({
    goals: goals.rows,
    instances: instances.rows,
    evidence: evidence.rows,
    experiments: experiments.rows,
    learnings: learnings.rows,
    creatorMessages: creatorMessages.rows,
    creatorApprovals: creatorApprovals.rows,
  });
}

before(async () => {
  stack = await bootStack('creatorroom');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  ownerA = await makeUser('owner-a@creatorroom.test');
  approverA = await makeUser('approver-a@creatorroom.test');
  ownerB = await makeUser('owner-b@creatorroom.test');

  const admin = await adminToken();
  const agencyAcreated = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: 'Creator Room Agency A', ownerUserId: ownerA.userId },
  });
  assert.equal(agencyAcreated.status, 201, JSON.stringify(agencyAcreated.body));
  agencyA = (agencyAcreated.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  const agencyBcreated = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: 'Creator Room Agency B', ownerUserId: ownerB.userId },
  });
  assert.equal(agencyBcreated.status, 201);
  agencyB = (agencyBcreated.body['agency'] as Record<string, unknown>)['agencyId'] as string;

  // The CLIENT-SIDE APPROVER: a client_collaborator of the owning agency —
  // the decision room's client-facing reader (any ACTIVE member may read).
  const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: admin,
    body: { userId: approverA.userId, role: 'client_collaborator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));

  const clientAcreated = await apiCall(port(), `/api/agencies/${agencyA}/clients`, {
    token: admin,
    body: { name: 'Creator Room Client A' },
  });
  assert.equal(clientAcreated.status, 201);
  clientA = clientAcreated.body['clientId'] as string;
  const clientBcreated = await apiCall(port(), `/api/agencies/${agencyB}/clients`, {
    token: admin,
    body: { name: 'Creator Room Client B' },
  });
  assert.equal(clientBcreated.status, 201);
  clientB = clientBcreated.body['clientId'] as string;
  const workspaceAcreated = await apiCall(port(), `/api/clients/${clientA}/workspaces`, {
    token: admin,
    body: { name: 'Creator Room Workspace A' },
  });
  assert.equal(workspaceAcreated.status, 201);
  workspaceA = workspaceAcreated.body['workspaceId'] as string;

  // ---- The creator scenario (every write through the frozen authorities).

  // The pack subject chain.
  const profile = await apiCall(port(), `/api/clients/${clientA}/creator-profiles`, {
    token: ownerA.token,
    body: {
      displayName: 'Ava Creator',
      handle: 'ava-room',
      niches: ['fitness', 'lifestyle'],
      bio: 'A fitness creator.',
      attributes: {},
      idempotencyKey: 'room-profile-1',
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const account = await apiCall(port(), `/api/creator-profiles/${profile.body['profileId']}/accounts`, {
    token: ownerA.token,
    body: {
      platformLabel: 'creator-platform-1',
      accountHandle: 'ava_room',
      metadata: {},
      idempotencyKey: 'room-account-1',
    },
  });
  assert.equal(account.status, 201);
  const fan = await apiCall(port(), `/api/creator-accounts/${account.body['accountId']}/fans`, {
    token: ownerA.token,
    body: {
      fanAlias: 'top-fan-room',
      tier: 'top_fan',
      tags: [],
      attributes: {},
      idempotencyKey: 'room-fan-1',
    },
  });
  assert.equal(fan.status, 201);
  const conversation = await apiCall(
    port(),
    `/api/creator-accounts/${account.body['accountId']}/conversations`,
    {
      token: ownerA.token,
      body: {
        fanId: fan.body['fanId'] as string,
        channel: 'dm',
        topic: 'vip-bundle-enquiry',
        attributes: {},
        idempotencyKey: 'room-conversation-1',
      },
    },
  );
  assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
  conversationId = conversation.body['conversationId'] as string;

  // The INBOUND fan message → the pack §7 observation mapping into the
  // common /evidence ledger (creator-operation evidence the room will show).
  const inbound = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/inbound`, {
    token: ownerA.token,
    body: { body: FAN_MESSAGE, idempotencyKey: 'room-inbound-1', mapToEvidence: true },
  });
  assert.equal(inbound.status, 201, JSON.stringify(inbound.body));
  inboundEvidenceId = inbound.body['evidenceRef'] as string;
  assert.ok(typeof inboundEvidenceId === 'string' && inboundEvidenceId.length > 0);

  // The client creator gate + the human approval + the APPROVED send (the
  // CREATOR-AC-06 chain through the frozen pack surfaces).
  const clientGate = await apiCall(port(), `/api/clients/${clientA}/policies`, {
    token: ownerA.token,
    body: {
      dimension: 'network',
      rules: [
        {
          effect: 'allow',
          operations: ['creator.conversation.send'],
          attributes: { approvalStatus: 'approved' },
          reason: 'MKT-039 room: creator sends require a human approval record',
        },
      ],
      description: 'MKT-039 room client creator gate (approvals demanded)',
    },
  });
  assert.equal(clientGate.status, 201, JSON.stringify(clientGate.body));

  const approval = await apiCall(port(), `/api/creator-conversations/${conversationId}/approvals`, {
    token: ownerA.token,
    body: { decision: 'approved', notes: 'On-brand and answers the bundle question.', idempotencyKey: 'room-approval-1' },
  });
  assert.equal(approval.status, 201, JSON.stringify(approval.body));

  const sent = await apiCall(port(), `/api/creator-conversations/${conversationId}/messages/outbound`, {
    token: ownerA.token,
    body: { body: APPROVED_REPLY, idempotencyKey: 'room-outbound-1', approvalId: approval.body['approvalId'] },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body['status'], 'sent');

  // The send observation → the pack §7 mapping into /evidence + /metrics.
  const observation = await apiCall(port(), `/api/clients/${clientA}/creator-observations`, {
    token: ownerA.token,
    body: {
      subjectKind: 'conversation',
      subjectRef: conversationId,
      eventKind: 'message_sent',
      content: { direction: 'outbound', approvedBy: approval.body['approvalId'] },
      observedAt: new Date().toISOString(),
      quality: 'C',
      metric: {
        name: 'creator.conversation.event_count',
        value: 1,
        unit: 'events',
        dimensions: { conversationId, eventKind: 'message_sent' },
        aggregationMethod: null,
      },
      idempotencyKey: 'room-observation-send-1',
    },
  });
  assert.equal(observation.status, 201, JSON.stringify(observation.body));
  sendEvidenceId = observation.body['evidenceId'] as string;
  sendObservationId = observation.body['observationId'] as string;

  // The Goal (active, workspace-scoped).
  const goal = await apiCall(port(), `/api/clients/${clientA}/goals`, {
    token: ownerA.token,
    body: {
      objective: 'Creator conversation triage with AI-drafted, human-approved replies',
      workspaceId: workspaceA,
      successCriteria: [
        {
          metric: 'creator.conversation.event_count',
          comparator: '>=',
          targetValue: 1,
          unit: 'events',
          description: 'at least one approved creator reply sent',
        },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
    },
  });
  assert.equal(goal.status, 201, JSON.stringify(goal.body));
  goalId = goal.body['goalId'] as string;
  const goalActive = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'active', version: goal.body['version'] as number },
  });
  assert.equal(goalActive.status, 200, JSON.stringify(goalActive.body));

  // The pack template Workflow (definition ACTIVE + instance RUNNING — the
  // shared lifecycle carrier the room recaps).
  const publish = await apiCall(port(), '/api/creator-operations/publish', {
    token: ownerA.token,
    body: { idempotencyKey: 'room-pack-publish-1' },
  });
  assert.equal(publish.status, 201, JSON.stringify(publish.body));
  const install = await apiCall(port(), `/api/workspaces/${workspaceA}/domain-pack-installs`, {
    token: ownerA.token,
    body: { packId: publish.body['packId'] as string, idempotencyKey: 'room-pack-install-1' },
  });
  assert.equal(install.status, 201, JSON.stringify(install.body));
  const artifacts = await apiCall(port(), `/api/workspaces/${workspaceA}/domain-pack-artifacts`, {
    token: ownerA.token,
  });
  const template = (artifacts.body as { artifacts: { artifactName: string; payload: Record<string, unknown> }[] })
    .artifacts.find((artifact) => artifact.artifactName === 'conversation-triage')!;
  assert.ok(template !== undefined);

  const workflow = await apiCall(port(), `/api/workspaces/${workspaceA}/workflows`, {
    token: ownerA.token,
    body: { name: 'creator-triage-room', description: 'MKT-039: the pack conversation-triage template' },
  });
  assert.equal(workflow.status, 201);
  workflowId = workflow.body['workflowId'] as string;
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: ownerA.token,
    body: template.payload,
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let definitionVersion = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const next = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status, version: definitionVersion },
    });
    assert.equal(next.status, 200);
    definitionVersion = next.body['version'] as number;
  }
  const instance = await apiCall(port(), `/api/workflows/${workflowId}/definitions/${definitionId}/instances`, {
    token: ownerA.token,
    body: {},
  });
  assert.equal(instance.status, 201, JSON.stringify(instance.body));
  workflowInstanceId = instance.body['workflowInstanceId'] as string;
  let instanceVersion = instance.body['version'] as number;
  for (const to of ['ready', 'running'] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/instances/${workflowInstanceId}/transitions`,
      {
        token: ownerA.token,
        body: { to, version: instanceVersion, idempotencyKey: `room-instance-${to}`, reason: 'MKT-039 room' },
      },
    );
    assert.equal(transition.status, 200);
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }

  // The experiment: declared → ready → RUNNING (awaiting the Client
  // Decision — the APPROVALS entry the approver will see).
  const experiment = await apiCall(port(), `/api/clients/${clientA}/experiments`, {
    token: ownerA.token,
    body: {
      hypothesis: 'AI-drafted, human-approved creator replies raise top-fan reply completion',
      decisionTarget: 'whether to extend AI-assisted conversation triage to all top-fan enquiries',
      populationUnit: 'creator-conversation',
      treatment: 'AI-drafted + human-approved reply',
      comparison: 'manual-only baseline',
      assignmentMethod: 'single-arm observational cohort',
      designType: 'observational',
      primaryMetric: { name: 'creator.conversation.event_count', dimensions: { scenario: 'conversation-triage' } },
      guardrails: [],
      analysisMethod: 'descriptive pre/post comparison',
      stopCriteria: 'after the client decides on the triage rollout',
      minimumEvidenceRequirement: 'one approved send with creator evidence',
      uncertaintyRepresentation: 'interval',
      workspaceId: workspaceA,
    },
  });
  assert.equal(experiment.status, 201, JSON.stringify(experiment.body));
  experimentId = experiment.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start'] as const) {
    const stepped = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: ownerA.token,
      body: { transition },
    });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  }
});

after(async () => {
  await db?.close();
  if (api !== null) {
    api.child.kill('SIGKILL');
    api = null;
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// THE HUMAN APPROVER SEES — the room displays the authoritative creator
// state (UI-AC-01) while the decision is still pending
// ---------------------------------------------------------------------------

test('the client-side approver opens the room and SEES the creator-operation evidence with the experiment AWAITING the Client Decision (UI-AC-01)', async () => {
  const room = await getDecisionRoom(clientA, approverA.token);
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const body = room.body;

  // The scope is server-derived from durable ownership (never the caller).
  assert.deepEqual(body['scope'], {
    kind: 'client-decision-room',
    clientId: clientA,
    agencyId: agencyA,
  });

  // WHAT HAPPENED: the creator goal (active) + the pack-template workflow
  // with its RUNNING instance.
  const whatHappened = body['whatHappened'] as Record<string, unknown>;
  const goals = whatHappened['goals'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(goals.length, 1);
  assert.equal(goals[0]!['goalId'], goalId);
  assert.equal(goals[0]!['status'], 'active');
  assert.equal(
    (goals[0]!['successCriteria'] as ReadonlyArray<Record<string, unknown>>)[0]!['metric'],
    'creator.conversation.event_count',
  );
  const workflows = whatHappened['workflows'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0]!['workflowId'], workflowId);
  const roomInstances = workflows[0]!['instances'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(roomInstances.length, 1);
  assert.equal(roomInstances[0]!['workflowInstanceId'], workflowInstanceId);
  assert.equal(roomInstances[0]!['status'], 'running', 'the shared creator instance is still live');
  assert.equal((workflows[0]!['instanceCounts'] as Record<string, number>)['running'], 1);

  // EVIDENCE QUALITY: the creator evidence chain the pack mapped into the
  // common /evidence ledger (the inbound + the approved send observations).
  const quality = body['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 2, 'the two creator observations (inbound + approved send)');
  const byClass = quality['byClass'] as ReadonlyArray<Record<string, unknown>>;
  const observationPosture = byClass.find((entry) => entry['class'] === 'observation')!;
  assert.ok(observationPosture !== undefined, 'the creator observations are in the evidence posture');
  assert.deepEqual(observationPosture['gradeCounts'], { A: 0, B: 0, C: 2, D: 0, E: 0, F: 0 });

  // EXPERIMENTS: the creator experiment, RUNNING and undecided.
  const experiments = (body['experiments'] as Record<string, unknown>)['experiments'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(experiments.length, 1);
  const experimentView = experiments.find((entry) => entry['experimentId'] === experimentId)!;
  assert.equal(experimentView['status'], 'running');
  assert.equal(experimentView['resultState'], 'undecided');
  assert.ok(!('resultingDecision' in experimentView), 'no decision is surfaced while the experiment runs');

  // APPROVALS: the experiment awaiting the Client Decision — the pending
  // state the durable authority exposes (derived read, never invented).
  const approvals = (body['approvals'] as Record<string, unknown>)['items'] as ReadonlyArray<
    Record<string, unknown>
  >;
  assert.equal(approvals.length, 1);
  const pending = approvals[0]!;
  assert.equal(pending['kind'], 'experiment_awaiting_decision');
  assert.equal(pending['experimentId'], experimentId);
  assert.equal(pending['status'], 'running');
  assert.ok(String(pending['decisionTarget']).includes('extend AI-assisted conversation triage'));

  // WHY: no learning yet (the decision has not been recorded).
  const why = body['why'] as Record<string, unknown>;
  assert.deepEqual(why['learnings'], []);

  // RECOMMENDATIONS: no applicable learning and no decided experiment yet.
  const recommendations = body['recommendations'] as Record<string, unknown>;
  assert.deepEqual(recommendations['items'], []);
});

// ---------------------------------------------------------------------------
// THE ROOM IS READ-ONLY BY CONSTRUCTION (UI-AC-02) — the frozen UI authority
// has no write path at all
// ---------------------------------------------------------------------------

test('the room is read-only by construction: mutating verbs are 405, authority-shaped bodies/queries/headers change nothing, and the probes never touch durable state (UI-AC-02)', async () => {
  const snapshotBeforeProbes = await durableSnapshot(clientA);

  // Mutating verbs are rejected BEFORE any handler (METHOD_NOT_ALLOWED).
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    const response = await apiCall(port(), `/api/reporting/decision-room/${clientA}`, {
      token: approverA.token,
      method,
      body: { agencyId: agencyB, clientId: clientB, workspaceId: workspaceA, status: 'succeeded' },
    });
    assert.equal(response.status, 405, `${method} must be rejected`);
    assert.equal((response.body['error'] as Record<string, unknown>)['code'], 'METHOD_NOT_ALLOWED');
  }

  // GET ignores every authority-shaped query parameter: the scope is
  // server-derived only (byte-identical response).
  const baseline = await getDecisionRoom(clientA, approverA.token);
  assert.equal(baseline.status, 200);
  const poisoned = await apiCall(
    port(),
    `/api/reporting/decision-room/${clientA}?agencyId=${agencyB}&clientId=${clientB}&status=concluded`,
    { token: approverA.token },
  );
  assert.equal(poisoned.status, 200);
  assert.deepEqual(stableBody(poisoned.body), stableBody(baseline.body));

  // Forged authority headers change nothing (frontend checks are never
  // authoritative).
  const forged = await getDecisionRoom(clientA, approverA.token, {
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
      'x-experiment-id': experimentId,
      'x-resulting-decision': 'forged decision',
    },
  });
  assert.equal(forged.status, 200);
  assert.deepEqual(stableBody(forged.body), stableBody(baseline.body));

  // Anonymous calls never reach the surface (401, fail closed).
  const anonymous = await getDecisionRoom(clientA, undefined);
  assert.equal(anonymous.status, 401);

  // The hard tenant boundary: a foreign client's room is the uniform 404 —
  // indistinguishable from an unknown or malformed identifier.
  const foreign = await getDecisionRoom(clientB, approverA.token);
  const unknown = await getDecisionRoom(randomUUID(), approverA.token);
  const malformed = await getDecisionRoom('not-a-uuid', approverA.token);
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  assert.equal(malformed.status, 404);
  assert.equal((foreign.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');

  // After every read and probe, the durable authority rows are
  // BYTE-IDENTICAL (the room mutated nothing — there is no write path).
  const snapshotAfterProbes = await durableSnapshot(clientA);
  assert.equal(
    snapshotAfterProbes,
    snapshotBeforeProbes,
    'the decision room probes mutated nothing: creator messages/approvals, goals, instances, evidence, experiments and learnings are byte-stable',
  );
});

// ---------------------------------------------------------------------------
// THE CLIENT DECISION IS RECORDED THROUGH THE FROZEN AUTHORITY ONLY —
// the client-side approver cannot record it; the owning principal can
// ---------------------------------------------------------------------------

test('the Client Decision is recorded through the frozen /experiments authority only: the client-side approver is 403; the owner records it citing the SAME creator evidence', async () => {
  // The approver CANNOT record the decision through ANY UI surface: the
  // experiment transition surface demands owner|admin (insufficient role —
  // the room cannot grant what its reader lacks; UI-AC-02).
  const approverAttempt = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: approverA.token,
    body: { transition: 'begin_analysis' },
  });
  assert.equal(
    approverAttempt.status,
    403,
    `the client-side approver cannot forge decision authority: ${JSON.stringify(approverAttempt.body)}`,
  );
  const stillRunning = await apiCall(port(), `/api/experiments/${experimentId}`, { token: ownerA.token });
  assert.equal(stillRunning.body['status'], 'running', 'the rejected attempt mutated nothing');

  // The OWNER records the Client Decision through the frozen /experiments
  // authority (analyze → conclude with the resulting decision citing the
  // SAME creator evidence the room showed the approver).
  for (const transition of ['begin_analysis'] as const) {
    const stepped = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token: ownerA.token,
      body: { transition },
    });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  }
  const concluded = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: ownerA.token,
    body: {
      transition: 'conclude',
      conclusion: {
        resultState: 'observation',
        uncertainty: { kind: 'interval', lower: 1, upper: 5, level: 0.9 },
        assumptions: ['the sandboxed creator scenario is representative'],
        sampleLimitations: ['one conversation-triage cycle — a prove-it-first sample'],
        confounders: ['fan tier composition'],
        resultingDecision: CLIENT_DECISION,
        evidenceRefs: [inboundEvidenceId, sendEvidenceId],
      },
    },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  assert.equal(concluded.body['status'], 'concluded');

  // The Learning is appended through the frozen /learnings authority citing
  // the SAME evidence + the CONCLUDED experiment.
  const learning = await apiCall(port(), `/api/clients/${clientA}/learnings`, {
    token: ownerA.token,
    body: {
      statement:
        'AI-drafted, human-approved creator replies execute with complete evidence lineage and surface cleanly through the Client Decision Room.',
      applicability: { domain: 'creator-operations', channel: 'dm', fanTier: 'top_fan' },
      evidenceRefs: [inboundEvidenceId, sendEvidenceId],
      experimentRefs: [experimentId],
      confidence: 0.7,
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  learningId = learning.body['learningId'] as string;

  // The shared lifecycle closes through the frozen /workflows authority.
  const instanceRead = await apiCall(port(), `/api/workflows/${workflowId}/instances/${workflowInstanceId}`, {
    token: ownerA.token,
  });
  const instanceTerminal = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${workflowInstanceId}/transitions`,
    {
      token: ownerA.token,
      body: {
        to: 'succeeded',
        version: instanceRead.body['version'] as number,
        idempotencyKey: 'room-instance-succeeded',
        reason: 'the conversation-triage instance concluded through the experiment authority',
      },
    },
  );
  assert.equal(instanceTerminal.status, 200, JSON.stringify(instanceTerminal.body));
});

// ---------------------------------------------------------------------------
// THE APPROVER SEES THE RECORDED DECISION — the room surfaces the frozen
// authorities' outcome (UI-AC-01), still read-only
// ---------------------------------------------------------------------------

test('the approver re-opens the room and SEES the recorded Client Decision surfaced verbatim + the learning + the terminal instance (UI-AC-01)', async () => {
  const room = await getDecisionRoom(clientA, approverA.token);
  assert.equal(room.status, 200, JSON.stringify(room.body));
  const body = room.body;

  // WHAT HAPPENED: the terminal creator instance.
  const workflows = (body['whatHappened'] as Record<string, unknown>)['workflows'] as ReadonlyArray<
    Record<string, unknown>
  >;
  const roomInstances = workflows[0]!['instances'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(roomInstances[0]!['status'], 'succeeded');
  assert.equal((workflows[0]!['instanceCounts'] as Record<string, number>)['succeeded'], 1);

  // WHY: the learning with its creator evidence refs.
  const why = (body['why'] as Record<string, unknown>)['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(why.length, 1);
  assert.equal(why[0]!['learningId'], learningId);
  assert.equal(why[0]!['status'], 'active');
  assert.deepEqual(why[0]!['evidenceRefs'], [inboundEvidenceId, sendEvidenceId]);
  assert.deepEqual(why[0]!['experimentRefs'], [experimentId]);

  // EXPERIMENTS: the Client Decision surfaced VERBATIM (never re-derived).
  const experiments = (body['experiments'] as Record<string, unknown>)['experiments'] as ReadonlyArray<
    Record<string, unknown>
  >;
  const concludedView = experiments.find((entry) => entry['experimentId'] === experimentId)!;
  assert.equal(concludedView['status'], 'concluded');
  assert.equal(concludedView['resultState'], 'observation');
  assert.equal(concludedView['resultingDecision'], CLIENT_DECISION);

  // RECOMMENDATIONS: exactly the applicable learning + the declared
  // experiment decision — no invented lift.
  const recommendations = body['recommendations'] as Record<string, unknown>;
  assert.equal(recommendations['basis'], 'applicable_learnings_and_declared_experiment_decisions');
  const items = recommendations['items'] as ReadonlyArray<Record<string, unknown>>;
  const learningItems = items.filter((item) => item['kind'] === 'applicable_learning');
  const decisionItems = items.filter((item) => item['kind'] === 'experiment_decision');
  assert.equal(learningItems.length, 1);
  assert.equal(learningItems[0]!['learningId'], learningId);
  assert.equal(decisionItems.length, 1);
  assert.equal(decisionItems[0]!['experimentId'], experimentId);
  assert.equal(decisionItems[0]!['resultingDecision'], CLIENT_DECISION);
  for (const forbidden of ['lift', 'causalLift', 'incrementalEffect', 'uplift']) {
    assert.ok(!(forbidden in decisionItems[0]!), `the recommendation vocabulary has no '${forbidden}' field`);
  }

  // APPROVALS: nothing pending anymore — the decision was recorded.
  const approvals = (body['approvals'] as Record<string, unknown>)['items'] as readonly unknown[];
  assert.equal(approvals.length, 0);

  // The evidence posture is unchanged by the decision recording (the room
  // still shows exactly the creator evidence it showed before).
  const quality = body['evidenceQuality'] as Record<string, unknown>;
  assert.equal(quality['totalRecords'], 2);

  // The metric observation the goal's success criterion names is still
  // bound to the send evidence (the authoritative measurement chain).
  const metric = await apiCall(port(), `/api/metrics/${sendObservationId}`, { token: ownerA.token });
  assert.equal(metric.status, 200);
  assert.equal(metric.body['metricName'], 'creator.conversation.event_count');
  assert.equal(metric.body['evidenceRef'], sendEvidenceId);

  // And the room's reads STILL mutate nothing (a final snapshot check:
  // snapshot BEFORE the read, read, snapshot AFTER — byte-identical).
  const snapshotBeforeFinalRead = await durableSnapshot(clientA);
  const finalRead = await getDecisionRoom(clientA, ownerA.token);
  assert.equal(finalRead.status, 200);
  const durableAfterFinalRead = await durableSnapshot(clientA);
  assert.equal(
    durableAfterFinalRead,
    snapshotBeforeFinalRead,
    'the final decision-room read mutated nothing (byte-stable durable rows)',
  );
});
