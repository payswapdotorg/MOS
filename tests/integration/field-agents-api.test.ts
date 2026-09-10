/**
 * MKT-025 integration test — the Human Agent profile authority (HUMAN-AC-01,
 * FIELD-AC-01) against real PostgreSQL + a real API subprocess.
 *
 * Proves:
 *   - HUMAN-AC-01: a Human Agent profile persists the full generic model —
 *     platform identity link (server-derived), capabilities, availability,
 *     optional territories + location, server-derived reliability signals,
 *     relationship-continuity settings and the authorization/contract state
 *     (default active) — readable back through the API with every field
 *     intact; the profile is a PLATFORM identity (creatable with NO agency
 *     membership at all);
 *   - FIELD-AC-01: the (field) agent DECLARES location, territories and
 *     availability through the dedicated declaration route (CAS), and the
 *     declaration persists; stale CAS versions are rejected;
 *   - profile content updates (specializations/capabilities/relationship
 *     continuity) are CAS-protected; the Field-Agent geography rule is
 *     enforced on the MERGED shape (adding field_agent without geography is
 *     rejected; clearing geography while field_agent is rejected);
 *   - ONE profile per platform user: duplicate creation is rejected by the
 *     DB fence (409) and concurrent creation converges to a single winner
 *     (module-level duplicate convergence);
 *   - the authorization/contract lifecycle: platform-controlled transitions
 *     (suspend/reactivate/contract_ended), self-mutation rejected, illegal
 *     transitions rejected, contract_ended TERMINAL in both API and DB
 *     (trigger backstop);
 *   - the server-side reliability fold (module-level only): counters update
 *     under the row lock and NO route exposes the mutation;
 *   - every material mutation is audited (append-only /audit rows).
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
import { SystemClock } from '../../src/platform/clock/clock.ts';
import { CryptoIdGenerator } from '../../src/platform/ids/ids.ts';
import { createFieldAgentsModule, type HumanAgentDeclaration } from '../../src/modules/field-agents/public.ts';
import { createUsersModule } from '../../src/modules/users/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

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

interface Principal {
  readonly token: string;
  readonly userId: string;
}

/** Creates a user (with password) and returns its session token + id. */
async function makeUser(email: string): Promise<Principal> {
  const admin = await adminToken();
  const user = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(user.status, 201);
  const userId = user.body['userId'] as string;
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password: PASSWORD },
  });
  const login = await apiCall(port(), '/api/auth/login', {
    body: { email, password: PASSWORD },
  });
  assert.equal(login.status, 200);
  return { token: login.body['token'] as string, userId };
}

/** Creates user + agency owned by that user. */
async function makeAgencyOwner(email: string): Promise<Principal & { agencyId: string }> {
  const principal = await makeUser(email);
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: principal.userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { ...principal, agencyId };
}

/** The agent links to an agency through the EXISTING membership authority. */
async function linkHumanAgent(
  agencyId: string,
  ownerToken: string,
  userId: string,
  role: 'human_agent' | 'agency_operator' = 'human_agent',
): Promise<string> {
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: ownerToken,
    body: { userId, role },
  });
  assert.equal(membership.status, 201);
  return membership.body['membershipId'] as string;
}

