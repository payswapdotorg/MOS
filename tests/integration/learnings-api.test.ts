/**
 * MKT-016 integration test — the Learnings authority (LEARN-001,
 * acceptance LEARN-AC-01..02) against real PostgreSQL + a real API
 * subprocess.
 *
 * Proofs:
 *   - LEARN-AC-01: a persisted Learning reads back with its scope (the
 *     Client ownership + the optional Workspace scope + the applicability
 *     conditions), its supporting evidence references and experiment
 *     OUTCOME references — verified in the API response AND the durable
 *     row; the references validate through the owning authorities' public
 *     contracts (same-Client accepted; cross-Client references rejected
 *     as uniform 404s, indistinguishable from unknown ones; a
 *     non-concluded experiment is not an outcome reference — 422); the
 *     append is audited;
 *   - LEARN-AC-02 (DB/integration): contradiction and supersession each
 *     create a NEW append-only relationship row; the ORIGINAL Learning row
 *     is byte-stable after both operations (verified by full-row SQL
 *     snapshots); the derived state moves active → contradicted →
 *     superseded through the relationship history only; retirement is a
 *     third relationship kind with no successor; the history queries
 *     return the full chain (both directions); a contradicted learning is
 *     NOT terminal (later evidence keeps arriving) while superseded and
 *     retired ARE terminal (module 409s + the DB terminal-target trigger
 *     as the race backstop);
 *   - the DB fences: at most ONE superseding relationship and ONE
 *     retirement per learning (unique partial indexes — a repeat is a
 *     409); learnings AND learning_relationships are APPEND-ONLY (direct
 *     SQL UPDATE/DELETE rejected on both tables); cross-tenant
 *     relationships and cross-tenant evidence/experiment citations are
 *     rejected by DB triggers even via direct SQL;
 *   - tenant isolation negatives: foreign learning identifiers are
 *     uniform 404s (no existence oracle), foreign-client appends are 404s,
 *     foreign workspace scoping is 404, the Client list never leaks other
 *     tenants' learnings, forged authority headers change nothing,
 *     anonymous calls are 401, and a disabled Client blocks new appends
 *     (409) without erasing history;
 *   - caller-authority rejection: provenance-shaped, state-shaped and
 *     identity-shaped body fields are rejected (422) on BOTH write
 *     surfaces;
 *   - role discipline: any active member may append and read;
 *     contradiction/supersession/retirement relationships require
 *     owner/admin (collaborator 403).
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

/** A full §16 experiment declaration (causal-capable, interval uncertainty). */
function experimentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hypothesis: 'A 5-touch onboarding email sequence increases new-account activation vs the 3-touch sequence.',
    decisionTarget: 'Whether to roll the 5-touch onboarding sequence out to all new clients.',
    populationUnit: 'New client accounts created after 2026-01-01, account level.',
    treatment: '5-touch onboarding email sequence with behavioral triggers.',
    comparison: 'Current 3-touch onboarding email sequence (status quo).',
    assignmentMethod: 'Simple random assignment at account creation, 50/50.',
    designType: 'randomized',
    primaryMetric: { name: 'activation_rate', dimensions: { cohort: 'new_accounts' } },
    guardrails: [{ name: 'unsubscribe_rate', dimensions: {} }],
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

/** Runs an experiment to CONCLUDED (the outcome a Learning may reference). */
async function makeConcludedExperiment(
  clientId: string,
  token: string,
): Promise<string> {
  const declared = await apiCall(port(), `/api/clients/${clientId}/experiments`, {
    token,
    body: experimentBody(),
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
        assumptions: ['Stable delivery infrastructure during the window'],
        sampleLimitations: ['Only standard-tier accounts observed'],
        confounders: [],
        resultingDecision: 'Roll out the 5-touch sequence to all new clients.',
        evidenceRefs: [],
      },
    },
  ] as ReadonlyArray<Record<string, unknown>>) {
    const applied = await apiCall(
      port(),
      `/api/experiments/${experimentId}/transitions`,
      { token, body },
    );
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
  }
  return experimentId;
}

/** The canonical Learning append payload. */
function learningBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    statement:
      'A 5-touch onboarding email sequence increases new-account activation versus the 3-touch sequence.',
    applicability: { channel: 'email', cohort: 'new_accounts', region: 'us' },
    evidenceRefs: [],
    experimentRefs: [],
    confidence: 0.82,
    ...overrides,
  };
}

async function appendLearning(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
  options: { correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/learnings`, {
    token,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body,
  });
}

async function getLearning(
  learningId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/learnings/${learningId}`, { token });
}

async function recordRelationship(
  learningId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/learnings/${learningId}/relationships`, { token, body });
}

async function listRelationships(
  learningId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/learnings/${learningId}/relationships`, { token });
}

