/**
 * MKT-041 integration test — the Agency Operating Graph (the derived
 * coordination model) against real PostgreSQL + a real API subprocess +
 * the module composed IN-PROCESS through bootstrapApplication() against the
 * SAME database (the MKT-034 sanctioned test-harness wiring — the rebuild
 * is a module-level operation, never an HTTP route).
 *
 * Proofs (spec/operating-graph-v1.5.md; spec/architecture-v1.5.md §3):
 *
 *   - THE GRAPH IS BUILT FROM REAL AUTHORITIES: after the authority surfaces
 *     create the full chain (Goal → Playbook Version → Deployment →
 *     Workflow/Definition/Instance → Execution → Evidence supersession →
 *     Experiment → Learning citations), one rebuild derives the exact
 *     relation set — cross-checked against DIRECT SQL ground truth (every
 *     relation, endpoint, epistemic state and version);
 *   - REBUILD TWICE CONVERGES: the second rebuild against unchanged
 *     authorities appends NOTHING and supersedes NOTHING (converged=true;
 *     the SQL row count is unchanged; the current set is byte-identical);
 *   - LIVE-FOLLOW: authority changes then a rebuild appends the new
 *     relations (a new portfolio goal), and a REDEPLOY retracts the prior
 *     EXACT-VERSION pin while keeping it addressable as history (version
 *     addressing: the deployment pins v1, then v2 — never a floating
 *     latest);
 *   - THE FROZEN VOCABULARY: every rebuild-derived relation is 'observed'
 *     and the five epistemic states stay DISTINCT; the database itself
 *     rejects a non-vocabulary state and a non-vocabulary relation (CHECK
 *     fences);
 *   - THE READ SURFACE (UI posture): the agency rollup + the client detail
 *     present the derived ledger with the honest derivation disclosure;
 *     any ACTIVE member may read;
 *   - THE ISOLATION BATTERY (fail-closed): anonymous calls are 401; a
 *     foreign agency's owner gets the UNIFORM 404 (indistinguishable from
 *     malformed/unknown agency identifiers — no cross-agency existence
 *     oracle); a foreign Client is the same uniform 404; every mutating
 *     verb is 405 at the router (the surface is read-only by
 *     construction); authority-shaped query parameters change nothing;
 *     after every read/probe the authoritative rows are BYTE-IDENTICAL to
 *     the pre-read SQL snapshots (the surface has no write path at all);
 *     the module-level rebuild of an unknown Client is the uniform 404.
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
import type { OperatingGraphModuleApi } from '../../src/modules/operating-graph/public.ts';
import { PgDb } from '../../src/platform/db/adapters/postgres/pg-db.ts';
import { NotFoundError } from '../../src/platform/errors/errors.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;
let operatingGraphModule: OperatingGraphModuleApi | null = null;

/** The in-process module handle (the rebuild is a module-level operation). */
function operatingGraph(): OperatingGraphModuleApi {
  if (operatingGraphModule === null) throw new Error('application not bootstrapped');
  return operatingGraphModule;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
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

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201);
  const userId = create.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
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

// ---------------------------------------------------------------------------
// Seeding helpers over the authorities' own API surfaces
// ---------------------------------------------------------------------------

function goalBody(objective: string, workspaceId: string | null): Record<string, unknown> {
  return {
    objective,
    ...(workspaceId === null ? {} : { workspaceId }),
    successCriteria: [
      {
        metric: 'activation_rate',
        comparator: '>=',
        targetValue: 0.4,
        unit: '%',
        description: 'New accounts activated within 14 days',
      },
    ],
    metrics: [{ name: 'activation_rate', unit: '%', description: 'observed only' }],
    constraints: [{ kind: 'risk', description: 'Email fatigue above 4 touches per fortnight.' }],
    timeHorizon: { startsOn: '2026-04-01', endsOn: '2026-06-30' },
  };
}

async function makeGoal(
  clientId: string,
  token: string,
  objective: string,
  workspaceId: string | null = null,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: goalBody(objective, workspaceId),
  });
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

function minimalWorkflowContent(playbookVersionId: string): Record<string, unknown> {
  return {
    graph: {
      nodes: [functionNode('a'), { ...functionNode('t'), nodeType: 'terminal' }],
      edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
    },
    inputSchema: { ...emptySchema },
    outputSchema: { ...emptySchema },
    playbookVersionId,
  };
}

