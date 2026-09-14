/**
 * MKT-044 integration test — Client Operating Memory (the DERIVED
 * governed client-context projection and retrieval surface) against real
 * PostgreSQL + a real API subprocess + the module composed IN-PROCESS
 * through bootstrapApplication() against the SAME database (the
 * MKT-041/MKT-043 harness precedent).
 *
 * Proofs (spec/architecture-v1.5.md §6: "Client memory is a governed
 * projection over canonical client, goal, playbook, deployment,
 * evidence, experiment, outcome, decision and learning records.
 * Retrieval/index technology is non-authoritative."):
 *
 *   - THE FULL GOLDEN PATH OVER REAL AUTHORITIES: after the authority
 *     surfaces create the full memory chain (Goals → the client's OWN
 *     Playbook + versions + an agency-scoped reusable playbook →
 *     Deployments → Evidence with a supersession chain → an Experiment
 *     → a Learning → Decisions with an ACCEPTED disposition and its
 *     observed OUTCOME), the CLIENT MEMORY VIEW composes correctly with
 *     provenance — cross-checked against DIRECT SQL ground truth over
 *     the authority tables (every count and citation);
 *   - THE WORKSPACE SLICE: the covering rule (client-wide items + the
 *     workspace's own items) with the same disclosure discipline;
 *   - THE KIND-FILTERED RETRIEVAL: the record-kind path selector over
 *     the frozen vocabulary (unknown kind → the uniform 404) — a filter
 *     over DERIVED data, never a second query authority;
 *   - LIVE-FOLLOW: authority changes through the REAL authority APIs (a
 *     new evidence row, a new recorded decision, a new appended
 *     learning) flow into the memory view on the very NEXT read —
 *     nothing is cached or indexed anywhere (the no-persistence proof);
 *   - PROJECTION-VERSION PINNING: two consecutive reads of unchanged
 *     authorities derive BYTE-IDENTICAL bodies (generatedAt excluded);
 *     every item cites its canonical record id; the full frozen
 *     projection vocabulary ships in every response;
 *   - THE ISOLATION BATTERY (fail-closed): anonymous calls are 401; a
 *     foreign agency's owner gets the UNIFORM 404 (indistinguishable
 *     from malformed/unknown identifiers — no cross-agency existence
 *     oracle); a foreign Client and a foreign Workspace are the same
 *     uniform 404; a suspended membership is the 403; every mutating
 *     verb is 405 at the router (read-only by construction);
 *     authority-shaped query parameters change nothing; after every
 *     read/probe the authoritative rows are BYTE-IDENTICAL to the
 *     pre-read SQL digests (the surface has no write path at all);
 *   - MODULE-LEVEL FAIL-CLOSED: an unknown Client/Workspace identifier
 *     is the uniform 404 through the module contract too.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { ClientMemoryModuleApi } from '../../src/modules/client-memory/public.ts';
import {
  CLIENT_MEMORY_PROJECTION_VERSION,
  CLIENT_MEMORY_RECORD_KINDS,
  CLIENT_MEMORY_SELECTION_RULES,
} from '../../src/modules/client-memory/public.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { NotFoundError } from '../../src/platform/errors/errors.ts';
import { randomUUID } from 'node:crypto';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;
let memoryModule: ClientMemoryModuleApi | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function theModule(): ClientMemoryModuleApi {
  if (memoryModule === null) throw new Error('application not bootstrapped');
  return memoryModule;
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

async function makeUser(email: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, { token: admin, body: { password: PASSWORD } });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password: PASSWORD } });
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

async function addMembership(agencyId: string, user: User, role: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: user.userId, role },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['membershipId'] as string;
}

// ---------------------------------------------------------------------------
// Seeding helpers over the authorities' own API surfaces
// ---------------------------------------------------------------------------

function goalBody(objective: string, workspaceId: string | null): Record<string, unknown> {
  return {
    objective,
    ...(workspaceId === null ? {} : { workspaceId }),
    successCriteria: [
      { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: 'MRR target' },
    ],
    metrics: [{ name: 'revenue', unit: 'USD', description: 'observed only' }],
    constraints: [{ kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
  };
}

async function makeGoal(clientId: string, token: string, body: Record<string, unknown>): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, { token, body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['goalId'] as string;
}

async function makeClientPlaybook(
  clientId: string,
  token: string,
  goalId: string | null,
  name: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name, description: 'The client-memory fixture playbook.', goalId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['playbookId'] as string;
}

async function makeAgencyPlaybook(agencyId: string, token: string, name: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/playbooks`, {
    token,
    body: { name, description: 'The agency-scoped reusable playbook (must NOT enter client memory).' },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['playbookId'] as string;
}

async function publishPlaybookVersion(
  playbookId: string,
  token: string,
): Promise<string> {
  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token,
    body: {
      strategy: { summary: 'v1 strategy', templates: [{ name: 'SEO', description: 'Topic clusters' }] },
      deploymentMetadata: {
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggers: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const versionId = version.body['versionId'] as string;
  let versionVersion = version.body['version'] as number;
  for (const status of ['review', 'published'] as const) {
    const transition = await apiCall(
      port(),
      `/api/playbooks/${playbookId}/versions/${versionId}/status`,
      { token, method: 'PATCH', body: { status, version: versionVersion } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    versionVersion = transition.body['version'] as number;
  }
  return versionId;
}

async function makeDraftPlaybookVersion(playbookId: string, token: string): Promise<string> {
  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token,
    body: {
      strategy: { summary: 'v2 strategy', templates: [] },
      deploymentMetadata: {
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggers: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  return version.body['versionId'] as string;
}

const emptySchema = { type: 'object', properties: {}, required: [] };

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

function workflowContent(playbookVersionId: string | null): Record<string, unknown> {
  return {
    graph: {
      nodes: [functionNode('prep'), terminalNode('done')],
      edges: [
        { fromNode: 'prep', toNode: 'done', edgeType: 'success', predicateRef: null, joinSemantics: null },
      ],
    },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    ...(playbookVersionId === null ? {} : { playbookVersionId }),
  };
}

async function makeWorkflowWithDefinition(
  workspaceId: string,
  token: string,
  playbookVersionId: string | null,
  name: string,
): Promise<string> {
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name, description: 'The client-memory fixture workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: workflowContent(playbookVersionId),
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  let version = definition.body['version'] as number;
  for (const status of ['review', 'active'] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/status`,
      { token, method: 'PATCH', body: { status, version } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    version = transition.body['version'] as number;
  }
  return definitionId;
}

async function makeDeployment(
  workspaceId: string,
  token: string,
  playbookVersionId: string,
  workflowDefinitionId: string,
): Promise<string> {
  const deployment = await apiCall(port(), `/api/workspaces/${workspaceId}/deployments`, {
    token,
    body: {
      selection: {
        playbookVersionId,
        workflowDefinitionIds: [workflowDefinitionId],
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggerConfig: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(deployment.status, 201, `deployment: ${JSON.stringify(deployment.body)}`);
  return deployment.body['deploymentId'] as string;
}

async function appendEvidence(
  clientId: string,
  token: string,
  ref: string,
  workspaceId: string | null,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'observation',
      sourceSystem: 'meta-ads',
      sourceRef: ref,
      observedAt: '2026-09-15T10:30:00.000Z',
      content: { metric: 'revenue', value: 5000, unit: 'USD' },
      quality: 'B',
      ...(workspaceId === null ? {} : { workspaceId }),
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

async function supersedeEvidence(
  evidenceId: string,
  token: string,
  ref: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/evidence/${evidenceId}/supersede`, {
    token,
    body: {
      class: 'observation',
      sourceSystem: 'meta-ads',
      sourceRef: ref,
      observedAt: '2026-09-16T10:30:00.000Z',
      content: { metric: 'revenue', value: 5200, unit: 'USD' },
      quality: 'A',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

async function makeExperiment(clientId: string, token: string, workspaceId: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: {
      hypothesis: 'Shorter subject lines lift the newsletter open rate.',
      decisionTarget: 'Choose the Q3 newsletter subject format.',
      populationUnit: 'newsletter recipient',
      treatment: 'short-subject',
      comparison: 'status-quo subject line',
      assignmentMethod: 'random',
      designType: 'randomized',
      primaryMetric: { name: 'open_rate', dimensions: {} },
      guardrails: [],
      analysisMethod: 'difference-in-means',
      expectedDirection: 'increase',
      stopCriteria: '14 days or 2000 recipients.',
      minimumEvidenceRequirement: 'B — strong quasi-experimental at minimum',
      uncertaintyRepresentation: 'interval',
      workspaceId,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['experimentId'] as string;
}

async function makeLearning(
  clientId: string,
  token: string,
  statement: string,
  evidenceRefs: readonly string[],
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/learnings`, {
    token,
    body: {
      statement,
      applicability: { channel: 'email' },
      evidenceRefs,
      experimentRefs: [],
      confidence: 0.7,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['learningId'] as string;
}

async function recordDecision(
  clientId: string,
  token: string,
  overrides: Record<string, unknown>,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/decisions`, {
    token,
    body: {
      objective: 'Adopt the short-subject newsletter format.',
      context: 'The experiment is running; early reads are positive.',
      hypothesisSummary: 'A shorter subject line increases open rate.',
      evidenceRefs: [],
      expectedImpact: {
        summary: 'Open rate is expected to rise by roughly two points.',
        direction: 'increase',
        magnitude: '+2pt',
      },
      alternatives: ['Keep the status-quo subject line.'],
      idempotencyKey: `cm-decision-${randomUUID()}`,
      ...overrides,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['decision'] as Record<string, unknown>)['decisionId'] as string;
}

async function disposition(decisionId: string, token: string, command: string): Promise<void> {
  const response = await apiCall(port(), `/api/decisions/${decisionId}/disposition`, {
    token,
    body: { command, reason: `client-memory fixture ${command}`, idempotencyKey: `cm-disp-${randomUUID()}` },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function recordOutcome(
  decisionId: string,
  token: string,
  deploymentRef: string,
  learningRef: string,
): Promise<void> {
  const response = await apiCall(port(), `/api/decisions/${decisionId}/outcome`, {
    token,
    body: {
      observedOutcome: {
        summary: 'Open rate lifted 2.4 points, in line with the expectation.',
        asExpected: true,
        notes: 'Delivery stable; no unsubscribe spike.',
      },
      deploymentRef,
      learningRef,
      idempotencyKey: `cm-outcome-${randomUUID()}`,
    },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let ownerA: User = { userId: '', token: '' };
let memberA: User = { userId: '', token: '' };
let suspendedA: User = { userId: '', token: '' };
let ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceB = '';
let goalA1Id = '';
let goalA2Id = '';
let playbookOwnId = '';
let playbookAgencyId = '';
let playbookV1Id = '';
let playbookV2DraftId = '';
let deploymentA1Id = '';
let deploymentA2Id = '';
let evidence1Id = '';
let evidence2Id = '';
let evidence3Id = '';
let experiment1Id = '';
let learning1Id = '';
let decision1Id = '';
let decision2Id = '';
let definitionA1Id = '';
let definitionA2Id = '';

before(async () => {
  stack = await bootStack('clientmemory');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/MKT-041/MKT-043
  // precedent): the SAME application composed IN-PROCESS against the
  // SAME database the API serves — the module-level 404 proofs use it.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  memoryModule = core.modules.clientMemory;

  db = new PgDb(stack.env.databaseUrl, 2);

  // --- The tenants ---
  ownerA = await makeUser('owner-a@clientmemory.test');
  memberA = await makeUser('member-a@clientmemory.test');
  suspendedA = await makeUser('suspended-a@clientmemory.test');
  ownerB = await makeUser('owner-b@clientmemory.test');
  agencyA = await makeAgency('Client Memory Agency A', ownerA);
  agencyB = await makeAgency('Client Memory Agency B', ownerB);
  await addMembership(agencyA, memberA, 'client_collaborator');
  const suspendedMembershipId = await addMembership(agencyA, suspendedA, 'client_collaborator');
  // Suspend the third member (the intra-tenant 403 posture).
  const suspendedRow = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: ownerA.token,
  });
  const row = (suspendedRow.body['memberships'] as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry['membershipId'] === suspendedMembershipId,
  )!;
  const suspended = await apiCall(
    port(),
    `/api/agencies/${agencyA}/memberships/${suspendedMembershipId}`,
    { token: ownerA.token, method: 'PATCH', body: { status: 'disabled', version: row['version'] as number } },
  );
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));

  clientA = await makeClient(agencyA, 'Client Memory Client A');
  clientA2 = await makeClient(agencyA, 'Client Memory Client A2 (empty)');
  clientB = await makeClient(agencyB, 'Client Memory Client B');
  workspaceA1 = await makeWorkspace(clientA, 'Workspace A1 (delivery)');
  workspaceA2 = await makeWorkspace(clientA, 'Workspace A2 (secondary)');
  workspaceB = await makeWorkspace(clientB, 'Workspace B (foreign)');

  // --- The memory chain over today's authorities (client A) ---
  // Workspace-A1-scoped ACTIVE goal + client-wide ACHIEVED goal.
  goalA1Id = await makeGoal(clientA, ownerA.token, goalBody('Grow recurring revenue.', workspaceA1));
  goalA2Id = await makeGoal(clientA, ownerA.token, goalBody('Activate the newsletter program.', null));
  // goalA1: draft → active. goalA2: draft → active → achieved (the
  // frozen goal state machine has no draft → achieved edge).
  for (const goalId of [goalA1Id, goalA2Id]) {
    const activated = await apiCall(port(), `/api/goals/${goalId}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: 1 },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
  }
  const achieved = await apiCall(port(), `/api/goals/${goalA2Id}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'achieved', version: 2 },
  });
  assert.equal(achieved.status, 200, JSON.stringify(achieved.body));

  // The client's OWN playbook (goal-linked, published v1 + draft v2) AND
  // an agency-scoped reusable playbook (the disclosed exclusion).
  playbookOwnId = await makeClientPlaybook(clientA, ownerA.token, goalA1Id, 'Client A Own Playbook');
  playbookAgencyId = await makeAgencyPlaybook(agencyA, ownerA.token, 'Agency Reusable IP Playbook');
  playbookV1Id = await publishPlaybookVersion(playbookOwnId, ownerA.token);
  playbookV2DraftId = await makeDraftPlaybookVersion(playbookOwnId, ownerA.token);

  // Deployments across the client's workspaces (draft statuses — every
  // lifecycle state is memory). Each deployment declares a workflow
  // definition pinned to the published playbook version.
  definitionA1Id = await makeWorkflowWithDefinition(workspaceA1, ownerA.token, playbookV1Id, 'Memory Workflow A1');
  definitionA2Id = await makeWorkflowWithDefinition(workspaceA2, ownerA.token, playbookV1Id, 'Memory Workflow A2');
  deploymentA1Id = await makeDeployment(workspaceA1, ownerA.token, playbookV1Id, definitionA1Id);
  deploymentA2Id = await makeDeployment(workspaceA2, ownerA.token, playbookV1Id, definitionA2Id);

  // Evidence with a supersession chain: ev1 (workspace A1) superseded by
  // ev2 (current) + ev3 (client-wide current).
  evidence1Id = await appendEvidence(clientA, ownerA.token, 'report/2026-09-revenue', workspaceA1);
  evidence2Id = await supersedeEvidence(evidence1Id, ownerA.token, 'report/2026-09-revenue-restated');
  evidence3Id = await appendEvidence(clientA, ownerA.token, 'report/2026-09-clientwide', null);

  // Experiment (running) on workspace A1.
  experiment1Id = await makeExperiment(clientA, ownerA.token, workspaceA1);

  // Learning (client-wide, ACTIVE) citing the client-wide evidence.
  learning1Id = await makeLearning(
    clientA,
    ownerA.token,
    'Shorter subject lines lift the newsletter open rate.',
    [evidence3Id],
  );

  // Decision 1 (workspace A1): recorded → ACCEPTED → observed OUTCOME
  // with the deployment + learning references and the evidence/experiment
  // citations.
  decision1Id = await recordDecision(clientA, ownerA.token, {
    workspaceId: workspaceA1,
    evidenceRefs: [evidence3Id],
    experimentRef: experiment1Id,
  });
  await disposition(decision1Id, ownerA.token, 'accept');
  await recordOutcome(decision1Id, ownerA.token, deploymentA1Id, learning1Id);

  // Decision 2 (client-wide): REJECTED.
  decision2Id = await recordDecision(clientA, ownerA.token, {
    objective: 'Spin up a paid podcast channel.',
    workspaceId: undefined,
  });
  await disposition(decision2Id, ownerA.token, 'reject');
});

after(async () => {
  await db?.close();
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Helpers for reading the derived views
// ---------------------------------------------------------------------------

async function clientMemoryView(token: string): Promise<Record<string, unknown>> {
  const response = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}`,
    { token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  return response.body;
}

// ---------------------------------------------------------------------------
// 1. THE GOLDEN PATH — the client memory view over real authorities, with
//    DIRECT SQL ground truth (AC-2/AC-7)
// ---------------------------------------------------------------------------

test('the client memory view composes the full governed projection from real authorities — cross-checked against DIRECT SQL ground truth', async () => {
  const view = await clientMemoryView(ownerA.token);

  // Scope.
  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'client-memory');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientId'], clientA);
  assert.equal(scope['workspaceCount'], 2);

  // Profile — the client record cited canonically.
  const profile = view['profile'] as Record<string, unknown>;
  assert.deepEqual(profile['sourceRef'], { kind: 'client', id: clientA });
  assert.equal(profile['name'], 'Client Memory Client A');
  assert.equal(profile['status'], 'active');

  // Workspace recaps.
  const workspaces = view['workspaces'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    workspaces.map((workspace) => workspace['workspaceId']),
    [workspaceA1, workspaceA2],
  );

  const items = view['items'] as ReadonlyArray<Record<string, unknown>>;
  const perKind = view['perKind'] as Record<string, number>;

  // --- GOALS: all lifecycle states retained. ---
  assert.equal(perKind['goal'], 2);
  // GROUND TRUTH (SQL).
  const goalRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM goals WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(goalRows.rows[0]!.count), 2);
  const goalItems = items.filter((item) => item['kind'] === 'goal');
  assert.deepEqual(
    goalItems.map((item) => item['id']).sort(),
    [goalA1Id, goalA2Id].sort(),
  );
  const goalA1 = goalItems.find((item) => item['id'] === goalA1Id)!;
  assert.equal(goalA1['status'], 'active');
  assert.equal(goalA1['workspaceId'], workspaceA1);
  assert.equal(goalA1['summary'], 'Grow recurring revenue.');

  // --- PLAYBOOKS: the client's OWN playbook only (the agency-scoped
  // reusable IP is the DISCLOSED exclusion — never silently dropped). ---
  assert.equal(perKind['playbook'], 1);
  assert.equal(items.find((item) => item['kind'] === 'playbook')!['id'], playbookOwnId);
  assert.ok(!items.some((item) => item['id'] === playbookAgencyId));
  // GROUND TRUTH (SQL): one client-scoped playbook row, one agency-scoped.
  const playbookRows = await db!.query<{ scoped: string; agency: string }>(
    `SELECT count(*) FILTER (WHERE client_id = $1)::text AS scoped,
            count(*) FILTER (WHERE client_id IS NULL AND agency_id = $2)::text AS agency
     FROM playbooks`,
    [clientA, agencyA],
  );
  assert.equal(Number(playbookRows.rows[0]!.scoped), 1);
  assert.equal(Number(playbookRows.rows[0]!.agency), 1);
  // The playbook links its goal.
  assert.deepEqual(
    items.find((item) => item['kind'] === 'playbook')!['links'],
    [{ kind: 'goal', id: goalA1Id }],
  );

  // --- PLAYBOOK VERSIONS: every immutable version (published + draft). ---
  assert.equal(perKind['playbook-version'], 2);
  const versionItems = items.filter((item) => item['kind'] === 'playbook-version');
  assert.deepEqual(
    versionItems.map((item) => item['id']).sort(),
    [playbookV1Id, playbookV2DraftId].sort(),
  );
  // GROUND TRUTH (SQL).
  const versionRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM playbook_versions WHERE playbook_id = $1`,
    [playbookOwnId],
  );
  assert.equal(Number(versionRows.rows[0]!.count), 2);

  // --- DEPLOYMENTS: every deployment across the LIVE workspaces. ---
  assert.equal(perKind['deployment'], 2);
  // GROUND TRUTH (SQL).
  const deploymentRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM deployments WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(deploymentRows.rows[0]!.count), 2);
  const deploymentA1 = items.find((item) => item['id'] === deploymentA1Id)!;
  assert.equal(deploymentA1['workspaceId'], workspaceA1);
  assert.deepEqual(
    deploymentA1['links'],
    [{ kind: 'playbook-version', id: playbookV1Id }],
  );

  // --- EVIDENCE: current rows only; the superseded predecessor counted. ---
  assert.equal(perKind['evidence'], 2);
  assert.equal(view['supersededEvidenceCount'], 1);
  const evidenceIds = items.filter((item) => item['kind'] === 'evidence').map((item) => item['id']);
  assert.ok(evidenceIds.includes(evidence2Id));
  assert.ok(evidenceIds.includes(evidence3Id));
  assert.ok(!evidenceIds.includes(evidence1Id));
  // GROUND TRUTH (SQL): the current/superseded split over the authority
  // (a row is superseded exactly when another row's supersedes_evidence_id
  // points at it — the authority's own derivation).
  const evidenceRows = await db!.query<{ current: string; superseded: string }>(
    `SELECT count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM evidence e2 WHERE e2.supersedes_evidence_id = e.evidence_id))::text AS current,
            count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM evidence e2 WHERE e2.supersedes_evidence_id = e.evidence_id))::text AS superseded
     FROM evidence e WHERE e.client_id = $1`,
    [clientA],
  );
  assert.equal(Number(evidenceRows.rows[0]!.current), 2);
  assert.equal(Number(evidenceRows.rows[0]!.superseded), 1);
  // The current chain row cites its superseded predecessor.
  const evidence2 = items.find((item) => item['id'] === evidence2Id)!;
  assert.deepEqual(evidence2['links'], [{ kind: 'evidence', id: evidence1Id }]);
  assert.equal(evidence2['status'], 'A');

  // --- EXPERIMENTS: every record, any state. ---
  assert.equal(perKind['experiment'], 1);
  assert.equal(items.find((item) => item['kind'] === 'experiment')!['id'], experiment1Id);
  // GROUND TRUTH (SQL).
  const experimentRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM experiments WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(experimentRows.rows[0]!.count), 1);

  // --- OUTCOMES: the observed outcome on the ACCEPTED decision. ---
  assert.equal(perKind['outcome'], 1);
  const outcomeItem = items.find((item) => item['kind'] === 'outcome')!;
  // The outcome is cited BY the decision id — the canonical record.
  assert.equal(outcomeItem['id'], decision1Id);
  assert.equal(outcomeItem['status'], 'as-expected');
  assert.ok(String(outcomeItem['summary']).includes('Open rate lifted 2.4 points'));
  // GROUND TRUTH (SQL): exactly one observed outcome, on an accepted row.
  const outcomeRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM decisions
     WHERE client_id = $1 AND observed_outcome IS NOT NULL AND disposition = 'accepted'`,
    [clientA],
  );
  assert.equal(Number(outcomeRows.rows[0]!.count), 1);

  // --- DECISIONS: every record, any disposition. ---
  assert.equal(perKind['decision'], 2);
  const decisionItems = items.filter((item) => item['kind'] === 'decision');
  assert.deepEqual(
    decisionItems.map((item) => item['id']).sort(),
    [decision1Id, decision2Id].sort(),
  );
  // GROUND TRUTH (SQL).
  const decisionRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM decisions WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(decisionRows.rows[0]!.count), 2);
  const decision1 = decisionItems.find((item) => item['id'] === decision1Id)!;
  assert.equal(decision1['status'], 'accepted');
  // The decision cites its evidence + experiment + deployment + learning.
  const decisionLinks = decision1['links'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(decisionLinks.some((link) => link['kind'] === 'evidence' && link['id'] === evidence3Id));
  assert.ok(decisionLinks.some((link) => link['kind'] === 'experiment' && link['id'] === experiment1Id));
  assert.ok(decisionLinks.some((link) => link['kind'] === 'deployment' && link['id'] === deploymentA1Id));
  assert.ok(decisionLinks.some((link) => link['kind'] === 'learning' && link['id'] === learning1Id));

  // --- LEARNINGS: every record with its derived state. ---
  assert.equal(perKind['learning'], 1);
  const learningItem = items.find((item) => item['kind'] === 'learning')!;
  assert.equal(learningItem['id'], learning1Id);
  assert.equal(learningItem['status'], 'active');
  assert.deepEqual(
    learningItem['links'],
    [{ kind: 'evidence', id: evidence3Id }],
  );
  // GROUND TRUTH (SQL).
  const learningRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM learnings WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(learningRows.rows[0]!.count), 1);

  // --- THE GOVERNANCE DISCLOSURE (AC-3: policy-visible composition). ---
  const projection = view['projection'] as Record<string, unknown>;
  assert.equal(projection['projectionVersion'], CLIENT_MEMORY_PROJECTION_VERSION);
  assert.deepEqual(projection['recordKinds'], [...CLIENT_MEMORY_RECORD_KINDS]);
  assert.deepEqual(projection['selectionRules'], CLIENT_MEMORY_SELECTION_RULES);
  assert.equal(projection['basis'], 'live-derivation-over-canonical-authorities');
  assert.equal(projection['persistence'], 'none-derived-read-model');
  assert.equal(projection['retrievalTechnology'], 'none-live-composition-only');
  assert.ok(typeof view['generatedAt'] === 'string');

  // Every item carries the canonical citation shape.
  for (const item of items) {
    assert.ok(typeof item['kind'] === 'string');
    assert.ok(typeof item['id'] === 'string' && (item['id'] as string).length >= 36);
    assert.ok(typeof item['summary'] === 'string');
    assert.ok(Array.isArray(item['links']));
    assert.ok(item['workspaceId'] === null || typeof item['workspaceId'] === 'string');
  }

  // Any ACTIVE member of the owning agency may read (the read posture).
  const memberView = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}`,
    { token: memberA.token },
  );
  assert.equal(memberView.status, 200);

  // The EMPTY client tallies honest zeros (nothing recorded is nothing
  // remembered — never an error, never invented rows).
  const emptyView = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA2}`,
    { token: ownerA.token },
  );
  assert.equal(emptyView.status, 200);
  const emptyPerKind = (emptyView.body as Record<string, unknown>)['perKind'] as Record<string, number>;
  for (const kind of CLIENT_MEMORY_RECORD_KINDS) {
    assert.equal(emptyPerKind[kind], 0, `the empty client's '${kind}' count is an honest zero`);
  }
  assert.equal(
    ((emptyView.body as Record<string, unknown>)['items'] as unknown[]).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// 2. THE WORKSPACE SLICE (the covering-rule projection)
// ---------------------------------------------------------------------------

test('the workspace memory slice carries client-wide items plus the workspace own items only', async () => {
  const response = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  const view = response.body;

  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'workspace-memory');
  assert.equal(scope['workspaceId'], workspaceA1);
  assert.equal(scope['clientId'], clientA);

  const perKind = view['perKind'] as Record<string, number>;
  const items = view['items'] as ReadonlyArray<Record<string, unknown>>;

  // goalA1 (workspace A1) + goalA2 (client-wide) cover workspace A1.
  assert.equal(perKind['goal'], 2);
  // dep-1 only — dep-2 is workspace A2's.
  assert.equal(perKind['deployment'], 1);
  assert.ok(items.some((item) => item['id'] === deploymentA1Id));
  assert.ok(!items.some((item) => item['id'] === deploymentA2Id));
  // ev-2 (workspace A1 current) + ev-3 (client-wide); the superseded
  // ev-1 is never presented, still counted.
  assert.equal(perKind['evidence'], 2);
  assert.equal(view['supersededEvidenceCount'], 1);
  // dec-1 (workspace A1, + its outcome) + dec-2 (client-wide).
  assert.equal(perKind['decision'], 2);
  assert.equal(perKind['outcome'], 1);
  // The client-level playbooks cover every workspace slice.
  assert.equal(perKind['playbook'], 1);
  assert.equal(perKind['playbook-version'], 2);
  // experiment-1 is workspace A1's.
  assert.equal(perKind['experiment'], 1);
  // learning-1 is client-wide.
  assert.equal(perKind['learning'], 1);

  // Workspace A2's slice: goalA2 (client-wide) + dep-2 only; NO dec-1
  // outcome, NO experiment.
  const view2 = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${workspaceA2}`,
    { token: ownerA.token },
  );
  assert.equal(view2.status, 200);
  const perKind2 = (view2.body as Record<string, unknown>)['perKind'] as Record<string, number>;
  assert.equal(perKind2['goal'], 1);
  assert.equal(perKind2['deployment'], 1);
  assert.equal(perKind2['decision'], 1);
  assert.equal(perKind2['outcome'], 0);
  assert.equal(perKind2['experiment'], 0);

  // The disclosure ships on the workspace surface too.
  const projection = (view as Record<string, unknown>)['projection'] as Record<string, unknown>;
  assert.equal(projection['projectionVersion'], CLIENT_MEMORY_PROJECTION_VERSION);
  assert.deepEqual(projection['selectionRules'], CLIENT_MEMORY_SELECTION_RULES);
});

// ---------------------------------------------------------------------------
// 3. THE KIND-FILTERED RETRIEVAL (search/filter over DERIVED data)
// ---------------------------------------------------------------------------

test('the kind-filtered retrieval presents one frozen-vocabulary kind from the derived items; an unknown kind is the uniform 404', async () => {
  const response = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/decision`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  const slice = response.body as Record<string, unknown>;
  const scope = slice['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'client-memory-kind-slice');
  assert.equal(scope['recordKind'], 'decision');
  const items = slice['items'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(items.length, 2);
  assert.ok(items.every((item) => item['kind'] === 'decision'));
  assert.equal(slice['perKindTotal'], 2);

  // The outcome slice — the composed outcome surface.
  const outcomeSlice = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/outcome`,
    { token: ownerA.token },
  );
  assert.equal(outcomeSlice.status, 200);
  const outcomeItems = (outcomeSlice.body as Record<string, unknown>)['items'] as unknown[];
  assert.equal(outcomeItems.length, 1);

  // An UNKNOWN kind is the uniform 404 (fail-closed, no vocabulary
  // oracle) — indistinguishable from an unknown record.
  const unknownKind = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/not-a-kind`,
    { token: ownerA.token },
  );
  assert.equal(unknownKind.status, 404);
  // A member may read the slice too.
  const memberSlice = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/evidence`,
    { token: memberA.token },
  );
  assert.equal(memberSlice.status, 200);
  assert.equal(
    ((memberSlice.body as Record<string, unknown>)['items'] as unknown[]).length,
    2,
  );
});

// ---------------------------------------------------------------------------
// 4. LIVE-FOLLOW — authority changes flow into the memory on the NEXT read
// ---------------------------------------------------------------------------

test('live-follow: new evidence, a new decision and a new learning enter the memory on the very next read', async () => {
  const before = await clientMemoryView(ownerA.token);
  const beforePerKind = before['perKind'] as Record<string, number>;
  assert.equal(beforePerKind['evidence'], 2);
  assert.equal(beforePerKind['decision'], 2);
  assert.equal(beforePerKind['learning'], 1);

  // --- A NEW evidence row (through the REAL authority API). ---
  const liveEvidenceId = await appendEvidence(
    clientA,
    ownerA.token,
    'report/2026-10-livefollow',
    null,
  );
  // --- A NEW recorded decision (through the REAL authority API). ---
  const liveDecisionId = await recordDecision(clientA, ownerA.token, {
    objective: 'Expand the short-subject format to the loyalty segment.',
  });
  // --- A NEW appended learning (through the REAL authority API). ---
  const liveLearningId = await makeLearning(
    clientA,
    ownerA.token,
    'Loyalty segments respond to shorter subjects too.',
    [liveEvidenceId],
  );

  const after = await clientMemoryView(ownerA.token);
  const afterPerKind = after['perKind'] as Record<string, number>;
  assert.equal(afterPerKind['evidence'], 3, 'evidence follows the new row immediately');
  assert.equal(afterPerKind['decision'], 3, 'decisions follow the new record immediately');
  assert.equal(afterPerKind['learning'], 2, 'learnings follow the new append immediately');
  const afterItems = after['items'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(afterItems.some((item) => item['id'] === liveEvidenceId));
  assert.ok(afterItems.some((item) => item['id'] === liveDecisionId));
  assert.ok(afterItems.some((item) => item['id'] === liveLearningId));
  assert.equal(after['supersededEvidenceCount'], 1, 'the supersession disclosure is unchanged');

  // SQL ground truth for the live-follow state.
  const evidenceRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evidence WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(evidenceRows.rows[0]!.count), 4);
  const decisionRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM decisions WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(decisionRows.rows[0]!.count), 3);
  const learningRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM learnings WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(learningRows.rows[0]!.count), 2);
});

// ---------------------------------------------------------------------------
// 5. PROJECTION-VERSION PINNING — same state ⇒ byte-identical body
// ---------------------------------------------------------------------------

test('projection-version pinning: two consecutive reads of unchanged authorities are byte-identical (generatedAt excluded)', async () => {
  const first = await clientMemoryView(ownerA.token);
  const second = await clientMemoryView(ownerA.token);
  const strip = (body: Record<string, unknown>): string => {
    const copy = { ...body } as Record<string, unknown>;
    delete copy['generatedAt'];
    return JSON.stringify(copy);
  };
  assert.equal(
    strip(second),
    strip(first),
    'same authority state + same projection version ⇒ byte-identical memory views',
  );
});

// ---------------------------------------------------------------------------
// 6. THE ISOLATION BATTERY (fail-closed)
// ---------------------------------------------------------------------------

test('anonymous calls are 401; foreign/malformed/unknown agencies, clients and workspaces are the uniform 404', async () => {
  // Anonymous (fail closed at the authenticator).
  const anonymous = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}`,
  );
  assert.equal(anonymous.status, 401);

  // A FOREIGN agency's owner probing agency A: the uniform 404 (never a
  // 403 that leaks the agency's existence).
  const foreign = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}`,
    { token: ownerB.token },
  );
  assert.equal(foreign.status, 404);

  // Malformed and unknown agency identifiers: the SAME 404.
  const malformed = await apiCall(
    port(),
    `/api/client-memory/not-a-uuid/clients/${clientA}`,
    { token: ownerA.token },
  );
  assert.equal(malformed.status, 404);
  const unknownAgency = await apiCall(
    port(),
    `/api/client-memory/${randomUUID()}/clients/${clientA}`,
    { token: ownerA.token },
  );
  assert.equal(unknownAgency.status, 404);

  // The client detail of ANOTHER agency's client: the uniform 404.
  const foreignAgencyClient = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignAgencyClient.status, 404);
  const malformedClient = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/not-a-uuid`,
    { token: ownerA.token },
  );
  assert.equal(malformedClient.status, 404);
  const unknownClient = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${randomUUID()}`,
    { token: ownerA.token },
  );
  assert.equal(unknownClient.status, 404);

  // The workspace detail of ANOTHER client's workspace: the uniform 404.
  const foreignWorkspace = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${workspaceB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignWorkspace.status, 404);
  const malformedWorkspace = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/not-a-uuid`,
    { token: ownerA.token },
  );
  assert.equal(malformedWorkspace.status, 404);
  const unknownWorkspace = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${randomUUID()}`,
    { token: ownerA.token },
  );
  assert.equal(unknownWorkspace.status, 404);

  // The kind-filtered retrieval of a foreign client: the same 404.
  const foreignKindSlice = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientB}/records/decision`,
    { token: ownerA.token },
  );
  assert.equal(foreignKindSlice.status, 404);

  // A SUSPENDED membership is the 403 (intra-tenant, post-existence).
  const suspended = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}`,
    { token: suspendedA.token },
  );
  assert.equal(suspended.status, 403);
});

test('READ-ONLY BY CONSTRUCTION: every mutating verb is 405 at the router; authority-shaped query parameters change nothing', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const path of [
      `/api/client-memory/${agencyA}/clients/${clientA}`,
      `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`,
      `/api/client-memory/${agencyA}/clients/${clientA}/records/decision`,
    ]) {
      const response = await apiCall(port(), path, { token: ownerA.token, method });
      assert.equal(response.status, 405, `${method} ${path} must be 405`);
    }
  }

  // Authority-shaped query parameters change nothing (the surface reads
  // none of them — the router strips the query string before handlers
  // run; bodies on GETs are ignored entirely).
  const plain = await clientMemoryView(ownerA.token);
  const polluted = await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}?agencyId=${agencyB}&clientId=${clientB}&projectionVersion=forged&status=deleted`,
    { token: ownerA.token },
  );
  assert.equal(polluted.status, 200);
  const strip = (body: Record<string, unknown>): string => {
    const copy = { ...body } as Record<string, unknown>;
    delete copy['generatedAt'];
    return JSON.stringify(copy);
  };
  assert.equal(strip(polluted.body as Record<string, unknown>), strip(plain), 'query parameters are never read');
});

test('after every read/probe the authoritative rows are BYTE-IDENTICAL (the surface has no write path)', async () => {
  const snapshot = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'goals' AS rel, md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id)) AS digest
       FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'evidence', md5(string_agg(e.evidence_id::text, ',' ORDER BY e.evidence_id))
       FROM evidence e WHERE e.client_id = $1
     UNION ALL
     SELECT 'experiments', md5(string_agg(x.experiment_id::text, ',' ORDER BY x.experiment_id))
       FROM experiments x WHERE x.client_id = $1
     UNION ALL
     SELECT 'decisions', md5(string_agg(d.decision_id::text, ',' ORDER BY d.decision_id))
       FROM decisions d WHERE d.client_id = $1
     UNION ALL
     SELECT 'learnings', md5(string_agg(l.learning_id::text, ',' ORDER BY l.learning_id))
       FROM learnings l WHERE l.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(dp.deployment_id::text, ',' ORDER BY dp.deployment_id))
       FROM deployments dp WHERE dp.client_id = $1
     UNION ALL
     SELECT 'playbooks', md5(string_agg(p.playbook_id::text, ',' ORDER BY p.playbook_id))
       FROM playbooks p WHERE p.client_id = $1
     UNION ALL
     SELECT 'playbook_versions', md5(string_agg(v.version_id::text, ',' ORDER BY v.version_id))
       FROM playbook_versions v JOIN playbooks p ON p.playbook_id = v.playbook_id
       WHERE p.client_id = $1
     UNION ALL
     SELECT 'clients', md5(string_agg(c.client_id::text, ',' ORDER BY c.client_id))
       FROM clients c WHERE c.client_id = $1`,
    [clientA],
  );
  const before = new Map(snapshot.rows.map((row) => [row.rel, row.digest]));

  // A battery of reads and probes.
  await apiCall(port(), `/api/client-memory/${agencyA}/clients/${clientA}`, { token: ownerA.token });
  await apiCall(port(), `/api/client-memory/${agencyA}/clients/${clientA}`, {
    token: memberA.token,
  });
  await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`,
    { token: ownerA.token },
  );
  await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/evidence`,
    { token: ownerA.token },
  );
  await apiCall(port(), `/api/client-memory/${agencyA}/clients/${clientA}`, { token: ownerB.token });
  await apiCall(port(), `/api/client-memory/not-a-uuid/clients/${clientA}`, { token: ownerA.token });
  await apiCall(
    port(),
    `/api/client-memory/${agencyA}/clients/${clientA}/records/not-a-kind`,
    { token: ownerA.token },
  );
  await apiCall(port(), `/api/client-memory/${agencyA}/clients/${clientA}`, {
    token: ownerA.token,
    method: 'POST',
    body: { clientId: clientB, projectionVersion: 'forged', status: 'deleted' },
  });
  await apiCall(port(), `/api/client-memory/${agencyA}/clients/${clientA}`, { token: suspendedA.token });

  const after = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'goals' AS rel, md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id)) AS digest
       FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'evidence', md5(string_agg(e.evidence_id::text, ',' ORDER BY e.evidence_id))
       FROM evidence e WHERE e.client_id = $1
     UNION ALL
     SELECT 'experiments', md5(string_agg(x.experiment_id::text, ',' ORDER BY x.experiment_id))
       FROM experiments x WHERE x.client_id = $1
     UNION ALL
     SELECT 'decisions', md5(string_agg(d.decision_id::text, ',' ORDER BY d.decision_id))
       FROM decisions d WHERE d.client_id = $1
     UNION ALL
     SELECT 'learnings', md5(string_agg(l.learning_id::text, ',' ORDER BY l.learning_id))
       FROM learnings l WHERE l.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(dp.deployment_id::text, ',' ORDER BY dp.deployment_id))
       FROM deployments dp WHERE dp.client_id = $1
     UNION ALL
     SELECT 'playbooks', md5(string_agg(p.playbook_id::text, ',' ORDER BY p.playbook_id))
       FROM playbooks p WHERE p.client_id = $1
     UNION ALL
     SELECT 'playbook_versions', md5(string_agg(v.version_id::text, ',' ORDER BY v.version_id))
       FROM playbook_versions v JOIN playbooks p ON p.playbook_id = v.playbook_id
       WHERE p.client_id = $1
     UNION ALL
     SELECT 'clients', md5(string_agg(c.client_id::text, ',' ORDER BY c.client_id))
       FROM clients c WHERE c.client_id = $1`,
    [clientA],
  );
  for (const row of after.rows) {
    assert.equal(
      row.digest,
      before.get(row.rel),
      `the ${row.rel} authority rows are byte-identical after every read/probe`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. MODULE-LEVEL FAIL-CLOSED (the contract's own 404s)
// ---------------------------------------------------------------------------

test('the module-level reads of unknown Client/Workspace identifiers are the uniform 404', async () => {
  await assert.rejects(
    () => theModule().getClientMemory({ clientId: randomUUID() }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 (module level)',
  );
  await assert.rejects(
    () => theModule().getWorkspaceMemory({ workspaceId: randomUUID() }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Workspace identifier is the uniform 404 (module level)',
  );
  await assert.rejects(
    () => theModule().getClientMemoryByKind({ clientId: randomUUID(), kind: 'decision' }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 on the kind slice too (module level)',
  );
});
