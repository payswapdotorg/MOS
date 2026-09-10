/**
 * MKT-020 integration tests — the logical Agent/Capability contract
 * surfaces on the real stack (embedded PostgreSQL 18 + real API process —
 * no mocks of platform services).
 *
 * Acceptance mapping (work-item-matrix.md MKT-020 = AGENT-001 /
 * "provider-neutral capability tests"):
 *   - the ROUND-TRIP proof: a declared capability round-trips through the
 *     API AND the database UNCHANGED (register → serialized response →
 *     direct SQL read-back all deep-equal the declared descriptors), and
 *     the full register/list/read/retire lifecycle works through the
 *     provider-neutral contract (retired tombstones stay readable);
 *   - provider neutrality (API half): registration requests carrying
 *     provider/model/SDK/credential-shaped fields,
 *     infrastructure-coupling fields (sandbox/pool/queue/runtime/
 *     deployment) and tenant/workflow/execution references are 422s — at
 *     the top level, on the capability descriptor and at every nesting
 *     level of the descriptor parameters;
 *   - caller-authority rejection: server-derived fields (identity, scope,
 *     lifecycle, provenance) supplied by callers are 422s;
 *   - duplicate convergence: the §8-style command fence per scope
 *     converges same-key/same-payload replays (200 replayed=true, ONE
 *     row) and rejects same-key/different-payload (409); the
 *     (scope, agent_key) ACTIVE declaration fence is a deterministic 409,
 *     freed by retirement (append-oriented versioning);
 *   - cross-scope isolation: foreign agency-scoped identifiers yield
 *     UNIFORM 404s (no cross-tenant oracle — an agent ID never grants
 *     access); agency registration/listing requires membership; the
 *     platform catalog stays readable to every authenticated principal;
 *   - role enforcement: agency-scope writes require owner/admin (403 for
 *     operators), reads stay member-visible; platform-scope mutations
 *     require the platform administrator; the service principal can
 *     register platform declarations (the future runtime caller shape);
 *   - append semantics: the lifecycle history is append-only (DB rejects
 *     UPDATE and DELETE; no second retirement), declared content is
 *     immutable (DB rejects rewrites), retired is terminal (DB rejects
 *     resurrection), the scope cannot migrate, the descriptor shape
 *     CHECK rejects provider-shaped descriptors under direct SQL, and
 *     the storage stays tenant-data-free (information_schema column
 *     check).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
} from './helpers/harness.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';
const SERVICE_TOKEN = 'integration-test-token';

let stack: IntegrationStack | null = null;
let api: { port: number; child: ChildProcessWithoutNullStreams } | null = null;

function the(): { stack: IntegrationStack; api: { port: number; child: ChildProcessWithoutNullStreams } } {
  if (stack === null || api === null) throw new Error('test stack not booted');
  return { stack, api };
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

before(async () => {
  stack = await bootStack('agents');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

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

async function makeUser(email: string, password: string): Promise<User> {
  const admin = await adminToken();
  const create = await apiCall(port(), '/api/users', {
    token: admin,
    body: { email, displayName: email.split('@')[0]! },
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const userId = create.body['userId'] as string;
  const cred = await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  assert.equal(cred.status, 204);
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Agency {
  readonly agencyId: string;
  readonly owner: User;
}

async function makeAgency(label: string): Promise<Agency> {
  const owner = await makeUser(`${label}-owner@marketingos.test`, `${label}-owner-pass-123`);
  const agency = await apiCall(port(), '/api/agencies', {
    token: await adminToken(),
    body: { name: `${label} agency`, ownerUserId: owner.userId },
  });
  assert.equal(agency.status, 201);
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { agencyId, owner };
}

/** A fully valid provider-neutral registration body. */
function agentBody(agentKey: string, idempotencyKey: string): Record<string, unknown> {
  return {
    agentKey,
    displayName: `${agentKey} Agent`,
    versionLabel: '1.0.0',
    description:
      'Declares reusable copywriting capabilities: brand-voice text generation with review escalation.',
    capabilities: [
      {
        capabilityKind: 'text-generation',
        parameters: {
          maxOutputTokens: 2048,
          outputFormat: 'markdown',
          languages: ['en', 'fr'],
        },
      },
      {
        capabilityKind: 'human-review',
        parameters: { reviewStage: 'final', sla: { maxHours: 24 } },
      },
    ],
    idempotencyKey,
  };
}

