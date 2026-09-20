/**
 * MKT-069 static tests — the Product Intelligence domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the growth-missions-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-069; spec/architecture-v1.6.md
 * §7/§8 — the primary contract; frozen by
 * spec/module-dependency-matrix-v1.6.md boundary rule 7; the registered
 * matrix row /product-intelligence ──→ /evidence, /integrations,
 * /ai-runtime — the currently-satisfiable subset of the frozen v1.6 row,
 * /research joining at MKT-062 time):
 *   1. migration 048 (the PRE-ASSIGNED number) creates exactly the SIX
 *      product-intelligence tables — OWN tables ONLY, NO
 *      evidence/integration/mission/workflow/execution/experiment/
 *      learning/goal/deployment/tenant table (the composed authorities
 *      stay sole), and the migration's only touches of the agencies /
 *      evidence / clients / integration_connections registries are the
 *      CHECK-ONLY trigger reads + the FK anchors (no INSERT/UPDATE/DELETE
 *      on them);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the seven §8 input
 *      kinds, the two authorization states + the authorization-shape and
 *      per-kind-authorization fences, the nine §8 derivation kinds, the
 *      verification-state vocabulary + the verification-shape fence
 *      (unverified ⟺ zero backing references), the hypothesis-kind
 *      fence, the five risk kinds, the three severities, the ai-pair
 *      shape and the repetition fences;
 *   3. THE APPEND-ONLY BATTERY: the UPDATE/DELETE rejection triggers on
 *      the version tail, the per-version inputs, the source-fact ledger,
 *      the derived-model records and the risk flags; the context-record
 *      mutation guard (identity immutability + exact CAS advance + the
 *      version pointer only ever advances); the same-version source-fact
 *      fence, the same-context fact-citation fences, the same-agency
 *      evidence-citation fences and the unchanged-source fence;
 *   4. THE READ-ONLY INSPECTION BATTERY (boundary rule 7): the fetcher
 *      port declares EXACTLY ONE method (fetch) and NO write method; the
 *      integrations structural port exposes resolveConnectionOwnership +
 *      executeRead ONLY (no mutation surface — the module CANNOT express
 *      an external write); ZERO write-verb/mutation-verb surface exists
 *      anywhere in the module CODE toward an external source; the
 *      documented future write seam exists as a named constant ONLY (no
 *      code path consumes it); NO mission-strategy/planner verbs;
 *   5. DML against the module's OWN tables ONLY (comment-stripped store
 *      scan), zero reads of another module's tables from the module
 *      code, and ZERO imports of any other module under
 *      src/modules/product-intelligence (the structural-port posture —
 *      proven by the real arch-check run in arch-check.test.ts);
 *   6. the ROUTE surface is EXACTLY the ten GET/POST record routes — NO
 *      PUT/PATCH/DELETE anywhere in the family (asserted against the
 *      actual router registrations), and no route names the write seam;
 *   7. the spec registration exists: /product-intelligence in
 *      spec/architecture.md §6 + the matrix row + the authority-notes
 *      bullet in spec/module-dependency-matrix.md; 048_product_intelligence.sql
 *      holds its numeric position in the expected-migration list;
 *   8. the version discipline: the frozen vocabulary version (pi-vocab-v1)
 *      + the read-only inspection capability + the write-seam disclosure
 *      ship on the public contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS,
  PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY,
  PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS,
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_RISK_KINDS,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
  PRODUCT_INTELLIGENCE_VERIFICATION_STATES,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM,
} from '../../src/modules/product-intelligence/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration048 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '048_product_intelligence.sql'));
const piPublic = read(src('modules', 'product-intelligence', 'public.ts'));
const piModule = read(src('modules', 'product-intelligence', 'internal', 'product-intelligence-module.ts'));
const piStore = read(src('modules', 'product-intelligence', 'internal', 'product-intelligence-store.ts'));
const piExtractor = read(src('modules', 'product-intelligence', 'internal', 'extractor.ts'));
const piFetcher = read(src('modules', 'product-intelligence', 'internal', 'http-fetcher.ts'));
const piRoutes = read(src('api', 'product-intelligence-routes.ts'));
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

// ---------------------------------------------------------------------------
// 1. Migration 048: OWN TABLES ONLY, no authority table
// ---------------------------------------------------------------------------

test('MKT-069: migration 048 creates exactly the six product-intelligence tables — OWN tables ONLY (no authority table, no mission state)', () => {
  const created = [...migration048.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'product_contexts',
      'product_context_versions',
      'product_context_inputs',
      'product_source_facts',
      'product_derived_models',
      'product_risk_flags',
    ],
    'own tables ONLY — the durable product/market inspection and model record layer; /evidence (015), /integrations (029), /growth-missions (045), /workflows (009), /executions (011), /experiments (019), /learnings (027), /goals (007) and /deployments (034) stay the sole authorities',
  );

  // The context record's frozen columns.
  const contextColumns = columnsOf(createTableBlock(migration048, 'product_contexts'));
  for (const required of [
    'product_context_id', 'agency_id', 'current_version_seq', 'version',
    'created_actor', 'created_at', 'updated_at',
  ]) {
    assert.ok(contextColumns.includes(required), `product_contexts must carry '${required}'`);
  }
  // The version tail's frozen columns.
  const versionColumns = columnsOf(createTableBlock(migration048, 'product_context_versions'));
  for (const required of [
    'product_context_version_id', 'product_context_id', 'version_seq', 'name', 'summary',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(versionColumns.includes(required), `product_context_versions must carry '${required}'`);
  }
  // The per-version inputs' frozen columns.
  const inputColumns = columnsOf(createTableBlock(migration048, 'product_context_inputs'));
  for (const required of [
    'input_id', 'product_context_version_id', 'input_kind', 'reference',
    'authorization_state', 'authorization_ref', 'notes', 'created_at',
  ]) {
    assert.ok(inputColumns.includes(required), `product_context_inputs must carry '${required}'`);
  }
  // The source-fact ledger's frozen columns (the FULL provenance set, AC-2).
  const factColumns = columnsOf(createTableBlock(migration048, 'product_source_facts'));
  for (const required of [
    'source_fact_id', 'product_context_id', 'product_context_version_id', 'input_id',
    'source_url', 'fetched_at', 'extractor', 'content_hash', 'extraction_notes',
    'observation', 'actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
  ]) {
    assert.ok(factColumns.includes(required), `product_source_facts must carry '${required}'`);
  }
  // The derived-model record's frozen columns (AC-3).
  const derivedColumns = columnsOf(createTableBlock(migration048, 'product_derived_models'));
  for (const required of [
    'derived_model_id', 'product_context_id', 'product_context_version_id', 'derivation_kind',
    'statement', 'detail', 'source_fact_ids', 'evidence_citations',
    'ai_model_identity', 'ai_call_reference', 'verification_state', 'hypothesis',
    'actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
  ]) {
    assert.ok(derivedColumns.includes(required), `product_derived_models must carry '${required}'`);
  }
  // The risk-flag record's frozen columns (AC-4).
  const riskColumns = columnsOf(createTableBlock(migration048, 'product_risk_flags'));
  for (const required of [
    'risk_flag_id', 'product_context_id', 'product_context_version_id', 'risk_kind',
    'severity', 'statement', 'source_fact_ids', 'evidence_citations',
    'ai_model_identity', 'ai_call_reference',
    'actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
  ]) {
    assert.ok(riskColumns.includes(required), `product_risk_flags must carry '${required}'`);
  }

  // The only touches of other authorities' registries are the CHECK-ONLY
  // trigger reads + the FK anchors — no INSERT/UPDATE/DELETE on them.
  const writesOnForeignTables = stripComments(migration048).match(
    /(INSERT INTO|UPDATE|DELETE FROM) (agencies|evidence|clients|integration_connections|goals|growth_missions)\b/g,
  );
  assert.deepEqual(
    writesOnForeignTables,
    null,
    'the migration must never write another authority\'s table (the registries are read CHECK-ONLY + FK anchors)',
  );
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies, CHECK-fenced
// ---------------------------------------------------------------------------

test('MKT-069: the frozen vocabularies are CHECK-fenced in migration 048 and pinned on the public contract', () => {
  // The seven §8 input kinds.
  for (const kind of PRODUCT_INTELLIGENCE_INPUT_KINDS) {
    assert.ok(migration048.includes(`'${kind}'`), `input kind '${kind}' is CHECK-fenced`);
  }
  // The two authorization states + the shape + per-kind fences.
  for (const state of PRODUCT_INTELLIGENCE_AUTHORIZATION_STATES) {
    assert.ok(migration048.includes(`'${state}'`), `authorization state '${state}' is CHECK-fenced`);
  }
  assert.ok(
    migration048.includes('CONSTRAINT product_context_input_authorization_shape'),
    'the authorization-shape fence exists (authorized ⟺ reference; public ⟺ null)',
  );
  assert.ok(
    migration048.includes('CONSTRAINT product_context_input_kind_authorization'),
    'the per-kind authorization fence exists',
  );
  // The per-kind map on the public contract matches the migration fence.
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.public_site_url, ['public']);
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.authenticated_app_environment, ['explicitly_authorized']);
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS.connected_source_workspace, ['explicitly_authorized']);
  for (const kind of [
    'source_code_repository_url',
    'product_documentation',
    'catalog_inventory',
    'current_analytics',
  ] as const) {
    assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_AUTHORIZATIONS[kind], ['public', 'explicitly_authorized']);
  }
  // The nine §8 derivation kinds.
  for (const kind of PRODUCT_INTELLIGENCE_DERIVATION_KINDS) {
    assert.ok(migration048.includes(`'${kind}'`), `derivation kind '${kind}' is CHECK-fenced`);
  }
  // The verification-state vocabulary + the verification-shape fence.
  for (const state of PRODUCT_INTELLIGENCE_VERIFICATION_STATES) {
    assert.ok(migration048.includes(`'${state}'`), `verification state '${state}' is CHECK-fenced`);
  }
  assert.ok(
    migration048.includes('CONSTRAINT product_derived_model_verification_shape'),
    'the verification-state fence exists (unverified ⟺ zero backing references; evidence_backed ⟺ at least one)',
  );
  // The hypothesis-kind fence: the two hypothesis kinds are frozen to the flag.
  for (const kind of PRODUCT_INTELLIGENCE_HYPOTHESIS_KINDS) {
    assert.ok(
      migration048.includes(`'${kind}'`),
      `hypothesis kind '${kind}' participates in the hypothesis-kind fence`,
    );
  }
  assert.ok(
    migration048.includes('CONSTRAINT product_derived_model_hypothesis_shape'),
    'the hypothesis-kind fence exists (hypotheses never become facts)',
  );
  // The five risk kinds + three severities.
  for (const kind of PRODUCT_INTELLIGENCE_RISK_KINDS) {
    assert.ok(migration048.includes(`'${kind}'`), `risk kind '${kind}' is CHECK-fenced`);
  }
  for (const severity of PRODUCT_INTELLIGENCE_RISK_SEVERITIES) {
    assert.ok(migration048.includes(`'${severity}'`), `severity '${severity}' is CHECK-fenced`);
  }
  // The ai-assistance pair fences.
  assert.ok(
    migration048.includes('CONSTRAINT product_derived_model_ai_shape'),
    'the derived-record ai-assistance pair fence exists',
  );
  assert.ok(
    migration048.includes('CONSTRAINT product_risk_flag_ai_shape'),
    'the risk-flag ai-assistance pair fence exists',
  );
  // The repetition fences.
  assert.ok(
    migration048.includes('CONSTRAINT product_derived_model_statement_unique'),
    'the derived-record repetition fence exists (hypotheses never become facts by repetition)',
  );
  assert.ok(
    migration048.includes('CONSTRAINT product_risk_flag_statement_unique'),
    'the risk-flag repetition fence exists',
  );
  // The unchanged-source fence.
  assert.ok(
    migration048.includes('CONSTRAINT product_source_facts_source_fence'),
    'the unchanged-source fence exists (an unchanged source never re-appends)',
  );
  // The vocabulary version + the read-only disclosure ship on the contract.
  assert.equal(PRODUCT_INTELLIGENCE_VOCABULARY_VERSION, 'pi-vocab-v1');
  assert.equal(PRODUCT_INTELLIGENCE_INSPECTION_CAPABILITY, 'source-inspection:fetch-read-only');
});

// ---------------------------------------------------------------------------
// 3. The append-only + guard battery
// ---------------------------------------------------------------------------

test('MKT-069: the append-only UPDATE/DELETE rejection triggers + the record guards exist for every table', () => {
  for (const [table, label] of [
    ['product_context_versions', 'the version tail'],
    ['product_context_inputs', 'the per-version inputs'],
    ['product_source_facts', 'the source-fact ledger'],
    ['product_derived_models', 'the derived-model records'],
    ['product_risk_flags', 'the risk flags'],
  ] as const) {
    assert.ok(
      migration048.includes(`CREATE TRIGGER ${table}_append_only_update_trigger`),
      `${label} rejects UPDATE by trigger`,
    );
    assert.ok(
      migration048.includes(`CREATE TRIGGER ${table}_append_only_delete_trigger`),
      `${label} rejects DELETE by trigger`,
    );
  }
  // The context-record mutation guard (the growth_mission_record_guard
  // precedent) + no-DELETE.
  assert.ok(migration048.includes('CREATE TRIGGER product_context_record_guard_trigger'));
  assert.ok(migration048.includes('CREATE TRIGGER product_contexts_no_delete_trigger'));
  assert.ok(migration048.includes('CAS version must advance by exactly one'));
  assert.ok(migration048.includes('current version cannot regress'));
  // The scope fences.
  assert.ok(migration048.includes('CREATE TRIGGER product_source_fact_input_consistent_trigger'));
  assert.ok(migration048.includes('CREATE TRIGGER product_derived_model_facts_same_context_trigger'));
  assert.ok(migration048.includes('CREATE TRIGGER product_derived_model_evidence_same_agency_trigger'));
  assert.ok(migration048.includes('CREATE TRIGGER product_risk_flag_facts_same_context_trigger'));
  assert.ok(migration048.includes('CREATE TRIGGER product_risk_flag_evidence_same_agency_trigger'));
});

// ---------------------------------------------------------------------------
// 4. The read-only inspection battery (boundary rule 7)
// ---------------------------------------------------------------------------

test('MKT-069 AC-5: the read-only inspection contract — the fetcher port has EXACTLY fetch(), the integrations port has NO mutation surface, and ZERO external write verbs exist', () => {
  // The fetcher port declares exactly one method: fetch. There is no
  // write method on the port — the read-only guarantee is structural.
  const fetcherPortBlock = piPublic.slice(
    piPublic.indexOf('export interface ProductSourceFetcher {'),
    piPublic.indexOf('export interface ProductSourceFetcher {') + 300,
  );
  assert.ok(fetcherPortBlock.includes('fetch(url: string): Promise<ProductSourceFetch>'));
  const fetcherMethods = [...fetcherPortBlock.matchAll(/\n\s+(readonly\s+)?([a-zA-Z]+)\s*\(/g)].map(
    (match) => match[2]!,
  );
  assert.deepEqual(fetcherMethods, ['fetch'], 'the fetcher port declares EXACTLY fetch()');

  // The integrations structural port exposes resolveConnectionOwnership +
  // executeRead ONLY — the /integrations mutation surface is absent from
  // the port type, so the module cannot express an external write.
  const integrationsPortBlock = piPublic.slice(
    piPublic.indexOf('export interface ProductIntelligenceIntegrationsPort {'),
    piPublic.length,
  );
  const portMethodNames = [
    ...integrationsPortBlock.matchAll(/\n\s+([a-zA-Z]+)\s*\(/g),
  ].map((match) => match[1]!);
  assert.ok(portMethodNames.includes('resolveConnectionOwnership'));
  assert.ok(portMethodNames.includes('executeRead'));
  assert.ok(
    !portMethodNames.includes('executeMutation'),
    'the narrow port has NO executeMutation method',
  );
  assert.ok(
    !portMethodNames.includes('registerConnection'),
    'the narrow port has NO registration method',
  );
  assert.ok(
    !portMethodNames.includes('suspendConnection'),
    'the narrow port has NO lifecycle method',
  );

  // ZERO external write/mutation verbs toward any external source in the
  // module CODE (comment-stripped): no push/upload/write/post/put/delete/
  // mutate call on any port, no provider SDK, no fetch-with-method other
  // than the fetcher's single GET.
  const moduleCode = [stripComments(piModule), stripComments(piStore), stripComments(piFetcher), stripComments(piExtractor)].join('\n');
  assert.ok(!/\bexecuteMutation\b/.test(moduleCode), 'no executeMutation call exists');
  assert.ok(!/\bmutate\s*\(/.test(moduleCode), 'no mutate( call exists');
  assert.ok(!/registerConnection|suspendConnection|connectConnection/.test(moduleCode), 'no connection lifecycle call exists');
  // The fetcher production adapter issues EXACTLY one GET.
  const fetcherGets = [...stripComments(piFetcher).matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]!);
  assert.deepEqual(fetcherGets, ['GET'], 'the production fetcher issues GET only');

  // The documented write seam is a named constant ONLY — no code path
  // consumes it (prose mentions are comments; only CODE references count,
  // so the scan runs comment-stripped — the single CODE occurrence is the
  // public-contract declaration itself).
  const seamCodeOccurrences = [
    stripComments(piPublic),
    stripComments(piModule),
    stripComments(piStore),
    stripComments(piExtractor),
    stripComments(piFetcher),
    stripComments(piRoutes),
  ].filter((code) => code.includes('PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM'));
  assert.deepEqual(
    seamCodeOccurrences,
    [stripComments(piPublic)],
    'the write seam appears ONLY in the public-contract declaration (the documented, deliberately-unwired constant)',
  );
  assert.ok(
    PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM.includes('separately-granted-capability-key'),
    'the seam documents the separately-granted capability key requirement',
  );

  // NO mission-strategy/planner logic: no platform-mix / channel-select /
  // attribution-plan verbs anywhere in the module code (MKT-070 territory).
  for (const forbidden of [
    'selectPlatformMix',
    'planMission',
    'missionStrategy',
    'chooseChannels',
    'attributionPlan',
  ]) {
    assert.ok(!moduleCode.includes(forbidden), `no ${forbidden} verb exists (MKT-070 territory)`);
  }
});

// ---------------------------------------------------------------------------
// 5. DML against OWN tables only; zero cross-module imports (the arch-check
//    real-run proof lives in arch-check.test.ts — the module-set + boundary
//    posture is verified here against the actual checker too)
// ---------------------------------------------------------------------------

test('MKT-069: the store issues DML against the product_* tables ONLY and reads no other module\'s tables', () => {
  const storeCode = stripComments(piStore);
  const dmlTargets = [
    ...storeCode.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g),
  ].map((match) => match[1]!);
  assert.ok(dmlTargets.length > 0, 'the store was scanned for DML targets');
  for (const target of dmlTargets) {
    assert.ok(
      target.startsWith('product_'),
      `DML target '${target}' must be a product_* table (OWN tables only)`,
    );
  }
  // No SELECT of another module's tables from the module code (the
  // cross-module reads compose the declared structural ports).
  const moduleAndStore = `${stripComments(piModule)}\n${storeCode}`;
  const foreignSelects = moduleAndStore.match(
    /\bFROM\s+(evidence|integration_connections|integration_events|agencies|clients|goals|growth_missions|experiments|metrics)\b/g,
  );
  assert.deepEqual(foreignSelects, null, 'the module code reads no other module\'s tables (structural ports only)');
  // The real arch-check run: zero violations with the module registered.
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );
  assert.ok(result.frozenModules.includes('product-intelligence'), 'the enforced set includes /product-intelligence');
  // The registered matrix row is the currently-satisfiable subset (the
  // provision module 'apps' rides the disclosed checker provision — parse
  // exactly as checkArchitecture does).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const specMatrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(specMatrix['product-intelligence'], ['evidence', 'integrations', 'ai-runtime']);
});

// ---------------------------------------------------------------------------
// 6. The route surface: EXACTLY the ten GET/POST record routes
// ---------------------------------------------------------------------------

test('MKT-069: the route surface is EXACTLY the ten GET/POST product-context routes — NO PUT/PATCH/DELETE, no write-seam route', () => {
  const registrations = [...piRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*\n?\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(registrations, [
    'POST /api/agencies/:agencyId/product-contexts',
    'GET /api/agencies/:agencyId/product-contexts',
    'GET /api/product-contexts/:contextId',
    'GET /api/product-contexts/:contextId/versions',
    'GET /api/product-contexts/:contextId/source-facts',
    'GET /api/product-contexts/:contextId/derived-models',
    'GET /api/product-contexts/:contextId/risk-flags',
    'POST /api/product-contexts/:contextId/versions',
    'POST /api/product-contexts/:contextId/inspection',
    'POST /api/product-contexts/:contextId/derived-models',
    'POST /api/product-contexts/:contextId/risk-flags',
  ]);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!piRoutes.includes(`'${verb}'`), `no ${verb} route exists in the family`);
  }
  // No route names the write seam (the code, comment-stripped — the doc
  // comments may DISCUSS the seam, but no route path or handler touches it).
  assert.ok(
    !stripComments(piRoutes).includes('write'),
    'no write-seam route exists (no code reference to the write capability)',
  );
});

// ---------------------------------------------------------------------------
// 7. The spec registration + the shared-file wiring + the migration position
// ---------------------------------------------------------------------------

test('MKT-069: the spec registration, the shared-file wiring and the migration position', () => {
  // spec/architecture.md §6 module list + authority note.
  assert.ok(architectureSpec.includes('/product-intelligence\n'), 'the §6 module list carries /product-intelligence');
  assert.ok(
    architectureSpec.includes('`/product-intelligence` is the v1.6 Product Intelligence authority'),
    'the architecture authority note exists',
  );
  // The matrix row + the authority-notes bullet.
  assert.ok(
    matrixSpec.includes('/product-intelligence ──→ /evidence, /integrations, /ai-runtime'),
    'the matrix dependency row exists',
  );
  assert.ok(
    matrixSpec.includes('- `/product-intelligence` is the v1.6 Product Intelligence authority'),
    'the matrix forbidden-directions bullet exists',
  );
  // The /research dependency disclosure (the honest additive registration).
  assert.ok(
    matrixSpec.includes('also lists `/research` on this row — it arrives with MKT-062'),
    'the matrix bullet discloses the /research dependency timing',
  );
  // 048_product_intelligence.sql holds its numeric position (the
  // PRE-ASSIGNED number — 047/049 are reserved for sibling deliveries;
  // the numeric ORDER is the invariant).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrationsOnDisk.includes('048_product_intelligence.sql'));
  assert.ok(
    migrationsOnDisk.indexOf('046_social_accounts.sql') < migrationsOnDisk.indexOf('048_product_intelligence.sql'),
    '048 appends after 046 (047/049 are sibling reservations that sort between when they land)',
  );
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '048_product_intelligence.sql');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly productIntelligence: ProductIntelligenceModuleApi'), 'ApplicationModules.productIntelligence');
  assert.ok(applicationTs.includes("from '../modules/product-intelligence/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerProductIntelligenceRoutes(router, services, modules)'), 'routes.ts registers the product-intelligence routes');
  assert.ok(routesTs.includes("from './product-intelligence-routes.ts'"), 'routes.ts imports the product-intelligence route builder');
  assert.ok(compositionRoot.includes('createProductIntelligenceModule'), 'the composition root constructs the product-intelligence module');
  assert.ok(compositionRoot.includes('createHttpProductSourceFetcher(httpCalls, clock)'), 'the production fetcher rides the platform HttpCallPort');
  assert.ok(compositionRoot.includes('productSourceFetcher'), 'the AppOptions fetcher seam exists (the test-double composition seam)');
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'product-intelligence', 'public.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'product-intelligence-module.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'product-intelligence-store.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'extractor.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'http-fetcher.ts')));
});
