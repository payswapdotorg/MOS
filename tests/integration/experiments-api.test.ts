/**
 * MKT-015 integration test — the Experiment model authority (EXP-001,
 * acceptance EXP-AC-01..03) against real PostgreSQL + a real API
 * subprocess.
 *
 * Proofs:
 *   - EXP-AC-01: a declared experiment stores the FULL frozen contract —
 *     hypothesis, treatment AND comparison, analysis method (+version),
 *     population/unit, assignment method, design type, primary metric BY
 *     NAME + DIMENSIONS (never a provider metric id), guardrails, expected
 *     direction, start/stop criteria, minimum evidence requirement and the
 *     declared uncertainty representation — verified in the API response
 *     AND the durable row; the declaration is audited;
 *   - the frozen lifecycle (spec/state-machines.md): DRAFT → READY →
 *     RUNNING → ANALYZING → CONCLUDED works through the explicit
 *     transition route, each application appends one immutable history row
 *     with server-derived provenance, and illegal transitions are 409s
 *     (API) + rejected by the DB legal-successor trigger (direct SQL);
 *   - EXP-AC-02: the conclusion-type taxonomy is closed and causal is
 *     DISTINCT from attribution/observation — a CAUSAL conclusion on an
 *     observational/descriptive design is rejected at the API (422) AND by
 *     the DB row CHECK (direct SQL), while attribution/observation/
 *     inconclusive conclusions are valid on every design;
 *   - EXP-AC-03: uncertainty (matching the declared representation) and
 *     the analysis metadata (assumptions, sample limitations, confounders)
 *     are retained verbatim — in the experiment record, the transition
 *     history row AND the history API response; an uncertainty payload
 *     mismatching the declared representation is rejected (422);
 *   - the declared DESIGN is immutable: direct SQL rewrites of design
 *     columns are rejected by the DB trigger; the transition history is
 *     append-only (UPDATE/DELETE rejected by DB triggers);
 *   - tenant isolation negatives: foreign experiment identifiers are
 *     uniform 404s (no existence oracle), foreign-client declarations are
 *     404s, foreign workspace scoping is 404, the Client list never leaks
 *     other tenants' experiments, forged authority headers change nothing,
 *     anonymous calls are 401, and a disabled Client blocks new
 *     declarations (409) without erasing history;
 *   - evidence citations: same-Client evidenceRefs land in the retained
 *     conclusion; a FOREIGN evidence reference is a uniform 404
 *     (indistinguishable from an unknown one), and a cross-tenant citation
 *     via direct SQL is rejected by the DB trigger;
 *   - caller-authority rejection: provenance-shaped, lifecycle-shaped and
 *     result-shaped body fields are rejected (422) on BOTH write surfaces;
 *   - role discipline: any active member may declare and read; lifecycle
 *     transitions require owner/admin (collaborator 403).
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

/** The full frozen §16 declaration payload (a randomized design). */
function declarationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hypothesis: 'A 5-touch onboarding email sequence increases new-account activation vs the 3-touch sequence.',
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    populationUnit: 'New client accounts created after 2026-01-01, account level.',
    treatment: '5-touch onboarding email sequence with behavioral triggers.',
    comparison: 'Current 3-touch onboarding email sequence (status quo).',
    assignmentMethod: 'Simple random assignment at account creation, 50/50.',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [
      { name: 'unsubscribe_rate', dimensions: {} },
      { name: 'support_ticket_volume', dimensions: { tier: 'standard' } },
    ],
    analysisMethod: 'Two-proportion z-test on account-level activation.',
    analysisMethodVersion: 'v2',
    expectedDirection: 'increase',
    startCriteria: 'Start once 500 accounts/week enrollment is confirmed.',
    stopCriteria: 'Stop at 2000 accounts per arm or after 6 weeks, whichever comes first.',
    minimumEvidenceRequirement: 'B — strong quasi-experimental design at minimum.',
    uncertaintyRepresentation: 'interval',
    ...overrides,
  };
}

/** An observational design (cannot carry causal conclusions). */
function observationalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return declarationBody({
    designType: 'observational',
    hypothesis: 'Accounts touched by field agents activate at a higher rate.',
    assignmentMethod: 'None — exposure observed as it occurs (no intervention).',
    analysisMethod: 'Cohort comparison with confounder discussion.',
    uncertaintyRepresentation: 'qualitative',
    ...overrides,
  });
}

/** The full frozen §16 conclusion payload (null optionals are omitted — JSON null is not a valid optional DTO value). */
function conclusionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    resultState: 'causal_supported',
    uncertainty: { kind: 'interval', lower: 0.012, upper: 0.041, level: 0.95 },
    assumptions: ['Stable delivery infrastructure during the window'],
    sampleLimitations: ['Only standard-tier accounts observed'],
    confounders: ['Seasonal demand shift', 'Concurrent pricing experiment on 5% of accounts'],
    resultingDecision: 'Roll out the 5-touch sequence to all new clients.',
    evidenceRefs: [],
    ...overrides,
  };
  // JSON `null` is not a valid optional value (the strict DTO rejects it) —
  // an absent value is an ABSENT KEY.
  if (body['uncertainty'] === null) delete body['uncertainty'];
  if (body['resultingDecision'] === null) delete body['resultingDecision'];
  if (body['expectedDirection'] === null) delete body['expectedDirection'];
  return body;
}

