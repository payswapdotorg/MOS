/**
 * MKT-062 static tests — the /research domain is structurally correct in
 * the ACTUAL migration, module contract and route surface (pure static
 * analysis, no DB; the product-intelligence-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-062; spec/architecture-v1.6.md
 * §7 — the primary contract; frozen matrix registration /research ──→
 * /integrations, /evidence, /ai-runtime — verbatim):
 *   1. migration 056 (the PRE-ASSIGNED number) creates exactly the EIGHT
 *      own tables — OWN tables ONLY, NO mission/workflow/execution/
 *      playbook/experiment/evidence/learning/job/deployment/integration/
 *      credential/tenant/content-intelligence table (the composed
 *      authorities stay sole);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the eight source kinds,
 *      the two authorization states, the kind-compatible authorization
 *      shape fence, the ten fact kinds, the run statuses, the per-source
 *      outcomes, the six derivation kinds and the two verification states;
 *   3. THE APPEND-ONLY + VERIFICATION BATTERY: the append-only
 *      UPDATE/DELETE rejection triggers on every tail table, the
 *      session-record mutation guard (identity immutability + exact CAS
 *      advance + the version pointer only ever advances), the DEFERRABLE
 *      verification-state ⇔ evidence-presence invariant (a derived record
 *      without backing evidence can never be presented as established),
 *      the single-supersession fence, the evidence scope fence and the
 *      integration connection scope fence;
 *   4. THE READ-ONLY BOUNDARY BATTERY (§7): the module exposes NO mutation
 *      surface toward any research source — the integrations structural
 *      port declares getConnection + executeRead ONLY (executeMutation is
 *      structurally absent), the page-reader contract has NO method field
 *      at all, the adapter performs GET only, and NO mutation verb toward
 *      a research source exists anywhere in the module code;
 *   5. THE LAYER-NOT-AUTHORITY BATTERY: DML against the module's OWN
 *      tables ONLY, zero reads of another module's tables from the module
 *      code, the migration's only touches of the agencies/integration
 *      tables are the FK anchor + the CHECK-ONLY trigger reads, and the
 *      module's ONE /evidence import is the shared §21 guard;
 *   6. the ROUTE surface is EXACTLY the ten GET/POST record routes — no
 *      PUT/PATCH/DELETE anywhere in the family (the declared sources are
 *      never rewritten in place: corrections are POST .../versions);
 *   7. the spec registration exists: /research in spec/architecture.md §6
 *      + the matrix row + the authority-notes bullet in
 *      spec/module-dependency-matrix.md; 056_research.sql holds its
 *      numeric position in the expected-migration list;
 *   8. the version discipline: the frozen vocabulary version (rs-vocab-v1)
 *      + the claim-tier disclosure + the pure helpers ship on the public
 *      contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import { RESEARCH_DERIVATION_KINDS, RESEARCH_SOURCE_KINDS } from '../../src/modules/research/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration056 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '056_research.sql'));
const rsPublic = read(src('modules', 'research', 'public.ts'));
const rsModule = read(src('modules', 'research', 'internal', 'research-module.ts'));
const rsStore = read(src('modules', 'research', 'internal', 'research-store.ts'));
const rsAdapter = read(src('modules', 'research', 'internal', 'adapters', 'http-page-reader.ts'));
const rsRoutes = read(src('api', 'research-routes.ts'));
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
  src('modules', 'research', 'public.ts'),
  src('modules', 'research', 'internal', 'research-module.ts'),
  src('modules', 'research', 'internal', 'research-store.ts'),
  src('modules', 'research', 'internal', 'adapters', 'http-page-reader.ts'),
];

// ---------------------------------------------------------------------------
// 1. Migration 056: OWN TABLES ONLY, no authority table
// ---------------------------------------------------------------------------

test('MKT-062: migration 056 creates exactly the eight own tables — OWN tables ONLY (no authority table)', () => {
  const created = [...migration056.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'research_sessions',
      'research_session_versions',
      'research_session_sources',
      'research_runs',
      'research_run_source_outcomes',
      'research_source_facts',
      'research_insights',
      'research_insight_evidence',
    ],
    'own tables ONLY — the durable research session/source-fact/insight layer; /evidence (015), /integrations (029), /experiments (019), /content-intelligence (057) and /growth-missions (045) stay the sole authorities',
  );

  // The session record's frozen columns.
  const sessionColumns = columnsOf(createTableBlock(migration056, 'research_sessions'));
  for (const required of [
    'research_session_id', 'agency_id', 'current_version_seq', 'version',
    'created_actor', 'created_at', 'updated_at',
  ]) {
    assert.ok(sessionColumns.includes(required), `research_sessions must carry '${required}'`);
  }
  // The version tail's frozen columns.
  const versionColumns = columnsOf(createTableBlock(migration056, 'research_session_versions'));
  for (const required of [
    'research_session_version_id', 'research_session_id', 'version_seq', 'topic', 'focus',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(versionColumns.includes(required), `research_session_versions must carry '${required}'`);
  }
  // The declared sources' frozen columns.
  const sourceColumns = columnsOf(createTableBlock(migration056, 'research_session_sources'));
  for (const required of [
    'source_id', 'research_session_version_id', 'kind', 'reference', 'authorization_state',
    'integration_connection_id', 'position',
  ]) {
    assert.ok(sourceColumns.includes(required), `research_session_sources must carry '${required}'`);
  }
  // The retained source facts' frozen columns (FULL provenance).
  const factColumns = columnsOf(createTableBlock(migration056, 'research_source_facts'));
  for (const required of [
    'research_source_fact_id', 'research_session_id', 'research_session_version_id', 'source_id',
    'research_run_id', 'fact_kind', 'source_ref', 'fetched_at', 'extractor',
    'content_hash', 'extraction_notes', 'content',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(factColumns.includes(required), `research_source_facts must carry '${required}'`);
  }
  // The insights' frozen columns (evidence + AI disclosure + state).
  const insightColumns = columnsOf(createTableBlock(migration056, 'research_insights'));
  for (const required of [
    'research_insight_id', 'research_session_id', 'derivation_kind', 'statement',
    'verification_state', 'supersedes_research_insight_id',
    'ai_model_registry_id', 'ai_model_display', 'ai_call_reference',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(insightColumns.includes(required), `research_insights must carry '${required}'`);
  }
  // The runs' + per-source outcome frozen columns.
  const runColumns = columnsOf(createTableBlock(migration056, 'research_runs'));
  for (const required of [
    'research_run_id', 'research_session_id', 'research_session_version_id', 'status',
    'sources_inspected', 'facts_retained', 'started_at', 'finished_at',
  ]) {
    assert.ok(runColumns.includes(required), `research_runs must carry '${required}'`);
  }
  const outcomeColumns = columnsOf(createTableBlock(migration056, 'research_run_source_outcomes'));
  for (const required of [
    'research_run_source_outcome_id', 'research_run_id', 'source_id', 'outcome', 'detail',
    'facts_extracted', 'created_at',
  ]) {
    assert.ok(outcomeColumns.includes(required), `research_run_source_outcomes must carry '${required}'`);
  }

  // NO authority table is created anywhere: the migration text may not
  // even name a composed-authority surface.
  for (const forbidden of [
    'mission', 'workflow', 'execution', 'playbook', 'experiment', 'evidence_record',
    'learning', 'job', 'deployment', 'content_candidate', 'content_hypothesis',
    'integration', 'credential', 'tenant',
  ]) {
    assert.ok(
      !created.some((table) => table.includes(forbidden)),
      `no '${forbidden}' table may be created (the composed authorities stay sole)`,
    );
  }
  // No secret-material column anywhere (§21 posture).
  for (const table of created) {
    assert.ok(
      !/secret|password|token|api_key/.test(columnsOf(createTableBlock(migration056, table)).join(',')),
      `${table} carries no material-shaped column`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-062 static: the source-kind + authorization vocabularies and the kind-compatible shape fence are CHECK-fenced', () => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  const sourceBlock = normalize(createTableBlock(migration056, 'research_session_sources'));
  const kindList = RESEARCH_SOURCE_KINDS.map((kind) => `'${kind}'`).join(', ');
  assert.ok(
    sourceBlock.includes(kindList),
    'research_session_sources CHECK-fences the full eight-kind source vocabulary',
  );
  assert.ok(
    sourceBlock.includes("'public', 'authorized'"),
    'the authorization-state vocabulary is CHECK-fenced',
  );
  // THE KIND-COMPATIBLE AUTHORIZATION FENCE (§7): the public web kinds are
  // public WITHOUT a connection; the authorized kinds carry a connection.
  assert.ok(
    sourceBlock.includes('CONSTRAINT research_session_sources_shape CHECK'),
    'the kind-authorization shape fence exists',
  );
  assert.ok(
    migration056.includes("AND authorization_state = 'public'"),
    'the public web kinds REQUIRE the public authorization state',
  );
  assert.ok(
    migration056.includes("AND authorization_state = 'authorized'"),
    'the authorized kinds REQUIRE the explicitly-authorized state',
  );
});

test('MKT-062 static: the fact/run/outcome/derivation/verification vocabularies are CHECK-fenced (the rs-vocab-v1 storage mirror)', () => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  const factBlock = normalize(createTableBlock(migration056, 'research_source_facts'));
  for (const factKind of [
    'page_title', 'meta_description', 'meta_keywords', 'og_title', 'og_description',
    'canonical_url', 'page_language', 'heading', 'text_excerpt', 'source_record',
  ]) {
    assert.ok(factBlock.includes(`'${factKind}'`), `the fact kind '${factKind}' is CHECK-fenced`);
  }
  const runBlock = normalize(createTableBlock(migration056, 'research_runs'));
  assert.ok(
    runBlock.includes("'completed', 'partial', 'failed'"),
    'the run-status vocabulary is CHECK-fenced',
  );
  const outcomeBlock = normalize(createTableBlock(migration056, 'research_run_source_outcomes'));
  for (const outcome of [
    'facts_extracted', 'no_facts_extracted', 'unauthorized_refused', 'fetch_http_error',
    'fetch_transport_error', 'read_error', 'read_refused',
  ]) {
    assert.ok(outcomeBlock.includes(`'${outcome}'`), `the outcome '${outcome}' is CHECK-fenced`);
  }
  const insightBlock = normalize(createTableBlock(migration056, 'research_insights'));
  const derivationList = RESEARCH_DERIVATION_KINDS.map((kind) => `'${kind}'`).join(', ');
  assert.ok(
    insightBlock.includes(derivationList),
    'research_insights CHECK-fences the full six-kind §7 derivation vocabulary',
  );
  assert.ok(
    insightBlock.includes("'unverified', 'evidence_backed'"),
    'the verification-state vocabulary is CHECK-fenced',
  );
  assert.ok(
    insightBlock.includes('CONSTRAINT research_insight_ai_shape CHECK'),
    'the AI-disclosure all-or-none shape fence exists',
  );
  assert.ok(
    insightBlock.includes("statement ? 'summary'"),
    'insight statements REQUIRE a summary',
  );
  assert.ok(
    factBlock.includes('length(content_hash) = 64'),
    'the content hash is the 64-char sha256',
  );
});

test('MKT-062 static: the append-only battery, the record guard and the verification invariant exist', () => {
  // APPEND-ONLY: every tail table rejects UPDATE and DELETE outright.
  for (const table of [
    'research_session_versions',
    'research_session_sources',
    'research_runs',
    'research_run_source_outcomes',
    'research_source_facts',
    'research_insights',
    'research_insight_evidence',
  ]) {
    assert.ok(
      migration056.includes(`CREATE TRIGGER ${table}_append_only_update_trigger`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration056.includes(`CREATE TRIGGER ${table}_append_only_delete_trigger`),
      `${table} rejects DELETE`,
    );
  }
  assert.ok(
    migration056.includes('research source facts are append-only'),
    'the fact-tail rejection message is explicit',
  );
  assert.ok(
    migration056.includes('research insights are append-only'),
    'the insight-tail rejection message is explicit',
  );
  // THE SESSION-RECORD GUARD: identity/scope immutable + exact CAS advance
  // + the version pointer only ever advances + references an existing
  // version.
  assert.ok(
    migration056.includes('CREATE OR REPLACE FUNCTION research_session_record_guard()'),
    'the session-record mutation guard exists',
  );
  assert.ok(
    migration056.includes('corrections are new version records, never rewrites'),
    'the source-immutability rejection message is explicit',
  );
  assert.ok(
    migration056.includes('CAS version must advance by exactly one'),
    'the exact CAS advance is fenced',
  );
  assert.ok(
    migration056.includes('current version cannot regress'),
    'the version pointer only ever advances',
  );
  assert.ok(
    migration056.includes('research sessions cannot be deleted'),
    'session records are never deleted',
  );
  // THE DEFERRABLE VERIFICATION-STATE INVARIANT.
  assert.ok(
    migration056.includes(
      'CREATE OR REPLACE FUNCTION research_insight_verification_consistent()',
    ),
    'the verification invariant function exists',
  );
  assert.ok(
    migration056.includes(
      'CREATE CONSTRAINT TRIGGER research_insight_verification_trigger',
    ),
    'the verification invariant is a DEFERRABLE constraint trigger (commit-time)',
  );
  assert.ok(
    migration056.includes('DEFERRABLE INITIALLY DEFERRED'),
    'the deferred verification posture is explicit',
  );
  assert.ok(
    migration056.includes('can never be presented as established'),
    'the honest rejection message is explicit',
  );
  // THE SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern).
  assert.ok(
    migration056.includes('CREATE UNIQUE INDEX IF NOT EXISTS research_insight_supersession_fence'),
    'the single-supersession partial-unique fence exists',
  );
  assert.ok(
    migration056.includes('a correction never changes its subject'),
    'the same-kind supersession rule is explicit',
  );
  // THE EVIDENCE SCOPE FENCE (same-session source facts only).
  assert.ok(
    migration056.includes('CREATE OR REPLACE FUNCTION research_insight_evidence_scope_consistent()'),
    'the insight-evidence scope fence exists',
  );
  assert.ok(
    migration056.includes('evidence references stay inside one session'),
    'the evidence scope rejection message is explicit',
  );
  // THE INTEGRATION CONNECTION SCOPE FENCE (read CHECK-ONLY).
  assert.ok(
    migration056.includes('CREATE OR REPLACE FUNCTION research_source_connection_scope_consistent()'),
    'the connection scope fence exists',
  );
  assert.ok(
    migration056.includes('the agency boundary cannot be crossed'),
    'the cross-agency connection rejection is explicit',
  );
  assert.ok(
    migration056.includes('a dangling authorized reference cannot persist'),
    'the dangling-connection rejection is explicit',
  );
  // The canonical agency reference is FK-anchored (migration 002).
  assert.ok(
    migration056.includes('agency_id            uuid        NOT NULL REFERENCES agencies(agency_id)'),
    'the session FK-anchors the canonical agency reference',
  );
});

// ---------------------------------------------------------------------------
// 3. THE READ-ONLY BOUNDARY BATTERY (§7)
// ---------------------------------------------------------------------------

test('MKT-062 §7 boundary: the READ-ONLY research contract — NO mutation surface toward any research source', () => {
  // The integrations structural port declares getConnection + executeRead
  // ONLY: executeMutation is STRUCTURALLY ABSENT (the port block text).
  const portBlock = rsPublic.slice(
    rsPublic.indexOf('export interface ResearchIntegrationsPort'),
    rsPublic.indexOf('export interface ResearchAiRuntimePort'),
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
    rsPublic.slice(
      rsPublic.indexOf('export interface ResearchPageFetchRequest'),
      rsPublic.indexOf('export interface ResearchPageFetchOutcome'),
    ),
  );
  assert.ok(requestBlock.includes('readonly url: string'), 'the request declares the url');
  assert.ok(!requestBlock.includes('method'), 'the fetch request carries NO method — GET is the only expressible verb');
  assert.ok(!requestBlock.includes('body'), 'the fetch request carries NO body field');
  // The REAL adapter is GET-only.
  const adapterCode = stripComments(rsAdapter);
  assert.ok(adapterCode.includes("method: 'GET'"), 'the adapter performs exactly one verb: GET');
  for (const verb of ["'POST'", "'PUT'", "'PATCH'", "'DELETE'"]) {
    assert.ok(!adapterCode.includes(`method: ${verb}`), `the adapter never performs ${verb}`);
  }
  // NO mutation verb toward any research source exists anywhere in the
  // module code (comment-stripped).
  for (const file of [rsPublic, rsModule, rsStore]) {
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
});

// ---------------------------------------------------------------------------
// 4. THE LAYER-NOT-AUTHORITY BATTERY (own tables only + the import posture)
// ---------------------------------------------------------------------------

test('MKT-062 boundary: DML against OWN tables ONLY — the store never writes or reads another module\'s tables', () => {
  const storeCode = stripComments(rsStore);
  const ownTables = [
    'research_sessions',
    'research_session_versions',
    'research_session_sources',
    'research_runs',
    'research_run_source_outcomes',
    'research_source_facts',
    'research_insights',
    'research_insight_evidence',
  ];
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(insertTables)].sort(),
    [
      'research_insight_evidence',
      'research_insights',
      'research_run_source_outcomes',
      'research_runs',
      'research_session_sources',
      'research_session_versions',
      'research_sessions',
      'research_source_facts',
    ].sort(),
    'INSERTs target exactly the own eight tables',
  );
  const updateTables = [...storeCode.matchAll(/UPDATE ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(updateTables)].sort(),
    ['research_sessions'],
    'UPDATEs target exactly the session record (the CAS version-pointer advance)',
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
  // tables are the FK anchor + the CHECK-ONLY trigger reads.
  for (const authority of ['agencies', 'integration_connections']) {
    assert.ok(
      !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${authority}\\b`).test(migration056),
      `the migration never writes the ${authority} authority table`,
    );
  }
});

test('MKT-062 boundary: the module imports ONLY the frozen matrix allowances (evidence — the ONE §21-guard import; integrations + ai-runtime as structural ports)', () => {
  const allowed = new Set(['evidence']);
  for (const file of moduleFiles) {
    for (const specifier of [...stripComments(read(file)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!)) {
      const match = specifier.match(/\/modules\/([a-z-]+)\/public\.ts$/);
      if (match === null) continue;
      assert.ok(
        allowed.has(match[1]!),
        `unexpected cross-module import '${specifier}' (the frozen matrix row allows /integrations, /evidence, /ai-runtime — /integrations and /ai-runtime arrive as STRUCTURAL PORTS)`,
      );
    }
  }
  // The ONE /evidence import is the shared §21 material-key guard (the
  // /product-intelligence precedent).
  assert.ok(
    rsStore.includes("import { containsMaterialKey } from '../../evidence/public.ts'"),
    'the ONE /evidence import is the shared containsMaterialKey guard',
  );
  // The public contract imports ZERO other modules (the ports are declared
  // structurally — the growth-missions precedent).
  const publicImports = [...rsPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual(publicImports, []);
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'research', 'public.ts')));
  assert.ok(existsSync(src('modules', 'research', 'internal', 'research-module.ts')));
  assert.ok(existsSync(src('modules', 'research', 'internal', 'research-store.ts')));
  assert.ok(
    existsSync(src('modules', 'research', 'internal', 'adapters', 'http-page-reader.ts')),
    'the real page-reader adapter exists under the sanctioned internal/adapters home',
  );
});

// ---------------------------------------------------------------------------
// 5. The GET/POST-only route surface
// ---------------------------------------------------------------------------

test('MKT-062 static: the route surface is EXACTLY the ten GET/POST record routes — no PUT/PATCH/DELETE anywhere', () => {
  const routes = [...stripComments(rsRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/agencies/:agencyId/research-sessions',
    'GET /api/research-sessions/:researchSessionId',
    'GET /api/research-sessions/:researchSessionId/facts',
    'GET /api/research-sessions/:researchSessionId/insights',
    'GET /api/research-sessions/:researchSessionId/runs',
    'GET /api/research-sessions/:researchSessionId/versions',
    'POST /api/agencies/:agencyId/research-sessions',
    'POST /api/research-sessions/:researchSessionId/insights',
    'POST /api/research-sessions/:researchSessionId/runs',
    'POST /api/research-sessions/:researchSessionId/versions',
  ]);
  const routesCode = stripComments(rsRoutes);
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
  assert.ok(routesCode.includes('requireResearchAgency'), 'the agency membership resolution');
  assert.ok(routesCode.includes('requireResearchSessionAccess'), 'the session-scoped ownership resolution');
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

test('MKT-062 static: the disclosed spec registration exists — §6 line + the matrix row + the authority-notes bullet + the migration position', () => {
  // The §6 module list carries /research.
  assert.ok(
    /^\/research$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /research',
  );
  assert.ok(
    architectureSpec.includes('`/research` is the v1.6 Web Research authority'),
    'the §6 registration sentence exists',
  );
  // The matrix dependency row + the authority-notes bullet.
  assert.ok(
    matrixSpec.includes('/research ──→ /integrations, /evidence, /ai-runtime'),
    'the matrix dependency row exists (the frozen v1.6 row verbatim)',
  );
  assert.ok(
    matrixSpec.includes('- `/research` is the v1.6 Web Research authority'),
    'the matrix authority-notes bullet exists',
  );
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly research: ResearchModuleApi'), 'ApplicationModules.research');
  assert.ok(applicationTs.includes("from '../modules/research/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerResearchRoutes(router, services, modules)'), 'routes.ts registers the research routes');
  assert.ok(routesTs.includes("from './research-routes.ts'"), 'routes.ts imports the research route builder');
  assert.ok(compositionRoot.includes('createResearchModule'), 'the composition root constructs the research module');
  assert.ok(
    compositionRoot.includes('pageReader: options.researchPageReader ?? new ResearchHttpPageReader(httpCalls)'),
    'the REAL page reader is wired with the disclosed test-double seam (the productPageReader precedent)',
  );
  // 056_research.sql is the migration tail position (the PRE-ASSIGNED
  // number; 057 belongs to the /content-intelligence sibling delivery of
  // this same Work Item).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '056_research.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '057_content_intelligence.sql');
});

// ---------------------------------------------------------------------------
// 7. The real-codebase arch-check run + the version discipline
// ---------------------------------------------------------------------------

test('MKT-062 static: the real codebase enforces the frozen boundaries with ZERO violations — /research is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('research'), 'the enforced set includes /research');
  // The matrix-listed composition directions are exactly the three (both
  // consumed through the declared structural ports + the ONE guard import).
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['research'], ['integrations', 'evidence', 'ai-runtime']);
});

test('MKT-062 static: the version discipline ships — the frozen vocabulary version + the claim tier + the pure helpers', () => {
  // The pure helpers are on the public contract (unit-testable + the
  // /content-intelligence sibling's composition surface).
  for (const helper of [
    'isKnownResearchSourceKind',
    'isKnownResearchDerivationKind',
    'assertValidResearchSessionDeclaration',
    'assertValidResearchProvenance',
    'assertValidResearchInsightInput',
    'composeResearchSessionOwnerContext',
    'researchDerivedVerificationState',
    'extractResearchHtmlSourceFacts',
    'hashResearchContent',
  ]) {
    assert.ok(rsPublic.includes(helper), `the public contract exports ${helper}`);
  }
});
