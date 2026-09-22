/**
 * MKT-065 static tests — the Cross-Platform Distribution authority is
 * structurally correct in the ACTUAL migration, module contract and route
 * surface (pure static analysis, no DB; the content-assets /
 * experiment-analysis boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-065; spec/
 * architecture-v1.6.md §5 "Cross-platform distribution"; spec/
 * architecture-lock-v1.6.md rules 20 ("Cross-platform distribution is
 * rights-gated per source asset and destination") and 29 ("Cross-platform
 * publishing requires both source rights and destination
 * capability/policy clearance")):
 *   1. migration 055 (the PRE-ASSIGNED number; 054 is the tail on the
 *      base; the MKT-057 and UX-002 siblings were told to add NONE — the
 *      Tech Lead reconciles numbering at merge, the 063/064/067
 *      precedent) creates exactly the four own tables —
 *      distribution_plans, distribution_destinations,
 *      distribution_publications, distribution_events — OWN tables ONLY:
 *      no mission, account, asset, rights, policy, integration or tenant
 *      table (the consumed authorities stay sole; the FK anchors are
 *      READ-ONLY references);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced (cpd-vocab-v1): the plan
 *      lifecycle, the destination outcome vocabulary, the event-kind
 *      vocabulary, the capability-rejection codes, the 056 publish-state
 *      mirror + the failure taxonomy, the asset-ref grammar, the
 *      idempotency-key grammar, the variant/key/sequence fences — plus
 *      the scope-chain/same-Client/same-agency triggers, the
 *      no-DELETE/disciplined-move triggers on plans and destinations and
 *      the fully append-only UPDATE/DELETE rejection triggers on the
 *      publications and the lineage tail;
 *   3. THE NO-SECOND-ENGINE BATTERY (the dispatch's cardinal rule): the
 *      physical publish goes EXACTLY through the 056 adapter contract —
 *      the module interacts with /social-accounts through
 *      resolveAccountOwnership, resolveAccountCapabilityMatrix and
 *      submitPublish ONLY (plus the read surfaces); NO provider HTTP
 *      client, NO fetch, NO worker host, NO dispatch loop, NO runtime
 *      identity of its own;
 *   4. THE NO-RIGHTS-AUTHORITY BATTERY (the 063 boundary rule): the
 *      module interacts with /content-rights EXACTLY through
 *      evaluatePublicationGate — the verdicts are RECORDED, never
 *      re-evaluated; only `allow` proceeds (fail-closed composition:
 *      review_required and blocked NEVER reach submitPublish);
 *   5. THE NO-POLICY-AUTHORITY BATTERY: /policies is consumed EXACTLY
 *      through evaluateAction (the dispatch gate); the decisions ride the
 *      policy engine's own ledger and their ids are recorded;
 *   6. THE NO-MISSION-MUTATION BATTERY: /growth-missions is consumed
 *      EXACTLY through resolveGrowthMissionOwnership (READ-ONLY) — no
 *      mission state, version or history write of any kind;
 *   7. THE DETERMINISM BATTERY: no /ai-runtime import anywhere in the
 *      module (the frozen row lists none); the pure helpers are
 *      deterministic (same inputs → same digest, same idempotency key);
 *   8. the route surface is EXACTLY the frozen five (GET/POST only; NO
 *      update route, NO delete route, NO gate-skipping/force-publish
 *      verb);
 *   9. the dependency posture (arch-check on the REAL codebase): zero
 *      violations, the module public imports exactly the six matrix-listed
 *      module publics + the platform contracts;
 *   10. the disclosed spec registration exists (the §6 line + sentence,
 *       the matrix row + bullet, the migration tail position — 055);
 *   11. the composition wiring is complete (the application surface, the
 *       composition root construction, the routes registration, the
 *       module count promotion in the arch-check test).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION,
  derivePublishIdempotencyKey,
  DISTRIBUTION_ASSET_REF_PATTERN,
  DISTRIBUTION_CAPABILITY_REJECTION_CODES,
  DISTRIBUTION_DESTINATION_STATUSES,
  DISTRIBUTION_EVENT_KINDS,
  DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN,
  DISTRIBUTION_PLAN_STATES,
  isLegalDistributionPlanTransition,
} from '../../src/modules/cross-platform-distribution/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration055 = read(src('platform', 'db', 'migrations', '055_cross_platform_distribution.sql'));
const modulePublic = read(src('modules', 'cross-platform-distribution', 'public.ts'));
const moduleImpl = read(src('modules', 'cross-platform-distribution', 'internal', 'module.ts'));
const moduleStore = read(src('modules', 'cross-platform-distribution', 'internal', 'store.ts'));
const moduleValidation = read(src('modules', 'cross-platform-distribution', 'internal', 'validation.ts'));
const moduleRoutes = read(src('api', 'cross-platform-distribution-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const routesTs = read(src('api', 'routes.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Comment-stripped SQL (dash-dash line comments and block comments). */
function stripSqlComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 055: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-065: migration 055 creates exactly the four cross-platform-distribution tables — OWN tables ONLY', () => {
  const created = [...migration055.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'distribution_plans',
      'distribution_destinations',
      'distribution_publications',
      'distribution_events',
    ],
    'own tables ONLY — the plan records, the destination variant rows, the per-destination publication links and the append-only lineage tail; the /growth-missions, /social-accounts, /content-assets, /content-rights, /integrations, /policies and tenant authorities stay sole',
  );

  // The migration never creates or mutates another authority's tables:
  // the ONLY cross-module references are the READ-ONLY FK anchors
  // (social accounts, publish attempts, missions, tenants — REFERENCES,
  // never CREATE/ALTER/UPDATE/DELETE of a foreign table).
  const sql = stripSqlComments(migration055);
  for (const forbidden of [
    /CREATE TABLE (?:IF NOT EXISTS )?(?:growth_missions|social_accounts|social_publish_attempts|content_assets|content_rights|polic|integrations)\b/,
    /CREATE TABLE (?:IF NOT EXISTS )?(?:agencies|clients|workspaces)\b/,
    /ALTER TABLE (?:ONLY )?(?:growth_missions|social_accounts|social_publish_attempts|content_assets|content_rights|policies|integrations|agencies|clients|workspaces)\b/,
    /UPDATE (?:ONLY )?(?:growth_missions|social_accounts|social_publish_attempts|content_assets|content_rights|policies|integrations|agencies|clients|workspaces)\b/,
    /DELETE FROM (?:growth_missions|social_accounts|social_publish_attempts|content_assets|content_rights|policies|integrations|agencies|clients|workspaces)\b/,
  ]) {
    assert.ok(!forbidden.test(sql), `migration 055 must not touch another authority's tables (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are CHECK-fenced (migration 055)
// ---------------------------------------------------------------------------

test('MKT-065: the plan lifecycle, destination outcomes, event kinds and mirrors are CHECK-fenced in migration 055', () => {
  // Whitespace-collapsed SQL (the CHECK lists wrap across lines — the
  // fences are matched content-wise, not layout-wise).
  const sql = stripSqlComments(migration055).replace(/\s+/g, ' ');

  // The plan lifecycle.
  assert.ok(sql.includes("CHECK (plan_state IN ('planned', 'dispatching', 'dispatched'))"));
  // The destination outcome vocabulary.
  assert.ok(sql.includes("CHECK (destination_status IN ('planned', 'rights_review_required', 'rights_blocked', 'capability_rejected', 'policy_blocked', 'publishing', 'published', 'accepted', 'failed', 'restricted'))"));
  // The event-kind vocabulary.
  assert.ok(sql.includes("CHECK (event_kind IN ('plan_created', 'dispatch_started', 'gate_evaluation', 'capability_resolution', 'policy_evaluation', 'publication_attempt', 'dispatch_completed', 'measurement_reference'))"));
  // The 056 publish-state mirror + the failure taxonomy on the
  // publication link rows.
  assert.ok(sql.includes("CHECK (publish_state IN ('submitted', 'accepted', 'published', 'failed', 'restricted'))"));
  assert.ok(sql.includes("'auth-expired', 'rate-limited', 'restricted', 'policy-denied', 'provider-unavailable', 'unsupported-capability', 'insufficient-scope'"));
  // The failure-shape fence (failure_code exactly on 'failed' states).
  assert.ok(sql.includes('CONSTRAINT distribution_publications_failure_shape CHECK'));
  // The asset-ref grammar (the 064 interop mirror).
  assert.ok(sql.includes("asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"));
  assert.ok(sql.includes("source_asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"));
  // The idempotency-key grammar (the 056 mirror).
  assert.ok(sql.includes("idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'"));
  // The fan-out fences: the position fence, the variant fence, the
  // global key fence, the gapless sequence fence, the one-publication-
  // per-destination fence.
  assert.ok(sql.includes('CONSTRAINT distribution_destinations_position_fence UNIQUE (plan_id, position)'));
  assert.ok(sql.includes('CONSTRAINT distribution_destinations_variant_fence UNIQUE (plan_id, social_account_id, target_format)'));
  assert.ok(sql.includes('CONSTRAINT distribution_destinations_key_fence UNIQUE (idempotency_key)'));
  assert.ok(sql.includes('CONSTRAINT distribution_events_sequence_fence UNIQUE (plan_id, event_seq)'));
  assert.ok(sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS distribution_publications_destination_fence'));
});

test('MKT-065: the append-only discipline + the tenant fences are trigger-fenced; the disciplined moves are the only sanctioned mutations', () => {
  const sql = stripSqlComments(migration055);
  // The fully append-only surfaces (UPDATE and DELETE rejected outright):
  // the lineage tail + the publication link rows.
  for (const table of ['distribution_events', 'distribution_publications']) {
    assert.ok(sql.includes(`CREATE TRIGGER ${table}_append_only_trigger`), `${table} is fully append-only`);
    assert.ok(
      new RegExp(`CREATE TRIGGER ${table}_append_only_trigger\\s*[\\s\\S]*?BEFORE UPDATE OR DELETE ON ${table}`).test(sql),
      `${table} rejects UPDATE and DELETE`,
    );
  }
  // The no-DELETE fences on the plan and destination records.
  for (const table of ['distribution_plans', 'distribution_destinations']) {
    assert.ok(sql.includes(`CREATE TRIGGER ${table}_no_delete_trigger`), `${table} is no-DELETE`);
  }
  // The disciplined state-move triggers.
  assert.ok(sql.includes('CREATE TRIGGER distribution_plans_disciplined_trigger'));
  assert.ok(sql.includes('CREATE TRIGGER distribution_destinations_disciplined_trigger'));
  // The plan moves: planned → dispatching → dispatched; dispatched →
  // dispatching (the idempotent re-dispatch) — nothing else.
  assert.ok(sql.includes("(OLD.plan_state = 'planned' AND NEW.plan_state = 'dispatching')"));
  assert.ok(sql.includes("(OLD.plan_state = 'dispatching' AND NEW.plan_state = 'dispatched')"));
  assert.ok(sql.includes("(OLD.plan_state = 'dispatched' AND NEW.plan_state = 'dispatching')"));
  // The destination outcome pointer NEVER returns to the born state.
  assert.ok(sql.includes('never re-entered'));
  // The scope-chain + same-Client/same-agency tenant fences.
  assert.ok(sql.includes('distribution_plans_scope_chain_trigger'));
  assert.ok(sql.includes('distribution_destinations_scope_trigger'));
  assert.ok(sql.includes('distribution_publications_scope_trigger'));
  assert.ok(sql.includes('distribution_events_destination_shape_trigger'));
  // The CAS-advance demands.
  assert.ok(sql.includes('the distribution plan state move must advance the CAS version'));
  assert.ok(sql.includes('the distribution destination outcome move must advance the CAS version'));
});

// ---------------------------------------------------------------------------
// 3. THE NO-SECOND-ENGINE BATTERY (the dispatch's cardinal rule)
// ---------------------------------------------------------------------------

test('MKT-065: the physical publish goes EXACTLY through the 056 submitPublish contract — NO provider client, NO worker plane, NO second engine', () => {
  const module = stripComments(moduleImpl);
  const store = stripComments(moduleStore);

  // The ONLY /social-accounts surfaces the module touches: the account
  // ownership resolution, the capability matrix and THE publish submit.
  const socialCalls = [...module.matchAll(
    /socialAccounts\.(resolveAccountOwnership|resolveAccountCapabilityMatrix|submitPublish|getSocialAccount|listSocialAccountsForClient|refreshPublishStatus)/g,
  )].map((match) => match[1]!);
  assert.deepEqual([...new Set(socialCalls)].sort(), [
    'resolveAccountCapabilityMatrix',
    'resolveAccountOwnership',
    'submitPublish',
  ]);
  // The module never holds a provider client, worker/dispatch loop or
  // runtime identity of its own.
  for (const forbidden of [
    /WorkerHost/, /worker-host/, /dispatchLoop/, /startWorker/, /claimTask/,
    /runQueue/, /spawnWorker/, /setInterval/, /fetch\(/, /node:http/,
    /https?:\/\//, /XMLHttpRequest/, / undici /,
  ]) {
    assert.ok(!forbidden.test(module), `the module must not implement its own provider client or worker plane (${forbidden})`);
    assert.ok(!forbidden.test(store), `the store must not implement its own provider client or worker plane (${forbidden})`);
  }
  // No publish-attempt table is ever written by the module or the store
  // (the 056 ledger stays the live publication truth).
  for (const forbidden of [
    /INSERT INTO social_publish_attempts/, /UPDATE social_publish_attempts/,
    /DELETE FROM social_publish_attempts/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write the 056 ledger (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write the 056 ledger (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 4. THE NO-RIGHTS-AUTHORITY BATTERY (the 063 boundary rule)
// ---------------------------------------------------------------------------

test('MKT-065: the module interacts with /content-rights EXACTLY through evaluatePublicationGate — the verdicts are recorded, never re-evaluated', () => {
  const module = stripComments(moduleImpl);
  const store = stripComments(moduleStore);

  // The ONLY /content-rights surface the module touches: THE gate.
  const rightsCalls = [...module.matchAll(
    /contentRights\.(evaluatePublicationGate|registerContentRights|recordRightsTransition|recordPlatformPermission|recordLineageLink|getRightsRecord\w*|listRightsEvents)/g,
  )].map((match) => match[1]!);
  assert.deepEqual([...new Set(rightsCalls)], ['evaluatePublicationGate']);
  // No rights table is ever written by the module or the store.
  for (const forbidden of [
    /INSERT INTO content_rights/, /UPDATE content_rights\w*/, /DELETE FROM content_rights/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write rights tables (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write rights tables (${forbidden})`);
  }
  // The fail-closed composition: only `allow` proceeds —
  // review_required and blocked NEVER reach submitPublish (the control
  // flow is executable code, not prose).
  assert.ok(module.includes("if (gate.outcome === 'review_required')"));
  assert.ok(module.includes("if (gate.outcome === 'blocked')"));
  // The gate evaluation happens BEFORE the capability resolution, the
  // policy gate and the publication attempt (the §5 chain order: Rights
  // before Platform/Account/Format before Publication). The anchors are
  // the main fan-out path's assignments (the re-dispatch convergence
  // replay of an attempted destination is a separate earlier branch —
  // the honest duplicate path).
  const gateIndex = module.indexOf('const gate = await evaluateRightsGate');
  const capabilityIndex = module.indexOf('const capability = await resolveDestinationCapability');
  const policyIndex = module.indexOf('const policy = await evaluateDispatchPolicy');
  const publishIndex = module.indexOf('const attempt = await attemptDestinationPublication');
  assert.ok(gateIndex >= 0 && capabilityIndex > gateIndex && policyIndex > capabilityIndex && publishIndex > policyIndex,
    'the fan-out order is gate → capability → policy → publish (the §5 chain)');
});