interface LearningRow {
  [column: string]: unknown;
  learning_id: string;
  client_id: string;
  workspace_id: string | null;
  statement: string;
  applicability: Record<string, unknown>;
  evidence_refs: ReadonlyArray<string>;
  experiment_refs: ReadonlyArray<string>;
  confidence: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

/** Full-row snapshot for the LEARN-AC-02 byte-stability proofs. */
async function learningRow(learningId: string): Promise<LearningRow | null> {
  assert.ok(db !== null);
  const result = await db.query<LearningRow>(
    'SELECT * FROM learnings WHERE learning_id = $1',
    [learningId],
  );
  return result.rows[0] ?? null;
}

async function relationshipRows(learningId: string): Promise<
  ReadonlyArray<{
    relationship_id: string;
    from_learning_id: string;
    to_learning_id: string | null;
    kind: string;
    recorded_actor: string;
    recorded_via: string;
    correlation_id: string;
    recorded_at: Date;
  }>
> {
  assert.ok(db !== null);
  const result = await db.query<{
    relationship_id: string;
    from_learning_id: string;
    to_learning_id: string | null;
    kind: string;
    recorded_actor: string;
    recorded_via: string;
    correlation_id: string;
    recorded_at: Date;
  }>(
    `SELECT relationship_id, from_learning_id, to_learning_id, kind, recorded_actor,
            recorded_via, correlation_id, recorded_at
       FROM learning_relationships
      WHERE from_learning_id = $1 OR to_learning_id = $1
      ORDER BY recorded_at ASC, relationship_id`,
    [learningId],
  );
  return result.rows;
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-learning-id': 'REPLACED_PER_TEST',
  'x-status': 'superseded',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients + one workspace),
// agency B foreign, evidence records and experiments under both clients.
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
let concludedExperimentA1 = '';
let draftExperimentA1 = '';
let concludedExperimentB = '';

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
  stack = await bootStack('learnings');
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
      body: { password: 'learnings-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'learnings-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@learnings.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@learnings.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@learnings.test', 'Agency B Owner'));

  agencyA = await makeAgency('Learnings Agency A', ownerA);
  agencyB = await makeAgency('Learnings Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Learnings Client A One');
  clientA2 = await makeClient(agencyA, 'Learnings Client A Two');
  clientB = await makeClient(agencyB, 'Learnings Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Learnings Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Learnings Workspace B');

  // Evidence records under client A1 and the foreign client B (the
  // MKT-013 authority) to exercise supporting evidence citations.
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

  // Experiments: a CONCLUDED outcome under client A1 (referenceable), a
  // DRAFT experiment under client A1 (not an outcome yet) and a CONCLUDED
  // experiment under the foreign client B.
  concludedExperimentA1 = await makeConcludedExperiment(clientA1, ownerA.token);
  const draft = await apiCall(port(), `/api/clients/${clientA1}/experiments`, {
    token: ownerA.token,
    body: experimentBody({ hypothesis: 'Draft hypothesis, never concluded.' }),
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  draftExperimentA1 = draft.body['experimentId'] as string;
  concludedExperimentB = await makeConcludedExperiment(clientB, ownerB.token);
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
// LEARN-AC-01 — the persisted Learning reads back with scope and references
// ---------------------------------------------------------------------------

test('LEARN-AC-01: an appended Learning stores statement, applicability scope and supporting references (API + durable row + audit)', async () => {
  const correlationId = randomUUID();
  const appended = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({
      workspaceId: workspaceA1,
      evidenceRefs: [evidenceA1],
      experimentRefs: [concludedExperimentA1],
    }),
    { correlationId },
  );
  assert.equal(appended.status, 201, JSON.stringify(appended.body));
  const record = appended.body;

  // The derived state starts server-chosen: ACTIVE, no successor.
  assert.equal(record['status'], 'active');
  assert.equal(record['supersededBy'], undefined);
  assert.equal(record['clientId'], clientA1);
  assert.equal(record['workspaceId'], workspaceA1);

  // The core LEARN-AC-01 fields round-trip byte-for-byte: the statement,
  // the applicability conditions (the scope under which it holds) and the
  // supporting references.
  assert.equal(record['statement'], learningBody().statement);
  assert.deepEqual(record['applicability'], {
    channel: 'email',
    cohort: 'new_accounts',
    region: 'us',
  });
  assert.deepEqual(record['evidenceRefs'], [evidenceA1]);
  assert.deepEqual(record['experimentRefs'], [concludedExperimentA1]);
  assert.equal(record['confidence'], 0.82);

  // Provenance is server-derived: the authenticated actor, 'api', the
  // request correlation, the module clock.
  const provenance = record['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId);
  assert.ok(!Number.isNaN(Date.parse(String(provenance['recordedAt']))));

  // The durable row carries the same contract (PostgreSQL is the system of
  // record — the API response is not the proof).
  const row = await learningRow(record['learningId'] as string);
  assert.ok(row !== null);
  assert.equal(row.client_id, clientA1);
  assert.equal(row.workspace_id, workspaceA1);
  assert.equal(row.statement, learningBody().statement);
  assert.deepEqual(row.applicability, {
    channel: 'email',
    cohort: 'new_accounts',
    region: 'us',
  });
  assert.deepEqual(row.evidence_refs, [evidenceA1]);
  assert.deepEqual(row.experiment_refs, [concludedExperimentA1]);
  assert.equal(Number.parseFloat(row.confidence ?? '0'), 0.82);
  assert.equal(row.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(row.recorded_via, 'api');
  assert.equal(row.correlation_id, correlationId);

  // The append is a material, audited mutation.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; correlation_id: string }>(
    `SELECT action, target_id, correlation_id FROM audit_events
      WHERE target_type = 'learning' AND target_id = $1 AND action = 'learnings.learning.appended'`,
    [record['learningId'] as string],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the append');
  assert.equal(audit.rows[0]!.correlation_id, correlationId);
});

test('LEARN-AC-01: the append guard rejects malformed Learnings at the API (fail closed)', async () => {
  for (const [label, override] of [
    ['empty statement', { statement: '' }],
    ['oversized statement', { statement: 'x'.repeat(2001) }],
    ['empty applicability', { applicability: {} }],
    ['non-object applicability', { applicability: ['channel'] }],
    ['non-scalar applicability', { applicability: { channel: { nested: true } } }],
    ['material key in applicability', { applicability: { channel: 'email', secret: 'x' } }],
    ['non-uuid evidence ref', { evidenceRefs: ['not-a-uuid'] }],
    ['duplicate experiment ref', { experimentRefs: [concludedExperimentA1, concludedExperimentA1] }],
    ['out-of-range confidence', { confidence: 1.5 }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await appendLearning(clientA1, ownerA.token, learningBody(override));
    assert.equal(rejected.status, 422, `expected 422 for: ${label}`);
  }
});

test('LEARN-AC-01: references validate through the owning authorities — foreign evidence/experiment refs are uniform 404s; a non-concluded experiment is not an outcome (422)', async () => {
  // A FOREIGN (client B) evidence id is indistinguishable from an unknown one.
  const foreignEvidence = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({ evidenceRefs: [evidenceB] }),
  );
  assert.equal(foreignEvidence.status, 404, JSON.stringify(foreignEvidence.body));
  const unknownEvidence = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({ evidenceRefs: [randomUUID()] }),
  );
  assert.equal(unknownEvidence.status, 404);
  assert.equal(foreignEvidence.status, unknownEvidence.status);
  assert.deepEqual(
    (foreignEvidence.body as Record<string, unknown>)['code'],
    (unknownEvidence.body as Record<string, unknown>)['code'],
  );

  // A FOREIGN (client B) CONCLUDED experiment is likewise a uniform 404 —
  // cross-Client outcome references are rejected through the /experiments
  // public contract.
  const foreignExperiment = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({ experimentRefs: [concludedExperimentB] }),
  );
  assert.equal(foreignExperiment.status, 404, JSON.stringify(foreignExperiment.body));
  const unknownExperiment = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({ experimentRefs: [randomUUID()] }),
  );
  assert.equal(unknownExperiment.status, 404);

  // A same-Client experiment that has NOT concluded carries no outcome —
  // a Learning may not reference it as supporting evidence.
  const notAnOutcome = await appendLearning(
    clientA1,
    ownerA.token,
    learningBody({ experimentRefs: [draftExperimentA1] }),
  );
  assert.equal(notAnOutcome.status, 422, JSON.stringify(notAnOutcome.body));
  const problem = String(
    ((notAnOutcome.body as Record<string, unknown>)['error'] as Record<string, unknown> | undefined)?.['message'],
  );
  assert.ok(
    problem.toLowerCase().includes('concluded'),
    `the rejection must name the concluded requirement: ${problem}`,
  );

  // Nothing was written for any of the rejected appends.
  assert.ok(db !== null);
  const count = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM learnings WHERE client_id = $1',
    [clientA2],
  );
  assert.equal(count.rows[0]!.count, '0');
});

test('the optional Workspace scope lands in the durable row; a foreign-Client workspace is a uniform 404', async () => {
  const scoped = await appendLearning(clientA1, ownerA.token, learningBody({ workspaceId: workspaceA1 }));
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  assert.equal((scoped.body as Record<string, unknown>)['workspaceId'], workspaceA1);
  const row = await learningRow((scoped.body as Record<string, unknown>)['learningId'] as string);
  assert.ok(row !== null);
  assert.equal(row.workspace_id, workspaceA1);

  // A workspace of ANOTHER Client (client B) is a uniform 404 — scope
  // input is never a traversal oracle.
  const foreign = await appendLearning(clientA1, ownerA.token, learningBody({ workspaceId: workspaceB }));
  assert.equal(foreign.status, 404, JSON.stringify(foreign.body));
  const unknown = await appendLearning(clientA1, ownerA.token, learningBody({ workspaceId: randomUUID() }));
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// LEARN-AC-02 — contradiction/supersession create NEW rows; the original
// row is byte-stable; the history chain is complete
// ---------------------------------------------------------------------------

test('LEARN-AC-02: contradiction creates a NEW relationship row; the original Learning row is byte-stable and its derived state becomes contradicted', async () => {
  // The EARLIER learning A (with supporting references, LEARN-AC-01 shape).
  const earlier = await appendLearning(clientA1, ownerA.token, learningBody({
    evidenceRefs: [evidenceA1],
    experimentRefs: [concludedExperimentA1],
  }));
  assert.equal(earlier.status, 201, JSON.stringify(earlier.body));
  const learningA = (earlier.body as Record<string, unknown>)['learningId'] as string;

  // The LATER learning B (the contradicting statement).
  const later = await appendLearning(clientA1, ownerA.token, learningBody({
    statement: 'The 5-touch sequence shows NO activation lift once seasonality is controlled for.',
    experimentRefs: [concludedExperimentA1],
  }));
  assert.equal(later.status, 201, JSON.stringify(later.body));
  const learningB = (later.body as Record<string, unknown>)['learningId'] as string;

  const before = await learningRow(learningA);
  assert.ok(before !== null);
  const relationshipsBefore = await relationshipRows(learningA);
  assert.equal(relationshipsBefore.length, 0);

  // Record the contradiction: B contradicts A — a NEW relationship row.
  const correlationId = randomUUID();
  const contradiction = await apiCall(port(), `/api/learnings/${learningA}/relationships`, {
    token: ownerA.token,
    correlationId,
    body: { kind: 'contradicts', toLearningId: learningB },
  });
  assert.equal(contradiction.status, 201, JSON.stringify(contradiction.body));
  const relationship = contradiction.body as Record<string, unknown>;
  assert.equal(relationship['fromLearningId'], learningA);
  assert.equal(relationship['toLearningId'], learningB);
  assert.equal(relationship['kind'], 'contradicts');
  const relationshipId = relationship['relationshipId'] as string;

  // The ORIGINAL Learning row is byte-stable: a full-row SQL snapshot is
  // identical before and after (no column was rewritten, nothing erased).
  const after = await learningRow(learningA);
  assert.ok(after !== null);
  assert.deepEqual(after, before);

  // The derived state moved — through the relationship history only.
  const read = await getLearning(learningA, ownerA.token);
  assert.equal(read.status, 200);
  const record = read.body as Record<string, unknown>;
  assert.equal(record['status'], 'contradicted');
  assert.equal(record['supersededBy'], undefined);
  assert.deepEqual(record['evidenceRefs'], [evidenceA1]);
  assert.deepEqual(record['experimentRefs'], [concludedExperimentA1]);

  // The NEW relationship row exists with server-derived provenance.
  const rows = await relationshipRows(learningA);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.relationship_id, relationshipId);
  assert.equal(rows[0]!.kind, 'contradicts');
  assert.equal(rows[0]!.to_learning_id, learningB);
  assert.equal(rows[0]!.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(rows[0]!.recorded_via, 'api');
  assert.equal(rows[0]!.correlation_id, correlationId);

  // The relationship append is audited.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string }>(
    `SELECT action FROM audit_events
      WHERE target_type = 'learning_relationship' AND target_id = $1
        AND action = 'learnings.learning.relationship_recorded'`,
    [relationshipId],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the relationship');

  // The LATER learning is unaffected (still active).
  const laterRead = await getLearning(learningB, ownerA.token);
  assert.equal((laterRead.body as Record<string, unknown>)['status'], 'active');
});

test('LEARN-AC-02: supersession after contradiction creates ANOTHER new row; the original row is byte-stable; derived state superseded + successor', async () => {
  const earlier = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningA = (earlier.body as Record<string, unknown>)['learningId'] as string;
  const contradicted = await appendLearning(clientA1, ownerA.token, learningBody({
    statement: 'Contradiction statement.',
  }));
  const learningB = (contradicted.body as Record<string, unknown>)['learningId'] as string;
  const successor = await appendLearning(clientA1, ownerA.token, learningBody({
    statement: 'Refined successor statement with tighter scope.',
  }));
  const learningC = (successor.body as Record<string, unknown>)['learningId'] as string;

  assert.equal(
    (await recordRelationship(learningA, ownerA.token, { kind: 'contradicts', toLearningId: learningB }))
      .status,
    201,
  );
  const snapshotAfterContradiction = await learningRow(learningA);
  assert.ok(snapshotAfterContradiction !== null);

  // Supersession: C supersedes A — the explicit successor relationship.
  const supersession = await recordRelationship(learningA, ownerA.token, {
    kind: 'supersedes',
    toLearningId: learningC,
  });
  assert.equal(supersession.status, 201, JSON.stringify(supersession.body));
  assert.equal((supersession.body as Record<string, unknown>)['kind'], 'supersedes');

  // The ORIGINAL row is STILL byte-stable (after contradiction AND
  // supersession).
  const after = await learningRow(learningA);
  assert.ok(after !== null);
  assert.deepEqual(after, snapshotAfterContradiction);

  // Derived state: superseded (terminal) with the successor pointer.
  const read = await getLearning(learningA, ownerA.token);
  const record = read.body as Record<string, unknown>;
  assert.equal(record['status'], 'superseded');
  assert.equal(record['supersededBy'], learningC);

  // The history chain is complete: both relationship rows, oldest first.
  const chain = await relationshipRows(learningA);
  assert.equal(chain.length, 2);
  assert.equal(chain[0]!.kind, 'contradicts');
  assert.equal(chain[1]!.kind, 'supersedes');
  assert.equal(chain[1]!.to_learning_id, learningC);

  // History queries return the full chain through the API too — including
  // from the SUCCESSOR's side (the relationship it recorded).
  const historyApi = await listRelationships(learningA, ownerA.token);
  assert.equal(historyApi.status, 200);
  const relationships = (historyApi.body as Record<string, unknown>)['relationships'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(relationships.length, 2);
  assert.equal(relationships[0]!['kind'], 'contradicts');
  assert.equal(relationships[1]!['kind'], 'supersedes');
  const successorHistory = await listRelationships(learningC, ownerA.token);
  const successorRelationships = (successorHistory.body as Record<string, unknown>)['relationships'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(successorRelationships.length, 1);
  assert.equal(successorRelationships[0]!['toLearningId'], learningC);

  // SUPERSESSION IS SINGLE-SUCCESSOR: a second supersession of the same
  // learning is a 409 (the DB fence is the race backstop).
  const secondSuccessor = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningD = (secondSuccessor.body as Record<string, unknown>)['learningId'] as string;
  const second = await recordRelationship(learningA, ownerA.token, {
    kind: 'supersedes',
    toLearningId: learningD,
  });
  assert.equal(second.status, 409, JSON.stringify(second.body));

  // TERMINAL: a superseded learning accepts no further relationships.
  const lateContradiction = await recordRelationship(learningA, ownerA.token, {
    kind: 'contradicts',
    toLearningId: learningD,
  });
  assert.equal(lateContradiction.status, 409);
  const lateRetirement = await recordRelationship(learningA, ownerA.token, { kind: 'retires' });
  assert.equal(lateRetirement.status, 409);

  // And the row is STILL byte-stable after all the rejected attempts.
  const final_ = await learningRow(learningA);
  assert.ok(final_ !== null);
  assert.deepEqual(final_, snapshotAfterContradiction);
});

test('LEARN-AC-02: retirement is a third relationship kind (no successor); retired is terminal; re-retirement is a 409', async () => {
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;
  const before = await learningRow(learningId);
  assert.ok(before !== null);

  const retirement = await recordRelationship(learningId, ownerA.token, { kind: 'retires' });
  assert.equal(retirement.status, 201, JSON.stringify(retirement.body));
  const relationship = retirement.body as Record<string, unknown>;
  assert.equal(relationship['kind'], 'retires');
  assert.equal(relationship['toLearningId'], undefined);

  // The original row is byte-stable through retirement as well.
  const after = await learningRow(learningId);
  assert.ok(after !== null);
  assert.deepEqual(after, before);

  // Derived state: retired (terminal), no successor.
  const read = await getLearning(learningId, ownerA.token);
  assert.equal((read.body as Record<string, unknown>)['status'], 'retired');
  assert.equal((read.body as Record<string, unknown>)['supersededBy'], undefined);

  // Re-retirement is a 409 (the retirement fence).
  const again = await recordRelationship(learningId, ownerA.token, { kind: 'retires' });
  assert.equal(again.status, 409);

  // A retired learning accepts no contradictions either.
  const later = await appendLearning(clientA1, ownerA.token, learningBody());
  const laterId = (later.body as Record<string, unknown>)['learningId'] as string;
  const lateContradiction = await recordRelationship(learningId, ownerA.token, {
    kind: 'contradicts',
    toLearningId: laterId,
  });
  assert.equal(lateContradiction.status, 409);
});

test('LEARN-AC-02: a CONTRADICTED learning is NOT terminal — later evidence keeps arriving, and it can still be superseded or retired', async () => {
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;
  const firstContradiction = await appendLearning(clientA1, ownerA.token, learningBody({
    statement: 'First contradicting observation.',
  }));
  const secondContradiction = await appendLearning(clientA1, ownerA.token, learningBody({
    statement: 'Second contradicting observation.',
  }));
  const first = (firstContradiction.body as Record<string, unknown>)['learningId'] as string;
  const second = (secondContradiction.body as Record<string, unknown>)['learningId'] as string;

  // Two contradictions accumulate as history rows ("Learnings have scope
  // and may be contradicted by later evidence").
  assert.equal(
    (await recordRelationship(learningId, ownerA.token, { kind: 'contradicts', toLearningId: first }))
      .status,
    201,
  );
  assert.equal(
    (await recordRelationship(learningId, ownerA.token, { kind: 'contradicts', toLearningId: second }))
      .status,
    201,
  );
  const read = await getLearning(learningId, ownerA.token);
  assert.equal((read.body as Record<string, unknown>)['status'], 'contradicted');
  const chain = await relationshipRows(learningId);
  assert.equal(chain.length, 2);

  // A contradicted learning can still be retired (contradiction is not
  // terminal).
  assert.equal(
    (await recordRelationship(learningId, ownerA.token, { kind: 'retires' })).status,
    201,
  );
  const retiredRead = await getLearning(learningId, ownerA.token);
  assert.equal((retiredRead.body as Record<string, unknown>)['status'], 'retired');
});

test('relationship input shapes: self-relationship, retires-with-successor and contradicts-without-successor are rejected (422)', async () => {
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;

  const self = await recordRelationship(learningId, ownerA.token, {
    kind: 'supersedes',
    toLearningId: learningId,
  });
  assert.equal(self.status, 422, JSON.stringify(self.body));

  const retireWithSuccessor = await recordRelationship(learningId, ownerA.token, {
    kind: 'retires',
    toLearningId: learningId,
  });
  assert.equal(retireWithSuccessor.status, 422);

  const contradictWithoutSuccessor = await recordRelationship(learningId, ownerA.token, {
    kind: 'contradicts',
  });
  assert.equal(contradictWithoutSuccessor.status, 422);

  const unknownKind = await recordRelationship(learningId, ownerA.token, {
    kind: 'replaces',
    toLearningId: learningId,
  });
  assert.equal(unknownKind.status, 422);
});

// ---------------------------------------------------------------------------
// LEARN-AC-02 — the DB-level append-only and fence backstops
// ---------------------------------------------------------------------------

test('learning rows are append-only: direct SQL UPDATE and DELETE are rejected by the DB triggers', async () => {
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;
  assert.ok(db !== null);
  await assert.rejects(
    db.query(`UPDATE learnings SET statement = 'smuggled' WHERE learning_id = $1`, [learningId]),
    (error: unknown) => {
      assert.ok(
        String((error as { message?: string }).message).includes('learnings are append-only'),
      );
      return true;
    },
  );
  await assert.rejects(
    db.query(`DELETE FROM learnings WHERE learning_id = $1`, [learningId]),
    /learnings are append-only/,
  );
  // The row is untouched.
  const row = await learningRow(learningId);
  assert.ok(row !== null);
  assert.equal(row.statement, learningBody().statement);
});

test('relationship rows are append-only: direct SQL UPDATE and DELETE are rejected by the DB triggers', async () => {
  const target = await appendLearning(clientA1, ownerA.token, learningBody());
  const targetId = (target.body as Record<string, unknown>)['learningId'] as string;
  const later = await appendLearning(clientA1, ownerA.token, learningBody());
  const laterId = (later.body as Record<string, unknown>)['learningId'] as string;
  assert.equal(
    (await recordRelationship(targetId, ownerA.token, { kind: 'contradicts', toLearningId: laterId }))
      .status,
    201,
  );
  const rows = await relationshipRows(targetId);
  assert.equal(rows.length, 1);
  const relationshipId = rows[0]!.relationship_id;
  assert.ok(db !== null);
  await assert.rejects(
    db.query(`UPDATE learning_relationships SET kind = 'supersedes' WHERE relationship_id = $1`, [
      relationshipId,
    ]),
    /learning relationships are append-only/,
  );
  await assert.rejects(
    db.query(`DELETE FROM learning_relationships WHERE relationship_id = $1`, [relationshipId]),
    /learning relationships are append-only/,
  );
});

test('the DB terminal-target trigger rejects relationships against superseded/retired learnings even via direct SQL (race backstop)', async () => {
  const target = await appendLearning(clientA1, ownerA.token, learningBody());
  const targetId = (target.body as Record<string, unknown>)['learningId'] as string;
  const later = await appendLearning(clientA1, ownerA.token, learningBody());
  const laterId = (later.body as Record<string, unknown>)['learningId'] as string;
  assert.equal(
    (await recordRelationship(targetId, ownerA.token, { kind: 'supersedes', toLearningId: laterId }))
      .status,
    201,
  );
  assert.ok(db !== null);
  // A late contradiction of the superseded target is rejected by the DB.
  await assert.rejects(
    db.query(
      `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                 recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, $3, 'contradicts', 'user:test', 'api', 'corr-sql')`,
      [randomUUID(), targetId, laterId],
    ),
    /history is terminal/,
  );
});

test('the DB fences reject a second supersession/retirement even via direct SQL, and the cross-tenant triggers fence foreign linkage', async () => {
  const target = await appendLearning(clientA1, ownerA.token, learningBody());
  const targetId = (target.body as Record<string, unknown>)['learningId'] as string;
  const laterA = await appendLearning(clientA1, ownerA.token, learningBody());
  const laterAId = (laterA.body as Record<string, unknown>)['learningId'] as string;
  const laterB = await appendLearning(clientA1, ownerA.token, learningBody());
  const laterBId = (laterB.body as Record<string, unknown>)['learningId'] as string;
  assert.equal(
    (await recordRelationship(targetId, ownerA.token, { kind: 'supersedes', toLearningId: laterAId }))
      .status,
    201,
  );
  assert.ok(db !== null);
  // A sequential second supersession is rejected by the terminal-target
  // trigger (the module's derived-status pre-check's backstop).
  await assert.rejects(
    db.query(
      `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                 recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, $3, 'supersedes', 'user:test', 'api', 'corr-sql')`,
      [randomUUID(), targetId, laterBId],
    ),
    /history is terminal/,
  );
  // A sequential second retirement is likewise rejected by the
  // terminal-target trigger (after a first retirement).
  await db.query(
    `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                               recorded_actor, recorded_via, correlation_id)
     VALUES ($1, $2, NULL, 'retires', 'user:test', 'api', 'corr-sql')`,
    [randomUUID(), laterBId],
  );
  await assert.rejects(
    db.query(
      `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                 recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, NULL, 'retires', 'user:test', 'api', 'corr-sql-2')`,
      [randomUUID(), laterBId],
    ),
    /already retired/,
  );

  // The cross-tenant RELATIONSHIP trigger: a foreign learning id can
  // never be linked (even via direct SQL).
  const foreignLearning = await appendLearning(clientB, ownerB.token, learningBody());
  const foreignId = (foreignLearning.body as Record<string, unknown>)['learningId'] as string;
  await assert.rejects(
    db.query(
      `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                 recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, $3, 'contradicts', 'user:test', 'api', 'corr-sql')`,
      [randomUUID(), laterAId, foreignId],
    ),
    /cross-tenant learning relationships are rejected/,
  );

  // The cross-tenant REFERENCE triggers on the learning row itself
  // (evidence + experiment outcomes, the migration 019 pattern).
  await assert.rejects(
    db.query(
      `INSERT INTO learnings (learning_id, client_id, statement, applicability, evidence_refs,
                      recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, 'smuggled', '{"channel":"email"}'::jsonb, $3::jsonb, 'user:test', 'api', 'corr-sql')`,
      [randomUUID(), clientA1, JSON.stringify([evidenceB])],
    ),
    /cross-tenant evidence linkage is rejected/,
  );
  await assert.rejects(
    db.query(
      `INSERT INTO learnings (learning_id, client_id, statement, applicability, experiment_refs,
                      recorded_actor, recorded_via, correlation_id)
       VALUES ($1, $2, 'smuggled', '{"channel":"email"}'::jsonb, $3::jsonb, 'user:test', 'api', 'corr-sql')`,
      [randomUUID(), clientA1, JSON.stringify([concludedExperimentB])],
    ),
    /cross-tenant experiment linkage is rejected/,
  );
});

test('the supersession/retirement unique fences are the RACE backstops: concurrent duplicates converge to one winner (direct SQL, two connections)', async () => {
  assert.ok(stack !== null);
  const raceTarget = await appendLearning(clientA1, ownerA.token, learningBody());
  const raceTargetId = (raceTarget.body as Record<string, unknown>)['learningId'] as string;
  const successorA = await appendLearning(clientA1, ownerA.token, learningBody());
  const successorAId = (successorA.body as Record<string, unknown>)['learningId'] as string;
  const successorB = await appendLearning(clientA1, ownerA.token, learningBody());
  const successorBId = (successorB.body as Record<string, unknown>)['learningId'] as string;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const conn1 = new PgDb(stack.env.databaseUrl, 1);
  const conn2 = new PgDb(stack.env.databaseUrl, 1);
  try {
    // Connection 1 inserts the superseding relationship and HOLDS the
    // transaction open (the winner).
    const winner = conn1.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                   recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, $3, 'supersedes', 'user:test', 'api', 'corr-race-1')`,
        [randomUUID(), raceTargetId, successorAId],
      );
      await sleep(500);
    });
    await sleep(120); // ensure the winner's insert is in flight first
    // Connection 2 races the SAME target with a different successor: both
    // passed the module/trigger pre-checks, the unique fence decides.
    await assert.rejects(
      conn2.query(
        `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                   recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, $3, 'supersedes', 'user:test', 'api', 'corr-race-2')`,
        [randomUUID(), raceTargetId, successorBId],
      ),
      (error: unknown) => {
        assert.ok(
          String((error as { message?: string }).message).includes('learning_supersession_fence'),
          `expected the supersession fence violation, got: ${String((error as { message?: string }).message)}`,
        );
        return true;
      },
    );
    await winner;

    // The identical retirement-fence race: one retirement wins, the
    // duplicate converges to the fence violation.
    const retireTarget = await appendLearning(clientA1, ownerA.token, learningBody());
    const retireTargetId = (retireTarget.body as Record<string, unknown>)['learningId'] as string;
    const retireWinner = conn1.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                   recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, NULL, 'retires', 'user:test', 'api', 'corr-race-3')`,
        [randomUUID(), retireTargetId],
      );
      await sleep(500);
    });
    await sleep(120);
    await assert.rejects(
      conn2.query(
        `INSERT INTO learning_relationships (relationship_id, from_learning_id, to_learning_id, kind,
                                   recorded_actor, recorded_via, correlation_id)
         VALUES ($1, $2, NULL, 'retires', 'user:test', 'api', 'corr-race-4')`,
        [randomUUID(), retireTargetId],
      ),
      (error: unknown) => {
        assert.ok(
          String((error as { message?: string }).message).includes('learning_retirement_fence'),
          `expected the retirement fence violation, got: ${String((error as { message?: string }).message)}`,
        );
        return true;
      },
    );
    await retireWinner;

    // Exactly one superseding + one retirement relationship survived per
    // target (duplicate convergence).
    assert.ok(db !== null);
    const survivors = await db.query<{ kind: string; to_learning_id: string | null }>(
      `SELECT kind, to_learning_id FROM learning_relationships
        WHERE from_learning_id IN ($1, $2)`,
      [raceTargetId, retireTargetId],
    );
    assert.equal(survivors.rows.length, 2);
    const kinds = survivors.rows.map((row) => row.kind).sort();
    assert.deepEqual(kinds, ['retires', 'supersedes']);
  } finally {
    await conn1.close();
    await conn2.close();
  }
});

// ---------------------------------------------------------------------------
// Tenant isolation negatives (the hard-boundary posture)
// ---------------------------------------------------------------------------

test('foreign learning identifiers are uniform 404s (no cross-tenant oracle)', async () => {
  // Agency A appends; agency B probes.
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;

  const foreignRead = await getLearning(learningId, ownerB.token);
  assert.equal(foreignRead.status, 404);
  const unknownRead = await getLearning(randomUUID(), ownerA.token);
  assert.equal(unknownRead.status, 404);
  // Uniform: the two failures are indistinguishable.
  assert.equal(foreignRead.status, unknownRead.status);
  assert.deepEqual(
    (foreignRead.body as Record<string, unknown>)['code'],
    (unknownRead.body as Record<string, unknown>)['code'],
  );

  // Foreign relationships and history are 404 too — BEFORE any dependent
  // traversal.
  const foreignRelationship = await recordRelationship(learningId, ownerB.token, {
    kind: 'retires',
  });
  assert.equal(foreignRelationship.status, 404);
  const foreignHistory = await listRelationships(learningId, ownerB.token);
  assert.equal(foreignHistory.status, 404);

  // A foreign LATER learning is a uniform 404 on the relationship surface.
  const foreignLater = await appendLearning(clientB, ownerB.token, learningBody());
  const foreignLaterId = (foreignLater.body as Record<string, unknown>)['learningId'] as string;
  const crossTenant = await recordRelationship(learningId, ownerA.token, {
    kind: 'contradicts',
    toLearningId: foreignLaterId,
  });
  assert.equal(crossTenant.status, 404, JSON.stringify(crossTenant.body));

  // A foreign CLIENT identifier is a uniform 404 on append.
  const foreignAppend = await appendLearning(clientB, ownerA.token, learningBody());
  assert.equal(foreignAppend.status, 404);
  const unknownAppend = await appendLearning(randomUUID(), ownerA.token, learningBody());
  assert.equal(unknownAppend.status, 404);
});

test('the Client list never leaks other tenants learnings; forged authority headers change nothing', async () => {
  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;

  const listA = await apiCall(port(), `/api/clients/${clientA1}/learnings`, {
    token: ownerA.token,
  });
  assert.equal(listA.status, 200);
  const learningsA = listA.body['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(learningsA.length >= 1);
  for (const entry of learningsA) {
    assert.equal(entry['clientId'], clientA1);
  }
  assert.ok(learningsA.some((entry) => entry['learningId'] === learningId));

  // B's list never contains A's learning.
  const listB = await apiCall(port(), `/api/clients/${clientB}/learnings`, {
    token: ownerB.token,
  });
  assert.equal(listB.status, 200);
  const learningsB = listB.body['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(!learningsB.some((entry) => entry['learningId'] === learningId));

  // Forged authority headers on the write surface change nothing: the
  // append lands under the PATH client with a server-generated identity.
  const forged = await apiCall(port(), `/api/clients/${clientA1}/learnings`, {
    token: ownerA.token,
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
      'x-learning-id': learningId,
    },
    body: learningBody(),
  });
  assert.equal(forged.status, 201, JSON.stringify(forged.body));
  const forgedRecord = forged.body as Record<string, unknown>;
  assert.equal(forgedRecord['clientId'], clientA1);
  assert.notEqual(forgedRecord['learningId'], learningId);
  assert.equal(forgedRecord['status'], 'active');

  // Anonymous calls are 401.
  const anonymous = await apiCall(port(), `/api/learnings/${learningId}`);
  assert.equal(anonymous.status, 401);
  const anonymousList = await apiCall(port(), `/api/clients/${clientA1}/learnings`);
  assert.equal(anonymousList.status, 401);
});

test('provenance-shaped, state-shaped and identity-shaped authority fields are rejected (422) on both write surfaces', async () => {
  for (const [label, field] of [
    ['provenance', { provenance: { actor: 'service:forged' } }],
    ['actor', { actor: 'service:forged' }],
    ['recordedAt', { recordedAt: '2020-01-01T00:00:00.000Z' }],
    ['correlationId', { correlationId: 'forged' }],
    ['status', { status: 'superseded' }],
    ['supersededBy', { supersededBy: randomUUID() }],
    ['learningId', { learningId: randomUUID() }],
    ['clientId', { clientId: clientB }],
    ['secret', { secret: 'material' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await appendLearning(clientA1, ownerA.token, learningBody(field));
    assert.equal(rejected.status, 422, `expected 422 for create field: ${label}`);
  }

  const appended = await appendLearning(clientA1, ownerA.token, learningBody());
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;
  for (const [label, field] of [
    ['status', { status: 'superseded' }],
    ['supersededBy', { supersededBy: randomUUID() }],
    ['relationshipId', { relationshipId: randomUUID() }],
    ['fromLearningId', { fromLearningId: randomUUID() }],
    ['provenance', { provenance: { actor: 'service:forged' } }],
    ['recordedAt', { recordedAt: '2020-01-01T00:00:00.000Z' }],
  ] as ReadonlyArray<[string, Record<string, unknown>]>) {
    const rejected = await recordRelationship(learningId, ownerA.token, {
      kind: 'retires',
      ...field,
    });
    assert.equal(rejected.status, 422, `expected 422 for relationship field: ${label}`);
  }
});

test('role discipline: any active member may append and read; relationships require owner/admin', async () => {
  // The collaborator (client_collaborator of agency A) may append.
  const appended = await appendLearning(clientA1, collaboratorA.token, learningBody());
  assert.equal(appended.status, 201, JSON.stringify(appended.body));
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;

  // ...and read, including the relationship history.
  const read = await getLearning(learningId, collaboratorA.token);
  assert.equal(read.status, 200);
  const history = await listRelationships(learningId, collaboratorA.token);
  assert.equal(history.status, 200, 'history is readable by any member');

  // ...but relationship recording requires owner/admin (403, intra-tenant).
  const denied = await recordRelationship(learningId, collaboratorA.token, { kind: 'retires' });
  assert.equal(denied.status, 403);
  const stillActive = await getLearning(learningId, ownerA.token);
  assert.equal((stillActive.body as Record<string, unknown>)['status'], 'active');
});

test('a disabled Client blocks new appends without erasing history (409, rows intact)', async () => {
  const clientId = await makeClient(agencyA, 'Learnings Disabled Client');
  const appended = await appendLearning(clientId, ownerA.token, learningBody());
  assert.equal(appended.status, 201, JSON.stringify(appended.body));
  const learningId = (appended.body as Record<string, unknown>)['learningId'] as string;

  const clientRead = await apiCall(port(), `/api/clients/${clientId}`, { token: ownerA.token });
  assert.equal(clientRead.status, 200, JSON.stringify(clientRead.body));
  const version = (clientRead.body as Record<string, unknown>)['version'] as number;
  const disable = await apiCall(port(), `/api/clients/${clientId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  // New appends are blocked (409).
  const blocked = await appendLearning(clientId, ownerA.token, learningBody());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

  // Existing learnings stay intact and readable, relationships still work
  // (history is never frozen, only new use is blocked).
  const read = await getLearning(learningId, ownerA.token);
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['learningId'], learningId);
  const row = await learningRow(learningId);
  assert.ok(row !== null);
});

test('the Client ledger lists learnings newest-first by server-recorded time (superseded included)', async () => {
  const list = await apiCall(port(), `/api/clients/${clientA1}/learnings`, {
    token: ownerA.token,
  });
  assert.equal(list.status, 200);
  const learnings = list.body['learnings'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(learnings.length >= 3, 'the fixtures are listed');
  let lastRecorded = Number.POSITIVE_INFINITY;
  for (const entry of learnings) {
    const provenance = entry['provenance'] as Record<string, unknown>;
    const recorded = Date.parse(String(provenance['recordedAt']));
    assert.ok(!Number.isNaN(recorded));
    assert.ok(recorded <= lastRecorded, 'records must be ordered newest first');
    lastRecorded = recorded;
    assert.equal(entry['clientId'], clientA1);
    // Every entry carries its derived state.
    assert.ok(['active', 'superseded', 'contradicted', 'retired'].includes(String(entry['status'])));
  }
  // Superseded learnings stay in the ledger (immutable history readable).
  assert.ok(learnings.some((entry) => entry['status'] === 'superseded'));
});
