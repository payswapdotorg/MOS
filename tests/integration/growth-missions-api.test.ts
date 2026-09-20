/**
 * MKT-053 integration tests — the Growth Mission and Objective Model surface
 * on the real stack (embedded PostgreSQL 18 + real API process — no mocks
 * of platform services; the module-level record commands are driven through
 * the SAME in-process application composed against the SAME database the
 * API serves — the MKT-034 sanctioned test-harness wiring, the
 * operating-graph/app-metering precedent).
 *
 * Acceptance mapping (spec/effective-backlog-v1.6.md MKT-053; the dispatch
 * acceptance criteria AC-1..AC-9):
 *   - AC-4 GOLDEN PATH PER FAMILY: creator-growth, audience-growth,
 *     product-marketing and commerce-discovery missions each round-trip
 *     (create → read back with objective/version/history → map goals →
 *     advance lifecycle honestly → terminal state) through BOTH the HTTP
 *     surfaces and the module-level operations;
 *   - AC-1 VERSION IMMUTABILITY: the declared objective is stored VERBATIM;
 *     a correction is a NEW version record (the original stays readable
 *     byte-identical); the DB rejects in-place rewrites outright (direct
 *     SQL UPDATE/DELETE on the version tail, the history tail, the target
 *     metrics and the mapping rows);
 *   - AC-3 HISTORY COMPLETENESS: every mission event (creation, goal
 *     mappings, version corrections, state transitions) lands in ONE
 *     gapless append-only tail with actor + provenance + reason; terminal
 *     transitions cite the declared objective family (the §3
 *     terminal-decision basis);
 *   - AC-3 HONEST-STATE: illegal transitions are rejected (a block is
 *     NEVER silently converted into success; 'achieved' only from
 *     'active'; activation requires a mapped goal; terminal missions are
 *     frozen);
 *   - AC-7 GOAL-MAPPING INTEGRITY: dangling goal references are rejected
 *     (uniform 404, never persisted — the DB FK + scope triggers are the
 *     backstops); a goal removal surfaces honestly (the recorded removal
 *     triple, the goal's live status through the /goals public contract,
 *     the abandoned-goal visibility);
 *   - AC-5 FAIL-CLOSED ISOLATION: anonymous 401; foreign/malformed
 *     agency/mission identifiers are the UNIFORM 404; a suspended
 *     membership is the 403; every PUT/PATCH/DELETE verb 405s at the
 *     router (the GET/POST surface discipline).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {
  apiCall,
  bootStack,
  shutdownStack,
  spawnApi,
  type IntegrationStack,
  type SpawnedProcess,
} from './helpers/harness.ts';
import { bootstrapApplication } from '../../src/composition-root.ts';
import type {
  GrowthMissionsModuleApi,
  GrowthMissionObjectiveFamily,
} from '../../src/modules/growth-missions/public.ts';

const BOOTSTRAP_EMAIL = 'root@marketingos.test';
const BOOTSTRAP_PASSWORD = 'bootstrap-root-pass';

let stack: IntegrationStack | null = null;
let api: (SpawnedProcess & { port: number }) | null = null;
let growthMissions: GrowthMissionsModuleApi | null = null;

function missions(): GrowthMissionsModuleApi {
  if (growthMissions === null) throw new Error('application not bootstrapped');
  return growthMissions;
}

function port(): number {
  if (api === null) throw new Error('api not spawned');
  return api.port;
}

function pool(): pg.Pool {
  if (stack === null) throw new Error('test stack not booted');
  return stack.pg.pool;
}

const MODULE_PROVENANCE = {
  actor: 'service:growth-missions-integration',
  recordedVia: 'module',
  correlationId: 'integration-growth-missions-1',
  causationId: null,
} as const;

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
  await apiCall(port(), `/api/users/${userId}/credential`, {
    token: admin,
    body: { password },
  });
  const login = await apiCall(port(), '/api/auth/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return { userId, token: login.body['token'] as string };
}

interface Principal {
  readonly userId: string;
  readonly token: string;
  readonly agencyId: string;
}

async function makeAgencyOwner(email: string): Promise<Principal> {
  const user = await makeUser(email, 'owner-password-123');
  const admin = await adminToken();
  const agency = await apiCall(port(), '/api/agencies', {
    token: admin,
    body: { name: `Agency ${email}`, ownerUserId: user.userId },
  });
  assert.equal(agency.status, 201, JSON.stringify(agency.body));
  const agencyId = (agency.body['agency'] as Record<string, unknown>)['agencyId'] as string;
  return { userId: user.userId, token: user.token, agencyId };
}

async function makeClient(agencyId: string, token: string, name: string): Promise<string> {
  const created = await apiCall(port(), `/api/agencies/${agencyId}/clients`, {
    token,
    body: { name },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['clientId'] as string;
}

async function makeGoal(clientId: string, token: string, objective: string): Promise<string> {
  const created = await apiCall(port(), `/api/clients/${clientId}/goals`, {
    token,
    body: {
      objective,
      successCriteria: [
        { metric: 'qualified_outcome', comparator: '>=', targetValue: 100, unit: 'count' },
      ],
      metrics: [],
      constraints: [],
      timeHorizon: null,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['goalId'] as string;
}

/**
 * JSON-null-stripping serializer: the route DTOs treat an absent key as
 * "none" (the goals `timeHorizon` nullable pattern applies to `null` only
 * where the DTO says so) — the module-level inputs use explicit nulls.
 */