// ---------------------------------------------------------------------------
// The round-trip proof (AGENT-001: "any declared capability round-trips
// through the API/DB unchanged")
// ---------------------------------------------------------------------------

test('AGENT-001 round-trip: platform declarations register, list, read and retire — capabilities round-trip UNCHANGED through the API and the DB', async () => {
  const { stack: st } = the();
  const create = await apiCall(port(), '/api/agents', {
    token: await adminToken(),
    body: agentBody('copy-writer', 'rt-platform-1'),
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body['replayed'], false);
  const agent = create.body['agent'] as Record<string, unknown>;
  assert.equal(agent['agentKey'], 'copy-writer');
  assert.equal(agent['status'], 'active');
  assert.equal(agent['scopeKind'], 'platform');
  assert.equal(agent['version'], 1);
  assert.ok(!('agencyId' in agent), 'platform-scoped declarations carry no agency scope');

  // THE round-trip: the serialized capabilities deep-equal the declared
  // descriptors — unchanged through the API.
  assert.deepEqual(
    agent['capabilities'],
    (agentBody('copy-writer', 'rt-platform-1')['capabilities'] as unknown[]),
    'the declared capabilities round-trip through the API unchanged',
  );
  // ...and the serialized record carries NO provider/model/credential/
  // infrastructure field.
  for (const forbidden of [
    'provider',
    'providerLabel',
    'model',
    'modelId',
    'sdk',
    'adapter',
    'credential',
    'apiKey',
    'sandboxId',
    'queueId',
    'runtimeClass',
    'deploymentId',
    'executionId',
    'workflowId',
    'clientId',
    'workspaceId',
  ]) {
    assert.ok(!(forbidden in agent), `the serialized declaration must not carry '${forbidden}'`);
  }

  // ...and through the DATABASE: the stored jsonb deep-equals the input.
  const stored = await st.pg.pool.query<{ capabilities: unknown[] }>(
    'SELECT capabilities FROM logical_agents WHERE agent_id = $1',
    [agent['agentId'] as string],
  );
  assert.equal(stored.rows.length, 1);
  assert.deepEqual(
    stored.rows[0]!.capabilities,
    agentBody('copy-writer', 'rt-platform-1')['capabilities'],
    'the declared capabilities round-trip through the DB unchanged',
  );

  // The lifecycle history starts with the registered event.
  const history = await apiCall(port(), `/api/agents/${agent['agentId']}/lifecycle-events`, {
    token: await adminToken(),
  });
  assert.equal(history.status, 200);
  const events = history.body['lifecycleEvents'] as Record<string, unknown>[];
  assert.equal(events.length, 1);
  assert.equal(events[0]!['transition'], 'registered');
  assert.equal(events[0]!['fromStatus'], null);
  assert.equal(events[0]!['toStatus'], 'active');

  // The platform catalog lists ACTIVE declarations only.
  const list = await apiCall(port(), '/api/agents', {
    token: await adminToken(),
  });
  assert.equal(list.status, 200);
  assert.ok(
    (list.body['agents'] as unknown[]).some(
      (entry) => (entry as Record<string, unknown>)['agentId'] === agent['agentId'],
    ),
  );

  // Retire: a stale version is a 409; the correct version retires.
  const badRetire = await apiCall(port(), `/api/agents/${agent['agentId']}/retire`, {
    token: await adminToken(),
    body: { version: 99 },
  });
  assert.equal(badRetire.status, 409);
  const retire = await apiCall(port(), `/api/agents/${agent['agentId']}/retire`, {
    token: await adminToken(),
    body: { version: 1, reason: 'superseded by v2' },
  });
  assert.equal(retire.status, 200, JSON.stringify(retire.body));
  const retired = retire.body as Record<string, unknown>;
  assert.equal(retired['status'], 'retired');
  assert.equal(retired['version'], 2);

  // The tombstone stays readable; there is NO second retirement.
  const read = await apiCall(port(), `/api/agents/${agent['agentId']}`, {
    token: await adminToken(),
  });
  assert.equal(read.status, 200);
  assert.equal((read.body as Record<string, unknown>)['status'], 'retired');
  const secondRetire = await apiCall(port(), `/api/agents/${agent['agentId']}/retire`, {
    token: await adminToken(),
    body: { version: 2 },
  });
  assert.equal(secondRetire.status, 409, 'retirement is terminal — no second retirement');

  // The platform catalog no longer lists the retired declaration; the
  // lifecycle history gained the retired event.
  const listAfter = await apiCall(port(), '/api/agents', {
    token: await adminToken(),
  });
  assert.ok(
    !(listAfter.body['agents'] as unknown[]).some(
      (entry) => (entry as Record<string, unknown>)['agentId'] === agent['agentId'],
    ),
    'the ACTIVE-only platform catalog excludes retired declarations',
  );
  const historyAfter = await apiCall(port(), `/api/agents/${agent['agentId']}/lifecycle-events`, {
    token: await adminToken(),
  });
  const eventsAfter = historyAfter.body['lifecycleEvents'] as Record<string, unknown>[];
  assert.equal(eventsAfter.length, 2);
  assert.equal(eventsAfter[1]!['transition'], 'retired');
  assert.equal(eventsAfter[1]!['fromStatus'], 'active');
  assert.equal(eventsAfter[1]!['toStatus'], 'retired');
  assert.equal(eventsAfter[1]!['reason'], 'superseded by v2');
});

test('AGENT-001 round-trip: agency-scoped declarations carry the owning agency and list in every lifecycle state', async () => {
  const agency = await makeAgency('rtagency');
  const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('ad-auditor', 'rt-agency-1'),
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  const agent = create.body['agent'] as Record<string, unknown>;
  assert.equal(agent['scopeKind'], 'agency');
  assert.equal(agent['agencyId'], agency.agencyId);
  assert.deepEqual(
    agent['capabilities'],
    agentBody('ad-auditor', 'rt-agency-1')['capabilities'],
    'the agency-scoped capabilities round-trip unchanged',
  );

  // The agency surface lists every lifecycle state (retired history stays
  // visible); the platform catalog does NOT list agency declarations.
  const retire = await apiCall(port(), `/api/agents/${agent['agentId']}/retire`, {
    token: agency.owner.token,
    body: { version: 1 },
  });
  assert.equal(retire.status, 200);
  const list = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
  });
  assert.equal(list.status, 200);
  assert.equal((list.body['agents'] as unknown[]).length, 1);
  assert.equal(
    ((list.body['agents'] as Record<string, unknown>[])[0]!['status']),
    'retired',
    'the agency registry lists tombstones (history stays visible)',
  );
  const platformList = await apiCall(port(), '/api/agents', {
    token: await adminToken(),
  });
  assert.ok(
    !(platformList.body['agents'] as unknown[]).some(
      (entry) => (entry as Record<string, unknown>)['agentId'] === agent['agentId'],
    ),
    'agency-scoped declarations never appear in the platform catalog',
  );
});

