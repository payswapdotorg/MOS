/**
 * MKT-069 static tests — the Product Intelligence domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the growth-missions-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-069; spec/architecture-v1.6.md
 * §7/§8 — the primary contract; frozen by
 * spec/module-dependency-matrix-v1.6.md boundary rule 7; frozen matrix
 * registration /product-intelligence ──→ /evidence, /integrations,
 * /ai-runtime — the DISCLOSED currently-satisfiable subset; /research
 * joins at MKT-062 time):
 *   1. migration 048 (the PRE-ASSIGNED number) creates exactly the TEN
 *      own tables — OWN tables ONLY, NO mission/workflow/execution/
 *      playbook/experiment/evidence/learning/job/deployment/research/
 *      integration/credential/tenant table (the composed authorities stay
 *      sole), and NO mission-strategy/planner state of any kind (MKT-070
 *      is a later Work Item);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the six input kinds, the
 *      two authorization states, the kind-compatible authorization shape
 *      fence (boundary rule 7), the eight §8 derivation kinds, the two
 *      verification states, the five risk categories, the four severities,
 *      the ten fact kinds, the run statuses and the per-input outcome
 *      vocabulary;
 *   3. THE APPEND-ONLY + VERIFICATION BATTERY: the append-only
 *      UPDATE/DELETE rejection triggers on every tail table, the
 *      context-record mutation guard (identity immutability + exact CAS
 *      advance + the version pointer only ever advances), the DEFERRABLE
 *      verification-state ⇔ evidence-presence invariant (a derived record
 *      without backing evidence can never be presented as established),
 *      the single-supersession fence, the evidence scope fences and the
 *      integration connection scope fence;
 *   4. THE READ-ONLY BOUNDARY BATTERY (boundary rule 7): the module
 *      exposes NO mutation surface toward any external source — the
 *      integrations structural port declares getConnection + executeRead
 *      ONLY (executeMutation is structurally absent), the page-reader
 *      contract has NO method field at all, the adapter performs GET
 *      only, and NO mutation verb toward an external source exists
 *      anywhere in the module code;
 *   5. THE LAYER-NOT-AUTHORITY BATTERY: DML against the module's OWN
 *      tables ONLY, zero reads of another module's tables from the module
 *      code, the migration's only touches of the agencies/integration
 *      tables are the FK anchor + the CHECK-ONLY trigger reads, and the
 *      module's ONE /evidence import is the shared §21 guard;
 *   6. the ROUTE surface is EXACTLY the twelve GET/POST record routes —
 *      no PUT/PATCH/DELETE anywhere in the family (the declared inputs
 *      are never rewritten in place: corrections are POST .../versions);
 *   7. the spec registration exists: /product-intelligence in
 *      spec/architecture.md §6 + the matrix row + the authority-notes
 *      bullet in spec/module-dependency-matrix.md; 048_product_intelligence.sql
 *      holds its numeric position in the expected-migration list;
 *   8. the version discipline: the frozen vocabulary version (pi-vocab-v1)
 *      + the claim-tier disclosure + the read-only write seam ship on the
 *      public contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  PRODUCT_INTELLIGENCE_INPUT_KINDS,
  PRODUCT_INTELLIGENCE_DERIVATION_KINDS,
  PRODUCT_INTELLIGENCE_RISK_CATEGORIES,
  PRODUCT_INTELLIGENCE_RISK_SEVERITIES,
  PRODUCT_INTELLIGENCE_VOCABULARY_VERSION,
  PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER,
} from '../../src/modules/product-intelligence/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration048 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '048_product_intelligence.sql'));
const piPublic = read(src('modules', 'product-intelligence', 'public.ts'));
const piModule = read(src('modules', 'product-intelligence', 'internal', 'product-intelligence-module.ts'));
const piStore = read(src('modules', 'product-intelligence', 'internal', 'product-intelligence-store.ts'));
const piAdapter = read(src('modules', 'product-intelligence', 'internal', 'adapters', 'http-page-reader.ts'));
const piRoutes = read(src('api', 'product-intelligence-routes.ts'));
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

const moduleFiles = [
  src('modules', 'product-intelligence', 'public.ts'),
  src('modules', 'product-intelligence', 'internal', 'product-intelligence-module.ts'),
  src('modules', 'product-intelligence', 'internal', 'product-intelligence-store.ts'),
  src('modules', 'product-intelligence', 'internal', 'adapters', 'http-page-reader.ts'),
];

// ---------------------------------------------------------------------------
// 1. Migration 048: OWN TABLES ONLY, no authority table, no planner state
// ---------------------------------------------------------------------------

test('MKT-069: migration 048 creates exactly the ten own tables — OWN tables ONLY (no authority table, no mission-strategy state)', () => {
  const created = [...migration048.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'product_contexts',
      'product_context_versions',
      'product_context_inputs',
      'product_inspection_runs',
      'product_inspection_input_runs',
      'product_source_facts',
      'product_derived_models',
      'product_derived_model_evidence',
      'product_risk_flags',
      'product_risk_flag_evidence',
    ],
    'own tables ONLY — the durable product/market inspection and model record layer; /evidence (015), /integrations (029), /goals (007), /workflows (009), /executions (011), /experiments (019), /learnings (027) and /growth-missions (045) stay the sole authorities',
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
  // The declared inputs' frozen columns.
  const inputColumns = columnsOf(createTableBlock(migration048, 'product_context_inputs'));
  for (const required of [
    'input_id', 'product_context_version_id', 'kind', 'reference', 'authorization_state',
    'integration_connection_id', 'position',
  ]) {
    assert.ok(inputColumns.includes(required), `product_context_inputs must carry '${required}'`);
  }
  // The retained source facts' frozen columns (FULL provenance).
  const factColumns = columnsOf(createTableBlock(migration048, 'product_source_facts'));
  for (const required of [
    'source_fact_id', 'product_context_id', 'product_context_version_id', 'input_id',
    'inspection_run_id', 'fact_kind', 'source_ref', 'fetched_at', 'extractor',
    'content_hash', 'extraction_notes', 'content',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(factColumns.includes(required), `product_source_facts must carry '${required}'`);
  }
  // The derived models' frozen columns (evidence + AI disclosure + state).
  const derivedColumns = columnsOf(createTableBlock(migration048, 'product_derived_models'));
  for (const required of [
    'derived_model_id', 'product_context_id', 'derivation_kind', 'statement',
    'verification_state', 'supersedes_derived_model_id',
    'ai_model_registry_id', 'ai_model_display', 'ai_call_reference',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(derivedColumns.includes(required), `product_derived_models must carry '${required}'`);
  }
  // The risk flags' frozen columns.
  const riskColumns = columnsOf(createTableBlock(migration048, 'product_risk_flags'));
  for (const required of [
    'risk_flag_id', 'product_context_id', 'category', 'severity', 'statement',
    'mitigation', 'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(riskColumns.includes(required), `product_risk_flags must carry '${required}'`);
  }
  // The inspection runs' + per-input outcome frozen columns.
  const runColumns = columnsOf(createTableBlock(migration048, 'product_inspection_runs'));
  for (const required of [
    'inspection_run_id', 'product_context_id', 'product_context_version_id', 'status',
    'inputs_inspected', 'facts_retained', 'started_at', 'finished_at',
  ]) {
    assert.ok(runColumns.includes(required), `product_inspection_runs must carry '${required}'`);
  }
  const inputRunColumns = columnsOf(createTableBlock(migration048, 'product_inspection_input_runs'));
  for (const required of [
    'inspection_input_run_id', 'inspection_run_id', 'input_id', 'outcome', 'detail',
    'facts_extracted', 'created_at',
  ]) {
    assert.ok(inputRunColumns.includes(required), `product_inspection_input_runs must carry '${required}'`);
  }

  // NO authority table is created and NO mission-strategy state exists
  // anywhere: the migration text may not even name a planner surface.
  for (const forbidden of [
    'mission', 'workflow', 'execution', 'playbook', 'experiment', 'evidence_record',
    'learning', 'job', 'deployment', 'research', 'planner', 'strategy',
  ]) {
    assert.ok(
      !created.some((table) => table.includes(forbidden)),
      `no '${forbidden}' table may be created (MKT-070 does the planning — this module holds the attachable model records only)`,
    );
  }
  // No secret-material column anywhere (§21 posture).
  for (const table of created) {
    assert.ok(
      !/secret|password|token|api_key/.test(columnsOf(createTableBlock(migration048, table)).join(',')),
      `${table} carries no material-shaped column`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-069 AC-1 static: the input-kind + authorization vocabularies and the kind-compatible shape fence are CHECK-fenced', () => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  const inputBlock = normalize(createTableBlock(migration048, 'product_context_inputs'));
  const kindList = PRODUCT_INTELLIGENCE_INPUT_KINDS.map((kind) => `'${kind}'`).join(', ');
  assert.ok(
    inputBlock.includes(kindList),
    'product_context_inputs CHECK-fences the full six-kind input vocabulary',
  );
  assert.ok(
    inputBlock.includes("'public', 'authorized'"),
    'the authorization-state vocabulary is CHECK-fenced',
  );
  // THE KIND-COMPATIBLE AUTHORIZATION FENCE (boundary rule 7): the web
  // kinds are public WITHOUT a connection; the authorized kinds carry a
  // connection reference.
  assert.ok(
    inputBlock.includes('CONSTRAINT product_context_inputs_shape CHECK'),
    'the kind-authorization shape fence exists',
  );
  assert.ok(
    migration048.includes("AND authorization_state = 'public'"),
    'the public web kinds REQUIRE the public authorization state',
  );
  assert.ok(
    migration048.includes("AND authorization_state = 'authorized'"),
    'the authorized kinds REQUIRE the explicitly-authorized state',
  );
  // The code-side frozen vocabulary agrees with the storage mirror.
  assert.deepEqual(PRODUCT_INTELLIGENCE_INPUT_KINDS, [
    'product_site_url', 'product_document', 'source_repository',
    'source_workspace', 'catalog_inventory', 'current_analytics',
  ]);
});

test('MKT-069 AC-3/AC-4 static: the derivation, verification, risk and fact vocabularies are CHECK-fenced (the pi-vocab-v1 storage mirror)', () => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  const derivedBlock = normalize(createTableBlock(migration048, 'product_derived_models'));
  const derivationList = PRODUCT_INTELLIGENCE_DERIVATION_KINDS.map((kind) => `'${kind}'`).join(', ');
  assert.ok(
    derivedBlock.includes(derivationList),
    'product_derived_models CHECK-fences the full eight-kind §8 derivation vocabulary',
  );
  assert.ok(
    derivedBlock.includes("'unverified', 'evidence_backed'"),
    'the verification-state vocabulary is CHECK-fenced',
  );
  // The AI-assistance disclosure shape (all three or none).
  assert.ok(
    derivedBlock.includes('CONSTRAINT product_derived_model_ai_shape CHECK'),
    'the AI-disclosure all-or-none shape fence exists',
  );
  const riskBlock = normalize(createTableBlock(migration048, 'product_risk_flags'));
  const categoryList = PRODUCT_INTELLIGENCE_RISK_CATEGORIES.map((c) => `'${c}'`).join(', ');
  const severityList = PRODUCT_INTELLIGENCE_RISK_SEVERITIES.map((s) => `'${s}'`).join(', ');
  assert.ok(
    riskBlock.includes(categoryList),
    'product_risk_flags CHECK-fences the five risk categories',
  );
  assert.ok(
    riskBlock.includes(severityList),
    'product_risk_flags CHECK-fences the four severities',
  );
  // The fact-kind vocabulary + the run/outcome vocabularies.
  const factBlock = normalize(createTableBlock(migration048, 'product_source_facts'));
  for (const factKind of [
    'page_title', 'meta_description', 'meta_keywords', 'og_title', 'og_description',
    'canonical_url', 'page_language', 'heading', 'text_excerpt', 'source_record',
  ]) {
    assert.ok(factBlock.includes(`'${factKind}'`), `the fact kind '${factKind}' is CHECK-fenced`);
  }
  const runBlock = normalize(createTableBlock(migration048, 'product_inspection_runs'));
  assert.ok(
    runBlock.includes("'completed', 'partial', 'failed'"),
    'the run-status vocabulary is CHECK-fenced',
  );
  const inputRunBlock = normalize(createTableBlock(migration048, 'product_inspection_input_runs'));
  for (const outcome of [
    'facts_extracted', 'no_facts_extracted', 'unauthorized_refused', 'fetch_http_error',
    'fetch_transport_error', 'read_error', 'read_refused',
  ]) {
    assert.ok(inputRunBlock.includes(`'${outcome}'`), `the outcome '${outcome}' is CHECK-fenced`);
  }
  // The statement shapes (REQUIRED bounded summary).
  assert.ok(
    derivedBlock.includes("statement ? 'summary'"),
    'derived statements REQUIRE a summary',
  );
  assert.ok(
    riskBlock.includes("statement ? 'summary'"),
    'risk statements REQUIRE a summary',
  );
});

test('MKT-069 AC-1/AC-3 static: the append-only battery, the record guard and the verification invariant exist', () => {
  // APPEND-ONLY: every tail table rejects UPDATE and DELETE outright.
  for (const table of [
    'product_context_versions',
    'product_context_inputs',
    'product_inspection_runs',
    'product_inspection_input_runs',
    'product_source_facts',
    'product_derived_models',
    'product_derived_model_evidence',
    'product_risk_flags',
    'product_risk_flag_evidence',
  ]) {
    assert.ok(
      migration048.includes(`CREATE TRIGGER ${table}_append_only_update_trigger`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration048.includes(`CREATE TRIGGER ${table}_append_only_delete_trigger`),
      `${table} rejects DELETE`,
    );
  }
  assert.ok(
    migration048.includes('product source facts are append-only'),
    'the fact-tail rejection message is explicit',
  );
  assert.ok(
    migration048.includes('product derived models are append-only'),
    'the derived-tail rejection message is explicit',
  );
  assert.ok(
    migration048.includes('product risk flags are append-only'),
    'the risk-tail rejection message is explicit',
  );
  // THE CONTEXT-RECORD GUARD: identity/scope immutable + exact CAS advance
  // + the version pointer only ever advances + references an existing
  // version.
  assert.ok(
    migration048.includes('CREATE OR REPLACE FUNCTION product_context_record_guard()'),
    'the context-record mutation guard exists',
  );
  assert.ok(
    migration048.includes('corrections are new version records, never rewrites'),
    'the input-immutability rejection message is explicit',
  );
  assert.ok(
    migration048.includes('CAS version must advance by exactly one'),
    'the exact CAS advance is fenced',
  );
  assert.ok(
    migration048.includes('current version cannot regress'),
    'the version pointer only ever advances',
  );
  assert.ok(
    migration048.includes('product contexts cannot be deleted'),
    'context records are never deleted',
  );
  // THE DEFERRABLE VERIFICATION-STATE INVARIANT: a derived record without
  // backing evidence can never be presented as established.
  assert.ok(
    migration048.includes(
      'CREATE OR REPLACE FUNCTION product_derived_model_verification_consistent()',
    ),
    'the verification invariant function exists',
  );
  assert.ok(
    migration048.includes(
      'CREATE CONSTRAINT TRIGGER product_derived_model_verification_trigger',
    ),
    'the verification invariant is a DEFERRABLE constraint trigger (commit-time)',
  );
  assert.ok(
    migration048.includes('DEFERRABLE INITIALLY DEFERRED'),
    'the deferred verification posture is explicit',
  );
  assert.ok(
    migration048.includes('can never be presented as established'),
    'the honest rejection message is explicit',
  );
  // THE SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern).
  assert.ok(
    migration048.includes('CREATE UNIQUE INDEX IF NOT EXISTS product_derived_model_supersession_fence'),
    'the single-supersession partial-unique fence exists',
  );
  assert.ok(
    migration048.includes('a correction never changes its subject'),
    'the same-kind supersession rule is explicit',
  );
  // THE EVIDENCE SCOPE FENCES (same-context source facts only).
  assert.ok(
    migration048.includes('CREATE OR REPLACE FUNCTION product_derived_model_evidence_scope_consistent()'),
    'the derived-evidence scope fence exists',
  );
  assert.ok(
    migration048.includes('CREATE OR REPLACE FUNCTION product_risk_flag_evidence_scope_consistent()'),
    'the risk-evidence scope fence exists',
  );
  assert.ok(
    migration048.includes('evidence references stay inside one context'),
    'the evidence scope rejection message is explicit',
  );
  // THE INTEGRATION CONNECTION SCOPE FENCE (the migration 046 pattern —
  // read CHECK-ONLY).
  assert.ok(
    migration048.includes('CREATE OR REPLACE FUNCTION product_input_connection_scope_consistent()'),
    'the connection scope fence exists',
  );
  assert.ok(
    migration048.includes('the agency boundary cannot be crossed'),
    'the cross-agency connection rejection is explicit',
  );
  assert.ok(
    migration048.includes('a dangling authorized reference cannot persist'),
    'the dangling-connection rejection is explicit',
  );
  // The canonical agency reference is FK-anchored (migration 002) — the
  // route-layer agency resolution's backstop.
  assert.ok(
    migration048.includes('agency_id           uuid        NOT NULL REFERENCES agencies(agency_id)'),
    'the context FK-anchors the canonical agency reference',
  );
});

// ---------------------------------------------------------------------------
// 3. THE READ-ONLY BOUNDARY BATTERY (boundary rule 7)
// ---------------------------------------------------------------------------

test('MKT-069 AC-5 boundary: the READ-ONLY inspection contract — NO mutation surface toward any external source', () => {
  // The integrations structural port declares getConnection + executeRead
  // ONLY: executeMutation is STRUCTURALLY ABSENT (the port block text).
  const portBlock = piPublic.slice(
    piPublic.indexOf('export interface ProductIntelligenceIntegrationsPort'),
    piPublic.indexOf('export interface ProductIntelligenceAiRuntimePort'),
  );
  assert.ok(portBlock.includes('getConnection'), 'the port declares getConnection');
  assert.ok(portBlock.includes('executeRead'), 'the port declares executeRead');
  assert.ok(
    !portBlock.includes('executeMutation'),
    'the port declares NO executeMutation — the read-only guarantee is a compile-time property',
  );
  assert.ok(
    !portBlock.includes('registerConnection'),
    'the port declares no connection registration',
  );
  assert.ok(
    !portBlock.includes('ingestWebhook'),
    'the port declares no webhook ingestion',
  );
  // The page-reader REQUEST contract has NO method and NO body field at
  // all: a mutation toward a public source is not expressible on the
  // contract (the RESPONSE outcome legitimately carries the read body).
  const requestBlock = stripComments(
    piPublic.slice(
      piPublic.indexOf('export interface ProductPageFetchRequest'),
      piPublic.indexOf('export interface ProductPageFetchOutcome'),
    ),
  );
  assert.ok(requestBlock.includes('readonly url: string'), 'the request declares the url');
  assert.ok(!requestBlock.includes('method'), 'the fetch request carries NO method — GET is the only expressible verb');
  assert.ok(!requestBlock.includes('body'), 'the fetch request carries NO body field');
  // The REAL adapter is GET-only.
  const adapterCode = stripComments(piAdapter);
  assert.ok(adapterCode.includes("method: 'GET'"), 'the adapter performs exactly one verb: GET');
  for (const verb of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.ok(!adapterCode.includes(`method: ${verb}`), `the adapter never performs ${verb}`);
  }
  // NO mutation verb toward any external source exists anywhere in the
  // module code (comment-stripped).
  for (const file of [piPublic, piModule, piStore]) {
    const code = stripComments(file);
    assert.ok(
      !code.includes('executeMutation'),
      'the module never calls executeMutation (the port cannot even express it)',
    );
    assert.ok(
      !code.includes('ingestWebhookEvent'),
      'the module never ingests webhooks',
    );
    assert.ok(
      !code.includes('registerConnection'),
      'the module never registers connections',
    );
  }
  // The read-only write seam is DOCUMENTED, not built: the constant
  // discloses it and no capability key / write gate exists in the code.
  assert.ok(
    piPublic.includes('PRODUCT_INTELLIGENCE_WRITE_CAPABILITY_SEAM'),
    'the write seam constant ships on the public contract',
  );
  const moduleCodeAll = stripComments(`${piModule}\n${piStore}`);
  assert.ok(
    !/writeCapability|capabilityKey|grantWrite|write[A-Z]/.test(moduleCodeAll),
    'no write-capability key or write gate exists in the module implementation',
  );
});

// ---------------------------------------------------------------------------
// 4. THE LAYER-NOT-AUTHORITY BATTERY (own tables only + the import posture)
// ---------------------------------------------------------------------------

test('MKT-069 boundary: DML against OWN tables ONLY — the store never writes or reads another module\'s tables', () => {
  const storeCode = stripComments(piStore);
  const ownTables = [
    'product_contexts',
    'product_context_versions',
    'product_context_inputs',
    'product_inspection_runs',
    'product_inspection_input_runs',
    'product_source_facts',
    'product_derived_models',
    'product_derived_model_evidence',
    'product_risk_flags',
    'product_risk_flag_evidence',
  ];
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(insertTables)].sort(),
    [
      'product_context_inputs',
      'product_context_versions',
      'product_contexts',
      'product_derived_model_evidence',
      'product_derived_models',
      'product_inspection_input_runs',
      'product_inspection_runs',
      'product_risk_flag_evidence',
      'product_risk_flags',
      'product_source_facts',
    ].sort(),
    'INSERTs target exactly the own ten tables (version 1 rides insertContext + insertVersion)',
  );
  const updateTables = [...storeCode.matchAll(/UPDATE ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(updateTables)].sort(),
    ['product_contexts'],
    'UPDATEs target exactly the context record (the CAS version-pointer advance)',
  );
  assert.ok(
    !/\bDELETE FROM\b/i.test(storeCode),
    'the store never issues a DELETE (every tail is append-only)',
  );
  // Every FROM target is an own table (every cross-module read composes
  // the /integrations + /ai-runtime public-contract ports).
  const selectTables = [...storeCode.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]!);
  for (const table of selectTables) {
    assert.ok(
      ownTables.includes(table),
      `the store may only read the own tables — found FROM ${table} (cross-module reads compose the /integrations + /ai-runtime public-contract ports)`,
    );
  }
  // The migration's only touches of the agencies/integration_connections
  // tables are the FK anchor + the CHECK-ONLY trigger reads: no
  // INSERT/UPDATE/DELETE on them anywhere in the migration code.
  for (const authority of ['agencies', 'integration_connections']) {
    assert.ok(
      !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${authority}\\b`).test(migration048),
      `the migration never writes the ${authority} authority table`,
    );
  }
});

test('MKT-069 boundary: the module imports ONLY the frozen matrix allowances (evidence — the ONE §21-guard import; integrations + ai-runtime as structural ports)', () => {
  const allowed = new Set(['evidence']);
  for (const file of moduleFiles) {
    for (const specifier of [...stripComments(read(file)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!)) {
      const match = specifier.match(/\/modules\/([a-z-]+)\/public\.ts$/);
      if (match === null) continue;
      assert.ok(
        allowed.has(match[1]!),
        `unexpected cross-module import '${specifier}' (the frozen matrix row allows /evidence, /integrations, /ai-runtime — /integrations and /ai-runtime arrive as STRUCTURAL PORTS; /research joins at MKT-062 time)`,
      );
    }
  }
  // The ONE /evidence import is the shared §21 material-key guard (the
  // /sales-continuity /decisions precedent).
  assert.ok(
    piStore.includes("import { containsMaterialKey } from '../../evidence/public.ts'"),
    'the ONE /evidence import is the shared containsMaterialKey guard',
  );
  // The public contract imports ZERO other modules (the ports are declared
  // structurally — the growth-missions precedent).
  const publicImports = [...piPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual(publicImports, []);
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'product-intelligence', 'public.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'product-intelligence-module.ts')));
  assert.ok(existsSync(src('modules', 'product-intelligence', 'internal', 'product-intelligence-store.ts')));
  assert.ok(
    existsSync(src('modules', 'product-intelligence', 'internal', 'adapters', 'http-page-reader.ts')),
    'the real page-reader adapter exists under the sanctioned internal/adapters home',
  );
});

test('MKT-069 boundary: ZERO mission-strategy/planner logic in the module CODE — the inspection/model record commands only', () => {
  for (const file of [piPublic, piModule, piStore]) {
    const code = stripComments(file).toLowerCase();
    for (const forbidden of [
      'missionstrateg', 'planner', 'chooseplatform', 'platformmix', 'selectchannel',
      'attributionplan', 'experimentplan', 'strategiz',
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `the module code must never contain the mission-strategy verb '${forbidden}' — MKT-070 (the Product Marketing Mission Planner) is a LATER Work Item; this module provides the attachable read surface only`,
      );
    }
  }
  // The module API's method set is exactly the record commands (no
  // mission-strategy surface): create/read/list/resolve/detail tails +
  // the version correction + the inspection + the derived/risk recording.
  const publicCode = stripComments(piPublic);
  for (const method of [
    'createProductContext',
    'getProductContext',
    'resolveProductContextOwnership',
    'listProductContextsForAgency',
    'getProductContextDetail',
    'getProductContextVersions',
    'getProductContextSourceFacts',
    'getProductContextDerivedModels',
    'getProductContextRiskFlags',
    'getProductContextInspectionRuns',
    'recordProductContextVersion',
    'runProductInspection',
    'recordDerivedModel',
    'getDerivedModel',
    'recordProductRiskFlag',
    'getProductRiskFlag',
  ]) {
    assert.ok(publicCode.includes(method), `ProductIntelligenceModuleApi declares ${method}`);
  }
});

// ---------------------------------------------------------------------------
// 5. The GET/POST-only route surface (AC-5/AC-7/AC-8)
// ---------------------------------------------------------------------------

test('MKT-069 AC-5/AC-7 static: the route surface is EXACTLY the twelve GET/POST record routes — no PUT/PATCH/DELETE anywhere', () => {
  const routes = [...stripComments(piRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/agencies/:agencyId/product-contexts',
    'GET /api/product-contexts/:productContextId',
    'GET /api/product-contexts/:productContextId/derived-models',
    'GET /api/product-contexts/:productContextId/inspection-runs',
    'GET /api/product-contexts/:productContextId/risk-flags',
    'GET /api/product-contexts/:productContextId/source-facts',
    'GET /api/product-contexts/:productContextId/versions',
    'POST /api/agencies/:agencyId/product-contexts',
    'POST /api/product-contexts/:productContextId/derived-models',
    'POST /api/product-contexts/:productContextId/inspections',
    'POST /api/product-contexts/:productContextId/risk-flags',
    'POST /api/product-contexts/:productContextId/versions',
  ]);
  const routesCode = stripComments(piRoutes);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !routesCode.includes(`'${verb}'`),
      `the route file never registers the verb '${verb}' (corrections are NEW version POSTs; append-only tails are never rewritten)`,
    );
  }
  // The fail-closed posture helpers exist (uniform 404 + 403).
  assert.ok(routesCode.includes('NotFoundError'), 'the uniform 404 error class');
  assert.ok(routesCode.includes('ForbiddenError'), 'the 403 error class');
  assert.ok(routesCode.includes('requireProductIntelligenceAgency'), 'the agency membership resolution');
  assert.ok(routesCode.includes('requireProductContextAccess'), 'the context-scoped ownership resolution');
  // Provenance is server-derived (never a request field): the DTOs reject
  // every provenance-shaped key + the verification state is rejected as an
  // authority field (SERVER-COMPUTED, never caller-declared).
  assert.ok(routesCode.includes('serverProvenance'), 'the server-derived provenance composer');
  assert.ok(routesCode.includes('forbiddenKeys'), 'the authority-field DTO rejection');
  assert.ok(
    routesCode.includes("'verificationState'"),
    'the verification state is a rejected authority field (server-computed only)',
  );
});

// ---------------------------------------------------------------------------
// 6. The spec registration + the migration list position + the shared files
// ---------------------------------------------------------------------------

test('MKT-069 AC-12 static: the disclosed spec registration exists — §6 line + the matrix row + the authority-notes bullet + the /research disclosure + 048 in numeric position', () => {
  // The §6 module list carries /product-intelligence.
  assert.ok(
    /^\/product-intelligence$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /product-intelligence',
  );
  assert.ok(
    architectureSpec.includes('`/product-intelligence` is the v1.6 Product Intelligence authority'),
    'the §6 registration sentence exists',
  );
  // The matrix dependency row + the authority-notes bullet + the honest
  // /research timing disclosure (the additive-registration pattern).
  assert.ok(
    matrixSpec.includes('/product-intelligence ──→ /evidence, /integrations, /ai-runtime'),
    'the matrix dependency row exists (the currently-satisfiable subset)',
  );
  assert.ok(
    matrixSpec.includes('- `/product-intelligence` is the v1.6 Product Intelligence authority'),
    'the matrix authority-notes bullet exists',
  );
  assert.ok(
    matrixSpec.includes('`/research` joins the row at MKT-062 time'),
    'the /research dependency timing is disclosed in the matrix note',
  );
  // 048_product_intelligence.sql holds its numeric position (the
  // PRE-ASSIGNED number — 047/049 belong to sibling deliveries).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -6], '048_product_intelligence.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -5], '049_commerce_capabilities.sql');
  // The MKT-056 social-adapter-contract delivery appends 050, the
  // MKT-063 /content-rights sibling delivery appends 051, and the
  // MKT-054 growth-operator delivery (renumbered 050→052 at merge)
  // appends 052 (the same additive
  // precedent — plus the MKT-064 /content-assets delivery appends 053; the
  // merged-tree truth).
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -4], '050_social_adapter_contract.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -3], '051_content_rights.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -2], '052_growth_operator.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length -1], '053_content_assets.sql');  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly productIntelligence: ProductIntelligenceModuleApi'), 'ApplicationModules.productIntelligence');
  assert.ok(applicationTs.includes("from '../modules/product-intelligence/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerProductIntelligenceRoutes(router, services, modules)'), 'routes.ts registers the product-intelligence routes');
  assert.ok(routesTs.includes("from './product-intelligence-routes.ts'"), 'routes.ts imports the product-intelligence route builder');
  assert.ok(compositionRoot.includes('createProductIntelligenceModule'), 'the composition root constructs the product-intelligence module');
  assert.ok(
    compositionRoot.includes('pageReader: options.productPageReader ?? new HttpPageReader(httpCalls)'),
    'the REAL page reader is wired with the disclosed test-double seam (the socialAccountFlows precedent)',
  );
});

// ---------------------------------------------------------------------------
// 7. The real-codebase arch-check run + the version discipline
// ---------------------------------------------------------------------------

test('MKT-069 AC-8/AC-10 static: the real codebase enforces the frozen boundaries with ZERO violations — /product-intelligence is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('product-intelligence'), 'the enforced set includes /product-intelligence');
  // The matrix-listed composition directions are exactly the three (both
  // consumed through the declared structural ports + the ONE guard import).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['product-intelligence'], ['evidence', 'integrations', 'ai-runtime']);
});

test('MKT-069 AC-3 static: the version discipline ships — the frozen vocabulary version + the claim tier + the pure helpers', () => {
  assert.equal(PRODUCT_INTELLIGENCE_VOCABULARY_VERSION, 'pi-vocab-v1');
  // Hypotheses never become facts: the claim-tier disclosure.
  assert.equal(PRODUCT_INTELLIGENCE_DERIVED_RECORD_TIER, 'claim');
  // The pure helpers are on the public contract (unit-testable + the
  // MKT-070 planner's future composition surface).
  for (const helper of [
    'isKnownProductIntelligenceInputKind',
    'isKnownProductIntelligenceDerivationKind',
    'isKnownProductIntelligenceRiskCategory',
    'isKnownProductIntelligenceRiskSeverity',
    'assertValidProductContextDeclaration',
    'assertValidProductIntelligenceProvenance',
    'assertValidProductDerivedModelInput',
    'assertValidProductRiskFlagInput',
    'composeProductContextOwnerContext',
    'derivedVerificationState',
    'extractHtmlSourceFacts',
    'hashContent',
  ]) {
    assert.ok(piPublic.includes(helper), `the public contract exports ${helper}`);
  }
});