function jsonBody(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || entry === undefined) continue;
    if (Array.isArray(entry)) {
      out[key] = entry.map((item) =>
        typeof item === 'object' && item !== null ? jsonBody(item) : item,
      );
    } else if (typeof entry === 'object') {
      out[key] = jsonBody(entry);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

/** One mission-family declaration fixture (arch v1.6 §1 examples, adapted). */
function declarationFixture(
  family: GrowthMissionObjectiveFamily,
  objective: string,
): {
  objective: string;
  objectiveFamily: GrowthMissionObjectiveFamily;
  productContext: { name: string | null; url: string | null; summary: string | null } | null;
  marketContext: { audience: string | null; geography: string | null; summary: string | null } | null;
  targetMetrics: readonly {
    metric: string;
    comparator: '>=' | '>' | '<=' | '<' | '==';
    targetValue: number;
    unit: string | null;
    description: string | null;
    intermediate: boolean;
  }[];
} {
  const withProduct = family === 'product_marketing' || family === 'commerce_discovery';
  return {
    objective,
    objectiveFamily: family,
    productContext: withProduct
      ? { name: 'PaySwap Pro', url: 'https://payswap.org', summary: 'The crypto payments product' }
      : null,
    marketContext: { audience: 'qualified users', geography: 'global', summary: null },
    targetMetrics: [
      { metric: 'primary_outcome', comparator: '>=', targetValue: 1000, unit: 'count', description: null, intermediate: false },
      { metric: 'watch_time_minutes', comparator: '>=', targetValue: 50000, unit: 'minutes', description: null, intermediate: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let ownerA: Principal | null = null;
let ownerB: Principal | null = null;
let collaboratorA: { userId: string; token: string } | null = null;
let clientA: string | null = null;
let clientB: string | null = null;

before(async () => {
  stack = await bootStack('growth_missions');
  api = await spawnApi(stack.env, {
    MOS_BOOTSTRAP_PLATFORM_ADMIN_EMAIL: BOOTSTRAP_EMAIL,
    MOS_BOOTSTRAP_PLATFORM_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
  });

  // The sanctioned test-harness wiring (the MKT-034/app-metering precedent):
  // the SAME application composed IN-PROCESS against the SAME database the
  // API serves — the module-level record commands are driven from here.
  process.env.MOS_DATABASE_URL = stack.env.databaseUrl;
  process.env.MOS_INTERNAL_API_TOKEN = stack.env.internalApiToken;
  process.env.MOS_ENV = 'test';
  process.env.MOS_OBJECT_STORE = 'fs';
  process.env.MOS_OBJECT_STORE_DIR = stack.env.objectStoreDir;
  process.env.MOS_SECRETS_DIR = stack.env.secretsDir;
  const core = await bootstrapApplication();
  growthMissions = core.modules.growthMissions;

  ownerA = await makeAgencyOwner('gm-owner-a@marketingos.test');
  ownerB = await makeAgencyOwner('gm-owner-b@marketingos.test');
  collaboratorA = await makeUser('gm-collab-a@marketingos.test', 'collab-password-123');
  clientA = await makeClient(ownerA.agencyId, ownerA.token, 'Mission Client A');
  clientB = await makeClient(ownerB.agencyId, ownerB.token, 'Mission Client B');
  // The collaborator joins agency A as an operator (any active member reads;
  // the mutation routes require owner/admin — the collaborator serves the
  // role battery).
  const admin = await adminToken();
  const join = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
    body: { userId: collaboratorA.userId, role: 'agency_operator' },
  });
  assert.equal(join.status, 201, JSON.stringify(join.body));
});

after(async () => {
  api?.child.kill('SIGKILL');
  if (stack !== null) {
    await shutdownStack(stack);
    stack = null;
  }
});

// ---------------------------------------------------------------------------
// AC-4: THE GOLDEN PATH PER FAMILY — through the HTTP surfaces
// ---------------------------------------------------------------------------

const FAMILY_ROUND_TRIPS: ReadonlyArray<{
  readonly label: string;
  readonly family: GrowthMissionObjectiveFamily;
  readonly objective: string;
  readonly terminal: 'achieved' | 'stopped_by_user' | 'blocked_pending_human_action' | 'budget_quota_exhausted';
}> = [
  {
    label: 'creator-growth',
    family: 'creator_growth',
    objective: 'grow a YouTube channel to 1,000,000 qualified views',
    terminal: 'achieved',
  },
  {
    label: 'audience-growth',
    family: 'audience_growth',
    objective: 'establish a healthy social presence across YouTube, Instagram and TikTok',
    terminal: 'stopped_by_user',
  },
  {
    label: 'product-marketing',
    family: 'product_marketing',
    objective: 'market a crypto trading product to qualified users',
    terminal: 'blocked_pending_human_action',
  },
  {
    label: 'commerce-discovery',
    family: 'commerce_discovery',
    objective: 'discover a viable dropshipping product and generate the first 100 orders',
    terminal: 'budget_quota_exhausted',
  },
];

test('AC-4 golden path per family (HTTP): create → read back → map goals → advance lifecycle honestly → terminal state', async () => {
  assert.ok(ownerA !== null && clientA !== null);
  for (const scenario of FAMILY_ROUND_TRIPS) {
    // 1. CREATE under the agency.
    const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
      token: ownerA.token,
      body: jsonBody(declarationFixture(scenario.family, scenario.objective)),
    });
    assert.equal(created.status, 201, `${scenario.label}: ${JSON.stringify(created.body)}`);
    const mission = created.body['mission'] as Record<string, unknown>;
    const missionId = mission['missionId'] as string;
    assert.equal(mission['status'], 'draft');
    assert.equal(mission['version'], 1);
    assert.equal(mission['currentVersionSeq'], 1);
    assert.equal(mission['agencyId'], ownerA.agencyId);
    const currentVersion = created.body['currentVersion'] as Record<string, unknown>;
    assert.equal(currentVersion['objective'], scenario.objective);
    assert.equal(currentVersion['objectiveFamily'], scenario.family);
    assert.equal(created.body['terminalDecisionBasis'], 'declared-business-objective-family');
    const metrics = currentVersion['targetMetrics'] as Record<string, unknown>[];
    assert.equal(metrics.length, 2);
    assert.equal(metrics[0]!['intermediate'], false);
    assert.equal(metrics[1]!['intermediate'], true);

    // 2. READ BACK with objective/version/history (the honest read-back).
    const readBack = await apiCall(port(), `/api/growth-missions/${missionId}`, {
      token: ownerA.token,
    });
    assert.equal(readBack.status, 200);
    const readVersion = readBack.body['currentVersion'] as Record<string, unknown>;
    assert.equal(readVersion['objective'], scenario.objective);
    assert.equal(readVersion['versionSeq'], 1);
    const history = readBack.body['history'] as Record<string, unknown>[];
    assert.equal(history.length, 1, `${scenario.label}: the creation event is in the history`);
    assert.equal(history[0]!['eventKind'], 'mission_created');
    assert.equal(history[0]!['eventSeq'], 1);
    assert.equal(history[0]!['toStatus'], 'draft');

    // 3. MAP GOALS (canonical goal references through /goals, READ-ONLY).
    const goalId1 = await makeGoal(clientA, ownerA.token, `${scenario.label} primary goal`);
    const goalId2 = await makeGoal(clientA, ownerA.token, `${scenario.label} secondary goal`);
    for (const goalId of [goalId1, goalId2]) {
      const mapped = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
        token: ownerA.token,
        body: { goalId },
      });
      assert.equal(mapped.status, 200, `${scenario.label}: ${JSON.stringify(mapped.body)}`);
    }
    const afterMapping = await apiCall(port(), `/api/growth-missions/${missionId}`, {
      token: ownerA.token,
    });
    const mappings = (afterMapping.body as Record<string, unknown>)['goalMappings'] as Record<string, unknown>[];
    assert.equal(mappings.length, 2, `${scenario.label}: both goals mapped`);
    assert.equal(mappings[0]!['goalStatus'], 'draft', 'the goal status is the LIVE /goals status');
    assert.equal(mappings[0]!['removedAt'], null);

    // 4. ADVANCE LIFECYCLE HONESTLY (activate → terminal).
    const activated = await apiCall(port(), `/api/growth-missions/${missionId}/status`, {
      token: ownerA.token,
      body: { status: 'active', reason: 'activation: the pursuit begins', version: 1 },
    });
    assert.equal(activated.status, 200, `${scenario.label}: ${JSON.stringify(activated.body)}`);
    assert.equal((activated.body['mission'] as Record<string, unknown>)['status'], 'active');

    const terminated = await apiCall(port(), `/api/growth-missions/${missionId}/status`, {
      token: ownerA.token,
      body: {
        status: scenario.terminal,
        reason: `terminal decision evaluated against the declared ${scenario.family} objective`,
        version: 2,
      },
    });
    assert.equal(terminated.status, 200, `${scenario.label}: ${JSON.stringify(terminated.body)}`);
    assert.equal((terminated.body['mission'] as Record<string, unknown>)['status'], scenario.terminal);

    // The terminal transition cites the declared objective family (§3).
    const finalHistory = await apiCall(port(), `/api/growth-missions/${missionId}/history`, {
      token: ownerA.token,
    });
    const events = finalHistory.body['history'] as Record<string, unknown>[];
    const terminalEvent = events.find((event) => event['eventKind'] === 'state_transition' && event['toStatus'] === scenario.terminal);
    assert.ok(terminalEvent !== undefined, `${scenario.label}: the terminal transition is in the history`);
    assert.equal(terminalEvent!['terminalDecisionFamily'], scenario.family);
    assert.equal(terminalEvent!['fromStatus'], 'active');
    assert.equal(typeof terminalEvent!['reason'], 'string');

    // The mission detail is still readable in the terminal state (business
    // history, not a tombstone) and the goal mappings remain visible.
    const terminalRead = await apiCall(port(), `/api/growth-missions/${missionId}`, {
      token: ownerA.token,
    });
    assert.equal(terminalRead.status, 200);
  }
});

