/**
 * MKT-046 integration test — the Sales-to-Delivery Continuity orchestrator
 * against real PostgreSQL + a real API subprocess.
 *
 * Proofs (spec/architecture-v1.5.md §8; the primary contract
 * spec/operating-graph-v1.5.md "Sales-to-delivery continuity"):
 *   - THE GOLDEN PATH: an ACCEPTED proposal (a Decision Ledger record)
 *     carries into a Client-scoped Playbook + its first Version THROUGH
 *     THE EXISTING /playbooks creation commands — verified in the API
 *     response AND the durable rows (the playbook row exists in the
 *     authority's own table with the client scope; the version row is a
 *     DRAFT with the derived strategy + minimal deployment metadata);
 *     the derived carry snapshot carries ALL FIVE §8 dimensions
 *     (scope/goals/outcomes/assumptions/economics) programmatically from
 *     the proposal record — verified against the decision row's own
 *     columns (NO MANUAL RE-ENTRY);
 *   - THE PROVENANCE ROUND-TRIP: the carry ledger links the canonical
 *     proposal decisionId + the exact-content fingerprint (the version
 *     identity — read back from the decisions row itself) to the carried
 *     playbook/version; GET proposal→carry, GET carry and GET
 *     playbook→carry all resolve the linkage AND the LIVE records
 *     (live-follow: the version's status change flows through on the
 *     very next read);
 *   - §8 RE-CARRY IDEMPOTENCY: re-carrying the SAME proposal version
 *     converges to the recorded carry (200, replayed=true, NO new
 *     playbook/carry rows — the disclosed duplicate guard); the SAME
 *     idempotency key reused for a DIFFERENT decision is a 409;
 *   - THE VERSION-BUMP BATTERY: a NEW proposal version (a successor
 *     decision record — the correction + supersede flow) carries FRESH
 *     identity (a new carry + a new playbook) while the ORIGINAL carry
 *     row stays byte-stable (full-row SQL snapshots) — never rewritten;
 *   - THE PROPOSAL GATES: only an ACCEPTED proposal carries (409 for a
 *     still-'proposed' or rejected one);
 *   - THE DEPLOYMENT CARRY: the carried version is published THROUGH the
 *     frozen playbook lifecycle and the deployment is configured THROUGH
 *     the existing /deployments creation command (born DRAFT — the
 *     MKT-040 validate-before-activate gate is NEVER invoked by the
 *     carry: the status stays 'draft'); the selection is DERIVED from
 *     the published version's own deployment metadata; the one-shot
 *     deployment leg converges on replay (replayed=true) and 409s on a
 *     different key;
 *   - the DB backstops (direct SQL): the event tail rejects UPDATE and
 *     DELETE; carry rows reject DELETE; the identity columns reject
 *     UPDATE; the completion ladder is forward-only (backwards and
 *     repeated rewrites reject); cross-tenant source references reject
 *     even via direct SQL;
 *   - tenant isolation negatives: foreign decision/carry identifiers are
 *     uniform 404s; a foreign workspace is 404; a foreign workflow
 *     definition is 404 (the deployments authority's own validation);
 *     anonymous calls are 401; collaborators may READ but not carry
 *     (403); forged authority headers change nothing; an uncarried
 *     proposal and a never-carried playbook are 404s.
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
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['workspaceId'] as string;
}

async function makeGoal(clientId: string, token: string, objective: string): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: {
      objective,
      successCriteria: [
        { metric: 'activation_rate', comparator: '>=', targetValue: 0.33, unit: 'ratio', description: 'The carried objective target.' },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body['goalId'] as string;
}

/** The canonical decision record payload (the full frozen proposal vocabulary). */
function proposalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    idempotencyKey: `proposal-${randomUUID()}`,
    ...overrides,
  };
}

