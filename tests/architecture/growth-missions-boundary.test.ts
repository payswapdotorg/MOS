/**
 * MKT-053 static tests — the Growth Mission and Objective Model domain is
 * structurally correct in the ACTUAL migration, module contract and route
 * surface (pure static analysis, no DB; the app-metering-boundary
 * precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-053; spec/architecture-v1.6.md
 * §1/§2/§3 — the primary contract; frozen by spec/architecture-lock-v1.6.md
 * rules 16/17/41; frozen matrix registration /growth-missions ──→
 * /agencies, /goals):
 *   1. migration 045 (the PRE-ASSIGNED number) creates exactly the FIVE
 *      mission tables — OWN tables ONLY, NO goal/workflow/execution/
 *      playbook/experiment/evidence/learning/job/deployment table (the
 *      composed authorities stay sole — the layer, never a replacement
 *      authority, architecture-lock-v1.6.md rule 16), and NO controller
 *      state of any kind (rule 17 — the Growth Operator is MKT-054);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the eight §3 objective
 *      families, the ten-state §2 lifecycle vocabulary (three non-terminal
 *      + the seven TERMINAL §2 states, verbatim), the per-kind event-shape
 *      fence, the terminal-decision-family fence and the comparator
 *      vocabulary;
 *   3. THE HONEST-STATE + APPEND-ONLY BATTERY: the frozen transition-pair
 *      trigger (terminal states have no outgoing pairs; a block is never
 *      silently converted into success), the current-state-match trigger,
 *      the append-only UPDATE/DELETE rejection triggers on the version
 *      tail, the target metrics and the history tail, the mission-record
 *      mutation guard (identity immutability + exact CAS advance + the
 *      version pointer only ever advances), the mapping scope/terminal/
 *      removal-only/no-DELETE fences and the ACTIVE (mission, goal)
 *      partial-unique fence;
 *   4. THE LAYER-NOT-AUTHORITY BATTERY: ZERO controller/scheduling/
 *      execution verbs anywhere in the module CODE (comment-stripped),
 *      DML against the module's OWN tables ONLY, zero reads of another
 *      module's tables from the module code, and the migration's only
 *      touches of the goals/clients/agencies tables are the CHECK-ONLY
 *      trigger reads + the FK anchor (no INSERT/UPDATE/DELETE on them);
 *   5. the /growth-missions public contract imports ZERO other modules —
 *      the /agencies + /goals directions arrive through the declared
 *      STRUCTURAL PORTS (the frozen-matrix row documents them);
 *   6. the ROUTE surface is EXACTLY the nine GET/POST record routes —
 *      NO PUT/PATCH/DELETE anywhere in the family (the objective is
 *      never rewritten in place: corrections are POST .../versions; goal
 *      removal is a recorded removal, never a DELETE);
 *   7. the spec registration exists: /growth-missions in
 *      spec/architecture.md §6 + the matrix row + the authority-notes
 *      bullet in spec/module-dependency-matrix.md; 045_growth_missions.sql
 *      holds its numeric position in the expected-migration list;
 *   8. the version discipline: the frozen vocabulary version (gm-vocab-v1)
 *      + the terminal-decision basis ship on the public contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  GROWTH_MISSION_OBJECTIVE_FAMILIES,
  GROWTH_MISSION_STATUSES,
  GROWTH_MISSION_TERMINAL_DECISION_BASIS,
  GROWTH_MISSION_TERMINAL_STATUSES,
  GROWTH_MISSION_TRANSITIONS,
  GROWTH_MISSION_VOCABULARY_VERSION,
} from '../../src/modules/growth-missions/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration045 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '045_growth_missions.sql'));
const missionPublic = read(src('modules', 'growth-missions', 'public.ts'));
const missionModule = read(src('modules', 'growth-missions', 'internal', 'growth-missions-module.ts'));
const missionStore = read(src('modules', 'growth-missions', 'internal', 'growth-missions-store.ts'));
const missionRoutes = read(src('api', 'growth-missions-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Extracts the CREATE TABLE block for `table` from a migration SQL text. */
function createTableBlock(migration: string, table: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${table} (`;
  const start = migration.indexOf(marker);
  assert.ok(start >= 0, `migration must create ${table}`);
  const end = migration.indexOf('\n);', start);
  assert.ok(end > start, `${table} block must terminate`);
  return migration.slice(start, end);
}

function columnsOf(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z_]+\s+\w+/.test(line))
    .map((line) => line.split(/\s+/)[0]!);
}

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1. Migration 045: OWN TABLES ONLY, no authority table, no controller state
// ---------------------------------------------------------------------------

test('MKT-053: migration 045 creates exactly the five mission tables — OWN tables ONLY (no authority table, no controller state)', () => {
  const created = [...migration045.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'growth_missions',
      'growth_mission_versions',
      'growth_mission_target_metrics',
      'growth_mission_events',
      'growth_mission_goal_mappings',
    ],
    'own tables ONLY — the durable mission record layer; /goals (007), /workflows (009), /executions (011), /playbooks (008), /experiments (019), /evidence (015), /learnings (027), /jobs (023) and /deployments (034) stay the sole authorities (architecture-lock-v1.6.md rule 16: the mission is a durable orchestration LAYER over them, never a replacement authority)',
  );

  // The mission record's frozen columns.
  const missionColumns = columnsOf(createTableBlock(migration045, 'growth_missions'));
  for (const required of [
    'mission_id', 'agency_id', 'status', 'current_version_seq', 'version',
    'created_actor', 'created_at', 'updated_at',
  ]) {
    assert.ok(missionColumns.includes(required), `growth_missions must carry '${required}'`);
  }
  // The version tail's frozen columns.
  const versionColumns = columnsOf(createTableBlock(migration045, 'growth_mission_versions'));
  for (const required of [
    'mission_version_id', 'mission_id', 'version_seq', 'objective', 'objective_family',
    'product_context', 'market_context',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(versionColumns.includes(required), `growth_mission_versions must carry '${required}'`);
  }
  // The target metrics' frozen columns.
  const metricColumns = columnsOf(createTableBlock(migration045, 'growth_mission_target_metrics'));
  for (const required of [
    'mission_version_id', 'metric', 'comparator', 'target_value', 'unit', 'description', 'intermediate',
  ]) {
    assert.ok(metricColumns.includes(required), `growth_mission_target_metrics must carry '${required}'`);
  }
  // The history tail's frozen columns.
  const eventColumns = columnsOf(createTableBlock(migration045, 'growth_mission_events'));
  for (const required of [
    'event_id', 'mission_id', 'event_seq', 'event_kind', 'from_status', 'to_status',
    'terminal_decision_family', 'reason', 'detail',
    'actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
  ]) {
    assert.ok(eventColumns.includes(required), `growth_mission_events must carry '${required}'`);
  }
  // The mapping's frozen columns.
  const mappingColumns = columnsOf(createTableBlock(migration045, 'growth_mission_goal_mappings'));
  for (const required of [
    'mapping_id', 'mission_id', 'goal_id', 'added_at', 'added_by',
    'removed_at', 'removed_by', 'removal_reason',
  ]) {
    assert.ok(mappingColumns.includes(required), `growth_mission_goal_mappings must carry '${required}'`);
  }

  // NO authority table is created and NO controller state exists anywhere:
  // the migration text may not even name a controller surface.
  for (const forbidden of [
    'workflow', 'execution', 'playbook', 'experiment', 'evidence', 'learning',
    'job', 'deployment', 'scheduler', 'controller', 'operator_queue', 'replan',
  ]) {
    assert.ok(
      !created.some((table) => table.includes(forbidden)),
      `no '${forbidden}' table may be created (the Growth Operator is MKT-054 — architecture-lock-v1.6.md rule 17)`,
    );
  }
  // No secret-material column anywhere (§21 posture).
  for (const table of created) {
    assert.ok(
      !/secret|password|token|api_key/.test(columnsOf(createTableBlock(migration045, table)).join(',')),
      `${table} carries no material-shaped column`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-053 AC-1/AC-2 static: the §3 family vocabulary and the §2 state vocabulary are CHECK-fenced (the gm-vocab-v1 storage mirror)', () => {
  // Whitespace-normalized block text (the CHECKs wrap across lines).
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  // The closed eight-family §3 vocabulary on BOTH family columns.
  const familyList = GROWTH_MISSION_OBJECTIVE_FAMILIES.map((family) => `'${family}'`).join(', ');
  for (const table of ['growth_mission_versions', 'growth_mission_events']) {
    const block = normalize(createTableBlock(migration045, table));
    assert.ok(
      block.includes(familyList),
      `${table} CHECK-fences the full frozen §3 family vocabulary`,
    );
  }
  // The closed ten-state §2 vocabulary on the mission record + the event
  // state columns.
  const stateList = ['draft', 'active', 'paused', ...GROWTH_MISSION_TERMINAL_STATUSES]
    .map((status) => `'${status}'`)
    .join(', ');
  assert.ok(
    normalize(createTableBlock(migration045, 'growth_missions')).includes(stateList),
    'growth_missions CHECK-fences the full §2 state vocabulary',
  );
  assert.ok(
    normalize(createTableBlock(migration045, 'growth_mission_events')).includes(stateList),
    'growth_mission_events CHECK-fences the full §2 state vocabulary on both state columns',
  );
  // The comparator vocabulary (the /goals set).
  assert.ok(
    createTableBlock(migration045, 'growth_mission_target_metrics').includes(
      "CHECK (comparator IN ('>=', '>', '<=', '<', '=='))",
    ),
    'the comparator vocabulary is CHECK-fenced',
  );
  // The code-side frozen vocabulary agrees with the storage mirror.
  assert.deepEqual(GROWTH_MISSION_OBJECTIVE_FAMILIES, [
    'audience_growth', 'creator_growth', 'product_marketing', 'acquisition',
    'lead_generation', 'revenue', 'commerce_discovery', 'hybrid',
  ]);
  assert.deepEqual(GROWTH_MISSION_STATUSES, [
    'draft', 'active', 'paused', ...GROWTH_MISSION_TERMINAL_STATUSES,
  ]);
});

test('MKT-053 AC-3 static: the event-shape fence, the terminal-decision-family fence and the frozen transition-pair trigger exist', () => {
  // THE EVENT-SHAPE FENCE (the frozen per-kind payloads).
  assert.ok(
    migration045.includes('CONSTRAINT growth_mission_event_shape CHECK ('),
    'the event-shape fence exists',
  );
  assert.ok(
    migration045.includes("AND reason IS NOT NULL)"),
    'state_transition events REQUIRE a reason',
  );
  // THE TERMINAL-DECISION FENCE (§3 made durable).
  assert.ok(
    migration045.includes('CONSTRAINT growth_mission_terminal_family_shape CHECK ('),
    'the terminal-decision-family fence exists (a terminal transition MUST carry the declared family)',
  );
  // THE FROZEN TRANSITION-PAIR TRIGGER — the honest-state rule.
  assert.ok(
    migration045.includes('CREATE OR REPLACE FUNCTION growth_mission_event_consistent()'),
    'the frozen transition-pair trigger exists',
  );
  assert.ok(
    migration045.includes(
      'a block is never silently converted into success',
    ),
    'the honest-state rejection message is explicit',
  );
  // Every legal pair appears in the trigger (the storage mirror of
  // GROWTH_MISSION_TRANSITIONS).
  const legalPairs: Array<readonly [string, string]> = [];
  for (const [from, targets] of Object.entries(GROWTH_MISSION_TRANSITIONS)) {
    for (const to of targets) legalPairs.push([from, to]);
  }
  for (const [from, to] of legalPairs) {
    assert.ok(
      new RegExp(`NEW\\.from_status = '${from}'[^;]*'${to}'`).test(migration045),
      `the trigger encodes the legal pair ${from} → ${to}`,
    );
  }
  // 'achieved' appears ONLY in the active-origin pair set (never from a
  // blocked/paused/draft origin).
  assert.ok(
    /NEW\.from_status = 'active'[^\0]*?'achieved'/.test(migration045),
    "'achieved' is reachable ONLY from 'active' in the storage mirror",
  );
  // THE CURRENT-STATE MATCH: history must match the durable state.
  assert.ok(
    migration045.includes('history must match the durable state'),
    'the current-state-match backstop exists',
  );
});

test('MKT-053 AC-1/AC-3 static: the append-only tails, the mission-record guard and the mapping fences exist', () => {
  // APPEND-ONLY: versions, target metrics and history events reject
  // UPDATE and DELETE outright.
  for (const table of [
    'growth_mission_versions',
    'growth_mission_target_metrics',
    'growth_mission_events',
  ]) {
    assert.ok(
      migration045.includes(`CREATE TRIGGER ${table}_append_only_update_trigger`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration045.includes(`CREATE TRIGGER ${table}_append_only_delete_trigger`),
      `${table} rejects DELETE`,
    );
  }
  assert.ok(
    migration045.includes('growth mission versions are append-only'),
    'the version-tail rejection message is explicit',
  );
  assert.ok(
    migration045.includes('growth mission events are append-only'),
    'the history-tail rejection message is explicit',
  );
  // THE MISSION-RECORD GUARD: identity/scope immutable + exact CAS advance +
  // the version pointer only ever advances + references an existing version.
  assert.ok(
    migration045.includes('CREATE OR REPLACE FUNCTION growth_mission_record_guard()'),
    'the mission-record mutation guard exists',
  );
  assert.ok(
    migration045.includes('corrections are new version records, never rewrites'),
    'the objective-immutability rejection message is explicit',
  );
  assert.ok(
    migration045.includes('CAS version must advance by exactly one'),
    'the exact CAS advance is fenced',
  );
  assert.ok(
    migration045.includes('current version cannot regress'),
    'the version pointer only ever advances',
  );
  assert.ok(
    migration045.includes('growth missions cannot be deleted'),
    'mission records are never deleted',
  );
  // THE GAPLESS HISTORY SEQUENCE.
  assert.ok(
    migration045.includes('CONSTRAINT growth_mission_events_seq_unique UNIQUE (mission_id, event_seq)'),
    'the gapless per-mission history sequence is fenced',
  );
  // THE MAPPING FENCES: the agency scope fence, the terminal freeze, the
  // removal-only UPDATE fence, no-DELETE and the ACTIVE fence.
  assert.ok(
    migration045.includes('CREATE OR REPLACE FUNCTION growth_mission_goal_scope_consistent()'),
    'the agency scope fence exists',
  );
  assert.ok(
    migration045.includes('the agency boundary cannot be crossed'),
    'the cross-agency goal mapping rejection is explicit',
  );
  assert.ok(
    migration045.includes('a dangling goal reference cannot persist'),
    'the dangling-reference rejection is explicit (AC-7)',
  );
  assert.ok(
    migration045.includes('CREATE OR REPLACE FUNCTION growth_mission_mapping_terminal_frozen()'),
    'the terminal-freeze mapping fence exists',
  );
  assert.ok(
    migration045.includes('CREATE OR REPLACE FUNCTION growth_mission_mapping_removal_only()'),
    'the removal-only UPDATE fence exists (the 038 single-supersession precedent)',
  );
  assert.ok(
    migration045.includes('removal triple must be all-null or all-set'),
    'the all-or-nothing removal triple is fenced',
  );
  assert.ok(
    migration045.includes('growth_mission_goal_mappings_no_delete_trigger'),
    'mapping DELETE is rejected outright',
  );
  assert.ok(
    migration045.includes('growth_mission_goal_mappings_active_fence'),
    'the ACTIVE (mission, goal) partial-unique fence exists',
  );
  // The canonical goal reference is FK-anchored to the /goals authority
  // table (migration 007) — read CHECK-ONLY.
  assert.ok(
    migration045.includes('goal_id          uuid        NOT NULL REFERENCES goals(goal_id)'),
    'the mapping FK-anchors the canonical goal reference',
  );
});

// ---------------------------------------------------------------------------
// 3. THE LAYER-NOT-AUTHORITY BATTERY (the controller prohibition)
// ---------------------------------------------------------------------------

test('MKT-053 boundary: ZERO controller/scheduling/execution verbs in the module CODE — the record commands only', () => {
  // The comment-stripped module code carries NO controller verb of any
  // kind (architecture-lock-v1.6.md rule 17: the Growth Operator — a
  // decision/replanning CONTROLLER — is MKT-054, a later Work Item).
  for (const file of [missionPublic, missionModule, missionStore]) {
    const code = stripComments(file).toLowerCase();
    for (const forbidden of [
      'schedul', 'tick', 'poll', 'dispatch', 'execut', 'replan', 'timer',
      'cron', 'daemon', 'worker:', 'retry', 'sleep', 'setinterval',
      'settimeout', 'while (', 'for await',
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `the module code must never contain the controller verb '${forbidden}' — MKT-053 is the durable record layer only (architecture-lock-v1.6.md rule 17)`,
      );
    }
  }
  // The module API's method set is exactly the record commands (no
  // controller surface): create/read/list/resolve/detail/versions/history
  // + the version correction + the lifecycle transition + the mapping pair.
  const publicCode = stripComments(missionPublic);
  for (const method of [
    'createGrowthMission',
    'getGrowthMission',
    'resolveGrowthMissionOwnership',
    'listGrowthMissionsForAgency',
    'getGrowthMissionDetail',
    'getGrowthMissionVersions',
    'getGrowthMissionHistory',
    'recordGrowthMissionVersion',
    'setGrowthMissionStatus',
    'addGrowthMissionGoalMapping',
    'removeGrowthMissionGoalMapping',
  ]) {
    assert.ok(publicCode.includes(method), `GrowthMissionsModuleApi declares ${method}`);
  }
});

test('MKT-053 boundary: DML against OWN tables ONLY — the store never writes or reads another module\'s tables', () => {
  const storeCode = stripComments(missionStore);
  const ownTables = [
    'growth_missions',
    'growth_mission_versions',
    'growth_mission_target_metrics',
    'growth_mission_events',
    'growth_mission_goal_mappings',
  ];
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(insertTables)].sort(),
    [
      'growth_mission_events',
      'growth_mission_goal_mappings',
      'growth_mission_target_metrics',
      'growth_mission_versions',
      'growth_missions',
    ],
    'INSERTs target exactly the own five tables',
  );
  const updateTables = [...storeCode.matchAll(/UPDATE ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(updateTables)].sort(),
    ['growth_mission_goal_mappings', 'growth_missions'],
    'UPDATEs target exactly the mission record (CAS state/pointer) + the honest mapping removal',
  );
  assert.ok(
    !/\bDELETE FROM\b/i.test(storeCode),
    'the store never issues a DELETE (the tails are append-only; removals are recorded, never erased)',
  );
  // Every FROM target is an own table (every cross-module read composes
  // the /goals and /agencies public-contract ports).
  const selectTables = [...storeCode.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]!);
  for (const table of selectTables) {
    assert.ok(
      ownTables.includes(table),
      `the store may only read the own tables — found FROM ${table} (cross-module reads compose the /goals + /agencies public-contract ports)`,
    );
  }
  // The migration's only touches of the goals/clients/agencies tables are
  // the CHECK-ONLY trigger reads + the FK anchor: no INSERT/UPDATE/DELETE
  // on any of them anywhere in the migration code.
  for (const authority of ['goals', 'clients', 'agencies']) {
    assert.ok(
      !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${authority}\\b`).test(migration045),
      `the migration never writes the ${authority} authority table`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Zero cross-module internal imports (the real-codebase arch-check run)
// ---------------------------------------------------------------------------

test('MKT-053 AC-9 static: the real codebase enforces the frozen boundaries with ZERO violations — /growth-missions is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('growth-missions'), 'the enforced set includes /growth-missions');
  // The matrix-listed composition directions are exactly the two (both
  // consumed through the declared structural ports).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['growth-missions'], ['agencies', 'goals']);
  // The module's public contract imports ZERO other modules (the ports
  // are declared structurally — the app-metering /workspaces precedent).
  const imports = [...missionPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual(imports, []);
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'growth-missions', 'public.ts')));
  assert.ok(existsSync(src('modules', 'growth-missions', 'internal', 'growth-missions-module.ts')));
  assert.ok(existsSync(src('modules', 'growth-missions', 'internal', 'growth-missions-store.ts')));
});