async function declareExperiment(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
  options: { correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body,
  });
}

async function applyTransition(
  experimentId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/experiments/${experimentId}/transitions`, { token, body });
}

async function getExperiment(
  experimentId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/experiments/${experimentId}`, { token });
}

interface ExperimentRow {
  [column: string]: unknown;
  experiment_id: string;
  client_id: string;
  workspace_id: string | null;
  hypothesis: string;
  decision_target: string;
  population_unit: string;
  treatment: string;
  comparison: string;
  assignment_method: string;
  design_type: string;
  primary_metric: Record<string, unknown>;
  guardrails: ReadonlyArray<Record<string, unknown>>;
  analysis_method: string;
  analysis_method_version: string | null;
  expected_direction: string | null;
  start_criteria: string | null;
  stop_criteria: string;
  minimum_evidence_requirement: string;
  uncertainty_representation: string;
  status: string;
  result_state: string;
  resulting_decision: string | null;
  concluded_at: Date | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

async function experimentRow(experimentId: string): Promise<ExperimentRow | null> {
  assert.ok(db !== null);
  const result = await db.query<ExperimentRow>(
    'SELECT * FROM experiments WHERE experiment_id = $1',
    [experimentId],
  );
  return result.rows[0] ?? null;
}

async function transitionRows(experimentId: string): Promise<
  ReadonlyArray<{
    transition_id: string;
    transition: string;
    from_status: string;
    to_status: string;
    conclusion: Record<string, unknown> | null;
    recorded_actor: string;
    recorded_via: string;
    correlation_id: string;
    recorded_at: Date;
  }>
> {
  assert.ok(db !== null);
  const result = await db.query<{
    transition_id: string;
    transition: string;
    from_status: string;
    to_status: string;
    conclusion: Record<string, unknown> | null;
    recorded_actor: string;
    recorded_via: string;
    correlation_id: string;
    recorded_at: Date;
  }>(
    'SELECT transition_id, transition, from_status, to_status, conclusion, recorded_actor, recorded_via, correlation_id, recorded_at FROM experiment_transitions WHERE experiment_id = $1 ORDER BY recorded_at ASC, transition_id',
    [experimentId],
  );
  return result.rows;
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-experiment-id': 'REPLACED_PER_TEST',
  'x-result-state': 'causal_supported',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients + one workspace),
// agency B foreign, evidence records under both clients.
const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceB = '';
let evidenceA1 = '';
let evidenceB = '';

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
  stack = await bootStack('experiments');
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
      body: { password: 'experiments-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'experiments-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@experiments.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@experiments.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@experiments.test', 'Agency B Owner'));

  agencyA = await makeAgency('Experiments Agency A', ownerA);
  agencyB = await makeAgency('Experiments Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Experiments Client A One');
  clientB = await makeClient(agencyB, 'Experiments Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Experiments Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Experiments Workspace B');

  // Evidence records under client A1 and the foreign client B (the
  // MKT-013 authority) to exercise conclusion evidence citations.
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
// EXP-AC-01 — the declared contract is stored (API + durable row + audit)
// ---------------------------------------------------------------------------

test('EXP-AC-01: a declared experiment stores hypothesis, treatment/comparison and analysis method (and the full §16 contract)', async () => {
  const correlationId = randomUUID();
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody(), {
    correlationId,
  });
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const record = declared.body;

  // The lifecycle starts server-chosen: DRAFT / undecided / no decision.
  assert.equal(record['status'], 'draft');
  assert.equal(record['resultState'], 'undecided');
  assert.equal(record['resultingDecision'], undefined);
  assert.equal(record['concludedAt'], undefined);
  assert.equal(record['clientId'], clientA1);

  // The core EXP-AC-01 fields round-trip byte-for-byte.
  assert.equal(record['hypothesis'], declarationBody().hypothesis);
  assert.equal(record['decisionTarget'], declarationBody().decisionTarget);
  assert.equal(record['populationUnit'], declarationBody().populationUnit);
  assert.equal(record['treatment'], declarationBody().treatment);
  assert.equal(record['comparison'], declarationBody().comparison);
  assert.equal(record['assignmentMethod'], declarationBody().assignmentMethod);
  assert.equal(record['analysisMethod'], declarationBody().analysisMethod);
  assert.equal(record['analysisMethodVersion'], 'v2');
  assert.equal(record['designType'], 'randomized');
  assert.equal(record['expectedDirection'], 'increase');
  assert.equal(record['startCriteria'], declarationBody().startCriteria);
  assert.equal(record['stopCriteria'], declarationBody().stopCriteria);
  assert.equal(record['minimumEvidenceRequirement'], declarationBody().minimumEvidenceRequirement);
  assert.equal(record['uncertaintyRepresentation'], 'interval');
  assert.deepEqual(record['primaryMetric'], {
    name: 'activation_rate',
    dimensions: { cohort: 'new_accounts' },
  });
  const guardrails = record['guardrails'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(guardrails.length, 2);
  assert.deepEqual(guardrails[0], { name: 'unsubscribe_rate', dimensions: {} });
  assert.deepEqual(guardrails[1], { name: 'support_ticket_volume', dimensions: { tier: 'standard' } });

  // Provenance is server-derived: the authenticated actor, 'api', the
  // request correlation, the module clock.
  const provenance = record['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId);
  assert.ok(!Number.isNaN(Date.parse(String(provenance['recordedAt']))));

  // The durable row carries the same contract (PostgreSQL is the system of
  // record — the API response is not the proof).
  const row = await experimentRow(record['experimentId'] as string);
  assert.ok(row !== null);
  assert.equal(row.hypothesis, declarationBody().hypothesis);
  assert.equal(row.treatment, declarationBody().treatment);
  assert.equal(row.comparison, declarationBody().comparison);
  assert.equal(row.analysis_method, declarationBody().analysisMethod);
  assert.equal(row.analysis_method_version, 'v2');
  assert.equal(row.design_type, 'randomized');
  assert.deepEqual(row.primary_metric, {
    name: 'activation_rate',
    dimensions: { cohort: 'new_accounts' },
  });
  assert.equal(row.guardrails.length, 2);
  assert.equal(row.status, 'draft');
  assert.equal(row.result_state, 'undecided');
  assert.equal(row.resulting_decision, null);
  assert.equal(row.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(row.recorded_via, 'api');
  assert.equal(row.correlation_id, correlationId);
  assert.ok(!Number.isNaN(Date.parse(row.recorded_at.toISOString())));

  // The declaration is a material, audited mutation.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; correlation_id: string }>(
    `SELECT action, target_id, correlation_id FROM audit_events
      WHERE target_type = 'experiment' AND target_id = $1 AND action = 'experiments.experiment.declared'`,
    [record['experimentId'] as string],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the declaration');
  assert.equal(audit.rows[0]!.correlation_id, correlationId);
});

test('EXP-AC-01: the declaration guard rejects malformed designs at the API (fail closed)', async () => {
  for (const [label, body] of [
    ['missing hypothesis', declarationBody({ hypothesis: '' })],
    ['missing comparison', declarationBody({ comparison: '' })],
    ['unknown design type', declarationBody({ designType: 'natural-experiment' })],
    ['unknown uncertainty representation', declarationBody({ uncertaintyRepresentation: 'error bars' })],
    ['malformed primary metric', declarationBody({ primaryMetric: { dimensions: {} } })],
    ['guardrails not an array', declarationBody({ guardrails: 'none' })],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await declareExperiment(clientA1, ownerA.token, body);
    assert.equal(rejected.status, 422, `expected 422 for: ${label}`);
  }
});

test('the optional Workspace scope lands in the durable row; a foreign-Client workspace is a uniform 404', async () => {
  const scoped = await declareExperiment(clientA1, ownerA.token, declarationBody({
    workspaceId: workspaceA1,
  }));
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  assert.equal(scoped.body['workspaceId'], workspaceA1);
  const row = await experimentRow(scoped.body['experimentId'] as string);
  assert.ok(row !== null);
  assert.equal(row.workspace_id, workspaceA1);

  // A workspace of the FOREIGN client B is indistinguishable from an
  // unknown workspace (uniform 404 — no traversal oracle).
  const foreign = await declareExperiment(clientA1, ownerA.token, declarationBody({
    workspaceId: workspaceB,
  }));
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const unknown = await declareExperiment(clientA1, ownerA.token, declarationBody({
    workspaceId: randomUUID(),
  }));
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// The frozen lifecycle + EXP-AC-03 retention
// ---------------------------------------------------------------------------

test('the frozen lifecycle runs DRAFT → READY → RUNNING → ANALYZING → CONCLUDED; each step appends immutable history', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;

  // mark_ready: DRAFT → READY
  const ready = await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' });
  assert.equal(ready.status, 200, JSON.stringify(ready.body));
  assert.equal(ready.body['status'], 'ready');
  assert.equal(ready.body['resultState'], 'undecided');

  // start: READY → RUNNING
  const running = await applyTransition(experimentId, ownerA.token, { transition: 'start' });
  assert.equal(running.status, 200, JSON.stringify(running.body));
  assert.equal(running.body['status'], 'running');

  // begin_analysis: RUNNING → ANALYZING
  const analyzing = await applyTransition(experimentId, ownerA.token, { transition: 'begin_analysis' });
  assert.equal(analyzing.status, 200, JSON.stringify(analyzing.body));
  assert.equal(analyzing.body['status'], 'analyzing');

  // conclude: ANALYZING → CONCLUDED with the full payload (EXP-AC-03).
  const correlationId = randomUUID();
  const concluded = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: ownerA.token,
    correlationId,
    body: {
      transition: 'conclude',
      conclusion: conclusionBody({ evidenceRefs: [evidenceA1] }),
    },
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  const record = concluded.body;
  assert.equal(record['status'], 'concluded');
  assert.equal(record['resultState'], 'causal_supported');
  assert.equal(record['resultingDecision'], conclusionBody().resultingDecision);
  assert.ok(!Number.isNaN(Date.parse(String(record['concludedAt']))));
  // The declared design is preserved through the conclusion (nothing was
  // rewritten).
  assert.equal(record['hypothesis'], declarationBody().hypothesis);
  assert.equal(record['analysisMethod'], declarationBody().analysisMethod);

  // The durable row is concluded.
  const row = await experimentRow(experimentId);
  assert.ok(row !== null);
  assert.equal(row.status, 'concluded');
  assert.equal(row.result_state, 'causal_supported');
  assert.equal(row.resulting_decision, conclusionBody().resultingDecision);
  assert.ok(row.concluded_at !== null);

  // The history: exactly 4 rows, oldest first, the conclusion row last and
  // carrying the FULL retained payload verbatim (EXP-AC-03).
  const history = await transitionRows(experimentId);
  assert.equal(history.length, 4);
  assert.deepEqual(
    history.map((entry) => [entry.transition, entry.from_status, entry.to_status]),
    [
      ['mark_ready', 'draft', 'ready'],
      ['start', 'ready', 'running'],
      ['begin_analysis', 'running', 'analyzing'],
      ['conclude', 'analyzing', 'concluded'],
    ],
  );
  for (const entry of history) {
    assert.equal(entry.recorded_actor, `user:${ownerA.userId}`);
    assert.equal(entry.recorded_via, 'api');
  }
  const conclusionRow = history[3]!;
  assert.ok(conclusionRow.conclusion !== null);
  const conclusion = conclusionRow.conclusion as Record<string, unknown>;
  assert.equal(conclusion['resultState'], 'causal_supported');
  assert.deepEqual(conclusion['uncertainty'], {
    kind: 'interval',
    lower: 0.012,
    upper: 0.041,
    level: 0.95,
  });
  assert.deepEqual(conclusion['assumptions'], ['Stable delivery infrastructure during the window']);
  assert.deepEqual(conclusion['sampleLimitations'], ['Only standard-tier accounts observed']);
  assert.deepEqual(conclusion['confounders'], [
    'Seasonal demand shift',
    'Concurrent pricing experiment on 5% of accounts',
  ]);
  assert.equal(conclusion['resultingDecision'], conclusionBody().resultingDecision);
  assert.deepEqual(conclusion['evidenceRefs'], [evidenceA1]);
  assert.equal(conclusionRow.correlation_id, correlationId);

  // The history API returns the same retained payload.
  const historyApi = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: ownerA.token,
  });
  assert.equal(historyApi.status, 200);
  const transitions = historyApi.body['transitions'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(transitions.length, 4);
  const apiConclusion = (transitions[3]!['conclusion'] as Record<string, unknown>);
  assert.equal(apiConclusion['resultState'], 'causal_supported');
  assert.deepEqual(apiConclusion['uncertainty'], {
    kind: 'interval',
    lower: 0.012,
    upper: 0.041,
    level: 0.95,
  });
  assert.deepEqual(apiConclusion['confounders'], [
    'Seasonal demand shift',
    'Concurrent pricing experiment on 5% of accounts',
  ]);
  assert.deepEqual(apiConclusion['evidenceRefs'], [evidenceA1]);

  // Each transition is audited.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string }>(
    `SELECT action, target_id FROM audit_events
      WHERE target_type = 'experiment' AND target_id = $1 AND action = 'experiments.experiment.transitioned'`,
    [experimentId],
  );
  assert.equal(audit.rows.length, 4, 'exactly one audit row per transition');

  // Terminal: no transition leaves CONCLUDED (uniform 409).
  const after = await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' });
  assert.equal(after.status, 409);
});

test('RUNNING may stop or invalidate (terminal branches of the frozen state machine)', async () => {
  for (const transition of ['stop', 'invalidate'] as const) {
    const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
    const experimentId = declared.body['experimentId'] as string;
    assert.equal(
      (await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status,
      200,
    );
    assert.equal(
      (await applyTransition(experimentId, ownerA.token, { transition: 'start' })).status,
      200,
    );
    const terminal = await applyTransition(experimentId, ownerA.token, { transition });
    assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
    assert.equal(
      terminal.body['status'],
      transition === 'stop' ? 'stopped' : 'invalidated',
    );
    // A stopped/invalidated experiment is NOT concluded: the result state
    // stays undecided (no conclusion was recorded).
    assert.equal(terminal.body['resultState'], 'undecided');
    // Terminal — nothing leaves.
    const after = await applyTransition(experimentId, ownerA.token, { transition: 'begin_analysis' });
    assert.equal(after.status, 409);
  }
});

test('illegal transitions are 409s (skips and backwards moves are rejected)', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;

  // start requires READY, not DRAFT (skip).
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'start' })).status, 409);
  // conclude WITHOUT its payload is invalid INPUT (422 — the guard fires
  // before state legality).
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'conclude' })).status, 422);
  // conclude WITH a payload on DRAFT is an illegal EDGE (409 — state).
  assert.equal(
    (
      await applyTransition(experimentId, ownerA.token, {
        transition: 'conclude',
        conclusion: conclusionBody(),
      })
    ).status,
    409,
  );

  // Move to RUNNING, then try to move BACK to READY.
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status, 200);
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'start' })).status, 200);
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status, 409);
});

