/**
 * MKT-014 integration test — the Metric normalization authority (METRIC-001,
 * acceptance "source/timestamp/reference mapping"; INT-001 posture: /metrics
 * owns NO provider state) against real PostgreSQL + a real API subprocess.
 *
 * Proofs:
 *   - METRIC-001 source mapping: appended observations carry the SOURCE
 *     SYSTEM (provider label and 'internal') + optional source_ref, the
 *     metric identity (name + dimensions), the value WITH unit, and a
 *     reference to the source record (source_ref; evidence_ref for internal
 *     observations) — verified in the API response AND the durable row; the
 *     append is audited;
 *   - METRIC-001 timestamp mapping: the OBSERVATION timestamp (observedAt,
 *     caller-declared, when the metric was true) is kept DISTINCT from the
 *     RETRIEVAL timestamp (retrievedAt, server-stamped at append — when the
 *     platform saw it) and from the provenance recordedAt; a caller-supplied
 *     retrievedAt is REJECTED (422 — it is an authority field);
 *   - append-oriented: the database itself rejects UPDATE and DELETE on
 *     metric_observations; corrections are NEW rows (a restated observation
 *     keeps the original row byte-for-byte untouched and both remain
 *     readable); no update/delete routes exist (405/404);
 *   - provenance is SERVER-DERIVED: actor from the authenticated principal,
 *     recording system, correlation identity from the request, server clock
 *     — machine provenance for service-principal appends; collaborators may
 *     append;
 *   - tenant isolation negatives: foreign observation identifiers are
 *     uniform 404s (no existence oracle), foreign-client appends are 404s,
 *     foreign workspace scoping is 404, the Client list never leaks other
 *     tenants' observations, forged authority headers change nothing,
 *     anonymous calls are 401, and a disabled Client blocks new appends
 *     (409) without erasing history;
 *   - evidence linkage: a same-Client evidenceRef lands in the durable row;
 *     a FOREIGN evidence reference is a uniform 404 (indistinguishable from
 *     an unknown one), and a cross-tenant link via direct SQL is rejected
 *     by the DB trigger;
 *   - caller-authority rejection: provenance-shaped, identity-shaped,
 *     ownership-shaped and retrieval-timestamp body fields are rejected
 *     (422);
 *   - the append guard rejects malformed observations at the API (fail
 *     closed);
 *   - the Client ledger lists observations newest-first.
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

function observationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    metricName: 'ad_spend',
    dimensions: { channel: 'meta', country: 'GH' },
    value: 123.45,
    unit: 'USD',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-01-15',
    observedAt: '2026-01-15T10:30:00.000Z',
    quality: 'ok',
    ...overrides,
  };
  // JSON `null` is not a valid optional-string value (the strict DTO
  // rejects it) — an absent reference is an ABSENT KEY.
  if (body['sourceRef'] === null) delete body['sourceRef'];
  if (body['aggregationMethod'] === null) delete body['aggregationMethod'];
  return body;
}

async function appendObservation(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
  options: { correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/metrics`, {
    token,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body,
  });
}

async function getObservation(
  observationId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/metrics/${observationId}`, { token });
}

interface MetricRow {
  [column: string]: unknown;
  observation_id: string;
  client_id: string;
  workspace_id: string | null;
  metric_name: string;
  dimensions: Record<string, unknown>;
  value: string;
  unit: string;
  source_system: string;
  source_ref: string | null;
  observed_at: Date;
  retrieved_at: Date;
  evidence_ref: string | null;
  quality: string;
  aggregation_method: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

async function metricRow(observationId: string): Promise<MetricRow | null> {
  assert.ok(db !== null);
  const result = await db.query<MetricRow>(
    'SELECT * FROM metric_observations WHERE observation_id = $1',
    [observationId],
  );
  return result.rows[0] ?? null;
}

async function observationCount(clientId: string): Promise<number> {
  assert.ok(db !== null);
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM metric_observations WHERE client_id = $1',
    [clientId],
  );
  return Number(result.rows[0]?.count ?? '0');
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-observation-id': 'REPLACED_PER_TEST',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients + one workspace),
// agency B foreign, one evidence record under client A1.
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
let observationA1 = '';
let observationB = '';

before(async () => {
  stack = await bootStack('metrics');
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
      body: { password: 'metrics-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'metrics-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@metrics.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@metrics.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@metrics.test', 'Agency B Owner'));

  agencyA = await makeAgency('Metrics Agency A', ownerA);
  agencyB = await makeAgency('Metrics Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Metrics Client A One');
  clientA2 = await makeClient(agencyA, 'Metrics Client A Two');
  clientB = await makeClient(agencyB, 'Metrics Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Metrics Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Metrics Workspace B');

  // An evidence record under client A1 (the MKT-013 authority) to exercise
  // the evidence_ref linkage, plus one under the foreign client B.
  const evidence = await apiCall(port(), `/api/clients/${clientA1}/evidence`, {
    token: ownerA.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'meta-ads',
      sourceRef: 'report/2026-01-15',
      observedAt: '2026-01-15T10:00:00.000Z',
      content: { metric: 'spend', value: 123.45, currency: 'USD' },
      quality: 'D',
    },
  });
  assert.equal(evidence.status, 201, JSON.stringify(evidence.body));
  evidenceA1 = evidence.body['evidenceId'] as string;

  const foreignEvidence = await apiCall(port(), `/api/clients/${clientB}/evidence`, {
    token: ownerB.token,
    body: {
      class: 'source_fact',
      sourceSystem: 'meta-ads',
      observedAt: '2026-01-15T10:00:00.000Z',
      content: { metric: 'spend', value: 50 },
      quality: 'D',
    },
  });
  assert.equal(foreignEvidence.status, 201, JSON.stringify(foreignEvidence.body));
  evidenceB = foreignEvidence.body['evidenceId'] as string;

  // Observation fixtures under client A1 and foreign client B.
  const first = await appendObservation(clientA1, ownerA.token, observationBody());
  assert.equal(first.status, 201, JSON.stringify(first.body));
  observationA1 = first.body['observationId'] as string;

  const foreign = await appendObservation(clientB, ownerB.token, observationBody());
  assert.equal(foreign.status, 201);
  observationB = foreign.body['observationId'] as string;
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

test('METRIC-001: appended observations carry source, identity, value+unit, reference and server-derived provenance', async () => {
  const correlationId = randomUUID();
  const append = await appendObservation(
    clientA1,
    ownerA.token,
    observationBody({
      sourceSystem: 'google-ads',
      sourceRef: 'report/google/2026-01-15',
      metricName: 'clicks',
      dimensions: { campaign: 'launch', country: 'GH' },
      value: 9871,
      unit: 'count',
      aggregationMethod: 'daily_sum',
      quality: 'partial',
    }),
    { correlationId },
  );
  assert.equal(append.status, 201, JSON.stringify(append.body));
  const record = append.body;

  // Source + identity + value/unit + reference (METRIC-001 mapping).
  assert.equal(record['metricName'], 'clicks');
  assert.deepEqual(record['dimensions'], { campaign: 'launch', country: 'GH' });
  assert.equal(record['value'], 9871);
  assert.equal(record['unit'], 'count');
  assert.deepEqual(record['source'], { system: 'google-ads', ref: 'report/google/2026-01-15' });
  assert.equal(record['quality'], 'partial');
  assert.equal(record['aggregationMethod'], 'daily_sum');
  assert.ok(typeof record['observationId'] === 'string' && (record['observationId'] as string).length > 0);
  assert.equal(record['clientId'], clientA1);

  // Provenance is server-derived: actor from the authenticated principal,
  // recording system, correlation identity from the request, server clock.
  const provenance = record['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId);
  assert.ok(!Number.isNaN(Date.parse(String(provenance['recordedAt']))));

  // The durable row carries the same contract, including every provenance
  // column and the dimension set.
  const row = await metricRow(record['observationId'] as string);
  assert.ok(row !== null);
  assert.equal(row.metric_name, 'clicks');
  assert.deepEqual(row.dimensions, { campaign: 'launch', country: 'GH' });
  assert.equal(Number(row.value), 9871);
  assert.equal(row.unit, 'count');
  assert.equal(row.source_system, 'google-ads');
  assert.equal(row.source_ref, 'report/google/2026-01-15');
  assert.equal(row.quality, 'partial');
  assert.equal(row.aggregation_method, 'daily_sum');
  assert.equal(row.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(row.recorded_via, 'api');
  assert.equal(row.correlation_id, correlationId);
  assert.ok(!Number.isNaN(Date.parse(row.recorded_at.toISOString())));

  // The append is a material, audited mutation.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; correlation_id: string }>(
    `SELECT action, target_id, correlation_id FROM audit_events
      WHERE target_type = 'metric_observation' AND target_id = $1 AND action = 'metrics.observation.appended'`,
    [record['observationId'] as string],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the append');
  assert.equal(audit.rows[0]!.correlation_id, correlationId);
});

test('METRIC-001: the observation timestamp stays distinct from the server-stamped retrieval and recording timestamps', async () => {
  const beforeAppend = new Date();
  const append = await appendObservation(clientA1, ownerA.token, observationBody({
    observedAt: '2026-01-15T10:30:00.000Z', // the past — when the metric was true
  }));
  assert.equal(append.status, 201, JSON.stringify(append.body));
  const record = append.body as Record<string, unknown>;

  // observedAt is the caller-declared source timestamp, byte-for-byte.
  assert.equal(record['observedAt'], '2026-01-15T10:30:00.000Z');

  // retrievedAt is SERVER-STAMPED (when the platform saw it): close to now,
  // NOT the caller-declared observation time.
  const retrievedAt = Date.parse(String(record['retrievedAt']));
  assert.ok(!Number.isNaN(retrievedAt), 'retrievedAt must parse');
  assert.ok(retrievedAt >= beforeAppend.getTime() - 1000, 'retrievedAt is the append moment');
  assert.notEqual(retrievedAt, Date.parse('2026-01-15T10:30:00.000Z'));

  // recordedAt (provenance) is its own server stamp; all three are carried
  // separately on the durable row.
  const row = await metricRow(record['observationId'] as string);
  assert.ok(row !== null);
  assert.equal(row.observed_at.toISOString(), '2026-01-15T10:30:00.000Z');
  assert.ok(row.retrieved_at.getTime() >= beforeAppend.getTime() - 1000);
  assert.ok(row.recorded_at.getTime() >= beforeAppend.getTime() - 1000);
  assert.notEqual(row.observed_at.getTime(), row.retrieved_at.getTime());

  // A caller-supplied retrievedAt is REJECTED: it is an authority field
  // (the platform's own timestamp), never a request-body value.
  const forged = await appendObservation(clientA1, ownerA.token, observationBody({
    retrievedAt: '2020-01-01T00:00:00.000Z',
  }));
  assert.equal(forged.status, 422, JSON.stringify(forged.body));
  const details = ((forged.body['error'] as Record<string, unknown>)['details'] as string[]) ?? [];
  assert.ok(
    details.some((detail) => detail.startsWith('retrievedAt: forbidden authority field')),
    `retrievedAt rejection must be explicit: ${JSON.stringify(details)}`,
  );
});

test('METRIC-001: service-principal appends record machine provenance; collaborators may append', async () => {
  // Internal service token: provenance actor is the service principal.
  const serviceAppend = await appendObservation(
    clientA2,
    'integration-test-token',
    observationBody({ sourceSystem: 'internal', sourceRef: null }),
  );
  assert.equal(serviceAppend.status, 201, JSON.stringify(serviceAppend.body));
  const serviceProvenance = serviceAppend.body['provenance'] as Record<string, unknown>;
  assert.equal(serviceProvenance['actor'], 'service:Internal API token');
  assert.equal(serviceProvenance['recordedVia'], 'api');

  // Any active member of the owning agency may append observations.
  const collaboratorAppend = await appendObservation(
    clientA2,
    collaboratorA.token,
    observationBody({ sourceSystem: 'human' }),
  );
  assert.equal(collaboratorAppend.status, 201, JSON.stringify(collaboratorAppend.body));
  const collaboratorProvenance = collaboratorAppend.body['provenance'] as Record<string, unknown>;
  assert.equal(collaboratorProvenance['actor'], `user:${collaboratorA.userId}`);
});

test('METRIC-001: evidence_ref links an internal observation to the same-Client /evidence record', async () => {
  const append = await appendObservation(clientA1, ownerA.token, observationBody({
    sourceSystem: 'internal',
    sourceRef: null,
    evidenceRef: evidenceA1,
    metricName: 'spend_from_evidence',
  }));
  assert.equal(append.status, 201, JSON.stringify(append.body));
  assert.equal(append.body['evidenceRef'], evidenceA1);

  // The durable row carries the same-Client evidence reference.
  const row = await metricRow(append.body['observationId'] as string);
  assert.ok(row !== null);
  assert.equal(row.evidence_ref, evidenceA1);
  assert.equal(row.client_id, clientA1);
});

test('append-only: the database rejects UPDATE and DELETE on metric_observations (immutable rows)', async () => {
  assert.ok(db !== null);
  const victim = await metricRow(observationA1);
  assert.ok(victim !== null);

  await assert.rejects(
    db.query('UPDATE metric_observations SET value = $1 WHERE observation_id = $2', ['999999', observationA1]),
    /append-only/,
  );
  await assert.rejects(
    db.query('UPDATE metric_observations SET recorded_actor = $1 WHERE observation_id = $2', [
      'forged:actor',
      observationA1,
    ]),
    /append-only/,
  );
  await assert.rejects(
    db.query('UPDATE metric_observations SET dimensions = $1::jsonb WHERE observation_id = $2', [
      JSON.stringify({ channel: 'forged' }),
      observationA1,
    ]),
    /append-only/,
  );
  await assert.rejects(
    db.query('DELETE FROM metric_observations WHERE observation_id = $1', [observationA1]),
    /append-only/,
  );

  // The row is untouched after the rejected rewrites.
  const after = await metricRow(observationA1);
  assert.ok(after !== null);
  assert.equal(Number(after.value), Number(victim.value));
  assert.equal(after.recorded_actor, victim.recorded_actor);
  assert.deepEqual(after.dimensions, victim.dimensions);
});

test('append-only: corrections are NEW rows — the original stays byte-for-byte untouched history', async () => {
  const original = await metricRow(observationA1);
  assert.ok(original !== null);
  const countBefore = await observationCount(clientA1);

  // A restated provider report is a NEW append carrying the same metric
  // identity (METRIC-001: "corrections are new rows").
  const correction = await appendObservation(clientA1, ownerA.token, observationBody({
    sourceRef: 'report/2026-01-15-revised',
    value: 120.0,
    quality: 'restated',
  }));
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  const newId = correction.body['observationId'] as string;
  assert.notEqual(newId, observationA1);

  // BOTH rows exist; the original is untouched.
  assert.equal(await observationCount(clientA1), countBefore + 1);
  const after = await metricRow(observationA1);
  assert.ok(after !== null);
  assert.deepEqual(after, original, 'the original row itself is untouched');
  const newRow = await metricRow(newId);
  assert.ok(newRow !== null);
  assert.equal(Number(newRow.value), 120.0);
  assert.equal(newRow.quality, 'restated');
  assert.equal(newRow.metric_name, original.metric_name);

  // Both records are readable through the ledger (immutable history).
  const list = await apiCall(port(), `/api/clients/${clientA1}/metrics`, { token: ownerA.token });
  assert.equal(list.status, 200);
  const ids = (list.body['observations'] as ReadonlyArray<Record<string, unknown>>).map(
    (entry) => entry['observationId'],
  );
  assert.ok(ids.includes(observationA1) && ids.includes(newId));
});

test('append-only: no update or delete routes exist', async () => {
  for (const [method, pathName] of [
    ['PATCH', `/api/metrics/${observationA1}`],
    ['PUT', `/api/metrics/${observationA1}`],
    ['DELETE', `/api/metrics/${observationA1}`],
    ['PATCH', `/api/clients/${clientA1}/metrics`],
    ['DELETE', `/api/clients/${clientA1}/metrics`],
    ['PATCH', `/api/metrics/${observationA1}/value`],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: await adminToken(),
      method,
      ...(method === 'DELETE' ? {} : { body: {} }),
    });
    assert.ok(
      response.status === 405 || response.status === 404,
      `${method} ${pathName} must not mutate observations (got ${response.status})`,
    );
  }
  // The observation survives every attempted mutation route.
  const read = await getObservation(observationA1, ownerA.token);
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['observationId'], observationA1);
});

test('cross-tenant identifiers are uniform 404s — no existence oracle, no foreign appends', async () => {
  // Foreign observation id (owned by a Client of another Agency) and an
  // unknown id are indistinguishable: same status, same typed code.
  const foreign = await getObservation(observationB, ownerA.token);
  assert.equal(foreign.status, 404);
  const unknown = await getObservation(randomUUID(), ownerA.token);
  assert.equal(unknown.status, 404);
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.equal(foreignError['code'], unknownError['code']);
  assert.equal(foreignError['code'], 'NOT_FOUND');

  // Appending to a foreign Client is equally rejected BEFORE any write (the
  // path Client is resolved canonically first — a foreign identifier is not
  // an authorization).
  const countBeforeA = await observationCount(clientA1);
  const foreignAppend = await appendObservation(clientB, ownerA.token, observationBody());
  assert.equal(foreignAppend.status, 404);
  assert.equal(await observationCount(clientA1), countBeforeA);
  assert.equal(await observationCount(clientB), 1, 'nothing was written to the foreign client either');

  // The Client list never leaks another tenant's observations.
  const list = await apiCall(port(), `/api/clients/${clientA1}/metrics`, { token: ownerA.token });
  assert.equal(list.status, 200);
  const listed = JSON.stringify(list.body);
  assert.ok(!listed.includes(observationB), "client A's ledger never contains B's observations");
  assert.ok(!listed.includes(clientB));

  // Foreign workspace scoping is a uniform 404 (a foreign workspace id is
  // not a traversal/existence oracle).
  const scoped = await appendObservation(clientA1, ownerA.token, observationBody({
    workspaceId: workspaceB,
  }));
  assert.equal(scoped.status, 404);

  // Workspace scoping INSIDE the owning Client works.
  const ownScoped = await appendObservation(clientA1, ownerA.token, observationBody({
    workspaceId: workspaceA1,
  }));
  assert.equal(ownScoped.status, 201, JSON.stringify(ownScoped.body));
  assert.equal(ownScoped.body['workspaceId'], workspaceA1);

  // Forged authority headers change nothing: the record resolves through
  // durable ownership only.
  const forged = await apiCall(port(), `/api/metrics/${observationA1}`, {
    token: ownerA.token,
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
      'x-observation-id': observationB,
    },
  });
  assert.equal(forged.status, 200);
  const forgedRecord = forged.body as Record<string, unknown>;
  assert.equal(forgedRecord['clientId'], clientA1);
  const forgedProvenance = forgedRecord['provenance'] as Record<string, unknown>;
  assert.equal(forgedProvenance['actor'], `user:${ownerA.userId}`);

  // A cross-tenant evidence linkage via direct SQL is rejected by the DB
  // trigger (the /evidence authority stays tenant-fenced).
  assert.ok(db !== null);
  await assert.rejects(
    db.query(
      `INSERT INTO metric_observations (observation_id, client_id, metric_name, dimensions, value,
                             unit, source_system, observed_at, retrieved_at, quality,
                             recorded_actor, recorded_via, correlation_id, evidence_ref)
       VALUES ($1, $2, 'ad_spend', '{}'::jsonb, 1, 'count', 'internal', now(), now(), 'ok',
               'service:sql-probe', 'sql-probe', 'corr-probe', $3)`,
      [randomUUID(), clientA1, evidenceB],
    ),
    /another client/,
  );

  // Anonymous calls never reach authorization.
  const anonymous = await apiCall(port(), `/api/metrics/${observationA1}`);
  assert.equal(anonymous.status, 401);
});

test('cross-tenant evidence linkage: a foreign evidenceRef is a uniform 404; the same-Client reference works', async () => {
  const countBefore = await observationCount(clientA1);
  const foreignLink = await appendObservation(clientA1, ownerA.token, observationBody({
    sourceSystem: 'internal',
    sourceRef: null,
    evidenceRef: evidenceB,
  }));
  assert.equal(foreignLink.status, 404, JSON.stringify(foreignLink.body));
  assert.equal(
    (foreignLink.body['error'] as Record<string, unknown>)['code'],
    'NOT_FOUND',
    'foreign evidence linkage is a 404',
  );
  // Indistinguishable from an unknown evidence id.
  const unknownLink = await appendObservation(clientA1, ownerA.token, observationBody({
    sourceSystem: 'internal',
    sourceRef: null,
    evidenceRef: randomUUID(),
  }));
  assert.equal(unknownLink.status, 404);
  assert.equal(
    (unknownLink.body['error'] as Record<string, unknown>)['code'],
    (foreignLink.body['error'] as Record<string, unknown>)['code'],
  );
  assert.equal(await observationCount(clientA1), countBefore, 'nothing was written');

  // The same-Client reference still works (positive control).
  const ownLink = await appendObservation(clientA1, ownerA.token, observationBody({
    sourceSystem: 'internal',
    sourceRef: null,
    evidenceRef: evidenceA1,
    metricName: 'spend_internal_ok',
  }));
  assert.equal(ownLink.status, 201, JSON.stringify(ownLink.body));
  assert.equal(ownLink.body['evidenceRef'], evidenceA1);
});

test('caller-supplied authority fields are rejected — provenance, identity and the retrieval timestamp are server-derived', async () => {
  for (const authorityField of [
    'actor',
    'recordedActor',
    'recordedVia',
    'recordedAt',
    'retrievedAt',
    'correlationId',
    'causationId',
    'provenance',
    'observationId',
    'metricId',
    'clientId',
    'agencyId',
    'version',
    'status',
    'secret',
  ]) {
    const attempt = await appendObservation(clientA1, ownerA.token, observationBody({
      [authorityField]: 'caller-supplied-authority-value',
    }));
    assert.equal(attempt.status, 422, `${authorityField} must be rejected`);
    const error = attempt.body['error'] as Record<string, unknown>;
    assert.equal(error['code'], 'INVALID_REQUEST');
    const details = (error['details'] as string[] | undefined) ?? [];
    assert.ok(
      details.some((detail) => detail.startsWith(`${authorityField}: forbidden authority field`)),
      `${authorityField} rejection must be explicit: ${JSON.stringify(details)}`,
    );
  }

  // Unknown fields are equally rejected (strict DTO).
  const unknown = await appendObservation(clientA1, ownerA.token, observationBody({
    flavor: 'extra',
  }));
  assert.equal(unknown.status, 422);
});

test('the append guard rejects malformed observations at the API (fail closed)', async () => {
  const rejects = async (body: Record<string, unknown>, needle: string): Promise<void> => {
    const attempt = await appendObservation(clientA2, ownerA.token, body);
    assert.equal(attempt.status, 422, JSON.stringify(attempt.body));
    const error = JSON.stringify(attempt.body);
    assert.ok(error.includes(needle), `expected rejection mentioning '${needle}': ${error}`);
  };
  await rejects(observationBody({ metricName: '' }), 'metricName');
  await rejects(observationBody({ dimensions: 'not-an-object' }), 'dimensions');
  await rejects(
    observationBody({ dimensions: { channel: { nested: 'object' } } }),
    'dimension values must be scalars',
  );
  await rejects(
    observationBody({ dimensions: { secret: 'never-in-metrics' } }),
    '§21',
  );
  await rejects(observationBody({ value: 'not-a-number' }), 'value');
  await rejects(observationBody({ unit: '' }), 'unit');
  await rejects(observationBody({ sourceSystem: '' }), 'sourceSystem');
  await rejects(observationBody({ observedAt: 'not-a-timestamp' }), 'invalid format');
  // Closed-set violations are rejected by the strict route DTO first
  // (pattern checks) — the same fail-closed posture.
  await rejects(observationBody({ quality: 'great' }), 'invalid format');
  await rejects(observationBody({ aggregationMethod: '' }), 'aggregationMethod');
});

test('a disabled Client blocks new observations without erasing history (409, rows intact)', async () => {
  // Fresh client, one observation, then disable the client.
  const clientId = await makeClient(agencyA, 'Metrics Disabled Client');
  const first = await appendObservation(clientId, ownerA.token, observationBody());
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const observationId = first.body['observationId'] as string;

  const clientRead = await apiCall(port(), `/api/clients/${clientId}`, { token: ownerA.token });
  assert.equal(clientRead.status, 200, JSON.stringify(clientRead.body));
  const version = (clientRead.body as Record<string, unknown>)['version'] as number;

  const disable = await apiCall(port(), `/api/clients/${clientId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'disabled', version },
  });
  assert.equal(disable.status, 200, JSON.stringify(disable.body));

  // New appends are blocked (409 — disabled Client blocks new use).
  const blocked = await appendObservation(clientId, ownerA.token, observationBody());
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));

  // History is intact and readable.
  const read = await getObservation(observationId, ownerA.token);
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['observationId'], observationId);
});

test('the Client ledger lists observations newest-first by server-recorded time', async () => {
  const list = await apiCall(port(), `/api/clients/${clientA1}/metrics`, { token: ownerA.token });
  assert.equal(list.status, 200);
  const observations = list.body['observations'] as ReadonlyArray<Record<string, unknown>>;
  assert.ok(observations.length >= 3, 'the fixtures are listed');
  let lastRecorded = Number.POSITIVE_INFINITY;
  for (const entry of observations) {
    const provenance = entry['provenance'] as Record<string, unknown>;
    const recorded = Date.parse(String(provenance['recordedAt']));
    assert.ok(!Number.isNaN(recorded));
    assert.ok(recorded <= lastRecorded, 'records must be ordered newest first');
    lastRecorded = recorded;
    assert.equal(entry['clientId'], clientA1);
  }
});