// ---------------------------------------------------------------------------
// Provider neutrality + authority-field rejection at the API surface
// ---------------------------------------------------------------------------

test('AGENT-001 provider neutrality: registration requests carrying provider/SDK/credential/infrastructure/tenant fields are 422s', async () => {
  const agency = await makeAgency('neutrality');
  for (const key of [
    'provider',
    'model',
    'modelId',
    'modelKey',
    'sdk',
    'adapter',
    'credential',
    'secret',
    'apiKey',
    'token',
    'password',
    'sandboxId',
    'queueId',
    'runtimeClass',
    'deploymentId',
    'endpoint',
    'executionId',
    'workflowId',
    'clientId',
    'workspaceId',
    'goalId',
  ]) {
    const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
      token: agency.owner.token,
      body: { ...agentBody(`neutral-${key}`, `neutral-${key}-1`), [key]: 'x' },
    });
    assert.equal(
      create.status,
      422,
      `the '${key}' field must be rejected (provider neutrality / no infrastructure coupling)`,
    );
  }
});

test('AGENT-001 authority-field rejection: server-derived fields are 422s, including on retire', async () => {
  const agency = await makeAgency('authority');
  for (const key of ['agentId', 'scopeKind', 'agencyId', 'status', 'version', 'createFingerprint', 'createdBy', 'createdAt']) {
    const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
      token: agency.owner.token,
      body: { ...agentBody(`authority-${key}`, `authority-${key}-1`), [key]: 'x' },
    });
    assert.equal(create.status, 422, `the server-derived '${key}' must be rejected`);
  }

  const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('authority-agent', 'authority-agent-1'),
  });
  assert.equal(create.status, 201);
  const agentId = (create.body['agent'] as Record<string, unknown>)['agentId'] as string;
  for (const key of ['agentKey', 'displayName', 'status', 'scopeKind', 'agencyId', 'createFingerprint']) {
    const retire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
      token: agency.owner.token,
      body: { version: 1, [key]: 'x' },
    });
    assert.equal(retire.status, 422, `the retire surface rejects the authority field '${key}'`);
  }
});