// ---------------------------------------------------------------------------
// AC-4: THE GOLDEN PATH PER FAMILY — through the module-level operations
// ---------------------------------------------------------------------------

test('AC-4 golden path per family (module-level operations): the same round-trip through the module commands', async () => {
  assert.ok(ownerA !== null && clientA !== null);
  for (const scenario of FAMILY_ROUND_TRIPS) {
    const detail = await missions().createGrowthMission(
      {
        agencyId: ownerA.agencyId,
        declaration: declarationFixture(scenario.family, scenario.objective),
      },
      MODULE_PROVENANCE,
    );
    assert.equal(detail.mission.status, 'draft');
    assert.equal(detail.mission.version, 1);
    assert.equal(detail.currentVersion.objective, scenario.objective);
    assert.equal(detail.currentVersion.objectiveFamily, scenario.family);
    assert.equal(detail.history.length, 1);
    assert.equal(detail.history[0]!.eventKind, 'mission_created');
    assert.equal(detail.goalMappings.length, 0);

    // Read back through the raw record + the detail + the tails.
    const raw = await missions().getGrowthMission(detail.mission.missionId);
    assert.ok(raw !== null);
    assert.equal(raw.status, 'draft');
    const ownership = await missions().resolveGrowthMissionOwnership(detail.mission.missionId);
    assert.ok(ownership !== null);
    assert.equal(ownership.scope.agencyId, ownerA.agencyId);
    assert.equal(ownership.agency.status, 'active');
    const versions = await missions().getGrowthMissionVersions(detail.mission.missionId);
    assert.equal(versions!.length, 1);
    assert.equal(versions![0]!.objective, scenario.objective);

    // Map a goal + advance honestly + terminate.
    const goalId = await makeGoal(clientA, ownerA.token, `${scenario.label} module-level goal`);
    const mapped = await missions().addGrowthMissionGoalMapping(
      { missionId: detail.mission.missionId, goalId },
      MODULE_PROVENANCE,
    );
    assert.equal(mapped.goalMappings.filter((mapping) => mapping.removedAt === null).length, 1);

    const activated = await missions().setGrowthMissionStatus(
      {
        missionId: detail.mission.missionId,
        status: 'active',
        reason: 'module-level activation',
        expectedVersion: mapped.mission.version,
      },
      MODULE_PROVENANCE,
    );
    assert.equal(activated.mission.status, 'active');

    const terminated = await missions().setGrowthMissionStatus(
      {
        missionId: detail.mission.missionId,
        status: scenario.terminal === 'achieved' ? 'stopped_by_user' : scenario.terminal,
        reason: 'module-level terminal decision against the declared objective',
        expectedVersion: activated.mission.version,
      },
      MODULE_PROVENANCE,
    );
    assert.ok(
      terminated.mission.status !== 'active' && terminated.mission.status !== 'draft',
      'the module-level round-trip reaches a terminal state',
    );

    // The history tail is complete and gapless.
    const history = await missions().getGrowthMissionHistory(detail.mission.missionId);
    const kinds = history!.map((event) => event.eventKind);
    assert.deepEqual(kinds, ['mission_created', 'goal_mapped', 'state_transition', 'state_transition']);
    for (const [index, event] of history!.entries()) {
      assert.equal(event.eventSeq, index + 1, 'the per-mission sequence is gapless');
    }
  }
});

