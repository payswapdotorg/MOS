/**
 * LAB-005 boundary tests — the static architectural proofs of
 * /lab-simulator (the LAB-004 boundary precedent, applied to the v1.7
 * Social Simulator Kernel):
 *
 *   1. THE NO-INVENTED-HIDDEN-PROVIDER-STATE DISCIPLINE (§8, the core
 *      acceptance): the migration owns EXACTLY its seven
 *      lab_simulator_* tables with the CHECK-fenced closed
 *      vocabularies (the pinned contract/world-model/engine/RNG
 *      versions, the 'declared_world_model_assumptions' modeling-basis
 *      label on EVERY configuration row — the declared knobs are
 *      explicit modeling assumptions, never provider facts — the
 *      'simulated_model_output' factuality label on EVERY run row, the
 *      closed outcome-metric vocabulary, the bounded step budget /
 *      member counts, the u64 seed shapes + the 64-hex digest shapes),
 *      the deterministic-identity fences and the append-only guard
 *      triggers (configurations, seeds, steps, observable snapshots and
 *      ensemble members append-only outright; runs and ensembles born
 *      running with the single completion advance);
 *   2. THE OBSERVABLE/HIDDEN SPLIT + THE OPAQUE CITATION (the /lab
 *      family discipline): the observable-state snapshots carry ONLY
 *      observable surfaces (no fatigue/trend/ranking-score internals
 *      in the agent-facing projection — asserted on the engine's
 *      output shape); the FK anchors are EXACTLY the tenant tables +
 *      same-module rows — NO foreign key into /lab, /lab-features,
 *      /lab-ideas or ANY v1.6 authority table; the module code issues
 *      NO SQL against any lab_, lab_feature_ or lab_idea_ table (the
 *      content-universe citations are OPAQUE recorded data);
 *   3. the module structure (public.ts + internal/ only) and the
 *      empty cross-module import set (the /lab family discipline);
 *   4. the registration: the granted worker spec append (the §6 line +
 *      the registration paragraph), the composition-root wiring and
 *      the ApplicationModules entry;
 *   5. the migration tail: 071_lab_simulator.sql sits in its
 *      TL-pre-assigned slot (069/070 are held by the in-flight
 *      parallel MKT-073/STUDIO-003 workers);
 *   6. the deterministic pure functions (the engine + the RNG + the
 *      digest derivations) are part of the frozen public surface (the
 *      reproducibility acceptance).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture } from '../../tools/arch-check/checker.ts';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string) => readFileSync(path, 'utf8');

const moduleDir = src('modules', 'lab-simulator');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '071_lab_simulator.sql'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureMd = read(join(repoRoot, 'spec', 'architecture.md'));

/** Strips line + block comments (the boundary-test convention). */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Strips SQL comments (line `--` + block) — for the DDL scans. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])--[^\n]*/g, '$1');
}

test('LAB-005 AC: the module owns EXACTLY its seven migration-071 tables — no authority table, no /lab table, no /lab-features or /lab-ideas table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...created].sort(),
    [
      'lab_simulator_ensemble_members',
      'lab_simulator_ensembles',
      'lab_simulator_observable_snapshots',
      'lab_simulator_run_steps',
      'lab_simulator_runs',
      'lab_simulator_seeds',
      'lab_simulator_world_configs',
    ],
  );
  // The FK anchors are EXACTLY the tenant tables + same-module rows.
  const references = [...stripSqlComments(migrationSql).matchAll(/REFERENCES\s+([a-z_]+)/g)].map((match) => match[1]!);
  for (const target of references) {
    assert.ok(
      [
        'agencies',
        'clients',
        'workspaces',
        'lab_simulator_world_configs',
        'lab_simulator_seeds',
        'lab_simulator_runs',
        'lab_simulator_ensembles',
      ].includes(target),
      `unexpected FK anchor '${target}' — the FK anchors must be tenant tables + same-module rows only`,
    );
  }
  // NO foreign key into any /lab, /lab-features, /lab-ideas or v1.6
  // authority table (the opaque citation discipline).
  for (const forbidden of [
    'REFERENCES lab_feature_',
    'REFERENCES lab_idea_',
    'REFERENCES lab_scenarios',
    'REFERENCES lab_runs',
    'REFERENCES experiments(',
    'REFERENCES decisions(',
    'REFERENCES evidence(',
    'REFERENCES metrics_',
    'REFERENCES publications',
  ]) {
    assert.ok(!stripSqlComments(migrationSql).includes(forbidden), `the migration must not FK into an authority table ('${forbidden}')`);
  }
});