test('AGENT-001 descriptor neutrality: extra descriptor keys and forbidden NESTED parameter keys are 422s', async () => {
  const agency = await makeAgency('descriptor');

  // Descriptor with an extra provider-shaped key.
  const extraKey = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: {
      ...agentBody('descriptor-extra', 'descriptor-extra-1'),
      capabilities: [{ capabilityKind: 'text-generation', parameters: {}, provider: 'openai' }],
    },
  });
  assert.equal(extraKey.status, 422, 'a descriptor carrying a provider key is rejected');

  // Parameters carrying a forbidden key at the TOP level.
  for (const key of ['provider', 'model', 'apiKey', 'secret', 'sandboxId', 'queueId', 'executionId', 'clientId']) {
    const nested = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
      token: agency.owner.token,
      body: {
        ...agentBody(`descriptor-nested-${key}`, `descriptor-nested-${key}-1`),
        capabilities: [
          { capabilityKind: 'text-generation', parameters: { [key]: 'x' } },
        ],
      },
    });
    assert.equal(nested.status, 422, `a forbidden parameter key '${key}' is rejected`);
  }

  // Parameters carrying a forbidden key NESTED (inside an array element).
  const deep = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: {
      ...agentBody('descriptor-deep', 'descriptor-deep-1'),
      capabilities: [
        {
          capabilityKind: 'text-generation',
          parameters: { fallbacks: [{ model: 'provider-model-x', reason: 'cheap' }] },
        },
      ],
    },
  });
  assert.equal(deep.status, 422, 'a forbidden key nested inside parameters is rejected');

  // An empty capabilities array is not a capability declaration.
  const empty = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: { ...agentBody('descriptor-empty', 'descriptor-empty-1'), capabilities: [] },
  });
  assert.equal(empty.status, 422, 'a declaration with zero capabilities is rejected');
});

// ---------------------------------------------------------------------------
// Duplicate convergence (§8) + the ACTIVE declaration fence
// ---------------------------------------------------------------------------

