/**
 * MKT-045 integration test — the AI Operator attention queue (the DERIVED
 * ranked read model) against real PostgreSQL + a real API subprocess + the
 * module composed IN-PROCESS through bootstrapApplication() against the
 * SAME database (the MKT-043 profit-intelligence harness precedent).
 *
 * Proofs (spec/architecture-v1.5.md §7; spec/module-dependency-matrix.md
 * "/ai-operator ──→ /clients, /workspaces, /workflows, /executions,
 * /deployments, /jobs, /policies, /evidence, /experiments, /learnings,
 * /field-agents, /profit-intelligence"):
 *
 *   - THE FULL GOLDEN PATH OVER REAL AUTHORITIES: after the authority
 *     surfaces create the real chain (Goal → Playbook Version →
 *     Deployment → Workflow/Definition/Instances → Executions in
 *     failed/unknown/paused states → a blocked deployment, a blocked
 *     instance, a declined Job → weak-grade Evidence → ready/concluded
 *     Experiments → a contradicted Learning → two undecided policy
 *     decisions → the human-agent pool + six open projected Jobs), the
 *     AGENCY queue derives the exact ranked items — every category of the
 *     frozen §7 vocabulary, cross-checked against DIRECT SQL ground truth
 *     over the authority tables (every count), with the exact
 *     deterministic ao-rank-v1 scores and the total order;
 *   - THE CLIENT SLICE: the client view narrows to the client's own items
 *     (the agency-scoped approvals and the agency-pool capacity
 *     constraint excluded, the capacity exclusion DISCLOSED);
 *   - THE ITEM DETAIL: the deterministic item id re-derives the queue and
 *     locates the item in context (queue counts + category counts);
 *   - LIVE-FOLLOW: authority changes through the REAL authority APIs (a
 *     new weak-evidence record, an execution transitioned to failed, a
 *     third undecided policy decision) flow into the queue on the very
 *     NEXT read — nothing is cached anywhere (the no-persistence proof);
 *   - RANK-VERSION PINNING: two consecutive reads of unchanged
 *     authorities are BYTE-IDENTICAL (generatedAt excluded);
 *   - THE ISOLATION BATTERY (fail-closed): anonymous calls are 401; a
 *     foreign agency's owner gets the UNIFORM 404 (indistinguishable
 *     from malformed/unknown identifiers — no cross-agency existence
 *     oracle); a foreign Client is the same uniform 404; a foreign,
 *     unknown or malformed item id is the same uniform 404 (foreign ≡
 *     unknown ≡ malformed — the queue re-derives, nothing is stored); a
 *     suspended membership is the 403; every mutating verb is 405 at the
 *     router (READ-ONLY BY CONSTRUCTION — no write path exists at all);
 *     authority-shaped query parameters change nothing; after every
 *     read/probe the authoritative rows are BYTE-IDENTICAL to the
 *     pre-read SQL digests;
 *   - THE EMPTY AGENCY: an agency with no attention state derives an
 *     EMPTY queue with honest zero counts (nothing fabricated);
 *   - MODULE-LEVEL FAIL-CLOSED: an unknown Client identifier and an
 *     unknown attention item id are the uniform 404 through the module
 *     contract too.
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
import { bootstrapApplication } from '../../src/composition-root.ts';
import type { AiOperatorModuleApi } from '../../src/modules/ai-operator/public.ts';
import {
  AI_OPERATOR_ASSUMPTIONS,
  AI_OPERATOR_RANK_VERSION,
  ATTENTION_CATEGORY_VOCABULARY_VERSION,
} from '../../src/modules/ai-operator/public.ts';
import { PROFIT_INTELLIGENCE_CALCULATION_VERSION } from '../../src/modules/profit-intelligence/public.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;
let aiOperatorModule: AiOperatorModuleApi | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function theModule(): AiOperatorModuleApi {
  if (aiOperatorModule === null) throw new Error('application not bootstrapped');
  return aiOperatorModule;
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

function goalBody(objective: string, workspaceId: string | null, criteria: unknown[]): Record<string, unknown> {
  return {
    objective,
    ...(workspaceId === null ? {} : { workspaceId }),
    successCriteria: criteria,
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

function workflowContent(playbookVersionId: string | null, nodes: Record<string, unknown>[]): Record<string, unknown> {
  const edges = nodes.slice(0, -1).map((node, index) => ({
    fromNode: node['nodeId'] as string,
    toNode: nodes[index + 1]!['nodeId'] as string,
    edgeType: 'success',
    predicateRef: null,
    joinSemantics: null,
  }));
  return {
    graph: { nodes, edges },
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
  nodes: Record<string, unknown>[],
): Promise<{ workflowId: string; definitionId: string }> {
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name, description: 'The ai-operator fixture workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: workflowContent(playbookVersionId, nodes),
  });
  assert.equal(definition.status, 201, `definition: ${JSON.stringify(definition.body).slice(0, 400)}`);
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
  return { workflowId, definitionId };
}

async function makeRunningInstance(
  workflowId: string,
  definitionId: string,
  token: string,
): Promise<{ instanceId: string; version: number }> {
  const instance = await apiCall(
    port(),
    `/api/workflows/${workflowId}/definitions/${definitionId}/instances`,
    { token, body: {} },
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
        token,
        body: { to, version: instanceVersion, idempotencyKey: `ao-setup-${to}-${instanceId}` },
      },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }
  return { instanceId, version: instanceVersion };
}

async function makeExecution(
  workspaceId: string,
  token: string,
  workflowInstanceId: string,
  nodeId: string,
  executionKind: string,
  idempotencyKey: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      workflowInstanceId,
      nodeId,
      executionKind,
      runtimeClass: 'pooled-worker',
      idempotencyKey,
    },
  });
  assert.equal(created.status, 201, `execution ${idempotencyKey}: ${JSON.stringify(created.body)}`);
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

/** Drives one execution through the lifecycle to the target state. */
async function driveExecution(
  executionId: string,
  token: string,
  path: readonly ('queued' | 'starting' | 'running' | 'pausing' | 'paused' | 'failed' | 'unknown')[],
): Promise<void> {
  let version = 1;
  for (const to of path) {
    const transition = await apiCall(port(), `/api/executions/${executionId}/transitions`, {
      token,
      body: {
        to,
        version,
        idempotencyKey: `ao-exec-${to}-${executionId}`,
        ...(to === 'failed' ? { retryClassification: 'safe' } : {}),
      },
    });
    assert.equal(transition.status, 200, `execution ${executionId} → ${to}: ${JSON.stringify(transition.body)}`);
    version = (transition.body['execution'] as Record<string, unknown>)['version'] as number;
  }
}