test('LAB-005 AC: NO media bytes and no secret surface — the bounded payload columns only', () => {
  const sql = stripSqlComments(migrationSql);
  for (const forbidden of ['bytea', 'binary', 'blob', 'large object', 'lo_']) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `the migration must not contain any binary type ('${forbidden}')`);
  }
  // The only structured payload columns are the declared knobs, the
  // derived-seed lineage, the plan/universe citations, the loop-phase
  // telemetry, the observable projection, the ensemble config space,
  // the trend state and the step digests' companions — identity +
  // linkage + simulation data only.
  const jsonbColumns = [...sql.matchAll(/(\w+)\s+jsonb\b/g)].map((match) => match[1]!);
  assert.deepEqual([...jsonbColumns].sort(), [
    'candidates',
    'competitor_posts',
    'config_citations',
    'content_universe',
    'derived',
    'exposure',
    'interactions',
    'knobs',
    'observable_state',
    'publishing_plan',
    'topic_trends',
  ]);
  const code = stripComments(moduleCode);
  for (const forbidden of ['Buffer.from(', 'toByteArray', 'writeFile', 'bytea']) {
    assert.ok(!code.includes(forbidden), `the module code must not touch byte persistence ('${forbidden}')`);
  }
});

test('LAB-005 AC: THE NO-INVENTED-HIDDEN-STATE DISCIPLINE + the closed vocabularies + the append-only guard triggers (the core acceptance)', () => {
  const sql = migrationSql;
  // The pinned versions (the reproducibility contract).
  for (const pinned of [
    "'lab-simulator-contract-v1'",
    "'lab-worldmodel-v1'",
    "'lab-sim-engine-v1'",
    "'lab-simulator-splitmix64'",
    "'lab-sim-rng-v1'",
  ]) {
    assert.ok(sql.includes(pinned), `the pinned version vocabulary must be CHECK-fenced ('${pinned}')`);
  }
  // THE MODELING BASIS: every configuration row is structurally labeled
  // as declared modeling assumptions — never a provider fact (the
  // no-invented-hidden-state discipline, structural).
  assert.ok(sql.includes("CHECK (modeling_basis = 'declared_world_model_assumptions')"), 'the modeling-basis label is CHECK-fenced on every configuration row');
  // THE FACTUALITY LABEL: every run row carries the simulated-model-output label.
  assert.ok(sql.includes("CHECK (factuality = 'simulated_model_output')"), 'the factuality label is CHECK-fenced on every run row');
  // The closed outcome-metric vocabulary (the ensemble agreement).
  assert.ok(sql.includes("outcome_metric IN ('impressions', 'views', 'engagements'"), 'the closed outcome-metric vocabulary is CHECK-fenced');
  // THE §13 FENCE: an ensemble of ONE is structurally inexpressible.
  assert.ok(sql.includes('CHECK (member_count >= 2 AND member_count <= 32)'), 'the ensemble member-count fence (≥ 2 — a single run is never ground truth)');
  // THE REPLAY FENCES: a replay carries the original + the recorded proof.
  assert.ok(sql.includes('CONSTRAINT lab_simulator_runs_replay_fence'), 'the deterministic-replay fence exists (no unverified replay row is expressible)');
  // The status-conditional summary fences (the honestly-zero birth state).
  assert.ok(sql.includes('CONSTRAINT lab_simulator_runs_summary_status'), 'the run summary fence exists (the totals SQL-computed at the single completion advance)');
  assert.ok(sql.includes('CONSTRAINT lab_simulator_ensembles_summary_status'), 'the ensemble summary fence exists');
  // The deterministic-identity idempotence fences.
  assert.ok(sql.includes('CONSTRAINT lab_simulator_world_configs_identity UNIQUE (client_id, config_digest)'), 'the configuration digest idempotence fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_simulator_seeds_identity UNIQUE (client_id, seed_digest)'), 'the seed digest idempotence fence exists');
  // The u64 master-seed shape + numeric bound.
  assert.ok(sql.includes("master_seed ~ '^(0|[1-9][0-9]{0,19})$'"), 'the master-seed u64 shape is CHECK-fenced');
  // The append-only discipline: the five outright tables + the two
  // guarded lifecycles.
  assert.ok(sql.includes('lab_simulator_world_configs_no_update_trigger'), 'configurations reject UPDATE outright (immutable once instantiated)');
  assert.ok(sql.includes('lab_simulator_world_configs_no_delete_trigger'), 'configurations reject DELETE outright');
  assert.ok(sql.includes('lab_simulator_seeds_no_update_trigger'), 'seeds reject UPDATE outright');
  assert.ok(sql.includes('lab_simulator_seeds_no_delete_trigger'), 'seeds reject DELETE outright');
  assert.ok(sql.includes('lab_simulator_run_steps_no_update_trigger'), 'steps reject UPDATE outright');
  assert.ok(sql.includes('lab_simulator_run_steps_no_delete_trigger'), 'steps reject DELETE outright');
  assert.ok(sql.includes('lab_simulator_observable_snapshots_no_update_trigger'), 'observable snapshots reject UPDATE outright');
  assert.ok(sql.includes('lab_simulator_observable_snapshots_no_delete_trigger'), 'observable snapshots reject DELETE outright');
  assert.ok(sql.includes('lab_simulator_ensemble_members_no_update_trigger'), 'ensemble members reject UPDATE outright');
  assert.ok(sql.includes('lab_simulator_ensemble_members_no_delete_trigger'), 'ensemble members reject DELETE outright');
  assert.ok(sql.includes('lab_simulator_run_guard'), 'the run guard enforces the single completion advance');
  assert.ok(sql.includes('lab_simulator_ensemble_guard'), 'the ensemble guard enforces the single completion advance');
  // The scope-consistency triggers (the §22 discipline).
  assert.ok(sql.includes('lab_simulator_seed_scope_check'), 'the seed→configuration scope-consistency trigger exists');
  assert.ok(sql.includes('lab_simulator_run_scope_check'), 'the run→seed/config/replay-target scope-consistency trigger exists');
  assert.ok(sql.includes('lab_simulator_run_step_scope_check'), 'the step→run scope-consistency trigger exists');
  assert.ok(sql.includes('lab_simulator_observable_snapshot_scope_check'), 'the snapshot→run scope-consistency trigger exists');
  assert.ok(sql.includes('lab_simulator_ensemble_member_scope_check'), 'the member→ensemble/run/config scope-consistency trigger exists');
});