test('the §8-style command fence converges same-key replays and rejects key reuse (ONE row); the ACTIVE fence frees on retirement', async () => {
  const agency = await makeAgency('converge');
  const first = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('brand-voice', 'converge-1'),
  });
  assert.equal(first.status, 201);
  assert.equal(first.body['replayed'], false);

  // A duplicate of the SAME logical command converges (200, replayed).
  const replay = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('brand-voice', 'converge-1'),
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body['replayed'], true);
  assert.equal(
    (replay.body['agent'] as Record<string, unknown>)['agentId'],
    (first.body['agent'] as Record<string, unknown>)['agentId'],
    'the replay converges to the EXISTING identity',
  );

  // Exactly ONE row in the agency registry.
  const list = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
  });
  assert.equal((list.body['agents'] as unknown[]).length, 1);

  // The same key reused for a DIFFERENT command is a 409.
  const conflict = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: { ...agentBody('brand-voice', 'converge-1'), versionLabel: '2.0.0' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    ((conflict.body as Record<string, unknown>)['error'] as Record<string, unknown>)['code'],
    'IDEMPOTENCY_CONFLICT',
  );

  // A fresh command key whose agent_key already has an ACTIVE declaration
  // is the deterministic duplicate fence (409).
  const duplicate = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('brand-voice', 'converge-2'),
  });
  assert.equal(duplicate.status, 409, 'one ACTIVE declaration per (scope, agent_key)');

  // Retirement frees the key: the SAME agent_key registers as a NEW
  // identity (append-oriented versioning).
  const agentId = (first.body['agent'] as Record<string, unknown>)['agentId'] as string;
  const retire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
    token: agency.owner.token,
    body: { version: 1, reason: 'superseded' },
  });
  assert.equal(retire.status, 200);
  const next = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: { ...agentBody('brand-voice', 'converge-3'), versionLabel: '2.0.0' },
  });
  assert.equal(next.status, 201, 'a retired key is free for a NEW version identity');
  assert.notEqual(
    (next.body['agent'] as Record<string, unknown>)['agentId'],
    agentId,
    'the new declaration is a NEW identity',
  );
  // Both rows (the tombstone and the new version) are visible in the
  // agency registry.
  const listAll = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
  });
  assert.equal((listAll.body['agents'] as unknown[]).length, 2);

  // The same idempotency key in a DIFFERENT scope is a different logical
  // command (the fences are per scope).
  const otherAgency = await makeAgency('converge2');
  const crossScope = await apiCall(port(), `/api/agencies/${otherAgency.agencyId}/agents`, {
    token: otherAgency.owner.token,
    body: agentBody('brand-voice', 'converge-1'),
  });
  assert.equal(crossScope.status, 201, 'idempotency fences are scoped per ownership scope');
});

// ---------------------------------------------------------------------------
// Cross-scope isolation (uniform 404s — no cross-tenant oracle)
// ---------------------------------------------------------------------------

test('cross-scope isolation: foreign agency-scoped identifiers are UNIFORM 404s; agency surfaces require membership', async () => {
  const agencyA = await makeAgency('isoa');
  const agencyB = await makeAgency('isob');
  const outsider = await makeUser('iso-outsider@marketingos.test', 'iso-outsider-pass-123');

  const create = await apiCall(port(), `/api/agencies/${agencyA.agencyId}/agents`, {
    token: agencyA.owner.token,
    body: agentBody('campaign-designer', 'iso-1'),
  });
  assert.equal(create.status, 201);
  const agentId = (create.body['agent'] as Record<string, unknown>)['agentId'] as string;

  // Foreign agency owner: read, retire and history all yield the SAME 404
  // as an unknown identifier — an agent ID never grants access.
  for (const [description, pathName, method, body] of [
    ['read', `/api/agents/${agentId}`, 'GET', undefined],
    ['retire', `/api/agents/${agentId}/retire`, 'POST', { version: 1 }],
    ['lifecycle history', `/api/agents/${agentId}/lifecycle-events`, 'GET', undefined],
  ] as const) {
    const foreign = await apiCall(port(), pathName, {
      token: agencyB.owner.token,
      method,
      body,
    });
    assert.equal(foreign.status, 404, `foreign ${description} is a uniform 404`);
    const unknown = await apiCall(port(), pathName.replace(agentId, '11111111-1111-4111-8111-111111111111'), {
      token: agencyB.owner.token,
      method,
      body,
    });
    assert.equal(unknown.status, 404, `unknown ${description} is a uniform 404`);
    assert.equal(
      (foreign.body as Record<string, unknown>)['code'],
      (unknown.body as Record<string, unknown>)['code'],
      'foreign and unknown identifiers are indistinguishable (no oracle)',
    );
  }

  // A user with no membership in the owning agency: same uniform 404.
  const outsiderRead = await apiCall(port(), `/api/agents/${agentId}`, {
    token: outsider.token,
  });
  assert.equal(outsiderRead.status, 404);

  // The platform catalog stays readable to every authenticated principal
  // (including the outsider) — but lists ONLY platform declarations.
  const outsiderCatalog = await apiCall(port(), '/api/agents', {
    token: outsider.token,
  });
  assert.equal(outsiderCatalog.status, 200);
  assert.ok(
    !(outsiderCatalog.body['agents'] as unknown[]).some(
      (entry) => (entry as Record<string, unknown>)['agencyId'] === agencyA.agencyId,
    ),
  );

  // Agency B's owner cannot list agency A's registry (agency surface
  // requires membership — the /agencies posture).
  const foreignList = await apiCall(port(), `/api/agencies/${agencyA.agencyId}/agents`, {
    token: agencyB.owner.token,
  });
  assert.equal(foreignList.status, 403);

  // The platform administrator CAN read the agency-scoped declaration
  // (platform operators mirror every scoped check).
  const adminRead = await apiCall(port(), `/api/agents/${agentId}`, {
    token: await adminToken(),
  });
  assert.equal(adminRead.status, 200);
});

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

