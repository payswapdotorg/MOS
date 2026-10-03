/**
 * LAB-003 boundary tests — the static architectural proofs of
 * /lab-features (the /lab-corpus + /lab-agent-body boundary
 * precedent, applied to the v1.7 Multimodal Content Feature Bundle):
 *
 *   1. THE NO-FABRICATION / NO-MEDIA-RETENTION DISCIPLINE (§4/§5):
 *      the migration owns EXACTLY its three lab_feature_* tables with
 *      NO binary column anywhere (media bytes are structurally
 *      inexpressible as durable state — they ride an in-memory handle
 *      through the extraction call only), the CHECK-fenced closed
 *      vocabularies (the 7-reason failure vocabulary, the outcome/
 *      skip vocabularies, the availability/posture echoes, the
 *      27-key feature accounting fence) and the append-only guard
 *      triggers (bundles + item outcomes append-only outright; runs
 *      born running with the single completion advance);
 *   2. THE BY-REFERENCE CORPUS DISCIPLINE: the FK anchors are EXACTLY
 *      the tenant tables + same-module rows — NO foreign key into
 *      /lab, /lab-corpus or ANY v1.6 authority table; the module code
 *      issues NO SQL against any lab_corpus_* table (the corpus
 *      advance seam stays the /lab-corpus module's own guarded
 *      column — DISCLOSED, deliberately not implemented here);
 *   3. the module structure (public.ts + internal/ only) and the
 *      empty cross-module import set (the /lab family discipline);
 *   4. the registration: the granted worker spec append (the §6 line
 *      + the registration paragraph — the MKT-066 platform-health
 *      precedent, NO checker provision: the provision mechanism is
 *      structurally for spec-pending modules only), the composition
 *      root wiring (the first-party extractor + the pending media
 *      fetch port as the two replaceable Lab ports) and the
 *      ApplicationModules entry;
 *   5. the migration tail: 065_lab_features.sql is the tail (062
 *      reserved for the parallel MKT-072 worker, 064 held by the
 *      in-flight STUDIO-001 delivery — the TL reconciles at merge);
 *   6. the deterministic identity function is part of the frozen
 *      public surface (the reproducible-identity acceptance).
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

const moduleDir = src('modules', 'lab-features');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '065_lab_features.sql'));
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

test('LAB-003 AC: the module owns EXACTLY its three migration-065 tables — no authority table, no /lab table, no /lab-corpus table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...created].sort(), ['lab_feature_batch_items', 'lab_feature_batch_runs', 'lab_feature_bundles']);
  // The FK anchors are EXACTLY the tenant tables + same-module rows.
  const references = [...stripSqlComments(migrationSql).matchAll(/REFERENCES\s+([a-z_]+)/g)].map((match) => match[1]!);
  for (const target of references) {
    assert.ok(
      ['agencies', 'clients', 'workspaces', 'lab_feature_batch_runs', 'lab_feature_bundles'].includes(target),
      `unexpected FK anchor '${target}' — the FK anchors must be tenant tables + same-module rows only`,
    );
  }
  // NO foreign key into any /lab, /lab-corpus or v1.6 authority table.
  for (const forbidden of [
    'REFERENCES lab_corpus_',
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

test('LAB-003 AC: NO media bytes anywhere — no binary column, no payload column, the bytea-free structural proof', () => {
  const sql = stripSqlComments(migrationSql);
  for (const forbidden of ['bytea', 'binary', 'blob', 'large object', 'lo_']) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `the migration must not contain any binary type ('${forbidden}')`);
  }
  // The only structured payload columns are the feature value map + the
  // bounded text detail columns (derived representations + identity only).
  const jsonbColumns = [...sql.matchAll(/(\w+)\s+jsonb/g)].map((match) => match[1]!);
  assert.deepEqual(jsonbColumns, ['features']);
  // The module code has no byte-bearing surface either (no base64
  // media decode, no buffer persistence).
  const code = stripComments(moduleCode);
  for (const forbidden of ['Buffer.from(', 'toByteArray', 'writeFile', 'bytea']) {
    assert.ok(!code.includes(forbidden), `the module code must not touch byte persistence ('${forbidden}')`);
  }
});

test('LAB-003 AC: the CHECK-fenced closed vocabularies + the append-only guard triggers (the failure-states acceptance)', () => {
  const sql = migrationSql;
  // The closed failure vocabulary (verbatim, all seven).
  for (const reason of [
    "'media_unavailable'",
    "'rights_not_permitted'",
    "'unsupported_modality'",
    "'extraction_error'",
    "'encoder_unavailable'",
    "'invalid_input'",
    "'scope_mismatch'",
  ]) {
    assert.ok(sql.includes(reason), `the closed failure vocabulary must be CHECK-fenced ('${reason}')`);
  }
  // The outcome + skip vocabularies.
  assert.ok(sql.includes("CHECK (outcome IN ('extracted', 'failed', 'skipped'))"), 'the per-item outcome vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'duplicate_citation_in_batch'"), 'the closed skip vocabulary is CHECK-fenced');
  assert.ok(sql.includes("'already_extracted'"), 'the closed skip vocabulary is CHECK-fenced');
  // The availability/posture echoes (the /lab-corpus closed sets as recorded data).
  for (const availability of ["'unknown'", "'available_permitted'", "'available_rights_unclear'", "'provider_unavailable'", "'withdrawn'"]) {
    assert.ok(sql.includes(availability), `the closed availability echo vocabulary is CHECK-fenced ('${availability}')`);
  }
  assert.ok(sql.includes("'metadata_only'") && sql.includes("'reference_gated'"), 'the closed posture vocabulary is CHECK-fenced');
  // The deterministic-identity fences.
  assert.ok(sql.includes("CHECK (identity_digest ~ '^[0-9a-f]{64}$')"), 'the identity digest shape is CHECK-fenced');
  assert.ok(sql.includes('CONSTRAINT lab_feature_bundles_identity UNIQUE (client_id, identity_digest)'), 'the deterministic identity is the idempotence fence');
  assert.ok(sql.includes('CONSTRAINT lab_feature_bundles_chain UNIQUE (client_id, reference_id, bundle_version)'), 'the per-reference append-only version chain is UNIQUE-fenced');
  // The 27-key feature accounting fence.
  assert.ok(sql.includes('CHECK (derived_feature_count + unavailable_feature_count = 27)'), 'the closed feature-set accounting is CHECK-fenced');
  // The never-asserted-separately run-count fence is STATUS-CONDITIONAL:
  // a run is born 'running' with all counts honestly zero (nothing is
  // computed yet); the single completion update SQL-computes them from
  // the item outcome rows, and at 'completed' the arithmetic is pinned
  // to the batch size.
  assert.ok(
    sql.includes("status = 'running' AND extracted_count = 0 AND failed_count = 0 AND skipped_count = 0"),
    'a born-running run carries honestly-zero summary counts',
  );
  assert.ok(
    sql.includes("status = 'completed' AND extracted_count + failed_count + skipped_count = item_count"),
    'the completed-run summary counts are CHECK-fenced to the batch size',
  );
  // The append-only discipline: bundles + items outright; runs guarded.
  assert.ok(sql.includes('lab_feature_bundles_no_update_trigger'), 'bundles reject UPDATE outright');
  assert.ok(sql.includes('lab_feature_bundles_no_delete_trigger'), 'bundles reject DELETE outright');
  assert.ok(sql.includes('lab_feature_items_no_update_trigger'), 'item outcomes reject UPDATE outright');
  assert.ok(sql.includes('lab_feature_items_no_delete_trigger'), 'item outcomes reject DELETE outright');
  assert.ok(sql.includes('lab_feature_run_guard'), 'the run guard trigger enforces the single completion advance');
  assert.ok(sql.includes('lab_feature_bundle_scope_check'), 'the bundle→run scope-consistency trigger exists');
  assert.ok(sql.includes('lab_feature_item_scope_check'), 'the item→run/bundle scope-consistency triggers exist');
});

test('LAB-003 AC: THE CORPUS ADVANCE SEAM IS NOT IMPLEMENTED — the module writes NO /lab-corpus table (the by-reference discipline)', () => {
  const code = stripComments(moduleCode);
  for (const forbidden of [
    'lab_corpus_versions',
    'lab_corpus_references',
    'lab_corpus_observations',
    'feature_bundle_version',
    'updateReference',
  ]) {
    assert.ok(!code.includes(forbidden), `the module must not touch the /lab-corpus seam ('${forbidden}' found)`);
  }
  // The bundles CARRY everything the TL integration needs: the citable
  // bundle reference helper + the per-reference chain read are the
  // public surface (produced here; the advance is the TL's decision).
  assert.ok(publicTs.includes('labFeaturesBundleReference'), 'the citable bundle reference is part of the public surface');
  assert.ok(publicTs.includes('listBundles(scope: LabFeaturesScope, referenceId: string)'), 'the per-reference bundle chain read is the corpus-advance seam surface');
  assert.ok(publicTs.includes("advance path itself is the Tech Lead's composition decision"), 'the disclosure is recorded on the public surface');
});

test('LAB-003 AC: the module imports NO other module — the /lab family discipline (zero cross-module imports; the two Lab ports are the composition-root wiring)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The static checker enforces it with zero violations (54 enforced
  // modules: 53 spec-parsed — the granted LAB-003 worker spec
  // registration, the MKT-066 platform-health precedent — + the
  // single /apps provision; NO lab-features checker provision exists:
  // the provision mechanism is structurally for spec-pending modules
  // only).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('lab-features'));
  assert.equal(result.frozenModules.length, 54);
});

test('LAB-003 AC: the registration — the granted worker spec append + the composition-root wiring + the ApplicationModules entry', () => {
  // The §6 module list line + the registration paragraph (the MKT-066
  // platform-health registration precedent — the ONE spec exception
  // the Tech Lead granted this delivery).
  const moduleListMatch = architectureMd.match(/## 6\. Core domain modules\s*```text([\s\S]*?)```/);
  assert.ok(moduleListMatch !== null);
  assert.ok(
    /^\s*\/lab-features\s*$/m.test(moduleListMatch[1]!),
    'spec/architecture.md §6 carries the /lab-features module list line',
  );
  assert.ok(architectureMd.includes('`/lab-features` is the v1.7 Multimodal Content Feature Bundle authority'), 'the §6 registration paragraph is present');
  // The composition root: the import + the wiring with the two
  // replaceable Lab ports + the modules-map tail.
  assert.ok(compositionRoot.includes("from './modules/lab-features/public.ts'"), 'the composition root imports the module public entry');
  assert.ok(compositionRoot.includes('const labFeatures = createLabFeaturesModule({'), 'the composition root wires the module');
  assert.ok(compositionRoot.includes('extractor: createFirstPartyLabFeatureExtractor(),'), 'the first-party extractor is the wired port');
  assert.ok(compositionRoot.includes('mediaFetch: createPendingLabMediaFetchPort(),'), 'the pending media-fetch port is the wired port');
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, labFeatures }'), 'the modules map carries the entry');
  // ApplicationModules.
  assert.ok(applicationTs.includes("from '../modules/lab-features/public.ts'"), 'application.ts imports the public contract');
  assert.ok(applicationTs.includes('readonly labFeatures: LabFeaturesModuleApi;'), 'ApplicationModules carries the entry');
});

test('LAB-003 AC: the migration tail — 065_lab_features.sql after 063 (062 reserved for the parallel MKT-072 worker, 064 held by the in-flight STUDIO-001)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrations.includes('065_lab_features.sql'));
  assert.equal(migrations[migrations.length - 1], '065_lab_features.sql');
  assert.equal(migrations[migrations.length - 2], '063_lab_agent_body.sql');
  assert.equal(migrations[migrations.length - 3], '061_lab_corpus.sql');
  assert.ok(!migrations.includes('062_commerce_discovery.sql'), '062 stays reserved for the parallel worker (not taken here)');
  assert.ok(!migrations.some((name) => name.startsWith('064_')), '064 stays reserved for the in-flight STUDIO-001 (not taken here)');
  // The module boundary is complete.
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const file of moduleFiles) {
    assert.ok(file.endsWith('.ts'), `the internal implementation files are TypeScript ('${file}')`);
  }
});

test('LAB-003 AC: the reproducible-identity function is part of the frozen public surface (the deterministic pure functions)', () => {
  assert.ok(publicTs.includes('computeLabFeatureIdentityDigest'), 'the identity derivation is exported');
  assert.ok(publicTs.includes('computeLabFeatureInputDigest'), 'the input digest derivation is exported');
  assert.ok(publicTs.includes('assertValidLabFeatureValueMap'), 'the NEVER-FABRICATE value-map guard is exported');
  assert.ok(publicTs.includes('LAB_FEATURE_KEYS'), 'the closed feature-key vocabulary is exported');
  assert.ok(publicTs.includes("LAB_FEATURES_CONTRACT_VERSION = 'lab-features-contract-v1'"), 'the contract identity is pinned');
  assert.ok(publicTs.includes("LAB_FEATURE_SET_VERSION = 'lab-featureset-v1'"), 'the feature-set version is pinned');
  // The §5 honest-unavailable discipline is vocabulary-fenced: no
  // 'pending' value state exists at the bundle level (the explicit
  // unavailable state + closed reason; the corpus-side 'pending'
  // sentinel stays LAB-002's own column state).
  assert.ok(publicTs.includes("LAB_FEATURE_VALUE_STATES = ['derived', 'unavailable'] as const"));
});
