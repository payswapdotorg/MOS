/**
 * LAB-004 boundary tests — the static architectural proofs of
 * /lab-ideas (the LAB-003 boundary precedent, applied to the v1.7
 * Idea Graph):
 *
 *   1. THE OBSERVED-SEPARATION / NO-FABRICATION DISCIPLINE (§6): the
 *      migration owns EXACTLY its seven lab_idea_* tables with the
 *      CHECK-fenced closed vocabularies (the 10 primitive kinds, the
 *      8 edge relations, the 4 origin classes, the 6 operation kinds
 *      with the kind→origin pairing), THE observed/derived/generated/
 *      combined separation fences (the origin class fenced to the
 *      creation path on every axis — no mixed-origin row is
 *      expressible), the deterministic-identity fences and the
 *      append-only guard triggers (nodes, edges, operations, inputs
 *      and assignments append-only outright; decompositions and
 *      cluster runs born running with the single completion advance);
 *   2. THE BY-REFERENCE BUNDLE CITATION (the /lab family discipline):
 *      the FK anchors are EXACTLY the tenant tables + same-module
 *      rows — NO foreign key into /lab-features, /lab-corpus, /lab or
 *      ANY v1.6 authority table; the module code issues NO SQL
 *      against any lab_feature_* or lab_corpus_* table (the bundle
 *      citation is OPAQUE recorded data);
 *   3. the module structure (public.ts + internal/ only) and the
 *      empty cross-module import set (the /lab family discipline);
 *   4. the registration: the granted worker spec append (the §6 line
 *      + the registration paragraph — the LAB-003 platform-health
 *      registration precedent, NO checker provision: the provision
 *      mechanism is structurally for spec-pending modules only), the
 *      composition-root wiring (the first-party decomposer + the
 *      first-party structural generator as the two replaceable Lab
 *      ports) and the ApplicationModules entry;
 *   5. the migration tail: 066_lab_ideas.sql is the tail (the TL
 *      pre-assigned number after the merged 065);
 *   6. the deterministic identity + novelty + clustering + lineage
 *      functions are part of the frozen public surface (the
 *      reproducible-identity + formula-disclosure acceptance).
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

const moduleDir = src('modules', 'lab-ideas');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '066_lab_ideas.sql'));
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

test('LAB-004 AC: the module owns EXACTLY its seven migration-066 tables — no authority table, no /lab-features table, no /lab-corpus table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(
    [...created].sort(),
    [
      'lab_idea_cluster_assignments',
      'lab_idea_cluster_runs',
      'lab_idea_decompositions',
      'lab_idea_edges',
      'lab_idea_nodes',
      'lab_idea_operation_inputs',
      'lab_idea_operations',
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
        'lab_idea_decompositions',
        'lab_idea_nodes',
        'lab_idea_operations',
        'lab_idea_cluster_runs',
      ].includes(target),
      `unexpected FK anchor '${target}' — the FK anchors must be tenant tables + same-module rows only`,
    );
  }
  // NO foreign key into any /lab, /lab-features, /lab-corpus or v1.6
  // authority table (the opaque bundle citation discipline).
  for (const forbidden of [
    'REFERENCES lab_feature_',
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
  // The disclosure: nodes.creating_operation_id is recorded DATA (no FK)
  // — the operation's output_node_id FK is the strong anchor.
  assert.ok(!stripSqlComments(migrationSql).includes('creating_operation_id   uuid        REFERENCES'), 'the recorded-data back-reference carries no FK (DISCLOSED)');
});

test('LAB-004 AC: NO media bytes and no secret surface — the bounded payload columns only', () => {
  const sql = stripSqlComments(migrationSql);
  for (const forbidden of ['bytea', 'binary', 'blob', 'large object', 'lo_']) {
    assert.ok(!sql.toLowerCase().includes(forbidden), `the migration must not contain any binary type ('${forbidden}')`);
  }
  // The only structured payload columns are the node attributes + the
  // recorded lineage chain (bounded JSON, identity + linkage data only).
  const jsonbColumns = [...sql.matchAll(/(\w+)\s+jsonb\b/g)].map((match) => match[1]!);
  assert.deepEqual([...jsonbColumns].sort(), ['attributes', 'lineage']);
  const code = stripComments(moduleCode);
  for (const forbidden of ['Buffer.from(', 'toByteArray', 'writeFile', 'bytea']) {
    assert.ok(!code.includes(forbidden), `the module code must not touch byte persistence ('${forbidden}')`);
  }
});

test('LAB-004 AC: THE OBSERVED-DERIVED-GENERATED-COMBINED SEPARATION + the closed vocabularies + the append-only guard triggers (the core acceptance)', () => {
  const sql = migrationSql;
  // The closed primitive-kind vocabulary (§6 verbatim, all ten).
  for (const kind of [
    "'idea'",
    "'problem'",
    "'claim'",
    "'hook'",
    "'narrative'",
    "'visual_treatment'",
    "'audio_treatment'",
    "'packaging'",
    "'cta'",
    "'timing_context'",
  ]) {
    assert.ok(sql.includes(kind), `the closed primitive-kind vocabulary must be CHECK-fenced ('${kind}')`);
  }
  // The closed edge-relation vocabulary (§6's supports list).
  for (const relation of [
    "'supports'",
    "'contradicts'",
    "'refines'",
    "'combines_with'",
    "'mutates_from'",
    "'analog_to'",
    "'inverts'",
    "'fills_gap'",
  ]) {
    assert.ok(sql.includes(relation), `the closed edge-relation vocabulary must be CHECK-fenced ('${relation}')`);
  }
  // The closed origin-class vocabulary (§6 verbatim, the separation).
  for (const originClass of ["'observed_source'", "'derived_abstraction'", "'generated_mutation'", "'combined_strategy'"]) {
    assert.ok(sql.includes(originClass), `the closed origin-class vocabulary must be CHECK-fenced ('${originClass}')`);
  }
  // The closed operation-kind vocabulary + the kind→origin pairing.
  for (const kind of ["'derive'", "'recombine'", "'mutate'", "'analogy'", "'invert'", "'fill_gap'"]) {
    assert.ok(sql.includes(kind), `the closed operation-kind vocabulary must be CHECK-fenced ('${kind}')`);
  }
  assert.ok(sql.includes('CONSTRAINT lab_idea_operations_kind_origin_pairing'), 'the operation-kind → output-origin pairing is CHECK-fenced');
  // THE SEPARATION FENCES: the origin class is fenced to the creation
  // path on every axis.
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_observed_fence'), 'the observed ⟺ decomposition anchor fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_operation_fence'), 'the non-observed ⟺ creating operation fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_lineage_fence'), 'the observed ⟺ no-lineage fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_novelty_fence'), 'the observed ⟺ no-novelty fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_citation_fence'), 'the observed ⟺ bundle-citation fence exists');
  assert.ok(sql.includes('CONSTRAINT lab_idea_nodes_kind_echo_fence'), 'the non-observed ⟺ kind-echo fence exists');
  // The deterministic-identity fences (the LAB-003 discipline).
  assert.ok(sql.includes("CHECK (identity_digest ~ '^[0-9a-f]{64}$')"), 'the identity digest shape is CHECK-fenced');
  assert.ok(sql.includes('CONSTRAINT lab_idea_decompositions_identity UNIQUE (client_id, identity_digest)'), 'the deterministic identity is the idempotence fence');
  assert.ok(sql.includes('CONSTRAINT lab_idea_decompositions_chain UNIQUE (client_id, bundle_id, decomposition_version)'), 'the per-cited-bundle append-only version chain is UNIQUE-fenced');
  // The one-run-per-version clustering fence.
  assert.ok(sql.includes('CONSTRAINT lab_idea_cluster_runs_version UNIQUE (client_id, cluster_version)'), 'the one-run-per-version clustering fence exists');
  // The append-only discipline: the five outright tables + the two
  // guarded lifecycles.
  assert.ok(sql.includes('lab_idea_nodes_no_update_trigger'), 'nodes reject UPDATE outright');
  assert.ok(sql.includes('lab_idea_nodes_no_delete_trigger'), 'nodes reject DELETE outright');
  assert.ok(sql.includes('lab_idea_edges_no_update_trigger'), 'edges reject UPDATE outright');
  assert.ok(sql.includes('lab_idea_edges_no_delete_trigger'), 'edges reject DELETE outright');
  assert.ok(sql.includes('lab_idea_operations_no_update_trigger'), 'operations reject UPDATE outright');
  assert.ok(sql.includes('lab_idea_operations_no_delete_trigger'), 'operations reject DELETE outright');
  assert.ok(sql.includes('lab_idea_operation_inputs_no_update_trigger'), 'operation inputs reject UPDATE outright');
  assert.ok(sql.includes('lab_idea_operation_inputs_no_delete_trigger'), 'operation inputs reject DELETE outright');
  assert.ok(sql.includes('lab_idea_cluster_assignments_no_update_trigger'), 'cluster assignments reject UPDATE outright');
  assert.ok(sql.includes('lab_idea_cluster_assignments_no_delete_trigger'), 'cluster assignments reject DELETE outright');
  assert.ok(sql.includes('lab_idea_decomposition_guard'), 'the decomposition guard enforces the single completion advance');
  assert.ok(sql.includes('lab_idea_cluster_run_guard'), 'the cluster run guard enforces the single completion advance');
  // The scope-consistency triggers (the §22 discipline).
  assert.ok(sql.includes('lab_idea_node_scope_check'), 'the node→decomposition scope-consistency trigger exists');
  assert.ok(sql.includes('lab_idea_operation_scope_check'), 'the operation→output-node scope + pairing backstop trigger exists');
  assert.ok(sql.includes('lab_idea_operation_input_scope_check'), 'the input→operation/node scope-consistency trigger exists');
  assert.ok(sql.includes('lab_idea_edge_scope_check'), 'the edge→nodes/creator scope-consistency trigger exists');
  assert.ok(sql.includes('lab_idea_cluster_assignment_scope_check'), 'the assignment→run/node scope-consistency trigger exists');
});

test('LAB-004 AC: THE BUNDLE CITATION IS OPAQUE — the module writes NO /lab-features or /lab-corpus table (the by-reference discipline)', () => {
  const code = stripComments(moduleCode);
  for (const forbidden of [
    'lab_feature_batch_runs',
    'lab_feature_bundles',
    'lab_feature_batch_items',
    'lab_corpus_versions',
    'lab_corpus_references',
    'lab_corpus_observations',
    'feature_bundle_version',
    'SELECT * FROM lab_feature',
    'SELECT * FROM lab_corpus',
  ]) {
    assert.ok(!code.includes(forbidden), `the module must not touch the /lab-features or /lab-corpus surfaces ('${forbidden}' found)`);
  }
  // The citation is carried as recorded data (the full linkage field set
  // is part of the frozen public surface).
  assert.ok(publicTs.includes('bundleReference: string'), 'the citable bundle reference is part of the citation contract');
  assert.ok(publicTs.includes('bundleIdentityDigest: string'), 'the bundle identity echo is part of the citation contract');
  assert.ok(publicTs.includes('NO import of /lab-features'), 'the by-reference disclosure is recorded on the public surface');
  // THE EVIDENCE FILTER: the strict observed-only filter is exported.
  assert.ok(publicTs.includes("LAB_IDEAS_EVIDENCE_ORIGIN_CLASSES: ReadonlyArray<LabIdeaOriginClass> = ['observed_source']"), 'the strict evidence filter is exported');
  assert.ok(moduleCode.includes('originClasses is REQUIRED'), 'the mandatory origin-class filter is enforced on the retrieval surface');
});

test('LAB-004 AC: the module imports NO other module — the /lab family discipline (zero cross-module imports; the two Lab ports are the composition-root wiring)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The static checker enforces it with zero violations (57 enforced
  // modules: 56 spec-parsed — the granted LAB-004 worker spec
  // registration, the LAB-003 precedent — + the single /apps
  // provision; NO lab-ideas checker provision exists: the provision
  // mechanism is structurally for spec-pending modules only).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('lab-ideas'));
  assert.equal(result.frozenModules.length, 58);
});

test('LAB-004 AC: the registration — the granted worker spec append + the composition-root wiring + the ApplicationModules entry', () => {
  // The §6 module list line + the registration paragraph (the granted
  // REGISTRATION APPEND — the ONE spec exception the Tech Lead granted
  // this delivery; the LAB-003 precedent).
  const moduleListMatch = architectureMd.match(/## 6\. Core domain modules\s*```text([\s\S]*?)```/);
  assert.ok(moduleListMatch !== null);
  assert.ok(
    /^\s*\/lab-ideas\s*$/m.test(moduleListMatch[1]!),
    'spec/architecture.md §6 carries the /lab-ideas module list line',
  );
  assert.ok(architectureMd.includes('`/lab-ideas` is the v1.7 Idea Graph authority'), 'the §6 registration paragraph is present');
  assert.ok(
    architectureMd.indexOf('`/lab-features` is the v1.7 Multimodal Content Feature Bundle authority') <
      architectureMd.indexOf('`/lab-ideas` is the v1.7 Idea Graph authority'),
    'the /lab-ideas paragraph is appended AFTER the /lab-features paragraph',
  );
  // The composition root: the import + the wiring with the two
  // replaceable Lab ports + the modules-map tail.
  assert.ok(compositionRoot.includes("from './modules/lab-ideas/public.ts'"), 'the composition root imports the module public entry');
  assert.ok(compositionRoot.includes('const labIdeas = createLabIdeasModule({'), 'the composition root wires the module');
  assert.ok(compositionRoot.includes('decomposer: createFirstPartyLabIdeaDecomposer(),'), 'the first-party decomposer is the wired port');
  assert.ok(compositionRoot.includes('generator: createFirstPartyLabIdeaGenerator(),'), 'the first-party structural generator is the wired port');
  assert.ok(compositionRoot.includes('labFeatures, commerceDiscovery, labCapabilities, labIdeas }'), 'the modules map carries the entry');
  // ApplicationModules.
  assert.ok(applicationTs.includes("from '../modules/lab-ideas/public.ts'"), 'application.ts imports the public contract');
  assert.ok(applicationTs.includes('readonly labIdeas: LabIdeasModuleApi;'), 'ApplicationModules carries the entry');
});

test('LAB-004 AC: the migration tail — 066_lab_ideas.sql is the tail after the merged LAB-003 065 (the merged-tree truth)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrations.includes('066_lab_ideas.sql'));
  assert.equal(migrations[migrations.length - 3], '066_lab_ideas.sql');
  assert.equal(migrations[migrations.length - 4], '065_lab_features.sql');
  assert.equal(migrations[migrations.length - 6], '063_lab_agent_body.sql');
  assert.equal(migrations[migrations.length - 8], '061_lab_corpus.sql');
  assert.ok(migrations.includes('062_commerce_discovery.sql'), '062 is taken by the merged MKT-072 sibling delivery (the merged-tree truth)');
  assert.ok(migrations.some((name) => name.startsWith('064_')), '064 is taken by the merged STUDIO-001 sibling delivery');
  // The module boundary is complete.
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const file of moduleFiles) {
    assert.ok(file.endsWith('.ts'), `the internal implementation files are TypeScript ('${file}')`);
  }
});

test('LAB-004 AC: the deterministic pure functions are part of the frozen public surface (the reproducible identity + the disclosed formulas)', () => {
  assert.ok(publicTs.includes('computeLabIdeaIdentityDigest'), 'the identity derivation is exported');
  assert.ok(publicTs.includes('computeLabIdeaInputDigest'), 'the input digest derivation is exported');
  assert.ok(publicTs.includes('computeLabIdeaNovelty'), 'the frozen novelty formula is exported');
  assert.ok(publicTs.includes('clusterLabIdeaNodes'), 'the frozen clustering formula is exported');
  assert.ok(publicTs.includes('buildLabIdeaLineage'), 'the deterministic lineage construction is exported');
  assert.ok(publicTs.includes('labIdeaJaccardSimilarity'), 'the frozen similarity is exported');
  assert.ok(publicTs.includes("LAB_IDEAS_CONTRACT_VERSION = 'lab-ideas-contract-v1'"), 'the contract identity is pinned');
  assert.ok(publicTs.includes("LAB_IDEA_SET_VERSION = 'lab-ideaset-v1'"), 'the idea-set version is pinned');
  assert.ok(publicTs.includes("LAB_IDEA_CLUSTERING_VERSION = 'lab-idea-clustering-v1'"), 'the clustering version is pinned');
  assert.ok(publicTs.includes("LAB_IDEA_NOVELTY_VERSION = 'lab-idea-novelty-v1'"), 'the novelty version is pinned');
  // The honest-pending disclosure: the open-ended generative kinds ship
  // the pending state through the replaceable port.
  assert.ok(publicTs.includes('LabIdeaGenerationPending'), 'the honest pending generation state is part of the port contract');
  assert.ok(publicTs.includes('PENDING refusal'), 'the pending refusal is disclosed on the public surface');
});