test('role enforcement: agency-scope writes require owner/admin; reads stay member-visible; platform mutations require the platform administrator', async () => {
  const agency = await makeAgency('roles');
  const member = await makeUser('agents-roles-member@marketingos.test', 'agents-roles-pass-123');
  const grant = await apiCall(port(), `/api/agencies/${agency.agencyId}/memberships`, {
    token: agency.owner.token,
    body: { userId: member.userId, role: 'agency_operator' },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.body));

  // An operator cannot register (403)...
  const denied = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: member.token,
    body: agentBody('role-agent', 'roles-1'),
  });
  assert.equal(denied.status, 403, 'operators cannot write the agency registry');

  // ...but reads stay member-visible.
  const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('role-agent', 'roles-1'),
  });
  assert.equal(create.status, 201);
  const agentId = (create.body['agent'] as Record<string, unknown>)['agentId'] as string;
  const memberList = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: member.token,
  });
  assert.equal(memberList.status, 200);
  const memberRead = await apiCall(port(), `/api/agents/${agentId}`, {
    token: member.token,
  });
  assert.equal(memberRead.status, 200);

  // An operator cannot retire (403); the owner can.
  const deniedRetire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
    token: member.token,
    body: { version: 1 },
  });
  assert.equal(deniedRetire.status, 403);
  const ownerRetire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
    token: agency.owner.token,
    body: { version: 1 },
  });
  assert.equal(ownerRetire.status, 200);

  // The platform administrator can register into an agency scope
  // (platform operators pass the agency checks)...
  const adminAgencyCreate = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: await adminToken(),
    body: agentBody('role-agent-admin', 'roles-2'),
  });
  assert.equal(adminAgencyCreate.status, 201);

  // ...and a plain agency owner CANNOT mutate the platform scope (403).
  const deniedPlatform = await apiCall(port(), '/api/agents', {
    token: agency.owner.token,
    body: agentBody('role-platform', 'roles-3'),
  });
  assert.equal(deniedPlatform.status, 403, 'platform-scope registration is platform-admin only');
});

test('the service principal (the future runtime caller shape) can register platform declarations', async () => {
  const create = await apiCall(port(), '/api/agents', {
    token: SERVICE_TOKEN,
    body: agentBody('svc-registered', 'svc-1'),
  });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal((create.body['agent'] as Record<string, unknown>)['scopeKind'], 'platform');
});

// ---------------------------------------------------------------------------
// DB backstops — immutability, terminal lifecycle, append-only history,
// descriptor shape, tenant-data-free storage
// ---------------------------------------------------------------------------

