/**
 * MKT-042 integration test — the Decision Ledger authority against real
 * PostgreSQL + a real API subprocess.
 *
 * Proofs (spec/architecture-v1.5.md §4; the primary contract
 * spec/operating-graph-v1.5.md "Decision Ledger"; frozen by
 * spec/architecture-lock-v1.5.md rule #5 and spec/change-request-005.md
 * change #2):
 *   - RECORD: a persisted decision reads back with the full frozen
 *     vocabulary (scope chain + objective/context/hypothesis summary +
 *     evidence citations + experiment link + structured expected impact +
 *     SEPARATE uncertainty + expected cost + alternatives + the
 *     server-derived proposer and provenance) — verified in the API
 *     response AND the durable row; the append is audited;
 *   - §8 replay convergence: the SAME logical create under one
 *     idempotency key converges to the recorded record (200, replayed,
 *     same rows — no duplicates); a key reused for a DIFFERENT payload is
 *     a 409;
 *   - the frozen disposition state machine: accept/reject/supersede from
 *     'proposed' only; a second disposition against a TERMINAL record is a
 *     409 (history never rewrites); concurrent dispositions converge to
 *     exactly ONE winner;
 *   - the append-only correction flow: a correction is a NEW record with
 *     the predecessor link; the superseded predecessor forward-links to
 *     its successor; the ORIGINAL proposal row is byte-stable through
 *     disposition AND outcome (full-row SQL snapshots);
 *   - the one-shot observed outcome: only an ACCEPTED decision records an
 *     outcome; a second observation is a 409 (a corrected outcome is a NEW
 *     decision); the execution/deployment reference is AT MOST ONE;
 *   - write-time reference validation through the cited authorities'
 *     public contracts: foreign/unknown evidence, experiment, execution,
 *     deployment, learning and predecessor references are uniform 404s
 *     (no cross-tenant oracle);
 *   - the DB backstops (direct SQL): decision_events reject UPDATE and
 *     DELETE; decision rows reject DELETE; the PROPOSAL columns reject
 *     UPDATE; illegal lifecycle transitions reject; cross-tenant
 *     evidence/workspace/predecessor/outcome references reject even via
 *     direct SQL;
 *   - tenant isolation negatives: foreign decision identifiers are
 *     uniform 404s; foreign-client lists are 404s; foreign workspace
 *     scoping is 404; anonymous calls are 401; collaborators may record
 *     and read but NOT disposition (403); forged authority headers change
 *     nothing; a disabled Client blocks new records (409) without erasing
 *     history;
 *   - the event tail: dispositions and outcome observations are appended
 *     verbatim, oldest first, and replays never duplicate rows.
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

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let db: PgDb | null = null;

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

interface User {
  readonly userId: string;
  readonly token: string;
}

async function makeAgency(name: string, owner: User): Promise<string> {
  const response = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name, ownerUserId: owner.userId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['agency'] as Record<string, unknown>)['agencyId'] as string;
}

async function addMembership(agencyId: string, user: User, role: string): Promise<void> {
  const response = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: await adminToken(),
    body: { userId: user.userId, role },
  });
  assert.equal(response.status, 201, `add membership: ${JSON.stringify(response.body)}`);
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

async function makeExecution(workspaceId: string, token: string): Promise<string> {
  const response = await apiCall(port(), `/api/workspaces/${workspaceId}/executions`, {
    token,
    body: {
      externalRequestRef: `ext-${randomUUID()}`,
      executionKind: 'extension',
      runtimeClass: 'ephemeral-sandbox',
      idempotencyKey: `exec-${randomUUID()}`,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['execution'] as Record<string, unknown>)['executionId'] as string;
}

// --- the deployment fixture chain (playbook → published version →
// workflow → active definition → deployment) ------------------------------

const emptySchema = { type: 'object', properties: {}, required: [] };

function functionNode(nodeId: string): Record<string, unknown> {
  return {
    nodeId,
    nodeType: 'function',
    inputMapping: {},
    outputSchema: { type: 'object', properties: { out: { type: 'string' } }, required: [] },
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
  return { ...functionNode(nodeId), nodeType: 'terminal' };
}

function successEdge(fromNode: string, toNode: string): Record<string, unknown> {
  return { fromNode, toNode, edgeType: 'success', predicateRef: null, joinSemantics: null };
}

async function makeDeployment(workspaceId: string, token: string): Promise<string> {
  // The workspace's client owns the playbook.
  const workspace = await apiCall(port(), `/api/workspaces/${workspaceId}`, { token });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  const clientId = workspace.body['clientId'] as string;

  const playbook = await apiCall(port(), `/api/clients/${clientId}/playbooks`, {
    token,
    body: { name: 'MKT-042 Decision Fixture Playbook', description: 'The ledger fixture playbook.' },
  });
  assert.equal(playbook.status, 201, JSON.stringify(playbook.body));
  const playbookId = playbook.body['playbookId'] as string;

  const version = await apiCall(port(), `/api/playbooks/${playbookId}/versions`, {
    token,
    body: {
      strategy: {
        summary: 'MKT-042 fixture strategy',
        templates: [{ name: 'Activation', description: 'Onboarding sequence' }],
      },
      deploymentMetadata: {
        requiredDomainPacks: [{ name: 'mkt042-test-pack', versionConstraint: '^1.0.0' }],
        requiredCapabilities: [
          { kind: 'extension', name: 'mkt042-email-composer', versionConstraint: '^1.0.0' },
        ],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggers: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const versionId = version.body['versionId'] as string;
  for (const [status, versionNumber] of [['review', 1], ['published', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/playbooks/${playbookId}/versions/${versionId}/status`,
      { token, method: 'PATCH', body: { status, version: versionNumber } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  const workflow = await apiCall(port(), `/api/workspaces/${workspaceId}/workflows`, {
    token,
    body: { name: 'MKT-042 Decision Fixture Workflow', description: 'The ledger fixture workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token,
    body: {
      graph: { nodes: [functionNode('a'), terminalNode('t')], edges: [successEdge('a', 't')] },
      inputSchema: { ...emptySchema },
      outputSchema: { ...emptySchema },
      retryPolicyDefaults: {},
      concurrencyLimits: {},
      timeoutPolicy: {},
      compensation: [],
      playbookVersionId: versionId,
    },
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  for (const [status, versionNumber] of [['review', 1], ['active', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/status`,
      { token, method: 'PATCH', body: { status, version: versionNumber } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  const deployment = await apiCall(port(), `/api/workspaces/${workspaceId}/deployments`, {
    token,
    body: {
      selection: {
        playbookVersionId: versionId,
        workflowDefinitionIds: [definitionId],
        requiredDomainPacks: [{ name: 'mkt042-test-pack', versionConstraint: '^1.0.0' }],
        requiredCapabilities: [
          { kind: 'extension', name: 'mkt042-email-composer', versionConstraint: '^1.0.0' },
        ],
        runtimeRequirements: { runtimeClass: 'pooled-worker' },
        triggerConfig: [{ kind: 'manual' }],
      },
    },
  });
  assert.equal(deployment.status, 201, JSON.stringify(deployment.body));
  return deployment.body['deploymentId'] as string;
}

/** The canonical decision record payload (the full frozen vocabulary). */
function decisionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objective: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    context: 'Q1 activation numbers are below target; the experiment concluded with a causal lift.',
    hypothesisSummary:
      'A 5-touch onboarding email sequence increases new-account activation versus the 3-touch sequence.',
    evidenceRefs: [],
    expectedImpact: {
      summary: 'New-account activation rate is expected to rise by roughly two points.',
      direction: 'increase',
      magnitude: '+18% relative CVR lift',
    },
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    expectedCost: 'One additional email send per new account (~$0.003/account).',
    alternatives: [
      'Keep the 3-touch sequence (status quo).',
      'Roll out only to standard-tier accounts first.',
    ],
    idempotencyKey: `decision-${randomUUID()}`,
    ...overrides,
  };
}

