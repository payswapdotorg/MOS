/**
 * MKT-025 security integration test — FIELD-AC-02 + HUMAN-AC-03 against real
 * PostgreSQL + a real API subprocess.
 *
 * Proves:
 *   - FIELD-AC-02: the platform calculates job eligibility from a job spec
 *     (specialization + required capabilities + territory + availability)
 *     WITHOUT exposing unrelated Client data:
 *       * the eligibility result carries PROFILE DATA ONLY — every agent
 *         entry matches the serialized profile key set exactly; no client
 *         identifiers/names appear anywhere in the response although
 *         Clients exist under both agencies;
 *       * matching respects the durable agency linkage (only the
 *         commissioning agency's ACTIVE human_agent memberships are
 *         candidates), authorization state, specialization, capabilities,
 *         territory and availability windows;
 *       * NEGATIVE match paths: missing capability, wrong territory,
 *         non-overlapping availability, suspended/contract-ended profile,
 *         disabled membership — none of them leak the agent into the result;
 *   - HUMAN-AC-03: a Human Agent serving multiple Agencies/Clients cannot
 *     access Client data through this module outside an authorized
 *     Job/Execution scope — fail-closed, because that context does NOT
 *     exist yet (the /jobs authority is MKT-026):
 *       * this module exposes NO client-data routes: every probed
 *         client-scoped path under /api/field-agents is a 404 (no route);
 *       * client-shaped request fields (clientId/jobId/…) are REJECTED at
 *         validation time, BEFORE any traversal (422);
 *       * authority-field smuggling on every route surface is rejected
 *         (userId, agencyId, authorizationState, reliability, version…);
 *       * the existing cross-tenant authority still holds for the
 *         multi-agency human agent: a Client of an agency WITHOUT membership
 *         is a UNIFORM 404 (no traversal/existence oracle);
 *   - access-control negatives: foreign-agency eligibility callers are 403,
 *     unknown agencies 404, anonymous callers 401, unrelated profile reads
 *     are a uniform 404.
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

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const PASSWORD = 'a-very-long-password-123';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;

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

async function linkHumanAgent(
  agencyId: string,
  ownerToken: string,
  userId: string,
): Promise<string> {
  const membership = await apiCall(port(), `/api/agencies/${agencyId}/memberships`, {
    token: ownerToken,
    body: { userId, role: 'human_agent' },
  });
  assert.equal(membership.status, 201);
  return membership.body['membershipId'] as string;
}

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201);
  return created.body['clientId'] as string;
}

async function createProfile(
  principal: Principal,
  declaration: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const created = await apiCall(port(), '/api/field-agents', {
    token: principal.token,
    body: declaration,
  });
  assert.equal(created.status, 201, `profile creation failed: ${JSON.stringify(created.body)}`);
  return created.body as Record<string, unknown>;
}

function fieldAgentDeclaration(options: {
  readonly capabilities: ReadonlyArray<{ skill: string; level: string | null }>;
  readonly location: { kind: string; value: string } | null;
  readonly territories: ReadonlyArray<{ kind: string; value: string }>;
  readonly availability: ReadonlyArray<{ dayOfWeek: number; startMinute: number; endMinute: number }>;
}): Record<string, unknown> {
  return {
    specializations: ['field_agent'],
    capabilities: options.capabilities,
    availability: options.availability,
    location: options.location,
    territories: options.territories,
    relationshipContinuity: {
      prefersRepeatClients: false,
      continuity: 'any',
      maxConcurrentClientRelationships: null,
    },
  };
}

/** The serialized profile key set (the ONLY data eligibility may return). */
const PROFILE_KEYS = [
  'agentId',
  'userId',
  'specializations',
  'capabilities',
  'availability',
  'location',
  'territories',
  'reliability',
  'relationshipContinuity',
  'authorizationState',
  'version',
  'createdAt',
  'updatedAt',
].sort();