/** A complete HUMAN-AC-01 field-agent declaration. */
function fullFieldAgentDeclaration(): Record<string, unknown> {
  return {
    specializations: ['field_agent'],
    capabilities: [
      { skill: 'canvassing', level: 'advanced' },
      { skill: 'product_demo', level: 'beginner' },
    ],
    availability: [
      { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
      { dayOfWeek: 4, startMinute: 600, endMinute: 900 },
    ],
    location: { kind: 'city', value: 'accra' },
    territories: [
      { kind: 'city', value: 'accra' },
      { kind: 'region', value: 'greater accra' },
    ],
    relationshipContinuity: {
      prefersRepeatClients: true,
      continuity: 'preferred',
      maxConcurrentClientRelationships: 4,
    },
  };
}

async function createProfile(
  principal: Principal,
  declaration: Record<string, unknown> = fullFieldAgentDeclaration(),
): Promise<Record<string, unknown>> {
  const created = await apiCall(port(), '/api/field-agents', {
    token: principal.token,
    body: declaration,
  });
  assert.equal(created.status, 201, `profile creation failed: ${JSON.stringify(created.body)}`);
  return created.body as Record<string, unknown>;
}

before(async () => {
  stack = await bootStack('fieldagents');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
  db = new PgDb(stack.env.databaseUrl, 2);
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

test('HUMAN-AC-01: the full generic Human Agent profile persists every field group and reads back intact', async () => {
  const agent = await makeUser('full-profile@fieldagents.test');
  const created = await createProfile(agent);

  assert.equal(created['userId'], agent.userId, 'identity link is server-derived from the principal');
  assert.equal(created['authorizationState'], 'active', 'authorization/contract state defaults to active');
  assert.deepEqual(created['specializations'], ['field_agent']);
  assert.deepEqual(created['capabilities'], [
    { skill: 'canvassing', level: 'advanced' },
    { skill: 'product_demo', level: 'beginner' },
  ]);
  assert.deepEqual(created['availability'], [
    { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
    { dayOfWeek: 4, startMinute: 600, endMinute: 900 },
  ]);
  assert.deepEqual(created['location'], { kind: 'city', value: 'accra' });
  assert.deepEqual(created['territories'], [
    { kind: 'city', value: 'accra' },
    { kind: 'region', value: 'greater accra' },
  ]);
  // Server-derived reliability/quality signals start at the zero aggregate.
  assert.deepEqual(created['reliability'], {
    completedJobs: 0,
    successfulJobs: 0,
    onTimeCompletions: 0,
    ratingSum: 0,
    ratingCount: 0,
  });
  assert.deepEqual(created['relationshipContinuity'], {
    prefersRepeatClients: true,
    continuity: 'preferred',
    maxConcurrentClientRelationships: 4,
  });
  assert.equal(created['version'], 1);
  assert.equal(created['createdBy'], agent.userId, 'provenance is server-derived');
  assert.ok(typeof created['createdAt'] === 'string');
  assert.ok(typeof created['updatedAt'] === 'string');

  // Read back through the API (self read).
  const read = await apiCall(port(), `/api/field-agents/${created['agentId']}`, {
    token: agent.token,
  });
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, created, 'the persisted profile round-trips exactly');

  // A generic NON-field declaration works too (chatter: optional geography).
  const chatter = await makeUser('chatter@fieldagents.test');
  const chatterProfile = await createProfile(chatter, {
    specializations: ['chatter'],
    capabilities: [{ skill: 'community_reply', level: null }],
    availability: [{ dayOfWeek: 2, startMinute: 0, endMinute: 480 }],
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: null,
    },
  });
  assert.ok(!('location' in chatterProfile), 'no location key when none declared');
  assert.deepEqual(chatterProfile['territories'], []);
});

test('HUMAN-AC-01: the profile is a PLATFORM identity — creatable with NO agency membership', async () => {
  const loner = await makeUser('no-agency@fieldagents.test');
  const created = await createProfile(loner);
  assert.ok(typeof created['agentId'] === 'string');
  // The loner can read their own profile.
  const read = await apiCall(port(), `/api/field-agents/${created['agentId']}`, {
    token: loner.token,
  });
  assert.equal(read.status, 200);
});

test('FIELD-AC-01: the field agent DECLARES location, territories and availability (dedicated route, CAS)', async () => {
  const agent = await makeUser('declare@fieldagents.test');
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;

  const declared = await apiCall(port(), `/api/field-agents/${agentId}/availability`, {
    token: agent.token,
    method: 'PATCH',
    body: {
      availability: [{ dayOfWeek: 2, startMinute: 480, endMinute: 1200 }],
      location: { kind: 'city', value: 'kumasi' },
      territories: [
        { kind: 'city', value: 'kumasi' },
        { kind: 'region', value: 'ashanti' },
      ],
      version: 1,
    },
  });
  assert.equal(declared.status, 200, JSON.stringify(declared.body));
  assert.equal(declared.body['version'], 2, 'CAS version increments');
  assert.deepEqual(declared.body['availability'], [{ dayOfWeek: 2, startMinute: 480, endMinute: 1200 }]);
  assert.deepEqual(declared.body['location'], { kind: 'city', value: 'kumasi' });
  assert.deepEqual(declared.body['territories'], [
    { kind: 'city', value: 'kumasi' },
    { kind: 'region', value: 'ashanti' },
  ]);

  // The declaration persists.
  const read = await apiCall(port(), `/api/field-agents/${agentId}`, { token: agent.token });
  assert.deepEqual(read.body['location'], { kind: 'city', value: 'kumasi' });

  // Stale CAS is rejected.
  const stale = await apiCall(port(), `/api/field-agents/${agentId}/availability`, {
    token: agent.token,
    method: 'PATCH',
    body: {
      availability: [{ dayOfWeek: 3, startMinute: 0, endMinute: 480 }],
      location: { kind: 'city', value: 'tamale' },
      territories: [{ kind: 'city', value: 'tamale' }],
      version: 1,
    },
  });
  assert.equal(stale.status, 409, 'stale CAS version must conflict');
});

test('profile content updates are CAS-protected; the Field-Agent geography rule holds on the MERGED shape', async () => {
  const agent = await makeUser('merge-rules@fieldagents.test');
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;

  // Adding a second specialization works (capability metadata).
  const updated = await apiCall(port(), `/api/field-agents/${agentId}/profile`, {
    token: agent.token,
    method: 'PATCH',
    body: {
      specializations: ['field_agent', 'sales_agent'],
      capabilities: [
        { skill: 'canvassing', level: 'advanced' },
        { skill: 'negotiation', level: 'intermediate' },
      ],
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'required',
        maxConcurrentClientRelationships: 2,
      },
      version: 1,
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body['specializations'], ['field_agent', 'sales_agent']);
  assert.equal(updated.body['version'], 2);

  // Clearing geography while field_agent is declared is rejected (422).
  const cleared = await apiCall(port(), `/api/field-agents/${agentId}/availability`, {
    token: agent.token,
    method: 'PATCH',
    body: {
      availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
      location: null,
      territories: [],
      version: 2,
    },
  });
  assert.equal(cleared.status, 422, 'field_agent without geography must be rejected');

  // Stale CAS on profile content is rejected.
  const stale = await apiCall(port(), `/api/field-agents/${agentId}/profile`, {
    token: agent.token,
    method: 'PATCH',
    body: {
      specializations: ['field_agent'],
      capabilities: [{ skill: 'canvassing', level: 'advanced' }],
      relationshipContinuity: {
        prefersRepeatClients: true,
        continuity: 'any',
        maxConcurrentClientRelationships: null,
      },
      version: 1,
    },
  });
  assert.equal(stale.status, 409);
});

test('ONE profile per platform user: duplicates rejected (DB fence) and concurrent creation converges', async () => {
  const agent = await makeUser('one-profile@fieldagents.test');
  await createProfile(agent);
  const second = await apiCall(port(), '/api/field-agents', {
    token: agent.token,
    body: fullFieldAgentDeclaration(),
  });
  assert.equal(second.status, 409, 'duplicate profile creation must conflict');

  // Module-level duplicate convergence under real concurrency: exactly one winner.
  assert.ok(stack !== null && db !== null);
  const users = createUsersModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator() });
  const fieldAgents = createFieldAgentsModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator(), users });
  const email = `race-${randomUUID()}@fieldagents.test`;
  const user = await users.createUser({ email, displayName: 'Race' });
  const declaration: HumanAgentDeclaration = {
    specializations: ['chatter'],
    capabilities: [{ skill: 'community_reply', level: null }],
    availability: [{ dayOfWeek: 1, startMinute: 0, endMinute: 60 }],
    location: null,
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: null,
    },
  };
  const results = await Promise.allSettled([
    fieldAgents.createHumanAgent({ userId: user.userId, declaration, actorId: null }),
    fieldAgents.createHumanAgent({ userId: user.userId, declaration, actorId: null }),
  ]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  const losers = results.filter((result) => result.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one concurrent creation wins');
  assert.equal(losers.length, 1, 'the loser fails closed');
  assert.match(String((losers[0] as PromiseRejectedResult).reason), /already has a Human Agent profile/);
  const profile = await fieldAgents.getHumanAgentByUser(user.userId);
  assert.ok(profile !== null);
  assert.equal(profile!.agentId, (winners[0] as PromiseFulfilledResult<{ agentId: string }>).value.agentId);
});