test('LAB-005 AC: THE CITATIONS ARE OPAQUE — the module writes NO /lab, /lab-features or /lab-ideas table (the by-reference discipline) + the observable/hidden split', () => {
  const code = stripComments(moduleCode);
  for (const forbidden of [
    'lab_feature_batch_runs',
    'lab_feature_bundles',
    'lab_feature_batch_items',
    'lab_idea_decompositions',
    'lab_idea_nodes',
    'lab_idea_operations',
    'lab_scenarios',
    'lab_runs',
    'SELECT * FROM lab_feature',
    'SELECT * FROM lab_idea',
    "FROM lab_scenarios",
    "FROM lab_runs",
  ]) {
    assert.ok(!code.includes(forbidden), `the module must not touch the /lab, /lab-features or /lab-ideas surfaces ('${forbidden}' found)`);
  }
  // The universe citation is carried as recorded data (the closed
  // citation-kind vocabulary is part of the frozen public surface).
  assert.ok(publicTs.includes('LAB_SIMULATOR_CITATION_KINDS'), 'the closed citation-kind vocabulary is part of the public contract');
  assert.ok(publicTs.includes('NO import of /lab-features'), 'the by-reference disclosure is recorded on the public surface');
  // THE MODELING-BASIS DISCLOSURE: the declared-assumption labeling is
  // exported on the public surface.
  assert.ok(publicTs.includes("LAB_SIMULATOR_MODELING_BASIS = 'declared_world_model_assumptions'"), 'the modeling-basis label is exported');
  assert.ok(publicTs.includes('LAB_SIMULATOR_RANKING_DISCLOSURE'), 'the ranking disclosure string is exported (never a provider fact)');
  // THE OBSERVABLE/HIDDEN SPLIT: the observable projection carries
  // ONLY observable surfaces — the model internals never enter it.
  assert.ok(publicTs.includes('interface LabSimulatorObservableSnapshotRecord'), 'the observable snapshot record is part of the public contract');
  assert.ok(
    !publicTs.includes('observableState: Readonly<Record<string, unknown>>').toString().includes('fatigue'),
    'the observable state shape never carries fatigue internals',
  );
  // The engine's observable projection is the declared closed shape.
  const core = read(join(moduleDir, 'internal', 'world-core.ts'));
  const observableMatch = core.match(/const observableState = \{[\s\S]*?\};/);
  assert.ok(observableMatch !== null, 'the engine builds the observable projection');
  const observableBody = observableMatch[0]!;
  for (const forbidden of ['fatigue', 'noveltyMap', 'pView', 'pEngage', 'trendValue', 'exposureShare']) {
    assert.ok(!observableBody.includes(forbidden), `the observable projection must not carry model internals ('${forbidden}')`);
  }
  // Every exposure decision carries the declared-assumption marker.
  assert.ok(core.includes("rankingModel: LAB_SIMULATOR_MODELING_BASIS"), 'every recorded exposure decision carries the declared-assumption label');
});