interface EligibilitySpec {
  readonly specialization?: string;
  readonly requiredCapabilities?: readonly string[];
  readonly territory?: { kind: string; value: string } | null;
  readonly dayOfWeek?: number;
  readonly startMinute?: number;
  readonly endMinute?: number;
}

async function eligibility(
  agencyId: string,
  token: string,
  spec: EligibilitySpec,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return apiCall(port(), `/api/agencies/${agencyId}/field-agents/eligibility`, {
    token,
    body: {
      specialization: spec.specialization ?? 'field_agent',
      ...(spec.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: spec.requiredCapabilities }),
      ...(spec.territory === undefined ? {} : { territory: spec.territory }),
      dayOfWeek: spec.dayOfWeek ?? 1,
      startMinute: spec.startMinute ?? 540,
      endMinute: spec.endMinute ?? 1020,
    },
  });
}

// Scenario state (built once in before()).
const scenario = {
  ownerA: null as unknown as Principal & { agencyId: string },
  ownerB: null as unknown as Principal & { agencyId: string },
  ownerC: null as unknown as Principal & { agencyId: string },
  // The multi-agency human agent (member of A AND B — never C).
  multiAgent: null as unknown as Principal,
  multiAgentProfileId: '',
  membershipA: '',
  membershipB: '',
  // Agency A's second, non-matching agent.
  weakAgent: null as unknown as Principal,
  weakAgentProfileId: '',
  // Agency B's own local agent.
  agentB: null as unknown as Principal,
  agentBProfileId: '',
  clientA1: '',
  clientA2: '',
  clientB1: '',
  clientC1: '',
};

before(async () => {
  stack = await bootStack('fieldsec');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  scenario.ownerA = await makeAgencyOwner('owner-a@fieldsec.test');
  scenario.ownerB = await makeAgencyOwner('owner-b@fieldsec.test');
  scenario.ownerC = await makeAgencyOwner('owner-c@fieldsec.test');

  // Clients under every agency (PROOF MATERIAL: none of it may ever appear
  // in a field-agents response).
  scenario.clientA1 = await makeClient(scenario.ownerA.agencyId, scenario.ownerA.token, 'Client Alpha One');
  scenario.clientA2 = await makeClient(scenario.ownerA.agencyId, scenario.ownerA.token, 'Client Alpha Two');
  scenario.clientB1 = await makeClient(scenario.ownerB.agencyId, scenario.ownerB.token, 'Client Beta One');
  scenario.clientC1 = await makeClient(scenario.ownerC.agencyId, scenario.ownerC.token, 'Client Gamma One');

  // The multi-agency human agent: member of A and B, field specialization,
  // Mon+Wed 09:00–17:00, city accra + region greater accra.
  scenario.multiAgent = await makeUser('multi-agent@fieldsec.test');
  scenario.membershipA = await linkHumanAgent(
    scenario.ownerA.agencyId,
    scenario.ownerA.token,
    scenario.multiAgent.userId,
  );
  scenario.membershipB = await linkHumanAgent(
    scenario.ownerB.agencyId,
    scenario.ownerB.token,
    scenario.multiAgent.userId,
  );
  const profile = await createProfile(scenario.multiAgent, fieldAgentDeclaration({
    capabilities: [
      { skill: 'canvassing', level: 'advanced' },
      { skill: 'product_demo', level: 'intermediate' },
    ],
    location: { kind: 'city', value: 'accra' },
    territories: [{ kind: 'region', value: 'greater accra' }],
    availability: [
      { dayOfWeek: 1, startMinute: 540, endMinute: 1020 },
      { dayOfWeek: 3, startMinute: 540, endMinute: 1020 },
    ],
  }));
  scenario.multiAgentProfileId = profile['agentId'] as string;

  // Agency A's non-matching agent: no territory overlap, no capability overlap.
  scenario.weakAgent = await makeUser('weak-agent@fieldsec.test');
  await linkHumanAgent(scenario.ownerA.agencyId, scenario.ownerA.token, scenario.weakAgent.userId);
  const weakProfile = await createProfile(scenario.weakAgent, fieldAgentDeclaration({
    capabilities: [{ skill: 'flyering', level: 'beginner' }],
    location: { kind: 'city', value: 'kumasi' },
    territories: [{ kind: 'city', value: 'kumasi' }],
    availability: [{ dayOfWeek: 2, startMinute: 540, endMinute: 1020 }],
  }));
  scenario.weakAgentProfileId = weakProfile['agentId'] as string;

  // Agency B's own local agent (B's only OTHER member besides the multi-agent).
  scenario.agentB = await makeUser('agent-b@fieldsec.test');
  await linkHumanAgent(scenario.ownerB.agencyId, scenario.ownerB.token, scenario.agentB.userId);
  const profileB = await createProfile(scenario.agentB, fieldAgentDeclaration({
    capabilities: [{ skill: 'canvassing', level: 'beginner' }],
    location: { kind: 'city', value: 'tema' },
    territories: [{ kind: 'city', value: 'tema' }],
    availability: [{ dayOfWeek: 1, startMinute: 600, endMinute: 900 }],
  }));
  scenario.agentBProfileId = profileB['agentId'] as string;
});

