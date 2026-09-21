/**
 * MKT-064 static tests — the Content Asset and Transformation Authority
 * is structurally correct in the ACTUAL migration, module contract and
 * route surface (pure static analysis, no DB; the
 * content-rights-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-064; spec/
 * architecture-v1.6.md §10 "Transformation system"; spec/
 * architecture-lock-v1.6.md rules 23/24; spec/
 * module-dependency-matrix-v1.6.md boundary rule 5: "Content Assets
 * stores/derives artifact lineage but cannot become a rights
 * authority"; AGENTS.md: "Transformation engines must preserve
 * source/ingredient lineage and may be first-party capabilities or
 * Extensions/Apps"):
 *   1. migration 053 (the PRE-ASSIGNED number; the main tail is 051 and
 *      052 is deliberately left for the sibling MKT-054's
 *      renumber-at-merge — disclosed) creates exactly the six own
 *      tables — content_assets, content_asset_versions,
 *      content_asset_lifecycle_events,
 *      content_asset_quality_observations, content_transformations,
 *      content_transformation_ingredients — OWN tables ONLY: no rights,
 *      policy, evidence, tenant, execution, workflow or job table (the
 *      authorities stay sole; the /executions reference is a READ-ONLY
 *      FK anchor, the object store is the platform port referenced by
 *      content-addressed key only);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the nine
 *      transformation kinds (the MKT-064 acceptance list VERBATIM), the
 *      media kinds, the lifecycle states, the lifecycle-event kinds
 *      with their frozen event shapes, the quality-metric vocabulary
 *      (the closed observation set — a fabricated 'score' cannot even
 *      be expressed), the transformation statuses with their status
 *      shapes, the ref grammar, the (asset, version) fence, the
 *      materialization + provenance shape CHECKs, the execution
 *      1:1 fence, the ingredient pair/position fences — plus the
 *      scope-chain, same-Client evidence and same-Client ingredient
 *      triggers and the append-only UPDATE/DELETE rejection triggers;
 *   3. THE NO-SECOND-ENGINE BATTERY (the MKT-054 cardinal rule + rule
 *      24): the module interacts with the /executions authority
 *      EXACTLY through createExecution / transitionExecution /
 *      getExecution — NO execution table is written by the module, NO
 *      worker host, NO dispatch loop, NO runtime identity of its own;
 *      the ENGINE is a replaceable capability behind the port
 *      registered as module DATA (the composition root registers NONE
 *      by default — the MKT-056 discipline; a kind with no engine
 *      fails closed);
 *   4. THE BOUNDARY-RULE-5 BATTERY (no rights authority): the module
 *      interacts with /content-rights EXACTLY through recordLineageLink
 *      (the derivation-seam bookkeeping) — NO gate evaluation, NO
 *      rights registration, NO transition, NO permission write, NO
 *      rights-table write anywhere: transforming an asset NEVER checks
 *      or mutates rights (an asset whose ingredients are rights-blocked
 *      can still be TRANSFORMED but can never pass the 063 publication
 *      gate);
 *   5. THE LINEAGE-IMMUTABILITY BATTERY (rule 23: "Every derived
 *      content artifact retains ingredient and transformation
 *      lineage"): the ingredient links are fully append-only with the
 *      refs FROZEN at request time; the output version link is set ONCE
 *      at completion (the disciplined terminal moves); the derived
 *      version is BORN with its object and its lineage (an existing
 *      version can never be mutated into an output — the only legal
 *      lifecycle move is draft → materialized);
 *   6. the route surface is EXACTLY the frozen set (GET/POST only; the
 *      literal segments register BEFORE the :versionId patterns;
 *      NO update route, NO delete route, NO rights-mutating route, NO
 *      engine-registry route);
 *   7. the dependency posture (arch-check on the REAL codebase): zero
 *      violations, the module public imports only the matrix-listed
 *      publics (/executions + /content-rights — the DISCLOSED
 *      module-importable subset of the frozen v1.6 row;
 *      /object-storage rides as the platform ObjectStore port and
 *      /evidence as the id-based reference seam);
 *   8. the disclosed spec registration exists (the §6 line + sentence,
 *      the matrix row + bullet, the migration tail position — 053,
 *      with 052 disclosed as the reserved sibling renumber gap);
 *   9. THE 063 SEAM COMPLETION (the mutual registration): the
 *      /content-rights row now lists /content-assets (the module
 *      exists on BOTH sides of the seam); the module public exports the
 *      ContentAssetReferencePort factory; the minted refs satisfy the
 *      063 migration-051 ref grammar; the composition root + application
 *      surface carry the module (the shared-file registration).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  CONTENT_ASSET_LIFECYCLE_EVENT_KINDS,
  CONTENT_ASSET_LIFECYCLE_STATES,
  CONTENT_ASSETS_VOCABULARY_VERSION,
  CONTENT_MEDIA_KINDS,
  CONTENT_QUALITY_METRICS,
  CONTENT_TRANSFORMATION_STATUSES,
  TRANSFORMATION_KINDS,
  createContentAssetReferencePort,
  mintContentAssetRef,
} from '../../src/modules/content-assets/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration053 = read(src('platform', 'db', 'migrations', '053_content_assets.sql'));
const assetsPublic = read(src('modules', 'content-assets', 'public.ts'));
const assetsModule = read(src('modules', 'content-assets', 'internal', 'module.ts'));
const assetsStore = read(src('modules', 'content-assets', 'internal', 'store.ts'));
const assetsValidation = read(src('modules', 'content-assets', 'internal', 'validation.ts'));
const assetsEngines = read(src('modules', 'content-assets', 'internal', 'engines', 'transformation-engines.ts'));
const assetsRoutes = read(src('api', 'content-assets-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));
const migration051 = read(src('platform', 'db', 'migrations', '051_content_rights.sql'));

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
// 1. Migration 053: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-064: migration 053 creates exactly the six content-assets tables — OWN tables ONLY', () => {
  const created = [...migration053.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'content_assets',
      'content_asset_versions',
      'content_asset_lifecycle_events',
      'content_asset_quality_observations',
      'content_transformations',
      'content_transformation_ingredients',
    ],
    'own tables ONLY — the logical asset identities, the immutable versioned artifact records, the append-only lifecycle tail, the append-only quality observations, the recorded transformations and the immutable ingredient lineage links; the /executions, /content-rights, /evidence, /policies and tenant authorities stay sole',
  );

  // The migration never creates or mutates another authority's tables:
  // the ONLY cross-module references are the READ-ONLY FK anchors
  // (evidence, executions, agencies, clients, workspaces — REFERENCES,
  // never CREATE/ALTER/UPDATE/DELETE of a foreign table).
  const sql = stripSqlComments(migration053);
  for (const forbidden of [
    /CREATE TABLE (?:IF NOT EXISTS )?content_rights/,
    /CREATE TABLE (?:IF NOT EXISTS )?evidence\b/,
    /CREATE TABLE (?:IF NOT EXISTS )?polic/,
    /CREATE TABLE (?:IF NOT EXISTS )?executions\b/,
    /CREATE TABLE (?:IF NOT EXISTS )?(?:agencies|clients|workspaces)\b/,
    /ALTER TABLE (?:ONLY )?(?:content_rights|evidence|policies|executions|agencies|clients|workspaces)\b/,
    /UPDATE (?:ONLY )?(?:content_rights|evidence|policies|executions|agencies|clients|workspaces)\b/,
    /DELETE FROM (?:content_rights|evidence|policies|executions|agencies|clients|workspaces)\b/,
  ]) {
    assert.ok(!forbidden.test(sql), `migration 053 must not touch another authority's tables (${forbidden})`);
  }

  // 052 is deliberately NOT created here (the sibling MKT-054's 050
  // collision is renumbered to 052 at ITS merge — the disclosed gap).
  assert.ok(!existsSync(src('platform', 'db', 'migrations', '052_commerce.sql')));
  assert.ok(!existsSync(src('platform', 'db', 'migrations', '052_content_rights.sql')));
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are CHECK-fenced (migration 053)
// ---------------------------------------------------------------------------

test('MKT-064: the transformation kind family, media kinds, lifecycle, metrics and statuses are CHECK-fenced in migration 053', () => {
  // Whitespace-collapsed SQL (the CHECK lists wrap across lines — the
  // fences are matched content-wise, not layout-wise).
  const sql = stripSqlComments(migration053).replace(/\s+/g, ' ');

  // The transformation kinds — the MKT-064 acceptance list VERBATIM.
  assert.ok(sql.includes("CHECK (transformation_kind IN ('crop', 'reframe', 'padding', 'compilation', 'clip', 'caption', 'voice', 'translation', 'format'))"));
  // The media kinds.
  assert.ok(sql.includes("CHECK (media_kind IN ('video', 'audio', 'image', 'text', 'document'))"));
  // The lifecycle states.
  assert.ok(sql.includes("CHECK (lifecycle_state IN ('draft', 'materialized', 'derived'))"));
  // The lifecycle event kinds + the frozen event shapes.
  assert.ok(sql.includes("CHECK (event_kind IN ('registration', 'materialization', 'derivation'))"));
  assert.ok(sql.includes("CONSTRAINT content_asset_lifecycle_event_shape CHECK"));
  // The transformation statuses + the status shapes.
  assert.ok(sql.includes("CHECK (status IN ('requested', 'completed', 'failed'))"));
  assert.ok(sql.includes("CONSTRAINT content_transformation_status_shape CHECK"));
  // The quality-metric vocabulary — the closed observation set.
  assert.ok(sql.includes("CHECK (metric IN ('duration_ms', 'width_px', 'height_px', 'bitrate_kbps', 'caption_coverage_ratio', 'language', 'fps', 'sample_rate_hz', 'byte_size'))"));
  // The observation value shapes (language carries text; every other
  // metric a non-negative number; the coverage ratio bounded to [0,1]).
  assert.ok(sql.includes('CONSTRAINT content_asset_quality_observation_shape CHECK'));
  // The ref grammar + the content-addressed object keys.
  assert.ok(sql.includes("asset_ref ~ '^ca:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'"));
  assert.ok(sql.includes("object_key ~ '^[a-f0-9]{64}$'"));
  // The materialization + provenance shape CHECKs.
  assert.ok(sql.includes('CONSTRAINT content_asset_version_materialization_shape CHECK'));
  assert.ok(sql.includes('CONSTRAINT content_asset_version_provenance_shape CHECK'));
  // The version discipline fences: one explicit version per asset; the
  // globally-unique ref; the execution 1:1 fence.
  assert.ok(sql.includes('content_asset_versions_asset_version_fence'));
  assert.ok(sql.includes('content_asset_versions_ref_fence'));
  assert.ok(sql.includes('content_transformations_execution_fence'));
  // The ingredient pair/position fences.
  assert.ok(sql.includes('content_transformation_ingredients_pair_fence'));
  assert.ok(sql.includes('content_transformation_ingredients_position_fence'));
});

test('MKT-064: the append-only discipline is trigger-fenced on every tail; versions and transformations admit only their disciplined moves; nothing is deletable', () => {
  const sql = stripSqlComments(migration053);
  // The fully append-only tails (UPDATE and DELETE rejected outright).
  for (const table of [
    'content_asset_lifecycle_events',
    'content_asset_quality_observations',
    'content_transformation_ingredients',
  ]) {
    assert.ok(sql.includes(`CREATE TRIGGER ${table}_append_only_trigger`), `${table} is fully append-only`);
    assert.ok(
      new RegExp(`CREATE TRIGGER ${table}_append_only_trigger\\s*[\\s\\S]*?BEFORE UPDATE OR DELETE ON ${table}`).test(sql),
      `${table} rejects UPDATE and DELETE`,
    );
  }
  // The no-DELETE fences on the records.
  for (const table of ['content_assets', 'content_asset_versions', 'content_transformations']) {
    assert.ok(sql.includes(`CREATE TRIGGER ${table}_no_delete_trigger`), `${table} is no-DELETE`);
  }
  // The disciplined state-move triggers.
  assert.ok(sql.includes('CREATE TRIGGER content_asset_versions_disciplined_trigger'));
  assert.ok(sql.includes('CREATE TRIGGER content_transformations_disciplined_trigger'));
  // The lifecycle move is draft → materialized ONLY.
  assert.ok(sql.includes("IF NOT (OLD.lifecycle_state = 'draft' AND NEW.lifecycle_state = 'materialized')"));
  // The transformation terminal moves are requested → completed|failed
  // ONLY (terminal rows never reopen).
  assert.ok(sql.includes("(OLD.status = 'requested' AND NEW.status = 'completed')"));
  assert.ok(sql.includes("(OLD.status = 'requested' AND NEW.status = 'failed')"));
  // The scope-chain + same-Client triggers.
  assert.ok(sql.includes('content_assets_scope_chain_trigger'));
  assert.ok(sql.includes('content_asset_versions_scope_trigger'));
  assert.ok(sql.includes('content_asset_versions_evidence_same_client_trigger'));
  assert.ok(sql.includes('content_transformations_scope_chain_trigger'));
  assert.ok(sql.includes('content_transformation_ingredients_same_client_trigger'));
  // The output link is set at completion only and the CAS versions
  // advance with every sanctioned move.
  assert.ok(sql.includes('the content transformation state move must advance the CAS version'));
  assert.ok(sql.includes('the content asset lifecycle move must advance the CAS version'));
});

// ---------------------------------------------------------------------------
// 3. The no-second-engine battery (rule 24 + the MKT-054 cardinal rule)
// ---------------------------------------------------------------------------

test('MKT-064: the module interacts with /executions EXACTLY through the public contract — NO second engine, NO worker plane, NO execution-table write', () => {
  const module = stripComments(assetsModule);
  const store = stripComments(assetsStore);

  // The ONLY executions surface the module touches.
  const executionCalls = [...module.matchAll(/executions\.(createExecution|transitionExecution|getExecution)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual([...new Set(executionCalls)].sort(), ['createExecution', 'getExecution', 'transitionExecution']);
  // The module never holds a worker/dispatch/runtime identity of its own.
  for (const forbidden of [
    /WorkerHost/, /worker-host/, /dispatchLoop/, /startWorker/, /claimTask/,
    /runQueue/, /spawnWorker/, /setInterval/,
  ]) {
    assert.ok(!forbidden.test(module), `the module must not implement its own worker plane (${forbidden})`);
    assert.ok(!forbidden.test(store), `the store must not implement its own worker plane (${forbidden})`);
  }
  // No execution table is ever written by the module or the store (the
  // /executions authority stays sole).
  for (const forbidden of [
    /INSERT INTO executions/, /UPDATE executions\b/, /DELETE FROM executions/,
    /INSERT INTO execution_/, /UPDATE execution_\w+/, /DELETE FROM execution_\w+/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write execution tables (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write execution tables (${forbidden})`);
  }
  // The engine registry is MODULE DATA (deps), never a module-internal
  // discovery, never a hardcoded provider.
  assert.ok(assetsPublic.includes('readonly engines: readonly TransformationEngine[]'));
  assert.ok(module.includes('deps.engines'));
});

test('MKT-064: the composition root registers NO engine by default (the MKT-056 discipline) and the doubles are re-exported through the public entry', () => {
  const root = stripComments(compositionRoot);
  // The options seam exists and defaults to EMPTY.
  assert.ok(root.includes('contentTransformationEngines'));
  assert.ok(root.includes('engines: options.contentTransformationEngines ?? []'));
  // The composition root does NOT construct any first-party double for
  // production (the doubles are test-only, supplied through the seam).
  for (const forbidden of ['createPassthroughTransformationEngine', 'createFormatTransformationEngine', 'createCropTransformationEngine']) {
    assert.ok(!root.includes(forbidden), `the production composition must not register the engine double ${forbidden}`);
  }
  // The public entry re-exports the doubles (the 063 validation-guard
  // re-export precedent — tests and the composition root construct them
  // without touching module internals).
  assert.ok(assetsPublic.includes('createPassthroughTransformationEngine'));
  assert.ok(assetsPublic.includes('createFormatTransformationEngine'));
  assert.ok(assetsPublic.includes('createCropTransformationEngine'));
  // The doubles live behind the real port contract and declare their
  // effects + constraints (architecture-v1.6.md §10: "Each
  // transformation declares expected effects and constraints").
  for (const declaration of ['declaredEffects', 'declaredConstraints', 'executionKind', 'supportedKinds']) {
    assert.ok(assetsEngines.includes(declaration), `the engine doubles declare ${declaration}`);
  }
});

// ---------------------------------------------------------------------------
// 4. The boundary-rule-5 battery (no rights authority)
// ---------------------------------------------------------------------------

test('MKT-064: the module interacts with /content-rights EXACTLY through recordLineageLink — NO gate, NO registration, NO transition, NO rights-table write', () => {
  const module = stripComments(assetsModule);
  const store = stripComments(assetsStore);

  // The ONLY /content-rights surface the module touches (the
  // derivation-seam bookkeeping).
  const rightsCalls = [...module.matchAll(/contentRights\.(recordLineageLink|evaluatePublicationGate|registerContentRights|recordRightsTransition|recordPlatformPermission|getRightsRecord\w*)/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual([...new Set(rightsCalls)], ['recordLineageLink']);
  // No rights table is ever written by the module or the store.
  for (const forbidden of [
    /INSERT INTO content_rights/, /UPDATE content_rights\w*/, /DELETE FROM content_rights/,
  ]) {
    assert.ok(!forbidden.test(store), `the store must not write rights tables (${forbidden})`);
    assert.ok(!forbidden.test(module), `the module must not write rights tables (${forbidden})`);
  }
  // The module never evaluates the gate: transforming an asset NEVER
  // checks rights (the 063 gate stays the sole rights authority —
  // blocked ingredients are transformable but unpublishable).
  assert.ok(!module.includes('evaluatePublicationGate'));
  assert.ok(!assetsRoutes.includes('evaluatePublicationGate'));
  // The route surface carries NO rights-mutating verb.
  for (const forbidden of ['/content-rights', 'registerContentRights', 'recordRightsTransition', 'recordPlatformPermission']) {
    assert.ok(!stripComments(assetsRoutes).includes(forbidden), `the content-assets routes carry no rights verb (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 5. The lineage-immutability battery (rule 23)
// ---------------------------------------------------------------------------

test('MKT-064: derived assets are BORN with lineage — ingredient links frozen at request, the output link set ONCE, derived is a birth state', () => {
  const module = stripComments(assetsModule);
  const sql = stripSqlComments(migration053);

  // The output version is created 'derived' WITH its object and its
  // lineage in the completion transaction (the STORE insert — the
  // derived birth is executable code, not prose).
  const store = stripComments(assetsStore);
  assert.ok(store.includes("'derived'"));
  assert.ok(module.includes('recordLineageLink'));
  // The ingredient links freeze the resolved versions at request time
  // (the explicit (asset, version) resolution).
  assert.ok(module.includes('getAssetVersionByNumber'));
  // The refs frozen in the ingredient rows (the 063 conjunction
  // vocabulary).
  assert.ok(sql.includes('input_asset_ref'));
  // The derived version is never mutated into existence: the ONLY legal
  // lifecycle move is draft → materialized (asserted above), and the
  // provenance shape CHECK forbids the /evidence anchor on derived rows
  // (the recorded transformation IS the provenance).
  assert.ok(sql.includes("(lifecycle_state = 'derived' AND source_evidence_ref IS NULL)"));
  // The output link is set ONCE at completion (the disciplined terminal
  // moves asserted above; the completion is one transaction).
  assert.ok(module.includes('completeTransformation'));
  assert.ok(store.includes("status = 'completed', output_version_id"));
});

// ---------------------------------------------------------------------------
// 6. The route surface is EXACTLY the frozen set
// ---------------------------------------------------------------------------

test('MKT-064: the route surface is EXACTLY the frozen ten (GET/POST only; literal segments BEFORE the :versionId patterns)', () => {
  const routes = stripComments(assetsRoutes);
  const registered = [...assetsRoutes.matchAll(/router\.add\(\s*'(\w+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(registered, [
    'POST /api/clients/:clientId/content-assets',
    'GET /api/clients/:clientId/content-assets',
    'GET /api/clients/:clientId/content-assets/by-ref/:assetRef',
    'POST /api/clients/:clientId/content-assets/transformations',
    'GET /api/clients/:clientId/content-assets/transformations',
    'GET /api/clients/:clientId/content-assets/transformations/:transformationId',
    'POST /api/clients/:clientId/content-assets/transformations/:transformationId/execute',
    'GET /api/clients/:clientId/content-assets/:versionId',
    'POST /api/clients/:clientId/content-assets/:versionId/materialize',
    'POST /api/clients/:clientId/content-assets/:versionId/observations',
  ]);
  // The literal segments sit BEFORE the :versionId patterns
  // (first-match-wins — the content-rights precedent).
  const literals = registered
    .filter((route) => !route.includes(':versionId'))
    .map((route) => route.split(' ')[1]!);
  const firstVersionPattern = registered.findIndex((route) => route.includes(':versionId'));
  for (const literal of literals) {
    assert.ok(registered.findIndex((route) => route.endsWith(literal)) < firstVersionPattern);
  }
  // NO update route (version records are immutable), NO delete route
  // (history is append-only) and NO engine-registry route.
  for (const forbidden of [/router\.add\(\s*'(PUT|PATCH|DELETE)'/, /engines\b.*router\.add/]) {
    assert.ok(!forbidden.test(assetsRoutes), `no engine-registry or mutation route may exist (${forbidden})`);
  }
  // The evidence anchor resolves canonically at the route layer (the
  // /app-metering precedent — /evidence is not a frozen allowance of
  // this row).
  assert.ok(routes.includes('requireEvidenceInClient'));
  assert.ok(routes.includes('modules.evidence.getEvidence'));
  // The floating-version rejection at the route surface: the ingredient
  // DTO cannot even express a missing version.
  assert.ok(assetsRoutes.includes('The EXPLICIT version'));
});

// ---------------------------------------------------------------------------
// 7. The dependency posture (arch-check on the REAL codebase)
// ---------------------------------------------------------------------------

test('MKT-064: the real codebase enforces the frozen boundaries — zero violations, the module public imports only the matrix-listed publics', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen matrix row is parsed from the spec docs (the DISCLOSED
  // module-importable subset; /object-storage is the platform port
  // direction — no matrix weight).
  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(modules.includes('content-assets'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['content-assets'], ['executions', 'content-rights']);

  // The module public imports exactly the matrix-listed module publics
  // and platform contracts.
  const publicImports = [...assetsPublic.matchAll(/from '\.\.\/\.\.\/([a-z/-]+)\/|from '\.\.\/([a-z-]+)\/public\.ts'/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    ['content-rights', 'executions', 'platform/clock', 'platform/db', 'platform/ids', 'platform/objects'].sort(),
  );

  // The application surface carries the module (the shared-file
  // registration — the composition root constructs it).
  assert.ok(applicationTs.includes('contentAssets: ContentAssetsModuleApi'));
  assert.ok(compositionRoot.includes('createContentAssetsModule'));
  assert.ok(
    compositionRoot.includes('const contentAssets = createContentAssetsModule({'),
    'the composition root constructs the content-assets module',
  );
});

// ---------------------------------------------------------------------------
// 8. The disclosed spec registration
// ---------------------------------------------------------------------------

test('MKT-064: the disclosed spec registration exists (the §6 line + sentence, the matrix row + bullet, the migration position)', () => {
  // §6 module list line.
  assert.ok(/^\/content-assets$/m.test(architectureSpec));
  // §6 registration sentence.
  assert.ok(architectureSpec.includes('`/content-assets` is the v1.6 Content Asset and Transformation Authority'));
  // The matrix row (the DISCLOSED module-importable subset).
  assert.ok(matrixSpec.includes('/content-assets ──→ /executions, /content-rights'));
  // The authority bullet.
  assert.ok(matrixSpec.includes('- `/content-assets` is the v1.6 Content Asset and Transformation Authority'));
  // The object-storage platform-port disclosure.
  assert.ok(matrixSpec.includes('the /object-storage direction of the frozen v1.6 row as the PLATFORM ObjectStore port'));

  // 053 holds its numeric position at the END of the ordered
  // expected-migration list in the infra-adapters architecture test
  // (the merged-tree tail: 052_growth_operator sits between 053 and 051).
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const expectedListMatch = infraAdapters.match(/assert\.deepEqual\(migrations, \[([\s\S]*?)\]\);/);
  assert.ok(expectedListMatch !== null, 'the expected-migration list must exist');
  const listEntries = [...expectedListMatch[1]!.matchAll(/'(\d{3}_[a-z_]+\.sql)'/g)].map((m) => m[1]!);
  // The MKT-067 /experiment-analysis sibling delivery appends 054 after
  // 053 (the same additive precedent — the merged-tree tail: 053 now
  // holds position -2, 052 between it and 051).
  assert.equal(listEntries[listEntries.length - 1], '054_experiment_analysis.sql');
  assert.equal(listEntries[listEntries.length - 2], '053_content_assets.sql');
  assert.equal(listEntries[listEntries.length - 4], '051_content_rights.sql');

  // The migration file exists.
  assert.ok(existsSync(src('platform', 'db', 'migrations', '053_content_assets.sql')));
});

// ---------------------------------------------------------------------------
// 9. The 063 seam completion (the mutual registration)
// ---------------------------------------------------------------------------

test('MKT-064: the 063 seam is COMPLETE — the row on both sides, the typed port satisfied, the ref grammar shared', async () => {
  // The /content-rights row now lists /content-assets (the module
  // exists on BOTH sides of the seam — the mutual registration).
  assert.ok(matrixSpec.includes('/content-rights ──→ /evidence, /policies, /content-assets'));
  assert.ok(matrixSpec.includes('`/content-assets` joined the row at MKT-064 time'));
  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['content-rights'], ['evidence', 'policies', 'content-assets']);

  // The module public exports the ContentAssetReferencePort factory —
  // the typed seam /content-rights declared, now satisfied by the real
  // module (verified live: the factory's port resolves refs through the
  // module's own records).
  assert.ok(assetsPublic.includes('createContentAssetReferencePort'));
  assert.ok(assetsPublic.includes('the OTHER side of the seam'));

  // The minted refs satisfy the 063 migration-051 grammar (the interop
  // contract, verified against the actual 051 CHECK text).
  assert.ok(migration051.includes("content_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'"));
  const minted = mintContentAssetRef('0b6bd3a6-1f2a-4c3d-9e8f-0a1b2c3d4e5f');
  assert.match(minted, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);

  // The typed-port conformance is executable: the factory returns a
  // port whose resolution shape matches the 063 declaration exactly.
  const port = createContentAssetReferencePort({
    resolveAssetRef: async () => null,
  } as never);
  const resolved = await port.resolveContentAssetRef('client', minted);
  assert.deepEqual(resolved, { exists: false });
});

// ---------------------------------------------------------------------------
// 10. The frozen vocabularies are the module contract (mirror test)
// ---------------------------------------------------------------------------

test('MKT-064: the module vocabularies are frozen and versioned (ca-vocab-v1)', () => {
  assert.equal(CONTENT_ASSETS_VOCABULARY_VERSION, 'ca-vocab-v1');
  assert.deepEqual(TRANSFORMATION_KINDS, [
    'crop', 'reframe', 'padding', 'compilation', 'clip',
    'caption', 'voice', 'translation', 'format',
  ]);
  assert.deepEqual(CONTENT_MEDIA_KINDS, ['video', 'audio', 'image', 'text', 'document']);
  assert.deepEqual(CONTENT_ASSET_LIFECYCLE_STATES, ['draft', 'materialized', 'derived']);
  assert.deepEqual(CONTENT_ASSET_LIFECYCLE_EVENT_KINDS, ['registration', 'materialization', 'derivation']);
  assert.deepEqual(CONTENT_TRANSFORMATION_STATUSES, ['requested', 'completed', 'failed']);
  assert.deepEqual(CONTENT_QUALITY_METRICS, [
    'duration_ms', 'width_px', 'height_px', 'bitrate_kbps',
    'caption_coverage_ratio', 'language', 'fps', 'sample_rate_hz', 'byte_size',
  ]);
  // The guard module and the engine doubles exist as module structure.
  assert.ok(existsSync(src('modules', 'content-assets', 'internal', 'validation.ts')));
  assert.ok(existsSync(src('modules', 'content-assets', 'internal', 'engines', 'transformation-engines.ts')));
  assert.ok(stripComments(assetsValidation).includes('assertValidQualityObservationInput'));
});