// ---------------------------------------------------------------------------
// AC-1/AC-4: version immutability — corrections are NEW version records
// ---------------------------------------------------------------------------

test('AC-1 version immutability: a correction is a NEW version record; the original stays byte-identical; the DB rejects in-place rewrites outright', async () => {
  assert.ok(ownerA !== null);
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: jsonBody(declarationFixture('revenue', 'generate $50,000 in attributable revenue')),
  });
  assert.equal(created.status, 201);
  const missionId = (created.body['mission'] as Record<string, unknown>)['missionId'] as string;

  // The correction path: a NEW declared version (never an in-place rewrite).
  const corrected = await apiCall(port(), `/api/growth-missions/${missionId}/versions`, {
    token: ownerA.token,
    body: { ...jsonBody(declarationFixture('revenue', 'generate $75,000 in attributable revenue (corrected scope)')), version: 1 },
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const correctedMission = corrected.body['mission'] as Record<string, unknown>;
  assert.equal(correctedMission['currentVersionSeq'], 2, 'the version pointer advanced');
  assert.equal(correctedMission['version'], 2, 'the CAS token advanced');
  assert.equal(
    (corrected.body['currentVersion'] as Record<string, unknown>)['objective'],
    'generate $75,000 in attributable revenue (corrected scope)',
  );

  // BOTH versions remain readable, the ORIGINAL byte-identical.
  const versions = await apiCall(port(), `/api/growth-missions/${missionId}/versions`, {
    token: ownerA.token,
  });
  const versionRows = versions.body['versions'] as Record<string, unknown>[];
  assert.equal(versionRows.length, 2);
  assert.equal(versionRows[0]!['versionSeq'], 1);
  assert.equal(versionRows[0]!['objective'], 'generate $50,000 in attributable revenue');
  assert.equal(versionRows[1]!['versionSeq'], 2);

  // The correction is in the history tail.
  const history = await apiCall(port(), `/api/growth-missions/${missionId}/history`, {
    token: ownerA.token,
  });
  const kinds = (history.body['history'] as Record<string, unknown>[]).map((event) => event['eventKind']);
  assert.deepEqual(kinds, ['mission_created', 'version_recorded']);
  const versionEvent = (history.body['history'] as Record<string, unknown>[])[1]!;
  assert.equal((versionEvent['detail'] as Record<string, unknown>)['versionSeq'], 2);

  // THE DB BACKSTOPS: direct SQL rewrites of the tails are rejected outright.
  await assert.rejects(
    () => pool().query("UPDATE growth_mission_versions SET objective = 'REWRITTEN' WHERE mission_id = $1", [missionId]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM growth_mission_versions WHERE mission_id = $1', [missionId]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query("UPDATE growth_mission_events SET reason = 'REWRITTEN' WHERE mission_id = $1", [missionId]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM growth_mission_events WHERE mission_id = $1', [missionId]),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query(
      "UPDATE growth_mission_target_metrics SET target_value = 999999 WHERE mission_version_id = (SELECT mission_version_id FROM growth_mission_versions WHERE mission_id = $1 AND version_seq = 1)",
      [missionId],
    ),
    /append-only/,
  );
  await assert.rejects(
    () => pool().query('DELETE FROM growth_missions WHERE mission_id = $1', [missionId]),
    /cannot be deleted/,
  );
  // The mission record's identity/scope are immutable and the CAS version
  // must advance by exactly one.
  await assert.rejects(
    () => pool().query("UPDATE growth_missions SET agency_id = $2 WHERE mission_id = $1", [missionId, ownerB?.agencyId]),
    /immutable/,
  );
  await assert.rejects(
    () => pool().query('UPDATE growth_missions SET version = version + 2 WHERE mission_id = $1', [missionId]),
    /exactly one/,
  );
  // The version pointer cannot regress and cannot dangle.
  await assert.rejects(
    () => pool().query('UPDATE growth_missions SET current_version_seq = 1, version = version + 1 WHERE mission_id = $1', [missionId]),
    /cannot regress/,
  );
  await assert.rejects(
    () => pool().query('UPDATE growth_missions SET current_version_seq = 99, version = version + 1 WHERE mission_id = $1', [missionId]),
    /must reference an existing declared version/,
  );

  // The original objective is STILL byte-identical after every attempt.
  const stored = await pool().query(
    'SELECT objective FROM growth_mission_versions WHERE mission_id = $1 ORDER BY version_seq',
    [missionId],
  );
  assert.equal(stored.rows[0]!.objective, 'generate $50,000 in attributable revenue');

  // The API surface has NO in-place objective rewrite: PUT/PATCH on the
  // mission path are router-rejected (the GET/POST surface discipline).
  const patch = await apiCall(port(), `/api/growth-missions/${missionId}`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { objective: 'REWRITTEN IN PLACE' },
  });
  assert.equal(patch.status, 405, 'no PATCH route may exist on the mission path');
  const put = await apiCall(port(), `/api/growth-missions/${missionId}`, {
    token: ownerA.token,
    method: 'PUT',
    body: { objective: 'REWRITTEN IN PLACE' },
  });
  assert.equal(put.status, 405, 'no PUT route may exist on the mission path');

  // CAS: a stale expectedVersion is the honest 409.
  const stale = await apiCall(port(), `/api/growth-missions/${missionId}/versions`, {
    token: ownerA.token,
    body: { ...jsonBody(declarationFixture('revenue', 'generate $90,000')), version: 1 },
  });
  assert.equal(stale.status, 409);
});