test('the DB legal-successor trigger rejects illegal status moves even via direct SQL (race backstop)', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  assert.ok(db !== null);
  await assert.rejects(
    db.query(`UPDATE experiments SET status = 'running' WHERE experiment_id = $1`, [experimentId]),
    (error: unknown) => {
      assert.ok(String((error as { message?: string }).message).includes('illegal experiment status transition'));
      return true;
    },
  );
  // The row is untouched.
  const row = await experimentRow(experimentId);
  assert.ok(row !== null);
  assert.equal(row.status, 'draft');
});

test('the declared design is immutable: direct SQL rewrites of design columns are rejected by the DB trigger', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  assert.ok(db !== null);
  await assert.rejects(
    db.query(`UPDATE experiments SET hypothesis = 'smuggled' WHERE experiment_id = $1`, [experimentId]),
    (error: unknown) => {
      assert.ok(String((error as { message?: string }).message).includes('declared design is immutable'));
      return true;
    },
  );
  await assert.rejects(
    db.query(`UPDATE experiments SET design_type = 'randomized', primary_metric = '{"name":"x"}'::jsonb WHERE experiment_id = $1`, [experimentId]),
    /declared design is immutable/,
  );
  // The lifecycle columns CAN change (through legal edges only).
  await db.query(`UPDATE experiments SET status = 'ready' WHERE experiment_id = $1`, [experimentId]);
  const row = await experimentRow(experimentId);
  assert.ok(row !== null);
  assert.equal(row.status, 'ready');
  assert.equal(row.hypothesis, declarationBody().hypothesis);
});