test('module-level creation guards: unknown user → 404; disabled user → 409', async () => {
  assert.ok(stack !== null && db !== null);
  const users = createUsersModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator() });
  const fieldAgents = createFieldAgentsModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator(), users });
  const declaration: HumanAgentDeclaration = {
    specializations: ['reviewer'],
    capabilities: [{ skill: 'content_review', level: null }],
    availability: [{ dayOfWeek: 0, startMinute: 0, endMinute: 60 }],
    location: null,
    territories: [],
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: null,
    },
  };

  await assert.rejects(
    fieldAgents.createHumanAgent({ userId: randomUUID(), declaration, actorId: null }),
    /not found: /,
  );

  const email = `disabled-${randomUUID()}@fieldagents.test`;
  const user = await users.createUser({ email, displayName: 'Disabled' });
  await users.setUserStatus({ userId: user.userId, status: 'disabled', expectedVersion: 1 });
  await assert.rejects(
    fieldAgents.createHumanAgent({ userId: user.userId, declaration, actorId: null }),
    /disabled and cannot hold an active Human Agent profile/,
  );
});

test('authorization/contract lifecycle: platform-controlled transitions, terminal contract_ended, DB backstop', async () => {
  const agent = await makeUser('lifecycle@fieldagents.test');
  const admin = await adminToken();
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;

  // The agent themself may NOT change the platform authorization state.
  const selfAttempt = await apiCall(port(), `/api/field-agents/${agentId}/authorization`, {
    token: agent.token,
    method: 'PATCH',
    body: { authorizationState: 'suspended', version: 1 },
  });
  assert.equal(selfAttempt.status, 403, 'self-mutation of platform authorization state is forbidden');

  // Platform admin suspends and reactivates.
  const suspended = await apiCall(port(), `/api/field-agents/${agentId}/authorization`, {
    token: admin,
    method: 'PATCH',
    body: { authorizationState: 'suspended', version: 1 },
  });
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
  assert.equal(suspended.body['authorizationState'], 'suspended');
  const reactivated = await apiCall(port(), `/api/field-agents/${agentId}/authorization`, {
    token: admin,
    method: 'PATCH',
    body: { authorizationState: 'active', version: 2 },
  });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body['authorizationState'], 'active');

  // Illegal transition (terminal contract_ended from contract_ended, or
  // fabrication): contract_ended then attempt to return.
  const ended = await apiCall(port(), `/api/field-agents/${agentId}/authorization`, {
    token: admin,
    method: 'PATCH',
    body: { authorizationState: 'contract_ended', version: 3 },
  });
  assert.equal(ended.status, 200);
  assert.equal(ended.body['authorizationState'], 'contract_ended');

  const resurrect = await apiCall(port(), `/api/field-agents/${agentId}/authorization`, {
    token: admin,
    method: 'PATCH',
    body: { authorizationState: 'active', version: 4 },
  });
  assert.equal(resurrect.status, 409, 'contract_ended is terminal — no resurrection');

  // DB backstop: direct UPDATE on the terminal row is rejected by the trigger.
  assert.ok(db !== null);
  await assert.rejects(
    db.query(
      "UPDATE human_agents SET authorization_state = 'active' WHERE agent_id = $1",
      [agentId],
    ),
    /contract is ended and terminal/,
  );

  // The terminal profile remains readable history for the owner.
  const read = await apiCall(port(), `/api/field-agents/${agentId}`, { token: agent.token });
  assert.equal(read.status, 200);
  assert.equal(read.body['authorizationState'], 'contract_ended');
});