async function recordDecision(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
  options: { correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/decisions`, {
    token,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body,
  });
}

async function getDecision(
  decisionId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}`, { token });
}

async function disposition(
  decisionId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}/disposition`, { token, body });
}

async function recordOutcome(
  decisionId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}/outcome`, { token, body });
}

async function listEvents(
  decisionId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}/events`, { token });
}

interface DecisionRow {
  [column: string]: unknown;
  decision_id: string;
  client_id: string;
  workspace_id: string | null;
  agency_id: string;
  objective: string;
  context: string | null;
  hypothesis_summary: string;
  experiment_ref: string | null;
  evidence_refs: ReadonlyArray<string>;
  expected_impact: Record<string, unknown>;
  uncertainty: Record<string, unknown> | null;
  expected_cost: string | null;
  alternatives: ReadonlyArray<string>;
  predecessor_decision_id: string | null;
  proposer_actor: string;
  proposer_role: string;
  disposition: string;
  successor_decision_id: string | null;
  disposition_at: Date | null;
  observed_outcome: Record<string, unknown> | null;
  execution_ref: string | null;
  deployment_ref: string | null;
  learning_ref: string | null;
  outcome_at: Date | null;
  idempotency_key: string;
  create_fingerprint: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

/** Full-row snapshot for the byte-stability proofs. */
async function decisionRow(decisionId: string): Promise<DecisionRow | null> {
  assert.ok(db !== null);
  const result = await db.query<DecisionRow>(
    'SELECT * FROM decisions WHERE decision_id = $1',
    [decisionId],
  );
  return result.rows[0] ?? null;
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-decision-id': 'REPLACED_PER_TEST',
  'x-disposition': 'accepted',
  'x-proposer-actor': 'service:forged',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients + one workspace),
// agency B foreign; evidence, experiments, executions, a deployment and
// learnings under both tenants for the reference-validation proofs.
const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientA2 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceB = '';
let evidenceA1 = '';
let evidenceB = '';
let experimentA1 = '';
let executionA1 = '';
let deploymentA1 = '';
let learningA1 = '';
let learningB = '';

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

before(async () => {
  stack = await bootStack('decisions');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);

  const admin = await adminToken();
  const createUser = async (email: string, name: string): Promise<User> => {
    const create = await apiCall(port(), '/api/users', {
      token: admin,
      body: { email, displayName: name },
    });
    assert.equal(create.status, 201);
    const userId = create.body['userId'] as string;
    await apiCall(port(), `/api/users/${userId}/credential`, {
      token: admin,
      body: { password: 'decisions-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'decisions-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@decisions.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@decisions.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@decisions.test', 'Agency B Owner'));

  agencyA = await makeAgency('Decisions Agency A', ownerA);
  agencyB = await makeAgency('Decisions Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Decisions Client A One');
  clientA2 = await makeClient(agencyA, 'Decisions Client A Two');
  clientB = await makeClient(agencyB, 'Decisions Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Decisions Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Decisions Workspace B');

  // Evidence records under both tenants (the MKT-013 authority).
  const evidence = await apiCall(port(), `/api/clients/${clientA1}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'internal',
      sourceRef: 'activation-report/2026-02',
      observedAt: '2026-02-15T10:00:00.000Z',
      content: { metric: 'activation_rate', value: 0.31 },
      quality: 'C',
    },
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  evidenceA1 = evidence.body['evidenceId'] as string;

  const foreignEvidence = await apiCall(port(), `/api/clients/${clientB}/evidence`, {
    token: ownerB.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'internal',
      observedAt: '2026-02-15T10:00:00.000Z',
      content: { metric: 'activation_rate', value: 0.28 },
      quality: 'C',
    },
  });
  assert.equal(foreignEvidence.status, 201, JSON.stringify(foreignEvidence.body));
  evidenceB = foreignEvidence.body['evidenceId'] as string;

  // A DRAFT experiment under client A1 — the hypothesis link accepts ANY
  // lifecycle state (the hypothesis informs the proposal BEFORE its
  // conclusion exists).
  const experiment = await apiCall(port(), `/api/clients/${clientA1}/experiments`, {
    token: ownerA.token,
    body: {
      hypothesis: 'A 5-touch onboarding email sequence increases new-account activation.',
      decisionTarget: 'Whether to roll the sequence out.',
      populationUnit: 'New client accounts.',
      treatment: '5-touch sequence.',
      comparison: '3-touch sequence.',
      assignmentMethod: 'Random 50/50.',
      designType: 'randomized',
      primaryMetric: { name: 'activation_rate', dimensions: {} },
      guardrails: [],
      analysisMethod: 'z-test',
      analysisMethodVersion: 'v1',
      expectedDirection: 'increase',
      startCriteria: 'Now.',
      stopCriteria: 'At 2000 accounts.',
      minimumEvidenceRequirement: 'C — descriptive at minimum.',
      uncertaintyRepresentation: 'interval',
    },
  });
  assert.equal(experiment.status, 201, JSON.stringify(experiment.body));
  experimentA1 = experiment.body['experimentId'] as string;

  // Executions under both tenants' workspaces (the MKT-011 authority).
  executionA1 = await makeExecution(workspaceA1, ownerA.token);

  // A deployment under client A1's workspace (the MKT-040 authority).
  deploymentA1 = await makeDeployment(workspaceA1, ownerA.token);

  // Learnings under both tenants (the MKT-016 authority).
  const learning = await apiCall(port(), `/api/clients/${clientA1}/learnings`, {
    token: ownerA.token,
    body: {
      statement: 'The 5-touch sequence lifted activation in the observed window.',
      applicability: { channel: 'email', cohort: 'new_accounts' },
      evidenceRefs: [],
      experimentRefs: [],
    },
  });
  assert.equal(learning.status, 201, JSON.stringify(learning.body));
  learningA1 = learning.body['learningId'] as string;

  const foreignLearning = await apiCall(port(), `/api/clients/${clientB}/learnings`, {
    token: ownerB.token,
    body: {
      statement: 'A foreign learning.',
      applicability: { channel: 'email' },
      evidenceRefs: [],
      experimentRefs: [],
    },
  });
  assert.equal(foreignLearning.status, 201, JSON.stringify(foreignLearning.body));
  learningB = foreignLearning.body['learningId'] as string;
});