test('the transition history is append-only: UPDATE and DELETE are rejected by the DB triggers', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status, 200);
  const history = await transitionRows(experimentId);
  assert.equal(history.length, 1);
  const transitionId = history[0]!.transition_id;
  assert.ok(db !== null);
  await assert.rejects(
    db.query(`UPDATE experiment_transitions SET from_status = 'ready', to_status = 'running' WHERE transition_id = $1`, [transitionId]),
    /append-only/,
  );
  await assert.rejects(
    db.query(`DELETE FROM experiment_transitions WHERE transition_id = $1`, [transitionId]),
    /append-only/,
  );
  // And experiment rows are never deleted through the module surface (the
  // FK restricts the delete anyway).
  await assert.rejects(
    db.query(`DELETE FROM experiments WHERE experiment_id = $1`, [experimentId]),
    () => true,
  );
  const row = await experimentRow(experimentId);
  assert.ok(row !== null);
});

// ---------------------------------------------------------------------------
// EXP-AC-02 — the conclusion-type taxonomy and the causal evidence standard
// ---------------------------------------------------------------------------

test('EXP-AC-02: a CAUSAL conclusion on an observational design is rejected (422) — causality from observational correlation alone is impossible', async () => {
  for (const designType of ['observational', 'descriptive'] as const) {
    for (const resultState of ['causal_supported', 'causal_not_supported'] as const) {
      const declared = await declareExperiment(
        clientA1,
        ownerA.token,
        designType === 'observational'
          ? observationalBody()
          : observationalBody({ designType: 'descriptive', uncertaintyRepresentation: 'none' }),
      );
      assert.equal(declared.status, 201, JSON.stringify(declared.body));
      const experimentId = declared.body['experimentId'] as string;
      for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
        assert.equal(
          (await applyTransition(experimentId, ownerA.token, { transition })).status,
          200,
        );
      }
      const representation =
        designType === 'observational' ? 'qualitative' : 'none';
      const uncertainty =
        representation === 'qualitative'
          ? { kind: 'qualitative', description: 'Directionally positive; magnitude unquantified.' }
          : null;
      const rejected = await applyTransition(experimentId, ownerA.token, {
        transition: 'conclude',
        conclusion: conclusionBody({
          resultState,
          uncertainty: uncertainty as Record<string, unknown>,
        }),
      });
      assert.equal(
        rejected.status,
        422,
        `expected causal-gate rejection for ${designType} + ${resultState}: ${JSON.stringify(rejected.body)}`,
      );
      assert.ok(
        JSON.stringify(rejected.body).includes('causal evidence standard'),
        'the rejection must name the causal evidence standard',
      );
      // The experiment stays ANALYZING (nothing was mutated).
      const still = await getExperiment(experimentId, ownerA.token);
      assert.equal(still.status, 200);
      assert.equal((still.body as Record<string, unknown>)['status'], 'analyzing');
    }
  }
});