async function makePlaybookWithVersions(
  clientId: string,
  token: string,
  goalId: string,
): Promise<{ playbookId: string; versionIds: string[] }> {
  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'MKT-041 Launch Playbook', description: 'The operating-graph fixture playbook.', goalId },
  });
  assert.equal(playbook.status, 201, JSON.stringify(playbook.body));
  const playbookId = playbook.body['playbookId'] as string;

  const versionIds: string[] = [];
  for (const [index, summary] of ['v1 strategy', 'v2 strategy'].entries()) {
    const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
      token,
      body: {
        strategy: { summary, templates: [{ name: 'SEO', description: 'Topic clusters' }] },
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
    void index;
    versionIds.push(versionId);
  }
  return { playbookId, versionIds };
}

async function makeWorkflowWithDefinition(
  workspaceId: string,
  token: string,
  playbookVersionId: string,
): Promise<{ workflowId: string; definitionId: string }> {
  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name: 'MKT-041 Launch Workflow', description: 'The operating-graph fixture workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: minimalWorkflowContent(playbookVersionId),
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

async function makeSecondDefinition(
  workflowId: string,
  token: string,
  playbookVersionId: string,
): Promise<string> {
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: minimalWorkflowContent(playbookVersionId),
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

async function makeInstance(
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
  return instance.body['workflowInstanceId'] as string;
}

async function makeExecution(
  workspaceId: string,
  token: string,
  workflowInstanceId: string,
  nodeId: string,
  idempotencyKey: string,
): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      workflowInstanceId,
      nodeId,
      executionKind: 'deterministic',
      runtimeClass: 'pooled-worker',
      idempotencyKey,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return (created.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

async function appendEvidence(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/evidence`, { token, body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

function evidenceBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: 'observation',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-09-15',
    observedAt: '2026-09-15T10:30:00.000Z',
    content: { metric: 'activation_rate', value: 0.42, unit: '%' },
    quality: 'B',
    ...overrides,
  };
}

async function supersedeEvidence(
  evidenceId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await apiCall(port(), `/api/evidence/${evidenceId}/supersede`, { token, body });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['evidenceId'] as string;
}

function experimentBody(hypothesis: string): Record<string, unknown> {
  return {
    hypothesis,
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out.',
    populationUnit: 'New client accounts created after 2026-01-01.',
    treatment: '5-touch onboarding email sequence.',
    comparison: 'Current 3-touch sequence (status quo).',
    assignmentMethod: 'Simple random assignment at account creation, 50/50.',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [{ name: 'unsubscribe_rate', dimensions: {} }],
    analysisMethod: 'Two-proportion z-test.',
    analysisMethodVersion: 'v2',
    expectedDirection: 'increase',
    startCriteria: 'Start once 500 accounts/week enrollment is confirmed.',
    stopCriteria: 'Stop at 2000 accounts per arm or after 6 weeks.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
    uncertaintyRepresentation: 'interval',
  };
}

async function makeConcludedExperiment(clientId: string, token: string): Promise<string> {
  const declared = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: experimentBody('The 5-touch sequence increases activation.'),
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;
  for (const body of [
    { transition: 'mark_ready' },
    { transition: 'start' },
    { transition: 'begin_analysis' },
    {
      transition: 'conclude',
      conclusion: {
        resultState: 'causal_supported',
        uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
        assumptions: ['Stable delivery infrastructure'],
        sampleLimitations: [],
        confounders: [],
        resultingDecision: 'Roll out the 5-touch sequence.',
        evidenceRefs: [],
      },
    },
  ] as ReadonlyArray<Record<string, unknown>>) {
    const applied = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
      token,
      body,
    });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }
  return experimentId;
}

async function makeLearning(
  clientId: string,
  token: string,
  evidenceRefs: string[],
  experimentRefs: string[],
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/learnings`, {
    token,
    body: {
      statement: 'Multi-touch onboarding sequences increase activation for new accounts.',
      applicability: { channel: 'email', cohort: 'new_accounts' },
      evidenceRefs,
      experimentRefs,
      confidence: 0.82,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['learningId'] as string;
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
          reason: 'MKT-041 integration-test platform boundary: explicit allow',
        },
      ],
      description: `MKT-041 integration-test platform default (${dimension})`,
    },
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
}

async function createDeployment(
  token: string,
  workspaceId: string,
  selection: Record<string, unknown>,
): Promise<string> {
  const created = await apiCall(port(), `/api/workspaces/${workspaceId}/deployments`, {
    token,
    body: { selection },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['deploymentId'] as string;
}

async function deploymentAction(
  token: string,
  workspaceId: string,
  deploymentId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(
    port(),
    `/api/workspaces/${workspaceId}/deployments/${deploymentId}/${action}`,
    { token, method: 'POST', body },
  );
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

let ownerA: User;
let memberA: User;
let ownerB: User;
let agencyA = '';
let agencyB = '';
let clientA = '';
let clientA2 = '';
let clientB = '';
let workspaceA = '';
let goalA = '';
let playbookId = '';
let playbookV1 = '';
let playbookV2 = '';
let workflowId = '';
let definitionId = '';
let definitionId2 = '';
let instanceId = '';
let executionId = '';
let evidenceV1 = '';
let evidenceV2 = '';
let experimentId = '';
let learningId = '';
let deploymentId = '';

/** The current relation set of the Client graph, straight from SQL. */
async function currentEdgeRows(): Promise<
  ReadonlyArray<{
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
    relation: string;
    edge_state: string;
    edge_version: number;
  }>
> {
  const result = await db!.query<{
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
    relation: string;
    edge_state: string;
    edge_version: number;
  }>(
    `SELECT from_kind, from_id, to_kind, to_id, relation, edge_state, edge_version
     FROM operating_graph_edges
     WHERE client_id = $1 AND is_current
     ORDER BY from_kind, from_id, relation, to_kind, to_id`,
    [clientA],
  );
  return result.rows;
}

function edgeKeyOf(row: {
  from_kind: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  relation: string;
}): string {
  return `${row.from_kind}:${row.from_id}|${row.relation}|${row.to_kind}:${row.to_id}`;
}

before(async () => {
  stack = await bootStack('opgraph');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034 precedent): the SAME
  // application composed IN-PROCESS against the SAME database the API
  // serves — the rebuild is a module-level operation, never a route.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  operatingGraphModule = core.modules.operatingGraph;

  db = new PgDb(stack.env.databaseUrl, 2);

  // Agency A (the owning agency): owner + an ordinary active member.
  ownerA = await makeUser('oscar@opgraph.test', 'a-very-long-password-123');
  memberA = await makeUser('mia@opgraph.test', 'a-very-long-password-123');
  ownerB = await makeUser('bruno@opgraph.test', 'a-very-long-password-123');
  agencyA = await makeAgency('Operating Graph Agency A', ownerA);
  agencyB = await makeAgency('Operating Graph Agency B', ownerB);
  const membership = await apiCall(port(), `/api/agencies/${agencyA}/memberships`, {
    token: await adminToken(),
    body: { userId: memberA.userId, role: 'client_collaborator' },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));

  clientA = await makeClient(agencyA, 'Graph Client A');
  clientA2 = await makeClient(agencyA, 'Graph Client A2');
  workspaceA = await makeWorkspace(clientA, 'Graph Workspace A');
  clientB = await makeClient(agencyB, 'Graph Client B');
  await makeWorkspace(clientB, 'Graph Workspace B');

  // The fail-closed deployment-dimension policy default for the golden path.
  await declarePlatformPolicy('deployment');

  // The full v1.5 chain on today's authorities.
  goalA = await makeGoal(clientA, ownerA.token, 'Grow activated accounts.');
  const playbookFixture = await makePlaybookWithVersions(clientA, ownerA.token, goalA);
  playbookId = playbookFixture.playbookId;
  playbookV1 = playbookFixture.versionIds[0]!;
  playbookV2 = playbookFixture.versionIds[1]!;
  const workflowFixture = await makeWorkflowWithDefinition(workspaceA, ownerA.token, playbookV1);
  workflowId = workflowFixture.workflowId;
  definitionId = workflowFixture.definitionId;
  // The second definition pins playbook v2 — the redeploy's immutable-version
  // compatibility requirement.
  definitionId2 = await makeSecondDefinition(workflowId, ownerA.token, playbookV2);
  instanceId = await makeInstance(workflowId, definitionId, ownerA.token);
  executionId = await makeExecution(workspaceA, ownerA.token, instanceId, 'a', 'opgraph-exec-1');
  evidenceV1 = await appendEvidence(clientA, ownerA.token, evidenceBody());
  evidenceV2 = await supersedeEvidence(
    evidenceV1,
    ownerA.token,
    evidenceBody({ sourceRef: 'report/2026-09-16' }),
  );
  experimentId = await makeConcludedExperiment(clientA, ownerA.token);
  learningId = await makeLearning(clientA, ownerA.token, [evidenceV1], [experimentId]);
  deploymentId = await createDeployment(ownerA.token, workspaceA, {
    playbookVersionId: playbookV1,
    workflowDefinitionIds: [definitionId],
    requiredDomainPacks: [],
    requiredCapabilities: [],
    runtimeRequirements: { runtimeClass: 'pooled-worker' },
    triggerConfig: [{ kind: 'manual' }],
  });
});

after(async () => {
  await db?.close();
  if (api !== null) api.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// 1. THE GRAPH IS BUILT FROM REAL AUTHORITIES (SQL ground truth)
// ---------------------------------------------------------------------------

test('one rebuild derives the exact relation set — cross-checked against DIRECT SQL ground truth', async () => {
  const report = await operatingGraph().rebuildClientOperatingGraph({ clientId: clientA });
  assert.equal(report.scope.kind, 'client-operating-graph-rebuild');
  assert.equal(report.scope.agencyId, agencyA);
  assert.equal(report.scope.clientId, clientA);
  assert.equal(report.scope.workspaceCount, 1);
  assert.ok(report.edgesDerived > 0, 'the fixture chain derives relations');
  assert.ok(report.edgesAppended === report.edgesDerived, 'the first rebuild appends everything');
  assert.equal(report.edgesSuperseded, 0);
  assert.equal(report.converged, false);
  assert.equal(report.recordedBy, 'operating-graph-rebuild');

  const rows = await currentEdgeRows();
  const keys = new Set(rows.map(edgeKeyOf));

  // THE FULL CHAIN — every relation derived from an authoritative reference.
  const expected: ReadonlyArray<[string, string, string, string]> = [
    [`client:${clientA}`, 'has_goal', 'goal', goalA],
    [`goal:${goalA}`, 'pursued_by_playbook', 'playbook', playbookId],
    [`playbook:${playbookId}`, 'has_version', 'playbook_version', playbookV1],
    [`playbook:${playbookId}`, 'has_version', 'playbook_version', playbookV2],
    [`deployment:${deploymentId}`, 'pins_playbook_version', 'playbook_version', playbookV1],
    [`deployment:${deploymentId}`, 'deploys_definition', 'workflow_definition', definitionId],
    [`workflow:${workflowId}`, 'has_definition', 'workflow_definition', definitionId],
    [`workflow:${workflowId}`, 'has_definition', 'workflow_definition', definitionId2],
    [`workflow_instance:${instanceId}`, 'pins_definition', 'workflow_definition', definitionId],
    [`execution:${executionId}`, 'executes_step', 'workflow_instance', instanceId],
    [`client:${clientA}`, 'runs_execution', 'execution', executionId],
    [`client:${clientA}`, 'has_evidence', 'evidence', evidenceV1],
    [`client:${clientA}`, 'has_evidence', 'evidence', evidenceV2],
    [`evidence:${evidenceV2}`, 'supersedes', 'evidence', evidenceV1],
    [`client:${clientA}`, 'runs_experiment', 'experiment', experimentId],
    [`client:${clientA}`, 'records_learning', 'learning', learningId],
    [`learning:${learningId}`, 'supported_by', 'evidence', evidenceV1],
    [`learning:${learningId}`, 'derived_from', 'experiment', experimentId],
  ];
  for (const [from, relation, toKind, toId] of expected) {
    const key = `${from}|${relation}|${toKind}:${toId}`;
    assert.ok(keys.has(key), `expected relation ${key} in the derived graph`);
  }

  // The registry rows carry ONLY source references (SQL ground truth).
  const nodeRows = await db!.query<{ node_kind: string; node_id: string }>(
    `SELECT node_kind, node_id FROM operating_graph_nodes`,
  );
  const nodeKeys = new Set(nodeRows.rows.map((row) => `${row.node_kind}:${row.node_id}`));
  for (const node of [
    `client:${clientA}`,
    `goal:${goalA}`,
    `playbook:${playbookId}`,
    `playbook_version:${playbookV1}`,
    `playbook_version:${playbookV2}`,
    `deployment:${deploymentId}`,
    `workflow:${workflowId}`,
    `workflow_definition:${definitionId}`,
    `workflow_instance:${instanceId}`,
    `execution:${executionId}`,
    `evidence:${evidenceV1}`,
    `evidence:${evidenceV2}`,
    `experiment:${experimentId}`,
    `learning:${learningId}`,
  ]) {
    assert.ok(nodeKeys.has(node), `expected registry node ${node}`);
  }
  // Every rebuild-derived relation is OBSERVED, version 1, current.
  for (const row of rows) {
    assert.equal(row.edge_state, 'observed', 'rebuild-derived relations are observed');
    assert.equal(row.edge_version, 1);
  }
});

// ---------------------------------------------------------------------------
// 2. REBUILD TWICE CONVERGES
// ---------------------------------------------------------------------------

test('a second rebuild against unchanged authorities appends NOTHING and supersedes NOTHING', async () => {
  const before = await currentEdgeRows();
  const beforeCount = await db!.query<{ count: string }>(
    'SELECT count(*) AS count FROM operating_graph_edges WHERE client_id = $1',
    [clientA],
  );

  const report = await operatingGraph().rebuildClientOperatingGraph({ clientId: clientA });
  assert.equal(report.converged, true, 'the second rebuild converges');
  assert.equal(report.edgesAppended, 0);
  assert.equal(report.edgesSuperseded, 0);
  assert.equal(report.edgesDerived, before.length);
  assert.equal(report.edgesConverged, before.length);
  assert.equal(report.nodesUpserted, report.nodesSeen, 'registry rows refresh in place');

  const after = await currentEdgeRows();
  const afterCount = await db!.query<{ count: string }>(
    'SELECT count(*) AS count FROM operating_graph_edges WHERE client_id = $1',
    [clientA],
  );
  assert.equal(afterCount.rows[0]!.count, beforeCount.rows[0]!.count, 'zero new ledger rows');
  assert.deepEqual(
    after.map(edgeKeyOf),
    before.map(edgeKeyOf),
    'the current relation set is byte-identical',
  );
});

// ---------------------------------------------------------------------------
// 3. THE READ SURFACE (agency rollup + client detail)
// ---------------------------------------------------------------------------

test('the agency rollup + the client detail present the derived ledger with the honest disclosure', async () => {
  const agencyView = await apiCall(port(), `/api/operating-graph/${agencyA}`, {
    token: ownerA.token,
  });
  assert.equal(agencyView.status, 200, JSON.stringify(agencyView.body));
  const scope = agencyView.body['scope'] as Record<string, unknown>;
  assert.equal(scope['kind'], 'agency-operating-graph');
  assert.equal(scope['agencyId'], agencyA);
  assert.equal(scope['clientCount'], 2);
  const perClient = agencyView.body['perClient'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(perClient.length, 2);
  const graphClient = perClient.find((entry) => entry['clientId'] === clientA)!;
  const emptyClient = perClient.find((entry) => entry['clientId'] === clientA2)!;
  assert.ok(graphClient['edgeCount'] as number >= 17, 'the fixture chain is tallied');
  assert.equal(emptyClient['edgeCount'], 0, 'a never-rebuilt client tallies zero');
  const relationCounts = graphClient['relationCounts'] as Record<string, number>;
  assert.equal(relationCounts['has_goal'], 1);
  assert.equal(relationCounts['supersedes'], 1);
  assert.equal(relationCounts['pins_playbook_version'], 1);
  const totals = agencyView.body['totals'] as Record<string, unknown>;
  assert.ok((totals['edgeCount'] as number) >= 17);

  const clientView = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}/clients/${clientA}`,
    { token: ownerA.token },
  );
  assert.equal(clientView.status, 200, JSON.stringify(clientView.body));
  const edges = clientView.body['edges'] as ReadonlyArray<Record<string, unknown>>;
  const pinEdge = edges.find(
    (edge) => edge['relation'] === 'pins_playbook_version' && edge['fromId'] === deploymentId,
  )!;
  // EXACT VERSION ADDRESSING: the pin references the deployment's own pinned
  // version id — never a floating "latest".
  assert.equal(pinEdge['toId'], playbookV1);
  assert.equal((pinEdge['current'] as Record<string, unknown>)['edgeState'], 'observed');
  const derivation = clientView.body['derivation'] as Record<string, unknown>;
  assert.equal(derivation['basis'], 'canonical-authority-records');
  assert.equal(derivation['evidenceWindow'], 'evidence-authority-bounded-newest-first-listing');
  assert.deepEqual(derivation['edgeStates'], ['unknown', 'observed', 'predicted', 'attributed', 'causal']);
  const nodes = clientView.body['nodes'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(nodes.length > 0);
  assert.equal((clientView.body['supersededEdges'] as unknown[]).length, 0, 'nothing superseded yet');

  // Any ACTIVE member of the agency may read (the read posture).
  const memberView = await apiCall(port(), `/api/operating-graph/${agencyA}`, {
    token: memberA.token,
  });
  assert.equal(memberView.status, 200);
});

// ---------------------------------------------------------------------------
// 4. LIVE-FOLLOW — authority changes then rebuild (append + retraction)
// ---------------------------------------------------------------------------

test('live-follow: a new goal appends on the next rebuild; a REDEPLOY retracts the prior EXACT-VERSION pin (history stays addressable)', async () => {
  // --- New portfolio goal → new relation appended. ---
  const goal2 = await makeGoal(clientA, ownerA.token, 'Reduce onboarding time.');
  const followReport = await operatingGraph().rebuildClientOperatingGraph({ clientId: clientA });
  assert.equal(followReport.converged, false);
  assert.ok(followReport.edgesAppended >= 1, 'the new goal appended relations');
  const afterGoal = await currentEdgeRows();
  assert.ok(
    afterGoal.some((row) => row.relation === 'has_goal' && row.to_id === goal2),
    'the new goal relation is live',
  );

  // --- Redeploy the deployment from v1 to v2 (the version-selection
  //     change): the graph must follow the EXACT pin, retracting the prior
  //     relation while keeping it addressable as history. ---
  const validated = await deploymentAction(ownerA.token, workspaceA, deploymentId, 'validate', {
    idempotencyKey: `opgraph-validate-${deploymentId}`,
    expectedVersion: 1,
  });
  assert.equal(validated.status, 200, JSON.stringify(validated.body));
  const activated = await deploymentAction(ownerA.token, workspaceA, deploymentId, 'activate', {
    idempotencyKey: `opgraph-activate-${deploymentId}`,
    expectedVersion: (validated.body['deployment'] as Record<string, unknown>)['version'] as number,
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));
  assert.equal((activated.body['deployment'] as Record<string, unknown>)['status'], 'active');

  const redeployed = await deploymentAction(ownerA.token, workspaceA, deploymentId, 'redeploy', {
    idempotencyKey: `opgraph-redeploy-${deploymentId}`,
    expectedVersion: (activated.body['deployment'] as Record<string, unknown>)['version'] as number,
    newSelection: {
      playbookVersionId: playbookV2,
      workflowDefinitionIds: [definitionId2],
      requiredDomainPacks: [],
      requiredCapabilities: [],
      runtimeRequirements: { runtimeClass: 'pooled-worker' },
      triggerConfig: [{ kind: 'manual' }],
    },
  });
  assert.equal(redeployed.status, 200, JSON.stringify(redeployed.body));
  // The pending selection rides the ledger; the ROW still pins v1 until the
  // completion edge applies it (DEPLOY-AC-06).
  assert.equal(
    (redeployed.body['deployment'] as Record<string, unknown>)['playbookVersionId'],
    playbookV1,
  );

  // ---- The completion edge applies the pending selection.
  const completed = await deploymentAction(ownerA.token, workspaceA, deploymentId, 'activate', {
    idempotencyKey: `opgraph-redeploy-complete-${deploymentId}`,
    expectedVersion: (redeployed.body['deployment'] as Record<string, unknown>)['version'] as number,
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(
    (completed.body['deployment'] as Record<string, unknown>)['playbookVersionId'],
    playbookV2,
    'the authority moved the pin to v2',
  );

  const retraceReport = await operatingGraph().rebuildClientOperatingGraph({ clientId: clientA });
  assert.ok(retraceReport.edgesAppended >= 1, 'the new pin appended a relation');
  assert.ok(retraceReport.edgesSuperseded >= 1, 'the prior pin was superseded (retracted)');

  // SQL ground truth: the v1 pin row stays (addressable, superseded); the
  // v2 pin row is current.
  const pinRows = await db!.query<{
    to_id: string;
    is_current: boolean;
    superseded_at: Date | null;
    edge_version: number;
  }>(
    `SELECT to_id, is_current, superseded_at, edge_version FROM operating_graph_edges
     WHERE client_id = $1 AND relation = 'pins_playbook_version' AND from_id = $2
     ORDER BY edge_version`,
    [clientA, deploymentId],
  );
  assert.equal(pinRows.rows.length, 2, 'both pin versions exist (append-oriented history)');
  assert.equal(pinRows.rows[0]!.to_id, playbookV1);
  assert.equal(pinRows.rows[0]!.is_current, false);
  assert.notEqual(pinRows.rows[0]!.superseded_at, null);
  assert.equal(pinRows.rows[1]!.to_id, playbookV2);
  assert.equal(pinRows.rows[1]!.is_current, true);
  assert.equal(pinRows.rows[1]!.edge_version, 1, 'the new pin is a NEW relation key (exact version addressing)');

  // The view presents the current pin + the superseded relation.
  const clientView = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}/clients/${clientA}`,
    { token: ownerA.token },
  );
  assert.equal(clientView.status, 200);
  const edges = clientView.body['edges'] as ReadonlyArray<Record<string, unknown>>;
  const currentPin = edges.find(
    (edge) => edge['relation'] === 'pins_playbook_version' && edge['fromId'] === deploymentId,
  )!;
  assert.equal(currentPin['toId'], playbookV2, 'the current pin follows the redeploy');
  const superseded = clientView.body['supersededEdges'] as ReadonlyArray<Record<string, unknown>>;
  const retractedPin = superseded.find(
    (edge) => edge['relation'] === 'pins_playbook_version' && edge['fromId'] === deploymentId,
  )!;
  assert.equal(retractedPin['toId'], playbookV1, 'the retracted pin stays addressable as history');

  // And the post-change state is STABLE: another rebuild converges.
  const stable = await operatingGraph().rebuildClientOperatingGraph({ clientId: clientA });
  assert.equal(stable.converged, true, 'the post-redeploy graph is stable');
});

// ---------------------------------------------------------------------------
// 5. THE FROZEN VOCABULARY — DB CHECK fences
// ---------------------------------------------------------------------------

test('the database itself rejects a non-vocabulary epistemic state and a non-vocabulary relation', async () => {
  // Register the endpoints first (the endpoint fence requires known
  // nodes; these already exist from the rebuild — idempotent).
  await db!.query(
    `INSERT INTO operating_graph_nodes (node_kind, node_id, agency_id, client_id, workspace_id)
     VALUES ('client', $1, $2, $1, NULL), ('goal', $3, $2, $1, NULL)
     ON CONFLICT (node_kind, node_id) DO NOTHING`,
    [clientA, agencyA, goalA],
  );
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO operating_graph_edges
           (edge_id, agency_id, client_id, workspace_id, from_kind, from_id, to_kind, to_id,
            relation, edge_state, edge_version, is_current, recorded_at, recorded_by)
         VALUES ($1, $2, $3, NULL, 'client', $3, 'goal', $4, 'has_goal', 'guessed', 1, true, now(), 'fixture-probe')`,
        [randomUUID(), agencyA, clientA, goalA],
      ),
    (error: { code?: string; message?: string }) =>
      (error.code === '23514' || (error.message ?? '').includes('check')) === true,
    'a non-vocabulary epistemic state is CHECK-rejected',
  );
  await assert.rejects(
    () =>
      db!.query(
        `INSERT INTO operating_graph_edges
           (edge_id, agency_id, client_id, workspace_id, from_kind, from_id, to_kind, to_id,
            relation, edge_state, edge_version, is_current, recorded_at, recorded_by)
         VALUES ($1, $2, $3, NULL, 'client', $3, 'goal', $4, 'owns_goal', 'observed', 1, true, now(), 'fixture-probe')`,
        [randomUUID(), agencyA, clientA, goalA],
      ),
    (error: { code?: string; message?: string }) =>
      (error.code === '23514' || (error.message ?? '').includes('check')) === true,
    'a non-vocabulary relation is CHECK-rejected',
  );
});

// ---------------------------------------------------------------------------
// 6. THE ISOLATION BATTERY (fail-closed)
// ---------------------------------------------------------------------------

test('anonymous calls are 401; foreign/malformed/unknown agencies are the uniform 404; mutating verbs are 405', async () => {
  // Anonymous (fail closed at the authenticator).
  const anonymous = await apiCall(port(), `/api/operating-graph/${agencyA}`);
  assert.equal(anonymous.status, 401);

  // A FOREIGN agency's owner probing agency A: the uniform 404 (never a 403
  // that leaks the agency's existence).
  const foreign = await apiCall(port(), `/api/operating-graph/${agencyA}`, {
    token: ownerB.token,
  });
  assert.equal(foreign.status, 404);

  // Malformed and unknown agency identifiers: the SAME 404.
  const malformed = await apiCall(port(), '/api/operating-graph/not-a-uuid', {
    token: ownerA.token,
  });
  assert.equal(malformed.status, 404);
  const unknown = await apiCall(port(), `/api/operating-graph/${randomUUID()}`, {
    token: ownerA.token,
  });
  assert.equal(unknown.status, 404);

  // The client detail of ANOTHER agency's client: the uniform 404 (the path
  // client resolves against the agency's OWN live clients only).
  const foreignClient = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}/clients/${clientB}`,
    { token: ownerA.token },
  );
  assert.equal(foreignClient.status, 404);
  const malformedClient = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}/clients/not-a-uuid`,
    { token: ownerA.token },
  );
  assert.equal(malformedClient.status, 404);
  const unknownClient = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}/clients/${randomUUID()}`,
    { token: ownerA.token },
  );
  assert.equal(unknownClient.status, 404);

  // READ-ONLY BY CONSTRUCTION: every mutating verb is 405 at the router.
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
    for (const path of [`/api/operating-graph/${agencyA}`, `/api/operating-graph/${agencyA}/clients/${clientA}`]) {
      const response = await apiCall(port(), path, { token: ownerA.token, method });
      assert.equal(response.status, 405, `${method} ${path} must be 405`);
    }
  }

  // Authority-shaped query parameters change nothing (byte-identical body
  // except generatedAt which is omitted from the comparison below).
  const plain = await apiCall(port(), `/api/operating-graph/${agencyA}`, {
    token: ownerA.token,
  });
  const polluted = await apiCall(
    port(),
    `/api/operating-graph/${agencyA}?clientId=${clientB}&agencyId=${agencyB}&edgeState=causal`,
    { token: ownerA.token },
  );
  assert.equal(polluted.status, 200);
  const strip = (body: Record<string, unknown>): string => {
    const copy = { ...body } as Record<string, unknown>;
    delete copy['generatedAt'];
    return JSON.stringify(copy);
  };
  assert.equal(strip(polluted.body), strip(plain.body), 'query parameters are never read');
});

test('after every read/probe the authoritative rows are BYTE-IDENTICAL (the surface has no write path)', async () => {
  const snapshot = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'goals' AS rel, md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id)) AS digest FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'workflows', md5(string_agg(w.workflow_id::text, ',' ORDER BY w.workflow_id)) FROM workflows w WHERE w.client_id = $1
     UNION ALL
     SELECT 'executions', md5(string_agg(e.execution_id::text, ',' ORDER BY e.execution_id)) FROM executions e WHERE e.client_id = $1
     UNION ALL
     SELECT 'evidence', md5(string_agg(v.evidence_id::text, ',' ORDER BY v.evidence_id)) FROM evidence v WHERE v.client_id = $1
     UNION ALL
     SELECT 'learnings', md5(string_agg(l.learning_id::text, ',' ORDER BY l.learning_id)) FROM learnings l WHERE l.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(d.deployment_id::text, ',' ORDER BY d.deployment_id)) FROM deployments d WHERE d.client_id = $1`,
    [clientA],
  );
  const before = new Map(snapshot.rows.map((row) => [row.rel, row.digest]));

  // A battery of reads and probes.
  await apiCall(port(), `/api/operating-graph/${agencyA}`, { token: ownerA.token });
  await apiCall(port(), `/api/operating-graph/${agencyA}/clients/${clientA}`, {
    token: memberA.token,
  });
  await apiCall(port(), `/api/operating-graph/${agencyA}`, { token: ownerB.token });
  await apiCall(port(), `/api/operating-graph/not-a-uuid`, { token: ownerA.token });
  await apiCall(port(), `/api/operating-graph/${agencyA}`, {
    token: ownerA.token,
    method: 'POST',
    body: { clientId: clientB, edgeState: 'causal' },
  });

  const after = await db!.query<{ rel: string; digest: string }>(
    `SELECT 'goals' AS rel, md5(string_agg(g.goal_id::text, ',' ORDER BY g.goal_id)) AS digest FROM goals g WHERE g.client_id = $1
     UNION ALL
     SELECT 'workflows', md5(string_agg(w.workflow_id::text, ',' ORDER BY w.workflow_id)) FROM workflows w WHERE w.client_id = $1
     UNION ALL
     SELECT 'executions', md5(string_agg(e.execution_id::text, ',' ORDER BY e.execution_id)) FROM executions e WHERE e.client_id = $1
     UNION ALL
     SELECT 'evidence', md5(string_agg(v.evidence_id::text, ',' ORDER BY v.evidence_id)) FROM evidence v WHERE v.client_id = $1
     UNION ALL
     SELECT 'learnings', md5(string_agg(l.learning_id::text, ',' ORDER BY l.learning_id)) FROM learnings l WHERE l.client_id = $1
     UNION ALL
     SELECT 'deployments', md5(string_agg(d.deployment_id::text, ',' ORDER BY d.deployment_id)) FROM deployments d WHERE d.client_id = $1`,
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

test('the module-level rebuild/read of an unknown Client is the uniform 404 (module level)', async () => {
  await assert.rejects(
    () => operatingGraph().rebuildClientOperatingGraph({ clientId: randomUUID() }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 (module level)',
  );
  await assert.rejects(
    () => operatingGraph().getClientOperatingGraph({ clientId: randomUUID() }),
    (error: unknown) => error instanceof NotFoundError,
    'an unknown Client identifier is the uniform 404 on the read path (module level)',
  );
});