test('declared content, scope and provenance are immutable at the DATABASE level; retired is terminal', async () => {
  const { stack: st } = the();
  const agency = await makeAgency('dbimmutable');
  const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('db-guarded', 'dbimmutable-1'),
  });
  assert.equal(create.status, 201);
  const agentId = (create.body['agent'] as Record<string, unknown>)['agentId'] as string;

  await assert.rejects(
    st.pg.pool.query('UPDATE logical_agents SET description = $1 WHERE agent_id = $2', [
      'hijacked contract text',
      agentId,
    ]),
    /declared contract is immutable/i,
    'rewriting the contract text must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query("UPDATE logical_agents SET capabilities = '[{\"capabilityKind\":\"x\",\"parameters\":{}}]'::jsonb WHERE agent_id = $1", [
      agentId,
    ]),
    /declared contract is immutable/i,
    'rewriting the declared capabilities must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('UPDATE logical_agents SET agent_key = $1 WHERE agent_id = $2', [
      'hijacked-key',
      agentId,
    ]),
    /immutable/i,
    'rewriting the agent key must be DB-rejected',
  );
  // Scope migration (agency → another agency and agency → platform) is
  // DB-rejected: a declaration never crosses scopes.
  await assert.rejects(
    st.pg.pool.query('UPDATE logical_agents SET agency_id = NULL WHERE agent_id = $1', [agentId]),
    /ownership scope is immutable/i,
    'migrating an agency declaration to platform scope must be DB-rejected',
  );

  // Retire through the API, then attempt resurrection by direct SQL.
  const retire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
    token: agency.owner.token,
    body: { version: 1 },
  });
  assert.equal(retire.status, 200);
  await assert.rejects(
    st.pg.pool.query("UPDATE logical_agents SET status = 'active' WHERE agent_id = $1", [agentId]),
    /retired and terminal/i,
    'resurrecting a retired declaration must be DB-rejected',
  );
});

test('the lifecycle history is append-only at the DATABASE level (UPDATE/DELETE rejected) with no second retirement', async () => {
  const { stack: st } = the();
  const agency = await makeAgency('dbappend');
  const create = await apiCall(port(), `/api/agencies/${agency.agencyId}/agents`, {
    token: agency.owner.token,
    body: agentBody('db-history', 'dbappend-1'),
  });
  assert.equal(create.status, 201);
  const agentId = (create.body['agent'] as Record<string, unknown>)['agentId'] as string;

  const retire = await apiCall(port(), `/api/agents/${agentId}/retire`, {
    token: agency.owner.token,
    body: { version: 1, reason: 'done' },
  });
  assert.equal(retire.status, 200);

  const events = await st.pg.pool.query<{ event_id: string }>(
    'SELECT event_id FROM logical_agent_lifecycle_events WHERE agent_id = $1 ORDER BY created_at',
    [agentId],
  );
  assert.equal(events.rows.length, 2, 'registered + retired');
  const retiredEventId = events.rows[1]!.event_id;

  await assert.rejects(
    st.pg.pool.query('UPDATE logical_agent_lifecycle_events SET reason = $1 WHERE event_id = $2', [
      'rewritten',
      retiredEventId,
    ]),
    /append-only history/i,
    'UPDATE on lifecycle history must be DB-rejected',
  );
  await assert.rejects(
    st.pg.pool.query('DELETE FROM logical_agent_lifecycle_events WHERE event_id = $1', [
      retiredEventId,
    ]),
    /append-only history/i,
    'DELETE on lifecycle history must be DB-rejected',
  );
  // A second 'retired' event is impossible (the once-per-transition
  // fence) — and an illegal pair (registered with a from status) is
  // rejected by the legality backstop.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agent_lifecycle_events (event_id, agent_id, transition, from_status, to_status)
       VALUES ($1, $2, 'retired', 'active', 'retired')`,
      ['99999999-9999-4999-8999-999999999999', agentId],
    ),
    /once_unique|unique constraint/i,
    'a second retired event must be DB-rejected (no second retirement)',
  );
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agent_lifecycle_events (event_id, agent_id, transition, from_status, to_status)
       VALUES ($1, $2, 'registered', 'retired', 'active')`,
      ['99999998-9999-4999-8999-999999999998', agentId],
    ),
    /illegal registered lifecycle event/i,
    'an illegal lifecycle pair must be DB-rejected',
  );
});