test('EXP-AC-02: attribution, observation and inconclusive conclusions are VALID on every design; causal conclusions on causal designs', async () => {
  // On the observational design: an observation conclusion is accepted.
  const observational = await declareExperiment(clientA1, ownerA.token, observationalBody());
  const observationalId = observational.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(observationalId, ownerA.token, { transition })).status, 200);
  }
  const concluded = await applyTransition(observationalId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({
      resultState: 'observation',
      uncertainty: { kind: 'qualitative', description: 'Directionally positive; magnitude unquantified.' },
      resultingDecision: null,
      evidenceRefs: [evidenceA1],
    }),
  });
  assert.equal(concluded.status, 200, JSON.stringify(concluded.body));
  assert.equal(concluded.body['resultState'], 'observation');
  // The retained conclusion distinguishes the observation type from any
  // causal value — a distinct stored value, never a free string.
  const row = await experimentRow(observationalId);
  assert.ok(row !== null);
  assert.equal(row.result_state, 'observation');

  // On a randomized design: an attribution conclusion is accepted too (it
  // is a distinct non-causal type).
  const randomized = await declareExperiment(
    clientA1,
    ownerA.token,
    declarationBody({
      analysisMethod: 'Platform-reported last-click attribution window comparison.',
    }),
  );
  const randomizedId = randomized.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(randomizedId, ownerA.token, { transition })).status, 200);
  }
  const attributed = await applyTransition(randomizedId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ resultState: 'attribution', resultingDecision: null }),
  });
  assert.equal(attributed.status, 200, JSON.stringify(attributed.body));
  assert.equal(attributed.body['resultState'], 'attribution');

  // And a causal conclusion on the causal design is accepted.
  const causal = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const causalId = causal.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(causalId, ownerA.token, { transition })).status, 200);
  }
  const causallySupported = await applyTransition(causalId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ resultState: 'causal_supported' }),
  });
  assert.equal(causallySupported.status, 200);
  assert.equal(causallySupported.body['resultState'], 'causal_supported');

  // A negative causal result is equally valid (a negative or inconclusive
  // result is a valid outcome).
  const negative = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const negativeId = negative.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(negativeId, ownerA.token, { transition })).status, 200);
  }
  const notSupported = await applyTransition(negativeId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ resultState: 'causal_not_supported', resultingDecision: null }),
  });
  assert.equal(notSupported.status, 200);
  assert.equal(notSupported.body['resultState'], 'causal_not_supported');
});