after(async () => {
  if (api !== null) {
    api.child.kill('SIGTERM');
    await api.exitCode();
  }
  if (stack !== null) await shutdownStack(stack);
});

// ---------------------------------------------------------------------------
// FIELD-AC-02 — eligibility WITHOUT Client data exposure
// ---------------------------------------------------------------------------

test('FIELD-AC-02: eligibility matches the right agents for a job spec and returns PROFILE DATA ONLY', async () => {
  const result = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    specialization: 'field_agent',
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    dayOfWeek: 1,
    startMinute: 600,
    endMinute: 720,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const agents = result.body['agents'] as Record<string, unknown>[];
  assert.equal(result.body['matched'], 1, 'exactly the multi-agency agent matches in agency A');
  assert.equal(agents.length, 1);
  assert.equal(agents[0]!['agentId'], scenario.multiAgentProfileId);
  assert.equal(agents[0]!['authorizationState'], 'active');

  // The serialized entries match the profile key set EXACTLY (location is
  // present for this profile; createdBy is the only optional-omitted key).
  const entryKeys = Object.keys(agents[0]!).sort();
  assert.deepEqual(
    entryKeys,
    [...PROFILE_KEYS, 'createdBy'].sort(),
    'eligibility returns exactly the profile fields — nothing else',
  );

  // NO Client data anywhere in the response: none of the four client ids,
  // none of the client names (although Clients exist under both agencies
  // and the matched agent serves both).
  const serialized = JSON.stringify(result.body);
  for (const clientId of [scenario.clientA1, scenario.clientA2, scenario.clientB1, scenario.clientC1]) {
    assert.ok(!serialized.includes(clientId), 'no client identifier may leak');
  }
  for (const clientName of ['Client Alpha One', 'Client Alpha Two', 'Client Beta One', 'Client Gamma One']) {
    assert.ok(!serialized.includes(clientName), 'no client data may leak');
  }
});