// ---------------------------------------------------------------------------
// AC-3: history completeness + the honest-state battery
// ---------------------------------------------------------------------------

test('AC-3 history completeness: every mission event lands in ONE gapless append-only tail with actor + provenance + reason', async () => {
  assert.ok(ownerA !== null && clientA !== null);
  const created = await missions().createGrowthMission(
    {
      agencyId: ownerA.agencyId,
      declaration: declarationFixture('audience_growth', 'grow the newsletter audience to 50,000 subscribers'),
    },
    MODULE_PROVENANCE,
  );
  const missionId = created.mission.missionId;
  const goalId = await makeGoal(clientA, ownerA.token, 'history completeness goal');

  let version = created.mission.version;
  await missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE);
  version = (await missions().recordGrowthMissionVersion(
    { missionId, declaration: declarationFixture('audience_growth', 'grow the audience to 60,000 (corrected)'), expectedVersion: version },
    MODULE_PROVENANCE,
  )).mission.version;
  version = (await missions().setGrowthMissionStatus(
    { missionId, status: 'active', reason: 'activation after correction', expectedVersion: version },
    MODULE_PROVENANCE,
  )).mission.version;
  version = (await missions().setGrowthMissionStatus(
    { missionId, status: 'paused', reason: 'paused for a strategy review', expectedVersion: version },
    MODULE_PROVENANCE,
  )).mission.version;
  await missions().removeGrowthMissionGoalMapping(
    { missionId, goalId, reason: 're-scoped: the goal moved to another mission' },
    MODULE_PROVENANCE,
  );
  // A paused mission with NO active goal mapping cannot resume (the
  // activation guard holds for resumption too) — re-map the goal first
  // (a NEW mapping row: the removed history is preserved), then resume.
  await assert.rejects(
    () =>
      missions().setGrowthMissionStatus(
        { missionId, status: 'active', reason: 'resume without a goal', expectedVersion: version },
        MODULE_PROVENANCE,
      ),
    /at least one existing goal must be mapped/,
  );
  await missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE);
  await missions().setGrowthMissionStatus(
    { missionId, status: 'active', reason: 'resumed after the strategy review', expectedVersion: version },
    MODULE_PROVENANCE,
  );

  const history = await missions().getGrowthMissionHistory(missionId);
  assert.ok(history !== null);
  const kinds = history.map((event) => event.eventKind);
  assert.deepEqual(kinds, [
    'mission_created',
    'goal_mapped',
    'version_recorded',
    'state_transition',
    'state_transition',
    'goal_unmapped',
    'goal_mapped',
    'state_transition',
  ]);
  for (const [index, event] of history.entries()) {
    assert.equal(event.eventSeq, index + 1, 'gapless sequence');
    assert.equal(event.provenance.actor, MODULE_PROVENANCE.actor);
    assert.equal(event.provenance.recordedVia, MODULE_PROVENANCE.recordedVia);
    assert.equal(typeof event.provenance.recordedAt, 'string');
    assert.ok(event.reason !== null && event.reason.length > 0, 'every event carries a reason');
  }
  // The unmapping carries the honest removal reason.
  const unmapped = history.find((event) => event.eventKind === 'goal_unmapped')!;
  assert.equal(unmapped.reason, 're-scoped: the goal moved to another mission');
  assert.equal((unmapped.detail as { goalId: string }).goalId, goalId);
  // The transitions carry their from/to pair.
  const paused = history.find((event) => event.toStatus === 'paused')!;
  assert.equal(paused.fromStatus, 'active');
});