test('DB backstops: identity link and provenance are immutable; duplicate specializations rejected', async () => {
  const agent = await makeUser('backstop@fieldagents.test');
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;
  assert.ok(db !== null);

  await assert.rejects(
    db.query('UPDATE human_agents SET user_id = $1 WHERE agent_id = $2', [randomUUID(), agentId]),
    /cannot change its platform identity link/,
  );
  await assert.rejects(
    db.query('UPDATE human_agents SET agent_id = $1 WHERE agent_id = $2', [randomUUID(), agentId]),
    /is immutable/,
  );
  await assert.rejects(
    db.query('UPDATE human_agents SET created_by = $1 WHERE agent_id = $2', [randomUUID(), agentId]),
    /provenance is immutable/,
  );
  await assert.rejects(
    db.query(
      "UPDATE human_agents SET specializations = ARRAY['field_agent','field_agent'] WHERE agent_id = $1",
      [agentId],
    ),
    /specializations must be unique/,
  );
  // Unknown specialization value is rejected by the CHECK.
  await assert.rejects(
    db.query(
      "UPDATE human_agents SET specializations = ARRAY['field_agent','influencer'] WHERE agent_id = $1",
      [agentId],
    ),
    /violates check constraint/,
  );
});

test('the server-side reliability fold updates counters under the row lock — and has NO route', async () => {
  assert.ok(stack !== null && db !== null);
  const agent = await makeUser('reliability@fieldagents.test');
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;

  const users = createUsersModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator() });
  const fieldAgents = createFieldAgentsModule({ db, clock: new SystemClock(), ids: new CryptoIdGenerator(), users });

  const first = await fieldAgents.recordReliabilityObservation({
    agentId,
    observation: { outcome: 'succeeded', onTime: true, rating: 5 },
  });
  assert.deepEqual(first.reliability, {
    completedJobs: 1,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 5,
    ratingCount: 1,
  });
  const second = await fieldAgents.recordReliabilityObservation({
    agentId,
    observation: { outcome: 'failed', onTime: false, rating: null },
  });
  assert.deepEqual(second.reliability, {
    completedJobs: 2,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 5,
    ratingCount: 1,
  });
  assert.ok(second.version > first.version, 'the fold increments the CAS version');

  // Invalid observations are rejected (server-side shape guard).
  await assert.rejects(
    fieldAgents.recordReliabilityObservation({
      agentId,
      observation: { outcome: 'maybe' as never, onTime: true, rating: null },
    }),
    /reliability observation failed validation/,
  );

  // NO route mutates reliability: probes fail closed.
  const probe = await apiCall(port(), `/api/field-agents/${agentId}/reliability`, {
    token: agent.token,
    method: 'PATCH',
    body: { outcome: 'succeeded', rating: 5 },
  });
  assert.equal(probe.status, 404, 'no reliability mutation route exists (fail-closed)');

  // The API read still reflects the folded aggregates.
  const read = await apiCall(port(), `/api/field-agents/${agentId}`, { token: agent.token });
  assert.deepEqual(read.body['reliability'], {
    completedJobs: 2,
    successfulJobs: 1,
    onTimeCompletions: 1,
    ratingSum: 5,
    ratingCount: 1,
  });
});