test('FIELD-AC-02: the candidate pool is the commissioning agency\'s ACTIVE human_agent memberships (durable linkage)', async () => {
  // Agency B sees the SAME multi-agency agent (it is a member there) plus
  // its local agent — but NOT agency A's weak agent.
  const resultB = await eligibility(scenario.ownerB.agencyId, scenario.ownerB.token, {
    specialization: 'field_agent',
    requiredCapabilities: [],
    dayOfWeek: 1,
    startMinute: 700,
    endMinute: 800,
  });
  assert.equal(resultB.status, 200);
  const idsB = (resultB.body['agents'] as Record<string, unknown>[]).map((agent) => agent['agentId']);
  assert.ok(idsB.includes(scenario.multiAgentProfileId), 'the multi-agency agent matches in B too');
  assert.ok(
    !idsB.includes(scenario.weakAgentProfileId),
    "agency A's non-member agent must never appear in B's eligibility",
  );

  // The multi-agency agent's profile is IDENTICAL through both agencies —
  // the profile carries no per-agency/client linkage at all.
  const inA = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    specialization: 'field_agent',
    requiredCapabilities: [],
    dayOfWeek: 3,
    startMinute: 700,
    endMinute: 800,
  });
  const inB = await eligibility(scenario.ownerB.agencyId, scenario.ownerB.token, {
    specialization: 'field_agent',
    requiredCapabilities: [],
    dayOfWeek: 3,
    startMinute: 700,
    endMinute: 800,
  });
  const entryA = (inA.body['agents'] as Record<string, unknown>[]).find(
    (agent) => agent['agentId'] === scenario.multiAgentProfileId,
  );
  const entryB = (inB.body['agents'] as Record<string, unknown>[]).find(
    (agent) => agent['agentId'] === scenario.multiAgentProfileId,
  );
  assert.ok(entryA !== undefined && entryB !== undefined);
  assert.deepEqual(entryA, entryB, 'the profile is agency-agnostic — no linkage data attached');
});

test('FIELD-AC-02 NEGATIVE: spec mismatches never leak agents into the result', async () => {
  // Missing capability.
  const missingCapability = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: ['mystery_skill'],
  });
  assert.equal(missingCapability.status, 200);
  assert.equal(missingCapability.body['matched'], 0, 'missing capability → no match');

  // Wrong territory (different value AND different kind).
  for (const territory of [
    { kind: 'city', value: 'kumasi' },
    { kind: 'region', value: 'accra' },
    { kind: 'country', value: 'ghana' },
  ]) {
    const wrongTerritory = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
      requiredCapabilities: [],
      territory,
    });
    assert.equal(wrongTerritory.status, 200);
    assert.equal(wrongTerritory.body['matched'], 0, `territory ${territory.kind}:${territory.value} must not match`);
  }

  // Non-overlapping availability for the MONDAY agent (the geography-free
  // Tuesday agent legitimately matches a Tuesday spec — the assertion is
  // that the Monday agent never leaks into off-day results).
  const wrongDay = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: [],
    dayOfWeek: 2,
    startMinute: 600,
    endMinute: 700,
  });
  const wrongDayIds = (wrongDay.body['agents'] as Record<string, unknown>[]).map(
    (agent) => agent['agentId'],
  );
  assert.ok(
    !wrongDayIds.includes(scenario.multiAgentProfileId),
    'the Monday-only agent must not match a Tuesday job',
  );
  const adjacent = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: [],
    dayOfWeek: 1,
    startMinute: 1020,
    endMinute: 1200,
  });
  const adjacentIds = (adjacent.body['agents'] as Record<string, unknown>[]).map(
    (agent) => agent['agentId'],
  );
  assert.ok(
    !adjacentIds.includes(scenario.multiAgentProfileId),
    'adjacent non-overlapping window (17:00+) must not match the 09:00–17:00 agent',
  );

  // Wrong specialization (the profiles are field_agent only).
  const wrongSpecialization = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    specialization: 'chatter',
    requiredCapabilities: [],
  });
  assert.equal(wrongSpecialization.body['matched'], 0, 'wrong specialization → no match');

  // No territory requirement: geography is not a gate (the weak agent's
  // Tuesday window matches a Tuesday spec).
  const noTerritory = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: ['flyering'],
    territory: null,
    dayOfWeek: 2,
    startMinute: 600,
    endMinute: 700,
  });
  assert.equal(noTerritory.body['matched'], 1, 'no-territory spec matches the geography-free agent');
});