// ---------------------------------------------------------------------------
// 5. The GET/POST-only route surface (AC-4/AC-5)
// ---------------------------------------------------------------------------

test('MKT-053 AC-4/AC-5 static: the route surface is EXACTLY the nine GET/POST record routes — no PUT/PATCH/DELETE anywhere', () => {
  const routes = [...stripComments(missionRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/agencies/:agencyId/growth-missions',
    'GET /api/growth-missions/:missionId',
    'GET /api/growth-missions/:missionId/history',
    'GET /api/growth-missions/:missionId/versions',
    'POST /api/agencies/:agencyId/growth-missions',
    'POST /api/growth-missions/:missionId/goal-mappings',
    'POST /api/growth-missions/:missionId/goal-mappings/:goalId/removal',
    'POST /api/growth-missions/:missionId/status',
    'POST /api/growth-missions/:missionId/versions',
  ]);
  const routesCode = stripComments(missionRoutes);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !routesCode.includes(`'${verb}'`),
      `the route file never registers the verb '${verb}' (corrections are NEW version POSTs; goal removal is a recorded removal, never a DELETE)`,
    );
  }
  // The fail-closed posture helpers exist (uniform 404 + 403).
  assert.ok(routesCode.includes('NotFoundError'), 'the uniform 404 error class');
  assert.ok(routesCode.includes('ForbiddenError'), 'the 403 error class');
  assert.ok(routesCode.includes('requireGrowthMissionsAgency'), 'the agency membership resolution');
  assert.ok(routesCode.includes('requireGrowthMissionAccess'), 'the mission-scoped ownership resolution');
  // Provenance is server-derived (never a request field): the DTOs reject
  // every provenance-shaped key.
  assert.ok(routesCode.includes('serverProvenance'), 'the server-derived provenance composer');
  assert.ok(routesCode.includes('forbiddenKeys'), 'the authority-field DTO rejection');
});

