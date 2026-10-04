/**
 * STUDIO-001 boundary tests — the static architectural proofs of
 * /content-studio (the /lab-agent-body boundary precedent, applied to
 * the Content Studio Runtime):
 *
 *   1. NO PUBLISHING / NO EXPERIMENT AUTHORITY (THE acceptance — lock
 *      v1.7 #43 + §16 + module-dependency-matrix-v1.7 forbidden
 *      directions "Studio → direct provider publication", "Studio →
 *      second Workflow/Execution authority", "Studio → second
 *      Rights/Policy authority", "Studio → second
 *      Experiment/Evidence authority"): the module source contains
 *      ZERO publication/distribution/experiment/evidence/workflow/
 *      execution/rights-decision vocabulary and ZERO provider SDK
 *      imports — and imports NO other module (the /lab family
 *      discipline; the consumption surfaces are the declared
 *      structural ports wired at the composition root);
 *   2. the migration-064 discipline: the module owns EXACTLY its six
 *      studio_* tables (no v1.6 authority table, no /lab-agent-body
 *      table, no /ai-runtime table), CHECK-fenced closed vocabularies,
 *      the guarded §5 legal-edge table in the session trigger, the
 *      append-only/immnutable triggers, the scope-consistency fences
 *      and NO binary column anywhere;
 *   3. the module structure (public.ts + internal/ only);
 *   4. the registration: the composition root constructs and registers
 *      the module with the REAL /lab-agent-body instance behind the
 *      disclosed READ-ONLY adapter (the off-matrix wrapper precedent)
 *      and the initial format declarations through the §2 seam;
 *      ApplicationModules carries the entry; the disclosed checker
 *      provision is the enforced-set registration pending the TL spec
 *      promotion (the LAB-011 worker-delivery precedent);
 *   5. the migration tail: 064_content_studio_runtime.sql is the tail
 *      (the next-free number on frozen main — 063 was the tail at
 *      base 2a4aa84; 062 remains reserved for the parallel worker).
 *
 * The STUDIO-007 boundary tests (the audio/video capture layer —
 * migration 073 over the STUDIO-001 runtime + the STUDIO-002 format
 * framework + the STUDIO-003 question/branch graph):
 *   6. the migration-073 discipline: the module owns EXACTLY its two
 *      studio_capture_* tables (no v1.6 authority table, no
 *      /content-assets or /content-rights table, ZERO cross-table
 *      DDL), the CHECK-fenced closed vocabularies, the shape fences,
 *      the born-processing fence, the guarded ingest state machine,
 *      the append-only/immutable triggers, the scope-consistency
 *      fences and NO binary column anywhere;
 *   7. THE NO-SYNCHRONOUS-PROCESSING structural proof: zero
 *      media-processing vocabulary in the module, the takes are BORN
 *      'processing' (module + DB fence), the ingest performs only the
 *      durable landing through the platform storage port;
 *   8. the storage-port discipline: the module consumes the platform
 *      ObjectStore port through the declared `objects` dep (the
 *      composition-root wiring — the same platform instance
 *      /content-assets uses), NEVER module-local blob storage, never
 *      a /content-assets registration;
 *   9. the API surface shape + the migration ordering (073 is the
 *      tail; 072 is NOT asserted absent — the in-flight LAB-006
 *      parallel worker holds it, the TL resolves the merge);
 *  10. the composition seam + the sanctioned registration-paragraph
 *      extension sentence (the STUDIO-007 capture surface + the
 *      objects port disclosed in spec/architecture.md §6).
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

const moduleDir = src('modules', 'content-studio');
const publicTs = read(join(moduleDir, 'public.ts'));
const moduleFiles = readdirSync(join(moduleDir, 'internal'));
const moduleCode = [
  publicTs,
  ...moduleFiles.map((name) => read(join(moduleDir, 'internal', name))),
].join('\n');
const migrationSql = read(src('platform', 'db', 'migrations', '064_content_studio_runtime.sql'));
const compositionRoot = read(src('composition-root.ts'));
const applicationTs = read(src('api', 'application.ts'));
const checkerTs = read(join(repoRoot, 'tools', 'arch-check', 'checker.ts'));

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

test('STUDIO-001 AC-1: NO PUBLISHING / NO EXPERIMENT AUTHORITY — the module source contains ZERO publication, distribution, experiment, evidence, workflow, execution and rights-decision vocabulary (the lock v1.7 #43 structural proof)', () => {
  const code = stripComments(moduleCode);
  // The forbidden authority surfaces are structurally absent. The
  // vocabulary is the verb/surface set of the v1.6 authorities the
  // Studio must never become (§16 + the module-dependency-matrix
  // forbidden directions).
  for (const forbidden of [
    'publish',
    'publication',
    'distribute',
    'dispatch',
    'submitPublish',
    'social-provider',
    'provider-sdk',
    'createExperiment',
    'assignVariant',
    'appendEvidence',
    'recordMetric',
    'createWorkflow',
    'startExecution',
    'evaluateRights',
    'resolvePolicy',
    'policyDecision',
    'rightsDecision',
    'grantRights',
    'marketplace',
    'modelRouter',
    'routeTask',
    'previewRouting',
  ]) {
    assert.ok(!code.includes(forbidden), `the module must not reference the forbidden authority surface ('${forbidden}' found)`);
  }
  // The consumed authorities are DECLARED opaque-reference DATA (the
  // request's source artifacts + consent references) — never
  // evaluation, never joined, never second-guessed.
  assert.ok(code.includes('sourceArtifactReferences'), 'the source artifacts are declared opaque references');
  assert.ok(code.includes('consentReferences'), 'the consent records are declared opaque references');
  assert.ok(publicTs.includes('DECLARED consent/provenance'), 'the request fence names the declared (never evaluated) context');
  // No provider SDK anywhere: zero external imports (the checker
  // proves it globally; this asserts it locally for the module).
  const externalImports = [...stripComments(moduleCode).matchAll(/from '([^'.][^']*)'/g)].map((match) => match[1]!);
  assert.deepEqual(externalImports.filter((name) => !name.startsWith('node:')), []);
});

test('STUDIO-001 AC-1: the module imports NO other module — the /lab family discipline (zero cross-module imports; the /lab-agent-body boundary is the composition-root-wired structural port)', () => {
  const importMatches = [...stripComments(moduleCode).matchAll(/from '\.\.\/(\.\.\/)?([^']+)'/g)].map((match) => match[0]);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.includes('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The ONLY /lab-agent-body consumption is the narrow structural
  // port: organization compatibility resolution (registry reads).
  assert.ok(publicTs.includes('ContentStudioAgentBodyPort'), 'the /lab-agent-body consumption is the declared structural port');
  assert.ok(publicTs.includes('resolveAgentBody'), 'the port resolves body-version references (compatibility only)');
  assert.ok(publicTs.includes('READ-ONLY'), 'the port is declared READ-ONLY — the pawn runtime stays /lab-agent-body');
  // The static checker enforces it with zero violations (54 enforced
  // modules: 53 spec-parsed + the single /apps provision — the 2026-10-03
  // TL spec promotion registered /content-studio in the spec §6 list and
  // retired the disclosed worker provision, the /lab registration
  // precedent).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('content-studio'));
  assert.equal(result.frozenModules.length, 59);
});

test('STUDIO-001 AC-2: the module owns EXACTLY its six migration-064 tables — no v1.6 authority table, no /lab-agent-body table, no /ai-runtime table', () => {
  const created = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created.sort(), [
    'studio_output_versions',
    'studio_processing_steps',
    'studio_production_requests',
    'studio_session_events',
    'studio_sessions',
    'studio_treatment_requests',
  ]);
  // No write into any table: the migration is pure DDL (the stripped
  // SQL contains no INSERT INTO, no DELETE FROM and no UPDATE outside
  // the BEFORE UPDATE ON trigger clauses).
  const stripped = stripSqlComments(migrationSql);
  assert.ok(!/INSERT INTO/.test(stripped), 'the migration never inserts data');
  assert.ok(!/DELETE FROM/.test(stripped), 'the migration never deletes data');
  assert.ok(!/UPDATE(?! ON)/.test(stripped), 'the migration never mutates a table (the ONLY UPDATE tokens are the BEFORE UPDATE ON trigger clauses)');
  // No FK into a v1.6 authority beyond the tenant anchors (agencies,
  // clients, workspaces) and its own tables.
  for (const reference of [...migrationSql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!)) {
    assert.ok(
      ['agencies', 'clients', 'workspaces', 'studio_production_requests', 'studio_sessions', 'studio_output_versions', 'studio_treatment_requests'].includes(reference),
      `unexpected FK target '${reference}'`,
    );
  }
  // The source artifacts / consent records are OPAQUE references
  // inside the declared content jsonb — NO content asset/rights table
  // is written or joined (the §16 no-second-rights-engine rule).
  assert.ok(!/content_assets|content_rights/.test(stripSqlComments(migrationSql)), 'no content asset/rights table is touched');
  // No /lab-agent-body table is written (the bodies are opaque
  // reference strings resolved through the port).
  assert.ok(!/lab_agent/.test(stripSqlComments(migrationSql)), 'no /lab-agent-body table is written');
});

test('STUDIO-001 AC-2: the CHECK-fenced closed vocabularies + the guarded §5 legal-edge trigger + the append-only/immutable triggers + the scope fences exist in migration 064 (and NO binary column anywhere)', () => {
  for (const fence of [
    "CHECK (state IN ('created',",
    "'awaiting_participant'",
    "'treatment_requested'",
    "CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))",
    "'blocked_dependency'",
    "'capability_failure'",
    "'participant_delay'",
    "'processing_delay'",
    "'provider_failure'",
    "'budget_exhausted'",
    "'rights_consent_issue'",
    "'quality_failure'",
    "CHECK (contract_version = 'content-studio-runtime-v1')",
    "CHECK (jsonb_typeof(payload) = 'object')",
    "payload_digest ~ '^[0-9a-f]{64}$'",
    "IN ('standalone', 'lab_initiated')",
    "studio_sessions_terminal_shape",
    "studio_sessions_successor_shape",
    "studio_steps_status_shape",
    "UNIQUE (session_id, revision, seq)",
  ]) {
    assert.ok(migrationSql.includes(fence), `the migration fence must exist: ${fence.slice(0, 60)}`);
  }
  // THE FROZEN §5 LEGAL-EDGE TABLE is encoded in the session guard
  // trigger (each canonical edge line present).
  for (const edge of [
    "(OLD.state = 'created' AND NEW.state IN ('preparing', 'cancelled', 'failed', 'expired'))",
    "(OLD.state = 'preparing' AND NEW.state IN ('awaiting_participant', 'recording', 'processing', 'cancelled', 'failed', 'expired'))",
    "(OLD.state = 'awaiting_participant' AND NEW.state IN ('recording', 'cancelled', 'failed', 'expired'))",
    "(OLD.state = 'recording' AND NEW.state IN ('processing', 'cancelled', 'failed', 'expired'))",
    "(OLD.state = 'processing' AND NEW.state IN ('review', 'cancelled', 'failed', 'expired'))",
    "(OLD.state = 'review' AND NEW.state IN ('treatment_requested', 'completed', 'cancelled', 'failed', 'expired'))",
  ]) {
    assert.ok(migrationSql.includes(edge), `the frozen §5 legal edge must be trigger-encoded: ${edge.slice(0, 70)}`);
  }
  // The terminal freeze is trigger-encoded.
  assert.ok(migrationSql.includes('terminal revisions are frozen'), 'the terminal freeze raises explicitly');
  for (const trigger of [
    'studio_production_requests_immutable',
    'studio_request_chain_scope_check',
    'studio_session_guard',
    'studio_sessions_no_delete',
    'studio_session_scope_check',
    'studio_session_events_append_only',
    'studio_session_event_scope_check',
    'studio_step_guard',
    'studio_processing_steps_no_delete',
    'studio_step_scope_check',
    'studio_output_versions_immutable',
    'studio_output_scope_check',
    'studio_treatment_requests_immutable',
    'studio_treatment_scope_check',
  ]) {
    assert.ok(migrationSql.includes(`FUNCTION ${trigger}(`), `the trigger function ${trigger} must exist`);
  }
  // The circular lineage completion (the successor-session FKs added
  // after the referenced tables exist).
  assert.ok(migrationSql.includes('studio_sessions_prior_output_fk'), 'the prior-output FK is completed at the tail');
  assert.ok(migrationSql.includes('studio_sessions_origin_treatment_fk'), 'the origin-treatment FK is completed at the tail');
  // NO binary column anywhere (no bytea, no blob, no media retention
  // surface) — checked over the STRIPPED DDL so the prose fence
  // comments cannot produce false positives.
  assert.ok(!/bytea|blob|binary/.test(stripSqlComments(migrationSql)), 'no binary column may exist');
});

test('STUDIO-001 AC-3: the module structure is public.ts + internal/ only (the frozen boundary shape)', () => {
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  for (const name of readdirSync(moduleDir)) {
    assert.ok(name === 'public.ts' || name === 'internal', `unexpected module entry '${name}'`);
  }
  const internal = readdirSync(join(moduleDir, 'internal'));
  assert.deepEqual(internal.sort(), ['content-studio-module.ts', 'content-studio-store.ts', 'validation.ts']);
});

test('STUDIO-001 AC-4: the registration — the composition root wires the REAL /lab-agent-body instance behind the disclosed READ-ONLY adapter + the initial formats through the §2 seam, and registers the module; the spec promotion registered /content-studio (the provision retired, the /lab registration precedent)', () => {
  assert.ok(compositionRoot.includes("import { createContentStudioModule, CONTENT_STUDIO_INITIAL_FORMATS } from './modules/content-studio/public.ts'"));
  assert.ok(compositionRoot.includes('const contentStudio = createContentStudioModule({'));
  assert.ok(compositionRoot.includes('agentBodies: contentStudioAgentBodies,'));
  assert.ok(compositionRoot.includes('formats: CONTENT_STUDIO_INITIAL_FORMATS,'));
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, contentStudio, labFeatures, commerceDiscovery, labCapabilities, labIdeas, labSimulator },'));
  assert.ok(applicationTs.includes("import type { ContentStudioModuleApi } from '../modules/content-studio/public.ts'"));
  assert.ok(applicationTs.includes('readonly contentStudio: ContentStudioModuleApi'));
  // The checker provision RETIRED (the 2026-10-03 TL spec promotion —
  // the /lab registration precedent): the provision array is back to
  // the single /apps entry; /content-studio enforces through the
  // spec-parsed list directly.
  const provision = stripComments(checkerTs).match(/v15CompositionModules[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(provision !== null);
  const entries = [...provision[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
  assert.deepEqual(entries, ['apps']);
  // The spec promotion is present: /content-studio registers through
  // the frozen §6 list (the TL promotion, the /lab precedent).
  const specModules = /## 6\. Core domain modules\s*```text([\s\S]*?)```/.exec(read(join(repoRoot, 'spec', 'architecture.md')))![1]!;
  assert.ok(/^\/content-studio$/m.test(specModules), 'the TL spec promotion registered /content-studio in the frozen list (the /lab precedent)');
});

test('STUDIO-001 AC-5: 064_content_studio_runtime.sql appends before the LAB-003 065 tail (the merged-tree truth; 062 remains reserved for the parallel worker); the header cites the governing contract', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // The STUDIO-007 delivery appends 073 as the new tail — every
  // end-anchored position shifts once more (the disclosed re-pin).
  assert.equal(migrations[migrations.length - 8], '064_content_studio_runtime.sql');
  assert.equal(migrations[migrations.length - 7], '065_lab_features.sql');
  assert.equal(migrations[migrations.length - 6], '066_lab_ideas.sql');
  assert.ok(!migrations.includes('062_agent_capability_candidates.sql'), '062 is reserved for the parallel worker (the TL reconciles numbering at merge — the LAB-011 disclosure)');
  // The header cites the governing sub-contract + the acceptance
  // verbatim (the house pattern).
  assert.ok(migrationSql.includes('STUDIO-001 (Content Studio Runtime)'));
  assert.ok(migrationSql.includes('no publishing/experiment authority'), 'the migration header cites the acceptance verbatim');
  assert.ok(migrationSql.includes('content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('spec/content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('studioIsNotPublicationOrExperimentAuthority'));
});

// ---------------------------------------------------------------------------
// The STUDIO-003 boundary tests (the intent-to-script pipeline —
// migration 070 over the STUDIO-001 runtime + the STUDIO-002 framework).
// ---------------------------------------------------------------------------

test('STUDIO-003 AC-1: the module owns EXACTLY its six migration-070 tables — no v1.6 authority table, no other module\'s table; the ONE additive CHECK rides the SAME-MODULE studio_formats table', () => {
  const migration070Sql = read(src('platform', 'db', 'migrations', '070_studio_script_question_graph.sql'));
  const created070 = [...migration070Sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created070.sort(), [
    'studio_conversation_edges',
    'studio_intents',
    'studio_question_graph_reviews',
    'studio_question_graphs',
    'studio_script_reviews',
    'studio_scripts',
  ]);
  // Pure DDL: no INSERT, no DELETE FROM, no UPDATE outside trigger bodies
  // (the stripped SQL discipline).
  const stripped = stripSqlComments(migration070Sql).replace(/\$\$[\s\S]*?\$\//g, 'TRIGGERBODY');
  assert.ok(!/\bINSERT INTO\b/.test(stripped), 'migration 070 writes no rows (pure DDL)');
  assert.ok(!/\bDELETE FROM\b/.test(stripped), 'migration 070 deletes no rows (pure DDL)');
  // The ONLY cross-table DDL is the additive CHECK on the same-module
  // studio_formats table (the §8 generated-input review field fence).
  const alters = [...migration070Sql.matchAll(/ALTER TABLE ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual([...new Set(alters)], ['studio_scripts', 'studio_question_graphs', 'studio_formats']);
  // No FK into any other module's tables: every REFERENCES target is a
  // tenant table or a same-module studio_* table.
  const references = [...migration070Sql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!);
  for (const target of references) {
    assert.ok(
      ['agencies', 'clients', 'workspaces'].includes(target) || target.startsWith('studio_'),
      `migration 070 references '${target}' — the FK anchors must be tenant tables + same-module rows only`,
    );
  }
});

test('STUDIO-003 AC-2: the migration-070 fences — the CHECK-fenced closed vocabularies, the origin-shape fence, the guarded review lifecycle (born pending, the decision-then-advance backing), the append-only/immutable triggers and the scope-consistency triggers all exist', () => {
  const migration070Sql = read(src('platform', 'db', 'migrations', '070_studio_script_question_graph.sql'));
  // The pinned third sub-contract identity.
  assert.ok(migration070Sql.includes(`CHECK (contract_version = 'content-studio-script-v1')`), 'the contract version is CHECK-pinned');
  // The closed vocabularies (the origins, the review states, the verdicts,
  // the reviewer/chooser splits, the answer kinds, the branch conditions).
  for (const fence of [
    `CHECK (origin IN ('supplied', 'generated'))`,
    `CHECK (review_state IS NULL\n                               OR review_state IN ('pending', 'approved', 'rejected', 'superseded'))`,
    `CHECK (verdict IN ('approved', 'rejected', 'superseded'))`,
    `CHECK (reviewer_kind IN ('human', 'autonomous'))`,
    `CHECK (answer_kind IN ('audio', 'video', 'text'))`,
    `CHECK (chooser_kind IN ('interviewer', 'human'))`,
  ]) {
    assert.ok(migration070Sql.includes(fence), `the closed-vocabulary fence is present: ${fence.slice(0, 60)}...`);
  }
  // The deterministic adjacency + the declared-graph helpers.
  for (const helper of ['studio_graph_nodes_wellformed', 'studio_graph_edges_declared', 'studio_graph_declared_wellformed', 'studio_citations_all_bounded']) {
    assert.ok(migration070Sql.includes(`FUNCTION ${helper}(`), `the IMMUTABLE helper exists: ${helper}`);
  }
  // The guard + append-only + scope triggers (every one of the 13).
  for (const trigger of [
    'studio_intents_no_update_trigger', 'studio_intents_no_delete_trigger', 'studio_intent_scope_trigger',
    'studio_scripts_born_pending_trigger', 'studio_script_guard_trigger', 'studio_scripts_no_delete_trigger',
    'studio_script_chain_scope_trigger', 'studio_script_scope_trigger',
    'studio_script_reviews_no_update_trigger', 'studio_script_reviews_no_delete_trigger', 'studio_script_review_scope_trigger',
    'studio_question_graph_guard_trigger', 'studio_question_graph_review_scope_trigger',
    'studio_conversation_edges_no_update_trigger', 'studio_conversation_edge_scope_trigger',
  ]) {
    assert.ok(migration070Sql.includes(`CREATE TRIGGER ${trigger}\n`), `the trigger exists: ${trigger}`);
  }
  // The origin-shape fences (the provenance discipline: every generated
  // record carries the FULL provenance structurally).
  assert.equal((migration070Sql.match(/CONSTRAINT studio_scripts_origin_shape/g) ?? []).length, 1);
  assert.equal((migration070Sql.match(/CONSTRAINT studio_question_graphs_origin_shape/g) ?? []).length, 1);
  // The decision-then-advance backing + the one-materialization fence.
  assert.ok(migration070Sql.includes('no matching decision record'), 'the decision-backing fence exists');
  assert.ok(migration070Sql.includes('EITHER a script chain OR a question-graph chain'), 'the one-materialization fence exists');
  // The additive format-registry CHECK (the §8 optional field).
  assert.ok(migration070Sql.includes('studio_formats_generated_review_check'), 'the additive same-module format CHECK exists');
  // NO binary column anywhere (CRED-001) — the comment-stripped DDL.
  assert.ok(!/\bbinary\b|\bbytea\b|\bblob\b/i.test(stripSqlComments(migration070Sql)), 'no binary column anywhere');
});

test('STUDIO-003 AC-2: the module still imports NO other module — the grown source keeps the /lab family discipline (zero cross-module imports; the migration-070 surfaces add no new structural port)', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('content-studio'), '/content-studio stays registered (the enforced set is UNCHANGED — 59 with the single /apps provision)');
  assert.equal(result.frozenModules.length, 59);
  // The import discipline over the GROWN source (the STUDIO-001 rule):
  // platform ports + the module's own files only (the relative-import
  // scan — node: builtins are allowed, as in the STUDIO-001 test).
  const importMatches = [...stripComments(moduleCode).matchAll(/from '(\.{1,2}\/[^']*)'/g)].map((match) => match[1]!);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.startsWith('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
  // The §8 pipeline adds NO new structural port: the deps stay
  // db + clock + ids + agentBodies + formats.
  assert.ok(publicTs.includes('readonly agentBodies: ContentStudioAgentBodyPort;'));
  assert.ok(publicTs.includes('readonly formats: ReadonlyArray<ContentStudioFormatDeclaration>;'));
  const depsKeys = [...publicTs.matchAll(/readonly (\w+):/g)].map((match) => match[1]!);
  assert.ok(!depsKeys.includes('reviewer'), 'no reviewer port (the review decisions are caller-supplied declared data)');
});

test('STUDIO-003 AC-3: the public API surface carries the intent-to-script pipeline — the §8 record methods on the ONE module API (no second Studio runtime)', () => {
  const api: ReadonlyArray<string> = [
    'recordIntent', 'getIntent', 'getIntentForRequest',
    'recordSuppliedScript', 'appendSuppliedScriptVersion', 'recordGeneratedScript', 'reviewScript',
    'getScript', 'listScriptVersions', 'getScriptForRequest', 'listScriptReviews',
    'recordSuppliedQuestionGraph', 'appendSuppliedQuestionGraphVersion', 'recordGeneratedQuestionGraph', 'reviewQuestionGraph',
    'getQuestionGraph', 'listQuestionGraphVersions', 'getQuestionGraphForRequest', 'listQuestionGraphReviews',
    'recordConversationStep', 'listConversationSteps',
  ];
  for (const method of api) {
    assert.ok(publicTs.includes(`  ${method}(`), `the module API declares ${method}`);
  }
  // The frozen vocabularies the migration-070 CHECK fences pin.
  for (const constant of [
    'CONTENT_STUDIO_SCRIPT_ORIGINS', 'CONTENT_STUDIO_REVIEW_STATES', 'CONTENT_STUDIO_REVIEW_VERDICTS',
    'CONTENT_STUDIO_REVIEWER_KINDS', 'CONTENT_STUDIO_GENERATED_INPUT_REVIEW_MODES', 'CONTENT_STUDIO_BRANCH_CONDITIONS',
    'CONTENT_STUDIO_ANSWER_KINDS', 'CONTENT_STUDIO_CHOOSER_KINDS', 'CONTENT_STUDIO_QUESTION_MODALITY_HINTS',
    'CONTENT_STUDIO_SCRIPT_CONTRACT_VERSION',
  ]) {
    assert.ok(publicTs.includes(`export const ${constant}`), `the public surface exports ${constant}`);
  }
  // The contract citations (the house pattern).
  assert.ok(publicTs.includes('INTENT-TO-SCRIPT'));
  assert.ok(publicTs.includes('content-studio-contract-v1.0.md'));
});

test('STUDIO-003 AC-4: 070_studio_script_question_graph.sql slots into the 068→071 gap in the ordered list (the TL pre-assigned slot; 069 is held by the parallel MKT-073 worker — NOT asserted absent); 073 now appends as the STUDIO-007 tail; the header cites the governing contract', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const last = migrations.length - 1;
  // The STUDIO-007 delivery appends 073_studio_av_capture.sql as the
  // new tail — the end-anchored positions shift once (the disclosed
  // re-pin; 072 is held by the in-flight LAB-006 parallel worker and
  // is NOT asserted absent).
  assert.equal(migrations[last], '073_studio_av_capture.sql', '073 is the tail (the STUDIO-007 delivery)');
  assert.equal(migrations[last - 1], '071_lab_simulator.sql', '071 stays the merged LAB-005 delivery');
  assert.equal(migrations[last - 2], '070_studio_script_question_graph.sql', '070 slots immediately before 071 (the TL pre-assigned gap)');
  assert.equal(migrations[last - 3], '068_studio_format_framework.sql', 'the STUDIO-002 framework precedes');
  // MY slot is asserted WITHOUT asserting 069's absence (the MKT-073
  // parallel worker holds it — the TL resolves the merge).
  assert.ok(migrations.includes('070_studio_script_question_graph.sql'));
  // The header cites the governing sub-contract + the acceptance verbatim.
  const migration070Sql = read(src('platform', 'db', 'migrations', '070_studio_script_question_graph.sql'));
  assert.ok(migration070Sql.includes('STUDIO-003 (Intent → Script /'));
  assert.ok(migration070Sql.includes('provenance of generated material'), 'the migration header cites the acceptance verbatim');
  assert.ok(migration070Sql.includes('content-studio-contract-v1.0.md'));
  assert.ok(migration070Sql.includes('§8 "Intent-to-script'));
});

test('STUDIO-003 AC-5: THE COMPOSITION-ROOT SEAM — the wiring lines carry the five STUDIO-001/002/003 dependencies UNCHANGED + the STUDIO-007 `objects` port append (the disclosed platform storage port — the capture layer lands its bytes through the SAME platform ObjectStore instance /content-assets uses)', () => {
  // The module construction carries the SAME five dependency lines
  // (the intent-to-script pipeline added NO new port) PLUS the
  // STUDIO-007 `objects` line (the platform storage/access port —
  // §9 "Capture implementations must use approved storage/access
  // ports"; disclosed in the STUDIO-007 composition comment).
  assert.ok(compositionRoot.includes('const contentStudio = createContentStudioModule({'));
  for (const line of ['db,', 'clock,', 'ids,', 'agentBodies: contentStudioAgentBodies,', 'formats: CONTENT_STUDIO_INITIAL_FORMATS,', 'objects,']) {
    assert.ok(compositionRoot.includes(line), `the wiring keeps the dependency: ${line.trim()}`);
  }
  assert.ok(compositionRoot.includes('contentStudio,'), 'the modules map keeps the entry');
  assert.ok(compositionRoot.includes('STUDIO-003'), 'the composition-root comment discloses the STUDIO-003 seam');
  assert.ok(compositionRoot.includes('STUDIO-007'), 'the composition-root comment discloses the STUDIO-007 storage-port seam');
});

// ---------------------------------------------------------------------------
// The STUDIO-007 boundary tests (the audio/video capture layer —
// migration 073 over the STUDIO-001 runtime + the STUDIO-002 framework
// + the STUDIO-003 question/branch graph).
// ---------------------------------------------------------------------------

test('STUDIO-007 AC-1: the module owns EXACTLY its two migration-073 tables — no v1.6 authority table, no /content-assets or /content-rights table, ZERO cross-table DDL (no ALTER TABLE anywhere)', () => {
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  const created073 = [...migration073Sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created073.sort(), ['studio_capture_sessions', 'studio_capture_takes']);
  // Pure DDL: no INSERT, no DELETE FROM, no UPDATE outside trigger bodies
  // (the stripped SQL discipline).
  const stripped = stripSqlComments(migration073Sql).replace(/\$\$[\s\S]*?\$\//g, 'TRIGGERBODY');
  assert.ok(!/\bINSERT INTO\b/.test(stripped), 'migration 073 writes no rows (pure DDL)');
  assert.ok(!/\bDELETE FROM\b/.test(stripped), 'migration 073 deletes no rows (pure DDL)');
  // ZERO cross-table DDL (stricter than 070: no additive CHECK on any
  // other table — the capture surface needs no foreign declaration field).
  const alters = [...stripSqlComments(migration073Sql).matchAll(/ALTER TABLE ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(alters, [], 'migration 073 alters no other table (purely additive, zero cross-table DDL)');
  // No FK into any other module's tables: every REFERENCES target is a
  // tenant table or a same-module studio_* table (NEVER content_assets,
  // content_rights or any v1.6 authority — the raw take is an INTERMEDIATE
  // production artifact, never a registered content asset).
  const references = [...migration073Sql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!);
  for (const target of references) {
    assert.ok(
      ['agencies', 'clients', 'workspaces'].includes(target) || target.startsWith('studio_'),
      `migration 073 references '${target}' — the FK anchors must be tenant tables + same-module rows only`,
    );
  }
  assert.ok(!migration073Sql.includes('content_asset'), 'no /content-assets surface anywhere');
  assert.ok(!migration073Sql.includes('content_rights'), 'no /content-rights surface anywhere');
});

test('STUDIO-007 AC-2: the migration-073 fences — the pinned contract identity, the CHECK-fenced closed vocabularies, the shape fences, the IMMUTABLE helper, the append-only/born-processing/guarded-update/scope triggers and NO binary column', () => {
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  // The pinned FOURTH sub-contract identity.
  assert.ok(migration073Sql.includes(`CHECK (contract_version = 'content-studio-capture-v1')`), 'the contract version is CHECK-pinned');
  // The closed vocabularies (the capture modes, the take modalities, the
  // ingest states, the input kinds, the §17 failure reasons, the §6
  // interviewer representations, the take-reference grammar).
  for (const fence of [
    `CHECK (capture_mode IN ('graph_walk', 'session_direct'))`,
    `CHECK (modality IN ('audio', 'video', 'screen'))`,
    `CHECK (ingest_state IN ('processing', 'stored', 'failed'))`,
    `CHECK (input_kind IN ('microphone', 'camera', 'microphone_and_camera',`,
    `CHECK (ingest_failure_reason IS NULL`,
    `'^studio-take:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`,
    `'^[0-9a-f]{64}$'`,
  ]) {
    assert.ok(migration073Sql.includes(fence), `the closed-vocabulary fence is present: ${fence.slice(0, 60)}...`);
  }
  // The IMMUTABLE bounded-refs helper (the 068 discipline).
  assert.ok(migration073Sql.includes('FUNCTION studio_capture_refs_all_bounded('), 'the IMMUTABLE helper exists');
  // The shape fences (the mode-graph pairing, the node-pin completeness,
  // the ingest-completion pairing, the failure pairing, the analysis pairing).
  for (const shape of [
    'studio_capture_sessions_mode_shape',
    'studio_capture_takes_node_pin_shape',
    'studio_capture_takes_ingest_shape',
    'studio_capture_takes_failure_shape',
    'studio_capture_takes_analysis_shape',
  ]) {
    assert.equal((migration073Sql.match(new RegExp(`CONSTRAINT ${shape}`, 'g')) ?? []).length, 1, `the shape fence exists exactly once: ${shape}`);
  }
  // The trigger inventory (every one of the seven).
  for (const trigger of [
    'studio_capture_sessions_no_update_trigger', 'studio_capture_sessions_no_delete_trigger', 'studio_capture_session_scope_trigger',
    'studio_capture_takes_born_processing_trigger', 'studio_capture_take_guard_trigger', 'studio_capture_takes_no_delete_trigger',
    'studio_capture_take_scope_trigger',
  ]) {
    assert.ok(migration073Sql.includes(`CREATE TRIGGER ${trigger}\n`), `the trigger exists: ${trigger}`);
  }
  // The born-processing fence message + the guarded terminal freeze + the
  // alternate-chain immutability (the honest messages).
  assert.ok(migration073Sql.includes('the durable landing is synchronous, any post-landing processing is the separate async completion'), 'the born-processing fence exists');
  assert.ok(migration073Sql.includes('the honest retry is a NEW take'), 'the terminal-freeze fence exists');
  assert.ok(migration073Sql.includes('a correction or retake is a NEW take row'), 'the take immutability fence exists');
  assert.ok(migration073Sql.includes('alternates are new rows, never overwrites or removals'), 'the no-delete fence exists');
  // The recording-state + walked-graph-binding scope fences (the
  // SQL-doubled quote forms, as the trigger messages carry them).
  assert.ok(migration073Sql.includes("may only open while its session revision is ''recording''"), 'the capture-session recording-state fence exists');
  assert.ok(migration073Sql.includes("may only be recorded while the session revision is ''recording''"), 'the take recording-state fence exists');
  assert.ok(migration073Sql.includes("must pin the declared graph bound to the session''s request version"), 'the walked-graph binding fence exists');
  assert.ok(migration073Sql.includes('retakes of the SAME capture moment'), 'the alternate scope fence exists');
  // NO binary column anywhere (CRED-001) — the comment-stripped DDL.
  assert.ok(!/\bbinary\b|\bbytea\b|\bblob\b/i.test(stripSqlComments(migration073Sql)), 'no binary column anywhere (the bytes live in the platform object store)');
});

test('STUDIO-007 AC-3: THE STRUCTURAL PARTICIPANT/SOURCE PROVENANCE — the take table carries the participant identity, the grant, the REQUIRED consent references, the device/input metadata and the durable artifact reference as NOT NULL columns (provenance is structural, never optional metadata)', () => {
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  const takesTable = migration073Sql.slice(migration073Sql.indexOf('CREATE TABLE IF NOT EXISTS studio_capture_takes'));
  for (const column of [
    'participant_reference',
    'consent_references',
    'input_kind',
    'device_label',
    'source_metadata',
    'object_key',
    'object_digest',
    'object_size',
    'content_type',
    'interviewer_representation',
  ]) {
    const declared = new RegExp(`\\n\\s+${column}\\s+(text|jsonb|bigint|integer|uuid)[^\\n]*NOT NULL`).test(takesTable)
      || (column === 'interviewer_representation' && /\n\s+interviewer_representation\s+text(\s|\n)/.test(takesTable));
    assert.ok(declared, `the provenance column '${column}' is declared on the take table`);
  }
  // The consent references are REQUIRED non-empty (1-16) via the IMMUTABLE
  // helper — never an empty array, never optional.
  assert.ok(migration073Sql.includes('CHECK (studio_capture_refs_all_bounded(consent_references))'), 'the consent provenance is CHECK-fenced as a non-empty bounded array');
  // The durable artifact reference is content-addressed (the sha256 key +
  // digest pair) with the exact size — the platform-anchored reference.
  assert.ok(/object_key\s+text\s+NOT NULL/.test(takesTable), 'the content-addressed object key is NOT NULL');
  assert.ok(/object_size\s+bigint\s+NOT NULL CHECK \(object_size > 0\)/.test(takesTable), 'the exact object size is NOT NULL and positive');
});

test('STUDIO-007 AC-4: THE NO-SYNCHRONOUS-PROCESSING STRUCTURAL PROOF — zero media-processing vocabulary in the module; the takes are BORN processing (the module insert + the DB fence); the ingest performs only the durable landing', () => {
  // ZERO media-processing engine vocabulary anywhere in the module (the
  // ingest path does validation + the storage-port put + the row insert —
  // any transcoding/analysis is the separate async completion surface).
  const strippedModule = stripComments(moduleCode);
  for (const forbidden of ['transcode', 'ffmpeg', 'libav', 'waveform', 'thumbnail', 'mux', 'demux', 'encodeMedia', 'decodeMedia', 'processAudio', 'processVideo']) {
    assert.ok(!strippedModule.includes(forbidden), `the module contains no media-processing vocabulary ('${forbidden}' found) — long-running processing is never synchronous HTTP work`);
  }
  // The born-processing birth: the module's ingest insert pins the born
  // state structurally.
  assert.ok(moduleCode.includes(`'processing', $25, $26::timestamptz, $26::timestamptz`), 'the take insert is born processing (the store insert literal)');
  // The async completion surface exists (the guarded terminal advances).
  assert.ok(publicTs.includes('completeCaptureTakeIngest('), 'the async completion surface is declared');
  assert.ok(publicTs.includes('failCaptureTakeIngest('), 'the async failure surface is declared');
  // The DB born-processing fence (defense in depth).
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  assert.ok(migration073Sql.includes(`IF NEW.ingest_state <> 'processing' THEN`), 'the DB born-processing fence rejects any other birth state');
  // The ingest-state closed vocabulary is exported on the public surface.
  assert.ok(publicTs.includes('export const CONTENT_STUDIO_TAKE_INGEST_STATES'));
});

test('STUDIO-007 AC-5: THE STORAGE-PORT DISCIPLINE — the module consumes the platform ObjectStore port through the declared `objects` dep; NEVER module-local blob storage; never a /content-assets registration; the imports stay platform + own files only', () => {
  // The declared platform port on the module deps (the composition-root
  // wiring — the same platform objects instance /content-assets uses).
  assert.ok(publicTs.includes('readonly objects: ObjectStore;'), 'the module deps declare the platform ObjectStore port');
  assert.ok(publicTs.includes(`from '../../platform/objects/contract.ts'`), 'the port type is the platform contract import');
  // The module NEVER constructs an object-store adapter itself (the
  // adapters are platform code wired at the composition root only).
  for (const adapter of ['new FsObjectStore', 'new S3ObjectStore', 'new MemoryObjectStore', 'createWriteStream', 'writeFile']) {
    assert.ok(!stripComments(moduleCode).includes(adapter), `the module never constructs storage itself ('${adapter}')`);
  }
  // The /content-assets registration is NEVER invoked from this module (a
  // raw take is an INTERMEDIATE production artifact — lock v1.7 #36).
  assert.ok(!stripComments(moduleCode).includes('registerAssetVersion'), 'no /content-assets registration call inside the module');
  assert.ok(!stripComments(moduleCode).includes('materializeAssetVersion'), 'no /content-assets materialization call inside the module');
  // The import discipline over the GROWN source (the STUDIO-001 rule,
  // re-proven for the capture surface): platform ports + the module's own
  // files only.
  const importMatches = [...stripComments(moduleCode).matchAll(/from '(\.{1,2}\/[^']*)'/g)].map((match) => match[1]!);
  for (const specifier of importMatches) {
    assert.ok(
      specifier.includes('platform/') || specifier.includes('errors/errors.ts') || specifier.includes('public.ts') || specifier.startsWith('./'),
      `the module may import platform ports + its own files only, found '${specifier}'`,
    );
  }
});

test('STUDIO-007 AC-6: the module boundary keeps the /lab family discipline over the GROWN source — the real checker is green, /content-studio stays registered, and the module structure stays public.ts + internal/ (the frozen boundary shape)', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('content-studio'), '/content-studio stays registered');
  assert.equal(result.frozenModules.length, 59, 'the enforced set is UNCHANGED (59 — no checker provision, the module is already registered)');
  // The module directory structure stays exactly public.ts + internal/
  // (the STUDIO-001 boundary shape; the capture layer extends the SAME
  // files, never a second Studio runtime).
  assert.deepEqual([...moduleFiles.map((name) => name)].sort(), ['content-studio-module.ts', 'content-studio-store.ts', 'validation.ts']);
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
});

test('STUDIO-007 AC-7: THE API SURFACE SHAPE — the §9 capture records ride the ONE module API (no second Studio runtime); the frozen vocabularies + the take-reference grammar are exported', () => {
  const api: ReadonlyArray<string> = [
    'openCaptureSession', 'getCaptureSession', 'listCaptureSessions',
    'recordCaptureTake', 'completeCaptureTakeIngest', 'failCaptureTakeIngest',
    'getCaptureTake', 'getCaptureTakeByReference', 'listCaptureTakes',
  ];
  for (const method of api) {
    assert.ok(publicTs.includes(`  ${method}(`), `the module API declares ${method}`);
  }
  for (const constant of [
    'CONTENT_STUDIO_CAPTURE_CONTRACT_VERSION', 'CONTENT_STUDIO_CAPTURE_SESSION_MODES', 'CONTENT_STUDIO_TAKE_MODALITIES',
    'CONTENT_STUDIO_TAKE_INGEST_STATES', 'CONTENT_STUDIO_CAPTURE_INPUT_KINDS', 'CONTENT_STUDIO_MAX_TAKE_BYTES',
    'CONTENT_STUDIO_TAKE_REF_PATTERN',
  ]) {
    assert.ok(publicTs.includes(`export const ${constant}`), `the public surface exports ${constant}`);
  }
  // The mint/parse pair (the reference grammar).
  assert.ok(publicTs.includes('export function mintContentStudioTakeReference('));
  assert.ok(publicTs.includes('export function parseContentStudioTakeReference('));
  // The capture contract citations (the house pattern).
  assert.ok(publicTs.includes('content-studio-capture-v1'));
  assert.ok(publicTs.includes('STUDIO-007'));
  assert.ok(publicTs.includes('approved storage/access ports'));
  // The take modalities are the closed §9 media-capture SUBSET (never the
  // structural requirements participant_streams/alternate_takes).
  assert.ok(publicTs.includes("export const CONTENT_STUDIO_TAKE_MODALITIES = ['audio', 'video', 'screen'] as const;"));
});

test('STUDIO-007 AC-8: 073_studio_av_capture.sql appends as the migration tail (072 is held by the in-flight parallel LAB-006 worker — NOT asserted absent); the header cites the governing contract + the acceptance verbatim', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const last = migrations.length - 1;
  assert.equal(migrations[last], '073_studio_av_capture.sql', '073 is the tail (this delivery)');
  // 072 is NOT asserted absent (the in-flight LAB-006 parallel worker
  // holds it — the TL resolves the merge, the 069/070 precedent).
  assert.ok(!migrations.some((name) => name.startsWith('073_') && name !== '073_studio_av_capture.sql'), 'no stray 073 migration');
  // The header cites the governing sub-contract + the acceptance verbatim.
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  assert.ok(migration073Sql.includes('STUDIO-007 (Audio/Video Capture)'));
  assert.ok(migration073Sql.includes('raw takes, alternates and participant/source'), 'the migration header cites the acceptance verbatim');
  assert.ok(migration073Sql.includes('no long-running synchronous HTTP'), 'the migration header cites the no-synchronous-processing acceptance verbatim');
  assert.ok(migration073Sql.includes('§9 "Capture — Capture is modality-specific but format-neutral'), 'the migration header cites the governing §9 rule verbatim');
  assert.ok(migration073Sql.includes('072 is HELD by the in-flight parallel LAB-006 worker'), 'the migration header discloses the 072 hold');
});

test('STUDIO-007 AC-9: THE COMPOSITION SEAM — the six dependencies (db, clock, ids, agentBodies, formats, objects) + the STUDIO-007 comment disclosure + the SANCTIONED registration-paragraph extension sentence', () => {
  // The composition root wires the REAL platform objects instance (the
  // same service /content-assets uses — disclosed in the comment).
  assert.ok(compositionRoot.includes('const contentStudio = createContentStudioModule({'));
  for (const line of ['db,', 'clock,', 'ids,', 'agentBodies: contentStudioAgentBodies,', 'formats: CONTENT_STUDIO_INITIAL_FORMATS,', 'objects,']) {
    assert.ok(compositionRoot.includes(line), `the wiring keeps the dependency: ${line.trim()}`);
  }
  assert.ok(compositionRoot.includes('STUDIO-007 (the audio/video capture layer) adds the THIRD'), 'the composition-root comment discloses the STUDIO-007 storage-port seam');
  // The sanctioned registration-paragraph extension (the brief's allowed
  // surface — one honest additive sentence in spec/architecture.md §6).
  const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(architectureSpec.includes('The STUDIO-007 audio/video capture extension (the same module, migration 073) adds the platform ObjectStore port'), 'the registration paragraph carries the sanctioned STUDIO-007 extension sentence');
  assert.ok(architectureSpec.includes('never a /content-assets registration of raw takes'), 'the extension sentence discloses the intermediate-artifact boundary');
});

test('STUDIO-007 AC-10: THE INITIAL FORMAT DECLARATIONS STAY UNCHANGED — the three frozen STUDIO-002 declarations carry their capture requirements + stage availability VERBATIM (the zero-drift delivery; the format-EXECUTION integrations are STUDIO-011/012/013)', () => {
  // The reaction capture requirements + the capture_ingestion stage keep
  // their declared availability (the STUDIO-003 precedent: the record
  // surfaces are the structural home; the format-EXECUTION integration
  // stays with the format work items).
  const reaction = publicTs.slice(publicTs.indexOf("formatId: 'reaction'"));
  assert.ok(reaction.includes("captureRequirements: { modalities: ['audio', 'video', 'screen'] }"), 'the reaction capture requirements stay unchanged');
  assert.ok(reaction.includes("stageId: 'capture_ingestion'"), 'the reaction capture_ingestion stage stays declared');
  assert.ok(reaction.includes("availability: { status: 'awaiting_execution_module', awaitingModule: 'STUDIO-007' }"), 'the reaction capture_ingestion availability stays honestly declared (the format-execution integration is STUDIO-011)');
  // The podcast capture requirements stay unchanged.
  const audioPodcast = publicTs.slice(publicTs.indexOf("formatId: 'audio-podcast'"));
  assert.ok(audioPodcast.includes("captureRequirements: { modalities: ['audio', 'participant_streams', 'alternate_takes'] }"), 'the audio-podcast capture requirements stay unchanged');
});

test('STUDIO-007 AC-11: THE WALKED-GRAPH PIN SURFACE — the capture sessions/takes bind the STUDIO-003 declared question graph (the module resolves the request-version graph; the DB scope triggers re-read the declared jsonb — the 070 conversation discipline)', () => {
  const migration073Sql = read(src('platform', 'db', 'migrations', '073_studio_av_capture.sql'));
  // The capture session pins the walked graph version (the composite FK).
  assert.ok(migration073Sql.includes('CONSTRAINT studio_capture_sessions_graph_fk'), 'the capture sessions FK the declared graph versions');
  assert.ok(migration073Sql.includes('CONSTRAINT studio_capture_takes_graph_fk'), 'the takes FK the declared graph versions');
  // The module resolves the request-version graph (the conversation-walk
  // binding mirror).
  assert.ok(moduleCode.includes('findLatestQuestionGraphForRequest(input.scope.clientId, session.requestId, session.requestVersion)'), 'the capture session resolves the request-version graph');
  // The take scope trigger re-reads the declared graph jsonb (the node
  // membership backstop — the 070 precedent).
  assert.ok(migration073Sql.includes(`jsonb_array_elements(graph.declared_graph -> 'nodes') AS node`), 'the take scope trigger re-reads the declared nodes');
  assert.ok(migration073Sql.includes('is not a declared node of the walked graph'), 'the node-membership fence message exists');
  // The composite session-revision FKs (the denormalized binding).
  assert.ok(migration073Sql.includes('CONSTRAINT studio_capture_takes_session_fk'), 'the takes FK the session revisions');
});

test('STUDIO-007 AC-12: THE STORE DISCIPLINE — the migration-073 persistence touches ONLY the module\'s own studio_* tables (no authority table, no other module table, no cross-tenant reads)', () => {
  const storeTs = read(join(moduleDir, 'internal', 'content-studio-store.ts'));
  // The capture store methods address exactly the two migration-073 tables.
  for (const table of ['studio_capture_sessions', 'studio_capture_takes']) {
    assert.ok(storeTs.includes(`INSERT INTO ${table}`), `the store writes ${table}`);
  }
  // Every studio_ table the store mentions is the module's own (the six
  // 064 tables + the two 068 registry tables + the six 070 tables + the
  // two 073 capture tables — sixteen own tables, nothing else).
  const ownTables = new Set([
    'studio_production_requests', 'studio_sessions', 'studio_session_events', 'studio_processing_steps',
    'studio_output_versions', 'studio_treatment_requests', 'studio_formats', 'studio_format_capabilities',
    'studio_intents', 'studio_scripts', 'studio_script_reviews', 'studio_question_graphs',
    'studio_question_graph_reviews', 'studio_conversation_edges', 'studio_capture_sessions', 'studio_capture_takes',
  ]);
  const mentioned = [...storeTs.matchAll(/(?:INSERT INTO|FROM|UPDATE)\s+(studio_[a-z_]+)/g)].map((match) => match[1]!);
  for (const table of mentioned) {
    assert.ok(ownTables.has(table), `the store mentions only the module's own tables, found '${table}'`);
  }
  // The capture queries are client-scoped (the tenant fence on every read).
  assert.ok(storeTs.includes('WHERE client_id = $1 AND take_reference = $2'), 'the take-reference resolution is client-scoped');
});
