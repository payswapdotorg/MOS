/**
 * MKT-062 static tests — the /content-intelligence domain is structurally
 * correct in the ACTUAL migration, module contract and route surface (pure
 * static analysis, no DB; the product-intelligence-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-062; spec/architecture-v1.6.md
 * §6 — the primary contract; frozen matrix registration
 * /content-intelligence ──→ /evidence, /metrics, /experiments,
 * /integrations, /research — verbatim):
 *   1. migration 057 (the PRE-ASSIGNED number) creates exactly the EIGHT
 *      own tables — OWN tables ONLY, NO evidence/metric/experiment/
 *      research/mission/workflow/execution/playbook/learning/job/
 *      deployment/integration/credential/tenant table (the composed
 *      authorities stay sole; the platform observations become CANONICAL
 *      /evidence records through the /evidence public contract);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the twelve content
 *      formats, the five length units, the fourteen narrative structures,
 *      the four audience-fit signals, the five freshness states, the four
 *      novelty states, the four reuse-risk levels, the eight hypothesis
 *      kinds, the two observation kinds and the three ingestion statuses;
 *   3. THE APPEND-ONLY + SCOPE BATTERY: the append-only UPDATE/DELETE
 *      rejection triggers on every table, the single-supersession fence +
 *      the deferred same-client/same-kind consistency trigger on
 *      hypotheses, and every cross-module FK scope fence (evidence links
 *      same-Client, metric links same-Client, hypothesis candidate links
 *      same-Client, research citations same-AGENCY, experiment references
 *      same-Client — all read CHECK-ONLY);
 *   4. THE HONEST-FRAMING BATTERY (§6): the non-causality framing
 *      constant ships on the public contract; NO experiment verb exists
 *      in the module code (hypotheses are INPUTS to /experiments — at
 *      most a READ-ONLY-validated reference); NO /ai-runtime import
 *      exists (the frozen row lists none);
 *   5. THE READ-ONLY BOUNDARY BATTERY: the integrations structural port
 *      declares getConnection + executeRead ONLY (executeMutation is
 *      structurally absent) — NO mutation toward any platform is
 *      expressible;
 *   6. THE LAYER-NOT-AUTHORITY BATTERY: DML against the module's OWN
 *      tables ONLY, zero reads of another module's tables from the module
 *      code, and the module's /evidence consumption is the public
 *      contract (appendEvidence + getEvidence + resolveEvidenceOwnership)
 *      + the ONE §21 guard import in the store;
 *   7. the ROUTE surface is EXACTLY the eight GET/POST record routes —
 *      no PUT/PATCH/DELETE anywhere in the family (candidates are
 *      append-only: a new observation is a NEW candidate; hypothesis
 *      corrections are NEW superseding records);
 *   8. the spec registration exists: /content-intelligence in
 *      spec/architecture.md §6 + the matrix row + the authority-notes
 *      bullet in spec/module-dependency-matrix.md;
 *      057_content_intelligence.sql is the migration tail (058_platform_health.sql
 *      follows at MKT-066 time — the sibling re-pin).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  CONTENT_INTELLIGENCE_FORMATS,
  CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS,
} from '../../src/modules/content-intelligence/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration057 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '057_content_intelligence.sql'));
const ciPublic = read(src('modules', 'content-intelligence', 'public.ts'));
const ciModule = read(src('modules', 'content-intelligence', 'internal', 'content-intelligence-module.ts'));
const ciStore = read(src('modules', 'content-intelligence', 'internal', 'content-intelligence-store.ts'));
const ciRoutes = read(src('api', 'content-intelligence-routes.ts'));
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
  src('modules', 'content-intelligence', 'public.ts'),
  src('modules', 'content-intelligence', 'internal', 'content-intelligence-module.ts'),
  src('modules', 'content-intelligence', 'internal', 'content-intelligence-store.ts'),
];

// ---------------------------------------------------------------------------
// 1. Migration 057: OWN TABLES ONLY, no authority table
// ---------------------------------------------------------------------------

test('MKT-062: migration 057 creates exactly the eight own tables — OWN tables ONLY (no authority table, no shadow observation ledger)', () => {
  const created = [...migration057.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'content_candidates',
      'content_candidate_evidence',
      'content_candidate_metric_observations',
      'content_hypotheses',
      'content_hypothesis_evidence',
      'content_hypothesis_candidates',
      'content_hypothesis_research_refs',
      'content_observation_ingestion_runs',
    ],
    'own tables ONLY — the durable candidate/hypothesis layer; /evidence (015), /metrics (018), /experiments (019), /research (056) and the tenant tables stay the sole authorities (the platform observations become CANONICAL /evidence records through the /evidence public contract — never a shadow ledger here)',
  );

  // The candidate record's frozen columns (the §6 observed-feature set).
  const candidateColumns = columnsOf(createTableBlock(migration057, 'content_candidates'));
  for (const required of [
    'content_candidate_id', 'client_id', 'workspace_id', 'topic_entity', 'niche', 'sub_niche',
    'content_format', 'length_value', 'length_unit', 'hook_features', 'narrative_structure',
    'published_at', 'observed_performance', 'performance_velocity', 'engagement',
    'audience_fit', 'freshness_state', 'novelty_state', 'reuse_risk',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(candidateColumns.includes(required), `content_candidates must carry '${required}'`);
  }
  // The hypothesis record's frozen columns.
  const hypothesisColumns = columnsOf(createTableBlock(migration057, 'content_hypotheses'));
  for (const required of [
    'content_hypothesis_id', 'client_id', 'workspace_id', 'hypothesis_kind', 'statement',
    'supersedes_content_hypothesis_id', 'experiment_id',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'created_at',
  ]) {
    assert.ok(hypothesisColumns.includes(required), `content_hypotheses must carry '${required}'`);
  }
  // The ingestion run record's frozen columns (the honest outcome + the
  // appended evidence ids).
  const runColumns = columnsOf(createTableBlock(migration057, 'content_observation_ingestion_runs'));
  for (const required of [
    'ingestion_run_id', 'client_id', 'workspace_id', 'connection_id', 'observation_kind',
    'operation', 'status', 'records_observed', 'evidence_appended', 'appended_evidence_ids',
    'started_at', 'finished_at', 'detail',
  ]) {
    assert.ok(runColumns.includes(required), `content_observation_ingestion_runs must carry '${required}'`);
  }

  // NO authority table is created and NO shadow observation ledger exists
  // (exact-name matching — the own link tables legitimately contain
  // 'evidence'/'research' as name fragments).
  const authorityTableNames = [
    'evidence', 'metric_observations', 'experiments', 'research_sessions',
    'research_insights', 'research_source_facts', 'growth_missions',
    'workflow_instances', 'executions', 'playbooks', 'learnings', 'jobs',
    'deployments', 'integration_connections', 'credentials', 'clients',
  ];
  for (const forbidden of authorityTableNames) {
    assert.ok(
      !created.includes(forbidden),
      `the authority table '${forbidden}' may not be created here (the composed authorities stay sole)`,
    );
  }
  // No secret-material column anywhere (§21 posture).
  for (const table of created) {
    assert.ok(
      !/secret|password|token|api_key/.test(columnsOf(createTableBlock(migration057, table)).join(',')),
      `${table} carries no material-shaped column`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the database fences
// ---------------------------------------------------------------------------

test('MKT-062 static: the §6 observed-feature vocabularies are CHECK-fenced (the ci-vocab-v1 storage mirror)', () => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ');
  const candidateBlock = normalize(createTableBlock(migration057, 'content_candidates'));
  const formatList = CONTENT_INTELLIGENCE_FORMATS.map((format) => `'${format}'`).join(', ');
  assert.ok(
    candidateBlock.includes(formatList),
    'content_candidates CHECK-fences the full twelve-format content vocabulary',
  );
  for (const [fragment, label] of [
    ["'seconds', 'minutes', 'hours', 'words', 'items'", 'the length-unit vocabulary'],
    ["'strong_fit', 'moderate_fit', 'weak_fit', 'unclear'", 'the audience-fit vocabulary'],
    ["'breaking', 'recent', 'established', 'evergreen', 'dated'", 'the freshness vocabulary'],
    ["'novel', 'variation', 'common', 'saturated'", 'the novelty vocabulary'],
    ["'low', 'medium', 'high', 'unclear'", 'the reuse-risk vocabulary'],
  ] as const) {
    assert.ok(candidateBlock.includes(fragment), `${label} is CHECK-fenced`);
  }
  // The narrative-structure vocabulary.
  const narrativeFragment = "'problem_solution', 'tutorial', 'listicle', 'story_arc', 'before_after', 'myth_busting', 'comparison', 'behind_the_scenes', 'interview', 'commentary', 'reaction', 'case_study', 'news_report', 'entertainment_bit'";
  assert.ok(
    candidateBlock.includes(narrativeFragment),
    'the narrative-structure vocabulary is CHECK-fenced',
  );
  // The length pair shape fence.
  assert.ok(
    candidateBlock.includes('CONSTRAINT content_candidates_length_shape CHECK'),
    'the length both-or-neither shape fence exists',
  );
  // The hook-features bounded array.
  assert.ok(
    candidateBlock.includes("jsonb_array_length(hook_features) <= 8"),
    'the hook-features array is bounded at 8 items',
  );
  // The hypothesis-kind vocabulary + the REQUIRED statement summary.
  const hypothesisBlock = normalize(createTableBlock(migration057, 'content_hypotheses'));
  const kindList = CONTENT_INTELLIGENCE_HYPOTHESIS_KINDS.map((kind) => `'${kind}'`).join(', ');
  assert.ok(
    hypothesisBlock.includes(kindList),
    'content_hypotheses CHECK-fences the full eight-kind hypothesis vocabulary',
  );
  assert.ok(
    hypothesisBlock.includes("statement ? 'summary'"),
    'hypothesis statements REQUIRE a summary',
  );
  // The observation-kind + ingestion-status vocabularies.
  const runBlock = normalize(createTableBlock(migration057, 'content_observation_ingestion_runs'));
  assert.ok(
    runBlock.includes("'platform_content', 'platform_analytics'"),
    'the observation-kind vocabulary is CHECK-fenced',
  );
  assert.ok(
    runBlock.includes("'completed', 'refused', 'failed'"),
    'the ingestion-status vocabulary is CHECK-fenced',
  );
  assert.ok(
    runBlock.includes('evidence_appended = jsonb_array_length(appended_evidence_ids)'),
    'the honest counts discipline is CHECK-fenced',
  );
});

// ---------------------------------------------------------------------------
// 3. THE APPEND-ONLY + SCOPE BATTERY
// ---------------------------------------------------------------------------

test('MKT-062 static: the append-only battery, the supersession fence and every cross-module scope fence exist', () => {
  // APPEND-ONLY: every table rejects UPDATE and DELETE outright.
  for (const table of [
    'content_candidates',
    'content_candidate_evidence',
    'content_candidate_metric_observations',
    'content_hypotheses',
    'content_hypothesis_evidence',
    'content_hypothesis_candidates',
    'content_hypothesis_research_refs',
    'content_observation_ingestion_runs',
  ]) {
    assert.ok(
      migration057.includes(`CREATE TRIGGER ${table}_append_only_update_trigger`) ||
        migration057.includes(`CREATE TRIGGER ${table.replace('content_candidate_metric_observations', 'content_candidate_metric_links')}_append_only_update_trigger`),
      `${table} rejects UPDATE`,
    );
    assert.ok(
      migration057.includes(`CREATE TRIGGER ${table}_append_only_delete_trigger`) ||
        migration057.includes(`CREATE TRIGGER ${table.replace('content_candidate_metric_observations', 'content_candidate_metric_links')}_append_only_delete_trigger`),
      `${table} rejects DELETE`,
    );
  }
  assert.ok(
    migration057.includes('content candidates are append-only'),
    'the candidate append-only rejection message is explicit',
  );
  assert.ok(
    migration057.includes('content hypotheses are append-only'),
    'the hypothesis append-only rejection message is explicit',
  );
  // THE SINGLE-SUPERSESSION FENCE (the migration 015 /evidence pattern).
  assert.ok(
    migration057.includes('CREATE UNIQUE INDEX IF NOT EXISTS content_hypothesis_supersession_fence'),
    'the single-supersession partial-unique fence exists',
  );
  assert.ok(
    migration057.includes('CREATE CONSTRAINT TRIGGER content_hypothesis_supersession_trigger'),
    'the supersession consistency is a DEFERRABLE constraint trigger (commit-time)',
  );
  assert.ok(
    migration057.includes('a correction never changes its subject'),
    'the same-kind supersession rule is explicit',
  );
  // THE SCOPE FENCES: every cross-module FK link is scoped.
  for (const [fn, label] of [
    ['content_candidate_evidence_scope_consistent', 'the candidate evidence scope fence'],
    ['content_candidate_metric_scope_consistent', 'the candidate metric scope fence'],
    ['content_hypothesis_evidence_scope_consistent', 'the hypothesis evidence scope fence'],
    ['content_hypothesis_candidates_scope_consistent', 'the hypothesis candidate scope fence'],
    ['content_hypothesis_research_scope_consistent', 'the hypothesis research-citation same-AGENCY fence'],
    ['content_hypothesis_experiment_scope_consistent', 'the hypothesis experiment scope fence'],
  ] as const) {
    assert.ok(
      migration057.includes(`CREATE OR REPLACE FUNCTION ${fn}()`),
      `${label} exists`,
    );
  }
  assert.ok(
    migration057.includes("evidence references stay inside one client"),
    'the same-Client evidence rejection is explicit',
  );
  assert.ok(
    migration057.includes("research insight citations stay inside the client''s agency"),
    'the same-AGENCY research-citation rejection is explicit',
  );
  // The canonical client reference is FK-anchored.
  assert.ok(
    migration057.includes('client_id             uuid        NOT NULL REFERENCES clients(client_id)'),
    'the candidate FK-anchors the canonical client reference',
  );
  // The evidence/metric/experiment/research FK anchors are read CHECK-ONLY.
  for (const authority of ['evidence', 'metric_observations', 'experiments', 'research_insights', 'integration_connections']) {
    assert.ok(
      !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${authority}\\b`).test(migration057),
      `the migration never writes the ${authority} authority table`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. THE HONEST-FRAMING BATTERY (§6) + the no-/ai-runtime rule
// ---------------------------------------------------------------------------

test('MKT-062 §6 boundary: the HONEST FRAMING ships on the contract — NO experiment verb, NO /ai-runtime import', () => {
  // The §6 non-claim framing constant ships on the public contract.
  assert.ok(
    ciPublic.includes('CONTENT_INTELLIGENCE_HYPOTHESIS_FRAMING'),
    'the hypothesis framing constant ships on the public contract',
  );
  assert.ok(
    ciPublic.includes('does not by itself establish causality'),
    'the framing carries §6\'s explicit non-claim',
  );
  // NO experiment verb exists in the module code: hypotheses are INPUTS to
  // /experiments — the experiment reference is validated READ-ONLY.
  const moduleCodeAll = stripComments(`${ciPublic}\n${ciModule}\n${ciStore}`);
  for (const forbidden of [
    'createExperiment',
    'applyExperimentTransition',
    'transitionExperiment',
    'declareExperiment',
  ]) {
    assert.ok(
      !moduleCodeAll.includes(forbidden),
      `the module code must never contain the experiment verb '${forbidden}' — /experiments stays the sole experiment identity/design authority (the reference is validated READ-ONLY through getExperiment)`,
    );
  }
  // NO /ai-runtime import exists (the frozen row lists none; AI-derived
  // research claims arrive as /research insight citations whose own
  // AI-discipline disclosures ride the research records).
  for (const file of moduleFiles) {
    for (const specifier of [...stripComments(read(file)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!)) {
      assert.ok(
        !specifier.includes('/ai-runtime/'),
        `no /ai-runtime import may exist (the frozen row lists none) — found '${specifier}'`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. THE READ-ONLY BOUNDARY BATTERY
// ---------------------------------------------------------------------------

test('MKT-062 §6 boundary: the READ-ONLY observation contract — NO mutation surface toward any platform', () => {
  // The integrations structural port declares getConnection + executeRead
  // ONLY: executeMutation is STRUCTURALLY ABSENT.
  const portBlock = ciPublic.slice(
    ciPublic.indexOf('export interface ContentIntelligenceIntegrationsPort'),
    ciPublic.indexOf('// ---------------------------------------------------------------------------\n// Canonical owner context'),
  );
  assert.ok(portBlock.includes('getConnection'), 'the port declares getConnection');
  assert.ok(portBlock.includes('executeRead'), 'the port declares executeRead');
  assert.ok(
    !portBlock.includes('executeMutation'),
    'the port declares NO executeMutation — the read-only guarantee is a compile-time property',
  );
  // NO mutation verb toward any platform exists anywhere in the module
  // code (comment-stripped).
  for (const file of [ciPublic, ciModule, ciStore]) {
    const code = stripComments(file);
    assert.ok(
      !code.includes('executeMutation'),
      'the module never calls executeMutation (the port cannot even express it)',
    );
    assert.ok(
      !code.includes('registerConnection'),
      'the module never registers connections',
    );
  }
});

// ---------------------------------------------------------------------------
// 6. THE LAYER-NOT-AUTHORITY BATTERY (own tables only + the import posture)
// ---------------------------------------------------------------------------

test('MKT-062 boundary: DML against OWN tables ONLY — the store never writes or reads another module\'s tables', () => {
  const storeCode = stripComments(ciStore);
  const ownTables = [
    'content_candidates',
    'content_candidate_evidence',
    'content_candidate_metric_observations',
    'content_hypotheses',
    'content_hypothesis_evidence',
    'content_hypothesis_candidates',
    'content_hypothesis_research_refs',
    'content_observation_ingestion_runs',
  ];
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(insertTables)].sort(),
    ownTables.slice().sort(),
    'INSERTs target exactly the own eight tables',
  );
  const updateTables = [...storeCode.matchAll(/UPDATE ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(updateTables)].sort(),
    [],
    'UPDATEs never happen (candidates AND hypotheses are append-only — a new observation is a NEW candidate; a hypothesis correction is a NEW superseding record)',
  );
  assert.ok(
    !/\bDELETE FROM\b/i.test(storeCode),
    'the store never issues a DELETE (every table is append-only)',
  );
  // Every FROM target is an own table (every cross-module read composes
  // the /evidence + /metrics + /experiments + /research public contracts).
  const selectTables = [...storeCode.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]!);
  for (const table of selectTables) {
    assert.ok(
      ownTables.includes(table),
      `the store may only read the own tables — found FROM ${table} (cross-module reads compose the /evidence + /metrics + /experiments + /research public contracts)`,
    );
  }
});

test('MKT-062 boundary: the module imports EXACTLY the five frozen matrix allowances through their public contracts', () => {
  const allowed = new Set(['evidence', 'metrics', 'experiments', 'research']);
  const found = new Set<string>();
  for (const file of moduleFiles) {
    for (const specifier of [...stripComments(read(file)).matchAll(/from '([^']+)'/g)].map((m) => m[1]!)) {
      // Relative cross-module public-contract imports (the own module's
      // '../public.ts' does not match: '..' is not a module segment).
      const match = specifier.match(/([a-z][a-z-]*)\/public\.ts$/);
      if (match === null || match[1] === 'platform') continue;
      found.add(match[1]!);
      assert.ok(
        allowed.has(match[1]!),
        `unexpected cross-module import '${specifier}' (the frozen matrix row allows /evidence, /metrics, /experiments, /integrations, /research — /integrations arrives as a STRUCTURAL PORT)`,
      );
    }
  }
  // All four importable allowances are exercised (the /integrations
  // direction is the structural port — no import).
  for (const expected of ['evidence', 'metrics', 'experiments', 'research']) {
    assert.ok(
      found.has(expected),
      `the ${expected} public contract is consumed (the /research direction is the sibling module of this same Work Item)`,
    );
  }
  // The ONE /evidence guard import lives in the store (the §21 backstop).
  assert.ok(
    ciStore.includes("import { containsMaterialKey } from '../../evidence/public.ts'"),
    'the ONE /evidence guard import is the shared containsMaterialKey backstop',
  );
  // The /evidence direction is consumed as the SOLE evidence authority:
  // the observation ingestion APPENDS canonical evidence records.
  assert.ok(
    stripComments(ciModule).includes('appendEvidence'),
    'the observation ingestion appends canonical /evidence records (the sole evidence authority)',
  );
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'content-intelligence', 'public.ts')));
  assert.ok(existsSync(src('modules', 'content-intelligence', 'internal', 'content-intelligence-module.ts')));
  assert.ok(existsSync(src('modules', 'content-intelligence', 'internal', 'content-intelligence-store.ts')));
});

// ---------------------------------------------------------------------------
// 7. The GET/POST-only route surface
// ---------------------------------------------------------------------------

test('MKT-062 static: the route surface is EXACTLY the eight GET/POST record routes — no PUT/PATCH/DELETE anywhere', () => {
  const routes = [...stripComments(ciRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/clients/:clientId/content-intelligence/candidates',
    'GET /api/clients/:clientId/content-intelligence/hypotheses',
    'GET /api/clients/:clientId/content-intelligence/ingestion-runs',
    'GET /api/content-candidates/:contentCandidateId',
    'GET /api/content-hypotheses/:contentHypothesisId',
    'POST /api/clients/:clientId/content-intelligence/candidates',
    'POST /api/clients/:clientId/content-intelligence/hypotheses',
    'POST /api/clients/:clientId/content-intelligence/ingestion-runs',
  ]);
  const routesCode = stripComments(ciRoutes);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !routesCode.includes(`'${verb}'`),
      `the route file never registers the verb '${verb}' (candidates are append-only; hypothesis corrections are NEW superseding records)`,
    );
  }
  // The fail-closed posture helpers exist (uniform 404 + the client-scope
  // authorization).
  assert.ok(routesCode.includes('NotFoundError'), 'the uniform 404 error class');
  assert.ok(routesCode.includes('requireClientAccess'), 'the client-scoped ownership resolution');
  assert.ok(routesCode.includes('serverProvenance'), 'the server-derived provenance composer');
  assert.ok(routesCode.includes('forbiddenKeys'), 'the authority-field DTO rejection');
});

// ---------------------------------------------------------------------------
// 8. The spec registration + the version discipline
// ---------------------------------------------------------------------------

test('MKT-062 static: the disclosed spec registration exists — §6 line + the matrix row + the authority-notes bullet + the migration tail', () => {
  // The §6 module list carries /content-intelligence.
  assert.ok(
    /^\/content-intelligence$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /content-intelligence',
  );
  assert.ok(
    architectureSpec.includes('`/content-intelligence` is the v1.6 Content Intelligence authority'),
    'the §6 registration sentence exists',
  );
  // The matrix dependency row + the authority-notes bullet.
  assert.ok(
    matrixSpec.includes('/content-intelligence ──→ /evidence, /metrics, /experiments, /integrations, /research'),
    'the matrix dependency row exists (the frozen v1.6 row verbatim)',
  );
  assert.ok(
    matrixSpec.includes('- `/content-intelligence` is the v1.6 Content Intelligence authority'),
    'the matrix authority-notes bullet exists',
  );
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly contentIntelligence: ContentIntelligenceModuleApi'), 'ApplicationModules.contentIntelligence');
  assert.ok(applicationTs.includes("from '../modules/content-intelligence/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerContentIntelligenceRoutes(router, services, modules)'), 'routes.ts registers the content-intelligence routes');
  assert.ok(routesTs.includes("from './content-intelligence-routes.ts'"), 'routes.ts imports the content-intelligence route builder');
  assert.ok(compositionRoot.includes('createContentIntelligenceModule'), 'the composition root constructs the content-intelligence module');
  assert.ok(
    compositionRoot.includes('crossPlatformDistribution, research, contentIntelligence, platformHealth },'),
    'the composition-root modules adjacency registers research + contentIntelligence',
  );
  // 057_content_intelligence.sql is the migration tail (the PRE-ASSIGNED
  // number).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '057_content_intelligence.sql');
  // The MKT-066 sibling delivery appends 058_platform_health.sql (the
  // PRE-ASSIGNED number — every tail position shifts once more; the same
  // additive re-pin precedent).
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '058_platform_health.sql');
});

test('MKT-062 static: the real codebase enforces the frozen boundaries with ZERO violations — /content-intelligence is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('content-intelligence'), 'the enforced set includes /content-intelligence');
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['content-intelligence'], [
    'evidence', 'metrics', 'experiments', 'integrations', 'research',
  ]);
});

test('MKT-062 static: the version discipline ships — the frozen vocabularies + the deterministic calculation versions + the pure helpers', () => {
  for (const helper of [
    'isKnownContentIntelligenceFormat',
    'isKnownContentIntelligenceHypothesisKind',
    'assertValidContentCandidateFeatures',
    'assertValidContentHypothesisInput',
    'assertValidContentIntelligenceProvenance',
    'composeContentCandidateOwnerContext',
    'clusterContentCandidatesByNiche',
    'rankContentCandidates',
  ]) {
    assert.ok(ciPublic.includes(helper), `the public contract exports ${helper}`);
  }
});