async function appendEvidence(
  clientId: string,
  token: string,
  ref: string,
  quality: string,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'observation',
      sourceSystem: 'meta-ads',
      sourceRef: ref,
      observedAt: '2026-09-15T10:30:00.000Z',
      content: { metric: 'revenue', value: 5000, unit: 'USD' },
      quality,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

async function declarePlatformPolicy(dimension: string): Promise<void> {
  const declared = await apiCall(port(), '/api/policies', {
    token: await adminToken(),
    body: {
      dimension,
      rules: [
        {
          effect: 'allow',
          operations: ['*'],
          reason: 'MKT-045 integration-test platform boundary: explicit allow',
        },
      ],
      description: `MKT-045 integration-test platform default (${dimension})`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

/** One UNDECIDED agency-scoped policy decision (no active policy). */
async function makeUndecidedDecision(agencyId: string, token: string, operation: string): Promise<string> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/policies/evaluate`, {
    token,
    body: { dimension: 'ai', operation },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body['outcome'], 'unknown');
  assert.equal(response.body['reasonCode'], 'no-active-policy');
  return response.body['decisionId'] as string;
}

async function makePlaybookWithPublishedVersion(
  clientId: string,
  token: string,
  goalId: string,
): Promise<{ playbookId: string; versionId: string }> {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'MKT-045 Delivery Playbook', description: 'The ai-operator fixture playbook.', goalId },
  });
  assert.equal(playbook.status, 201, JSON.stringify(playbook.body));
  const playbookId = playbook.body['playbookId'] as string;

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
  return { playbookId, versionId };
}

async function makeDeployment(
  workspaceId: string,
  token: string,
  playbookVersionId: string,
  definitionId: string,
): Promise<string> {
  const deployment = await apiCall(port(), `/api/workspaces/${workspaceId}/deployments`, {
    token,
    body: {
      selection: {
        playbookVersionId,
        workflowDefinitionIds: [definitionId],
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

async function driveDeployment(
  workspaceId: string,
  deploymentId: string,
  token: string,
  action: 'activate' | 'block',
): Promise<void> {
  // draft → validating → ready (one validate call).
  let version = 1;
  const validated = await apiCall(
    port(),
    `/api/workspaces/${workspaceId}/deployments/${deploymentId}/validate`,
    { token, method: 'POST', body: { idempotencyKey: `ao-validate-${deploymentId}`, expectedVersion: version } },
  );
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  version = (validated.body['deployment'] as Record<string, unknown>)['version'] as number;
  const transition = await apiCall(
    port(),
    `/api/workspaces/${workspaceId}/deployments/${deploymentId}/${action}`,
    {
      token,
      method: 'POST',
      body: {
        idempotencyKey: `ao-${action}-${deploymentId}`,
        expectedVersion: version,
        ...(action === 'block' ? { reason: 'MKT-045 fixture: the operator blocked this deployment.' } : {}),
      },
    },
  );
  assert.equal(transition.status, 200, `${action}: ${JSON.stringify(transition.body)}`);
}

async function makeExperiment(clientId: string, token: string, hypothesis: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: {
      hypothesis,
      decisionTarget: 'Whether to roll out the treatment.',
      populationUnit: 'account',
      treatment: 'personalized-subject',
      comparison: 'static-subject',
      assignmentMethod: 'random',
      designType: 'randomized',
      primaryMetric: { name: 'activation_rate', dimensions: {} },
      guardrails: [],
      analysisMethod: 'difference-in-means',
      analysisMethodVersion: 'v1',
      expectedDirection: 'increase',
      stopCriteria: 'At 400 accounts or 14 days.',
      minimumEvidenceRequirement: 'B — strong quasi-experimental at minimum',
      uncertaintyRepresentation: 'none',
    },
  });
  assert.equal(response.status, 201, `experiment: ${JSON.stringify(response.body)}`);
  return response.body['experimentId'] as string;
}

async function driveExperiment(
  experimentId: string,
  token: string,
  path: readonly ('mark_ready' | 'start' | 'begin_analysis' | 'conclude')[],
  conclusion?: Record<string, unknown>,
): Promise<void> {
  for (const transition of path) {
    const response = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token,
      body: { transition, ...(transition === 'conclude' && conclusion !== undefined ? { conclusion } : {}) },
    });
    assert.equal(response.status, 200, `experiment ${experimentId} ${transition}: ${JSON.stringify(response.body)}`);
  }
}

async function makeLearning(clientId: string, token: string, statement: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/learnings`, {
    token,
    body: {
      statement,
      applicability: { channel: 'email' },
      evidenceRefs: [],
      experimentRefs: [],
      confidence: 0.8,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['learningId'] as string;
}

async function makeProjectedJob(
  workflowId: string,
  instanceId: string,
  nodeId: string,
  token: string,
): Promise<string> {
  const projected = await apiCall(
    port(),
    `/api/workflows/${workflowId}/instances/${instanceId}/jobs`,
    {
      token,
      body: {
        nodeId,
        title: `Field visit — ${nodeId}`,
        description: 'Visit the venue and collect the signed form.',
        specialization: 'field_agent',
        requiredCapabilities: ['canvassing'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 600,
      },
    },
  );
  assert.equal(projected.status, 201, `job ${nodeId}: ${JSON.stringify(projected.body).slice(0, 400)}`);
  return projected.body['jobId'] as string;
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let ownerA: User = { userId: '', token: '' };
let memberA: User = { userId: '', token: '' };
let suspendedA: User = { userId: '', token: '' };
let ownerB: User = { userId: '', token: '' };
let humanAgentA: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceA2 = '';
let workspaceA3 = '';
let decisionA1Id = '';
let decisionA2Id = '';
let decisionA3Id = '';
let execDet1Id = '';
let execDet2Id = '';
let execDet3Id = '';
let execHum1Id = '';
let jobId = '';
let deployment2Id = '';
let blockedInstanceId = '';

before(async () => {
  stack = await bootStack('aioperator');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-043 precedent): the SAME
  // application composed IN-PROCESS against the SAME database the API
  // serves — the module-level 404 proofs use it.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  aiOperatorModule = core.modules.aiOperator;

  db = new PgDb(stack.env.databaseUrl, 2);

  // --- The tenants ---
  ownerA = await makeUser('owner-a@aioperator.test');
  memberA = await makeUser('member-a@aioperator.test');
  suspendedA = await makeUser('suspended-a@aioperator.test');
  ownerB = await makeUser('owner-b@aioperator.test');
  humanAgentA = await makeUser('human-a@aioperator.test');
  agencyA = await makeAgency('AI Operator Agency A', ownerA);
  agencyB = await makeAgency('AI Operator Agency B', ownerB);
  await addMembership(agencyA, memberA, 'client_collaborator');
  const suspendedMembershipId = await addMembership(agencyA, suspendedA, 'client_collaborator');
  // The agency's HUMAN AGENT pool member (the capacity + jobs window).
  await addMembership(agencyA, humanAgentA, 'human_agent');
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

  clientA = await makeClient(agencyA, 'AI Operator Client A');
  clientA2 = await makeClient(agencyA, 'AI Operator Client A2 (empty)');
  clientB = await makeClient(agencyB, 'AI Operator Client B (foreign)');
  workspaceA1 = await makeWorkspace(clientA, 'Workspace A1 (delivery)');
  workspaceA2 = await makeWorkspace(clientA, 'Workspace A2 (goal, never delivered)');
  workspaceA3 = await makeWorkspace(clientA, 'Workspace A3 (work without goal)');
  await makeWorkspace(clientB, 'Workspace B (foreign)');

  // --- The human-agent pool (120 declared weekly minutes) ---
  const profile = await apiCall(port(), '/api/field-agents', {
    token: humanAgentA.token,
    body: {
      specializations: ['field_agent'],
      capabilities: [{ skill: 'canvassing', level: 'advanced' }],
      availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 600 }],
      location: { kind: 'city', value: 'accra' },
      territories: [],
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'preferred',
        maxConcurrentClientRelationships: 4,
      },
    },
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const humanAgentProfileId = profile.body['agentId'] as string;

  // --- The covering goal (workspace A1) + the undelivered goal (A2) ---
  const goalA1Id = await makeGoal(clientA, ownerA.token, goalBody('Grow recurring revenue.', workspaceA1, [
    { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: 'MRR target' },
  ]));
  const goalA2Id = await makeGoal(clientA, ownerA.token, goalBody('Activate workspace A2.', workspaceA2, [
    { metric: 'activation_rate', comparator: '>=', targetValue: 0.4, unit: '%', description: 'Activation' },
  ]));
  for (const goalId of [goalA1Id, goalA2Id]) {
    const activated = await apiCall(port(), `/api/goals/${goalId}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: 1 },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
  }

  const playbookFixture = await makePlaybookWithPublishedVersion(clientA, ownerA.token, goalA1Id);
  const playbookV1 = playbookFixture.versionId;

  // --- Workspace A1: the delivery workflow (2 definitions, both pinned to
  // the published playbook version) + the capacity workflow (7 human_task
  // nodes — six OPEN jobs + one declined).
  const deliveryNodes = [functionNode('prep'), humanTaskNode('visit'), terminalNode('done')];
  const wf1 = await makeWorkflowWithDefinition(workspaceA1, ownerA.token, playbookV1, 'Delivery Workflow A1', deliveryNodes);
  const definition1Id = wf1.definitionId;
  // definition2: same content, second definition on the same workflow.
  const definition2 = await apiCall(port(), `/api/workflows/${wf1.workflowId}/definitions`, {
    token: ownerA.token,
    body: workflowContent(playbookV1, deliveryNodes),
  });
  assert.equal(definition2.status, 201, JSON.stringify(definition2.body));
  const definition2Id = definition2.body['workflowDefinitionId'] as string;
  {
    let version = definition2.body['version'] as number;
    for (const status of ['review', 'active'] as const) {
      const transition = await apiCall(
        port(),
        `/api/workflows/${wf1.workflowId}/definitions/${definition2Id}/status`,
        { token: ownerA.token, method: 'PATCH', body: { status, version } },
      );
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
      version = transition.body['version'] as number;
    }
  }

  const instance1 = await makeRunningInstance(wf1.workflowId, definition1Id, ownerA.token);
  const instance1Id = instance1.instanceId;
  const instance2 = await makeRunningInstance(wf1.workflowId, definition2Id, ownerA.token);
  const instance2Id = instance2.instanceId;
  blockedInstanceId = instance2Id;
  // instance2: running → BLOCKED (the blocked-work fixture).
  {
    const blocked = await apiCall(
      port(),
      `/api/workflows/${wf1.workflowId}/instances/${instance2Id}/transitions`,
      {
        token: ownerA.token,
        body: {
          to: 'blocked',
          version: instance2.version,
          idempotencyKey: `ao-setup-blocked-${instance2Id}`,
          reason: 'MKT-045 fixture: the instance is blocked.',
        },
      },
    );
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
  }

  // The capacity workflow (workspace A1, no playbook): 8 human_task nodes.
  const capacityNodes = [
    functionNode('prep'),
    ...Array.from({ length: 7 }, (_, index) => humanTaskNode(`visit${index + 1}`)),
    terminalNode('done'),
  ];
  const wfCap = await makeWorkflowWithDefinition(workspaceA1, ownerA.token, null, 'Capacity Workflow A1', capacityNodes);
  const instanceCap = await makeRunningInstance(wfCap.workflowId, wfCap.definitionId, ownerA.token);
  const instanceCapId = instanceCap.instanceId;

  // --- Workspace A3: its own workflow (no playbook) + one running
  // instance — delivered work pursuing no covering goal.
  const wf3 = await makeWorkflowWithDefinition(workspaceA3, ownerA.token, null, 'Orphan Workflow A3', [functionNode('prep'), terminalNode('done')]);
  const instance3 = await makeRunningInstance(wf3.workflowId, wf3.definitionId, ownerA.token);
  const instance3Id = instance3.instanceId;

  // --- Executions (the anomaly + blocked-work + leakage fixtures) ---
  execDet1Id = await makeExecution(workspaceA1, ownerA.token, instance1Id, 'prep', 'deterministic', 'ao-exec-det-1');
  await driveExecution(execDet1Id, ownerA.token, ['queued', 'starting', 'running', 'failed']); // anomaly (failed)
  execDet2Id = await makeExecution(workspaceA1, ownerA.token, instance2Id, 'prep', 'deterministic', 'ao-exec-det-2');
  await driveExecution(execDet2Id, ownerA.token, ['queued', 'starting', 'running', 'unknown']); // anomaly (UNKNOWN)
  execHum1Id = await makeExecution(workspaceA1, ownerA.token, instance1Id, 'visit', 'human', 'ao-exec-hum-1');
  await driveExecution(execHum1Id, ownerA.token, ['queued', 'starting', 'running', 'pausing', 'paused']); // blocked-work (paused)
  execDet3Id = await makeExecution(workspaceA3, ownerA.token, instance3Id, 'prep', 'deterministic', 'ao-exec-det-3');
  // (stays 'created' — the live-follow battery transitions it to failed)

  // --- Evidence (the client-risk fixture: a weak-grade record) ---
  await appendEvidence(clientA, ownerA.token, 'report/2026-09-strong', 'B');
  await appendEvidence(clientA, ownerA.token, 'report/2026-09-weak', 'D');

  // --- The declined job (blocked-work) + the six OPEN jobs (capacity) ---
  jobId = await makeProjectedJob(wf1.workflowId, instance1Id, 'visit', ownerA.token);
  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: ownerA.token,
    body: {
      candidateAgentId: humanAgentProfileId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  const offerId = offer.body['offerId'] as string;
  const declined = await apiCall(port(), `/api/jobs/${jobId}/offers/${offerId}/decline`, {
    token: humanAgentA.token,
    body: {},
  });
  assert.equal(declined.status, 200, JSON.stringify(declined.body));
  for (let index = 1; index <= 6; index += 1) {
    await makeProjectedJob(wfCap.workflowId, instanceCapId, `visit${index}`, ownerA.token);
  }

  // --- The deployments (one ACTIVE envelope + one BLOCKED) ---
  await declarePlatformPolicy('deployment');
  const deployment1Id = await makeDeployment(workspaceA1, ownerA.token, playbookV1, definition1Id);
  await driveDeployment(workspaceA1, deployment1Id, ownerA.token, 'activate');
  deployment2Id = await makeDeployment(workspaceA1, ownerA.token, playbookV1, definition1Id);
  await driveDeployment(workspaceA1, deployment2Id, ownerA.token, 'block');

  // --- The undecided policy decisions (two; the third arrives in the
  // live-follow battery) ---
  decisionA1Id = await makeUndecidedDecision(agencyA, ownerA.token, 'secret.read');
  decisionA2Id = await makeUndecidedDecision(agencyA, ownerA.token, 'secret.write');

  // --- The experiments (ready + concluded-with-causal-support) ---
  const experiment1Id = await makeExperiment(clientA, ownerA.token, 'Personalized subject lines lift activation (ready).');
  await driveExperiment(experiment1Id, ownerA.token, ['mark_ready']);
  const experiment2Id = await makeExperiment(clientA, ownerA.token, 'Personalized subject lines lift activation (concluded).');
  await driveExperiment(experiment2Id, ownerA.token, ['mark_ready', 'start', 'begin_analysis'], undefined);
  await driveExperiment(experiment2Id, ownerA.token, ['conclude'], {
    resultState: 'causal_supported',
    assumptions: [],
    evidenceRefs: [],
  });

  // --- The learnings (one contradicted by a later one) ---
  const learning1Id = await makeLearning(clientA, ownerA.token, 'Tuesday sends outperform Friday sends.');
  const learning2Id = await makeLearning(clientA, ownerA.token, 'Later data: send day has no durable effect.');
  const contradicted = await apiCall(port(), `/api/learnings/${learning1Id}/relationships`, {
    token: ownerA.token,
    body: { kind: 'contradicts', toLearningId: learning2Id },
  });
  assert.equal(contradicted.status, 201, JSON.stringify(contradicted.body));
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

async function agencyQueue(token: string, agencyId = agencyA): Promise<Record<string, unknown>> {
  const response = await apiCall(port(), `/api/ai-operator/${agencyId}/attention-queue`, { token });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  return response.body;
}

async function clientQueue(token: string): Promise<Record<string, unknown>> {
  const response = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${clientA}/attention-queue`,
    { token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  return response.body;
}

async function itemDetail(token: string, itemId: string, agencyId = agencyA): Promise<Record<string, unknown>> {
  const response = await apiCall(
    port(),
    `/api/ai-operator/${agencyId}/attention-queue/${encodeURIComponent(itemId)}`,
    { token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  return response.body;
}

interface QueueItem {
  readonly itemId: string;
  readonly category: string;
  readonly priorityScore: number;
  readonly rank: number;
  readonly scope: Record<string, unknown>;
  readonly rationale: { readonly headline: string; readonly factors: ReadonlyArray<{ readonly key: string; readonly value: string }> };
  readonly actionContract: Record<string, unknown>;
  readonly sourceRefs: ReadonlyArray<{ readonly kind: string; readonly id: string }>;
  readonly scoreAssumptionKeys: readonly string[];
}

function itemsOf(view: Record<string, unknown>): QueueItem[] {
  return view['items'] as QueueItem[];
}

function factorOf(item: QueueItem, key: string): string {
  const factor = item.rationale.factors.find((entry) => entry.key === key);
  assert.ok(factor !== undefined, `factor '${key}' must exist on ${item.itemId}`);
  return factor.value;
}

function stripGeneratedAt(body: Record<string, unknown>): string {
  const copy = { ...body } as Record<string, unknown>;
  delete copy['generatedAt'];
  return JSON.stringify(copy);
}

// ---------------------------------------------------------------------------
// 1. THE GOLDEN PATH — the agency queue over real authorities, with DIRECT
//    SQL ground truth (AC-5 + AC-6 + AC-7)
// ---------------------------------------------------------------------------

test('the agency queue derives every §7 category from real authorities — exact ranks, scores and order, cross-checked against DIRECT SQL ground truth', async () => {
  const view = await agencyQueue(ownerA.token);

  // Scope: the server-derived aggregation scope.
  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'agency-attention-queue');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientCount'], 2, 'the LIVE clients (A + A2)');
  assert.equal(scope['humanAgentCount'], 1);

  const items = itemsOf(view);
  assert.equal(items.length, 17, 'exactly the fixture items (nothing invented)');

  // The exact deterministic order (score DESC → category ASC → itemId
  // ASC). The queue: ranks 1–2 are the two approvals (score 101, the
  // tiebreak between their random decision ids — asserted as a SET
  // below), ranks 3–14 are the exact literal sequence, ranks 15–17 are
  // the opportunities (random experiment ids — asserted by category +
  // score below).
  assert.deepEqual(
    items.slice(2, 14).map((item) => [item.itemId, item.priorityScore] as const),
    [
      // anomaly: UNKNOWN 95, failed 91.
      [`ao:anomaly:execution:${execDet2Id}`, 95],
      [`ao:anomaly:execution:${execDet1Id}`, 91],
      // blocked-work: deployment blocked 90, instance blocked 88,
      // job declined 85, execution paused 84.
      [`ao:blocked-work:deployment:${deployment2Id}`, 90],
      [`ao:blocked-work:workflow-instance:${blockedInstanceId}`, 88],
      [`ao:blocked-work:job:${jobId}`, 85],
      [`ao:blocked-work:execution:${execHum1Id}`, 84],
      // margin-pressure 80 (negative realized margin, consumed from PI).
      [`ao:margin-pressure:client:${clientA}`, 80],
      // client-risk 76 (one weak evidence record).
      [`ao:client-risk:client:${clientA}`, 76],
      // capacity-constraint 70 (agency pool).
      [`ao:capacity-constraint:agency:${agencyA}`, 70],
      // scope-leakage 57 / 56 / 56 (consumed from PI).
      [`ao:scope-leakage:client:${clientA}:executions-outside-deployed-envelope`, 57],
      [`ao:scope-leakage:client:${clientA}:active-goals-without-delivery`, 56],
      [`ao:scope-leakage:client:${clientA}:work-without-active-goal`, 56],
    ],
  );

  // The two approvals (rank 1-2, score 101, itemId tiebreak between the
  // two random decision ids).
  const firstTwo = items.slice(0, 2);
  assert.deepEqual(
    new Set(firstTwo.map((item) => item.itemId)),
    new Set([`ao:approval:policy-decision:${decisionA1Id}`, `ao:approval:policy-decision:${decisionA2Id}`]),
  );
  for (const approval of firstTwo) {
    assert.equal(approval.category, 'approval');
    assert.equal(approval.priorityScore, 101, 'base 90 + severity 10 (no-active-policy) + recurrence 1 (same dimension)');
    assert.equal(factorOf(approval, 'same-dimension-undecided-count'), '2');
    assert.equal(factorOf(approval, 'policy-outcome'), 'unknown');
    assert.equal(factorOf(approval, 'policy-reason'), 'no-active-policy');
    assert.equal((approval.actionContract as Record<string, unknown>)['kind'], 'policy-evaluation');
    assert.equal((approval.actionContract as Record<string, unknown>)['policyDimension'], 'ai');
    assert.equal((approval.actionContract as Record<string, unknown>)['policyScopeKind'], 'agency');
    assert.equal(approval.scope['clientId'], null, 'the agency-scoped decisions carry no client scope');
    assert.deepEqual(
      approval.sourceRefs.map((ref) => ref.kind),
      ['policy-decision'],
    );
  }

  // The opportunities (promotable 48, contradicted learning 47, ready 44).
  const opportunities = items.filter((item) => item.category === 'opportunity');
  assert.deepEqual(
    opportunities
      .map((item) => [item.rationale.headline.split(' ')[0] as string, item.priorityScore] as const)
      .sort(([a, scoreA], [b, scoreB]) => a.localeCompare(b) || (scoreA as number) - (scoreB as number)),
    [
      ['experiment', 44],
      ['experiment', 48],
      ['learning', 47],
    ],
  );
  const promotable = opportunities.find((item) => item.priorityScore === 48)!;
  assert.equal(factorOf(promotable, 'opportunity-kind'), 'experiment-promotable');
  assert.equal((promotable.actionContract as Record<string, unknown>)['kind'], 'decision-recording');
  const contradictedLearning = opportunities.find((item) => item.priorityScore === 47)!;
  assert.equal(factorOf(contradictedLearning, 'opportunity-kind'), 'learning-contradicted');
  assert.equal((contradictedLearning.actionContract as Record<string, unknown>)['kind'], 'learning-revision');

  // Ranks are contiguous 1..17.
  assert.deepEqual(
    items.map((item) => item.rank),
    Array.from({ length: 17 }, (_, index) => index + 1),
  );

  // The per-category counts.
  const counts = view['counts'] as Record<string, number>;
  assert.deepEqual(counts, {
    'blocked-work': 4,
    approval: 2,
    'client-risk': 1,
    anomaly: 2,
    'scope-leakage': 3,
    'margin-pressure': 1,
    'capacity-constraint': 1,
    opportunity: 3,
  });

  // GROUND TRUTH (SQL): every count above.
  const decisions = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM policy_decisions
     WHERE agency_id = $1 AND outcome = 'unknown'`,
    [agencyA],
  );
  assert.equal(Number(decisions.rows[0]!.count), 2, 'the undecided policy decisions');

  const executionStatusRows = await db!.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM executions
     WHERE agency_id = $1 GROUP BY status ORDER BY status`,
    [agencyA],
  );
  const statusCounts = new Map(executionStatusRows.rows.map((row) => [row.status, Number(row.count)]));
  assert.equal(statusCounts.get('failed'), 1);
  assert.equal(statusCounts.get('unknown'), 1);
  assert.equal(statusCounts.get('paused'), 1);
  assert.equal(statusCounts.get('created'), 1);

  const instanceRows = await db!.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM workflow_instances
     WHERE agency_id = $1 GROUP BY status ORDER BY status`,
    [agencyA],
  );
  const instanceStatus = new Map(instanceRows.rows.map((row) => [row.status, Number(row.count)]));
  assert.equal(instanceStatus.get('blocked'), 1, 'the blocked instance');
  assert.equal(instanceStatus.get('running'), 3, 'instance1 + instance3 + instanceCap');
  assert.equal(instanceStatus.get('draft') ?? 0, 0);

  const deploymentRows = await db!.query<{ status: string; count: string }>(
    `SELECT status, count(*)::text AS count FROM deployments
     WHERE agency_id = $1 GROUP BY status ORDER BY status`,
    [agencyA],
  );
  const deploymentStatus = new Map(deploymentRows.rows.map((row) => [row.status, Number(row.count)]));
  assert.equal(deploymentStatus.get('active'), 1);
  assert.equal(deploymentStatus.get('blocked'), 1, 'the blocked deployment');

  const weakEvidence = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evidence v
     WHERE v.client_id = $1 AND v.quality IN ('D', 'E', 'F')
       AND NOT EXISTS (
         SELECT 1 FROM evidence newer WHERE newer.supersedes_evidence_id = v.evidence_id
       )`,
    [clientA],
  );
  assert.equal(Number(weakEvidence.rows[0]!.count), 1, 'the current weak-grade evidence records');

  const openJobs = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs
     WHERE agency_id = $1 AND status IN ('projected', 'offered')`,
    [agencyA],
  );
  assert.equal(Number(openJobs.rows[0]!.count), 6, 'the OPEN jobs (the capacity demand)');

  const declinedJobs = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs
     WHERE agency_id = $1 AND status = 'declined'`,
    [agencyA],
  );
  assert.equal(Number(declinedJobs.rows[0]!.count), 1, 'the declined job');

  const activeProfiles = await db!.query<{ minutes: string; profiles: string }>(
    `SELECT coalesce(sum((avail->>'endMinute')::int - (avail->>'startMinute')::int), 0)::text AS minutes,
            count(DISTINCT agent_id)::text AS profiles
     FROM human_agents, jsonb_array_elements(availability) AS avail
     WHERE authorization_state = 'active'`,
  );
  assert.equal(Number(activeProfiles.rows[0]!.minutes), 120, 'the declared weekly capacity minutes');
  assert.equal(Number(activeProfiles.rows[0]!.profiles), 1);

  const concludedExperiments = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM experiments
     WHERE client_id = $1 AND status = 'concluded' AND result_state = 'causal_supported'`,
    [clientA],
  );
  assert.equal(Number(concludedExperiments.rows[0]!.count), 1);

  const readyExperiments = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM experiments WHERE client_id = $1 AND status = 'ready'`,
    [clientA],
  );
  assert.equal(Number(readyExperiments.rows[0]!.count), 1);

  // Learnings: the status is DERIVED from the relationship history (a
  // 'contradicts' relationship from the target learning).
  const contradictedLearnings = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM learning_relationships rel
     JOIN learnings l ON l.learning_id = rel.from_learning_id
     WHERE l.client_id = $1 AND rel.kind = 'contradicts'`,
    [clientA],
  );
  assert.equal(Number(contradictedLearnings.rows[0]!.count), 1);

  // --- Per-item spot checks (the frozen score arithmetic + rationale) ---
  const anomalyUnknown = items.find((item) => item.itemId === `ao:anomaly:execution:${execDet2Id}`)!;
  assert.equal(anomalyUnknown.rank, 3);
  assert.equal(factorOf(anomalyUnknown, 'execution-status'), 'unknown');
  assert.equal(factorOf(anomalyUnknown, 'attempt-number'), '1');
  assert.equal((anomalyUnknown.actionContract as Record<string, unknown>)['kind'], 'execution-reconciliation');
  assert.equal(anomalyUnknown.scope['clientId'], clientA);

  const anomalyFailed = items.find((item) => item.itemId === `ao:anomaly:execution:${execDet1Id}`)!;
  assert.equal(factorOf(anomalyFailed, 'execution-status'), 'failed');
  assert.equal(factorOf(anomalyFailed, 'retry-classification'), 'safe');

  const blockedInstance = items.find((item) => item.category === 'blocked-work' && item.itemId.startsWith('ao:blocked-work:workflow-instance:'))!;
  assert.equal(factorOf(blockedInstance, 'instance-status'), 'blocked');
  assert.equal(factorOf(blockedInstance, 'linked-failed-executions'), '0');
  assert.equal((blockedInstance.actionContract as Record<string, unknown>)['kind'], 'workflow-instance-transition');
  assert.equal(blockedInstance.scope['workspaceId'], workspaceA1);

  const blockedDeployment = items.find((item) => item.itemId === `ao:blocked-work:deployment:${deployment2Id}`)!;
  assert.equal(factorOf(blockedDeployment, 'deployment-status'), 'blocked');
  assert.equal((blockedDeployment.actionContract as Record<string, unknown>)['kind'], 'deployment-lifecycle');

  const declinedJob = items.find((item) => item.itemId === `ao:blocked-work:job:${jobId}`)!;
  assert.equal(factorOf(declinedJob, 'job-status'), 'declined');
  assert.equal((declinedJob.actionContract as Record<string, unknown>)['kind'], 'job-outcome-submission');

  const pausedExecution = items.find((item) => item.itemId === `ao:blocked-work:execution:${execHum1Id}`)!;
  assert.equal(factorOf(pausedExecution, 'execution-status'), 'paused');

  const clientRisk = items.find((item) => item.itemId === `ao:client-risk:client:${clientA}`)!;
  assert.equal(factorOf(clientRisk, 'weak-evidence-count'), '1');
  assert.equal(factorOf(clientRisk, 'weak-evidence-grades'), 'D/E/F');
  assert.equal((clientRisk.actionContract as Record<string, unknown>)['kind'], 'evidence-append');

  // The margin-pressure item CONSUMES the PI figures (never recomputed).
  const margin = items.find((item) => item.itemId === `ao:margin-pressure:client:${clientA}`)!;
  assert.equal(factorOf(margin, 'realized-margin'), '-0.15', 'realized 0 revenue − 0.15 observed delivery cost');
  assert.equal(factorOf(margin, 'realized-revenue'), '0');
  assert.equal(factorOf(margin, 'margin-ratio'), 'not-derivable-zero-revenue');
  assert.equal(factorOf(margin, 'pressure-threshold-ratio'), '0.15');
  assert.equal(
    factorOf(margin, 'source-calculation-version'),
    PROFIT_INTELLIGENCE_CALCULATION_VERSION,
    'the CONSUMED /profit-intelligence calculation version ships in the rationale',
  );
  assert.equal((margin.actionContract as Record<string, unknown>)['kind'], 'decision-recording');

  // The scope-leakage items CONSUME the PI indicators verbatim.
  const envelope = items.find(
    (item) => item.itemId === `ao:scope-leakage:client:${clientA}:executions-outside-deployed-envelope`,
  )!;
  assert.equal(factorOf(envelope, 'leaked-count'), '2', 'exec-det-2 (definition not deployed) + exec-det-3 (no deployment)');
  assert.equal(factorOf(envelope, 'source-calculation-version'), PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  const withoutGoal = items.find(
    (item) => item.itemId === `ao:scope-leakage:client:${clientA}:work-without-active-goal`,
  )!;
  assert.equal(factorOf(withoutGoal, 'leaked-count'), '1', 'workspace A3\'s uncovered running instance');
  const goalsWithoutDelivery = items.find(
    (item) => item.itemId === `ao:scope-leakage:client:${clientA}:active-goals-without-delivery`,
  )!;
  assert.equal(factorOf(goalsWithoutDelivery, 'leaked-count'), '1', 'workspace A2\'s undelivered goal');

  // The capacity-constraint item (the agency pool).
  const capacity = items.find((item) => item.itemId === `ao:capacity-constraint:agency:${agencyA}`)!;
  assert.equal(factorOf(capacity, 'declared-capacity-minutes'), '120');
  assert.equal(factorOf(capacity, 'projected-demand-minutes'), '720', '6 open jobs × 120 demand minutes');
  assert.equal(factorOf(capacity, 'open-job-count'), '6');
  assert.equal(factorOf(capacity, 'in-flight-job-count'), '0');
  assert.equal(factorOf(capacity, 'active-profile-count'), '1');
  assert.equal(capacity.scope['clientId'], null, 'the capacity item is agency-pool-scoped');
  assert.equal((capacity.actionContract as Record<string, unknown>)['kind'], 'field-agent-availability');
  assert.equal((capacity.actionContract as Record<string, unknown>)['policyDimension'], 'field');
  assert.equal(capacity.sourceRefs.length, 7, 'the active profile ref + the 6 open job refs');

  // --- THE RANKING DISCLOSURE (AC-3/AC-6) ---
  const ranking = view['ranking'] as Record<string, unknown>;
  assert.equal(ranking['rankVersion'], AI_OPERATOR_RANK_VERSION);
  assert.equal(ranking['categoryVocabularyVersion'], ATTENTION_CATEGORY_VOCABULARY_VERSION);
  assert.deepEqual(ranking['assumptions'], AI_OPERATOR_ASSUMPTIONS);
  assert.equal(ranking['basis'], 'live-derivation-over-canonical-authorities');
  assert.equal(ranking['persistence'], 'none-derived-read-model');
  assert.equal(ranking['consumedProfitIntelligenceVersion'], PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  assert.ok(typeof view['generatedAt'] === 'string');
  for (const item of items) {
    assert.ok(item.scoreAssumptionKeys.includes('categoryBaseWeights'), `${item.itemId} discloses the base-weight assumption`);
    assert.ok(item.rationale.headline.length > 0);
  }

  // Any ACTIVE member of the owning agency may read (the read posture).
  const memberView = await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, {
    token: memberA.token,
  });
  assert.equal(memberView.status, 200);
});

// ---------------------------------------------------------------------------
// 2. THE CLIENT SLICE (AC-5 — client-scoped surface)
// ---------------------------------------------------------------------------

test('the client queue narrows to the client slice; the agency-scoped approvals and the capacity item are excluded (disclosed)', async () => {
  const view = await clientQueue(ownerA.token);

  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'client-attention-queue');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientId'], clientA);
  assert.equal(scope['workspaceCount'], 3);

  const items = itemsOf(view);
  // 17 − 2 agency-scoped approvals − 1 agency-pool capacity item = 14.
  assert.equal(items.length, 14);
  assert.ok(items.every((item) => item.scope['clientId'] === clientA), 'every item is client-scoped');
  assert.equal(items.filter((item) => item.category === 'approval').length, 0);
  assert.equal(items.filter((item) => item.category === 'capacity-constraint').length, 0);
  // The same deterministic order: the top item is the unknown anomaly (95).
  assert.equal(items[0]!.itemId, `ao:anomaly:execution:${execDet2Id}`);
  assert.equal(items[0]!.priorityScore, 95);
  assert.deepEqual(
    items.map((item) => item.rank),
    Array.from({ length: 14 }, (_, index) => index + 1),
  );

  const counts = view['counts'] as Record<string, number>;
  assert.deepEqual(counts, {
    'blocked-work': 4,
    approval: 0,
    'client-risk': 1,
    anomaly: 2,
    'scope-leakage': 3,
    'margin-pressure': 1,
    'capacity-constraint': 0,
    opportunity: 3,
  });

  // The capacity exclusion is DISCLOSED with the honest reason.
  const exclusions = view['scopeExclusions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0]!['category'], 'capacity-constraint');
  assert.ok(String(exclusions[0]!['reason']).includes('agency-pool-scoped'));

  // The EMPTY client's slice is empty with honest zero counts (nothing
  // fabricated — the empty-tally posture).
  const emptyClientView = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${clientA2}/attention-queue`,
    { token: ownerA.token },
  );
  assert.equal(emptyClientView.status, 200);
  assert.equal((emptyClientView.body['items'] as unknown[]).length, 0);
  for (const value of Object.values(emptyClientView.body['counts'] as Record<string, number>)) {
    assert.equal(value, 0);
  }
  assert.equal((emptyClientView.body['scope'] as Record<string, unknown>)['workspaceCount'], 0);

  // The same ranking disclosure ships.
  const ranking = view['ranking'] as Record<string, unknown>;
  assert.equal(ranking['rankVersion'], AI_OPERATOR_RANK_VERSION);
});

// ---------------------------------------------------------------------------
// 3. THE ITEM DETAIL (AC-5 — the deterministic item id)
// ---------------------------------------------------------------------------

test('the item detail re-derives the queue and locates the item in context', async () => {
  const capacityItemId = `ao:capacity-constraint:agency:${agencyA}`;
  const view = await itemDetail(ownerA.token, capacityItemId);

  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'agency-attention-item');
  assert.equal(scope['agencyId'], agencyA);

  const item = view['item'] as QueueItem;
  assert.equal(item.itemId, capacityItemId);
  assert.equal(item.priorityScore, 70);
  assert.equal(factorOf(item, 'projected-demand-minutes'), '720');

  assert.equal(view['totalItemCount'], 17);
  const categoryCounts = view['categoryCounts'] as Record<string, number>;
  assert.equal(categoryCounts['capacity-constraint'], 1);
  assert.equal(categoryCounts['approval'], 2);
  const ranking = view['ranking'] as Record<string, unknown>;
  assert.equal(ranking['rankVersion'], AI_OPERATOR_RANK_VERSION);
});

// ---------------------------------------------------------------------------
// 4. LIVE-FOLLOW — authority changes flow into the queue on the NEXT read
// ---------------------------------------------------------------------------

test('live-follow: new weak evidence, a failed execution and a third undecided decision move the queue on the very next read', async () => {
  const before = await agencyQueue(ownerA.token);
  const beforeRisk = itemsOf(before).find((item) => item.itemId === `ao:client-risk:client:${clientA}`)!;
  assert.equal(beforeRisk.priorityScore, 76, '75 base + 1 weak evidence record');
  assert.equal((before['counts'] as Record<string, number>)['approval'], 2);
  assert.equal((before['counts'] as Record<string, number>)['anomaly'], 2);

  // --- A NEW weak-grade evidence record (the severity rises 1 → 2). ---
  await appendEvidence(clientA, ownerA.token, 'report/2026-09-weak-2', 'E');
  // --- execDet3 (created) transitions to FAILED (a NEW anomaly item). ---
  await driveExecution(execDet3Id, ownerA.token, ['queued', 'starting', 'running', 'failed']);
  // --- A THIRD undecided policy decision (the recurrence rises 1 → 2). ---
  decisionA3Id = await makeUndecidedDecision(agencyA, ownerA.token, 'secret.rotate');

  const after = await agencyQueue(ownerA.token);
  const afterItems = itemsOf(after);
  assert.equal(afterItems.length, 19, '17 + the new anomaly + the new approval');

  const afterRisk = afterItems.find((item) => item.itemId === `ao:client-risk:client:${clientA}`)!;
  assert.equal(afterRisk.priorityScore, 77, 'the weak-evidence severity follows the new record immediately');
  assert.equal(factorOf(afterRisk, 'weak-evidence-count'), '2');
  assert.equal(factorOf(afterRisk, 'weak-evidence-grades'), 'D/E/F');

  const newAnomaly = afterItems.find((item) => item.itemId === `ao:anomaly:execution:${execDet3Id}`);
  assert.ok(newAnomaly !== undefined, 'the newly failed execution appears immediately');
  assert.equal(newAnomaly.priorityScore, 91);
  assert.equal(factorOf(newAnomaly, 'execution-status'), 'failed');

  const approvals = afterItems.filter((item) => item.category === 'approval');
  assert.equal(approvals.length, 3);
  for (const approval of approvals) {
    assert.equal(approval.priorityScore, 102, 'base 90 + severity 10 + recurrence 2');
    assert.equal(factorOf(approval, 'same-dimension-undecided-count'), '3');
  }
  assert.ok(
    approvals.some((item) => item.itemId === `ao:approval:policy-decision:${decisionA3Id}`),
    'the third decision (the live-follow one) is in the queue',
  );

  const afterCounts = after['counts'] as Record<string, number>;
  assert.deepEqual(afterCounts, {
    'blocked-work': 4,
    approval: 3,
    'client-risk': 1,
    anomaly: 3,
    'scope-leakage': 3,
    'margin-pressure': 1,
    'capacity-constraint': 1,
    opportunity: 3,
  });

  // SQL ground truth for the live-follow state.
  const weakEvidence = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM evidence v
     WHERE v.client_id = $1 AND v.quality IN ('D', 'E', 'F')
       AND NOT EXISTS (
         SELECT 1 FROM evidence newer WHERE newer.supersedes_evidence_id = v.evidence_id
       )`,
    [clientA],
  );
  assert.equal(Number(weakEvidence.rows[0]!.count), 2);
  const undecided = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM policy_decisions
     WHERE agency_id = $1 AND outcome = 'unknown'`,
    [agencyA],
  );
  assert.equal(Number(undecided.rows[0]!.count), 3);
  const failedExecutions = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM executions
     WHERE agency_id = $1 AND status = 'failed'`,
    [agencyA],
  );
  assert.equal(Number(failedExecutions.rows[0]!.count), 2);
});

// ---------------------------------------------------------------------------
// 5. RANK-VERSION PINNING (AC-6) — same state ⇒ byte-identical body
// ---------------------------------------------------------------------------

test('rank-version pinning: two consecutive reads of unchanged authorities are byte-identical (generatedAt excluded)', async () => {
  const first = await agencyQueue(ownerA.token);
  const second = await agencyQueue(ownerA.token);
  assert.equal(
    stripGeneratedAt(second),
    stripGeneratedAt(first),
    'same authority state + same rank version ⇒ byte-identical queue',
  );

  const clientFirst = await clientQueue(ownerA.token);
  const clientSecond = await clientQueue(ownerA.token);
  assert.equal(stripGeneratedAt(clientSecond), stripGeneratedAt(clientFirst));

  const detailFirst = await itemDetail(ownerA.token, `ao:capacity-constraint:agency:${agencyA}`);
  const detailSecond = await itemDetail(ownerA.token, `ao:capacity-constraint:agency:${agencyA}`);
  assert.equal(stripGeneratedAt(detailSecond), stripGeneratedAt(detailFirst));
});

// ---------------------------------------------------------------------------
// 6. THE ISOLATION BATTERY (fail-closed)
// ---------------------------------------------------------------------------

test('anonymous calls are 401; foreign/malformed/unknown agencies, clients and items are the uniform 404; suspended is 403', async () => {
  // Anonymous (fail closed at the authenticator).
  for (const path of [
    `/api/ai-operator/${agencyA}/attention-queue`,
    `/api/ai-operator/${agencyA}/attention-queue/ao:capacity-constraint:agency:${agencyA}`,
    `/api/ai-operator/${agencyA}/clients/${clientA}/attention-queue`,
  ]) {
    const anonymous = await apiCall(port(), path);
    assert.equal(anonymous.status, 401, `anonymous ${path}`);
  }

  // A FOREIGN agency's owner probing agency A: the uniform 404 (never a
  // 403 that leaks the agency's existence).
  const foreignQueue = await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, {
    token: ownerB.token,
  });
  assert.equal(foreignQueue.status, 404);
  const foreignDetail = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/attention-queue/${encodeURIComponent(`ao:capacity-constraint:agency:${agencyA}`)}`,
    { token: ownerB.token },
  );
  assert.equal(foreignDetail.status, 404);
  const foreignClient = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${clientA}/attention-queue`,
    { token: ownerB.token },
  );
  assert.equal(foreignClient.status, 404);

  // Malformed and unknown agency identifiers: the SAME 404.
  const malformed = await apiCall(port(), '/api/ai-operator/not-a-uuid/attention-queue', {
    token: ownerA.token,
  });
  assert.equal(malformed.status, 404);
  const unknown = await apiCall(port(), `/api/ai-operator/${randomUUID()}/attention-queue`, {
    token: ownerA.token,
  });
  assert.equal(unknown.status, 404);

  // The client slice of ANOTHER agency's client: the uniform 404.
  const foreignAgencyClient = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${clientB}/attention-queue`,
    { token: ownerA.token },
  );
  assert.equal(foreignAgencyClient.status, 404);
  const malformedClient = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/not-a-uuid/attention-queue`,
    { token: ownerA.token },
  );
  assert.equal(malformedClient.status, 404);
  const unknownClient = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${randomUUID()}/attention-queue`,
    { token: ownerA.token },
  );
  assert.equal(unknownClient.status, 404);

  // Foreign ≡ unknown ≡ malformed ITEM ids: a REAL item id of agency A's
  // queue read under agency B (ownerB IS a legitimate member of B) is
  // simply absent from B's queue → the same uniform 404; a malformed and
  // an unknown item id under agency A are the same 404.
  const foreignItemUnderB = await apiCall(
    port(),
    `/api/ai-operator/${agencyB}/attention-queue/${encodeURIComponent(`ao:capacity-constraint:agency:${agencyA}`)}`,
    { token: ownerB.token },
  );
  assert.equal(foreignItemUnderB.status, 404, 'foreign ≡ unknown — the queue re-derives, nothing is stored');
  const malformedItem = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/attention-queue/not-an-item-id`,
    { token: ownerA.token },
  );
  assert.equal(malformedItem.status, 404);
  const unknownItem = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/attention-queue/${encodeURIComponent(`ao:anomaly:execution:${randomUUID()}`)}`,
    { token: ownerA.token },
  );
  assert.equal(unknownItem.status, 404);

  // A SUSPENDED membership is the 403 (intra-tenant, post-existence).
  const suspended = await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, {
    token: suspendedA.token,
  });
  assert.equal(suspended.status, 403);
  const suspendedClient = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/clients/${clientA}/attention-queue`,
    { token: suspendedA.token },
  );
  assert.equal(suspendedClient.status, 403);

  // The empty agency B: ownerB reads OWN queue → 200 with honest zeros.
  const ownQueue = await apiCall(port(), `/api/ai-operator/${agencyB}/attention-queue`, {
    token: ownerB.token,
  });
  assert.equal(ownQueue.status, 200);
  assert.equal((ownQueue.body['items'] as unknown[]).length, 0);
  const emptyCounts = ownQueue.body['counts'] as Record<string, number>;
  for (const value of Object.values(emptyCounts)) {
    assert.equal(value, 0, 'the empty agency tallies zero honestly');
  }
});

test('READ-ONLY BY CONSTRUCTION: every mutating verb is 405 at the router; authority-shaped query parameters change nothing', async () => {
  const capacityItemId = `ao:capacity-constraint:agency:${agencyA}`;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const path of [
      `/api/ai-operator/${agencyA}/attention-queue`,
      `/api/ai-operator/${agencyA}/attention-queue/${encodeURIComponent(capacityItemId)}`,
      `/api/ai-operator/${agencyA}/clients/${clientA}/attention-queue`,
    ]) {
      const response = await apiCall(port(), path, {
        token: ownerA.token,
        method,
        body: { priorityScore: 999, category: 'approval', rankVersion: 'forged' },
      });
      assert.equal(response.status, 405, `${method} ${path} must be 405`);
    }
  }

  // Authority-shaped query parameters change nothing (the surface reads
  // none of them; bodies on GETs are ignored entirely).
  const plain = await agencyQueue(ownerA.token);
  const polluted = await apiCall(
    port(),
    `/api/ai-operator/${agencyA}/attention-queue?agencyId=${agencyB}&clientId=${clientB}&itemId=ao:approval:policy-decision:${decisionA1Id}&priorityScore=999&rankVersion=forged`,
    { token: ownerA.token },
  );
  assert.equal(polluted.status, 200);
  assert.equal(stripGeneratedAt(polluted.body), stripGeneratedAt(plain), 'query parameters are never read');
});

test('after every read/probe the authoritative rows are BYTE-IDENTICAL (the surface has no write path)', async () => {
  const digestQuery = `SELECT 'policy_decisions' AS rel, md5(string_agg(d.decision_id::text, ',' ORDER BY d.decision_id)) AS digest
       FROM policy_decisions d WHERE d.agency_id = $1
     UNION ALL
     SELECT 'executions', md5(string_agg(e.execution_id::text || ':' || e.status, ',' ORDER BY e.execution_id))
       FROM executions e WHERE e.agency_id = $1
     UNION ALL
     SELECT 'jobs', md5(string_agg(j.job_id::text || ':' || j.status, ',' ORDER BY j.job_id))
       FROM jobs j WHERE j.agency_id = $1
     UNION ALL
     SELECT 'evidence', md5(string_agg(v.evidence_id::text, ',' ORDER BY v.evidence_id))
       FROM evidence v WHERE v.client_id = $2
     UNION ALL
     SELECT 'experiments', md5(string_agg(x.experiment_id::text || ':' || x.status, ',' ORDER BY x.experiment_id))
       FROM experiments x WHERE x.client_id = $2
     UNION ALL
     SELECT 'learnings', md5(string_agg(l.learning_id::text, ',' ORDER BY l.learning_id))
       FROM learnings l WHERE l.client_id = $2
     UNION ALL
     SELECT 'workflow_instances', md5(string_agg(i.workflow_instance_id::text || ':' || i.status, ',' ORDER BY i.workflow_instance_id))
       FROM workflow_instances i WHERE i.agency_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(dp.deployment_id::text || ':' || dp.status, ',' ORDER BY dp.deployment_id))
       FROM deployments dp WHERE dp.agency_id = $1
     UNION ALL
     SELECT 'human_agents', md5(string_agg(h.agent_id::text, ',' ORDER BY h.agent_id))
       FROM human_agents h`;
  const before = await db!.query<{ rel: string; digest: string }>(digestQuery, [agencyA, clientA]);
  const beforeDigests = new Map(before.rows.map((row) => [row.rel, row.digest] as const));

  // A battery of reads and probes.
  await agencyQueue(ownerA.token);
  await agencyQueue(memberA.token);
  await clientQueue(ownerA.token);
  await itemDetail(ownerA.token, `ao:capacity-constraint:agency:${agencyA}`);
  await itemDetail(ownerA.token, `ao:margin-pressure:client:${clientA}`);
  await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, { token: ownerB.token });
  await apiCall(port(), `/api/ai-operator/not-a-uuid/attention-queue`, { token: ownerA.token });
  await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, {
    token: ownerA.token,
    method: 'POST',
    body: { priorityScore: 999, category: 'approval', rankVersion: 'forged' },
  });
  await apiCall(port(), `/api/ai-operator/${agencyA}/attention-queue`, { token: suspendedA.token });

  const after = await db!.query<{ rel: string; digest: string }>(digestQuery, [agencyA, clientA]);
  for (const row of after.rows) {
    assert.equal(
      row.digest,
      beforeDigests.get(row.rel),
      `the ${row.rel} authority rows are byte-identical after every read/probe`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. MODULE-LEVEL FAIL-CLOSED (the contract's own 404s)
// ---------------------------------------------------------------------------

test('the module-level reads of unknown identifiers are the uniform 404', async () => {
  await assert.rejects(
    () =>
      theModule().getAttentionItem({
        agencyId: agencyA,
        itemId: `ao:anomaly:execution:${randomUUID()}`,
        clients: [{ clientId: clientA }],
        humanAgentUserIds: [],
      }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown attention item id is the uniform 404 (module level)',
  );
  await assert.rejects(
    () => theModule().getClientAttentionQueue({ clientId: randomUUID(), humanAgentUserIds: [] }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 (module level)',
  );
});
