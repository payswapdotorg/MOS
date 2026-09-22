/**
 * MKT-067 boundary tests — the /experiment-analysis module fence.
 *
 * The nine boundary proofs (the content-rights/content-assets boundary
 * battery pattern):
 *
 *  1. OWN TABLES ONLY — migration 054 creates exactly the two module
 *     tables and touches no other authority's tables.
 *  2. VOCABULARIES CHECK-FENCED — the outcome, allocation-direction,
 *     arm-kind, method and floor-source vocabularies are DB CHECKs;
 *     both tails are append-only (UPDATE/DELETE rejection triggers);
 *     the tenant fences (experiment-same-client, workspace-in-client,
 *     analysis-linkage) exist.
 *  3. THE NO-SECOND-ENGINE BATTERY — the module exposes NO method that
 *     mutates experiments (no create/apply/conclude), no workflow/
 *     execution/workflow-input mutation, no platform-state write; the
 *     consumed authorities are read-only through their public contracts.
 *  4. THE HONTEX-NEGATIVE SPINE — negative/inconclusive outcome
 *     vocabulary members exist in code + DB CHECK; no outcome-coercion
 *     path exists (no 'retry', no rewrite — the append-only triggers
 *     are the backstop).
 *  5. THE HUMAN-GROWTH INVARIANT — zero-capacity arms (including the
 *     human-treatment arm) are recorded, never an error; the
 *     exploration floor is recorded data with its source.
 *  6. THE ROUTE SURFACE BATTERY — the exact route table; no update/
 *     delete route; no exposure-mutating route; authority fields
 *     rejected; literal-before-param registration order.
 *  7. arch-check ON THE REAL CODEBASE — zero violations; the §6 + matrix
 *     registration parses; the public imports are exactly the frozen
 *     four plus platform.
 *  8. THE SPEC REGISTRATION — §6 line + sentence; the matrix row verbatim;
 *     the migration tail position (054 last on the base).
 *  9. THE COMPOSITION WIRING — the composition root constructs and
 *     registers the module; ApplicationModules carries the contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  EXPERIMENT_ANALYSIS_OUTCOMES,
  EXPERIMENT_ALLOCATION_ARM_KINDS,
  EXPERIMENT_ANALYSIS_METHOD,
  EXPLORATION_FLOOR_SOURCES,
  RECOMMENDED_ALLOCATION_DIRECTIONS,
  EXPERIMENT_ANALYSIS_VOCABULARY_VERSION,
} from '../../src/modules/experiment-analysis/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration054 = read(src('platform', 'db', 'migrations', '054_experiment_analysis.sql'));
const analysisPublic = read(src('modules', 'experiment-analysis', 'public.ts'));
const analysisModule = read(src('modules', 'experiment-analysis', 'internal', 'module.ts'));
const analysisStore = read(src('modules', 'experiment-analysis', 'internal', 'store.ts'));
const analysisValidation = read(src('modules', 'experiment-analysis', 'internal', 'validation.ts'));
const analysisStatistics = read(src('modules', 'experiment-analysis', 'internal', 'statistics.ts'));
const analysisAllocator = read(src('modules', 'experiment-analysis', 'internal', 'allocator.ts'));
const analysisRoutes = read(src('api', 'experiment-analysis-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

// ---------------------------------------------------------------------------
// 1. OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-067 boundary 1: migration 054 creates EXACTLY the two module tables and never another authority\'s', () => {
  const created = [...migration054.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(created.sort(), [
    'experiment_allocation_recommendations',
    'experiment_analysis_records',
  ]);
  // No other authority's tables are created or mutated.
  for (const forbidden of [
    'experiments', 'experiment_transitions', 'metric_observations', 'evidence', 'learnings',
    'policy_decisions', 'clients', 'workspaces', 'agencies', 'workflow', 'execution',
    'growth_', 'content_', 'notification', 'job',
  ]) {
    assert.ok(
      !migration054.includes(`CREATE TABLE IF NOT EXISTS ${forbidden}`),
      `the migration must not create a ${forbidden} table`,
    );
    assert.ok(
      !new RegExp(`ALTER TABLE ${forbidden}`).test(migration054),
      `the migration must not alter a ${forbidden} table`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. VOCABULARIES CHECK-FENCED + append-only + tenant fences
// ---------------------------------------------------------------------------

test('MKT-067 boundary 2: the frozen vocabularies are DB CHECKs; both tails are append-only; the tenant fences exist', () => {
  // The outcome vocabulary is CHECK-fenced verbatim in the analysis table.
  for (const outcome of EXPERIMENT_ANALYSIS_OUTCOMES) {
    assert.ok(migration054.includes(`'${outcome}'`), `outcome '${outcome}' is CHECK-fenced`);
  }
  // The allocation-direction vocabulary is CHECK-fenced.
  for (const direction of RECOMMENDED_ALLOCATION_DIRECTIONS) {
    assert.ok(migration054.includes(`'${direction}'`), `direction '${direction}' is CHECK-fenced`);
  }
  // The arm-kind vocabulary is validated at the boundary (the closed
  // set lives in the public contract + the route DTO pattern + the
  // allocator kinds).
  const armKindSurfaces = [analysisPublic, analysisRoutes, analysisAllocator].join('\n');
  for (const kind of EXPERIMENT_ALLOCATION_ARM_KINDS) {
    assert.ok(armKindSurfaces.includes(`'${kind}'`), `arm kind '${kind}' is fenced in the boundary surfaces`);
  }
  // The method is a single-value CHECK (the frozen deterministic method).
  assert.ok(migration054.includes("CHECK (analysis_method IN ('two_sample_means_v1'))"));
  assert.ok(migration054.includes("vocabulary_version = 'ea-vocab-v1'"));
  // The floor sources are CHECK-fenced on the recommendation row.
  for (const source of EXPLORATION_FLOOR_SOURCES) {
    assert.ok(migration054.includes(`'${source}'`), `floor source '${source}' is CHECK-fenced`);
  }

  // APPEND-ONLY on BOTH tails (the migration 047/052 pattern).
  for (const [table, marker] of [
    ['experiment_analysis_records', 'experiment analysis'],
    ['experiment_allocation_recommendations', 'experiment allocation recommendation'],
  ] as const) {
    assert.ok(
      migration054.includes(`${table}_append_only() RETURNS trigger`),
      `${table} has the append-only guard function`,
    );
    assert.ok(
      new RegExp(`CREATE TRIGGER ${table}_append_only_trigger\\s+BEFORE UPDATE OR DELETE ON ${table}`).test(migration054),
      `${table} rejects UPDATE and DELETE`,
    );
    assert.ok(migration054.includes(`${marker} % is append-only`));
  }
  // A negative or inconclusive result is never rewritten: the append-only
  // rejection message states the preservation rule.
  assert.match(
    migration054,
    /a negative or inconclusive result is preserved, never rewritten; re-analysis is a NEW record/,
  );

  // THE TENANT FENCES: experiment-same-client + workspace-in-client +
  // analysis-linkage chain.
  assert.ok(
    migration054.includes('experiment_analysis_scope_chain_consistent() RETURNS trigger'),
    'the analysis scope-chain trigger exists',
  );
  assert.ok(migration054.includes('cross-tenant experiment linkage is rejected'));
  assert.ok(
    migration054.includes('experiment_allocation_scope_chain_consistent() RETURNS trigger'),
    'the allocation scope-chain trigger exists',
  );
  assert.ok(migration054.includes('the linkage chain cannot be crossed'));
  // The observation window is a real window.
  assert.ok(
    migration054.includes('CHECK (observation_window_end > observation_window_start)'),
  );
  // The exploration floor is recorded DATA with bounds.
  assert.ok(
    migration054.includes('CHECK (exploration_floor > 0 AND exploration_floor <= 0.5)'),
  );
});

// ---------------------------------------------------------------------------
// 3. THE NO-SECOND-ENGINE BATTERY
// ---------------------------------------------------------------------------

test('MKT-067 boundary 3: the module holds NO second-engine surface — no experiment mutation, no workflow/execution/exposure write', () => {
  const stripped = [
    stripComments(analysisModule),
    stripComments(analysisStore),
    stripComments(analysisPublic),
  ].join('\n');
  for (const forbidden of [
    'createExperiment',
    'applyExperimentTransition',
    'createWorkflow',
    'transitionWorkflow',
    'createExecution',
    'transitionExecution',
    'setExperimentExposure',
    'mutateExposure',
    'dispatchAllocation',
    'applyAllocation',
    'publish',
  ]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(stripped),
      `the module must not expose '${forbidden}'`,
    );
  }
  // The consumed authorities are READ through narrow documented methods.
  assert.ok(stripComments(analysisModule).includes('resolveExperimentOwnership'));
  assert.ok(stripComments(analysisModule).includes('listMetricObservationsForClient'));
  assert.ok(stripComments(analysisModule).includes('getEvidence'));
  assert.ok(stripComments(analysisModule).includes('listLearningsForClient'));
});

// ---------------------------------------------------------------------------
// 4. THE HONEST-NEGATIVE SPINE
// ---------------------------------------------------------------------------

test('MKT-067 boundary 4: negative/inconclusive outcomes are first-class — no coercion, no rewrite, no silent retry path', () => {
  // The pure classification never maps a non-positive state to a positive one.
  const statisticsCode = stripComments(analysisStatistics);
  assert.ok(statisticsCode.includes("return 'effect_negative';"));
  assert.ok(statisticsCode.includes("return 'inconclusive';"));
  assert.ok(statisticsCode.includes("return 'insufficient_observations';"));
  assert.ok(statisticsCode.includes("return 'effect_negligible';"));
  // No retry/coercion verbs on the record surface.
  for (const forbidden of ['retryAnalysis', 'rewriteOutcome', 'suppressAnalysis', 'discardAnalysis']) {
    assert.ok(!stripComments(analysisPublic).includes(forbidden));
  }
  // The DB rejects any rewrite of a recorded outcome (append-only triggers
  // — proven in boundary 2).
});

// ---------------------------------------------------------------------------
// 5. THE HUMAN-GROWTH INVARIANT
// ---------------------------------------------------------------------------

test('MKT-067 boundary 5: zero-capacity arms (the human-treatment arm included) are recorded, never an error; the floor is data', () => {
  const allocatorCode = stripComments(analysisAllocator);
  // The human arm is considered-and-recorded, never an absence.
  assert.ok(allocatorCode.includes('humanTreatmentConsideration'));
  assert.ok(allocatorCode.includes('never blocks, crashes or invalidates non-human allocation'));
  // A zero-capacity arm is excluded and recorded (not an error).
  assert.ok(allocatorCode.includes('zeroCapacityArms'));
  assert.ok(allocatorCode.includes('zero observable capacity'));
  // The exploration floor is an input recorded with its source.
  assert.ok(allocatorCode.includes('explorationFloor'));
  assert.ok(stripComments(analysisValidation).includes('explorationFloor'));
  assert.ok(migration054.includes('exploration_floor_source'));
});

// ---------------------------------------------------------------------------
// 6. THE ROUTE SURFACE BATTERY
// ---------------------------------------------------------------------------

test('MKT-067 boundary 6: the exact route surface — no update/delete/exposure route; authority fields rejected', () => {
  const routes = [...analysisRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes, [
    'POST /api/clients/:clientId/experiment-analysis/analyses',
    'GET /api/clients/:clientId/experiment-analysis/analyses',
    'GET /api/clients/:clientId/experiment-analysis/analyses/by-experiment/:experimentId',
    'GET /api/clients/:clientId/experiment-analysis/analyses/:analysisId',
    'POST /api/clients/:clientId/experiment-analysis/allocations',
    'GET /api/clients/:clientId/experiment-analysis/allocations/by-experiment/:experimentId',
    'GET /api/clients/:clientId/experiment-analysis/allocations/:recommendationId',
  ]);
  // The by-experiment literal routes register BEFORE the parameter routes.
  const byExperimentIndex = routes.findIndex((route) => route.includes('analyses/by-experiment'));
  const paramIndex = routes.findIndex((route) => route.endsWith('analyses/:analysisId'));
  assert.ok(byExperimentIndex >= 0 && paramIndex > byExperimentIndex);
  // The authority fields are rejected on every DTO.
  assert.ok(analysisRoutes.includes('EXPERIMENT_ANALYSIS_AUTHORITY_FIELDS'));
  assert.ok(analysisRoutes.includes("'outcome'"));
  assert.ok(analysisRoutes.includes("'inputDigest'"));
  assert.ok(analysisRoutes.includes("'shares'"));
  // The response carries the vocabulary version.
  assert.ok(analysisRoutes.includes(`vocabularyVersion: EXPERIMENT_ANALYSIS_VOCABULARY_VERSION`));
  // routes.ts registers the family.
  assert.ok(routesTs.includes("import { registerExperimentAnalysisRoutes } from './experiment-analysis-routes.ts'"));
  assert.ok(routesTs.includes('registerExperimentAnalysisRoutes(router, services, modules);'));
});

// ---------------------------------------------------------------------------
// 7. arch-check on the REAL codebase
// ---------------------------------------------------------------------------

test('MKT-067 boundary 7: the real codebase enforces the frozen boundaries — ZERO violations; the module is registered; imports are exactly the frozen four', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(modules.includes('experiment-analysis'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['experiment-analysis'], ['experiments', 'metrics', 'evidence', 'learnings']);

  // The module's public imports are EXACTLY the frozen four + platform.
  const publicImports = [
    ...analysisPublic.matchAll(/from '\.\.\/\.\.\/([a-z/-]+)\/|from '\.\.\/([a-z-]+)\/public\.ts'/g),
  ].map((match) => match[1] ?? match[2]);
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    ['evidence', 'experiments', 'learnings', 'metrics', 'platform/clock', 'platform/db', 'platform/ids'].sort(),
  );

  // ApplicationModules carries the contract.
  assert.ok(applicationTs.includes('readonly experimentAnalysis: ExperimentAnalysisModuleApi'));
  assert.ok(applicationTs.includes("from '../modules/experiment-analysis/public.ts'"));
});

// ---------------------------------------------------------------------------
// 8. THE SPEC REGISTRATION
// ---------------------------------------------------------------------------

test('MKT-067 boundary 8: the disclosed spec registration exists — §6 line + sentence + matrix row + bullet; 054 holds the migration tail', () => {
  // The §6 fence line.
  assert.ok(/^\/experiment-analysis$/m.test(architectureSpec), 'the §6 fence line exists');
  // The registration sentence.
  assert.ok(
    architectureSpec.includes(
      '`/experiment-analysis` is the v1.6 Experiment Analysis and Adaptive Allocation authority',
    ),
  );
  assert.ok(
    architectureSpec.includes(
      'a negative or inconclusive result is a valid scientific outcome preserved as a first-class append-only record',
    ),
  );
  // The matrix row (the enforced v1.1 file, the ──→ form inside the fence).
  assert.ok(
    matrixSpec.includes('/experiment-analysis ──→ /experiments, /metrics, /evidence, /learnings'),
    'the enforced matrix row exists',
  );
  // The authority bullet.
  assert.ok(
    matrixSpec.includes('- `/experiment-analysis` is the v1.6 Experiment Analysis and Adaptive Allocation authority'),
  );

  // The migration tail: 054 is the second-to-last entry of the ordered
  // expected list (the MKT-065 /cross-platform-distribution sibling
  // delivery appends 055 after it — the same additive precedent; every
  // tail position shifts once more).
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const expectedListMatch = infraAdapters.match(/assert\.deepEqual\(migrations, \[([\s\S]*?)\]\);/);
  assert.ok(expectedListMatch !== null, 'the expected-migration list must exist');
  const listEntries = [...expectedListMatch[1]!.matchAll(/'(\d{3}_[a-z_]+\.sql)'/g)].map((m) => m[1]!);
  // The MKT-062 sibling delivery appends 056_research.sql and
  // 057_content_intelligence.sql (the PRE-ASSIGNED numbers — every tail
  // position shifts once more; the same additive re-pin precedent).
  assert.equal(listEntries[listEntries.length -2], '057_content_intelligence.sql');
  // The MKT-066 sibling delivery appends 058_platform_health.sql (the
  // PRE-ASSIGNED number — every tail position shifts once more; the same
  // additive re-pin precedent).
  assert.equal(listEntries[listEntries.length - 1], '058_platform_health.sql');
  assert.equal(listEntries[listEntries.length -3], '056_research.sql');
  assert.equal(listEntries[listEntries.length -4], '055_cross_platform_distribution.sql');
  assert.equal(listEntries[listEntries.length -5], '054_experiment_analysis.sql');
  assert.equal(listEntries[listEntries.length -6], '053_content_assets.sql');
  assert.ok(existsSync(src('platform', 'db', 'migrations', '054_experiment_analysis.sql')));
  // 055 is the last migration on disk (the MKT-065 sibling tail).
  const onDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // The MKT-062 sibling delivery appends 056_research.sql and
  // 057_content_intelligence.sql (the PRE-ASSIGNED numbers — every tail
  // position shifts once more; the same additive re-pin precedent).
  assert.equal(onDisk[onDisk.length -2], '057_content_intelligence.sql');
  // The MKT-066 sibling delivery appends 058_platform_health.sql (the
  // PRE-ASSIGNED number — every tail position shifts once more; the same
  // additive re-pin precedent).
  assert.equal(onDisk[onDisk.length - 1], '058_platform_health.sql');
  assert.equal(onDisk[onDisk.length -3], '056_research.sql');
  assert.equal(onDisk[onDisk.length -4], '055_cross_platform_distribution.sql');
  assert.equal(onDisk[onDisk.length -5], '054_experiment_analysis.sql');
});

// ---------------------------------------------------------------------------
// 9. THE COMPOSITION WIRING
// ---------------------------------------------------------------------------

test('MKT-067 boundary 9: the composition root constructs and registers the module with the frozen-row instances', () => {
  assert.ok(
    compositionRoot.includes('const experimentAnalysis = createExperimentAnalysisModule'),
    'the composition root constructs the module',
  );
  assert.ok(compositionRoot.includes('createExperimentAnalysisModule({'));
  // The frozen-row deps are passed (experiments/metrics/evidence/learnings
  // + the structural ports clients/workspaces).
  const wiring = compositionRoot.slice(
    compositionRoot.indexOf('const experimentAnalysis = createExperimentAnalysisModule'),
    compositionRoot.indexOf('const experimentAnalysis = createExperimentAnalysisModule') + 500,
  );
  for (const dep of ['experiments,', 'metrics:', 'evidence,', 'learnings,', 'clients,', 'workspaces,']) {
    assert.ok(wiring.includes(dep), `the wiring passes ${dep}`);
  }
  // The modules map registers it (the tail position; the MKT-065
  // /cross-platform-distribution sibling delivery appends its own
  // registration after it — the same additive precedent).
  assert.ok(compositionRoot.includes('contentAssets, experimentAnalysis, crossPlatformDistribution, research'));
  // The MKT-062 sibling registration appends research + contentIntelligence
  // after crossPlatformDistribution (the additive composition-root
  // adjacency — the same sibling re-pin precedent).
  assert.ok(compositionRoot.includes('crossPlatformDistribution, research, contentIntelligence, platformHealth },'));
  // No ai-runtime dependency anywhere in the module wiring (determinism).
  assert.ok(!wiring.includes('aiRuntime'));
  // The vocabulary version is exported from the public contract.
  assert.ok(analysisPublic.includes(`'${EXPERIMENT_ANALYSIS_VOCABULARY_VERSION}'`));
  assert.ok(analysisPublic.includes(`'${EXPERIMENT_ANALYSIS_METHOD}'`));
});