async function recordProposal(
  clientId: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const response = await apiCall(port(), `/api/clients/${clientId}/decisions`, {
    token,
    body: proposalBody(body),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return (response.body['decision'] as Record<string, unknown>)['decisionId'] as string;
}

async function acceptProposal(decisionId: string, token: string): Promise<void> {
  const response = await apiCall(port(), `/api/decisions/${decisionId}/disposition`, {
    token,
    body: { command: 'accept', reason: 'Commercially approved for delivery.', idempotencyKey: `accept-${randomUUID()}` },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

async function carry(
  decisionId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}/carry`, { token, body });
}

async function carryDeployment(
  carryId: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/sales-continuity/carries/${carryId}/deployment`, { token, body });
}

async function getProposalContinuity(
  decisionId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/decisions/${decisionId}/carry`, { token });
}

async function getCarryView(
  carryId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/sales-continuity/carries/${carryId}`, { token });
}

async function getPlaybookContinuity(
  playbookId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/playbooks/${playbookId}/carry`, { token });
}

async function listCarries(
  clientId: string,
  token: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/clients/${clientId}/sales-continuity/carries`, { token });
}

interface CarryRow {
  [column: string]: unknown;
  carry_id: string;
  client_id: string;
  agency_id: string;
  source_workspace_id: string | null;
  source_decision_id: string;
  source_fingerprint: string;
  carried_playbook_id: string | null;
  carried_playbook_version_id: string | null;
  carried_version_number: number | null;
  carried_deployment_id: string | null;
  carry_state: string;
  carried_payload: Record<string, unknown>;
  idempotency_key: string;
  create_fingerprint: string;
  recorded_actor: string;
  recorded_via: string;
  correlation_id: string;
  causation_id: string | null;
  recorded_at: Date;
}

interface DecisionSqlRow {
  [column: string]: unknown;
  decision_id: string;
  client_id: string;
  objective: string;
  context: string | null;
  hypothesis_summary: string;
  expected_impact: Record<string, unknown>;
  uncertainty: Record<string, unknown> | null;
  expected_cost: string | null;
  alternatives: ReadonlyArray<string>;
  create_fingerprint: string;
  disposition: string;
}

async function carryRow(carryId: string): Promise<CarryRow | null> {
  assert.ok(db !== null);
  const result = await db.query<CarryRow>(
    'SELECT * FROM sales_continuity_carries WHERE carry_id = $1',
    [carryId],
  );
  return result.rows[0] ?? null;
}

async function decisionRow(decisionId: string): Promise<DecisionSqlRow | null> {
  assert.ok(db !== null);
  const result = await db.query<DecisionSqlRow>(
    'SELECT decision_id, client_id, objective, context, hypothesis_summary, expected_impact, uncertainty, expected_cost, alternatives, create_fingerprint, disposition FROM decisions WHERE decision_id = $1',
    [decisionId],
  );
  return result.rows[0] ?? null;
}

async function countRows(sql: string, params: ReadonlyArray<string>): Promise<number> {
  assert.ok(db !== null);
  const result = await db.query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

/** Authority headers a frontend attacker might forge. */
const FORGED_HEADERS = {
  'x-platform-role': 'platform_administrator',
  'x-role': 'agency_owner',
  'x-agency-id': 'REPLACED_PER_TEST',
  'x-client-id': 'REPLACED_PER_TEST',
  'x-decision-id': 'REPLACED_PER_TEST',
  'x-carry-state': 'deployed',
  'x-provenance-actor': 'service:forged',
} as Record<string, string>;

// Shared fixtures.
const ownerA: User = { userId: '', token: '' };
const collaboratorA: User = { userId: '', token: '' };
const ownerB: User = { userId: '', token: '' };
let agencyA = '';
let agencyB = '';
let clientA1 = '';
let clientB = '';
let workspaceA1 = '';
let workspaceB = '';
let goalA1 = '';

// The golden-path fixtures (state carried between tests in file order,
// the decisions-api.test.ts pattern).
let goldenProposalId = '';            // the accepted proposal (decision A)
let goldenCarryId = '';
let goldenPlaybookId = '';
let goldenVersionId = '';
let goldenSnapshotBefore = '';        // byte-stability snapshot (version-bump battery)
let successorProposalId = '';         // the new proposal version (decision B, the correction)
let successorCarryId = '';
let uncarriedProposalId = '';         // accepted but never carried
let proposedStillId = '';             // still 'proposed' (never accepted)
let rejectedProposalId = '';          // rejected
let foreignAcceptedProposalId = '';   // client B's accepted proposal
const carryKey = `carry-${randomUUID()}`;

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
  stack = await bootStack('salescontinuity');
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
      body: { password: 'sales-continuity-password-123' },
    });
    const login = await apiCall(port(), '/api/auth/login', {
      body: { email, password: 'sales-continuity-password-123' },
    });
    assert.equal(login.status, 200);
    return { userId, token: login.body['token'] as string };
  };

  Object.assign(ownerA, await createUser('owner-a@sales-continuity.test', 'Agency A Owner'));
  Object.assign(collaboratorA, await createUser('collab-a@sales-continuity.test', 'Agency A Collaborator'));
  Object.assign(ownerB, await createUser('owner-b@sales-continuity.test', 'Agency B Owner'));

  agencyA = await makeAgency('Sales Continuity Agency A', ownerA);
  agencyB = await makeAgency('Sales Continuity Agency B', ownerB);
  await addMembership(agencyA, collaboratorA, 'client_collaborator');

  clientA1 = await makeClient(agencyA, 'Sales Continuity Client A One');
  clientB = await makeClient(agencyB, 'Sales Continuity Client B');

  workspaceA1 = await makeWorkspace(clientA1, 'Sales Continuity Workspace A1');
  workspaceB = await makeWorkspace(clientB, 'Sales Continuity Workspace B');

  goalA1 = await makeGoal(clientA1, ownerA.token, 'Lift new-account activation to 33%.');

  // The golden-path proposal: the full frozen vocabulary, accepted.
  goldenProposalId = await recordProposal(clientA1, ownerA.token);
  await acceptProposal(goldenProposalId, ownerA.token);

  // Fixtures for the gates + isolation batteries.
  uncarriedProposalId = await recordProposal(clientA1, ownerA.token);
  await acceptProposal(uncarriedProposalId, ownerA.token);

  proposedStillId = await recordProposal(clientA1, ownerA.token);
  rejectedProposalId = await recordProposal(clientA1, ownerA.token);
  const reject = await apiCall(port(), `/api/decisions/${rejectedProposalId}/disposition`, {
    token: ownerA.token,
    body: { command: 'reject', reason: 'Not approved.', idempotencyKey: `reject-${randomUUID()}` },
  });
  assert.equal(reject.status, 200, JSON.stringify(reject.body));

  foreignAcceptedProposalId = await recordProposal(clientB, ownerB.token);
  await acceptProposal(foreignAcceptedProposalId, ownerB.token);
});