test('EXP-AC-02: the DB causal-evidence-standard CHECK rejects causal result states on observational rows even via direct SQL', async () => {
  assert.ok(db !== null);
  // A causal result state on an observational design cannot even be
  // INSERTED (row-level CHECK on experiments).
  await assert.rejects(
    db.query(
      `INSERT INTO experiments (experiment_id, client_id, hypothesis, decision_target, population_unit,
                              treatment, comparison, assignment_method, design_type, primary_metric,
                              guardrails, analysis_method, stop_criteria, minimum_evidence_requirement,
                              uncertainty_representation, status, result_state, recorded_actor,
                              recorded_via, correlation_id)
       VALUES ($1, $2, 'h', 'd', 'p', 't', 'c', 'a', 'observational', '{"name":"m"}'::jsonb,
               '[]'::jsonb, 'm', 's', 'B', 'qualitative', 'concluded', 'causal_supported',
               'user:test', 'api', 'corr-sql')`,
      [randomUUID(), clientA1],
    ),
    /experiments_causal_standard/,
  );
  // And the transition-history row is fenced the same way (a causal
  // conclusion row cannot cite an observational experiment): build a real
  // observational experiment + a legal transition row, then smuggle a
  // causal conclusion payload.
  const declared = await declareExperiment(clientA1, ownerA.token, observationalBody());
  const experimentId = declared.body['experimentId'] as string;
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status, 200);
  await assert.rejects(
    db.query(
      `INSERT INTO experiment_transitions (transition_id, experiment_id, transition, from_status,
                                 to_status, conclusion, recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, 'conclude', 'draft', 'concluded',
               $3::jsonb, 'user:test', 'api', 'corr-sql')`,
      [
        randomUUID(),
        experimentId,
        JSON.stringify({
          resultState: 'causal_supported',
          uncertainty: null,
          assumptions: [],
          sampleLimitations: [],
          confounders: [],
          resultingDecision: null,
          evidenceRefs: [],
        }),
      ],
    ),
    (error: unknown) => {
      // Either the edge CHECK (draft → concluded) or the payload CHECK
      // fires first — both are DB backstops of frozen rules; the causal
      // gate is additionally covered by the experiments-row CHECK above.
      const message = String((error as { message?: string }).message);
      assert.ok(
        message.includes('experiment_transition_edges') || message.includes('experiment_transition_payload'),
        `expected a transition CHECK rejection, got: ${message}`,
      );
      return true;
    },
  );
});

test('EXP-AC-03: an uncertainty payload mismatching the declared representation is rejected (never silently transformed)', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(experimentId, ownerA.token, { transition })).status, 200);
  }
  // Declared 'interval' — a distribution descriptor is rejected.
  const mismatch = await applyTransition(experimentId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({
      uncertainty: { kind: 'distribution', descriptor: 'normal(mean=0.02)' },
    }),
  });
  assert.equal(mismatch.status, 422, JSON.stringify(mismatch.body));
  assert.ok(JSON.stringify(mismatch.body).includes('declared uncertainty representation'));

  // A null uncertainty on a non-'none' design is rejected (never silently
  // dropped).
  const dropped = await applyTransition(experimentId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ uncertainty: undefined }),
  });
  assert.equal(dropped.status, 422, JSON.stringify(dropped.body));

  // Malformed interval bounds are rejected.
  const inverted = await applyTransition(experimentId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ uncertainty: { kind: 'interval', lower: 0.05, upper: 0.01, level: 0.95 } }),
  });
  assert.equal(inverted.status, 422);
});