// ---------------------------------------------------------------------------
// 6. The spec registration + the migration list position + the shared files
// ---------------------------------------------------------------------------

test('MKT-053 AC-9 static: the disclosed spec registration exists — §6 line + the matrix row + the authority-notes bullet + 045 in numeric position', () => {
  // The §6 module list carries /growth-missions.
  assert.ok(
    /^\/growth-missions$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /growth-missions',
  );
  // The matrix dependency row + the authority-notes bullet (the disclosed
  // minimal registration — the app-metering style).
  assert.ok(
    matrixSpec.includes('/growth-missions ──→ /agencies, /goals'),
    'the matrix dependency row exists',
  );
  assert.ok(
    matrixSpec.includes('- `/growth-missions` is the v1.6 Growth Mission and Objective Model authority'),
    'the matrix authority-notes bullet exists',
  );
  // 045_growth_missions.sql holds its numeric position (the PRE-ASSIGNED
  // number — 046 belongs to the MKT-055 sibling delivery, which appends
  // it after this one per the pre-assignment).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '045_growth_missions.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '046_social_accounts.sql');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly growthMissions: GrowthMissionsModuleApi'), 'ApplicationModules.growthMissions');
  assert.ok(applicationTs.includes("from '../modules/growth-missions/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerGrowthMissionsRoutes(router, services, modules)'), 'routes.ts registers the mission routes');
  assert.ok(routesTs.includes("from './growth-missions-routes.ts'"), 'routes.ts imports the mission route builder');
  assert.ok(compositionRoot.includes('createGrowthMissionsModule'), 'the composition root constructs the mission module');
  assert.ok(
    compositionRoot.includes('    agencies,\n    goals,\n  });'),
    'the REAL /agencies + /goals public-contract instances satisfy the structural ports',
  );
});

// ---------------------------------------------------------------------------
// 7. The version discipline (the frozen vocabulary version + the basis)
// ---------------------------------------------------------------------------

test('MKT-053 AC-2 static: the version discipline ships — the frozen vocabulary version + the terminal-decision basis', () => {
  assert.equal(GROWTH_MISSION_VOCABULARY_VERSION, 'gm-vocab-v1');
  assert.equal(GROWTH_MISSION_TERMINAL_DECISION_BASIS, 'declared-business-objective-family');
  // The terminal states are exactly the frozen §2 seven, verbatim.
  assert.deepEqual(GROWTH_MISSION_TERMINAL_STATUSES, [
    'achieved',
    'stopped_by_user',
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ]);
  // The pure helpers are on the public contract (unit-testable + the
  // MKT-054 controller's future composition surface).
  for (const helper of [
    'isKnownGrowthMissionObjectiveFamily',
    'isKnownGrowthMissionStatus',
    'isTerminalGrowthMissionStatus',
    'isLegalGrowthMissionTransition',
    'assertValidGrowthMissionDeclaration',
    'assertValidGrowthMissionProvenance',
    'assertValidGrowthMissionReason',
    'composeGrowthMissionOwnerContext',
  ]) {
    assert.ok(missionPublic.includes(helper), `the public contract exports ${helper}`);
  }
});
