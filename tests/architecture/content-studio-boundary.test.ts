/**
 * STUDIO-001 + STUDIO-002 boundary tests — the static architectural
 * proofs of /content-studio (the /lab-agent-body boundary precedent,
 * applied to the Content Studio Runtime and its Pluggable Format
 * Framework):
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
 *   2. the migration-064 + migration-068 discipline: the module owns
 *      EXACTLY its eight studio_* tables (six runtime tables from 064
 *      + the format registry and the format-capability links from
 *      068 — no v1.6 authority table, no /lab-agent-body table, no
 *      /ai-runtime table, NO /lab-capabilities table — the capability
 *      ENGINE is LAB-013 and the format-capability link records carry
 *      OPAQUE references only), CHECK-fenced closed vocabularies, the
 *      guarded §5 legal-edge table in the session trigger, the
 *      guarded §2 format lifecycle in the registry trigger (born
 *      draft, identity immutable, draft → active → retired, the
 *      activation capability-consistency fence, no resurrection),
 *      the append-only/immutable triggers, the scope-consistency
 *      fences and NO binary column anywhere;
 *   3. the module structure (public.ts + internal/ only);
 *   4. the registration: the composition root constructs and registers
 *      the module with the REAL /lab-agent-body instance behind the
 *      disclosed READ-ONLY adapter (the off-matrix wrapper precedent)
 *      and the initial format declarations through the §2 seam
 *      (STUDIO-002 extended the seam with the full framework — the
 *      registerFormat/activateFormat/retireFormat/getFormat/
 *      listFormats registry surface — with the composition wiring
 *      UNCHANGED); ApplicationModules carries the entry; the spec
 *      registration is the promoted §6 line (no checker provision);
 *   5. the migration tail: 068_studio_format_framework.sql is the
 *      tail (the TL pre-assigned 068 to this delivery; 066 and 067
 *      are held by the parallel LAB-004/LAB-013 workers — the TL
 *      reconciles numbering at merge, the 062/063/064/065 precedent).
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
const migration068Sql = read(src('platform', 'db', 'migrations', '068_studio_format_framework.sql'));
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
  assert.equal(result.frozenModules.length, 56);
});

test('STUDIO-001 AC-2: the module owns EXACTLY its EIGHT studio_* tables (six from 064 + the format registry and capability links from 068) — no v1.6 authority table, no /lab-agent-body table, no /ai-runtime table, NO /lab-capabilities table', () => {
  const created064 = [...migrationSql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created064.sort(), [
    'studio_output_versions',
    'studio_processing_steps',
    'studio_production_requests',
    'studio_session_events',
    'studio_sessions',
    'studio_treatment_requests',
  ]);
  const created068 = [...migration068Sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created068.sort(), [
    'studio_format_capabilities',
    'studio_formats',
  ]);
  // No write into any table: BOTH migrations are pure DDL (the stripped
  // SQL contains no INSERT INTO, no DELETE FROM and no UPDATE outside
  // the BEFORE UPDATE ON trigger clauses).
  for (const sql of [migrationSql, migration068Sql]) {
    const stripped = stripSqlComments(sql);
    assert.ok(!/INSERT INTO/.test(stripped), 'the migration never inserts data');
    assert.ok(!/DELETE FROM/.test(stripped), 'the migration never deletes data');
    assert.ok(!/UPDATE(?! ON)/.test(stripped), 'the migration never mutates a table (the ONLY UPDATE tokens are the BEFORE UPDATE ON trigger clauses)');
  }
  // No FK into a v1.6 authority beyond the tenant anchors (agencies,
  // clients, workspaces) and the module's own tables (064's + 068's
  // same-module studio_formats anchor).
  for (const reference of [...migrationSql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!)) {
    assert.ok(
      ['agencies', 'clients', 'workspaces', 'studio_production_requests', 'studio_sessions', 'studio_output_versions', 'studio_treatment_requests'].includes(reference),
      `unexpected FK target '${reference}'`,
    );
  }
  for (const reference of [...migration068Sql.matchAll(/REFERENCES ([a-z_]+)/g)].map((match) => match[1]!)) {
    assert.ok(
      ['agencies', 'clients', 'workspaces', 'studio_formats'].includes(reference),
      `unexpected 068 FK target '${reference}'`,
    );
  }
  // The source artifacts / consent records are OPAQUE references
  // inside the declared content jsonb — NO content asset/rights table
  // is written or joined (the §16 no-second-rights-engine rule).
  for (const sql of [migrationSql, migration068Sql]) {
    assert.ok(!/content_assets|content_rights/.test(stripSqlComments(sql)), 'no content asset/rights table is touched');
    // No /lab-agent-body table is written (the bodies are opaque
    // reference strings resolved through the port).
    assert.ok(!/lab_agent/.test(stripSqlComments(sql)), 'no /lab-agent-body table is written');
    // NO /lab-capabilities table is written or referenced (the
    // capability ENGINE is Worker-B's LAB-013 module — the capability
    // references are OPAQUE strings in the link records).
    assert.ok(!/lab_capabilit|lab_feature/.test(stripSqlComments(sql)), 'no /lab-capabilities table is written or referenced');
    // NO binary column anywhere (no bytea, no blob, no media retention
    // surface) — checked over the STRIPPED DDL so the prose fence
    // comments cannot produce false positives.
    assert.ok(!/bytea|blob|binary/.test(stripSqlComments(sql)), 'no binary column may exist');
  }
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

test('STUDIO-001/STUDIO-002 AC-4: the registration — the composition root wires the REAL /lab-agent-body instance behind the disclosed READ-ONLY adapter + the initial formats through the §2 seam (the STUDIO-002 wiring UNCHANGED — the registry rides the same seam), and registers the module; the spec promotion registered /content-studio (the provision retired, the /lab registration precedent)', () => {
  assert.ok(compositionRoot.includes("import { createContentStudioModule, CONTENT_STUDIO_INITIAL_FORMATS } from './modules/content-studio/public.ts'"));
  assert.ok(compositionRoot.includes('const contentStudio = createContentStudioModule({'));
  assert.ok(compositionRoot.includes('agentBodies: contentStudioAgentBodies,'));
  assert.ok(compositionRoot.includes('formats: CONTENT_STUDIO_INITIAL_FORMATS,'));
  assert.ok(compositionRoot.includes('lab, labCorpus, labAgentBody, contentStudio, labFeatures, commerceDiscovery },'));
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
  // STUDIO-002: the registry surface is the module's PUBLIC API — the
  // pluggability seam (registering a future format requires NO runtime
  // change, no composition change, no second module instance).
  for (const apiMember of ['registerFormat', 'activateFormat', 'retireFormat', 'getFormat', 'listFormats']) {
    assert.ok(publicTs.includes(`  ${apiMember}(`), `the §2 registry surface declares ${apiMember}`);
  }
  assert.ok(publicTs.includes('CONTENT_STUDIO_FORMAT_CONTRACT_VERSION'), 'the format-framework contract identity is exported');
  assert.ok(publicTs.includes("CONTENT_STUDIO_FORMAT_CONTRACT_VERSION = 'content-studio-format-v1'"), 'the migration-068 CHECK fence pins exactly this identity');
});

test('STUDIO-001/STUDIO-002 AC-5: 068_studio_format_framework.sql appends as the migration tail (the TL pre-assigned 068; 066 and 067 are held by the parallel LAB-004/LAB-013 workers); the header cites the governing contract', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations[migrations.length - 3], '064_content_studio_runtime.sql');
  assert.equal(migrations[migrations.length - 2], '065_lab_features.sql');
  assert.equal(migrations[migrations.length - 1], '068_studio_format_framework.sql');
  assert.ok(!migrations.includes('066_lab_ideas.sql'), '066 is held by the parallel LAB-004 worker (the TL reconciles numbering at merge)');
  assert.ok(!migrations.includes('067_lab_capabilities.sql'), '067 is held by the parallel LAB-013 worker (the TL reconciles numbering at merge)');
  // The header cites the governing sub-contract + the acceptance
  // verbatim (the house pattern).
  assert.ok(migrationSql.includes('STUDIO-001 (Content Studio Runtime)'));
  assert.ok(migrationSql.includes('no publishing/experiment authority'), 'the migration header cites the acceptance verbatim');
  assert.ok(migrationSql.includes('content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('spec/content-studio-contract-v1.0.md'));
  assert.ok(publicTs.includes('studioIsNotPublicationOrExperimentAuthority'));
  assert.ok(migration068Sql.includes('STUDIO-002 (Pluggable Format'));
  assert.ok(migration068Sql.includes('new formats do not require another Studio'), 'the 068 header cites the acceptance verbatim (the line-wrapped fragment)');
  assert.ok(migration068Sql.includes('content-studio-contract-v1.0.md'));
});

test('STUDIO-002 AC: the migration-068 format-registry fences — the closed-vocabulary CHECKs, the born-draft fence, the guarded lifecycle (identity immutable, draft → active → retired, the activation capability-consistency), the chain-scope fence, the append-only link discipline and the scope-consistency triggers', () => {
  // THE CLOSED-VOCABULARY CHECK FENCES over the declared jsonb (the
  // IMMUTABLE SQL helpers + the CHECK constraints pinning the NINE
  // §2 surfaces' vocabularies).
  for (const fence of [
    "CHECK (status IN ('draft', 'active', 'retired'))",
    "CHECK (contract_version = 'content-studio-format-v1')",
    "CHECK (format_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$')",
    "CHECK (format_version >= 1 AND format_version <= 1000)",
    'studio_format_jsonb_strings_all_in',
    "ARRAY['script', 'question_list', 'intent']",
    "IN ('required', 'optional')",
    "IN ('single_scope', 'explicit_grant_per_participant')",
    "ARRAY['audio', 'video', 'screen', 'participant_streams', 'alternate_takes']",
    "IN ('none', 'representation')",
    "ARRAY['voice', 'voice_text', 'avatar', 'prerecorded', 'generated', 'multimodal_declared', 'hybrid']",
    "IN ('adaptive', 'fixed')",
    "ARRAY['read', 'analyze', 'compose', 'transform', 'communicate', 'simulate']",
    "ARRAY['raw_captures', 'final_media', 'alternate_takes', 'transcript',",
    "ARRAY['participant_recording_consent', 'interviewer_representation_disclosure',",
    "ARRAY['source_reference', 'human_capture', 'interviewer_representation',",
    'studio_format_hook_fireson_in',
    "ARRAY['stage_completion', 'output_recorded']",
    'studio_format_stages_available',
    "ARRAY['runtime_driven', 'awaiting_execution_module']",
    'studio_formats_natural_key',
  ]) {
    assert.ok(migration068Sql.includes(fence), `the migration-068 fence must exist: ${fence.slice(0, 60)}`);
  }
  // THE GUARDED §2 FORMAT LIFECYCLE is trigger-encoded (the 063
  // versioned-registry precedent + the STUDIO-002 fences).
  for (const trigger of [
    'studio_formats_born_draft',
    'studio_format_guard',
    'studio_formats_no_delete',
    'studio_format_chain_scope_check',
    'studio_format_capabilities_immutable',
    'studio_format_capability_scope_check',
  ]) {
    assert.ok(migration068Sql.includes(`FUNCTION ${trigger}(`), `the trigger function ${trigger} must exist`);
  }
  // BORN DRAFT is trigger-encoded.
  assert.ok(migration068Sql.includes('BORN DRAFT'), 'the born-draft fence raises explicitly');
  // The lifecycle legal edges are trigger-encoded (the exact 063
  // pattern — draft → active | retired, active → retired, no
  // resurrection).
  assert.ok(
    migration068Sql.includes("(OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))"),
    'the draft edge is trigger-encoded',
  );
  assert.ok(
    migration068Sql.includes("(OLD.status = 'active' AND NEW.status = 'retired')"),
    'the retirement edge is trigger-encoded',
  );
  // The activation capability-consistency fence is trigger-encoded.
  assert.ok(migration068Sql.includes('capability link records do not match'), 'the activation-consistency fence raises explicitly');
  // The version-chain scope fence is trigger-encoded.
  assert.ok(migration068Sql.includes('cross-tenant/cross-workspace corrections are rejected'), 'the chain-scope fence raises explicitly');
  // The link records are append-only + scope-consistent.
  assert.ok(migration068Sql.includes('INSERT only — corrections are NEW format version rows'), 'the link append-only fence raises explicitly');
  assert.ok(migration068Sql.includes('cross-tenant/cross-workspace link injection is rejected'), 'the link scope-consistency fence raises explicitly');
  // The capability link kind vocabulary is CHECK-fenced.
  assert.ok(migration068Sql.includes("CHECK (capability_kind IN ('required'))"), 'the closed capability-link kind vocabulary');
  // The registry never seeds content (the lazy materialization is the
  // module's — disclosed).
  assert.ok(migration068Sql.includes('The initial registry CONTENT is NOT seeded here'), 'the no-seed disclosure is explicit');
});

test('STUDIO-002 AC: THE PLUGGABILITY PROOF is structural — the module source drives EVERY session through the registry\'s declared contracts (no per-format runtime code; the three initial formats are DATA, the custom registrations are DATA)', () => {
  // The runtime's format consumption is the REGISTRY RESOLUTION (no
  // per-format branches anywhere in the module code).
  const code = stripComments(moduleCode);
  for (const required of [
    'requireActiveFormat',
    'requireSessionFormat',
    'ensureWiredFormat',
    'registerFormat',
    'activateFormat',
    'retireFormat',
  ]) {
    assert.ok(code.includes(required), `the registry-driven runtime references ${required}`);
  }
  // NO per-format runtime branch: the module code never names a
  // specific format identity in CODE (the reaction/podcast identities
  // appear ONLY in the declared DATA constants + docs).
  const implementationCode = [
    read(join(moduleDir, 'internal', 'content-studio-module.ts')),
    read(join(moduleDir, 'internal', 'content-studio-store.ts')),
    read(join(moduleDir, 'internal', 'validation.ts')),
  ].join('\n');
  const implementationWithoutComments = stripComments(implementationCode);
  for (const formatIdentity of ["'reaction'", "'audio-podcast'", "'video-podcast'"]) {
    assert.ok(
      !implementationWithoutComments.includes(formatIdentity),
      `the runtime implementation must never branch on the format identity ${formatIdentity} (per-format code would be a second Studio runtime)`,
    );
  }
  // The initial formats are DECLARED DATA on the public surface (the
  // seam the composition root wires).
  assert.ok(publicTs.includes('CONTENT_STUDIO_INITIAL_FORMATS'), 'the initial registry content is exported declared data');
  // The nine §2 surfaces are all declared + validated (the full
  // declaration surface is real, not prose).
  for (const surface of [
    'DECLARATION SURFACE 1 of 9',
    'DECLARATION SURFACE 2 of 9',
    'DECLARATION SURFACE 3 of 9',
    'DECLARATION SURFACE 4 of 9',
    'DECLARATION SURFACE 5 of 9',
    'DECLARATION SURFACE 6 of 9',
    'DECLARATION SURFACE 7 of 9',
    'DECLARATION SURFACE 8 of 9',
    'DECLARATION SURFACE 9 of 9',
  ]) {
    assert.ok(publicTs.includes(surface), `the ${surface} doc-fence exists`);
  }
  // The honest availability layer is declared data on every stage.
  assert.ok(publicTs.includes('CONTENT_STUDIO_FORMAT_AVAILABILITY_STATES'), 'the closed availability vocabulary is exported');
  for (const format of ['awaiting_execution_module', 'runtime_driven']) {
    assert.ok(publicTs.includes(format), `the availability state '${format}' appears in the declared initial content`);
  }
});