test('EXP-AC-03: a conclusion payload on a non-conclude transition and a missing payload on conclude are both rejected', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  // A conclusion riding a non-conclude transition is 422.
  const smuggled = await applyTransition(experimentId, ownerA.token, {
    transition: 'mark_ready',
    conclusion: conclusionBody(),
  });
  assert.equal(smuggled.status, 422, JSON.stringify(smuggled.body));
  // conclude WITHOUT its payload is 422.
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'mark_ready' })).status, 200);
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'start' })).status, 200);
  assert.equal((await applyTransition(experimentId, ownerA.token, { transition: 'begin_analysis' })).status, 200);
  const missing = await applyTransition(experimentId, ownerA.token, { transition: 'conclude' });
  assert.equal(missing.status, 422, JSON.stringify(missing.body));
});

// ---------------------------------------------------------------------------
// Tenant isolation + authority injection negatives
// ---------------------------------------------------------------------------

test('foreign experiment identifiers are uniform 404s (no cross-tenant oracle)', async () => {
  // Agency A declares; agency B probes.
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;

  const foreignRead = await getExperiment(experimentId, ownerB.token);
  assert.equal(foreignRead.status, 404);
  const unknownRead = await getExperiment(randomUUID(), ownerA.token);
  assert.equal(unknownRead.status, 404);
  // Uniform: the two failures are indistinguishable.
  assert.equal(foreignRead.status, unknownRead.status);
  assert.deepEqual(
    (foreignRead.body as Record<string, unknown>)['code'],
    (unknownRead.body as Record<string, unknown>)['code'],
  );

  // Foreign transitions and history are 404 too — BEFORE any dependent
  // traversal.
  const foreignTransition = await applyTransition(experimentId, ownerB.token, {
    transition: 'mark_ready',
  });
  assert.equal(foreignTransition.status, 404);
  const foreignHistory = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: ownerB.token,
  });
  assert.equal(foreignHistory.status, 404);

  // A foreign CLIENT identifier is a uniform 404 on declaration.
  const foreignDeclare = await declareExperiment(clientB, ownerA.token, declarationBody());
  assert.equal(foreignDeclare.status, 404);
  const unknownDeclare = await declareExperiment(randomUUID(), ownerA.token, declarationBody());
  assert.equal(unknownDeclare.status, 404);
});

test('the Client list never leaks other tenants experiments; forged authority headers change nothing', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;

  const listA = await apiCall(port(), `/api/clients/${clientA1}/experiments`, {
    token: ownerA.token,
  });
  assert.equal(listA.status, 200);
  const experimentsA = listA.body['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(experimentsA.length >= 1);
  for (const entry of experimentsA) {
    assert.equal(entry['clientId'], clientA1);
  }
  assert.ok(experimentsA.some((entry) => entry['experimentId'] === experimentId));

  // B's list never contains A's experiment.
  const listB = await apiCall(port(), `/api/clients/${clientB}/experiments`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 200);
  const experimentsB = listB.body['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(!experimentsB.some((entry) => entry['experimentId'] === experimentId));

  // Forged authority headers on the write surface change nothing.
  const forged = await apiCall(port(), `/api/clients/${clientA1}/experiments`, {
    token: ownerA.token,
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
      'x-experiment-id': experimentId,
    },
    body: declarationBody(),
  });
  assert.equal(forged.status, 201, JSON.stringify(forged.body));
  const forgedRecord = forged.body as Record<string, unknown>;
  assert.equal(forgedRecord['clientId'], clientA1);
  assert.notEqual(forgedRecord['experimentId'], experimentId);

  // Anonymous calls are 401.
  const anonymous = await apiCall(port(), `/api/experiments/${experimentId}`);
  assert.equal(anonymous.status, 401);
  const anonymousList = await apiCall(port(), `/api/clients/${clientA1}/experiments`);
  assert.equal(anonymousList.status, 401);
});