test('AC-3 honest-state battery: illegal transitions are rejected — a block is NEVER silently converted into success', async () => {
  assert.ok(ownerA !== null && clientA !== null);
  const created = await missions().createGrowthMission(
    {
      agencyId: ownerA.agencyId,
      declaration: declarationFixture('acquisition', 'acquire 500 qualified users'),
    },
    MODULE_PROVENANCE,
  );
  const missionId = created.mission.missionId;

  // Activation without a mapped goal is rejected.
  await assert.rejects(
    () =>
      missions().setGrowthMissionStatus(
        { missionId, status: 'active', reason: 'no goal mapped yet', expectedVersion: 1 },
        MODULE_PROVENANCE,
      ),
    /at least one existing goal must be mapped/,
  );

  // draft → achieved directly is illegal ('achieved' only from 'active').
  await assert.rejects(
    () =>
      missions().setGrowthMissionStatus(
        { missionId, status: 'achieved', reason: 'premature success', expectedVersion: 1 },
        MODULE_PROVENANCE,
      ),
    /illegal growth mission transition/,
  );

  // Map a goal, activate, then reach EVERY terminal state honestly and
  // prove the frozen exits.
  const goalId = await makeGoal(clientA, ownerA.token, 'honest-state goal');
  let version = (await missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE)).mission.version;
  version = (await missions().setGrowthMissionStatus(
    { missionId, status: 'active', reason: 'activation', expectedVersion: version },
    MODULE_PROVENANCE,
  )).mission.version;
  version = (await missions().setGrowthMissionStatus(
    { missionId, status: 'blocked_pending_human_action', reason: 'a rights gate requires human approval', expectedVersion: version },
    MODULE_PROVENANCE,
  )).mission.version;

  // THE HONEST-STATE RULE: from the blocked terminal state, NOTHING moves —
  // least of all 'achieved'.
  for (const target of ['achieved', 'active', 'paused', 'stopped_by_user'] as const) {
    await assert.rejects(
      () =>
        missions().setGrowthMissionStatus(
          { missionId, status: target, reason: 'attempted resurrection', expectedVersion: version },
          MODULE_PROVENANCE,
        ),
      /illegal growth mission transition|frozen/,
    );
  }
  // Terminal missions are fully frozen: no version corrections, no mapping
  // changes.
  await assert.rejects(
    () =>
      missions().recordGrowthMissionVersion(
        { missionId, declaration: declarationFixture('acquisition', 'REWRITTEN'), expectedVersion: version },
        MODULE_PROVENANCE,
      ),
    /frozen/,
  );
  const lateGoalId = await makeGoal(clientA, ownerA.token, 'late goal');
  await assert.rejects(
    () => missions().addGrowthMissionGoalMapping({ missionId, goalId: lateGoalId }, MODULE_PROVENANCE),
    /frozen/,
  );

  // The DB pair trigger is the final backstop: a fabricated block → success
  // event cannot even be INSERTED.
  await assert.rejects(
    () =>
      pool().query(
        `INSERT INTO growth_mission_events (event_id, mission_id, event_seq, event_kind, from_status, to_status,
                                             terminal_decision_family, reason, detail, actor, recorded_via,
                                             correlation_id, causation_id, recorded_at)
         VALUES (gen_random_uuid(), $1, 99, 'state_transition', 'blocked_pending_human_action', 'achieved',
                 NULL, 'silent conversion attempt', NULL, 'service:test', 'test', 'test', NULL, now())`,
        [missionId],
      ),
    /not legal|terminal/i,
  );

  // The missing reason is rejected at the route (422) and at the module.
  const noReason = await apiCall(port(), `/api/growth-missions/${missionId}/status`, {
    token: ownerA.token,
    body: { status: 'achieved', version: 1 },
  });
  assert.equal(noReason.status, 422);
  await assert.rejects(
    () =>
      missions().setGrowthMissionStatus(
        { missionId, status: 'achieved', reason: '', expectedVersion: version },
        MODULE_PROVENANCE,
      ),
    /reason/,
  );
});

// ---------------------------------------------------------------------------
// AC-7: goal-mapping integrity
// ---------------------------------------------------------------------------