after(async () => {
  if (db !== null) await db.close();
  if (api !== null) api.child.kill('SIGKILL');
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// THE GOLDEN PATH: proposal version → carried playbook + provenance
// ---------------------------------------------------------------------------

test('GOLDEN PATH: an accepted proposal carries into a Playbook + Version through the existing /playbooks commands', async () => {
  const response = await carry(goldenProposalId, ownerA.token, { idempotencyKey: carryKey });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body['replayed'], false);

  const carryRecord = response.body['carry'] as Record<string, unknown>;
  goldenCarryId = carryRecord['carryId'] as string;
  goldenPlaybookId = carryRecord['carriedPlaybookId'] as string;
  goldenVersionId = carryRecord['carriedPlaybookVersionId'] as string;

  // The ledger linkage: source references + version identity + completion.
  assert.equal((carryRecord['source'] as Record<string, unknown>)['decisionId'], goldenProposalId);
  assert.equal(carryRecord['carryState'], 'carried');
  assert.equal(carryRecord['carriedVersionNumber'], 1);
  assert.equal((carryRecord['source'] as Record<string, unknown>)['kind'], 'decision');
  assert.equal((carryRecord['source'] as Record<string, unknown>)['decisionId'], goldenProposalId);

  // The created playbook: Client-scoped to the proposal's Client, the
  // derived name, the Goal link threaded through.
  const playbook = response.body['playbook'] as Record<string, unknown>;
  assert.equal(playbook['playbookId'], goldenPlaybookId);
  assert.ok((playbook['name'] as string).startsWith('Proposal — '));

  // The created version: DRAFT #1 with the derived strategy.
  const version = response.body['playbookVersion'] as Record<string, unknown>;
  assert.equal(version['versionId'], goldenVersionId);
  assert.equal(version['versionNumber'], 1);
  assert.equal(version['status'], 'draft');

  // GROUND TRUTH: the playbook row exists in the AUTHORITY's own table
  // (created through its public command — never by this module), with
  // the client scope + goal link.
  const playbookRows = await countRows(
    'SELECT count(*)::text AS count FROM playbooks WHERE playbook_id = $1 AND client_id = $2 AND goal_id IS NULL',
    [goldenPlaybookId, clientA1],
  );
  assert.equal(playbookRows, 1, 'the carried playbook row lives in the /playbooks authority table with the client scope');

  const versionRows = await countRows(
    'SELECT count(*)::text AS count FROM playbook_versions WHERE version_id = $1 AND playbook_id = $2 AND version_number = 1 AND status = \'draft\'',
    [goldenVersionId, goldenPlaybookId],
  );
  assert.equal(versionRows, 1, 'the carried version row lives in the /playbooks authority table as draft #1');

  // GROUND TRUTH: the carry ledger row carries the exact version identity.
  const row = await carryRow(goldenCarryId);
  assert.ok(row !== null);
  const decision = await decisionRow(goldenProposalId);
  assert.ok(decision !== null);
  assert.equal(row!.source_decision_id, goldenProposalId);
  assert.equal(row!.source_fingerprint, decision!.create_fingerprint, 'the source fingerprint IS the proposal\'s exact-content fingerprint (the version identity)');
  assert.equal(row!.client_id, clientA1);
  assert.equal(row!.agency_id, agencyA);
  assert.equal(row!.carry_state, 'carried');
  assert.equal(row!.carried_playbook_id, goldenPlaybookId);
  assert.equal(row!.carried_playbook_version_id, goldenVersionId);
  assert.equal(row!.carried_version_number, 1);
  assert.equal(row!.carried_deployment_id, null);
  assert.equal(row!.recorded_via, 'api');
  assert.equal(row!.idempotency_key, carryKey);
  goldenSnapshotBefore = JSON.stringify(row);

  // GROUND TRUTH: the derived snapshot carries ALL FIVE §8 dimensions
  // programmatically from the proposal record (NO MANUAL RE-ENTRY —
  // every value equals the decision row's own column).
  const payload = row!.carried_payload;
  assert.equal(payload['derivationVersion'], 'sc-carry-v1');
  assert.deepEqual(payload['source'], {
    kind: 'decision',
    decisionId: goldenProposalId,
    fingerprint: decision!.create_fingerprint,
    disposition: 'accepted',
  });
  assert.deepEqual(payload['scope'], { objective: decision!.objective, context: decision!.context });
  assert.deepEqual((payload['outcomes'] as Record<string, unknown>)['expectedImpact'], decision!.expected_impact);
  assert.deepEqual((payload['outcomes'] as Record<string, unknown>)['uncertainty'], decision!.uncertainty);
  assert.equal((payload['economics'] as Record<string, unknown>)['expectedCost'], decision!.expected_cost);
  assert.deepEqual((payload['assumptions'] as Record<string, unknown>)['alternatives'], decision!.alternatives);
  assert.equal((payload['goals'] as Record<string, unknown>)['hypothesisSummary'], decision!.hypothesis_summary);
  // The strategy the authority persisted: the derived template's
  // description IS the proposal's expected-impact summary.
  const strategyRow = await db!.query<{ strategy: Record<string, unknown> }>(
    'SELECT strategy FROM playbook_versions WHERE version_id = $1',
    [goldenVersionId],
  );
  const strategy = strategyRow.rows[0]!.strategy;
  const templates = strategy['templates'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(templates.length, 1);
  assert.equal(
    templates[0]!['description'],
    (decision!.expected_impact as Record<string, unknown>)['summary'],
    'the carried strategy template carries the proposal outcome expectation verbatim',
  );

  // The event tail: the claim + the playbook completion.
  const events = await apiCall(port(), `/api/sales-continuity/carries/${goldenCarryId}/events`, {
    token: ownerA.token,
  });
  assert.equal(events.status, 200);
  const eventList = events.body['events'] as ReadonlyArray<Record<string, unknown>>;
  assert.deepEqual(
    eventList.map((event) => event['eventKind']),
    ['carry-claimed', 'playbook-carried'],
  );
});

test('PROVENANCE ROUND-TRIP: proposal → carried records and delivery side → proposal both resolve, with live records', async () => {
  // The proposal-anchored view.
  const proposalView = await getProposalContinuity(goldenProposalId, ownerA.token);
  assert.equal(proposalView.status, 200, JSON.stringify(proposalView.body));
  const view = proposalView.body['carry'] as Record<string, unknown>;
  assert.equal(view['carryId'], goldenCarryId);
  assert.equal((view['source'] as Record<string, unknown>)['decisionId'], goldenProposalId);
  assert.equal(view['carriedPlaybookId'], goldenPlaybookId);
  assert.equal((proposalView.body['playbookVersion'] as Record<string, unknown>)['versionId'], goldenVersionId);
  assert.equal((proposalView.body['sourceDecision'] as Record<string, unknown>)['decisionId'], goldenProposalId);

  // The carry-anchored view.
  const carryView = await getCarryView(goldenCarryId, ownerA.token);
  assert.equal(carryView.status, 200);
  assert.equal((carryView.body['carry'] as Record<string, unknown>)['carryId'], goldenCarryId);

  // THE ROUND-TRIP'S OTHER HALF: the delivery side (the carried playbook)
  // links back to the EXACT proposal version it was carried from.
  const playbookView = await getPlaybookContinuity(goldenPlaybookId, ownerA.token);
  assert.equal(playbookView.status, 200, JSON.stringify(playbookView.body));
  const roundTripCarry = playbookView.body['carry'] as Record<string, unknown>;
  assert.equal((roundTripCarry['source'] as Record<string, unknown>)['decisionId'], goldenProposalId);
  const decision = await decisionRow(goldenProposalId);
  assert.ok(decision !== null);
  assert.equal(
    (roundTripCarry['source'] as Record<string, unknown>)['fingerprint'],
    decision!.create_fingerprint,
    'the delivery side links back to the exact proposal version identity (fingerprint match)',
  );
  assert.equal(roundTripCarry['carriedPlaybookId'], goldenPlaybookId);
});

test('NO MANUAL RE-ENTRY: the carry DTO rejects every content field (the payload is derived)', async () => {
  for (const field of ['name', 'description', 'strategy', 'objective', 'expectedImpact', 'carriedPayload', 'playbookId']) {
    const response = await carry(goldenProposalId, ownerA.token, {
      idempotencyKey: `smuggle-${randomUUID()}`,
      [field]: 'smuggled content',
    });
    assert.equal(response.status, 422, `the carry DTO must reject the content field '${field}'`);
  }
});

test('§8 RE-CARRY IDEMPOTENCY: the SAME proposal version converges — no second playbook, no second carry row', async () => {
  const playbooksBefore = await countRows(
    'SELECT count(*)::text AS count FROM playbooks WHERE client_id = $1',
    [clientA1],
  );
  const carriesBefore = await countRows(
    'SELECT count(*)::text AS count FROM sales_continuity_carries WHERE client_id = $1',
    [clientA1],
  );

  // A DIFFERENT key, the SAME source: the disclosed duplicate guard
  // converges (replayed=true, the recorded carry, NO new playbook).
  const replayDifferentKey = await carry(goldenProposalId, ownerA.token, {
    idempotencyKey: `carry-again-${randomUUID()}`,
  });
  assert.equal(replayDifferentKey.status, 200, JSON.stringify(replayDifferentKey.body));
  assert.equal(replayDifferentKey.body['replayed'], true);
  const replayedCarry = replayDifferentKey.body['carry'] as Record<string, unknown>;
  assert.equal(replayedCarry['carryId'], goldenCarryId);
  assert.equal(replayedCarry['carriedPlaybookId'], goldenPlaybookId);
  assert.equal(
    (replayDifferentKey.body['playbookVersion'] as Record<string, unknown> | undefined)?.['versionId'],
    goldenVersionId,
    'the replay resolves the RECORDED playbook version (live read, no new creation)',
  );

  // The SAME key as the original: the logical fence converges too.
  const replaySameKey = await carry(goldenProposalId, ownerA.token, { idempotencyKey: carryKey });
  assert.equal(replaySameKey.status, 200);
  assert.equal(replaySameKey.body['replayed'], true);
  assert.equal((replaySameKey.body['carry'] as Record<string, unknown>)['carryId'], goldenCarryId);

  // A key reused for a DIFFERENT logical create is a 409.
  const conflict = await carry(uncarriedProposalId, ownerA.token, { idempotencyKey: carryKey });
  assert.equal(conflict.status, 409);

  // Ground truth: no new rows anywhere.
  assert.equal(
    await countRows('SELECT count(*)::text AS count FROM playbooks WHERE client_id = $1', [clientA1]),
    playbooksBefore,
    'no second playbook row',
  );
  assert.equal(
    await countRows('SELECT count(*)::text AS count FROM sales_continuity_carries WHERE client_id = $1', [clientA1]),
    carriesBefore,
    'no second carry row',
  );
});

test('PROPOSAL GATES: only an ACCEPTED proposal carries (409 otherwise)', async () => {
  const stillProposed = await carry(proposedStillId, ownerA.token, {
    idempotencyKey: `gate-1-${randomUUID()}`,
  });
  assert.equal(stillProposed.status, 409, 'a still-proposed decision has not been commercially decided');

  const rejected = await carry(rejectedProposalId, ownerA.token, {
    idempotencyKey: `gate-2-${randomUUID()}`,
  });
  assert.equal(rejected.status, 409, 'a rejected proposal was never approved for delivery');

  // An unknown decision identifier is the uniform 404.
  const unknown = await carry(randomUUID(), ownerA.token, {
    idempotencyKey: `gate-3-${randomUUID()}`,
  });
  assert.equal(unknown.status, 404);
});

// ---------------------------------------------------------------------------
// THE VERSION-BUMP BATTERY: a new proposal version carries fresh identity
// ---------------------------------------------------------------------------

test('VERSION BUMP: a successor proposal version carries FRESH identity; the old carried identity is never rewritten', async () => {
  // The correction flow (the frozen disposition machine supersedes from
  // 'proposed' only — corrections precede acceptance): create the
  // original proposal, create the correction naming it as predecessor,
  // supersede the original with the correction, then accept the
  // correction. The correction IS the new proposal version.
  const versionedOriginal = await recordProposal(clientA1, ownerA.token, {
    objective: 'Whether to roll the 5-touch onboarding sequence out to all new clients (v1).',
  });
  successorProposalId = await recordProposal(clientA1, ownerA.token, {
    objective: 'Whether to roll the 6-touch onboarding sequence out to all new clients (v2).',
    predecessorDecisionId: versionedOriginal,
  });
  const supersede = await apiCall(port(), `/api/decisions/${versionedOriginal}/disposition`, {
    token: ownerA.token,
    body: {
      command: 'supersede',
      reason: 'Superseded by the 6-touch correction.',
      successorDecisionId: successorProposalId,
      idempotencyKey: `supersede-${randomUUID()}`,
    },
  });
  assert.equal(supersede.status, 200, JSON.stringify(supersede.body));
  await acceptProposal(successorProposalId, ownerA.token);

  // The superseded original is not carryable (its live correction is the
  // successor — carry that instead).
  const supersededCarry = await carry(versionedOriginal, ownerA.token, {
    idempotencyKey: `superseded-${randomUUID()}`,
  });
  assert.equal(supersededCarry.status, 409, 'a superseded proposal is not carryable (carry its successor)');

  // The successor — the NEW proposal version — carries with FRESH
  // identity.
  const successorCarry = await carry(successorProposalId, ownerA.token, {
    idempotencyKey: `carry-successor-${randomUUID()}`,
  });
  assert.equal(successorCarry.status, 201, JSON.stringify(successorCarry.body));
  assert.equal(successorCarry.body['replayed'], false);
  successorCarryId = (successorCarry.body['carry'] as Record<string, unknown>)['carryId'] as string;
  const successorPlaybookId = (successorCarry.body['carry'] as Record<string, unknown>)['carriedPlaybookId'] as string;

  assert.notEqual(successorCarryId, goldenCarryId, 'fresh carry identity');
  assert.notEqual(successorPlaybookId, goldenPlaybookId, 'fresh playbook identity');

  // The OLD carried identity is preserved BYTE-STABLE (the full row
  // snapshot taken in the golden path is unchanged through the version
  // bump — never rewritten).
  const rowAfter = await carryRow(goldenCarryId);
  assert.ok(rowAfter !== null);
  assert.equal(JSON.stringify(rowAfter), goldenSnapshotBefore, 'the original carry row is byte-stable through the version bump');

  // The listing: the client's carries include both identities.
  const listing = await listCarries(clientA1, ownerA.token);
  assert.equal(listing.status, 200);
  const listed = listing.body['carries'] as ReadonlyArray<Record<string, unknown>>;
  assert.equal(listed.length, 2);
  assert.deepEqual(
    listed.map((entry) => entry['carryId']).sort(),
    [goldenCarryId, successorCarryId].sort(),
  );
});

// ---------------------------------------------------------------------------
// THE DEPLOYMENT CARRY (where applicable)
// ---------------------------------------------------------------------------

test('DEPLOYMENT CARRY: the carried version is published through the frozen lifecycle and the deployment configured through the existing command (born DRAFT)', async () => {
  // The natural operator flow (the /workflows authority requires a
  // definition's pinned playbook version to be PUBLISHED before the
  // definition itself can activate, and the /deployments authority
  // requires ACTIVE definitions — so publication precedes the delivery
  // work products): publish the carried version through the /playbooks
  // authority's own lifecycle routes, then create + activate the
  // workflow definition of workspaceA1 linked to the carried version.
  for (const [status, versionNumber] of [['review', 1], ['published', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/playbooks/${goldenPlaybookId}/versions/${goldenVersionId}/status`,
      { token: ownerA.token, method: 'PATCH', body: { status, version: versionNumber } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  const workflow = await apiCall(port(), `/api/workspaces/${workspaceA1}/workflows`, {
    token: ownerA.token,
    body: { name: 'MKT-046 Carry Workflow', description: 'The carried delivery workflow.' },
  });
  assert.equal(workflow.status, 201, JSON.stringify(workflow.body));
  const workflowId = workflow.body['workflowId'] as string;

  const emptySchema = { type: 'object', properties: {}, required: [] };
  const definition = await apiCall(port(), `/api/workflows/${workflowId}/definitions`, {
    token: ownerA.token,
    body: {
      graph: {
        nodes: [
          {
            nodeId: 'a',
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
          },
          {
            nodeId: 't',
            nodeType: 'terminal',
            inputMapping: {},
            outputSchema: { type: 'object', properties: {}, required: [] },
            executionPolicyRef: null,
            retryPolicy: null,
            timeout: null,
            idempotencyKeyStrategy: null,
            humanApproval: null,
            join: null,
            loop: null,
          },
        ],
        edges: [{ fromNode: 'a', toNode: 't', edgeType: 'success', predicateRef: null, joinSemantics: null }],
      },
      inputSchema: { ...emptySchema },
      outputSchema: { ...emptySchema },
      retryPolicyDefaults: {},
      concurrencyLimits: {},
      timeoutPolicy: {},
      compensation: [],
      playbookVersionId: goldenVersionId,
    },
  });
  assert.equal(definition.status, 201, JSON.stringify(definition.body));
  const definitionId = definition.body['workflowDefinitionId'] as string;
  for (const [status, versionNumber] of [['review', 1], ['active', 2]] as const) {
    const transition = await apiCall(
      port(),
      `/api/workflows/${workflowId}/definitions/${definitionId}/status`,
      { token: ownerA.token, method: 'PATCH', body: { status, version: versionNumber } },
    );
    assert.equal(transition.status, 200, JSON.stringify(transition.body));
  }

  // THE DEPLOYMENT CARRY: the workspace + the workflow definition
  // references are the caller's only inputs.
  const deploymentKey = `deploy-carry-${randomUUID()}`;
  const response = await carryDeployment(goldenCarryId, ownerA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [definitionId],
    idempotencyKey: deploymentKey,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body['replayed'], false);

  const carryRecord = response.body['carry'] as Record<string, unknown>;
  assert.equal(carryRecord['carryState'], 'deployed');
  assert.equal(carryRecord['carriedDeploymentId'] !== null, true);

  const deployment = response.body['deployment'] as Record<string, unknown>;
  const deploymentId = deployment['deploymentId'] as string;
  assert.equal(deployment['workspaceId'], workspaceA1);
  assert.equal(deployment['status'], 'draft', 'the deployment is born DRAFT — the MKT-040 validate-before-activate gate is NEVER invoked by the carry');
  assert.equal(deployment['playbookVersionId'], goldenVersionId, 'the deployment pins the CARRIED version');

  // GROUND TRUTH: the deployment row exists in the authority's own table
  // with the DERIVED selection (the published version's own deployment
  // metadata: no packs, no capabilities, no runtime class, no triggers).
  const deploymentRows = await db!.query<{
    status: string;
    playbook_version_id: string;
    workflow_definition_ids: ReadonlyArray<string>;
    required_domain_packs: ReadonlyArray<unknown>;
    required_capabilities: ReadonlyArray<unknown>;
    runtime_requirements: Record<string, unknown>;
    trigger_config: ReadonlyArray<unknown>;
  }>(
    'SELECT status, playbook_version_id, workflow_definition_ids, required_domain_packs, required_capabilities, runtime_requirements, trigger_config FROM deployments WHERE deployment_id = $1',
    [deploymentId],
  );
  const row = deploymentRows.rows[0];
  assert.ok(row !== undefined);
  assert.equal(row!.status, 'draft');
  assert.equal(row!.playbook_version_id, goldenVersionId);
  assert.deepEqual([...row!.workflow_definition_ids], [definitionId]);
  assert.deepEqual([...row!.required_domain_packs], []);
  assert.deepEqual([...row!.required_capabilities], []);
  assert.equal((row!.runtime_requirements as Record<string, unknown>)['runtimeClass'], 'pooled-worker');
  assert.deepEqual([...row!.trigger_config], [{ kind: 'manual', config: null }]);

  // GROUND TRUTH: the carried version is now PUBLISHED (moved through
  // the frozen lifecycle by the carry's orchestrated commands).
  const versionStatus = await db!.query<{ status: string }>(
    'SELECT status FROM playbook_versions WHERE version_id = $1',
    [goldenVersionId],
  );
  assert.equal(versionStatus.rows[0]!.status, 'published');

  // LIVE-FOLLOW: the continuity view resolves the version's LIVE status
  // (published) and the deployment's live state — never a stale copy.
  const view = await getProposalContinuity(goldenProposalId, ownerA.token);
  assert.equal(view.status, 200);
  assert.equal((view.body['playbookVersion'] as Record<string, unknown>)['status'], 'published');
  assert.equal((view.body['deployment'] as Record<string, unknown>)['deploymentId'], deploymentId);

  // The event tail now carries the deployment completion.
  const events = await apiCall(port(), `/api/sales-continuity/carries/${goldenCarryId}/events`, {
    token: ownerA.token,
  });
  assert.equal(events.status, 200);
  assert.deepEqual(
    (events.body['events'] as ReadonlyArray<Record<string, unknown>>).map((event) => event['eventKind']),
    ['carry-claimed', 'playbook-carried', 'deployment-carried'],
  );

  // §8 replay: the same key converges to the recorded deployment.
  const replay = await carryDeployment(goldenCarryId, ownerA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [definitionId],
    idempotencyKey: deploymentKey,
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['replayed'], true);
  assert.equal((replay.body['deployment'] as Record<string, unknown>)['deploymentId'], deploymentId);

  // The one-shot rule: a DIFFERENT key against the deployed carry 409s.
  const oneShot = await carryDeployment(goldenCarryId, ownerA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [definitionId],
    idempotencyKey: `deploy-again-${randomUUID()}`,
  });
  assert.equal(oneShot.status, 409, 'one carry carries into one deployment (the disclosed one-shot)');

  // THE TWO-PHASE PUBLISH-LEG PROOF (the successor carry's version is
  // still DRAFT): the deployment carry walks the frozen ladder (draft →
  // review → published through the orchestrated commands) and the
  // /deployments authority's own validation then rejects the golden
  // definition — it is linked to the GOLDEN version, not the successor's
  // pinned version (the authority's semantics are never bypassed; the
  // command is retryable — no completion was recorded).
  const successorVersionId = (await carryRow(successorCarryId))!.carried_playbook_version_id!;
  const draftAttempt = await carryDeployment(successorCarryId, ownerA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [definitionId],
    idempotencyKey: `successor-deploy-${randomUUID()}`,
  });
  assert.equal(
    draftAttempt.status,
    409,
    'the /deployments authority rejects a definition not linked to the pinned version (immutable-version compatibility — its own honest conflict class)',
  );
  assert.match(
    String((draftAttempt.body['error'] as Record<string, unknown>)['message']),
    /does not pin playbook version/,
  );

  // GROUND TRUTH: the publish leg RAN (the successor's version is now
  // published through the frozen lifecycle — the orchestrated command),
  // and NO completion was recorded (the carry stays 'carried' — the
  // honest retryable posture).
  const successorStatus = await db!.query<{ status: string }>(
    'SELECT status FROM playbook_versions WHERE version_id = $1',
    [successorVersionId],
  );
  assert.equal(successorStatus.rows[0]!.status, 'published', 'the publish leg walked the frozen ladder for the draft version');
  const successorRow = await carryRow(successorCarryId);
  assert.equal(successorRow!.carry_state, 'carried', 'no completion recorded for the rejected attempt (retryable)');
  assert.equal(successorRow!.carried_deployment_id, null);
});

// ---------------------------------------------------------------------------
// Isolation, authorization and boundary negatives
// ---------------------------------------------------------------------------

test('ISOLATION: foreign and unknown identifiers are the uniform 404; anonymous is 401; collaborators read but cannot carry', async () => {
  // A foreign proposal (agency B's) from agency A's owner: 404 (the
  // decision ownership resolves through /decisions first).
  const foreignCarry = await carry(foreignAcceptedProposalId, ownerA.token, {
    idempotencyKey: `foreign-1-${randomUUID()}`,
  });
  assert.equal(foreignCarry.status, 404);

  // A foreign carry identifier: 404.
  const foreignCarryView = await getCarryView(goldenCarryId, ownerB.token);
  assert.equal(foreignCarryView.status, 404);

  // An unknown carry identifier: 404.
  const unknownCarryView = await getCarryView(randomUUID(), ownerA.token);
  assert.equal(unknownCarryView.status, 404);

  // A foreign proposal continuity read: 404.
  const foreignProposalView = await getProposalContinuity(foreignAcceptedProposalId, ownerA.token);
  assert.equal(foreignProposalView.status, 404);

  // The proposal-anchored view of an UNcarried accepted proposal: 404
  // (no continuity to read — indistinguishable).
  const uncarriedView = await getProposalContinuity(uncarriedProposalId, ownerA.token);
  assert.equal(uncarriedView.status, 404);

  // The delivery-side view of a NEVER-carried playbook: 404.
  const manualPlaybook = await apiCall(port(), `/api/clients/${clientA1}/playbooks`, {
    token: ownerA.token,
    body: { name: 'A manually created playbook', description: 'Never carried.' },
  });
  assert.equal(manualPlaybook.status, 201);
  const neverCarriedView = await getPlaybookContinuity(
    manualPlaybook.body['playbookId'] as string,
    ownerA.token,
  );
  assert.equal(neverCarriedView.status, 404);

  // A foreign workspace on the deployment carry: 404 (isolation before
  // traversal — a workspace of another Client).
  const foreignWorkspace = await carryDeployment(successorCarryId, ownerA.token, {
    workspaceId: workspaceB,
    workflowDefinitionIds: [randomUUID()],
    idempotencyKey: `foreign-ws-${randomUUID()}`,
  });
  assert.equal(foreignWorkspace.status, 404);

  // An unknown workflow definition reference: the /deployments
  // authority's own validation rejects (uniform 404).
  const unknownDefinition = await carryDeployment(successorCarryId, ownerA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [randomUUID()],
    idempotencyKey: `unknown-def-${randomUUID()}`,
  });
  assert.equal(unknownDefinition.status, 404);

  // Anonymous: 401 on every surface.
  const anonymousCarry = await apiCall(port(), `/api/decisions/${goldenProposalId}/carry`, {
    body: { idempotencyKey: 'anonymous' },
  });
  assert.equal(anonymousCarry.status, 401);
  const anonymousView = await apiCall(port(), `/api/sales-continuity/carries/${goldenCarryId}`);
  assert.equal(anonymousView.status, 401);

  // A collaborator (client_collaborator): may READ the continuity
  // surfaces, may NOT carry (403 — the owner|admin posture of the
  // playbook/deployment creation commands it orchestrates).
  const collaboratorView = await getProposalContinuity(goldenProposalId, collaboratorA.token);
  assert.equal(collaboratorView.status, 200);
  const collaboratorList = await listCarries(clientA1, collaboratorA.token);
  assert.equal(collaboratorList.status, 200);
  const collaboratorCarry = await carry(uncarriedProposalId, collaboratorA.token, {
    idempotencyKey: `collab-${randomUUID()}`,
  });
  assert.equal(collaboratorCarry.status, 403);
  const collaboratorDeploy = await carryDeployment(successorCarryId, collaboratorA.token, {
    workspaceId: workspaceA1,
    workflowDefinitionIds: [randomUUID()],
    idempotencyKey: `collab-deploy-${randomUUID()}`,
  });
  assert.equal(collaboratorDeploy.status, 403);

  // Forged authority headers change nothing.
  const forged = await apiCall(port(), `/api/decisions/${uncarriedProposalId}/carry`, {
    token: collaboratorA.token,
    headers: FORGED_HEADERS,
    body: { idempotencyKey: `forged-${randomUUID()}` },
  });
  assert.equal(forged.status, 403, 'forged headers never elevate a collaborator');
  const forgedForeign = await apiCall(port(), `/api/decisions/${foreignAcceptedProposalId}/carry`, {
    token: ownerA.token,
    headers: { ...FORGED_HEADERS, 'x-agency-id': agencyB, 'x-client-id': clientB },
    body: { idempotencyKey: `forged-2-${randomUUID()}` },
  });
  assert.equal(forgedForeign.status, 404, 'forged scope headers never cross the tenant boundary');

  // A foreign client's listing: 404.
  const foreignList = await listCarries(clientB, ownerA.token);
  assert.equal(foreignList.status, 404);
});

test('GOAL LINK: the optional canonical goal threads through to the /playbooks creation command; a foreign goal is the authority\'s 404', async () => {
  // The successor carry's goal link: carry the uncarried proposal with
  // the canonical goal of the SAME client.
  const goalLinkKey = `goal-link-${randomUUID()}`;
  const response = await carry(uncarriedProposalId, ownerA.token, {
    idempotencyKey: goalLinkKey,
    goalId: goalA1,
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const linkedPlaybookId = (response.body['carry'] as Record<string, unknown>)['carriedPlaybookId'] as string;
  const goalRows = await countRows(
    'SELECT count(*)::text AS count FROM playbooks WHERE playbook_id = $1 AND goal_id = $2 AND client_id = $3',
    [linkedPlaybookId, goalA1, clientA1],
  );
  assert.equal(goalRows, 1, 'the canonical goal link threads through to the playbook row');

  // A foreign goal (client B's) is rejected by the PLAYBOOK AUTHORITY's
  // own validation (uniform 404 — never an authorization). A FRESH
  // uncarried proposal anchors it (the source fence would replay an
  // already-carried one before the goal validation runs).
  const freshProposal = await recordProposal(clientA1, ownerA.token);
  await acceptProposal(freshProposal, ownerA.token);
  const goalB = await makeGoal(clientB, ownerB.token, 'A foreign goal.');
  const foreignGoal = await carry(freshProposal, ownerA.token, {
    idempotencyKey: `foreign-goal-${randomUUID()}`,
    goalId: goalB,
  });
  assert.equal(foreignGoal.status, 404, JSON.stringify(foreignGoal.body));
});

// ---------------------------------------------------------------------------
// DB backstops (direct SQL — the migration 040 fences)
// ---------------------------------------------------------------------------

test('DB BACKSTOPS: the continuity ledger is append-only, forward-only and cross-tenant fenced', async () => {
  const row = await carryRow(goldenCarryId);
  assert.ok(row !== null);

  // The event tail rejects UPDATE and DELETE.
  await assert.rejects(
    () => db!.query('UPDATE sales_continuity_events SET detail = \'{"tampered": true}\'::jsonb WHERE carry_id = $1', [goldenCarryId]),
    /append-only/,
  );
  await assert.rejects(
    () => db!.query('DELETE FROM sales_continuity_events WHERE carry_id = $1', [goldenCarryId]),
    /append-only/,
  );

  // The carry rows reject DELETE.
  await assert.rejects(
    () => db!.query('DELETE FROM sales_continuity_carries WHERE carry_id = $1', [goldenCarryId]),
    /append-only/,
  );

  // The identity columns reject UPDATE (the source reference + snapshot).
  await assert.rejects(
    () => db!.query('UPDATE sales_continuity_carries SET source_decision_id = $2 WHERE carry_id = $1', [goldenCarryId, successorProposalId]),
    /immutable/,
  );
  await assert.rejects(
    () => db!.query("UPDATE sales_continuity_carries SET carried_payload = jsonb_set(carried_payload, '{scope,objective}', '\"tampered\"') WHERE carry_id = $1", [goldenCarryId]),
    /immutable/,
  );

  // The completion ladder is forward-only: backwards moves reject.
  await assert.rejects(
    () => db!.query("UPDATE sales_continuity_carries SET carry_state = 'carried' WHERE carry_id = $1", [goldenCarryId]),
    /forward-only/,
  );
  // Repeated rewrites reject (the deployment reference is already set —
  // re-pointing it to a DIFFERENT deployment is a rewrite, and a same-value
  // no-op update is legal pass-through for the row CHECKs).
  await assert.rejects(
    () => db!.query('UPDATE sales_continuity_carries SET carried_deployment_id = $2 WHERE carry_id = $1', [goldenCarryId, randomUUID()]),
    /forward-only/,
  );
  // Skipping the ladder rejects (claim shape CHECK: 'carrying' carries nothing).
  await assert.rejects(
    () => db!.query(
      `INSERT INTO sales_continuity_carries (carry_id, client_id, agency_id, source_decision_id, source_fingerprint,
         carried_playbook_id, carry_state, carried_payload, idempotency_key, create_fingerprint,
         recorded_actor, recorded_via, correlation_id, recorded_at)
       VALUES ($1, $2, $3, $4, 'sc-test', $5, 'carried', $6::jsonb, $7, 'sc-test', 'test', 'sql', 'test-corr', now())`,
      [
        randomUUID(),
        clientA1,
        agencyA,
        uncarriedProposalId,
        row!.carried_playbook_id,
        JSON.stringify({
          derivationVersion: 'sc-carry-v1',
          source: { kind: 'decision', decisionId: uncarriedProposalId, fingerprint: 'x', disposition: 'accepted' },
          scope: { objective: 'o', context: null },
          goals: { objective: 'o', hypothesisSummary: 'h', evidenceRefs: [], experimentRef: null },
          outcomes: { expectedImpact: { summary: 's', direction: null, magnitude: null }, uncertainty: null },
          assumptions: { hypothesisSummary: 'h', alternatives: [], experimentRef: null },
          economics: { expectedCost: null, expectedImpactSummary: 's' },
        }),
        `sql-${randomUUID()}`,
      ],
    ),
    /carry_completion_shape/,
  );

  // The cross-tenant reference fence: a carry claiming a source decision
  // of ANOTHER Client rejects even via direct SQL.
  await assert.rejects(
    () => db!.query(
      `INSERT INTO sales_continuity_carries (carry_id, client_id, agency_id, source_decision_id, source_fingerprint,
         carry_state, carried_payload, idempotency_key, create_fingerprint,
         recorded_actor, recorded_via, correlation_id, recorded_at)
       VALUES ($1, $2, $3, $4, 'sc-test', 'carrying', $5::jsonb, $6, 'sc-test', 'test', 'sql', 'test-corr', now())`,
      [
        randomUUID(),
        clientB,
        agencyB,
        goldenProposalId,
        JSON.stringify({
          derivationVersion: 'sc-carry-v1',
          source: { kind: 'decision', decisionId: goldenProposalId, fingerprint: 'x', disposition: 'accepted' },
          scope: { objective: 'o', context: null },
          goals: { objective: 'o', hypothesisSummary: 'h', evidenceRefs: [], experimentRef: null },
          outcomes: { expectedImpact: { summary: 's', direction: null, magnitude: null }, uncertainty: null },
          assumptions: { hypothesisSummary: 'h', alternatives: [], experimentRef: null },
          economics: { expectedCost: null, expectedImpactSummary: 's' },
        }),
        `sql-${randomUUID()}`,
      ],
    ),
    /cannot cross the Client boundary/,
  );
});