test('the descriptor shape CHECK rejects provider-shaped and malformed descriptors under direct SQL', async () => {
  const { stack: st } = the();
  const base = {
    agent_key: 'shape-guard',
    display_name: 'Shape Guard',
    version_label: '1.0.0',
    description: 'shape validation probe',
    agency_id: null,
    idempotency_key: 'shape-guard-1',
    create_fingerprint: 'a'.repeat(64),
  };
  // A descriptor with THREE keys (provider smuggled in) — rejected.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agents (agent_id, agent_key, display_name, version_label, description,
                                    capabilities, agency_id, status, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9)`,
      [
        '88888888-8888-4888-8888-888888888888',
        base.agent_key,
        base.display_name,
        base.version_label,
        base.description,
        JSON.stringify([{ capabilityKind: 'x', parameters: {}, provider: 'openai' }]),
        base.agency_id,
        base.idempotency_key,
        base.create_fingerprint,
      ],
    ),
    /logical_agents_capabilities/i,
    'a provider-shaped descriptor must be DB-rejected',
  );
  // A descriptor missing 'parameters' — rejected.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agents (agent_id, agent_key, display_name, version_label, description,
                                    capabilities, agency_id, status, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9)`,
      [
        '88888888-8888-4888-8888-888888888887',
        base.agent_key,
        base.display_name,
        base.version_label,
        base.description,
        JSON.stringify([{ capabilityKind: 'x' }]),
        base.agency_id,
        base.idempotency_key + '-2',
        base.create_fingerprint,
      ],
    ),
    /logical_agents_capabilities/i,
    'a malformed descriptor must be DB-rejected',
  );
  // A non-object parameters value — rejected.
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agents (agent_id, agent_key, display_name, version_label, description,
                                    capabilities, agency_id, status, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9)`,
      [
        '88888888-8888-4888-8888-888888888886',
        base.agent_key,
        base.display_name,
        base.version_label,
        base.description,
        JSON.stringify([{ capabilityKind: 'x', parameters: ['array'] }]),
        base.agency_id,
        base.idempotency_key + '-3',
        base.create_fingerprint,
      ],
    ),
    /logical_agents_capabilities/i,
    'a non-object parameters value must be DB-rejected',
  );
  // An agency_id pointing at a nonexistent agency — FK-rejected (the
  // scope backstop).
  await assert.rejects(
    st.pg.pool.query(
      `INSERT INTO logical_agents (agent_id, agent_key, display_name, version_label, description,
                                    capabilities, agency_id, status, idempotency_key, create_fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'active', $8, $9)`,
      [
        '88888888-8888-4888-8888-888888888885',
        base.agent_key,
        base.display_name,
        base.version_label,
        base.description,
        JSON.stringify([{ capabilityKind: 'x', parameters: {} }]),
        '77777777-7777-4777-8777-777777777777',
        base.idempotency_key + '-4',
        base.create_fingerprint,
      ],
    ),
    /foreign key/i,
    'a nonexistent owning agency must be FK-rejected',
  );
});

test('the logical_agents storage stays tenant-data-free: no client/workspace/goal/workflow/execution columns exist', async () => {
  const { stack: st } = the();
  const columns = await st.pg.pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'logical_agents'`,
  );
  const names = columns.rows.map((row) => row.column_name);
  for (const forbidden of [
    'client_id',
    'workspace_id',
    'goal_id',
    'workflow_id',
    'execution_id',
    'task_id',
    'sandbox_id',
    'deployment_id',
    'provider',
    'provider_id',
    'provider_label',
    'model_id',
    'model_key',
    'sdk',
    'api_key',
    'credential_id',
    'secret_handle',
    'runtime_class',
    'queue_id',
    'pool_id',
  ]) {
    assert.ok(
      !names.includes(forbidden),
      `logical_agents must not carry the '${forbidden}' column — the logical Agent owns no tenant data, workflow state, deployment state, infrastructure or provider selection (architecture.md §12)`,
    );
  }
  // The ownership scope and the contract columns DO exist.
  for (const required of [
    'agent_id',
    'agent_key',
    'display_name',
    'version_label',
    'description',
    'capabilities',
    'agency_id',
    'status',
  ]) {
    assert.ok(names.includes(required), `logical_agents.${required} required`);
  }
});