test('agency co-members can READ the profile (linkage via membership); unrelated callers get a UNIFORM 404', async () => {
  const owner = await makeAgencyOwner('visibility-owner@fieldagents.test');
  const agent = await makeUser('visibility-agent@fieldagents.test');
  await linkHumanAgent(owner.agencyId, owner.token, agent.userId);
  const created = await createProfile(agent);
  const agentId = created['agentId'] as string;

  // The agency owner (co-member through the human_agent membership) reads it.
  const ownerRead = await apiCall(port(), `/api/field-agents/${agentId}`, {
    token: owner.token,
  });
  assert.equal(ownerRead.status, 200, 'agency co-member read via membership linkage');

  // An unrelated caller: same 404 as for an unknown identifier.
  const stranger = await makeUser('visibility-stranger@fieldagents.test');
  const foreign = await apiCall(port(), `/api/field-agents/${agentId}`, {
    token: stranger.token,
  });
  const unknown = await apiCall(port(), `/api/field-agents/${randomUUID()}`, {
    token: stranger.token,
  });
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);
  const foreignError = foreign.body['error'] as Record<string, unknown>;
  const unknownError = unknown.body['error'] as Record<string, unknown>;
  assert.deepEqual(
    { ...foreignError, message: undefined },
    { ...unknownError, message: undefined },
    'foreign and unknown 404 payloads have identical shape (no existence oracle)',
  );

  // Co-members can read but NOT mutate the self-declared profile.
  const ownerMutate = await apiCall(port(), `/api/field-agents/${agentId}/profile`, {
    token: owner.token,
    method: 'PATCH',
    body: {
      specializations: ['field_agent'],
      capabilities: [{ skill: 'canvassing', level: 'advanced' }],
      relationshipContinuity: {
        prefersRepeatClients: false,
        continuity: 'any',
        maxConcurrentClientRelationships: null,
      },
      version: 1,
    },
  });
  assert.equal(ownerMutate.status, 403, 'co-members cannot rewrite a self-declared profile');
});

test('every material mutation is audited (append-only /audit rows)', async () => {
  assert.ok(db !== null);
  const audited = await db.query(
    'SELECT action, target_id, after_version FROM audit_events WHERE action LIKE $1 ORDER BY occurred_at, event_id',
    ['field_agents.%'],
  );
  const actions = audited.rows.map((row) => (row as { action: string }).action);
  for (const expected of [
    'field_agents.profile.created',
    'field_agents.profile.updated',
    'field_agents.availability.declared',
    'field_agents.authorization.changed',
  ]) {
    assert.ok(actions.includes(expected), `audit must include ${expected} (found: ${actions.join(', ')})`);
  }
});

test('anonymous callers are rejected (401) on every field-agents route', async () => {
  const create = await apiCall(port(), '/api/field-agents', {
    body: fullFieldAgentDeclaration(),
  });
  assert.equal(create.status, 401);
  const read = await apiCall(port(), `/api/field-agents/${randomUUID()}`, {});
  assert.equal(read.status, 401);
  const eligibility = await apiCall(port(), `/api/agencies/${randomUUID()}/field-agents/eligibility`, {
    body: { specialization: 'field_agent', dayOfWeek: 1, startMinute: 540, endMinute: 600 },
  });
  assert.equal(eligibility.status, 401);
});