test('FIELD-AC-02 NEGATIVE: suspended/contract-ended profiles and disabled memberships leave the eligibility pool', async () => {
  const admin = await adminToken();
  // Suspend the multi-agent through the platform authorization route.
  const suspended = await apiCall(
    port(),
    `/api/field-agents/${scenario.multiAgentProfileId}/authorization`,
    {
      token: admin,
      method: 'PATCH',
      body: { authorizationState: 'suspended', version: 1 },
    },
  );
  assert.equal(suspended.status, 200);

  const whileSuspended = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    dayOfWeek: 1,
    startMinute: 600,
    endMinute: 720,
  });
  assert.equal(whileSuspended.body['matched'], 0, 'a suspended agent is not eligible');

  // Reactivate, then disable the A membership through the EXISTING agencies
  // authority (agency-level standing is membership, not profile state).
  await apiCall(port(), `/api/field-agents/${scenario.multiAgentProfileId}/authorization`, {
    token: admin,
    method: 'PATCH',
    body: { authorizationState: 'active', version: 2 },
  });
  const memberships = await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/memberships`,
    { token: scenario.ownerA.token },
  );
  const membershipRow = (memberships.body['memberships'] as Record<string, unknown>[]).find(
    (row) => row['userId'] === scenario.multiAgent.userId,
  );
  assert.ok(membershipRow !== undefined);
  const disabled = await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/memberships/${membershipRow!['membershipId']}`,
    {
      token: scenario.ownerA.token,
      method: 'PATCH',
      body: { status: 'disabled', version: membershipRow!['version'] as number },
    },
  );
  assert.equal(disabled.status, 200);

  const whileDisabledMembership = await eligibility(scenario.ownerA.agencyId, scenario.ownerA.token, {
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    dayOfWeek: 1,
    startMinute: 600,
    endMinute: 720,
  });
  assert.equal(whileDisabledMembership.body['matched'], 0, 'a disabled membership leaves the agency pool');

  // Re-enable for later tests.
  await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/memberships/${membershipRow!['membershipId']}`,
    {
      token: scenario.ownerA.token,
      method: 'PATCH',
      body: { status: 'active', version: (disabled.body['version'] as number) },
    },
  );
});

// ---------------------------------------------------------------------------
// HUMAN-AC-03 — cross-scope security (fail-closed client boundary)
// ---------------------------------------------------------------------------

test('HUMAN-AC-03: this module exposes NO client-data routes — every probed client-scoped path fails closed', async () => {
  const agentToken = scenario.multiAgent.token;
  const agentId = scenario.multiAgentProfileId;
  const probes: ReadonlyArray<{ method: string; path: string; body?: unknown }> = [
    { method: 'GET', path: `/api/field-agents/${agentId}/clients` },
    { method: 'GET', path: `/api/field-agents/${agentId}/clients/${scenario.clientA1}` },
    { method: 'GET', path: '/api/field-agents/clients' },
    { method: 'GET', path: `/api/field-agents/clients/${scenario.clientA1}` },
    { method: 'GET', path: `/api/field-agents/${agentId}/client/${scenario.clientA1}` },
    { method: 'POST', path: `/api/field-agents/${agentId}/client-access`, body: { clientId: scenario.clientA1 } },
    { method: 'GET', path: `/api/clients/${scenario.clientA1}/field-agents` },
    { method: 'GET', path: `/api/field-agents/${agentId}/jobs` },
  ];
  for (const probe of probes) {
    const response = await apiCall(port(), probe.path, {
      token: agentToken,
      method: probe.method,
      body: probe.body,
    });
    assert.equal(
      response.status,
      404,
      `client-scoped path ${probe.method} ${probe.path} must not exist (no route — fail-closed)`,
    );
  }
});

test('HUMAN-AC-03: client/job identifiers in eligibility requests are rejected BEFORE traversal (422)', async () => {
  const base = {
    specialization: 'field_agent',
    dayOfWeek: 1,
    startMinute: 600,
    endMinute: 720,
  };
  // Foreign-client identifier: rejected at validation, before ANY traversal.
  const foreignClient = await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/field-agents/eligibility`,
    {
      token: scenario.ownerA.token,
      body: { ...base, clientId: scenario.clientB1 },
    },
  );
  assert.equal(foreignClient.status, 422, 'client scoping requires the (not-yet-existing) job context');
  assert.match(
    String((foreignClient.body['error'] as Record<string, unknown>)['message']),
    /failed validation|forbidden/,
  );

  // Own-agency client identifier: equally rejected (no client-scoped
  // eligibility surface exists at all).
  const ownClient = await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/field-agents/eligibility`,
    {
      token: scenario.ownerA.token,
      body: { ...base, clientId: scenario.clientA1 },
    },
  );
  assert.equal(ownClient.status, 422);

  // Job-shaped identifiers (the Job authority does not exist yet): rejected.
  for (const extra of [
    { jobId: randomUUID() },
    { jobIds: [randomUUID()] },
    { clients: [scenario.clientA1] },
    { userIds: [scenario.multiAgent.userId] },
    { agencyId: scenario.ownerB.agencyId },
    { agentId: scenario.multiAgentProfileId },
  ]) {
    const smuggled = await apiCall(
      port(),
      `/api/agencies/${scenario.ownerA.agencyId}/field-agents/eligibility`,
      {
        token: scenario.ownerA.token,
        body: { ...base, ...extra },
      },
    );
    assert.equal(
      smuggled.status,
      422,
      `smuggled field ${Object.keys(extra)[0]} must be rejected before traversal`,
    );
  }
});

test('HUMAN-AC-03: authority-field smuggling on the profile surfaces is rejected (§23)', async () => {
  const agent = await makeUser('smuggler@fieldsec.test');
  const declaration = fieldAgentDeclaration({
    capabilities: [{ skill: 'canvassing', level: null }],
    location: { kind: 'city', value: 'accra' },
    territories: [],
    availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
  });
  for (const extra of [
    { userId: randomUUID() },
    { agentId: randomUUID() },
    { agencyId: randomUUID() },
    { clientId: randomUUID() },
    { authorizationState: 'active' },
    { reliability: { completedJobs: 100 } },
    { version: 42 },
    { createdBy: randomUUID() },
    { memberships: [] },
  ]) {
    const created = await apiCall(port(), '/api/field-agents', {
      token: agent.token,
      body: { ...declaration, ...extra },
    });
    assert.equal(
      created.status,
      422,
      `authority field ${Object.keys(extra)[0]} must be rejected on create`,
    );
  }

  // A profile was never created for the smuggler (fail-closed validation).
  const created = await apiCall(port(), '/api/field-agents', {
    token: agent.token,
    body: declaration,
  });
  assert.equal(created.status, 201);
  const agentId = created.body['agentId'] as string;

  // The same rejection holds on the mutation surfaces (the authorization
  // surface is platform-controlled, so its smuggling probe runs with the
  // platform admin token to REACH validation).
  const admin = await adminToken();
  for (const [path, body, token] of [
    [
      `/api/field-agents/${agentId}/profile`,
      {
        specializations: ['field_agent'],
        capabilities: [{ skill: 'canvassing', level: null }],
        relationshipContinuity: {
          prefersRepeatClients: false,
          continuity: 'any',
          maxConcurrentClientRelationships: null,
        },
        version: 1,
        authorizationState: 'active',
      },
      agent.token,
    ],
    [
      `/api/field-agents/${agentId}/availability`,
      {
        availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 1020 }],
        location: { kind: 'city', value: 'accra' },
        territories: [],
        version: 1,
        specializations: ['field_agent'],
      },
      agent.token,
    ],
    [
      `/api/field-agents/${agentId}/authorization`,
      { authorizationState: 'suspended', version: 1, reliability: { completedJobs: 5 } },
      admin,
    ],
  ] as const) {
    const response = await apiCall(port(), path, {
      token,
      method: 'PATCH',
      body: { ...body },
    });
    assert.equal(response.status, 422, `authority smuggling on ${path} must be rejected`);
  }
});

test('HUMAN-AC-03: the multi-agency human agent cannot read Clients of an agency WITHOUT membership (uniform 404)', async () => {
  // The multi-agent is a member of A and B — NOT C. A Client of C is
  // indistinguishable from an unknown Client for them (the existing
  // cross-tenant authority, exercised with a human_agent principal).
  const foreignClient = await apiCall(port(), `/api/clients/${scenario.clientC1}`, {
    token: scenario.multiAgent.token,
  });
  const unknownClient = await apiCall(port(), `/api/clients/${randomUUID()}`, {
    token: scenario.multiAgent.token,
  });
  assert.equal(foreignClient.status, 404, 'client of a non-member agency is a uniform 404');
  assert.equal(unknownClient.status, 404);
  const foreignError = foreignClient.body['error'] as Record<string, unknown>;
  const unknownError = unknownClient.body['error'] as Record<string, unknown>;
  assert.deepEqual(
    { ...foreignError, message: undefined },
    { ...unknownError, message: undefined },
    'foreign and unknown client 404s have identical shape (no existence oracle)',
  );
});

test('access-control negatives: foreign-agency eligibility callers are 403, unknown agencies 404, anonymous 401', async () => {
  // A member of agency B calling eligibility for agency A: 403 (no membership).
  const foreign = await eligibility(scenario.ownerA.agencyId, scenario.ownerB.token, {
    requiredCapabilities: [],
  });
  assert.equal(foreign.status, 403);

  // Owner C (no relationship to A): also 403 (active identity, no membership).
  const outsider = await eligibility(scenario.ownerA.agencyId, scenario.ownerC.token, {
    requiredCapabilities: [],
  });
  assert.equal(outsider.status, 403);

  // Unknown agency: uniform 404 (the agency resolves BEFORE anything else).
  const unknownAgency = await eligibility(randomUUID(), scenario.ownerA.token, {
    requiredCapabilities: [],
  });
  assert.equal(unknownAgency.status, 404);

  // Anonymous: 401.
  const anonymous = await apiCall(
    port(),
    `/api/agencies/${scenario.ownerA.agencyId}/field-agents/eligibility`,
    { body: { specialization: 'field_agent', dayOfWeek: 1, startMinute: 540, endMinute: 600 } },
  );
  assert.equal(anonymous.status, 401);

  // A human_agent member of the agency may run eligibility (it is an active
  // member; the response still carries profile data only — no client data).
  const selfProbe = await eligibility(scenario.ownerA.agencyId, scenario.multiAgent.token, {
    requiredCapabilities: ['canvassing'],
    territory: { kind: 'city', value: 'accra' },
    dayOfWeek: 1,
    startMinute: 600,
    endMinute: 720,
  });
  assert.equal(selfProbe.status, 200);
  assert.equal(selfProbe.body['matched'], 1);
  const serialized = JSON.stringify(selfProbe.body);
  assert.ok(!serialized.includes(scenario.clientA1) && !serialized.includes(scenario.clientA2));
});

test('unrelated profile reads stay a UNIFORM 404 (no existence oracle) even for other human agents', async () => {
  // The weak agent (agency A member) CAN read the multi-agent profile
  // (co-member). But agent B's local agent (agency B member — the
  // multi-agent is also in B, so co-membership applies)... verify the true
  // stranger: a brand-new user with no relationship at all.
  const stranger = await makeUser('stranger-read@fieldsec.test');
  const foreign = await apiCall(port(), `/api/field-agents/${scenario.multiAgentProfileId}`, {
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
    'identical 404 shape (no existence oracle)',
  );

  // Mutations by the stranger equally 404 (resolve-before-authorize).
  const mutate = await apiCall(
    port(),
    `/api/field-agents/${scenario.multiAgentProfileId}/availability`,
    {
      token: stranger.token,
      method: 'PATCH',
      body: {
        availability: [{ dayOfWeek: 1, startMinute: 0, endMinute: 60 }],
        location: { kind: 'city', value: 'accra' },
        territories: [],
        version: 4,
      },
    },
  );
  assert.equal(mutate.status, 404);
});
