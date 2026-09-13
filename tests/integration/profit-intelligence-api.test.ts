/**
 * MKT-043 integration test — Profit Intelligence (the DERIVED
 * revenue/cost/capacity/utilization/scope-leakage/margin analytics read
 * model) against real PostgreSQL + a real API subprocess + the module
 * composed IN-PROCESS through bootstrapApplication() against the SAME
 * database (the MKT-041 operating-graph harness precedent).
 *
 * Proofs (spec/architecture-v1.5.md §5; spec/operating-graph-v1.5.md
 * "Profit Intelligence"; architecture-lock-v1.5 #6):
 *
 *   - THE FULL GOLDEN PATH OVER REAL AUTHORITIES: after the authority
 *     surfaces create the full chain (Goal → Playbook Version →
 *     Deployment → Workflow/Definition/Instance → Executions → Job →
 *     Offer → Outcome → Evidence → Metric observations (with a
 *     restatement supersession + a foreign-currency row + a
 *     workspace-tagged row) → AI usage telemetry → an integration
 *     connection), the CLIENT view derives the exact figures —
 *     cross-checked against DIRECT SQL ground truth over the authority
 *     tables (every count and sum);
 *   - THE WORKSPACE SLICE: the workspace view narrows to the workspace's
 *     own observations/executions/telemetry (workspace-tagged revenue
 *     only) with the same disclosure discipline;
 *   - THE AGENCY PORTFOLIO: the rollup merges the per-client derivations
 *     (per-client contribution rows, portfolio revenue/costs, capacity,
 *     utilization, leakage and margin totals, the empty client tallies
 *     zero honestly);
 *   - LIVE-FOLLOW: authority changes through the REAL authority APIs
 *     (a new revenue observation, a new execution, a new telemetry row)
 *     flow into the figures on the very NEXT read — nothing is cached
 *     anywhere (the no-persistence proof);
 *   - CALCULATION-VERSION PINNING: two consecutive reads of unchanged
 *     authorities derive BYTE-IDENTICAL bodies (generatedAt excluded);
 *     every material figure carries calculationVersion + assumptionKeys
 *     + sourceRefs; the full assumption record ships in every response;
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
import fs from 'node:fs';
import path from 'node:path';
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
import type { ProfitIntelligenceModuleApi } from '../../src/modules/profit-intelligence/public.ts';
import {
  PROFIT_INTELLIGENCE_ASSUMPTIONS,
  PROFIT_INTELLIGENCE_CALCULATION_VERSION,
} from '../../src/modules/profit-intelligence/public.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;
let profitModule: ProfitIntelligenceModuleApi | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function theModule(): ProfitIntelligenceModuleApi {
  if (profitModule === null) throw new Error('application not bootstrapped');
  return profitModule;
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

function workflowContent(playbookVersionId: string | null): Record<string, unknown> {
  return {
    graph: {
      nodes: [functionNode('prep'), humanTaskNode('visit'), terminalNode('done')],
      edges: [
        { fromNode: 'prep', toNode: 'visit', edgeType: 'success', predicateRef: null, joinSemantics: null },
        { fromNode: 'visit', toNode: 'done', edgeType: 'success', predicateRef: null, joinSemantics: null },
      ],
    },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    ...(playbookVersionId === null ? {} : { playbookVersionId }),
  };
}

async function makePlaybookWithPublishedVersion(
  clientId: string,
  token: string,
  goalId: string,
): Promise<{ playbookId: string; versionId: string }> {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'MKT-043 Delivery Playbook', description: 'The profit-intelligence fixture playbook.', goalId },
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

async function makeWorkflowWithDefinition(
  workspaceId: string,
  token: string,
  playbookVersionId: string | null,
  name: string,
): Promise<{ workflowId: string; definitionId: string }> {
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name, description: 'The profit-intelligence fixture workflow.' },
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
  return { workflowId, definitionId };
}

async function makeRunningInstance(
  workflowId: string,
  definitionId: string,
  token: string,
): Promise<string> {
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
        body: { to, version: instanceVersion, idempotencyKey: `pi-setup-${to}-${instanceId}` },
      },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
    instanceVersion = (transition.body['instance'] as Record<string, unknown>)['version'] as number;
  }
  return instanceId;
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

async function appendEvidence(clientId: string, token: string, ref: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    body: {
      class: 'observation',
      sourceSystem: 'meta-ads',
      sourceRef: ref,
      observedAt: '2026-09-15T10:30:00.000Z',
      content: { metric: 'revenue', value: 5000, unit: 'USD' },
      quality: 'B',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

async function appendObservation(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/metrics`, { token, body });
  assert.equal(response.status, 201, `observation: ${JSON.stringify(response.body)}`);
  return response.body['observationId'] as string;
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
          reason: 'MKT-043 integration-test platform boundary: explicit allow',
        },
      ],
      description: `MKT-043 integration-test platform default (${dimension})`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

/** The human-agent profile declaration matching the projected job spec. */
const matchingFieldAgentProfile: Record<string, unknown> = {
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
let workspaceB = '';
let goalAId = '';
let playbookId = '';
let playbookV1 = '';
let workflowA1Id = '';
let definition1Id = '';
let definition2Id = '';
let workflowA3Id = '';
let definition3Id = '';
let instance1Id = '';
let instance2Id = '';
let instance3Id = '';
let execDet1Id = '';
let evidence1Id = '';
let evidence2Id = '';
let jobId = '';
let jobOfferId = '';
let taskProfileId = '';
let modelRegistryId = '';
let connectionId = '';

before(async () => {
  stack = await bootStack('profitintel');

  // Provision the integration credential material out-of-band
  // (deployment-style — the MKT-023 integrations-test precedent: the
  // secret never transits an API).
  fs.writeFileSync(
    path.join(stack.env.secretsDir, 'pi-meta-api-key.secret'),
    'MATERIAL-pi-meta-do-not-leak-13579',
    { mode: 0o600 },
  );

  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/MKT-041 precedent):
  // the SAME application composed IN-PROCESS against the SAME database
  // the API serves — the module-level 404 proofs use it.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  profitModule = core.modules.profitIntelligence;

  db = new PgDb(stack.env.databaseUrl, 2);

  // --- The tenants ---
  ownerA = await makeUser('owner-a@profitintel.test');
  memberA = await makeUser('member-a@profitintel.test');
  suspendedA = await makeUser('suspended-a@profitintel.test');
  ownerB = await makeUser('owner-b@profitintel.test');
  humanAgentA = await makeUser('human-a@profitintel.test');
  agencyA = await makeAgency('Profit Intelligence Agency A', ownerA);
  agencyB = await makeAgency('Profit Intelligence Agency B', ownerB);
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

  clientA = await makeClient(agencyA, 'Profit Client A');
  clientA2 = await makeClient(agencyA, 'Profit Client A2 (empty)');
  clientB = await makeClient(agencyB, 'Profit Client B');
  workspaceA1 = await makeWorkspace(clientA, 'Workspace A1 (delivery)');
  workspaceA2 = await makeWorkspace(clientA, 'Workspace A2 (declared, never delivered)');
  workspaceA3 = await makeWorkspace(clientA, 'Workspace A3 (work without goal)');
  workspaceB = await makeWorkspace(clientB, 'Workspace B (foreign)');

  // --- The full v1.5 chain over today's authorities (client A) ---
  // The workspace-A1-scoped ACTIVE goal with the revenue criteria (USD +
  // EUR): workspace-scoped so the leakage fixture keeps workspace A3's
  // delivered work UNCOVERED by any ACTIVE goal (the client-wide covering
  // rule is proven in the unit battery instead).
  goalAId = await makeGoal(clientA, ownerA.token, goalBody('Grow recurring revenue.', workspaceA1, [
    { metric: 'revenue', comparator: '>=', targetValue: 5000, unit: 'USD', description: 'MRR target' },
    { metric: 'revenue', comparator: '>=', targetValue: 777, unit: 'EUR', description: 'EUR target (never converted)' },
  ]));
  // The workspace-scoped ACTIVE goal whose workspace has ZERO instances.
  const goalA2Id = await makeGoal(clientA, ownerA.token, goalBody('Activate workspace A2.', workspaceA2, [
    { metric: 'activation_rate', comparator: '>=', targetValue: 0.4, unit: '%', description: 'Activation' },
  ]));
  // Both goals ACTIVATE (draft → active through the authority's own
  // lifecycle surface — estimated figures and leakage indicators read
  // ACTIVE goals only).
  for (const goalId of [goalAId, goalA2Id]) {
    const activated = await apiCall(port(), `/api/goals/${goalId}/status`, {
      token: ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: 1 },
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.body));
  }

  const playbookFixture = await makePlaybookWithPublishedVersion(clientA, ownerA.token, goalAId);
  playbookId = playbookFixture.playbookId;
  playbookV1 = playbookFixture.versionId;

  // Workspace A1: TWO definitions on ONE workflow — both pinned to the
  // published playbook version (the service attribution chain).
  const wf1 = await makeWorkflowWithDefinition(workspaceA1, ownerA.token, playbookV1, 'Delivery Workflow A1');
  workflowA1Id = wf1.workflowId;
  definition1Id = wf1.definitionId;
  definition2Id = await (async () => {
    const definition = await apiCall(port(), `/api/workflows/${workflowA1Id}/definitions`, {
      token: ownerA.token,
      body: workflowContent(playbookV1),
    });
    assert.equal(definition.status, 201, JSON.stringify(definition.body));
    const definitionId = definition.body['workflowDefinitionId'] as string;
    let version = definition.body['version'] as number;
    for (const status of ['review', 'active'] as const) {
      const transition = await apiCall(
        port(),
        `/api/workflows/${workflowA1Id}/definitions/${definitionId}/status`,
        { token: ownerA.token, method: 'PATCH', body: { status, version } },
      );
      assert.equal(transition.status, 200, JSON.stringify(transition.body));
      version = transition.body['version'] as number;
    }
    return definitionId;
  })();

  instance1Id = await makeRunningInstance(workflowA1Id, definition1Id, ownerA.token);
  instance2Id = await makeRunningInstance(workflowA1Id, definition2Id, ownerA.token);

  // Workspace A3: its own workflow (definition pinned to NO playbook) +
  // one running instance — delivered work pursuing no covering goal.
  const wf3 = await makeWorkflowWithDefinition(workspaceA3, ownerA.token, null, 'Orphan Workflow A3');
  workflowA3Id = wf3.workflowId;
  definition3Id = wf3.definitionId;
  instance3Id = await makeRunningInstance(workflowA3Id, definition3Id, ownerA.token);

  // --- Executions (the attempt ledger; every lifecycle state counts) ---
  execDet1Id = await makeExecution(workspaceA1, ownerA.token, instance1Id, 'prep', 'deterministic', 'pi-exec-det-1');
  // On instance2 — whose pinned definition is NOT declared by the ACTIVE
  // deployment: the scope-leakage fixture.
  await makeExecution(workspaceA1, ownerA.token, instance2Id, 'prep', 'deterministic', 'pi-exec-det-2');
  await makeExecution(workspaceA1, ownerA.token, instance1Id, 'prep', 'extension', 'pi-exec-ext-1');
  // A human-kind execution (the utilization indicator; NEVER costed).
  await makeExecution(workspaceA1, ownerA.token, instance1Id, 'visit', 'human', 'pi-exec-hum-1');
  // On workspace A3's instance (no deployment, no covering goal).
  await makeExecution(workspaceA3, ownerA.token, instance3Id, 'prep', 'deterministic', 'pi-exec-det-3');

  // --- Evidence (revenue provenance + the job outcome reference) ---
  evidence1Id = await appendEvidence(clientA, ownerA.token, 'report/2026-09-revenue');
  evidence2Id = await appendEvidence(clientA, ownerA.token, 'report/2026-09-job-outcome');

  // --- Metric observations (the append-only revenue ledger) ---
  // Identity 1 (revenue/monthly/client-wide): an original + a LATER
  // restatement — latest-wins.
  await appendObservation(clientA, ownerA.token, {
    metricName: 'revenue',
    dimensions: { series: 'monthly' },
    value: 5000,
    unit: 'USD',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-revenue',
    observedAt: '2026-09-15T10:30:00.000Z',
    quality: 'ok',
  });
  await appendObservation(clientA, ownerA.token, {
    metricName: 'revenue',
    dimensions: { series: 'monthly' },
    value: 5200,
    unit: 'USD',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-revenue-restated',
    observedAt: '2026-09-16T10:30:00.000Z',
    quality: 'restated',
    evidenceRef: evidence1Id,
  });
  // Identity 2 (revenue/euro/client-wide): foreign currency — never
  // converted, never in the margin.
  await appendObservation(clientA, ownerA.token, {
    metricName: 'revenue',
    dimensions: { series: 'euro' },
    value: 90,
    unit: 'EUR',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-euro',
    observedAt: '2026-09-15T10:30:00.000Z',
    quality: 'ok',
  });
  // Identity 3 (revenue/monthly/workspace A1): the workspace-tagged slice.
  await appendObservation(clientA, ownerA.token, {
    metricName: 'revenue',
    dimensions: { series: 'monthly' },
    value: 300,
    unit: 'USD',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-ws',
    observedAt: '2026-09-15T10:30:00.000Z',
    quality: 'ok',
    workspaceId: workspaceA1,
  });
  // NOT revenue at all (never in the slice).
  await appendObservation(clientA, ownerA.token, {
    metricName: 'activation_rate',
    dimensions: {},
    value: 0.42,
    unit: '%',
    sourceSystem: 'internal',
    sourceRef: 'internal/activation',
    observedAt: '2026-09-15T10:30:00.000Z',
    quality: 'ok',
  });

  // --- The human-agent profile + the delivered job (the /jobs surface) ---
  const profile = await apiCall(port(), '/api/field-agents', {
    token: humanAgentA.token,
    body: matchingFieldAgentProfile,
  });
  assert.equal(profile.status, 201, JSON.stringify(profile.body));
  const humanAgentProfileId = profile.body['agentId'] as string;

  const projected = await apiCall(
    port(),
    `/api/workflows/${workflowA1Id}/instances/${instance1Id}/jobs`,
    {
      token: ownerA.token,
      body: {
        nodeId: 'visit',
        title: 'Field visit — collect signed feedback',
        description: 'Visit the venue and collect the signed form.',
        specialization: 'field_agent',
        requiredCapabilities: ['canvassing'],
        territory: { kind: 'city', value: 'accra' },
        dayOfWeek: 2,
        startMinute: 540,
        endMinute: 1020,
      },
    },
  );
  assert.equal(projected.status, 201, `job projection: ${JSON.stringify(projected.body)}`);
  jobId = projected.body['jobId'] as string;

  const offer = await apiCall(port(), `/api/jobs/${jobId}/offers`, {
    token: ownerA.token,
    body: {
      candidateAgentId: humanAgentProfileId,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  });
  assert.equal(offer.status, 201, JSON.stringify(offer.body));
  jobOfferId = offer.body['offerId'] as string;
  const accepted = await apiCall(port(), `/api/jobs/${jobId}/offers/${jobOfferId}/accept`, {
    token: humanAgentA.token,
    body: {},
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const outcome = await apiCall(port(), `/api/jobs/${jobId}/outcome`, {
    token: humanAgentA.token,
    body: { outcome: 'succeeded', evidenceRef: evidence2Id },
  });
  assert.equal(outcome.status, 201, JSON.stringify(outcome.body));

  // --- AI/provider telemetry (the /ai-runtime surface) ---
  const model = await apiCall(port(), '/api/ai/models', {
    token: await adminToken(),
    body: {
      providerLabel: 'example-labs-pi',
      modelKey: 'example-model-pi',
      displayName: 'Example Model PI',
      capabilities: ['text-generation', 'tool-use'],
      toolFeatures: ['function-calling'],
      contextLimitTokens: 128_000,
      costInputPerMtok: 3.5,
      costOutputPerMtok: 10.0,
      latencyP50Ms: 900,
      latencyP95Ms: 2400,
      reliability: 0.98,
      qualitySignals: { 'copywriting.generate': 0.87 },
      privacyCharacteristics: { dataResidency: 'eu', trainingUse: false },
    },
  });
  assert.equal(model.status, 201, JSON.stringify(model.body));
  modelRegistryId = model.body['modelRegistryId'] as string;

  const taskProfile = await apiCall(port(), `/api/workspaces/${workspaceA1}/ai/task-profiles`, {
    token: ownerA.token,
    body: {
      taskClass: 'copywriting.generate',
      qualityTarget: 'publication-ready',
      riskClass: 'medium',
      contextRequirements: { minInputTokens: 200, maxInputTokens: 8000 },
      latencyTargetMs: 30_000,
      maxCostPerInvocation: 0.25,
      privacyClass: 'internal',
      toolRequirements: ['web-search'],
      outputSchema: { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] },
      evaluatorIds: ['brand-voice-rubric'],
      escalationPolicy: { maxEscalations: 2, fallback: 'human-review' },
      idempotencyKey: 'pi-task-profile-1',
    },
  });
  assert.equal(taskProfile.status, 201, JSON.stringify(taskProfile.body));
  taskProfileId = (taskProfile.body['taskProfile'] as Record<string, unknown>)['taskProfileId'] as string;

  // Linked telemetry (through the deterministic execution) + an orphan row.
  const linked = await apiCall(port(), `/api/workspaces/${workspaceA1}/ai/usage-telemetry`, {
    token: ownerA.token,
    body: {
      taskProfileId,
      modelRegistryId,
      executionId: execDet1Id,
      outcome: 'succeeded',
      latencyMs: 1234,
      costAmount: 0.0125,
      tokensIn: 1500,
      tokensOut: 420,
      escalationCount: 0,
      idempotencyKey: 'pi-usage-1',
    },
  });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  const orphan = await apiCall(port(), `/api/workspaces/${workspaceA1}/ai/usage-telemetry`, {
    token: ownerA.token,
    body: {
      taskProfileId,
      modelRegistryId,
      outcome: 'succeeded',
      latencyMs: 900,
      costAmount: 0.0075,
      tokensIn: 400,
      tokensOut: 100,
      escalationCount: 0,
      idempotencyKey: 'pi-usage-2',
    },
  });
  assert.equal(orphan.status, 201, JSON.stringify(orphan.body));

  // --- The integrations connection (the provider-activity surface) ---
  const credential = await apiCall(port(), `/api/agencies/${agencyA}/credentials`, {
    token: ownerA.token,
    body: { kind: 'integration_api_key', label: 'Meta Ads API key', secretHandle: 'pi-meta-api-key' },
  });
  assert.equal(credential.status, 201, JSON.stringify(credential.body));
  const connection = await apiCall(port(), `/api/clients/${clientA}/connections`, {
    token: ownerA.token,
    body: {
      adapterKey: 'meta-ads',
      credentialReferenceId: credential.body['credentialId'] as string,
      providerConfig: { region: 'eu-west-1' },
    },
  });
  assert.equal(connection.status, 201, `connection: ${JSON.stringify(connection.body)}`);
  connectionId = connection.body['connectionId'] as string;

  // --- The ACTIVE deployment (the deployed envelope) ---
  await declarePlatformPolicy('deployment');
  const deployment = await apiCall(port(), `/api/workspaces/${workspaceA1}/deployments`, {
    token: ownerA.token,
    body: {
      selection: {
        playbookVersionId: playbookV1,
        workflowDefinitionIds: [definition1Id],
        requiredDomainPacks: [],
        requiredCapabilities: [],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggerConfig: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(deployment.status, 201, JSON.stringify(deployment.body));
  const deploymentId = deployment.body['deploymentId'] as string;
  let deploymentVersion = deployment.body['version'] as number;
  for (const [action, body] of [
    ['validate', { idempotencyKey: `pi-validate-${deploymentId}`, expectedVersion: deploymentVersion }],
  ] as const) {
    const response = await apiCall(
      port(),
      `/api/workspaces/${workspaceA1}/deployments/${deploymentId}/${action}`,
      { token: ownerA.token, method: 'POST', body },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    deploymentVersion = (response.body['deployment'] as Record<string, unknown>)['version'] as number;
  }
  const activated = await apiCall(
    port(),
    `/api/workspaces/${workspaceA1}/deployments/${deploymentId}/activate`,
    {
      token: ownerA.token,
      method: 'POST',
      body: { idempotencyKey: `pi-activate-${deploymentId}`, expectedVersion: deploymentVersion },
    },
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal((activated.body['deployment'] as Record<string, unknown>)['status'], 'active');
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

async function clientView(token: string): Promise<Record<string, unknown>> {
  const response = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}`,
    { token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  return response.body;
}

function figureOf(body: Record<string, unknown>, path: string[]): Record<string, unknown> {
  let current: unknown = body;
  for (const key of path) {
    assert.ok(current !== null && typeof current === 'object', `path ${path.join('.')} broke at ${key}`);
    current = (current as Record<string, unknown>)[key];
  }
  assert.ok(current !== null && typeof current === 'object');
  return current as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. THE GOLDEN PATH — the client view over real authorities, with DIRECT
//    SQL ground truth (AC-5 + AC-7)
// ---------------------------------------------------------------------------

test('the client view derives the full figure set from real authorities — cross-checked against DIRECT SQL ground truth', async () => {
  const view = await clientView(ownerA.token);

  // Scope.
  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'client-profit-intelligence');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientId'], clientA);
  assert.equal(scope['workspaceCount'], 3);

  // --- REVENUE (AC-5a): latest-wins, declared-unit grouping, evidence ---
  const revenue = view['revenue'] as Record<string, unknown>;
  const byCurrency = revenue['byCurrency'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    byCurrency.map((entry) => entry['currency']),
    ['EUR', 'USD'],
    'grouped by DECLARED unit (locale order), never converted',
  );
  const usd = byCurrency.find((entry) => entry['currency'] === 'USD')!;
  const eur = byCurrency.find((entry) => entry['currency'] === 'EUR')!;
  // 5200 (restated winner) + 300 (workspace-tagged identity).
  assert.equal(figureOf(usd, ['total'])['value'], 5500);
  assert.equal(usd['identityCount'], 2);
  assert.equal(figureOf(eur, ['total'])['value'], 90);
  assert.equal(eur['identityCount'], 1);
  assert.equal(revenue['observationCount'], 4, 'four in-scope rows (the activation_rate row never entered)');
  assert.equal(revenue['supersededObservationCount'], 1);
  assert.equal(revenue['restatedIdentityCount'], 1);
  const qualityCounts = revenue['qualityCounts'] as Record<string, number>;
  assert.equal(qualityCounts['ok'], 2);
  assert.equal(qualityCounts['restated'], 1);
  const evidenceRefs = revenue['evidenceRefs'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(evidenceRefs, [{ kind: 'evidence', id: evidence1Id }], 'evidence provenance ships');

  // GROUND TRUTH (SQL): the in-scope row population.
  const revenueRows = await db!.query<{ count: string; usd: string }>(
    `SELECT count(*)::text AS count,
            coalesce(sum(value) FILTER (WHERE unit = 'USD'), 0)::text AS usd
     FROM metric_observations
     WHERE client_id = $1
       AND metric_name IN ('revenue', 'gross_revenue', 'net_revenue', 'recurring_revenue', 'mrr', 'arr')`,
    [clientA],
  );
  // All 4 in-scope rows exist on the authority (the module's slice is the
  // same population — the superseded predecessor counted, never summed).
  assert.equal(Number(revenueRows.rows[0]!.count), 4);
  // The summed-across-ALL-rows SQL number deliberately differs from the
  // derived figure (5000 + 5200 + 300 = 10500): latest-wins is the
  // disclosed derivation rule, not the raw sum.
  assert.equal(Number(revenueRows.rows[0]!.usd), 10500);

  // --- DELIVERY COST (AC-5b) ---
  const costs = view['costs'] as Record<string, unknown>;
  const executionCounts = costs['executionCounts'] as Record<string, number>;
  assert.deepEqual(executionCounts, { deterministic: 3, ai: 0, human: 1, extension: 1 });
  // GROUND TRUTH (SQL): the execution attempt ledger by kind.
  const executionKindRows = await db!.query<{ execution_kind: string; count: string }>(
    `SELECT execution_kind, count(*)::text AS count FROM executions
     WHERE client_id = $1 GROUP BY execution_kind ORDER BY execution_kind`,
    [clientA],
  );
  const sqlKinds = new Map(executionKindRows.rows.map((row) => [row.execution_kind, Number(row.count)]));
  assert.equal(sqlKinds.get('deterministic'), executionCounts['deterministic']);
  assert.equal(sqlKinds.get('extension'), executionCounts['extension']);
  assert.equal(sqlKinds.get('human'), executionCounts['human']);
  assert.equal(sqlKinds.get('ai') ?? 0, executionCounts['ai']);

  // 3×0.05 + 1×0.02 (every lifecycle state counts — the attempt ledger).
  assert.equal(figureOf(costs, ['automationDeliveryCost'])['value'], 0.17);
  assert.equal(costs['deliveredJobCount'], 1);
  assert.equal(costs['inFlightJobCount'], 0);
  assert.equal(figureOf(costs, ['humanDeliveryCost'])['value'], 75);
  // GROUND TRUTH (SQL): the delivered-jobs surface.
  const deliveredRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM jobs
     WHERE client_id = $1 AND status = 'outcome_submitted'`,
    [clientA],
  );
  assert.equal(Number(deliveredRows.rows[0]!.count), 1);

  // --- AI/PROVIDER COST (AC-5c) ---
  const aiProvider = costs['aiProvider'] as Record<string, unknown>;
  assert.equal(figureOf(aiProvider, ['telemetryCost'])['value'], 0.02);
  assert.equal(aiProvider['telemetryRowCount'], 2);
  // GROUND TRUTH (SQL): the telemetry spend.
  const telemetryRows = await db!.query<{ total: string; count: string }>(
    `SELECT coalesce(sum(cost_amount), 0)::text AS total, count(*)::text AS count
     FROM ai_usage_telemetry WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(telemetryRows.rows[0]!.total), 0.02);
  assert.equal(Number(telemetryRows.rows[0]!.count), 2);

  // The integrations adapter activity: counts + references, NO invented cost.
  const adapterActivity = aiProvider['adapterActivity'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(adapterActivity.length, 1);
  const meta = adapterActivity.find((row) => row['adapterKey'] === 'meta-ads')!;
  assert.equal(meta['connectionCount'], 1);
  assert.equal(meta['ingestedEventCount'], 0);
  assert.deepEqual(meta['connectionRefs'], [{ kind: 'integration-connection', id: connectionId }]);
  // GROUND TRUTH (SQL): the connection population.
  const connectionRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM integration_connections WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(connectionRows.rows[0]!.count), 1);

  // The TOTAL: automation + human + telemetry (the exact component sum).
  assert.equal(figureOf(costs, ['totalDeliveryCost'])['value'], 75.19);
  assert.equal(costs['humanExecutionCostAttribution'], 'utilization-indicator-only');

  // --- HUMAN CAPACITY + UTILIZATION (AC-5b) ---
  const capacity = view['capacity'] as Record<string, unknown>;
  assert.equal(capacity['activeProfileCount'], 1);
  assert.equal(capacity['skippedProfileCount'], 0);
  assert.equal(capacity['weeklyCapacityMinutes'], 600);
  assert.equal(figureOf(capacity, ['weeklyCapacityCost'])['value'], 550);
  assert.equal(figureOf(capacity, ['weeklyCapacityCost'])['provenance'], 'estimated');
  // GROUND TRUTH (SQL): the declared availability pool (the jsonb array
  // is UNNESTED per window — the authoritative minutes arithmetic).
  const availabilityRows = await db!.query<{ minutes: string; profiles: string }>(
    `SELECT coalesce(sum((avail->>'endMinute')::int - (avail->>'startMinute')::int), 0)::text AS minutes,
            count(DISTINCT agent_id)::text AS profiles
     FROM human_agents, jsonb_array_elements(availability) AS avail
     WHERE authorization_state = 'active'`,
  );
  assert.equal(Number(availabilityRows.rows[0]!.minutes), 600);
  assert.equal(Number(availabilityRows.rows[0]!.profiles), 1);

  const utilization = view['utilization'] as Record<string, unknown>;
  assert.equal(figureOf(utilization, ['deliveredWorkMinutes'])['value'], 120);
  assert.equal(figureOf(utilization, ['capacityMinutes'])['value'], 600);
  assert.equal(figureOf(utilization, ['utilization'])['value'], 0.2);
  assert.equal(utilization['humanExecutionCount'], 1, 'the indicator is disclosed, never costed');

  // --- SCOPE LEAKAGE (AC-5d) ---
  const leakage = view['scopeLeakage'] as Record<string, unknown>;
  const indicators = leakage['indicators'] as ReadonlyArray<Record<string, unknown>>;
  const byKind = new Map(indicators.map((indicator) => [indicator['kind'], indicator]));
  // exec-det-2 (instance2's definition NOT declared by the ACTIVE
  // deployment) + exec-det-3 (workspace A3 has no deployment at all).
  assert.equal(byKind.get('executions-outside-deployed-envelope')!['count'], 2);
  // Workspace A3's non-terminal instance with no covering ACTIVE goal.
  assert.equal(byKind.get('work-without-active-goal')!['count'], 1);
  // Workspace A2's ACTIVE goal with zero instances in scope.
  assert.equal(byKind.get('active-goals-without-delivery')!['count'], 1);
  for (const indicator of indicators) {
    assert.ok(typeof indicator['rule'] === 'string' && (indicator['rule'] as string).length > 0);
    assert.ok(Array.isArray(indicator['sourceRefs']));
  }

  // --- MARGIN (AC-5e) ---
  const margin = view['margin'] as Record<string, unknown>;
  assert.equal(figureOf(margin, ['realizedRevenue'])['value'], 5500);
  assert.equal(figureOf(margin, ['realizedDeliveryCost'])['value'], 75.19);
  assert.equal(figureOf(margin, ['realizedMargin'])['value'], 5424.81);
  assert.equal(figureOf(margin, ['realizedMargin'])['provenance'], 'observed');
  // Estimated: ACTIVE-goal USD criteria (5000; the EUR criterion never
  // converts) − the standing weekly capacity commitment (550).
  assert.equal(figureOf(margin, ['estimatedRevenue'])['value'], 5000);
  assert.equal(figureOf(margin, ['estimatedDeliveryCost'])['value'], 550);
  assert.equal(figureOf(margin, ['estimatedMargin'])['value'], 4450);
  assert.equal(figureOf(margin, ['estimatedRevenue'])['provenance'], 'estimated');
  const currencyPolicyNote = margin['currencyPolicyNote'] as string;
  assert.ok(currencyPolicyNote.includes('EUR'), 'the excluded currency is disclosed');
  assert.ok(currencyPolicyNote.includes('NOT converted'), 'the no-FX policy is stated');

  // --- CONTRIBUTION BREAKDOWN (AC-5e) ---
  // Service (Playbook): det-1 (0.05) + det-2 (0.05) + ext-1 (0.02) +
  // linked telemetry (0.0125) + the delivered job (75) = 75.1325 → 75.13
  // (money rounds to cents — the pinning-stable arithmetic).
  const serviceContributions = view['serviceContributions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(serviceContributions.length, 1);
  const serviceRow = serviceContributions[0]!;
  assert.equal(serviceRow['playbookId'], playbookId);
  assert.equal(figureOf(serviceRow, ['deliveryCost'])['value'], 75.13);
  assert.equal(serviceRow['deliveredJobCount'], 1);
  assert.equal(serviceRow['executionCount'], 3);
  assert.equal(figureOf(serviceRow, ['revenue'])['value'], null);
  assert.ok(
    String(figureOf(serviceRow, ['revenue'])['notDerivableReason']).includes('no playbook reference'),
    'per-service revenue is NULL WITH REASON (never fabricated)',
  );
  // Unattributed service remainder: orphan telemetry (0.0075) + det-3
  // (no playbook chain, 0.05) → 0.06 (rounded).
  assert.equal(figureOf(view, ['unattributedServiceDeliveryCost'])['value'], 0.06);

  // Project (Deployment): det-1 + ext-1 + linked telemetry + the job →
  // 75.08; unattributed: det-2 + det-3 + orphan telemetry → 0.11.
  const projectContributions = view['projectContributions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(projectContributions.length, 1);
  const projectRow = projectContributions[0]!;
  assert.equal(projectRow['deploymentStatus'], 'active');
  assert.equal(figureOf(projectRow, ['deliveryCost'])['value'], 75.08);
  assert.equal(projectRow['deliveredJobCount'], 1);
  assert.equal(projectRow['executionCount'], 3);
  assert.equal(figureOf(projectRow, ['revenue'])['value'], null);
  assert.ok(
    String(figureOf(projectRow, ['revenue'])['notDerivableReason']).includes('no deployment reference'),
  );
  assert.equal(figureOf(view, ['unattributedProjectDeliveryCost'])['value'], 0.11);

  // --- THE CALCULATION DISCLOSURE (AC-2/AC-7) ---
  const calculation = view['calculation'] as Record<string, unknown>;
  assert.equal(calculation['calculationVersion'], PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  assert.deepEqual(calculation['assumptions'], PROFIT_INTELLIGENCE_ASSUMPTIONS);
  assert.equal(calculation['basis'], 'live-derivation-over-canonical-authorities');
  assert.equal(calculation['persistence'], 'none-derived-read-model');
  assert.ok(typeof view['generatedAt'] === 'string');

  // Every material figure carries the version + assumption keys + source refs.
  const usdTotal = figureOf(usd, ['total']);
  assert.equal(usdTotal['calculationVersion'], PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  const assumptionKeys = usdTotal['assumptionKeys'] as readonly string[];
  assert.ok(assumptionKeys.includes('revenueMetricNames'));
  assert.ok(assumptionKeys.includes('latestObservationWinsPerMetricIdentity'));
  const usdRefs = usdTotal['sourceRefs'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(usdRefs.length, 2, 'the two contributing USD identities are cited (the restated winner + the workspace-tagged row; EUR is its own currency entry)');
  // Any ACTIVE member of the owning agency may read (the read posture).
  const memberView = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}`,
    { token: memberA.token },
  );
  assert.equal(memberView.status, 200);
});

// ---------------------------------------------------------------------------
// 2. THE WORKSPACE SLICE (AC-5 — workspace-scoped surface)
// ---------------------------------------------------------------------------

test('the workspace view narrows to the workspace slice with the same disclosure discipline', async () => {
  const response = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`,
    { token: ownerA.token },
  );
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  const view = response.body;

  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'workspace-profit-intelligence');
  assert.equal(scope['workspaceId'], workspaceA1);

  // Workspace-tagged revenue ONLY (the client-wide rows are attributed at
  // the client rollup — no allocation assumption).
  const revenue = view['revenue'] as Record<string, unknown>;
  const byCurrency = revenue['byCurrency'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(byCurrency.length, 1);
  assert.equal(byCurrency[0]!['currency'], 'USD');
  assert.equal(figureOf(byCurrency[0]!, ['total'])['value'], 300);
  assert.equal(byCurrency[0]!['identityCount'], 1);
  assert.equal(revenue['observationCount'], 1);
  assert.equal(revenue['supersededObservationCount'], 0);

  // The workspace's OWN executions + telemetry (det-1, det-2, ext-1,
  // hum-1; both telemetry rows).
  const costs = view['costs'] as Record<string, unknown>;
  assert.deepEqual(costs['executionCounts'], { deterministic: 2, ai: 0, human: 1, extension: 1 });
  assert.equal(figureOf(costs, ['automationDeliveryCost'])['value'], 0.12);
  assert.equal(figureOf(costs, ['aiProvider', 'telemetryCost'])['value'], 0.02);
  // The delivered job is workspace-scoped to A1.
  assert.equal(costs['deliveredJobCount'], 1);
  assert.equal(figureOf(costs, ['totalDeliveryCost'])['value'], 75.14);

  // The workspace slice of scope leakage: only exec-det-2 leaks here (the
  // deployment declares definition1; instance2 pins definition2).
  const leakage = view['scopeLeakage'] as Record<string, unknown>;
  const indicators = leakage['indicators'] as ReadonlyArray<Record<string, unknown>>;
  const byKind = new Map(indicators.map((indicator) => [indicator['kind'], indicator]));
  assert.equal(byKind.get('executions-outside-deployed-envelope')!['count'], 1);
  assert.equal(byKind.get('work-without-active-goal')!['count'], 0, 'the workspace-scoped goal covering A1 covers this workspace');
  assert.equal(byKind.get('active-goals-without-delivery')!['count'], 0);

  // The workspace margin: realized 300 − 75.14; estimated (the covering
  // A1-scoped goal's criteria) 5000 − 550.
  const margin = view['margin'] as Record<string, unknown>;
  assert.equal(figureOf(margin, ['realizedRevenue'])['value'], 300);
  assert.equal(figureOf(margin, ['realizedDeliveryCost'])['value'], 75.14);
  assert.equal(figureOf(margin, ['realizedMargin'])['value'], 224.86);
  assert.equal(figureOf(margin, ['estimatedRevenue'])['value'], 5000);
  assert.equal(figureOf(margin, ['estimatedMargin'])['value'], 4450);

  // The disclosure ships on the workspace surface too.
  const calculation = view['calculation'] as Record<string, unknown>;
  assert.equal(calculation['calculationVersion'], PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  assert.deepEqual(calculation['assumptions'], PROFIT_INTELLIGENCE_ASSUMPTIONS);
});

// ---------------------------------------------------------------------------
// 3. THE AGENCY PORTFOLIO (AC-5 — the agency-scoped surface)
// ---------------------------------------------------------------------------

test('the agency view rolls up the portfolio with per-client contribution rows', async () => {
  const response = await apiCall(port(), `/api/profit-intelligence/${agencyA}`, {
    token: ownerA.token,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body).slice(0, 600));
  const view = response.body;

  const scope = view['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'agency-profit-intelligence');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientCount'], 2);
  assert.equal(scope['humanAgentCount'], 1);

  // The per-client contribution rows (the client dimension of AC-5e).
  const perClient = view['perClient'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(perClient.length, 2);
  const rowA = perClient.find((row) => row['clientId'] === clientA)!;
  const rowA2 = perClient.find((row) => row['clientId'] === clientA2)!;
  assert.equal(figureOf(rowA, ['revenue'])['value'], 5500);
  assert.equal(figureOf(rowA, ['deliveryCost'])['value'], 75.19);
  assert.equal(figureOf(rowA, ['margin'])['value'], 5424.81);
  // The EMPTY client tallies honest zeros (nothing delivered, nothing sold).
  assert.equal(figureOf(rowA2, ['revenue'])['value'], 0);
  assert.equal(figureOf(rowA2, ['deliveryCost'])['value'], 0);
  assert.equal(figureOf(rowA2, ['margin'])['value'], 0);

  // The portfolio rollups equal the client-A derivations (client A2 is
  // empty — the merge is exact).
  const revenue = view['revenue'] as Record<string, unknown>;
  const usd = (revenue['byCurrency'] as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry['currency'] === 'USD',
  )!;
  assert.equal(figureOf(usd, ['total'])['value'], 5500);
  assert.equal(revenue['observationCount'], 4);
  assert.equal(revenue['supersededObservationCount'], 1);

  const costs = view['costs'] as Record<string, unknown>;
  assert.deepEqual(costs['executionCounts'], { deterministic: 3, ai: 0, human: 1, extension: 1 });
  assert.equal(figureOf(costs, ['totalDeliveryCost'])['value'], 75.19);

  const capacity = view['capacity'] as Record<string, unknown>;
  assert.equal(capacity['weeklyCapacityMinutes'], 600);
  const utilization = view['utilization'] as Record<string, unknown>;
  assert.equal(figureOf(utilization, ['utilization'])['value'], 0.2);

  const leakage = view['scopeLeakage'] as Record<string, unknown>;
  const byKind = new Map(
    (leakage['indicators'] as ReadonlyArray<Record<string, unknown>>).map((indicator) => [
      indicator['kind'],
      indicator,
    ]),
  );
  assert.equal(byKind.get('executions-outside-deployed-envelope')!['count'], 2);
  assert.equal(byKind.get('work-without-active-goal')!['count'], 1);
  assert.equal(byKind.get('active-goals-without-delivery')!['count'], 1);

  const margin = view['margin'] as Record<string, unknown>;
  assert.equal(figureOf(margin, ['realizedMargin'])['value'], 5424.81);
  assert.equal(figureOf(margin, ['estimatedMargin'])['value'], 4450);

  // The portfolio service/project contributions merge across clients.
  const serviceContributions = view['serviceContributions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(serviceContributions.length, 1);
  assert.equal(serviceContributions[0]!['playbookId'], playbookId);
  assert.equal(figureOf(serviceContributions[0]!, ['deliveryCost'])['value'], 75.13);
  assert.equal(figureOf(view, ['unattributedServiceDeliveryCost'])['value'], 0.06);
  const projectContributions = view['projectContributions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(projectContributions.length, 1);
  assert.equal(figureOf(projectContributions[0]!, ['deliveryCost'])['value'], 75.08);
  assert.equal(figureOf(view, ['unattributedProjectDeliveryCost'])['value'], 0.11);

  // The disclosure ships on the agency surface too.
  const calculation = view['calculation'] as Record<string, unknown>;
  assert.equal(calculation['calculationVersion'], PROFIT_INTELLIGENCE_CALCULATION_VERSION);
  assert.equal(calculation['persistence'], 'none-derived-read-model');
});

// ---------------------------------------------------------------------------
// 4. LIVE-FOLLOW — authority changes flow into the figures on the NEXT read
// ---------------------------------------------------------------------------

test('live-follow: new revenue, a new execution and new telemetry move the figures on the very next read', async () => {
  const before = await clientView(ownerA.token);
  const beforeUsd = ((before['revenue'] as Record<string, unknown>)['byCurrency'] as ReadonlyArray<Record<string, unknown>>)
    .find((entry) => entry['currency'] === 'USD')!;
  assert.equal(figureOf(beforeUsd, ['total'])['value'], 5500);
  assert.equal(
    ((before['costs'] as Record<string, unknown>)['executionCounts'] as Record<string, number>)['deterministic'],
    3,
  );
  assert.equal(figureOf(before, ['costs', 'totalDeliveryCost'])['value'], 75.19);

  // --- A NEW revenue observation (a NEW identity — not a restatement). ---
  await appendObservation(clientA, ownerA.token, {
    metricName: 'revenue',
    dimensions: { series: 'livefollow' },
    value: 250,
    unit: 'USD',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-livefollow',
    observedAt: '2026-09-17T10:30:00.000Z',
    quality: 'ok',
  });
  // --- A NEW deterministic execution (outside the deployed envelope). ---
  await makeExecution(workspaceA1, ownerA.token, instance2Id, 'prep', 'deterministic', 'pi-exec-livefollow');
  // --- NEW AI/provider telemetry. ---
  const extra = await apiCall(port(), `/api/workspaces/${workspaceA1}/ai/usage-telemetry`, {
    token: ownerA.token,
    body: {
      taskProfileId,
      modelRegistryId,
      outcome: 'succeeded',
      latencyMs: 700,
      costAmount: 0.03,
      tokensIn: 200,
      tokensOut: 50,
      escalationCount: 0,
      idempotencyKey: 'pi-usage-livefollow',
    },
  });
  assert.equal(extra.status, 201, JSON.stringify(extra.body));

  const after = await clientView(ownerA.token);
  const afterRevenue = after['revenue'] as Record<string, unknown>;
  const afterUsd = (afterRevenue['byCurrency'] as ReadonlyArray<Record<string, unknown>>).find(
    (entry) => entry['currency'] === 'USD',
  )!;
  assert.equal(figureOf(afterUsd, ['total'])['value'], 5750, 'revenue follows the new observation immediately');
  assert.equal(afterRevenue['observationCount'], 5);
  const afterCosts = after['costs'] as Record<string, unknown>;
  assert.equal(
    (afterCosts['executionCounts'] as Record<string, number>)['deterministic'],
    4,
    'the execution count follows the new execution immediately',
  );
  assert.equal(figureOf(afterCosts, ['automationDeliveryCost'])['value'], 0.22);
  assert.equal(figureOf(afterCosts, ['aiProvider', 'telemetryCost'])['value'], 0.05);
  assert.equal(figureOf(afterCosts, ['totalDeliveryCost'])['value'], 75.27);
  const afterLeakage = new Map(
    ((after['scopeLeakage'] as Record<string, unknown>)['indicators'] as ReadonlyArray<Record<string, unknown>>).map(
      (indicator) => [indicator['kind'], indicator],
    ),
  );
  assert.equal(
    afterLeakage.get('executions-outside-deployed-envelope')!['count'],
    3,
    'the leakage indicator follows the new out-of-envelope execution',
  );
  const afterMargin = after['margin'] as Record<string, unknown>;
  assert.equal(figureOf(afterMargin, ['realizedRevenue'])['value'], 5750);
  assert.equal(figureOf(afterMargin, ['realizedMargin'])['value'], 5674.73);

  // SQL ground truth for the live-follow state.
  const revenueRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM metric_observations
     WHERE client_id = $1 AND metric_name = 'revenue'`,
    [clientA],
  );
  assert.equal(Number(revenueRows.rows[0]!.count), 5);
  const executionRows = await db!.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM executions WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(executionRows.rows[0]!.count), 6);
  const telemetryRows = await db!.query<{ total: string }>(
    `SELECT coalesce(sum(cost_amount), 0)::text AS total FROM ai_usage_telemetry WHERE client_id = $1`,
    [clientA],
  );
  assert.equal(Number(telemetryRows.rows[0]!.total), 0.05);
});

// ---------------------------------------------------------------------------
// 5. CALCULATION-VERSION PINNING (AC-7) — same state ⇒ byte-identical body
// ---------------------------------------------------------------------------

test('calculation-version pinning: two consecutive reads of unchanged authorities are byte-identical (generatedAt excluded)', async () => {
  const first = await clientView(ownerA.token);
  const second = await clientView(ownerA.token);
  const strip = (body: Record<string, unknown>): string => {
    const copy = { ...body } as Record<string, unknown>;
    delete copy['generatedAt'];
    return JSON.stringify(copy);
  };
  assert.equal(
    strip(second),
    strip(first),
    'same authority state + same calculation version ⇒ byte-identical figures',
  );
});

// ---------------------------------------------------------------------------
// 6. THE ISOLATION BATTERY (fail-closed)
// ---------------------------------------------------------------------------

test('anonymous calls are 401; foreign/malformed/unknown agencies, clients and workspaces are the uniform 404', async () => {
  // Anonymous (fail closed at the authenticator).
  const anonymous = await apiCall(port(), `/api/profit-intelligence/${agencyA}`);
  assert.equal(anonymous.status, 401);

  // A FOREIGN agency's owner probing agency A: the uniform 404 (never a
  // 403 that leaks the agency's existence).
  const foreign = await apiCall(port(), `/api/profit-intelligence/${agencyA}`, {
    token: ownerB.token,
  });
  assert.equal(foreign.status, 404);
  const foreignClient = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}`,
    { token: ownerB.token },
  );
  assert.equal(foreignClient.status, 404);

  // Malformed and unknown agency identifiers: the SAME 404.
  const malformed = await apiCall(port(), '/api/profit-intelligence/not-a-uuid', {
    token: ownerA.token,
  });
  assert.equal(malformed.status, 404);
  const unknown = await apiCall(port(), `/api/profit-intelligence/${randomUUID()}`, {
    token: ownerA.token,
  });
  assert.equal(unknown.status, 404);

  // The client detail of ANOTHER agency's client: the uniform 404.
  const foreignAgencyClient = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignAgencyClient.status, 404);
  const malformedClient = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/not-a-uuid`,
    { token: ownerA.token },
  );
  assert.equal(malformedClient.status, 404);
  const unknownClient = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${randomUUID()}`,
    { token: ownerA.token },
  );
  assert.equal(unknownClient.status, 404);

  // The workspace detail of ANOTHER client's workspace: the uniform 404.
  const foreignWorkspace = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/${workspaceB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignWorkspace.status, 404);
  const malformedWorkspace = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/not-a-uuid`,
    { token: ownerA.token },
  );
  assert.equal(malformedWorkspace.status, 404);
  const unknownWorkspace = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/${randomUUID()}`,
    { token: ownerA.token },
  );
  assert.equal(unknownWorkspace.status, 404);

  // A SUSPENDED membership is the 403 (intra-tenant, post-existence).
  const suspended = await apiCall(port(), `/api/profit-intelligence/${agencyA}`, {
    token: suspendedA.token,
  });
  assert.equal(suspended.status, 403);
});

test('READ-ONLY BY CONSTRUCTION: every mutating verb is 405 at the router; authority-shaped query parameters change nothing', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const path of [
      `/api/profit-intelligence/${agencyA}`,
      `/api/profit-intelligence/${agencyA}/clients/${clientA}`,
      `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`,
    ]) {
      const response = await apiCall(port(), path, { token: ownerA.token, method });
      assert.equal(response.status, 405, `${method} ${path} must be 405`);
    }
  }

  // Authority-shaped query parameters change nothing (the surface reads
  // none of them; bodies on GETs are ignored entirely).
  const plain = await clientView(ownerA.token);
  const polluted = await apiCall(
    port(),
    `/api/profit-intelligence/${agencyA}/clients/${clientA}?agencyId=${agencyB}&clientId=${clientB}&calculationVersion=forged&value=99999`,
    { token: ownerA.token },
  );
  assert.equal(polluted.status, 200);
  const strip = (body: Record<string, unknown>): string => {
    const copy = { ...body } as Record<string, unknown>;
    delete copy['generatedAt'];
    return JSON.stringify(copy);
  };
  assert.equal(strip(polluted.body), strip(plain), 'query parameters are never read');
});

test('after every read/probe the authoritative rows are BYTE-IDENTICAL (the surface has no write path)', async () => {
  const snapshot = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'metric_observations' AS rel, md5(string_agg(o.observation_id::text, ',' ORDER BY o.observation_id)) AS digest
       FROM metric_observations o WHERE o.client_id = $1
     UNION ALL
     SELECT 'executions', md5(string_agg(e.execution_id::text, ',' ORDER BY e.execution_id))
       FROM executions e WHERE e.client_id = $1
     UNION ALL
     SELECT 'ai_usage_telemetry', md5(string_agg(u.usage_id::text, ',' ORDER BY u.usage_id))
       FROM ai_usage_telemetry u WHERE u.client_id = $1
     UNION ALL
     SELECT 'jobs', md5(string_agg(j.job_id::text, ',' ORDER BY j.job_id))
       FROM jobs j WHERE j.client_id = $1
     UNION ALL
     SELECT 'goals', md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id))
       FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(d.deployment_id::text, ',' ORDER BY d.deployment_id))
       FROM deployments d WHERE d.client_id = $1
     UNION ALL
     SELECT 'integration_connections', md5(string_agg(c.connection_id::text, ',' ORDER BY c.connection_id))
       FROM integration_connections c WHERE c.client_id = $1
     UNION ALL
     SELECT 'human_agents', md5(string_agg(h.agent_id::text, ',' ORDER BY h.agent_id))
       FROM human_agents h`,
    [clientA],
  );
  const before = new Map(snapshot.rows.map((row) => [row.rel, row.digest]));

  // A battery of reads and probes.
  await apiCall(port(), `/api/profit-intelligence/${agencyA}`, { token: ownerA.token });
  await apiCall(port(), `/api/profit-intelligence/${agencyA}/clients/${clientA}`, {
    token: memberA.token,
  });
  await apiCall(port(), `/api/profit-intelligence/${agencyA}/clients/${clientA}/workspaces/${workspaceA1}`, {
    token: ownerA.token,
  });
  await apiCall(port(), `/api/profit-intelligence/${agencyA}`, { token: ownerB.token });
  await apiCall(port(), `/api/profit-intelligence/not-a-uuid`, { token: ownerA.token });
  await apiCall(port(), `/api/profit-intelligence/${agencyA}`, {
    token: ownerA.token,
    method: 'POST',
    body: { clientId: clientB, calculationVersion: 'forged', value: 99999 },
  });
  await apiCall(port(), `/api/profit-intelligence/${agencyA}`, { token: suspendedA.token });

  const after = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'metric_observations' AS rel, md5(string_agg(o.observation_id::text, ',' ORDER BY o.observation_id)) AS digest
       FROM metric_observations o WHERE o.client_id = $1
     UNION ALL
     SELECT 'executions', md5(string_agg(e.execution_id::text, ',' ORDER BY e.execution_id))
       FROM executions e WHERE e.client_id = $1
     UNION ALL
     SELECT 'ai_usage_telemetry', md5(string_agg(u.usage_id::text, ',' ORDER BY u.usage_id))
       FROM ai_usage_telemetry u WHERE u.client_id = $1
     UNION ALL
     SELECT 'jobs', md5(string_agg(j.job_id::text, ',' ORDER BY j.job_id))
       FROM jobs j WHERE j.client_id = $1
     UNION ALL
     SELECT 'goals', md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id))
       FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(d.deployment_id::text, ',' ORDER BY d.deployment_id))
       FROM deployments d WHERE d.client_id = $1
     UNION ALL
     SELECT 'integration_connections', md5(string_agg(c.connection_id::text, ',' ORDER BY c.connection_id))
       FROM integration_connections c WHERE c.client_id = $1
     UNION ALL
     SELECT 'human_agents', md5(string_agg(h.agent_id::text, ',' ORDER BY h.agent_id))
       FROM human_agents h`,
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
    () => theModule().getClientProfitIntelligence({ clientId: randomUUID(), humanAgentUserIds: [] }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 (module level)',
  );
  await assert.rejects(
    () => theModule().getWorkspaceProfitIntelligence({ workspaceId: randomUUID(), humanAgentUserIds: [] }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Workspace identifier is the uniform 404 (module level)',
  );
});