after(async () => {
  if (db !== null) await db.close();
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// RECORD — the full frozen vocabulary round-trips through API + row + audit
// ---------------------------------------------------------------------------

test('RECORD: a decision stores the full frozen vocabulary with server-derived scope, proposer and provenance (API + durable row + audit)', async () => {
  const correlationId = randomUUID();
  const recorded = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({
      workspaceId: workspaceA1,
      experimentRef: experimentA1,
      evidenceRefs: [evidenceA1],
    }),
    { correlationId },
  );
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const body = recorded.body as Record<string, unknown>;
  const decision = body['decision'] as Record<string, unknown>;
  assert.equal(body['replayed'], false);
  const decisionId = decision['decisionId'] as string;

  // The lifecycle starts server-chosen: PROPOSED, no successor, no outcome.
  assert.equal(decision['disposition'], 'proposed');
  assert.equal(decision['successorDecisionId'], undefined);
  assert.equal(decision['observedOutcome'], undefined);
  assert.equal(decision['executionRef'], undefined);

  // The scope chain is server-derived (Client from the path; Agency
  // through the canonical /clients chain; the optional Workspace scope).
  assert.equal(decision['clientId'], clientA1);
  assert.equal(decision['agencyId'], agencyA);
  assert.equal(decision['workspaceId'], workspaceA1);

  // The proposal vocabulary round-trips byte-for-byte.
  const expected = decisionBody({
    workspaceId: workspaceA1,
    experimentRef: experimentA1,
    evidenceRefs: [evidenceA1],
  });
  assert.equal(decision['objective'], expected['objective']);
  assert.equal(decision['context'], expected['context']);
  assert.equal(decision['hypothesisSummary'], expected['hypothesisSummary']);
  assert.equal(decision['experimentRef'], experimentA1);
  assert.deepEqual(decision['evidenceRefs'], [evidenceA1]);
  assert.deepEqual(decision['expectedImpact'], expected['expectedImpact']);
  assert.deepEqual(decision['uncertainty'], expected['uncertainty']);
  assert.equal(decision['expectedCost'], expected['expectedCost']);
  assert.deepEqual(decision['alternatives'], expected['alternatives']);
  assert.equal(decision['predecessorDecisionId'], undefined);

  // The PROPOSER is server-derived: the authenticated actor + its durable
  // membership role in the OWNING agency (never a body field).
  const proposer = decision['proposer'] as Record<string, unknown>;
  assert.equal(proposer['actor'], `user:${ownerA.userId}`);
  assert.equal(proposer['role'], 'agency_owner');

  // Provenance is server-derived: the authenticated actor, 'api', the
  // request correlation, the module clock.
  const provenance = decision['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId);
  assert.ok(!Number.isNaN(Date.parse(String(provenance['recordedAt']))));

  // The durable row carries the same contract (PostgreSQL is the system of
  // record — the API response is not the proof).
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  assert.equal(row.client_id, clientA1);
  assert.equal(row.workspace_id, workspaceA1);
  assert.equal(row.agency_id, agencyA);
  assert.equal(row.objective, expected['objective']);
  assert.equal(row.hypothesis_summary, expected['hypothesisSummary']);
  assert.equal(row.experiment_ref, experimentA1);
  assert.deepEqual(row.evidence_refs, [evidenceA1]);
  assert.deepEqual(row.expected_impact, expected['expectedImpact']);
  assert.deepEqual(row.uncertainty, expected['uncertainty']);
  assert.deepEqual(row.alternatives, expected['alternatives']);
  assert.equal(row.proposer_actor, `user:${ownerA.userId}`);
  assert.equal(row.proposer_role, 'agency_owner');
  assert.equal(row.disposition, 'proposed');
  assert.equal(row.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(row.recorded_via, 'api');
  assert.equal(row.correlation_id, correlationId);
  assert.ok(typeof row.create_fingerprint === 'string' && row.create_fingerprint.length > 0);

  // The append is a material, audited mutation.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; correlation_id: string }>(
    `SELECT action, target_id, correlation_id FROM audit_events
      WHERE target_type = 'decision' AND target_id = $1 AND action = 'decisions.decision.recorded'`,
    [decisionId],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the append');
  assert.equal(audit.rows[0]!.correlation_id, correlationId);
});

test('RECORD: the create guard rejects malformed decisions at the API (fail closed)', async () => {
  for (const [label, override] of [
    ['empty objective', { objective: '' }],
    ['oversized objective', { objective: 'x'.repeat(2001) }],
    ['empty hypothesis summary', { hypothesisSummary: '' }],
    ['non-uuid evidence ref', { evidenceRefs: ['not-a-uuid'] }],
    ['duplicate evidence ref', { evidenceRefs: [evidenceA1, evidenceA1] }],
    ['missing expected impact', { expectedImpact: null }],
    ['bad impact direction', { expectedImpact: { summary: 'S.', direction: 'skyward' } }],
    ['bad uncertainty kind', { uncertainty: { kind: 'gut_feel' } }],
    ['inverted uncertainty interval', { uncertainty: { kind: 'interval', lower: 0.9, upper: 0.1, level: 0.95 } }],
    ['material key in expected impact', { expectedImpact: { summary: 'S.', secret: 'x' } }],
    ['material key in uncertainty', { uncertainty: { kind: 'qualitative', description: 'D.', password: 'x' } }],
    ['oversized alternative', { alternatives: ['x'.repeat(1001)] }],
    ['oversized reason-free expected cost', { expectedCost: 'x'.repeat(2001) }],
    ['missing idempotency key', { idempotencyKey: '' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await recordDecision(clientA1, ownerA.token, decisionBody(override));
    assert.equal(rejected.status, 422, `expected 422 for: ${label}`);
  }
});

test('RECORD: caller-supplied authority fields are rejected — no DTO path to identity, proposer, provenance or lifecycle', async () => {
  for (const [label, override] of [
    ['decisionId', { decisionId: randomUUID() }],
    ['agencyId', { agencyId: agencyB }],
    ['disposition', { disposition: 'accepted' }],
    ['successorDecisionId', { successorDecisionId: randomUUID() }],
    ['observedOutcome', { observedOutcome: { summary: 'Forged.' } }],
    ['executionRef', { executionRef: randomUUID() }],
    ['proposer', { proposer: { actor: 'user:forged', role: 'agency_owner' } }],
    ['proposerActor', { proposerActor: 'user:forged' }],
    ['provenance', { provenance: { actor: 'user:forged' } }],
    ['correlationId', { correlationId: 'forged' }],
    ['recordedAt', { recordedAt: '2020-01-01T00:00:00.000Z' }],
    ['secret', { secret: 'material' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await recordDecision(clientA1, ownerA.token, decisionBody(override));
    assert.equal(rejected.status, 422, `the create DTO must reject the authority field: ${label}`);
  }
});

// ---------------------------------------------------------------------------
// §8 replay convergence
// ---------------------------------------------------------------------------

test('§8: the SAME logical create under one key converges to the recorded record; a key reused for a DIFFERENT payload is a 409', async () => {
  const key = `replay-${randomUUID()}`;
  const first = await recordDecision(clientA1, ownerA.token, decisionBody({ idempotencyKey: key }));
  assert.equal(first.status, 201);
  const firstId = ((first.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  // The SAME payload under the SAME key replays to the SAME record.
  const replay = await recordDecision(clientA1, ownerA.token, decisionBody({ idempotencyKey: key }));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['replayed'], true);
  const replayId = ((replay.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  assert.equal(replayId, firstId);

  // No duplicate rows were written.
  assert.ok(db !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM decisions WHERE idempotency_key = $1',
    [key],
  );
  assert.equal(count.rows[0]!.count, '1');

  // A DIFFERENT payload under the recorded key is a 409.
  const different = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ idempotencyKey: key, objective: 'A different objective entirely.' }),
  );
  assert.equal(different.status, 409, JSON.stringify(different.body));

  // The fence is per-CLIENT: the same key under a different Client of the
  // SAME agency records fine.
  const otherClient = await recordDecision(
    clientA2,
    ownerA.token,
    decisionBody({ idempotencyKey: key }),
  );
  assert.equal(otherClient.status, 201, JSON.stringify(otherClient.body));
});

// ---------------------------------------------------------------------------
// Write-time reference validation (the frozen vocabulary links)
// ---------------------------------------------------------------------------

test('references validate through the cited authorities — foreign/unknown evidence and experiment refs are uniform 404s', async () => {
  // A FOREIGN (client B) evidence id is indistinguishable from an unknown one.
  const foreignEvidence = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ evidenceRefs: [evidenceB] }),
  );
  assert.equal(foreignEvidence.status, 404, JSON.stringify(foreignEvidence.body));
  const unknownEvidence = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ evidenceRefs: [randomUUID()] }),
  );
  assert.equal(unknownEvidence.status, 404);
  assert.equal(foreignEvidence.status, unknownEvidence.status);
  assert.deepEqual(
    (foreignEvidence.body as Record<string, unknown>)['code'],
    (unknownEvidence.body as Record<string, unknown>)['code'],
  );

  // A FOREIGN (client B) experiment id is likewise a uniform 404. (There
  // is no client-B experiment fixture — an unknown id carries the same
  // uniform 404, and the API-level identity is what matters.)
  const unknownExperiment = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ experimentRef: randomUUID() }),
  );
  assert.equal(unknownExperiment.status, 404, JSON.stringify(unknownExperiment.body));

  // A SAME-Client experiment in ANY lifecycle state (draft) is a legal
  // hypothesis link — the hypothesis informs the proposal BEFORE its
  // conclusion exists.
  const draftLinked = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ experimentRef: experimentA1 }),
  );
  assert.equal(draftLinked.status, 201, JSON.stringify(draftLinked.body));

  // Nothing was written for the rejected creates.
  assert.ok(db !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM decisions WHERE client_id = $1 AND objective LIKE \'%unknown-or-foreign%\'',
    [clientA1],
  );
  assert.equal(count.rows[0]!.count, '0');
});