test('provenance-shaped, lifecycle-shaped and result-shaped authority fields are rejected (422) on both write surfaces', async () => {
  for (const [label, field] of [
    ['provenance', { provenance: { actor: 'service:forged' } }],
    ['actor', { actor: 'service:forged' }],
    ['recordedAt', { recordedAt: '2020-01-01T00:00:00.000Z' }],
    ['correlationId', { correlationId: 'forged' }],
    ['status', { status: 'running' }],
    ['resultState', { resultState: 'causal_supported' }],
    ['resultingDecision', { resultingDecision: 'ship it' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await declareExperiment(clientA1, ownerA.token, declarationBody(field));
    assert.equal(rejected.status, 422, `expected 422 for create field: ${label}`);
  }

  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  for (const [label, field] of [
    ['status', { status: 'concluded' }],
    ['fromStatus', { fromStatus: 'analyzing' }],
    ['toStatus', { toStatus: 'concluded' }],
    ['resultState', { resultState: 'causal_supported' }],
    ['resultingDecision', { resultingDecision: 'ship it' }],
    ['provenance', { provenance: { actor: 'service:forged' } }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await applyTransition(experimentId, ownerA.token, {
      transition: 'mark_ready',
      ...field,
    });
    assert.equal(rejected.status, 422, `expected 422 for transition field: ${label}`);
  }
});

test('role discipline: any active member may declare and read; lifecycle transitions require owner/admin', async () => {
  // The collaborator (client_collaborator of agency A) may declare.
  const declared = await declareExperiment(clientA1, collaboratorA.token, declarationBody());
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;

  // ...and read.
  const read = await getExperiment(experimentId, collaboratorA.token);
  assert.equal(read.status, 200);

  // ...but lifecycle transitions require owner/admin (403, intra-tenant).
  const denied = await applyTransition(experimentId, collaboratorA.token, {
    transition: 'mark_ready',
  });
  assert.equal(denied.status, 403);
  const deniedHistory = await apiCall(port(), `/api/experiments/${experimentId}/transitions`, {
    token: collaboratorA.token,
  });
  assert.equal(deniedHistory.status, 200, 'history is readable by any member');
});

test('a disabled Client blocks new declarations without erasing history (409, rows intact)', async () => {
  const clientId = await makeClient(agencyA, 'Experiments Disabled Client');
  const declared = await declareExperiment(clientId, ownerA.token, declarationBody());
  assert.equal(declared.status, 201, JSON.stringify(declared.body));
  const experimentId = declared.body['experimentId'] as string;

  const clientRead = await apiCall(port(), `/api/clients/${clientId}`, { token: ownerA.token });
  assert.equal(clientRead.status, 200, JSON.stringify(clientRead.body));
  const version = (clientRead.body as Record<string, unknown>)['version'] as number;
  const disable = await apiCall(port(), `/api/clients/${clientId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  // New declarations are blocked (409).
  const blocked = await declareExperiment(clientId, ownerA.token, declarationBody());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

  // Existing designs stay intact and readable.
  const read = await getExperiment(experimentId, ownerA.token);
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['experimentId'], experimentId);
});

// ---------------------------------------------------------------------------
// Evidence citations (same-Client only; DB-fenced)
// ---------------------------------------------------------------------------

test('a FOREIGN evidence citation in the conclusion is a uniform 404; the DB trigger fences cross-tenant citations', async () => {
  const declared = await declareExperiment(clientA1, ownerA.token, declarationBody());
  const experimentId = declared.body['experimentId'] as string;
  for (const transition of ['mark_ready', 'start', 'begin_analysis'] as const) {
    assert.equal((await applyTransition(experimentId, ownerA.token, { transition })).status, 200);
  }
  // A foreign (client B) evidence id is indistinguishable from an unknown one.
  const foreign = await applyTransition(experimentId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ evidenceRefs: [evidenceB] }),
  });
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const unknown = await applyTransition(experimentId, ownerA.token, {
    transition: 'conclude',
    conclusion: conclusionBody({ evidenceRefs: [randomUUID()] }),
  });
  assert.equal(unknown.status, 404);

  // The experiment is still ANALYZING (nothing was written).
  const still = await getExperiment(experimentId, ownerA.token);
  assert.equal((still.body as Record<string, unknown>)['status'], 'analyzing');

  // The DB trigger rejects a cross-tenant citation inserted directly.
  assert.ok(db !== null);
  const row = await experimentRow(experimentId);
  assert.ok(row !== null);
  await assert.rejects(
    db.query(
      `INSERT INTO experiment_transitions (transition_id, experiment_id, transition, from_status,
                                 to_status, conclusion, recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, 'conclude', 'analyzing', 'concluded', $3::jsonb, 'user:test', 'api', 'corr-sql')`,
      [
        randomUUID(),
        experimentId,
        JSON.stringify({
          resultState: 'causal_supported',
          uncertainty: { kind: 'interval', lower: 0.01, upper: 0.02, level: 0.95 },
          assumptions: [],
          sampleLimitations: [],
          confounders: [],
          resultingDecision: null,
          evidenceRefs: [evidenceB],
        }),
      ],
    ),
    /cross-tenant evidence linkage is rejected/,
  );
});

test('the Client ledger lists experiments newest-first by server-recorded time', async () => {
  const list = await apiCall(port(), `/api/clients/${clientA1}/experiments`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const experiments = list.body['experiments'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(experiments.length >= 3, 'the fixtures are listed');
  let lastRecorded = Number.POSITIVE_INFINITY;
  for (const entry of experiments) {
    const provenance = entry['provenance'] as Record<string, unknown>;
    const recorded = Date.parse(String(provenance['recordedAt']));
    assert.ok(!Number.isNaN(recorded));
    assert.ok(recorded <= lastRecorded, 'records must be ordered newest first');
    lastRecorded = recorded;
    assert.equal(entry['clientId'], clientA1);
  }
});