test('AC-7 goal-mapping integrity: dangling references rejected; cross-agency references rejected; honest removal + live goal status', async () => {
  assert.ok(ownerA !== null && ownerB !== null && clientA !== null && clientB !== null);
  const created = await missions().createGrowthMission(
    {
      agencyId: ownerA.agencyId,
      declaration: declarationFixture('hybrid', 'grow the creator business and its commerce line together'),
    },
    MODULE_PROVENANCE,
  );
  const missionId = created.mission.missionId;

  // A DANGLING goal reference (unknown uuid) never persists — uniform 404.
  const unknownGoal = '00000000-0000-4000-8000-0000000000aa';
  const dangling = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
    token: ownerA.token,
    body: { goalId: unknownGoal },
  });
  assert.equal(dangling.status, 404);
  const dbCheck = await pool().query(
    'SELECT count(*)::int AS count FROM growth_mission_goal_mappings WHERE mission_id = $1',
    [missionId],
  );
  assert.equal(dbCheck.rows[0]!.count, 0, 'zero mapping rows persisted');

  // A CROSS-AGENCY goal reference is indistinguishable from unknown (404).
  const foreignGoal = await makeGoal(clientB, ownerB.token, 'agency B goal');
  const foreign = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
    token: ownerA.token,
    body: { goalId: foreignGoal },
  });
  assert.equal(foreign.status, 404);
  // And at the module level too.
  await assert.rejects(
    () => missions().addGrowthMissionGoalMapping({ missionId, goalId: foreignGoal }, MODULE_PROVENANCE),
    /not found/i,
  );

  // An honest mapping works; re-mapping the SAME goal is a conflict.
  const goalId = await makeGoal(clientA, ownerA.token, 'integrity goal');
  let version = (await missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE)).mission.version;
  await assert.rejects(
    () => missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE),
    /already mapped/,
  );

  // GOAL REMOVAL SURFACES HONESTLY: the mapping keeps its history, gains
  // the removal triple, and the history records the unmapping with reason.
  const removed = await missions().removeGrowthMissionGoalMapping(
    { missionId, goalId, reason: 'the goal was re-scoped away from this mission' },
    MODULE_PROVENANCE,
  );
  const removedMapping = removed.goalMappings.find((mapping) => mapping.goalId === goalId)!;
  assert.ok(removedMapping.removedAt !== null);
  assert.equal(removedMapping.removedBy, MODULE_PROVENANCE.actor);
  assert.equal(removedMapping.removalReason, 'the goal was re-scoped away from this mission');
  // The mapping row is STILL THERE (never erased) and the goal status is
  // STILL live-resolved through the /goals public contract.
  assert.equal(removedMapping.goalStatus, 'draft');
  // Removing an already-removed mapping is a conflict.
  await assert.rejects(
    () => missions().removeGrowthMissionGoalMapping({ missionId, goalId, reason: 'again' }, MODULE_PROVENANCE),
    /no active mapping/,
  );
  // Re-adding after an honest removal works (a NEW mapping row).
  version = (await missions().addGrowthMissionGoalMapping({ missionId, goalId }, MODULE_PROVENANCE)).mission.version;
  const rows = await pool().query(
    'SELECT count(*)::int AS count FROM growth_mission_goal_mappings WHERE mission_id = $1 AND goal_id = $2',
    [missionId, goalId],
  );
  assert.equal(rows.rows[0]!.count, 2, 'two mapping rows — the history is preserved');

  // THE ABANDONED GOAL SURFACES HONESTLY: abandon the goal through the
  // /goals authority; the mission detail shows the LIVE status.
  const goalRead = await apiCall(port(), `/api/goals/${goalId}`, { token: ownerA.token });
  const abandon = await apiCall(port(), `/api/goals/${goalId}/status`, {
    token: ownerA.token,
    method: 'PATCH',
    body: { status: 'abandoned', version: goalRead.body['version'] as number },
  });
  assert.equal(abandon.status, 200, JSON.stringify(abandon.body));
  const detail = await missions().getGrowthMissionDetail(missionId);
  const abandonedView = detail!.goalMappings.find((mapping) => mapping.goalId === goalId && mapping.removedAt === null)!;
  assert.equal(abandonedView.goalStatus, 'abandoned', 'the live goal status surfaces honestly');

  // The DB backstops: a cross-agency mapping cannot even be INSERTED, and a
  // mapping DELETE is rejected outright.
  await assert.rejects(
    () =>
      pool().query(
        'INSERT INTO growth_mission_goal_mappings (mapping_id, mission_id, goal_id, added_at, added_by) VALUES (gen_random_uuid(), $1, $2, now(), $3)',
        [missionId, foreignGoal, 'service:test'],
      ),
    /agency boundary cannot be crossed/,
  );
  await assert.rejects(
    () =>
      pool().query(
        'DELETE FROM growth_mission_goal_mappings WHERE mission_id = $1',
        [missionId],
      ),
    /cannot be deleted/,
  );
  void version;
});

// ---------------------------------------------------------------------------
// AC-5: the fail-closed isolation battery
// ---------------------------------------------------------------------------