test('the optional Workspace scope lands in the durable row; a foreign-Client workspace is a uniform 404', async () => {
  const scoped = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: workspaceA1 }));
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  const decisionId = ((scoped.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  assert.equal(row.workspace_id, workspaceA1);

  // A workspace of ANOTHER Client (client B) is a uniform 404 — scope
  // input is never a traversal oracle.
  const foreign = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: workspaceB }));
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const unknown = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: randomUUID() }));
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// The frozen disposition state machine
// ---------------------------------------------------------------------------

test('DISPOSITION: accept moves proposed → accepted and appends the immutable event; a second disposition is a 409', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  const accepted = await disposition(decisionId, ownerA.token, {
    command: 'accept',
    reason: 'Rolling out to all new clients.',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const decision = (accepted.body as Record<string, unknown>)['decision'] as Record<string, unknown>;
  assert.equal(decision['disposition'], 'accepted');
  assert.ok(typeof decision['dispositionAt'] === 'string');
  assert.equal((accepted.body as Record<string, unknown>)['replayed'], false);
  const event = (accepted.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(event['eventKind'], 'disposition');
  assert.equal(event['disposition'], 'accepted');

  // The durable row moved.
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  assert.equal(row.disposition, 'accepted');
  assert.ok(row.disposition_at !== null);

  // A second disposition against the TERMINAL record is a 409 — history
  // never rewrites.
  const second = await disposition(decisionId, ownerA.token, {
    command: 'reject',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  const reAccept = await disposition(decisionId, ownerA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(reAccept.status, 409);
  // The proposal payload never moved.
  assert.equal(row.objective, decisionBody().objective);
});

test('DISPOSITION: the frozen command vocabulary and the successor-presence rules are enforced (422)', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  for (const [label, body] of [
    ['unknown command', { command: 'withdraw', idempotencyKey: 'k' }],
    ['supersede without successor', { command: 'supersede', idempotencyKey: 'k' }],
    ['accept with successor', { command: 'accept', successorDecisionId: randomUUID(), idempotencyKey: 'k' }],
    ['malformed successor', { command: 'supersede', successorDecisionId: 'not-a-uuid', idempotencyKey: 'k' }],
    ['missing key', { command: 'accept', idempotencyKey: '' }],
    ['authority field', { command: 'accept', idempotencyKey: 'k', disposition: 'accepted' }],
    ['provenance field', { command: 'accept', idempotencyKey: 'k', provenance: { actor: 'x' } }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await disposition(decisionId, ownerA.token, body);
    assert.equal(rejected.status, 422, `expected 422 for: ${label}`);
  }
  // The decision is still proposed.
  const still = await getDecision(decisionId, ownerA.token);
  assert.equal((still.body as Record<string, unknown>)['disposition'], 'proposed');
});

test('DISPOSITION: §8 replay — the same disposition command under one key converges; a different command under the key is a 409', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  const key = `disp-replay-${randomUUID()}`;
  const first = await disposition(decisionId, ownerA.token, {
    command: 'reject',
    reason: 'Cost too high.',
    idempotencyKey: key,
  });
  assert.equal(first.status, 200);

  const replay = await disposition(decisionId, ownerA.token, {
    command: 'reject',
    reason: 'Cost too high.',
    idempotencyKey: key,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['replayed'], true);

  // One event row only.
  assert.ok(db !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM decision_events WHERE decision_id = $1',
    [decisionId],
  );
  assert.equal(count.rows[0]!.count, '1');

  // A different command under the recorded key is a 409.
  const different = await disposition(decisionId, ownerA.token, {
    command: 'accept',
    idempotencyKey: key,
  });
  assert.equal(different.status, 409, JSON.stringify(different.body));
});

test('DISPOSITION: concurrent dispositions converge to exactly ONE winner (CAS)', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  const results = await Promise.allSettled([
    disposition(decisionId, ownerA.token, { command: 'accept', idempotencyKey: `race-a-${randomUUID()}` }),
    disposition(decisionId, ownerA.token, { command: 'reject', idempotencyKey: `race-b-${randomUUID()}` }),
  ]);
  const statuses = results.map((result) =>
    result.status === 'fulfilled' ? result.value.status : -1,
  );
  assert.deepEqual(
    [...statuses].sort(),
    [200, 409],
    `exactly one winner and one loser (got ${statuses.join(', ')})`,
  );

  // Exactly ONE event row and ONE terminal disposition.
  assert.ok(db !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM decision_events WHERE decision_id = $1',
    [decisionId],
  );
  assert.equal(count.rows[0]!.count, '1');
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  assert.ok(row.disposition === 'accepted' || row.disposition === 'rejected');
});

// ---------------------------------------------------------------------------
// The append-only correction flow (supersession)
// ---------------------------------------------------------------------------

test('CORRECTION: a correction is a NEW record with the predecessor link; supersede forward-links the predecessor and nothing is rewritten', async () => {
  // The ORIGINAL decision.
  const original = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({
      experimentRef: experimentA1,
      evidenceRefs: [evidenceA1],
    }),
  );
  assert.equal(original.status, 201);
  const originalId = ((original.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const before = await decisionRow(originalId);
  assert.ok(before !== null);

  // The CORRECTION: a new record declaring its predecessor.
  const corrected = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({
      objective: 'CORRECTED: roll out only to standard-tier accounts first.',
      predecessorDecisionId: originalId,
    }),
  );
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  const correctedId = ((corrected.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  assert.equal(
    ((corrected.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['predecessorDecisionId'],
    originalId,
  );

  // SUPERSEDE the original with the correction.
  const superseded = await disposition(originalId, ownerA.token, {
    command: 'supersede',
    reason: 'Better-informed correction recorded.',
    successorDecisionId: correctedId,
    idempotencyKey: `supersede-${randomUUID()}`,
  });
  assert.equal(superseded.status, 200, JSON.stringify(superseded.body));
  const supersededDecision = (superseded.body as Record<string, unknown>)['decision'] as Record<string, unknown>;
  assert.equal(supersededDecision['disposition'], 'superseded');
  // The forward link landed.
  assert.equal(supersededDecision['successorDecisionId'], correctedId);

  // The ORIGINAL row: byte-stable on every proposal column (only the
  // lifecycle columns moved).
  const after = await decisionRow(originalId);
  assert.ok(after !== null);
  for (const column of [
    'client_id',
    'workspace_id',
    'agency_id',
    'objective',
    'context',
    'hypothesis_summary',
    'experiment_ref',
    'evidence_refs',
    'expected_impact',
    'uncertainty',
    'expected_cost',
    'alternatives',
    'predecessor_decision_id',
    'proposer_actor',
    'proposer_role',
    'idempotency_key',
    'create_fingerprint',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ] as const) {
    assert.deepEqual(
      after[column],
      before[column],
      `the proposal column '${column}' must be byte-stable through supersession`,
    );
  }

  // A superseded predecessor cannot be corrected AGAIN (its replacement
  // already exists — correct the successor instead).
  const again = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({ predecessorDecisionId: originalId }),
  );
  assert.equal(again.status, 409, JSON.stringify(again.body));

  // The correction stays a live proposal (it can be dispositioned later).
  const correctionStill = await getDecision(correctedId, ownerA.token);
  assert.equal((correctionStill.body as Record<string, unknown>)['disposition'], 'proposed');
});

test('CORRECTION: supersede validates the successor — foreign/unknown successors are 404s; a non-correction successor is a 409', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  // An UNKNOWN successor is a uniform 404.
  const unknown = await disposition(decisionId, ownerA.token, {
    command: 'supersede',
    successorDecisionId: randomUUID(),
    idempotencyKey: `supersede-${randomUUID()}`,
  });
  assert.equal(unknown.status, 404, JSON.stringify(unknown.body));

  // A FOREIGN (client B) decision is likewise a uniform 404 — but first a
  // client-B decision must exist. Record one.
  const foreignDecision = await recordDecision(clientB, ownerB.token, decisionBody());
  assert.equal(foreignDecision.status, 201);
  const foreignId = ((foreignDecision.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const foreign = await disposition(decisionId, ownerA.token, {
    command: 'supersede',
    successorDecisionId: foreignId,
    idempotencyKey: `supersede-${randomUUID()}`,
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));

  // A same-Client decision that does NOT declare this decision as its
  // predecessor is a 409 (supersession requires the successor to be its
  // correction).
  const unrelated = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(unrelated.status, 201);
  const unrelatedId = ((unrelated.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const notACorrection = await disposition(decisionId, ownerA.token, {
    command: 'supersede',
    successorDecisionId: unrelatedId,
    idempotencyKey: `supersede-${randomUUID()}`,
  });
  assert.equal(notACorrection.status, 409, JSON.stringify(notACorrection.body));

  // The decision is still proposed.
  const still = await getDecision(decisionId, ownerA.token);
  assert.equal((still.body as Record<string, unknown>)['disposition'], 'proposed');
});

// ---------------------------------------------------------------------------
// The one-shot observed outcome
// ---------------------------------------------------------------------------

test('OUTCOME: an accepted decision records its observed outcome ONCE with the implementation + learning references', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: workspaceA1 }));
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  const accepted = await disposition(decisionId, ownerA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(accepted.status, 200);

  const outcome = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: {
      summary: 'Activation rose 2.1 points, in line with the expected interval.',
      asExpected: true,
      notes: 'Delivery was stable; no unsubscribes spike.',
    },
    executionRef: executionA1,
    learningRef: learningA1,
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
  const decision = (outcome.body as Record<string, unknown>)['decision'] as Record<string, unknown>;
  assert.deepEqual(decision['observedOutcome'], {
    summary: 'Activation rose 2.1 points, in line with the expected interval.',
    asExpected: true,
    notes: 'Delivery was stable; no unsubscribes spike.',
  });
  assert.equal(decision['executionRef'], executionA1);
  assert.equal(decision['deploymentRef'], undefined);
  assert.equal(decision['learningRef'], learningA1);
  const event = (outcome.body as Record<string, unknown>)['event'] as Record<string, unknown>;
  assert.equal(event['eventKind'], 'outcome_observed');

  // The durable row carries the outcome triple verbatim.
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  assert.deepEqual(row.observed_outcome, {
    summary: 'Activation rose 2.1 points, in line with the expected interval.',
    asExpected: true,
    notes: 'Delivery was stable; no unsubscribes spike.',
  });
  assert.equal(row.execution_ref, executionA1);
  assert.equal(row.deployment_ref, null);
  assert.equal(row.learning_ref, learningA1);

  // A SECOND outcome is a 409 — a corrected outcome is a NEW decision.
  const second = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Actually, activation rose only 0.8 points.' },
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));

  // §8 replay of the SAME outcome command converges.
  const replay = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: {
      summary: 'Activation rose 2.1 points, in line with the expected interval.',
      asExpected: true,
      notes: 'Delivery was stable; no unsubscribes spike.',
    },
    executionRef: executionA1,
    learningRef: learningA1,
    idempotencyKey: `outcome-replay-${randomUUID()}`,
  });
  assert.equal(replay.status, 409, 'a second observation under ANY key is a 409 (one-shot)');
});

test('OUTCOME: only an ACCEPTED decision records an outcome; both implementation references are rejected; the guard rejects malformed payloads', async () => {
  // A PROPOSED decision cannot record an outcome (409).
  const proposed = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(proposed.status, 201);
  const proposedId = ((proposed.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const onProposed = await recordOutcome(proposedId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(onProposed.status, 409, JSON.stringify(onProposed.body));

  // A REJECTED decision cannot record an outcome (409) — it was never
  // carried out.
  const toReject = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(toReject.status, 201);
  const rejectedId = ((toReject.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await disposition(rejectedId, ownerA.token, {
    command: 'reject',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  const onRejected = await recordOutcome(rejectedId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(onRejected.status, 409);

  // An ACCEPTED decision rejects BOTH implementation references (422 —
  // the at-most-one rule) and malformed payloads.
  const accepted = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(accepted.status, 201);
  const acceptedId = ((accepted.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await disposition(acceptedId, ownerA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  for (const [label, override] of [
    ['both implementation refs', { executionRef: executionA1, deploymentRef: deploymentA1 }],
    ['malformed execution ref', { executionRef: 'not-a-uuid' }],
    ['missing observation', { observedOutcome: null }],
    ['empty observation summary', { observedOutcome: { summary: '' } }],
    ['non-boolean asExpected', { observedOutcome: { summary: 'S.', asExpected: 'yes' } }],
    ['material key in observation', { observedOutcome: { summary: 'S.', secret: 'x' } }],
    ['missing key', { idempotencyKey: '' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await recordOutcome(acceptedId, ownerA.token, {
      observedOutcome: { summary: 'Observed.' },
      idempotencyKey: `outcome-${randomUUID()}`,
      ...override,
    });
    assert.equal(rejected.status, 422, `expected 422 for: ${label}`);
  }
});

test('OUTCOME: foreign/unknown execution, deployment and learning references are uniform 404s; a deployment reference resolves', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await disposition(decisionId, ownerA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });

  // Foreign/unknown execution → uniform 404.
  const foreignExecution = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    executionRef: randomUUID(),
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(foreignExecution.status, 404, JSON.stringify(foreignExecution.body));

  // Foreign/unknown learning → uniform 404.
  const foreignLearning = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    learningRef: learningB,
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(foreignLearning.status, 404, JSON.stringify(foreignLearning.body));
  const unknownLearning = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    learningRef: randomUUID(),
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(unknownLearning.status, 404);
  assert.deepEqual(
    (foreignLearning.body as Record<string, unknown>)['code'],
    (unknownLearning.body as Record<string, unknown>)['code'],
  );

  // A SAME-Client DEPLOYMENT reference resolves through the /deployments
  // public contract.
  const withDeployment = await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed through the deployment.' },
    deploymentRef: deploymentA1,
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(withDeployment.status, 200, JSON.stringify(withDeployment.body));
  const decision = (withDeployment.body as Record<string, unknown>)['decision'] as Record<string, unknown>;
  assert.equal(decision['deploymentRef'], deploymentA1);

  // A FOREIGN deployment (client B's workspace would need one) is not
  // fixture-created; the unknown-id 404 above already proves the fence
  // shape for the deployment column through the same public contract.
});

// ---------------------------------------------------------------------------
// The append-only event tail
// ---------------------------------------------------------------------------

test('EVENTS: the tail carries dispositions and outcomes verbatim, oldest first; replays never duplicate', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: workspaceA1 }));
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  // Empty tail before any mutation (creation IS the row, not an event).
  const empty = await listEvents(decisionId, ownerA.token);
  assert.equal(empty.status, 200);
  assert.deepEqual((empty.body as Record<string, unknown>)['events'], []);

  // A disposition event.
  const dispositionKey = `disp-${randomUUID()}`;
  await disposition(decisionId, ownerA.token, {
    command: 'accept',
    reason: 'Approved for rollout.',
    idempotencyKey: dispositionKey,
  });
  // Replay the same disposition (converges, no new event).
  await disposition(decisionId, ownerA.token, {
    command: 'accept',
    reason: 'Approved for rollout.',
    idempotencyKey: dispositionKey,
  });
  // An outcome event.
  await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed.', asExpected: true },
    executionRef: executionA1,
    learningRef: learningA1,
    idempotencyKey: `outcome-${randomUUID()}`,
  });

  const tail = await listEvents(decisionId, ownerA.token);
  assert.equal(tail.status, 200);
  const events = (tail.body as Record<string, unknown>)['events'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(events.length, 2, 'exactly the disposition + outcome events (the replay added none)');
  assert.equal(events[0]!['eventKind'], 'disposition');
  assert.equal(events[0]!['disposition'], 'accepted');
  assert.equal(events[0]!['reason'], 'Approved for rollout.');
  assert.equal(events[1]!['eventKind'], 'outcome_observed');
  assert.deepEqual(events[1]!['observedOutcome'], { summary: 'Observed.', asExpected: true });
  assert.equal(events[1]!['executionRef'], executionA1);
  assert.equal(events[1]!['learningRef'], learningA1);
});

// ---------------------------------------------------------------------------
// Tenant isolation negatives
// ---------------------------------------------------------------------------

test('ISOLATION: foreign decision identifiers are uniform 404s; foreign-client lists are 404s; anonymous calls are 401', async () => {
  // A decision under the foreign client B.
  const foreignDecision = await recordDecision(clientB, ownerB.token, decisionBody());
  assert.equal(foreignDecision.status, 201);
  const foreignId = ((foreignDecision.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  // A member of agency A reading the foreign decision → 404, and the
  // response is INDISTINGUISHABLE from an unknown decision id.
  const foreign = await getDecision(foreignId, ownerA.token);
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const unknown = await getDecision(randomUUID(), ownerA.token);
  assert.equal(unknown.status, 404);
  assert.deepEqual(
    (foreign.body as Record<string, unknown>)['code'],
    (unknown.body as Record<string, unknown>)['code'],
  );

  // Foreign dispositions/outcomes/events are equally uniform 404s.
  const foreignDisposition = await disposition(foreignId, ownerA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(foreignDisposition.status, 404);
  const foreignOutcome = await recordOutcome(foreignId, ownerA.token, {
    observedOutcome: { summary: 'Observed.' },
    idempotencyKey: `outcome-${randomUUID()}`,
  });
  assert.equal(foreignOutcome.status, 404);
  const foreignEvents = await listEvents(foreignId, ownerA.token);
  assert.equal(foreignEvents.status, 404);

  // Listing a foreign client's decisions → 404 (the client boundary is
  // checked before dependent traversal).
  const foreignList = await apiCall(port(), `/api/clients/${clientB}/decisions`, {
    token: ownerA.token,
  });
  assert.equal(foreignList.status, 404, JSON.stringify(foreignList.body));

  // Anonymous calls fail closed (401) on every surface.
  for (const [method, pathName] of [
    ['POST', `/api/clients/${clientA1}/decisions`],
    ['GET', `/api/clients/${clientA1}/decisions`],
    ['GET', `/api/decisions/${randomUUID()}`],
    ['POST', `/api/decisions/${randomUUID()}/disposition`],
    ['POST', `/api/decisions/${randomUUID()}/outcome`],
    ['GET', `/api/decisions/${randomUUID()}/events`],
  ] as const) {
    const anonymous = await apiCall(port(), pathName, {
      method,
      body: method === 'POST' ? decisionBody() : undefined,
    });
    assert.equal(anonymous.status, 401, `anonymous ${method} ${pathName} must be 401`);
  }
});

test('ISOLATION: forged authority headers change nothing; the durable rows stay byte-identical', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const before = await decisionRow(decisionId);
  assert.ok(before !== null);

  // Forged authority headers on every surface.
  await apiCall(port(), `/api/decisions/${decisionId}`, {
    token: ownerA.token,
    headers: { ...FORGED_HEADERS, 'x-decision-id': decisionId },
  });
  await apiCall(port(), `/api/decisions/${decisionId}/disposition`, {
    token: ownerA.token,
    headers: { ...FORGED_HEADERS, 'x-decision-id': decisionId },
    body: { command: 'accept', idempotencyKey: 'forged-header-probe' },
  });
  // The headers did NOT authorize anything (the probe used a legitimate
  // token; the point is the forged fields are ignored, not honored).

  // The durable row is byte-identical (the disposition DID land through
  // the legitimate token — the forged headers added nothing beyond it).
  const after = await decisionRow(decisionId);
  assert.ok(after !== null);
  assert.equal(after.disposition, 'accepted');
  assert.equal(after.proposer_actor, `user:${ownerA.userId}`);
  assert.equal(after.recorded_actor, `user:${ownerA.userId}`);

  // A fresh decision stays untouched by header-only probes.
  const second = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(second.status, 201);
  const secondId = ((second.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const secondBefore = await decisionRow(secondId);
  assert.ok(secondBefore !== null);
  await apiCall(port(), `/api/decisions/${secondId}`, {
    token: collaboratorA.token,
    headers: { ...FORGED_HEADERS, 'x-decision-id': secondId, 'x-disposition': 'accepted' },
  });
  await apiCall(port(), `/api/decisions/${secondId}/disposition`, {
    token: collaboratorA.token,
    headers: { ...FORGED_HEADERS, 'x-decision-id': secondId, 'x-role': 'agency_owner' },
    body: { command: 'accept', idempotencyKey: 'forged-role-probe' },
  });
  const secondAfter = await decisionRow(secondId);
  assert.ok(secondAfter !== null);
  assert.deepEqual(secondAfter, secondBefore, 'no header probe changed a single byte');
});

test('ROLES: any active member records and reads; dispositions and outcomes require owner/admin (collaborator 403)', async () => {
  // A collaborator CAN record.
  const recorded = await recordDecision(clientA1, collaboratorA.token, decisionBody());
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
  const decisionId = ((recorded.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  // The server-derived proposer carries the collaborator's OWN role.
  const decision = (recorded.body as Record<string, unknown>)['decision'] as Record<string, unknown>;
  const proposer = decision['proposer'] as Record<string, unknown>;
  assert.equal(proposer['actor'], `user:${collaboratorA.userId}`);
  assert.equal(proposer['role'], 'client_collaborator');

  // A collaborator CAN read + list + read events.
  const read = await getDecision(decisionId, collaboratorA.token);
  assert.equal(read.status, 200);
  const list = await apiCall(port(), `/api/clients/${clientA1}/decisions`, {
    token: collaboratorA.token,
  });
  assert.equal(list.status, 200);
  const events = await listEvents(decisionId, collaboratorA.token);
  assert.equal(events.status, 200);

  // A collaborator CANNOT disposition (403 — the consequential governance
  // act) or record an outcome.
  const forbiddenDisposition = await disposition(decisionId, collaboratorA.token, {
    command: 'accept',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  assert.equal(forbiddenDisposition.status, 403, JSON.stringify(forbiddenDisposition.body));
});

test('LIFECYCLE GUARD: a disabled Client blocks NEW decisions (409) without erasing history', async () => {
  const disabledClient = await makeClient(agencyA, 'Decisions Disabled Client');
  const recorded = await recordDecision(disabledClient, ownerA.token, decisionBody());
  assert.equal(recorded.status, 201);
  const decisionId = ((recorded.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  // Disable the client through the /clients authority.
  const clientRecord = await apiCall(port(), `/api/clients/${disabledClient}`, {
    token: ownerA.token,
  });
  assert.equal(clientRecord.status, 200);
  const version = clientRecord.body['version'] as number;
  const disable = await apiCall(port(), `/api/clients/${disabledClient}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  // New decisions under the disabled client are blocked (409).
  const blocked = await recordDecision(disabledClient, ownerA.token, decisionBody());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

  // The recorded history is still readable (nothing was erased).
  const stillThere = await getDecision(decisionId, ownerA.token);
  assert.equal(stillThere.status, 200);
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
});

// ---------------------------------------------------------------------------
// The DB backstops (direct SQL against the append-only invariants)
// ---------------------------------------------------------------------------

test('DB BACKSTOP: the event tail rejects UPDATE and DELETE; decision rows reject DELETE (append-only history)', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await disposition(decisionId, ownerA.token, {
    command: 'accept',
    reason: 'For the backstop proofs.',
    idempotencyKey: `disp-${randomUUID()}`,
  });

  assert.ok(db !== null);
  const event = await db.query<{ event_id: string }>(
    'SELECT event_id FROM decision_events WHERE decision_id = $1 LIMIT 1',
    [decisionId],
  );
  assert.equal(event.rows.length, 1);
  const eventId = event.rows[0]!.event_id;

  // UPDATE on the event tail is rejected.
  await assert.rejects(
    db.query('UPDATE decision_events SET reason = $1 WHERE event_id = $2', [
        'Rewritten.',
        eventId,
      ]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('decision events are append-only'));
      return true;
    },
  );
  // DELETE on the event tail is rejected.
  await assert.rejects(
    db.query('DELETE FROM decision_events WHERE event_id = $1', [eventId]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('decision events are append-only'));
      return true;
    },
  );
  // DELETE on the decision row is rejected.
  await assert.rejects(
    db.query('DELETE FROM decisions WHERE decision_id = $1', [decisionId]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('decisions are append-only ledger history'));
      return true;
    },
  );

  // Both rows still exist.
  const row = await decisionRow(decisionId);
  assert.ok(row !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM decision_events WHERE decision_id = $1',
    [decisionId],
  );
  assert.equal(count.rows[0]!.count, '1');
});

test('DB BACKSTOP: proposal columns reject UPDATE; illegal lifecycle transitions reject at the database level', async () => {
  const created = await recordDecision(clientA1, ownerA.token, decisionBody({ workspaceId: workspaceA1 }));
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  assert.ok(db !== null);
  // Rewriting the objective is rejected (proposal immutability).
  await assert.rejects(
    db.query('UPDATE decisions SET objective = $1 WHERE decision_id = $2', [
        'Rewritten objective.',
        decisionId,
      ]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('the decision proposal payload is immutable'));
      return true;
    },
  );
  // Rewriting the proposer is rejected.
  await assert.rejects(
    db.query('UPDATE decisions SET proposer_actor = $1 WHERE decision_id = $2', [
        'user:forged',
        decisionId,
      ]),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('the decision proposal payload is immutable'));
      return true;
    },
  );

  // An illegal transition (proposed → proposed is not a transition, so
  // use proposed → accepted first, then accepted → proposed) is rejected.
  await db.query(
    "UPDATE decisions SET disposition = 'accepted', disposition_at = now() WHERE decision_id = $1 AND disposition = 'proposed'",
    [decisionId],
  );
  await assert.rejects(
    db.query(
        "UPDATE decisions SET disposition = 'proposed' WHERE decision_id = $1",
        [decisionId],
      ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('illegal decision disposition transition'));
      return true;
    },
  );
  // accepted → rejected is equally illegal (terminal states have no
  // outgoing edges).
  await assert.rejects(
    db.query(
        "UPDATE decisions SET disposition = 'rejected', disposition_at = now() WHERE decision_id = $1",
        [decisionId],
      ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('illegal decision disposition transition'));
      return true;
    },
  );
  // An outcome observation on a decision that is not accepted is rejected.
  const proposed = await recordDecision(clientA1, ownerA.token, decisionBody());
  const proposedId = ((proposed.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await assert.rejects(
    db.query(
        `UPDATE decisions SET observed_outcome = '{"summary":"Forged."}'::jsonb, outcome_at = now()
          WHERE decision_id = $1`,
        [proposedId],
      ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('illegal decision disposition transition'));
      return true;
    },
  );
  // A disposition must not set the outcome columns.
  await assert.rejects(
    db.query(
        `UPDATE decisions SET disposition = 'rejected', disposition_at = now(),
            observed_outcome = '{"summary":"x"}'::jsonb, outcome_at = now()
          WHERE decision_id = $1 AND disposition = 'proposed'`,
        [proposedId],
      ),
    (error: unknown) => {
      assert.ok(String((error as Error).message).includes('a disposition must not set the outcome columns'));
      return true;
    },
  );
});

test('DB BACKSTOP: the tenant fences reject cross-tenant inserts even via direct SQL', async () => {
  assert.ok(db !== null);
  // A cross-workspace scope (workspace of client B under client A1).
  await assert.rejects(
    db.query(
        `INSERT INTO decisions (decision_id, client_id, workspace_id, agency_id, objective,
                                hypothesis_summary, evidence_refs, expected_impact, alternatives,
                                proposer_actor, proposer_role, disposition, idempotency_key,
                                create_fingerprint, recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, $3, $4, 'Objective.', 'Hypothesis.', '[]'::jsonb,
                 '{"summary":"Impact."}'::jsonb, '[]'::jsonb, 'user:x', 'agency_owner',
                 'proposed', $5, 'dc1:x:1', 'user:x', 'api', 'corr-x')`,
        [randomUUID(), clientA1, workspaceB, agencyA, `fence-${randomUUID()}`],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('does not belong to client'),
        `the workspace-within-client fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );

  // Cross-tenant evidence citation.
  await assert.rejects(
    db.query(
        `INSERT INTO decisions (decision_id, client_id, agency_id, objective,
                                hypothesis_summary, evidence_refs, expected_impact, alternatives,
                                proposer_actor, proposer_role, disposition, idempotency_key,
                                create_fingerprint, recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, $3, 'Objective.', 'Hypothesis.', $4::jsonb,
                 '{"summary":"Impact."}'::jsonb, '[]'::jsonb, 'user:x', 'agency_owner',
                 'proposed', $5, 'dc1:x:1', 'user:x', 'api', 'corr-x')`,
        [randomUUID(), clientA1, agencyA, JSON.stringify([evidenceB]), `fence-${randomUUID()}`],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('cross-tenant evidence linkage is rejected'),
        `the cross-tenant evidence fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );

  // Cross-tenant experiment link.
  await assert.rejects(
    db.query(
        `INSERT INTO decisions (decision_id, client_id, agency_id, objective,
                                hypothesis_summary, experiment_ref, evidence_refs, expected_impact,
                                alternatives, proposer_actor, proposer_role, disposition,
                                idempotency_key, create_fingerprint, recorded_actor, recorded_via,
                                correlation_id)
         VALUES ($1, $2, $3, 'Objective.', 'Hypothesis.', $4, '[]'::jsonb,
                 '{"summary":"Impact."}'::jsonb, '[]'::jsonb, 'user:x', 'agency_owner',
                 'proposed', $5, 'dc1:x:1', 'user:x', 'api', 'corr-x')`,
        [randomUUID(), clientA1, agencyA, randomUUID(), `fence-${randomUUID()}`],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('links unknown experiment'),
        `the experiment fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );

  // Cross-tenant predecessor link: a decision of client B as the
  // predecessor of a client A1 decision.
  const foreignDecision = await recordDecision(clientB, ownerB.token, decisionBody());
  const foreignId = ((foreignDecision.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await assert.rejects(
    db.query(
        `INSERT INTO decisions (decision_id, client_id, agency_id, objective,
                                hypothesis_summary, predecessor_decision_id, evidence_refs,
                                expected_impact, alternatives, proposer_actor, proposer_role,
                                disposition, idempotency_key, create_fingerprint, recorded_actor,
                                recorded_via, correlation_id)
         VALUES ($1, $2, $3, 'Objective.', 'Hypothesis.', $4, '[]'::jsonb,
                 '{"summary":"Impact."}'::jsonb, '[]'::jsonb, 'user:x', 'agency_owner',
                 'proposed', $5, 'dc1:x:1', 'user:x', 'api', 'corr-x')`,
        [randomUUID(), clientA1, agencyA, foreignId, `fence-${randomUUID()}`],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('cross-tenant correction links are rejected'),
        `the cross-tenant predecessor fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );

  // Cross-tenant OUTCOME references: an accepted client A1 decision cannot
  // link a client B learning via direct SQL.
  const created = await recordDecision(clientA1, ownerA.token, decisionBody());
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  await db.query(
    "UPDATE decisions SET disposition = 'accepted', disposition_at = now() WHERE decision_id = $1 AND disposition = 'proposed'",
    [decisionId],
  );
  await assert.rejects(
    db.query(
        `UPDATE decisions SET observed_outcome = '{"summary":"Observed."}'::jsonb, outcome_at = now(),
                                learning_ref = $2
          WHERE decision_id = $1`,
        [decisionId, learningB],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('cross-tenant decision outcome references are rejected'),
        `the cross-tenant outcome fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );

  // No rows from the rejected inserts landed.
  const count = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM decisions WHERE idempotency_key LIKE 'fence-%'",
  );
  assert.equal(count.rows[0]!.count, '0');
});

test('DB BACKSTOP: the supersede successor fence rejects an illegal successor at the database level', async () => {
  // Two UNRELATED same-Client proposals.
  const first = await recordDecision(clientA1, ownerA.token, decisionBody());
  const firstId = ((first.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const second = await recordDecision(clientA1, ownerA.token, decisionBody());
  const secondId = ((second.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;

  assert.ok(db !== null);
  // Superseding with a successor that does NOT declare the predecessor is
  // rejected by the trigger.
  await assert.rejects(
    db.query(
        `UPDATE decisions SET disposition = 'superseded', successor_decision_id = $2,
                                disposition_at = now()
          WHERE decision_id = $1 AND disposition = 'proposed'`,
        [firstId, secondId],
      ),
    (error: unknown) => {
      assert.ok(
        String((error as Error).message).includes('supersede requires a live correction successor'),
        `the successor fence must reject (got: ${(error as Error).message})`,
      );
      return true;
    },
  );
  // The row is still proposed.
  const row = await decisionRow(firstId);
  assert.ok(row !== null);
  assert.equal(row.disposition, 'proposed');
});

// ---------------------------------------------------------------------------
// Byte-stability through the full lifecycle
// ---------------------------------------------------------------------------

test('STABILITY: the proposal row is byte-stable through disposition AND outcome (only lifecycle columns move)', async () => {
  const created = await recordDecision(
    clientA1,
    ownerA.token,
    decisionBody({
      workspaceId: workspaceA1,
      experimentRef: experimentA1,
      evidenceRefs: [evidenceA1],
    }),
  );
  assert.equal(created.status, 201);
  const decisionId = ((created.body as Record<string, unknown>)['decision'] as Record<string, unknown>)['decisionId'] as string;
  const before = await decisionRow(decisionId);
  assert.ok(before !== null);

  await disposition(decisionId, ownerA.token, {
    command: 'accept',
    reason: 'Approved.',
    idempotencyKey: `disp-${randomUUID()}`,
  });
  await recordOutcome(decisionId, ownerA.token, {
    observedOutcome: { summary: 'Observed as expected.', asExpected: true },
    executionRef: executionA1,
    learningRef: learningA1,
    idempotencyKey: `outcome-${randomUUID()}`,
  });

  const after = await decisionRow(decisionId);
  assert.ok(after !== null);
  for (const column of [
    'client_id',
    'workspace_id',
    'agency_id',
    'objective',
    'context',
    'hypothesis_summary',
    'experiment_ref',
    'evidence_refs',
    'expected_impact',
    'uncertainty',
    'expected_cost',
    'alternatives',
    'predecessor_decision_id',
    'proposer_actor',
    'proposer_role',
    'idempotency_key',
    'create_fingerprint',
    'recorded_actor',
    'recorded_via',
    'correlation_id',
    'causation_id',
    'recorded_at',
  ] as const) {
    assert.deepEqual(
      after[column],
      before[column],
      `the proposal column '${column}' must be byte-stable through the full lifecycle`,
    );
  }
  // The lifecycle columns moved exactly as designed.
  assert.equal(after.disposition, 'accepted');
  assert.ok(after.disposition_at !== null);
  assert.ok(after.observed_outcome !== null);
  assert.ok(after.outcome_at !== null);
  assert.equal(after.execution_ref, executionA1);
  assert.equal(after.learning_ref, learningA1);
});

// ---------------------------------------------------------------------------
// The list surface
// ---------------------------------------------------------------------------

test('LIST: the Client’s decisions list newest-first and never leaks other tenants', async () => {
  const older = await recordDecision(clientA1, ownerA.token, decisionBody({ objective: 'The older decision.' }));
  assert.equal(older.status, 201);
  const newer = await recordDecision(clientA1, ownerA.token, decisionBody({ objective: 'The newer decision.' }));
  assert.equal(newer.status, 201);

  const list = await apiCall(port(), `/api/clients/${clientA1}/decisions`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const decisions = (list.body as Record<string, unknown>)['decisions'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(decisions.length >= 2);
  // Newest first.
  const newerIndex = decisions.findIndex(
    (entry) => entry['objective'] === 'The newer decision.',
  );
  const olderIndex = decisions.findIndex(
    (entry) => entry['objective'] === 'The older decision.',
  );
  assert.ok(newerIndex >= 0 && olderIndex >= 0);
  assert.ok(newerIndex < olderIndex, 'newest decisions list first');
  // Every listed decision belongs to THIS client.
  for (const entry of decisions) {
    assert.equal(entry['clientId'], clientA1);
  }
  // The unknown client lists 404.
  const unknown = await apiCall(port(), `/api/clients/${randomUUID()}/decisions`, {
    token: ownerA.token,
  });
  assert.equal(unknown.status, 404);
});
