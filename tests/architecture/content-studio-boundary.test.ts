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
  // modules: 52 spec-parsed + the single /apps provision + the
  // disclosed content-studio worker provision pending the TL spec
  // promotion — the LAB-011 worker-delivery precedent).
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(result.violations, []);
  assert.ok(result.frozenModules.includes('content-studio'));
  assert.equal(result.frozenModules.length, 54);
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

test('STUDIO-001 AC-4: the registration — the composition root wires the REAL /lab-agent-body instance behind the disclosed READ-ONLY adapter + the initial formats through the §2 seam, and registers the module; the checker provision is the disclosed worker registration pending the TL spec promotion', () => {
  assert.ok(compositionRoot.includes("import { createContentStudioModule, CONTENT_STUDIO_INITIAL_FORMATS } from './modules/content-studio/public.ts'"));
  assert.ok(compositionRoot.includes('const contentStudio = createContentStudioModule({'));
  assert.ok(compositionRoot.includes('agentBodies: contentStudioAgentBodies,'));
  assert.ok(compositionRoot.includes('formats: CONTENT_STUDIO_INITIAL_FORMATS,'));
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, contentStudio },'));
  assert.ok(applicationTs.includes("import type { ContentStudioModuleApi } from '../modules/content-studio/public.ts'"));
  assert.ok(applicationTs.includes('readonly contentStudio: ContentStudioModuleApi'));
  // The disclosed checker provision (the LAB-011 worker-delivery
  // precedent — pending the TL spec promotion): the provision array
  // carries the /apps entry + the content-studio worker entry.
  const provision = stripComments(checkerTs).match(/v15CompositionModules[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(provision !== null);
  const entries = [...provision[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
  assert.deepEqual(entries, ['apps', 'content-studio']);
  // The spec files remain worker-untouched (the /content-studio
  // registration is NOT in the frozen list — the TL promotes it).
  const specModules = /## 6\. Core domain modules\s*```text([\s\S]*?)```/.exec(read(join(repoRoot, 'spec', 'architecture.md')))![1]!;
  assert.ok(!/^\/content-studio$/m.test(specModules), 'no worker spec edit — the TL spec promotion registers /content-studio (the /lab precedent)');
});

test('STUDIO-001 AC-5: 064_content_studio_runtime.sql is the migration tail (the next-free number on frozen main; 062 remains reserved for the parallel worker); the header cites the governing contract', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations[migrations.length - 1], '064_content_studio_runtime.sql');
  assert.ok(!migrations.includes('062_agent_capability_candidates.sql'), '062 is reserved for the parallel worker (the TL reconciles numbering at merge — the LAB-011 disclosure)');
  // The header cites the governing sub-contract + the acceptance
  // verbatim (the house pattern).
  assert.ok(migrationSql.includes('STUDIO-001 (Content Studio Runtime)'));
  assert.ok(migrationSql.includes('no publishing/experiment authority'), 'the migration header cites the acceptance verbatim');
  assert.ok(migrationSql.includes('content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('spec/content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('studioIsNotPublicationOrExperimentAuthority'));
});