test('LAB-005 AC: the module imports NO other module — the /lab family discipline (zero cross-module imports; platform ports only)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The static checker enforces it with zero violations (59 enforced
  // modules: 58 spec-parsed — the granted LAB-005 worker spec
  // registration, the LAB-003/LAB-004 precedent — + the single /apps
  // provision; NO lab-simulator checker provision exists).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('lab-simulator'));
  assert.equal(result.frozenModules.length, 59);
});

test('LAB-005 AC: the registration — the granted worker spec append + the composition-root wiring + the ApplicationModules entry', () => {
  // The §6 module list line + the registration paragraph (the granted
  // REGISTRATION APPEND — the ONE spec exception the Tech Lead granted
  // this delivery; the LAB-003/LAB-004 precedent).
  const moduleListMatch = architectureMd.match(/## 6\. Core domain modules\s*```text([\s\S]*?)```/);
  assert.ok(moduleListMatch !== null);
  assert.ok(
    /^\s*\/lab-simulator\s*$/m.test(moduleListMatch[1]!),
    'spec/architecture.md §6 carries the /lab-simulator module list line',
  );
  assert.ok(architectureMd.includes('`/lab-simulator` is the v1.7 Social Simulator Kernel authority'), 'the §6 registration paragraph is present');
  assert.ok(
    architectureMd.indexOf('`/lab-capabilities` is the v1.7 Capability Engine + Arena Adapter authority') <
      architectureMd.indexOf('`/lab-simulator` is the v1.7 Social Simulator Kernel authority'),
    'the /lab-simulator paragraph is appended AFTER the /lab-capabilities registration paragraphs',
  );
  // The composition root: the import + the platform-ports-only wiring
  // + the modules-map tail.
  assert.ok(compositionRoot.includes("from './modules/lab-simulator/public.ts'"), 'the composition root imports the module public entry');
  assert.ok(compositionRoot.includes('const labSimulator = createLabSimulatorModule({'), 'the composition root wires the module');
  assert.ok(compositionRoot.includes('labCapabilities, labIdeas, labSimulator }'), 'the modules map carries the entry');
  // ApplicationModules.
  assert.ok(applicationTs.includes("from '../modules/lab-simulator/public.ts'"), 'application.ts imports the public contract');
  assert.ok(applicationTs.includes('readonly labSimulator: LabSimulatorModuleApi;'), 'ApplicationModules carries the entry');
});

test('LAB-005 AC: the migration tail — 071_lab_simulator.sql in its TL-pre-assigned slot (069 is held by the in-flight parallel MKT-073 worker; 070 is TAKEN by the merged STUDIO-003 sibling delivery; 073 is appended by the STUDIO-007 audio/video capture delivery — the disclosed additive re-pin)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrations.includes('071_lab_simulator.sql'));
  assert.equal(migrations[migrations.length - 2], '071_lab_simulator.sql');
  assert.equal(migrations[migrations.length - 4], '068_studio_format_framework.sql');
  assert.equal(migrations[migrations.length - 6], '066_lab_ideas.sql');
  assert.equal(migrations[migrations.length - 7], '065_lab_features.sql');
  assert.ok(!migrations.some((name) => name.startsWith('069_')), '069 stays reserved for the in-flight parallel MKT-073 worker');
  assert.ok(migrations.some((name) => name.startsWith('070_')), '070 is taken by the STUDIO-003 intent-to-script delivery (the additive re-pin — the TL pre-assigned slot)');
  assert.ok(migrations.some((name) => name.startsWith('073_')), '073 is taken by the STUDIO-007 audio/video capture delivery (the new tail — the same additive precedent)');
  // The module boundary is complete.
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const file of moduleFiles) {
    assert.ok(file.endsWith('.ts'), `the internal implementation files are TypeScript ('${file}')`);
  }
});