// ---------------------------------------------------------------------------
// 5. THE NO-POLICY-AUTHORITY BATTERY
// ---------------------------------------------------------------------------

test('MKT-065: /policies is consumed EXACTLY through evaluateAction — the dispatch gate; no policy table write', () => {
  const module = stripComments(moduleImpl);
  const store = stripComments(moduleStore);

  const policyCalls = [...module.matchAll(
    /policies\.(evaluateAction|declarePolicyVersion|getPolicyDecision|getPolicyVersion|listPolicyVersions|listPolicyDecisions)/g,
  )].map((match) => match[1]!);
  assert.deepEqual([...new Set(policyCalls)], ['evaluateAction']);
  for (const forbidden of [
    /INSERT INTO policy_/, /UPDATE policy_\w+/, /DELETE FROM policy_/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write policy tables (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write policy tables (${forbidden})`);
  }
  // The dispatch-gate operation label is the frozen one.
  assert.ok(moduleImpl.includes("'content.distribution.dispatch'"));
});

// ---------------------------------------------------------------------------
// 6. THE NO-MISSION-MUTATION BATTERY
// ---------------------------------------------------------------------------

test('MKT-065: /growth-missions is consumed EXACTLY through resolveGrowthMissionOwnership (READ-ONLY) — no mission mutation surface', () => {
  const module = stripComments(moduleImpl);
  const store = stripComments(moduleStore);

  const missionCalls = [...module.matchAll(
    /growthMissions\.(createGrowthMission|setGrowthMissionStatus|recordMissionVersion|mapMissionGoal|unmapMissionGoal|resolveGrowthMissionOwnership|getGrowthMission\w*)/g,
  )].map((match) => match[1]!);
  assert.deepEqual([...new Set(missionCalls)], ['resolveGrowthMissionOwnership']);
  for (const forbidden of [
    /INSERT INTO growth_missions/, /UPDATE growth_missions/, /DELETE FROM growth_missions/,
    /INSERT INTO growth_mission_/, /UPDATE growth_mission_\w+/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write mission tables (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write mission tables (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 7. THE DETERMINISM BATTERY (no /ai-runtime — the frozen row lists none)
// ---------------------------------------------------------------------------

test('MKT-065: the module is fully deterministic — NO /ai-runtime import anywhere; the pure helpers are deterministic', () => {
  for (const file of [modulePublic, moduleImpl, moduleStore, moduleValidation, moduleRoutes]) {
    // Comment-stripped: the DISCLOSURE that no ai-runtime dependency
    // exists is prose, not code — the code itself must carry none.
    const code = stripComments(file);
    assert.ok(!code.includes('ai-runtime'), 'no /ai-runtime import may exist anywhere in the module surfaces');
    assert.ok(!code.includes('aiRuntime'), 'no /ai-runtime reference may exist anywhere in the module surfaces');
  }
  // The deterministic idempotency key: same plan + destination → same
  // key, and it satisfies the 056 grammar.
  const planId = '0d9e8a7b-6c5d-4e3f-9a2b-1c0d9e8a7b6c';
  const destinationId = '1e0f9b8c-7d6e-4f3a-8b3c-2d1e0f9b8c7d';
  const key = derivePublishIdempotencyKey(planId, destinationId);
  assert.equal(key, `cpd:${planId}:${destinationId}`);
  assert.ok(DISTRIBUTION_IDEMPOTENCY_KEY_PATTERN.test(key));
  assert.equal(key.length, 77);
  // The 064 interop grammar mirror.
  assert.ok(DISTRIBUTION_ASSET_REF_PATTERN.test('ca:01234567-89ab-cdef-0123-456789abcdef'));
  assert.ok(!DISTRIBUTION_ASSET_REF_PATTERN.test('asset-latest'));
});

// ---------------------------------------------------------------------------
// 8. The route surface is EXACTLY the frozen five
// ---------------------------------------------------------------------------

test('MKT-065: the route surface is EXACTLY the frozen five (GET/POST only; NO update, NO delete, NO gate-skipping verb)', () => {
  const registered = [...moduleRoutes.matchAll(/router\.add\(\s*'(\w+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(registered, [
    'POST /api/clients/:clientId/cross-platform-distribution/plans',
    'GET /api/clients/:clientId/cross-platform-distribution/plans',
    'GET /api/clients/:clientId/cross-platform-distribution/plans/:planId',
    'POST /api/clients/:clientId/cross-platform-distribution/plans/:planId/dispatch',
    'POST /api/clients/:clientId/cross-platform-distribution/plans/:planId/measurements',
  ]);
  // NO update route (declarations are immutable), NO delete route (the
  // lineage is append-only) and NO force-publish/gate-skip verb of any
  // kind (fail-closed by construction).
  for (const forbidden of [
    /router\.add\(\s*'(PUT|PATCH|DELETE)'/,
    /force/, /bypass/, /skip[-_]?gate/, /unsafe/,
  ]) {
    assert.ok(!forbidden.test(stripComments(moduleRoutes)), `no mutation-bypass route may exist (${forbidden})`);
  }
  // The strict-validation gate runs on EVERY mutation route (the dispatch
  // route reads no body but still rejects authority fields).
  assert.ok(moduleRoutes.includes('DISTRIBUTION_AUTHORITY_FIELDS'));
  const validateCount = (moduleRoutes.match(/validate: \(ctx\) =>/g) ?? []).length;
  assert.equal(validateCount, 3, 'all three mutation routes carry the strict-validation gate');
});

// ---------------------------------------------------------------------------
// 9. The dependency posture (arch-check on the REAL codebase)
// ---------------------------------------------------------------------------

test('MKT-065: the real codebase enforces the frozen boundaries — zero violations, the module public imports exactly the six matrix-listed publics', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen matrix row is parsed from the spec docs (the frozen v1.6
  // row verbatim).
  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(modules.includes('cross-platform-distribution'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['cross-platform-distribution'], [
    'growth-missions', 'social-accounts', 'content-assets', 'content-rights',
    'integrations', 'policies',
  ]);

  // The module public imports exactly the matrix-listed module publics
  // and platform contracts.
  const publicImports = [...modulePublic.matchAll(/from '\.\.\/\.\.\/([a-z/-]+)\/|from '\.\.\/([a-z-]+)\/public\.ts'/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    [
      'content-assets', 'content-rights', 'growth-missions', 'integrations',
      'policies', 'platform/clock', 'platform/db', 'platform/ids', 'social-accounts',
    ].sort(),
  );
  // 48 enforced modules after this registration (47 spec-parsed — the
  // MKT-062 sibling delivery appends /research + /content-intelligence,
  // the same additive promotion precedent — + the disclosed 'apps'
  // provision).
  assert.equal(result.frozenModules.length, 48);
});

// ---------------------------------------------------------------------------
// 10. The disclosed spec registration
// ---------------------------------------------------------------------------

test('MKT-065: the disclosed spec registration exists (the §6 line + sentence, the matrix row + bullet, the migration position)', () => {
  // §6 module list line.
  assert.ok(/^\/cross-platform-distribution$/m.test(architectureSpec));
  // §6 registration sentence.
  assert.ok(architectureSpec.includes('`/cross-platform-distribution` is the v1.6 Cross-Platform Distribution authority'));
  // The matrix row (the frozen v1.6 row verbatim).
  assert.ok(matrixSpec.includes('/cross-platform-distribution ──→ /growth-missions, /social-accounts, /content-assets, /content-rights, /integrations, /policies'));
  // The authority bullet.
  assert.ok(matrixSpec.includes('- `/cross-platform-distribution` is the v1.6 Cross-Platform Distribution authority'));

  // 055 holds its numeric position at the END of the ordered
  // expected-migration list in the infra-adapters architecture test.
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const expectedListMatch = infraAdapters.match(/assert\.deepEqual\(migrations, \[([\s\S]*?)\]\);/);
  assert.ok(expectedListMatch !== null, 'the expected-migration list must exist');
  const listEntries = [...expectedListMatch[1]!.matchAll(/'(\d{3}_[a-z_]+\.sql)'/g)].map((m) => m[1]!);
  // The MKT-065 delivery appends 055 after 054 (the same additive
  // precedent — the merged-tree tail: 054 now holds position -2).
  // The MKT-062 sibling delivery appends 056_research.sql and
  // 057_content_intelligence.sql (the PRE-ASSIGNED numbers — every tail
  // position shifts once more; the same additive re-pin precedent).
  assert.equal(listEntries[listEntries.length -1], '057_content_intelligence.sql');
  assert.equal(listEntries[listEntries.length -2], '056_research.sql');
  assert.equal(listEntries[listEntries.length -3], '055_cross_platform_distribution.sql');
  assert.equal(listEntries[listEntries.length -4], '054_experiment_analysis.sql');
  assert.equal(listEntries[listEntries.length -5], '053_content_assets.sql');

  // The migration file exists.
  assert.ok(existsSync(src('platform', 'db', 'migrations', '055_cross_platform_distribution.sql')));
});

// ---------------------------------------------------------------------------
// 11. The composition wiring + the frozen vocabularies (the module contract)
// ---------------------------------------------------------------------------

test('MKT-065: the composition wiring is complete (the application surface, the composition root, the routes)', () => {
  assert.ok(applicationTs.includes('crossPlatformDistribution: CrossPlatformDistributionModuleApi'));
  assert.ok(compositionRoot.includes('createCrossPlatformDistributionModule'));
  assert.ok(
    compositionRoot.includes('const crossPlatformDistribution = createCrossPlatformDistributionModule({'),
    'the composition root constructs the cross-platform-distribution module',
  );
  assert.ok(routesTs.includes('registerCrossPlatformDistributionRoutes(router, services, modules)'));
  assert.ok(routesTs.includes("from './cross-platform-distribution-routes.ts'"));
  // The arch-check promotion: 47 spec-parsed modules (the MKT-062 sibling
  // delivery appends /research + /content-intelligence — the same additive
  // promotion precedent) + the disclosed 'apps' provision = 48 enforced.
  const archCheckTest = read(join(repoRoot, 'tests', 'architecture', 'arch-check.test.ts'));
  assert.ok(archCheckTest.includes('(47 modules)'));
  assert.ok(archCheckTest.includes("'cross-platform-distribution'"));
  assert.ok(archCheckTest.includes('MISSING_MODULE|src/modules/cross-platform-distribution'));
  assert.ok(archCheckTest.includes("'research'"));
  assert.ok(archCheckTest.includes("'content-intelligence'"));
  assert.ok(archCheckTest.includes('MISSING_MODULE|src/modules/research'));
  assert.ok(archCheckTest.includes('MISSING_MODULE|src/modules/content-intelligence'));
  assert.ok(
    /\n\s*48,\s*\n\s*'no unexpected violation categories may be reported'/.test(archCheckTest),
    'the structure-violation total is promoted 46 → 48 (the MKT-062 sibling registrations)',
  );
});

test('MKT-065: the module vocabularies are frozen and versioned (cpd-vocab-v1)', () => {
  assert.equal(CROSS_PLATFORM_DISTRIBUTION_VOCABULARY_VERSION, 'cpd-vocab-v1');
  assert.deepEqual(DISTRIBUTION_PLAN_STATES, ['planned', 'dispatching', 'dispatched']);
  assert.deepEqual(DISTRIBUTION_DESTINATION_STATUSES, [
    'planned',
    'rights_review_required',
    'rights_blocked',
    'capability_rejected',
    'policy_blocked',
    'publishing',
    'published',
    'accepted',
    'failed',
    'restricted',
  ]);
  assert.deepEqual(DISTRIBUTION_EVENT_KINDS, [
    'plan_created',
    'dispatch_started',
    'gate_evaluation',
    'capability_resolution',
    'policy_evaluation',
    'publication_attempt',
    'dispatch_completed',
    'measurement_reference',
  ]);
  assert.deepEqual(DISTRIBUTION_CAPABILITY_REJECTION_CODES, [
    'platform_adapter_unregistered',
    'authorization_unusable',
    'publish_capability_undeclared',
    'publish_operation_undeclared',
    'publish_scope_unsatisfied',
    'integration_adapter_unregistered',
  ]);
  // The plan transition table.
  assert.ok(isLegalDistributionPlanTransition('planned', 'dispatching'));
  assert.ok(isLegalDistributionPlanTransition('dispatching', 'dispatched'));
  assert.ok(isLegalDistributionPlanTransition('dispatched', 'dispatching'));
  assert.ok(!isLegalDistributionPlanTransition('planned', 'dispatched'));
  assert.ok(!isLegalDistributionPlanTransition('dispatched', 'planned'));
  // The guard module exists as module structure.
  assert.ok(existsSync(src('modules', 'cross-platform-distribution', 'internal', 'validation.ts')));
  assert.ok(stripComments(moduleValidation).includes('assertValidCreateDistributionPlanInput'));
  assert.ok(stripComments(moduleValidation).includes('computeDistributionPlanInputDigest'));
});
