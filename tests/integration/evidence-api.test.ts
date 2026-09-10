/**
 * MKT-013 integration test — the Evidence/provenance authority (EVID-001,
 * EVID-AC-01..03) against real PostgreSQL + a real API subprocess.
 *
 * Proofs:
 *   - EVID-AC-01: appended evidence records carry source (system+ref),
 *     timestamp (observedAt + server-stamped recordedAt), SERVER-DERIVED
 *     provenance (actor from the authenticated principal, recording system,
 *     correlation identity from the request) and traceable content +
 *     reference — verified in the API response AND the durable row; the
 *     append is audited;
 *   - EVID-AC-02: evidence is append-oriented — UPDATE and DELETE are
 *     rejected by the database itself, and supersession appends a NEW
 *     record while the prior row is byte-for-byte untouched (both rows
 *     remain readable; the prior gains supersededBy);
 *   - EVID-AC-03: model/human claims (inference/hypothesis/...) are never
 *     auto-promoted to authoritative classes (source_fact/observation):
 *     claim→authoritative supersession is rejected 422, the reverse
 *     direction is rejected too, a direct-SQL promotion attempt is rejected
 *     by the DB trigger, high confidence never promotes anything, and NO
 *     update/delete route exists (405);
 *   - tenant isolation: foreign evidence identifiers are uniform 404s (no
 *     existence oracle), foreign supersession is rejected, foreign
 *     workspace scoping is rejected, the Client list never leaks other
 *     tenants' records, forged authority headers change nothing;
 *   - caller-authority rejection: provenance-shaped, identity-shaped and
 *     supersession-shaped body fields are rejected (422) — provenance is
 *     structurally server-derived;
 *   - the append guard rejects malformed records at the API (empty
 *     content, secret-shaped content keys, missing attribution method,
 *     out-of-set quality/class, out-of-range confidence);
 *   - supersession graph: chains A→B→C, single-correction fencing (409 on
 *     a second correction), a PARALLEL supersession race converges to
 *     exactly one winner, and the role gate (owner|admin) is enforced;
 *   - scope preservation: a correction INHERITS the prior record's
 *     Workspace scope.
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

function sourceFactBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    class: 'source_fact',
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-01-15',
    observedAt: '2026-01-15T10:30:00.000Z',
    content: { metric: 'spend', value: 123.45, currency: 'USD' },
    contentRef: 'mos-objects://evidence/2026-01-15/spend.json',
    quality: 'D',
    ...overrides,
  };
}

async function appendEvidence(
  clientId: string,
  token: string,
  body: Record<string, unknown>,
  options: { correlationId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/evidence`, {
    token,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
    body,
  });
}

async function supersede(
  evidenceId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/evidence/${evidenceId}/supersede`, { token, body });
}

async function getEvidence(
  evidenceId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/evidence/${evidenceId}`, { token });
}

interface EvidenceRow {
  [column: string]: unknown;
  evidence_id: string;
  client_id: string;
  workspace_id: string | null;
  class: string;
  source_system: string;
  source_ref: string | null;
  observed_at: Date;
  content: Record<string, unknown>;
  content_ref: string | null;
  quality: string;
  confidence: string | null;
  supersedes_evidence_id: string | null;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

async function evidenceRow(evidenceId: string): Promise<EvidenceRow | null> {
  assert.ok(db !== null);
  const result = await db.query<EvidenceRow>('SELECT * FROM evidence WHERE evidence_id = $1', [
    evidenceId,
  ]);
  return result.rows[0] ?? null;
}

async function evidenceCount(clientId: string): Promise<number> {
  assert.ok(db !== null);
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM evidence WHERE client_id = $1',
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
  'x-evidence-id': 'REPLACED_PER_TEST',
  'x-recorded-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures: agency A with members (two clients + one workspace),
// agency B foreign.
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
let factA1 = '';
let inferenceA1 = '';
let factB = '';

before(async () => {
  stack = await bootStack('evidence');
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
      body: { password: 'evidence-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'evidence-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@evidence.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@evidence.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@evidence.test', 'Agency B Owner'));

  agencyA = await makeAgency('Evidence Agency A', ownerA);
  agencyB = await makeAgency('Evidence Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Evidence Client A One');
  clientA2 = await makeClient(agencyA, 'Evidence Client A Two');
  clientB = await makeClient(agencyB, 'Evidence Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Evidence Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Evidence Workspace B');

  // Authoritative + claim fixtures under client A1.
  const fact = await appendEvidence(clientA1, ownerA.token, sourceFactBody());
  assert.equal(fact.status, 201, JSON.stringify(fact.body));
  factA1 = fact.body['evidenceId'] as string;

  const inference = await appendEvidence(clientA1, ownerA.token, {
    class: 'inference',
    sourceSystem: 'model:gpt-marketing',
    observedAt: '2026-01-15T11:00:00.000Z',
    content: { conclusion: 'spend drives leads', supports: [factA1] },
    quality: 'E',
    confidence: 0.87,
  });
  assert.equal(inference.status, 201, JSON.stringify(inference.body));
  inferenceA1 = inference.body['evidenceId'] as string;

  const foreignFact = await appendEvidence(clientB, ownerB.token, sourceFactBody());
  assert.equal(foreignFact.status, 201);
  factB = foreignFact.body['evidenceId'] as string;
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

test('EVID-AC-01: appended evidence carries source, timestamp, server-derived provenance and traceable content/reference', async () => {
  const correlationId = randomUUID();
  const append = await appendEvidence(
    clientA1,
    ownerA.token,
    sourceFactBody({ sourceSystem: 'google-ads', contentRef: 'mos-objects://evidence/g.json' }),
    { correlationId },
  );
  assert.equal(append.status, 201, JSON.stringify(append.body));
  const record = append.body;

  // Source + timestamp + traceable content/reference (EVID-AC-01).
  assert.equal(record['class'], 'source_fact');
  assert.deepEqual(record['source'], { system: 'google-ads', ref: 'report/2026-01-15' });
  assert.equal(record['observedAt'], '2026-01-15T10:30:00.000Z');
  assert.deepEqual(record['content'], { metric: 'spend', value: 123.45, currency: 'USD' });
  assert.equal(record['contentRef'], 'mos-objects://evidence/g.json');
  assert.equal(record['quality'], 'D');
  assert.ok(typeof record['evidenceId'] === 'string' && (record['evidenceId'] as string).length > 0);
  assert.equal(record['clientId'], clientA1);

  // Provenance is server-derived: actor from the authenticated principal,
  // recording system, correlation identity from the request, server clock.
  const provenance = record['provenance'] as Record<string, unknown>;
  assert.equal(provenance['actor'], `user:${ownerA.userId}`);
  assert.equal(provenance['recordedVia'], 'api');
  assert.equal(provenance['correlationId'], correlationId);
  assert.ok(!Number.isNaN(Date.parse(String(provenance['recordedAt']))));
  // Fresh records carry no supersession.
  assert.equal(record['supersedes'], undefined);
  assert.equal(record['supersededBy'], undefined);

  // The durable row carries the same contract, including every provenance
  // column.
  const row = await evidenceRow(record['evidenceId'] as string);
  assert.ok(row !== null);
  assert.equal(row.class, 'source_fact');
  assert.equal(row.source_system, 'google-ads');
  assert.equal(row.source_ref, 'report/2026-01-15');
  assert.equal(row.observed_at.toISOString(), '2026-01-15T10:30:00.000Z');
  assert.deepEqual(row.content, { metric: 'spend', value: 123.45, currency: 'USD' });
  assert.equal(row.content_ref, 'mos-objects://evidence/g.json');
  assert.equal(row.quality, 'D');
  assert.equal(row.recorded_actor, `user:${ownerA.userId}`);
  assert.equal(row.recorded_via, 'api');
  assert.equal(row.correlation_id, correlationId);
  assert.ok(!Number.isNaN(Date.parse(row.recorded_at.toISOString())));

  // The append is a material, audited mutation.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; correlation_id: string }>(
    `SELECT action, target_id, correlation_id FROM audit_events
      WHERE target_type = 'evidence' AND target_id = $1 AND action = 'evidence.record.appended'`,
    [record['evidenceId'] as string],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the append');
  assert.equal(audit.rows[0]!.correlation_id, correlationId);
});

test('EVID-AC-01: service-principal appends record machine provenance; collaborators may append', async () => {
  // Internal service token: provenance actor is the service principal.
  const serviceAppend = await appendEvidence(
    clientA2,
    'integration-test-token',
    sourceFactBody({ sourceSystem: 'internal' }),
  );
  assert.equal(serviceAppend.status, 201, JSON.stringify(serviceAppend.body));
  const serviceProvenance = serviceAppend.body['provenance'] as Record<string, unknown>;
  assert.equal(serviceProvenance['actor'], 'service:Internal API token');
  assert.equal(serviceProvenance['recordedVia'], 'api');

  // Any active member of the owning agency may append evidence.
  const collaboratorAppend = await appendEvidence(
    clientA2,
    collaboratorA.token,
    sourceFactBody({ sourceSystem: 'human' }),
  );
  assert.equal(collaboratorAppend.status, 201, JSON.stringify(collaboratorAppend.body));
  const collaboratorProvenance = collaboratorAppend.body['provenance'] as Record<string, unknown>;
  assert.equal(collaboratorProvenance['actor'], `user:${collaboratorA.userId}`);
});

test('EVID-AC-02: the database rejects UPDATE and DELETE on evidence (append-only backstop)', async () => {
  assert.ok(db !== null);
  const victim = await evidenceRow(factA1);
  assert.ok(victim !== null);

  await assert.rejects(
    db.query('UPDATE evidence SET quality = $1 WHERE evidence_id = $2', ['A', factA1]),
    /append-only/,
  );
  await assert.rejects(
    db.query('UPDATE evidence SET recorded_actor = $1 WHERE evidence_id = $2', [
      'forged:actor',
      factA1,
    ]),
    /append-only/,
  );
  await assert.rejects(
    db.query('UPDATE evidence SET content = $1::jsonb WHERE evidence_id = $2', [
      JSON.stringify({ metric: 'spend', value: 999999 }),
      factA1,
    ]),
    /append-only/,
  );
  await assert.rejects(db.query('DELETE FROM evidence WHERE evidence_id = $1', [factA1]), /append-only/);

  // The row is untouched after the rejected rewrites.
  const after = await evidenceRow(factA1);
  assert.ok(after !== null);
  assert.equal(after.quality, victim.quality);
  assert.equal(after.recorded_actor, victim.recorded_actor);
  assert.deepEqual(after.content, victim.content);
});

test('EVID-AC-02: supersession appends a NEW record — the prior row is untouched history', async () => {
  const priorBefore = await evidenceRow(factA1);
  assert.ok(priorBefore !== null);
  assert.equal(priorBefore.supersedes_evidence_id, null);

  const correction = await supersede(factA1, ownerA.token, sourceFactBody({
    sourceSystem: 'meta-ads',
    sourceRef: 'report/2026-01-15-revised',
    content: { metric: 'spend', value: 120.0, currency: 'USD', note: 'restated export' },
    quality: 'C',
  }));
  assert.equal(correction.status, 201, JSON.stringify(correction.body));
  const newId = correction.body['evidenceId'] as string;
  assert.notEqual(newId, factA1);
  assert.equal(correction.body['supersedes'], factA1);
  assert.equal(correction.body['supersededBy'], undefined);

  // The NEW durable row references the prior; the prior row is byte-for-byte
  // the same EXCEPT it is now resolved as superseded (a read-side relation —
  // the stored columns never changed).
  const priorAfter = await evidenceRow(factA1);
  assert.ok(priorAfter !== null);
  assert.deepEqual(priorAfter, priorBefore, 'the prior row itself is untouched');
  const newRow = await evidenceRow(newId);
  assert.ok(newRow !== null);
  assert.equal(newRow.supersedes_evidence_id, factA1);

  // The prior record is still readable and now reports its successor.
  const priorRead = await getEvidence(factA1, ownerA.token);
  assert.equal(priorRead.status, 200);
  assert.equal((priorRead.body as Record<string, unknown>)['supersededBy'], newId);
  assert.deepEqual(
    (priorRead.body as Record<string, unknown>)['content'],
    priorBefore.content,
    'history content is not overwritten',
  );

  // The audit trail carries the supersession as its own material event.
  assert.ok(db !== null);
  const audit = await db.query<{ action: string; target_id: string; details: Record<string, unknown> }>(
    `SELECT action, target_id, details FROM audit_events
      WHERE target_type = 'evidence' AND action = 'evidence.record.superseded'
        AND details->>'supersedes' = $1`,
    [factA1],
  );
  assert.equal(audit.rows.length, 1, 'exactly one audit row for the supersession');
  assert.equal(audit.rows[0]!.target_id, newId);

  // Both records appear in the Client ledger (immutable history).
  const list = await apiCall(port(), `/api/clients/${clientA1}/evidence`, { token: ownerA.token });
  assert.equal(list.status, 200);
  const ids = (list.body['evidence'] as ReadonlyArray<Record<string, unknown>>).map(
    (entry) => entry['evidenceId'],
  );
  assert.ok(ids.includes(factA1) && ids.includes(newId));
});

test('EVID-AC-03: a claim is never auto-promoted to an authoritative class', async () => {
  const countBefore = await evidenceCount(clientA1);

  // claim → authoritative: rejected 422 with the EVID-AC-03 message.
  const promotion = await supersede(inferenceA1, ownerA.token, sourceFactBody({
    sourceSystem: 'internal',
    quality: 'D',
  }));
  assert.equal(promotion.status, 422, JSON.stringify(promotion.body));
  const promotionError = promotion.body['error'] as Record<string, unknown>;
  assert.equal(promotionError['code'], 'INVALID_REQUEST');
  assert.ok(
    JSON.stringify(promotionError).includes('never auto-promoted'),
    `the rejection must name the promotion rule: ${JSON.stringify(promotionError)}`,
  );

  // authoritative → claim: equally rejected (tier preservation). Uses a
  // FRESH authoritative record so the single-correction fence cannot mask
  // the tier rejection.
  const freshFact = await appendEvidence(clientA1, ownerA.token, sourceFactBody({
    sourceRef: 'promotion-probe/fresh',
  }));
  assert.equal(freshFact.status, 201);
  const freshFactId = freshFact.body['evidenceId'] as string;
  const laundering = await supersede(freshFactId, ownerA.token, {
    class: 'inference',
    sourceSystem: 'model:gpt-marketing',
    observedAt: '2026-01-16T09:00:00.000Z',
    content: { conclusion: 'the fact was misread' },
    quality: 'E',
  });
  assert.equal(laundering.status, 422);
  const launderingError = laundering.body['error'] as Record<string, unknown>;
  assert.ok(
    JSON.stringify(launderingError).includes('authority tier'),
    `the rejection must name tier preservation: ${JSON.stringify(launderingError)}`,
  );

  // Nothing was written and the claim is unchanged (still current).
  assert.equal(await evidenceCount(clientA1), countBefore + 1, 'only the fresh probe fact exists');
  const claim = await getEvidence(inferenceA1, ownerA.token);
  assert.equal(claim.status, 200);
  const claimBody = claim.body as Record<string, unknown>;
  assert.equal(claimBody['class'], 'inference');
  assert.equal(claimBody['supersededBy'] ?? null, null, 'the claim was not silently replaced');

  // Even a direct SQL write cannot promote (the DB trigger backstop).
  assert.ok(db !== null);
  await assert.rejects(
    db.query(
      `INSERT INTO evidence (evidence_id, client_id, class, source_system, observed_at,
                             content, quality, supersedes_evidence_id, recorded_actor,
                             recorded_via, correlation_id)
       VALUES ($1, $2, 'source_fact', 'internal', now(), '{}'::jsonb || jsonb_build_object('metric','x'),
               'D', $3, 'service:sql-probe', 'sql-probe', 'corr-probe')`,
      [randomUUID(), clientA1, inferenceA1],
    ),
    /claims are never auto-promoted/,
  );

  // Confidence never promotes: the high-confidence claim stays a claim with
  // its confidence stored as a SEPARATE dimension.
  assert.equal(claimBody['confidence'], 0.87);
  assert.equal(claimBody['class'], 'inference');
  const claimProvenance = claimBody['provenance'] as Record<string, unknown>;
  assert.equal(claimProvenance['actor'], `user:${ownerA.userId}`);
});

test('EVID-AC-03: no update or delete routes exist (append-only surface)', async () => {
  for (const [method, pathName] of [
    ['PATCH', `/api/evidence/${factA1}`],
    ['PUT', `/api/evidence/${factA1}`],
    ['DELETE', `/api/evidence/${factA1}`],
    ['PATCH', `/api/clients/${clientA1}/evidence`],
    ['DELETE', `/api/clients/${clientA1}/evidence`],
    ['DELETE', `/api/evidence/${factA1}/supersede`],
    ['PATCH', `/api/evidence/${factA1}/status`],
  ] as const) {
    const response = await apiCall(port(), pathName, {
      token: await adminToken(),
      method,
      ...(method === 'DELETE' ? {} : { body: {} }),
    });
    assert.ok(
      response.status === 405 || response.status === 404,
      `${method} ${pathName} must not mutate evidence (got ${response.status})`,
    );
  }
  // The claim survives every attempted mutation route.
  const claim = await getEvidence(inferenceA1, ownerA.token);
  assert.equal(claim.status, 200);
  assert.equal((claim.body as Record<string, unknown>)['class'], 'inference');
});

test('cross-tenant identifiers are uniform 404s — no existence oracle, no foreign supersession', async () => {
  // Foreign evidence id (owned by a Client of another Agency) and an
  // unknown id are indistinguishable: same status, same typed code (the
  // message embeds the probed identifier, which is by construction unknown
  // to the caller — the CODE carries the uniformity).
  const foreign = await getEvidence(factB, ownerA.token);
  assert.equal(foreign.status, 404);
  const unknown = await getEvidence(randomUUID(), ownerA.token);
  assert.equal(unknown.status, 404);
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.equal(foreignError['code'], unknownError['code']);
  assert.equal(foreignError['code'], 'NOT_FOUND');

  // Foreign supersession is equally uniform — and rejected before any write.
  const countBefore = await evidenceCount(clientA1);
  const foreignSupersede = await supersede(factB, ownerA.token, sourceFactBody());
  assert.equal(foreignSupersede.status, 404);
  assert.equal(await evidenceCount(clientA1), countBefore);

  // The Client list never leaks another tenant's records.
  const list = await apiCall(port(), `/api/clients/${clientA1}/evidence`, { token: ownerA.token });
  assert.equal(list.status, 200);
  const listed = JSON.stringify(list.body);
  assert.ok(!listed.includes(factB), "client A's ledger never contains B's records");
  assert.ok(!listed.includes(clientB));

  // Foreign workspace scoping is a uniform 404 (a foreign workspace id is
  // not a traversal/existence oracle).
  const scoped = await appendEvidence(clientA1, ownerA.token, sourceFactBody({
    workspaceId: workspaceB,
  }));
  assert.equal(scoped.status, 404);

  // Forged authority headers change nothing: the record resolves through
  // durable ownership only.
  const forged = await apiCall(port(), `/api/evidence/${factA1}`, {
    token: ownerA.token,
    headers: {
      ...FORGED_HEADERS,
      'x-agency-id': agencyB,
      'x-client-id': clientB,
      'x-evidence-id': factB,
    },
  });
  assert.equal(forged.status, 200);
  const forgedRecord = forged.body as Record<string, unknown>;
  assert.equal(forgedRecord['clientId'], clientA1);
  const forgedProvenance = forgedRecord['provenance'] as Record<string, unknown>;
  assert.equal(forgedProvenance['actor'], `user:${ownerA.userId}`);

  // A cross-tenant supersession attempt via direct SQL is rejected by the
  // DB trigger (Client-boundary backstop).
  assert.ok(db !== null);
  await assert.rejects(
    db.query(
      `INSERT INTO evidence (evidence_id, client_id, class, source_system, observed_at,
                             content, quality, supersedes_evidence_id, recorded_actor,
                             recorded_via, correlation_id)
       VALUES ($1, $2, 'source_fact', 'internal', now(), jsonb_build_object('metric','x'),
               'D', $3, 'service:sql-probe', 'sql-probe', 'corr-probe')`,
      [randomUUID(), clientA1, factB],
    ),
    /another client/,
  );

  // Anonymous calls never reach authorization.
  const anonymous = await apiCall(port(), `/api/evidence/${factA1}`);
  assert.equal(anonymous.status, 401);
});

test('caller-supplied authority fields are rejected — provenance is server-derived', async () => {
  for (const authorityField of [
    'actor',
    'recordedActor',
    'recordedVia',
    'recordedAt',
    'correlationId',
    'causationId',
    'provenance',
    'evidenceId',
    'clientId',
    'agencyId',
    'supersedes',
    'supersedesEvidenceId',
    'supersededBy',
    'version',
    'status',
    'secret',
  ]) {
    const attempt = await appendEvidence(clientA1, ownerA.token, sourceFactBody({
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

  // The supersede route additionally rejects workspaceId (scope-preserving).
  const scopeAttempt = await supersede(factA1, ownerA.token, sourceFactBody({
    workspaceId: workspaceA1,
  }));
  assert.equal(scopeAttempt.status, 422);
  const scopeDetails = ((scopeAttempt.body['error'] as Record<string, unknown>)['details'] as string[]) ?? [];
  assert.ok(
    scopeDetails.some((detail) => detail.startsWith('workspaceId: forbidden authority field')),
    `workspaceId rejection must be explicit: ${JSON.stringify(scopeDetails)}`,
  );

  // Unknown fields are equally rejected (strict DTO).
  const unknown = await appendEvidence(clientA1, ownerA.token, sourceFactBody({
    flavor: 'extra',
  }));
  assert.equal(unknown.status, 422);
});

test('the append guard rejects malformed records at the API (fail closed)', async () => {
  const rejects = async (body: Record<string, unknown>, needle: string): Promise<void> => {
    const attempt = await appendEvidence(clientA2, ownerA.token, body);
    assert.equal(attempt.status, 422, JSON.stringify(attempt.body));
    const error = JSON.stringify(attempt.body);
    assert.ok(error.includes(needle), `expected rejection mentioning '${needle}': ${error}`);
  };
  await rejects(sourceFactBody({ content: {} }), 'must not be empty');
  await rejects(
    sourceFactBody({ content: { nested: { password: 'never-in-evidence' } } }),
    '§21',
  );
  await rejects(
    { class: 'attribution', sourceSystem: 'internal', observedAt: '2026-01-15T10:30:00.000Z', content: { credit: 'channel-a' }, quality: 'D' },
    'declared method',
  );
  await rejects(
    { class: 'causal_estimate', sourceSystem: 'internal', observedAt: '2026-01-15T10:30:00.000Z', content: { effect: 2.1 }, quality: 'B' },
    'declared method',
  );
  // Closed-set violations are rejected by the strict route DTO first
  // (pattern checks), which is the same fail-closed posture.
  await rejects(sourceFactBody({ quality: 'G' }), 'invalid format');
  await rejects(sourceFactBody({ class: 'gut_feeling' }), 'invalid format');
  await rejects(sourceFactBody({ confidence: 1.5 }), 'must be <= 1');
  await rejects(sourceFactBody({ observedAt: 'not-a-timestamp' }), 'invalid format');
});

test('supersession graph: chains, single-correction fencing and a converging parallel race', async () => {
  // A fresh chain s1 → s2 → s3.
  const s1 = await appendEvidence(clientA2, ownerA.token, sourceFactBody({
    sourceRef: 'chain/1',
  }));
  assert.equal(s1.status, 201);
  const s1Id = s1.body['evidenceId'] as string;

  const s2 = await supersede(s1Id, ownerA.token, sourceFactBody({ sourceRef: 'chain/2' }));
  assert.equal(s2.status, 201, JSON.stringify(s2.body));
  const s2Id = s2.body['evidenceId'] as string;

  const s3 = await supersede(s2Id, ownerA.token, sourceFactBody({ sourceRef: 'chain/3' }));
  assert.equal(s3.status, 201);
  const s3Id = s3.body['evidenceId'] as string;

  const read1 = await getEvidence(s1Id, ownerA.token);
  assert.equal((read1.body as Record<string, unknown>)['supersededBy'], s2Id);
  const read2 = await getEvidence(s2Id, ownerA.token);
  const body2 = read2.body as Record<string, unknown>;
  assert.equal(body2['supersedes'], s1Id);
  assert.equal(body2['supersededBy'], s3Id);
  const read3 = await getEvidence(s3Id, ownerA.token);
  const body3 = read3.body as Record<string, unknown>;
  assert.equal(body3['supersedes'], s2Id);
  assert.equal(body3['supersededBy'] ?? null, null, 'the chain head is current');

  // A second correction of the ALREADY-superseded s1 is a 409.
  const doubleSupersede = await supersede(s1Id, ownerA.token, sourceFactBody({
    sourceRef: 'chain/late-illegal',
  }));
  assert.equal(doubleSupersede.status, 409);

  // PARALLEL race: two corrections of the same fresh record — exactly one
  // wins (the DB fence converges duplicates).
  const raceTarget = await appendEvidence(clientA2, ownerA.token, sourceFactBody({
    sourceRef: 'race/target',
  }));
  assert.equal(raceTarget.status, 201);
  const raceTargetId = raceTarget.body['evidenceId'] as string;

  const [first, second] = await Promise.all([
    supersede(raceTargetId, ownerA.token, sourceFactBody({ sourceRef: 'race/first' })),
    supersede(raceTargetId, ownerA.token, sourceFactBody({ sourceRef: 'race/second' })),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409], `exactly one winner: ${JSON.stringify(statuses)}`);
  assert.ok(db !== null);
  const successors = await db.query<{ evidence_id: string }>(
    'SELECT evidence_id FROM evidence WHERE supersedes_evidence_id = $1',
    [raceTargetId],
  );
  assert.equal(successors.rows.length, 1, 'the fence stores exactly one superseding record');
  const winnerId = (first.status === 201 ? first : second).body['evidenceId'] as string;
  assert.equal(successors.rows[0]!.evidence_id, winnerId);

  // The role gate: supersession requires owner|admin — a collaborator gets 403.
  const gated = await supersede(s3Id, collaboratorA.token, sourceFactBody({
    sourceRef: 'chain/collab',
  }));
  assert.equal(gated.status, 403);
});

test('workspace scope is preserved by corrections and validated against canonical ownership', async () => {
  // A workspace-scoped record.
  const scoped = await appendEvidence(clientA1, ownerA.token, sourceFactBody({
    workspaceId: workspaceA1,
  }));
  assert.equal(scoped.status, 201, JSON.stringify(scoped.body));
  const scopedId = scoped.body['evidenceId'] as string;
  assert.equal(scoped.body['workspaceId'], workspaceA1);

  // The correction INHERITS the prior record's workspace scope (the supersede
  // DTO rejects workspaceId — scope is not caller-settable on corrections).
  const corrected = await supersede(scopedId, ownerA.token, sourceFactBody({
    sourceRef: 'scoped/revised',
  }));
  assert.equal(corrected.status, 201, JSON.stringify(corrected.body));
  assert.equal(corrected.body['workspaceId'], workspaceA1);

  // The DB scope backstop: a cross-client workspace reference is rejected by
  // the database itself, whatever the application did.
  assert.ok(db !== null);
  await assert.rejects(
    db.query(
      `INSERT INTO evidence (evidence_id, client_id, workspace_id, class, source_system,
                             observed_at, content, quality, recorded_actor, recorded_via,
                             correlation_id)
       VALUES ($1, $2, $3, 'source_fact', 'internal', now(), jsonb_build_object('metric','x'),
               'D', 'service:sql-probe', 'sql-probe', 'corr-probe')`,
      [randomUUID(), clientA1, workspaceB],
    ),
    /does not belong to client/,
  );
});