test('LAB-005 AC: the deterministic pure functions are part of the frozen public surface (the reproducibility contract)', () => {
  assert.ok(publicTs.includes('simulateLabTrajectory'), 'the pure engine is exported (the same inputs always produce the same trajectory)');
  assert.ok(publicTs.includes('createLabSimulatorRng'), 'the declared seeded generator is exported');
  assert.ok(publicTs.includes('deriveLabSimulatorSeed'), 'the deterministic derived-seed function is exported');
  assert.ok(publicTs.includes('computeLabSimulatorConfigDigest'), 'the configuration digest derivation is exported');
  assert.ok(publicTs.includes('computeLabSimulatorSeedDigest'), 'the seed digest derivation is exported');
  assert.ok(publicTs.includes('computeLabSimulatorStepDigest'), 'the step digest derivation is exported');
  assert.ok(publicTs.includes('computeLabSimulatorObservableDigest'), 'the observable digest derivation is exported');
  assert.ok(publicTs.includes('computeLabSimulatorTrajectoryDigest'), 'the trajectory digest derivation is exported');
  assert.ok(publicTs.includes("LAB_SIMULATOR_CONTRACT_VERSION = 'lab-simulator-contract-v1'"), 'the contract identity is pinned');
  assert.ok(publicTs.includes("LAB_SIMULATOR_WORLD_MODEL_VERSION = 'lab-worldmodel-v1'"), 'the world-model version is pinned');
  assert.ok(publicTs.includes("LAB_SIMULATOR_ENGINE_VERSION = 'lab-sim-engine-v1'"), 'the engine version is pinned');
  assert.ok(publicTs.includes("LAB_SIMULATOR_RNG_ID = 'lab-simulator-splitmix64'"), 'the RNG identity is pinned');
  assert.ok(publicTs.includes("LAB_SIMULATOR_RNG_VERSION = 'lab-sim-rng-v1'"), 'the RNG version is pinned');
  assert.ok(publicTs.includes("LAB_SIMULATOR_FACTUALITY = 'simulated_model_output'"), 'the factuality label is pinned');
  // The §13 disclosure: a single run is never ground truth.
  assert.ok(publicTs.includes('LAB_SIMULATOR_MIN_ENSEMBLE_MEMBERS = 2'), 'the §13 ensemble floor is pinned (an ensemble of ONE is inexpressible)');
});