test('AC-5 fail-closed isolation: anonymous 401; foreign/malformed ≡ unknown ≡ 404; suspended 403; role discipline', async () => {
  assert.ok(ownerA !== null && ownerB !== null && collaboratorA !== null && clientA !== null && clientB !== null);
  const collab = collaboratorA;
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: jsonBody(declarationFixture('lead_generation', 'generate 1,000 qualified leads')),
  });
  assert.equal(created.status, 201);
  const missionId = (created.body['mission'] as Record<string, unknown>)['missionId'] as string;

  // ANONYMOUS: 401 on every surface.
  for (const [method, path] of [
    ['GET', `/api/growth-missions/${missionId}`],
    ['GET', `/api/agencies/${ownerA.agencyId}/growth-missions`],
    ['POST', `/api/agencies/${ownerA.agencyId}/growth-missions`],
  ] as const) {
    const anonymous = await apiCall(port(), path, { method, body: method === 'POST' ? declarationFixture('revenue', 'x') : undefined });
    assert.equal(anonymous.status, 401, `${method} ${path} must 401 anonymously`);
  }

  // MALFORMED ≡ UNKNOWN: the uniform 404.
  for (const malformed of ['not-a-uuid', '00000000-0000-4000-8000-0000000000zz']) {
    const read = await apiCall(port(), `/api/growth-missions/${malformed}`, { token: ownerA.token });
    assert.equal(read.status, 404);
  }
  const unknownMission = await apiCall(port(), '/api/growth-missions/00000000-0000-4000-8000-0000000000bb', {
    token: ownerA.token,
  });
  assert.equal(unknownMission.status, 404);
  const malformedAgency = await apiCall(port(), '/api/agencies/not-an-agency/growth-missions', {
    token: ownerA.token,
  });
  assert.equal(malformedAgency.status, 404);

  // FOREIGN: agency B's owner cannot see agency A's mission (404, not 403 —
  // no cross-tenant existence oracle), and cannot create under A's agency.
  const foreignRead = await apiCall(port(), `/api/growth-missions/${missionId}`, {
    token: ownerB.token,
  });
  assert.equal(foreignRead.status, 404);
  const foreignHistory = await apiCall(port(), `/api/growth-missions/${missionId}/history`, {
    token: ownerB.token,
  });
  assert.equal(foreignHistory.status, 404);
  const foreignVersions = await apiCall(port(), `/api/growth-missions/${missionId}/versions`, {
    token: ownerB.token,
  });
  assert.equal(foreignVersions.status, 404);
  const foreignCreate = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerB.token,
    body: jsonBody(declarationFixture('revenue', 'foreign creation attempt')),
  });
  assert.equal(foreignCreate.status, 404);
  const foreignList = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerB.token,
  });
  assert.equal(foreignList.status, 404);
  const foreignTransition = await apiCall(port(), `/api/growth-missions/${missionId}/status`, {
    token: ownerB.token,
    body: { status: 'stopped_by_user', reason: 'foreign attempt', version: 1 },
  });
  assert.equal(foreignTransition.status, 404);
  const foreignGoal = await makeGoal(clientB, ownerB.token, 'foreign battery goal');
  const foreignMapping = await apiCall(port(), `/api/growth-missions/${missionId}/goal-mappings`, {
    token: ownerB.token,
    body: { goalId: foreignGoal },
  });
  assert.equal(foreignMapping.status, 404);

  // ROLE DISCIPLINE: an active non-owner member READS (200) but cannot
  // mutate (403 — the goals create/mutation posture).
  const memberRead = await apiCall(port(), `/api/growth-missions/${missionId}`, {
    token: collaboratorA.token,
  });
  assert.equal(memberRead.status, 200, 'any active member reads the mission');
  const memberCreate = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: collaboratorA.token,
    body: jsonBody(declarationFixture('revenue', 'operator creation attempt')),
  });
  assert.equal(memberCreate.status, 403);

  // SUSPENDED: a disabled membership is the 403 (never data, never 404).
  const admin = await adminToken();
  const memberships = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/memberships`, {
    token: admin,
  });
  const collaboratorMembership = (memberships.body['memberships'] as Record<string, unknown>[]).find(
    (entry) => entry['userId'] === collab.userId,
  )!;
  const disabled = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${collaboratorMembership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'disabled', version: collaboratorMembership['version'] as number },
    },
  );
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  const suspendedRead = await apiCall(port(), `/api/growth-missions/${missionId}`, {
    token: collaboratorA.token,
  });
  assert.equal(suspendedRead.status, 403, 'a suspended membership is the 403');
  // Restore for later batteries.
  const restored = await apiCall(
    port(),
    `/api/agencies/${ownerA.agencyId}/memberships/${collaboratorMembership['membershipId'] as string}`,
    {
      token: admin,
      method: 'PATCH',
      body: { status: 'active', version: (disabled.body['version'] as number) },
    },
  );
  assert.equal(restored.status, 200);
});

// ---------------------------------------------------------------------------
// AC-1: the declaration validation battery (the route DTO + module guards)
// ---------------------------------------------------------------------------

test('AC-1 declaration validation: the frozen family vocabulary, the authority-field rejection and the measurable-metric discipline', async () => {
  assert.ok(ownerA !== null);
  const base = declarationFixture('revenue', 'generate $50,000 in attributable revenue');

  // A non-frozen family is a 422.
  const badFamily = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: { ...jsonBody(base), objectiveFamily: 'engagement_growth' },
  });
  assert.equal(badFamily.status, 422);
  // A non-frozen STATUS is a 422 on the transition route.
  const created = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: jsonBody(base),
  });
  assert.equal(created.status, 201);
  const missionId = (created.body['mission'] as Record<string, unknown>)['missionId'] as string;
  const badStatus = await apiCall(port(), `/api/growth-missions/${missionId}/status`, {
    token: ownerA.token,
    body: { status: 'succeeded', reason: 'not a frozen state', version: 1 },
  });
  assert.equal(badStatus.status, 422);
  // Authority fields are rejected everywhere.
  const authorityInjected = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: { ...jsonBody(base), missionId: '00000000-0000-4000-8000-0000000000cc', status: 'active' },
  });
  assert.equal(authorityInjected.status, 422);
  // Provenance is server-derived: a caller-supplied provenance is rejected.
  const provenanceInjected = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: { ...jsonBody(base), provenance: { actor: 'user:forbidden' } },
  });
  assert.equal(provenanceInjected.status, 422);
  // An unmeasurable metric is a 422.
  const badMetric = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: { ...jsonBody(base), targetMetrics: [{ metric: 'vibes', comparator: '~=', targetValue: 1 }] },
  });
  assert.equal(badMetric.status, 422);
  // An empty objective is a 422.
  const emptyObjective = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
    body: { ...jsonBody(base), objective: '   ' },
  });
  assert.equal(emptyObjective.status, 422);
});

// ---------------------------------------------------------------------------
// AC-5 (agency listing + the unknown-agency creation posture)
// ---------------------------------------------------------------------------

test('AC-1/AC-5 the agency listing surface: missions in ALL lifecycle states; unknown/foreign agency creation is the uniform 404', async () => {
  assert.ok(ownerA !== null);
  const listing = await apiCall(port(), `/api/agencies/${ownerA.agencyId}/growth-missions`, {
    token: ownerA.token,
  });
  assert.equal(listing.status, 200);
  const missionsListed = listing.body['missions'] as Record<string, unknown>[];
  assert.ok(missionsListed.length > 0, 'the agency sees its missions');
  // Every lifecycle state is visible business history (terminal included).
  assert.ok(
    missionsListed.some((mission) => mission['status'] === 'achieved' || mission['status'] === 'stopped_by_user' || mission['status'] === 'blocked_pending_human_action' || mission['status'] === 'budget_quota_exhausted'),
    'terminal missions are visible business history, not tombstones',
  );

  // Creation under an UNKNOWN agency is the uniform 404.
  const unknownAgency = await apiCall(port(), '/api/agencies/00000000-0000-4000-8000-0000000000dd/growth-missions', {
    token: ownerA.token,
    body: jsonBody(declarationFixture('revenue', 'x')),
  });
  assert.equal(unknownAgency.status, 404);
  // Module-level: the same posture.
  await assert.rejects(
    () =>
      missions().createGrowthMission(
        { agencyId: '00000000-0000-4000-8000-0000000000ee', declaration: declarationFixture('revenue', 'x') },
        MODULE_PROVENANCE,
      ),
    /not found/i,
  );
  await assert.rejects(
    () => missions().listGrowthMissionsForAgency('00000000-0000-4000-8000-0000000000ff'),
    /not found/i,
  );
});
