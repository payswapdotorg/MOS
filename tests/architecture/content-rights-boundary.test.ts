/**
 * MKT-063 static tests — the Content Rights and Provenance authority is
 * structurally correct in the ACTUAL migration, module contract and
 * route surface (pure static analysis, no DB; the
 * notification-delivery-boundary precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-063; spec/
 * architecture-v1.6.md §9; spec/frozen-manifest-v1.6.json
 * hardPublicationRules; spec/module-dependency-matrix-v1.6.md boundary
 * rule 4):
 *   1. migration 051 (the PRE-ASSIGNED number; 050 is reserved for a
 *      sibling delivery — the sibling workers are told 050/051 may
 *      collide, kept 051, disclosed) creates exactly the five own
 *      tables — content_rights_records, content_rights_clearances,
 *      content_rights_events, content_rights_permissions,
 *      content_rights_lineage_links — OWN tables ONLY: no evidence,
 *      policy, credential, tenant, mission, workflow, execution or
 *      content-asset table (the authorities stay sole, consumed
 *      READ-ONLY through the public contracts; /content-assets is the
 *      FUTURE consumer of this gate, never an import here);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the seven rights
 *      states (the MKT-063 acceptance list VERBATIM + the explicit
 *      `unknown` initial state), the asset kinds, the transition-event
 *      kinds, the platform permissions — plus the FROZEN
 *      TRANSITION-TABLE CHECK (the (from, to, kind) triples; `cleared`
 *      reachable ONLY from `review` via human_clearance with the
 *      clearance row), the event-shape CHECK (clearance_id exactly for
 *      human_clearance), the licence-basis payload-shape CHECK, the
 *      one-record-per-(client, asset ref) fence, the lineage pair fence
 *      + no-self-link CHECK, the scope-chain + same-Client evidence
 *      triggers and the append-only UPDATE/DELETE rejection triggers;
 *   3. THE FAIL-CLOSED GATE BATTERY: the gate code paths are exactly
 *      the frozen semantics — absent record → blocked; unknown/review
 *      → review_required (NEVER allow); expiry → blocked; destination
 *      scope decides licence bases (unspecified → review_required);
 *      policy deny → blocked; the conjunction (any unclear ingredient
 *      → review_required; any blocked/absent ingredient → blocked);
 *      composite without lineage → blocked;
 *   4. THE BOUNDARY-RULE-4 BATTERY (no publication authority): NO
 *      publish/dispatch/post/emit verb exists anywhere in the module,
 *      the routes or the migration — the gate blocks or refers to
 *      review; publishing is MKT-065's execution surface;
 *   5. THE HUMAN-CLEARANCE SPINE: review → cleared ONLY through the
 *      recorded clearance (actor identity + REQUIRED rationale) — no
 *      auto-clear path exists anywhere in the code;
 *   6. the route surface is EXACTLY the frozen nine (GET/POST only);
 *   7. the dependency posture (arch-check on the REAL codebase): zero
 *      violations, the module public imports only the matrix-listed
 *      publics (/evidence + /policies — the DISCLOSED currently-
 *      satisfiable subset; /content-assets joins at MKT-064 time);
 *   8. the disclosed spec registration exists (the §6 line + sentence,
 *      the matrix row + bullet, the migration tail position);
 *   9. the composition root + application surface carry the module
 *      (the shared-file registration).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  CONTENT_RIGHTS_ASSET_KINDS,
  CONTENT_RIGHTS_EVENT_KINDS,
  CONTENT_RIGHTS_GATE_OUTCOMES,
  CONTENT_RIGHTS_GATE_REASON_CODES,
  CONTENT_RIGHTS_PERMISSIONS,
  CONTENT_RIGHTS_STATES,
  CONTENT_RIGHTS_VOCABULARY_VERSION,
} from '../../src/modules/content-rights/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration051 = read(src('platform', 'db', 'migrations', '051_content_rights.sql'));
const rightsPublic = read(src('modules', 'content-rights', 'public.ts'));
const rightsModule = read(src('modules', 'content-rights', 'internal', 'module.ts'));
const rightsStore = read(src('modules', 'content-rights', 'internal', 'store.ts'));
const rightsValidation = read(src('modules', 'content-rights', 'internal', 'validation.ts'));
const rightsRoutes = read(src('api', 'content-rights-routes.ts'));
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

/** Comment-stripped SQL (dash-dash line comments and block comments). */
function stripSqlComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 051: OWN TABLES ONLY
// ---------------------------------------------------------------------------

test('MKT-063: migration 051 creates exactly the five content-rights tables — OWN tables ONLY', () => {
  const created = [...migration051.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    [
      'content_rights_records',
      'content_rights_clearances',
      'content_rights_events',
      'content_rights_permissions',
      'content_rights_lineage_links',
    ],
    'own tables ONLY — the rights records, the human clearances, the append-only transition-event tail, the destination-platform permission scope and the immutable ingredient lineage links; the /evidence, /policies, tenant and future /content-assets authorities stay sole',
  );

  // The rights-record shape.
  const recordColumns = columnsOf(createTableBlock(migration051, 'content_rights_records'));
  for (const required of [
    'rights_record_id', 'agency_id', 'client_id', 'workspace_id', 'content_asset_ref',
    'asset_kind', 'state', 'source_evidence_ref', 'licence_label', 'licence_evidence_ref',
    'valid_until', 'created_by_actor', 'created_via', 'correlation_id', 'causation_id',
    'created_at', 'updated_at', 'version',
  ]) {
    assert.ok(recordColumns.includes(required), `content_rights_records must carry '${required}'`);
  }

  // The event tail shape.
  const eventColumns = columnsOf(createTableBlock(migration051, 'content_rights_events'));
  for (const required of [
    'event_id', 'rights_record_id', 'from_state', 'to_state', 'event_kind', 'reason',
    'clearance_id', 'recorded_by_actor', 'recorded_via', 'correlation_id', 'causation_id',
    'recorded_at',
  ]) {
    assert.ok(eventColumns.includes(required), `content_rights_events must carry '${required}'`);
  }

  // The clearance shape.
  const clearanceColumns = columnsOf(createTableBlock(migration051, 'content_rights_clearances'));
  for (const required of [
    'clearance_id', 'rights_record_id', 'cleared_by_actor', 'cleared_via', 'rationale',
    'evidence_ref', 'correlation_id', 'causation_id', 'cleared_at',
  ]) {
    assert.ok(clearanceColumns.includes(required), `content_rights_clearances must carry '${required}'`);
  }

  // The permission shape.
  const permissionColumns = columnsOf(createTableBlock(migration051, 'content_rights_permissions'));
  for (const required of [
    'permission_id', 'rights_record_id', 'platform_key', 'permission', 'evidence_ref',
    'recorded_by_actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
  ]) {
    assert.ok(permissionColumns.includes(required), `content_rights_permissions must carry '${required}'`);
  }

  // The lineage shape.
  const lineageColumns = columnsOf(createTableBlock(migration051, 'content_rights_lineage_links'));
  for (const required of [
    'lineage_link_id', 'agency_id', 'client_id', 'workspace_id', 'composite_asset_ref',
    'ingredient_asset_ref', 'recorded_by_actor', 'recorded_via', 'correlation_id',
    'causation_id', 'created_at',
  ]) {
    assert.ok(lineageColumns.includes(required), `content_rights_lineage_links must carry '${required}'`);
  }

  // OWN TABLES ONLY: no other module's table is created or mutated.
  for (const forbidden of [
    'CREATE TABLE IF NOT EXISTS evidence', 'CREATE TABLE IF NOT EXISTS policy_decisions',
    'CREATE TABLE IF NOT EXISTS policies', 'CREATE TABLE IF NOT EXISTS credential_references',
    'CREATE TABLE IF NOT EXISTS clients', 'CREATE TABLE IF NOT EXISTS agencies',
    'CREATE TABLE IF NOT EXISTS workspaces', 'CREATE TABLE IF NOT EXISTS growth_missions',
    'CREATE TABLE IF NOT EXISTS content_assets', 'CREATE TABLE IF NOT EXISTS executions',
    'CREATE TABLE IF NOT EXISTS workflows', 'CREATE TABLE IF NOT EXISTS jobs',
    'ALTER TABLE evidence', 'ALTER TABLE policy_decisions', 'ALTER TABLE clients',
    'ALTER TABLE growth_missions', 'ALTER TABLE content_assets',
  ]) {
    assert.ok(!migration051.includes(forbidden), `migration 051 must not create or mutate another authority's table (${forbidden})`);
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies + the DB fences
// ---------------------------------------------------------------------------

test('MKT-063 AC-1: the frozen vocabularies are CHECK-fenced in migration 051 (incl. the frozen transition table)', () => {
  // The module vocabulary is exactly the disclosed set and carries a version.
  assert.equal(CONTENT_RIGHTS_VOCABULARY_VERSION, 'cr-vocab-v1');
  assert.equal(CONTENT_RIGHTS_STATES.length, 7);
  assert.equal(CONTENT_RIGHTS_ASSET_KINDS.length, 2);
  assert.equal(CONTENT_RIGHTS_EVENT_KINDS.length, 6);
  assert.equal(CONTENT_RIGHTS_PERMISSIONS.length, 2);
  assert.equal(CONTENT_RIGHTS_GATE_OUTCOMES.length, 3);
  assert.equal(CONTENT_RIGHTS_GATE_REASON_CODES.length, 18);

  // Every vocabulary value is CHECK-fenced in the migration.
  for (const state of CONTENT_RIGHTS_STATES) {
    assert.ok(migration051.includes(`'${state}'`), `rights state '${state}' must be CHECK-fenced`);
  }
  for (const kind of CONTENT_RIGHTS_ASSET_KINDS) {
    assert.ok(migration051.includes(`'${kind}'`), `asset kind '${kind}' must be CHECK-fenced`);
  }
  for (const kind of CONTENT_RIGHTS_EVENT_KINDS) {
    assert.ok(migration051.includes(`'${kind}'`), `event kind '${kind}' must be CHECK-fenced`);
  }
  for (const permission of CONTENT_RIGHTS_PERMISSIONS) {
    assert.ok(migration051.includes(`'${permission}'`), `permission '${permission}' must be CHECK-fenced`);
  }

  // THE FROZEN TRANSITION TABLE CHECK — the fail-closed human-action spine.
  assert.ok(migration051.includes('content_rights_transition_table_check'));
  assert.ok(
    migration051.includes("from_state = 'review' AND event_kind = 'human_clearance' AND to_state = 'cleared'"),
    'the ONLY row into cleared is review --human_clearance--> cleared',
  );
  assert.ok(
    migration051.includes("from_state = 'unknown' AND event_kind = 'determination'"),
    'determination resolves only the unknown state',
  );
  // The event-shape CHECK: clearance_id REQUIRED exactly for human_clearance.
  assert.ok(migration051.includes('content_rights_event_shape'));

  // The disciplined state-move trigger on the records (the same frozen
  // pairs; `cleared` reachable only from `review`).
  assert.ok(migration051.includes('content_rights_record_disciplined'));
  assert.ok(
    migration051.includes("OLD.state = 'review' AND NEW.state IN ('cleared', 'blocked')"),
    'the record state may leave review only toward cleared/blocked',
  );

  // The one-record-per-(client, asset ref) fence.
  assert.ok(migration051.includes('content_rights_records_asset_fence'));
  assert.ok(
    migration051.includes('ON content_rights_records (client_id, content_asset_ref)'),
    'the asset fence is exactly (client, asset ref)',
  );

  // The lineage pair fence + the no-self-link CHECK.
  assert.ok(migration051.includes('content_rights_lineage_links_pair_fence'));
  assert.ok(migration051.includes('content_rights_lineage_no_self'));

  // The tenant scope-chain + same-Client evidence triggers.
  assert.ok(migration051.includes('content_rights_scope_chain_consistent'));
  assert.ok(migration051.includes('content_rights_lineage_scope_chain_consistent'));
  assert.ok(migration051.includes('content_rights_evidence_same_client'));
  assert.ok(migration051.includes('content_rights_clearance_evidence_same_client'));
  assert.ok(migration051.includes('content_rights_permission_evidence_same_client'));
  assert.ok(
    migration051.includes('cross-tenant evidence linkage is rejected'),
    'the same-Client evidence backstop fires on cross-tenant linkage',
  );

  // The append-only UPDATE/DELETE rejection triggers (events, clearances,
  // permissions, lineage) + the no-DELETE on records.
  assert.ok(migration051.includes('content_rights_event_append_only'));
  assert.ok(migration051.includes('content_rights_clearance_append_only'));
  assert.ok(migration051.includes('content_rights_permission_append_only'));
  assert.ok(migration051.includes('content_rights_lineage_append_only'));
  assert.ok(migration051.includes('content_rights_record_no_delete'));

  // The licence-basis payload-shape CHECK (a licence state requires its
  // licence evidence).
  assert.ok(migration051.includes('content_rights_record_shape'));
});

// ---------------------------------------------------------------------------
// 3. THE FAIL-CLOSED GATE BATTERY (static semantics)
// ---------------------------------------------------------------------------

test('MKT-063 AC-4: the gate code is fail-closed by construction — absent/unknown/review/expired/denied never allow', () => {
  const moduleCode = stripComments(rightsModule);

  // The absent-record case returns blocked BEFORE anything else.
  assert.ok(moduleCode.includes("'no_rights_record'"));
  assert.ok(moduleCode.includes('an absent rights evaluation is BLOCKED, never allowed'));

  // The pure state evaluation maps unknown/review to review_required —
  // and the contract pins that the review_required surface is the
  // blocked_pending_human_action source (a CONTRACT-DOCUMENTATION
  // assertion — the raw text, comments included).
  assert.ok(rightsPublic.includes("'review_required'"));
  assert.ok(
    rightsPublic.includes('blocked_pending_human_action'),
    'the contract names the blocked_pending_human_action posture for review_required consumers',
  );

  // Expiry fails closed (the pure core checks validUntil first).
  assert.ok(
    stripComments(rightsPublic).includes("input.validUntil !== null && input.validUntil <= input.nowIso"),
    'the pure evaluation checks expiry BEFORE the state switch',
  );
  assert.ok(moduleCode.includes("'licence_expired'"));

  // The destination scope decides licence bases; unspecified fails closed.
  assert.ok(moduleCode.includes("'destination_permission_unspecified'"));
  assert.ok(moduleCode.includes("'destination_not_permitted'"));

  // The policy gate: only an explicit allow permits; deny AND unknown
  // both block.
  assert.ok(moduleCode.includes('enforcementOutcome(decision) === \'allow\''));
  assert.ok(moduleCode.includes("'policy_denied'"));
  assert.ok(
    moduleCode.includes('policyAllowed'),
    'the policy outcome composes into the final gate outcome',
  );
  // The policy decision is recorded on EVERY evaluation (the decision id
  // rides the result — the destinationPolicyGateRequired rule).
  assert.ok(moduleCode.includes('policyDecisionId: decision.decisionId'));

  // The conjunction: any blocked/absent ingredient blocks; any unclear
  // ingredient makes the composite review_required.
  assert.ok(moduleCode.includes('conjunctionOfGateOutcomes'));
  assert.ok(moduleCode.includes("'ingredient_rights_unclear'"));
  assert.ok(moduleCode.includes("'ingredient_no_rights_record'"));
  assert.ok(moduleCode.includes("'ingredient_blocked'"));

  // The composite-without-lineage case blocks (sourceLineageRequired).
  assert.ok(moduleCode.includes("'lineage_missing'"));
  assert.ok(moduleCode.includes('the conjunction cannot be evaluated, fail-closed'));
  assert.ok(rightsModule.includes('an unauditable composite is'));

  // The cycle + depth guards fail closed.
  assert.ok(moduleCode.includes("'lineage_cycle'"));
  assert.ok(moduleCode.includes("'lineage_depth_exceeded'"));
  assert.ok(
    stripComments(rightsValidation).includes('MAX_LINEAGE_DEPTH = 16'),
    'the traversal depth is bounded',
  );
});

// ---------------------------------------------------------------------------
// 4. THE BOUNDARY-RULE-4 BATTERY (no publication authority)
// ---------------------------------------------------------------------------

test('MKT-063 boundary rule 4: NO publication authority — the gate blocks or refers to review, never publishes', () => {
  // No publication verb anywhere in the module, the store, the routes or
  // the migration. The gate POST is an EVALUATION.
  const forbiddenPublicationVerbs = [
    'publishContent', 'publishAsset', 'dispatchPublication', 'executePublication',
    'postContent', 'uploadMedia', 'schedulePublication', 'publish(',
    'dispatch(', 'emitPublication',
  ];
  for (const source of [
    stripComments(rightsPublic),
    stripComments(rightsModule),
    stripComments(rightsStore),
    stripComments(rightsValidation),
    stripComments(rightsRoutes),
  ]) {
    for (const forbidden of forbiddenPublicationVerbs) {
      assert.ok(
        !source.includes(forbidden),
        `no publication verb ('${forbidden}') may exist anywhere in the content-rights module — publishing is MKT-065's execution surface (boundary rule 4)`,
      );
    }
  }

  // The migration creates no publication/lifecycle state of any kind.
  const migrationCode = stripSqlComments(migration051);
  for (const forbidden of ['publication_status', 'published_at', 'dispatched_at', 'upload_ref']) {
    assert.ok(!migrationCode.includes(forbidden), `no publication-state column ('${forbidden}') may exist in migration 051`);
  }

  // The route surface carries the gate as an EVALUATION and documents
  // the no-publish posture.
  assert.ok(rightsRoutes.includes('THE PUBLICATION GATE'));
  assert.ok(rightsRoutes.includes('never a publication'));

  // Boundary rule 4 verbatim: cannot silently approve unclear rights —
  // the contract states it (a CONTRACT-DOCUMENTATION assertion — the
  // raw text, comments included; the phrase may wrap across comment
  // lines, so assert the unwrappable fragment).
  assert.ok(
    rightsPublic.includes('silently approve unclear rights'),
    'the module contract states boundary rule 4',
  );
});

// ---------------------------------------------------------------------------
// 5. THE HUMAN-CLEARANCE SPINE (no auto-clear path)
// ---------------------------------------------------------------------------

test('MKT-063 AC-2: review → cleared happens ONLY through the recorded human clearance — no auto-clear path exists', () => {
  const moduleCode = stripComments(rightsModule);
  const validationCode = stripComments(rightsValidation);
  const storeCode = stripComments(rightsStore);

  // The module REQUIRES the clearance payload for human_clearance
  // transitions (the guard fires before any write).
  assert.ok(validationCode.includes('clearance: REQUIRED for a human_clearance transition'));
  assert.ok(
    validationCode.includes('ONLY a human_clearance transition carries a clearance payload'),
  );

  // The clearance row is created in the SAME transaction as the event
  // + the state move (all-or-nothing — there is no clearance-free path
  // into cleared).
  assert.ok(storeCode.includes('INSERT INTO content_rights_clearances'));
  // The store's transition transaction composes clearance + event + move.
  assert.ok(storeCode.includes('recordTransition'));

  // The clearing actor is the SERVER-DERIVED provenance actor (a human
  // identity at the route surface — never a request field).
  assert.ok(storeCode.includes('provenance.actor'));
  assert.ok(migration051.includes('cleared_by_actor'));

  // Fair-use reasoning rides as review evidence on the clearance —
  // never an auto-clear (the contract states it — the raw text).
  assert.ok(
    rightsPublic.includes('fair-use reasoning'),
    'the contract documents the fair-use-as-review-evidence rule',
  );
  assert.ok(
    !moduleCode.includes('autoClear') && !moduleCode.includes('auto_clear'),
    'no auto-clear path exists in the module core',
  );

  // The gate never treats fair-use evidence as a licence basis: only
  // the recorded `cleared` state (borne of the clearance event) allows.
  assert.ok(moduleCode.includes("'allowed_human_clearance'"));
});

// ---------------------------------------------------------------------------
// 6. The route surface battery
// ---------------------------------------------------------------------------

test('MKT-063: the route surface is EXACTLY the frozen nine — GET/POST only, no publish/dispatch route', () => {
  const registrations = [...rightsRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(
    registrations.sort(),
    [
      'POST /api/clients/:clientId/content-rights',
      'GET /api/clients/:clientId/content-rights',
      'GET /api/clients/:clientId/content-rights/by-asset/:assetRef',
      'POST /api/clients/:clientId/content-rights/gate',
      'POST /api/clients/:clientId/content-rights/lineage',
      'GET /api/clients/:clientId/content-rights/lineage/:compositeAssetRef',
      'GET /api/clients/:clientId/content-rights/:rightsRecordId',
      'POST /api/clients/:clientId/content-rights/:rightsRecordId/transitions',
      'POST /api/clients/:clientId/content-rights/:rightsRecordId/permissions',
    ].sort(),
    'exactly the registration POST, the gate POST, the lineage POST, the transition + permission POSTs and the four reads; no PUT/PATCH/DELETE and no publish/dispatch route of any kind',
  );

  // No update/delete verb on the rights family.
  assert.ok(!/router\.add\(\s*'(PUT|PATCH|DELETE)'/i.test(rightsRoutes));

  // The authority-field rejection contract.
  assert.ok(rightsRoutes.includes('CONTENT_RIGHTS_AUTHORITY_FIELDS'));
  for (const authorityField of [
    'rightsRecordId', 'agencyId', 'clientId', 'state', 'version', 'outcome', 'reasons',
    'policyDecisionId', 'secret', 'material',
  ]) {
    assert.ok(rightsRoutes.includes(`'${authorityField}'`), `the DTOs reject the authority field '${authorityField}'`);
  }

  // The uniform-404 discipline + authorization are wired.
  assert.ok(rightsRoutes.includes('requireClientAccess'));
  assert.ok(rightsRoutes.includes('requireWorkspaceAccess'));
  assert.ok(rightsRoutes.includes('requireRightsRecordInClient'));
  assert.ok(rightsRoutes.includes('resolveRightsOwnership'));

  // The literal-segment routes register BEFORE the :rightsRecordId
  // patterns (first-match-wins — the jobs-queue precedent).
  const gatePos = rightsRoutes.indexOf("'/api/clients/:clientId/content-rights/gate'");
  const byAssetPos = rightsRoutes.indexOf("'/api/clients/:clientId/content-rights/by-asset/:assetRef'");
  const recordPos = rightsRoutes.indexOf("'/api/clients/:clientId/content-rights/:rightsRecordId'");
  assert.ok(gatePos < recordPos && byAssetPos < recordPos, 'literal segments register before :rightsRecordId');

  // routes.ts registers the family.
  assert.ok(routesTs.includes("import { registerContentRightsRoutes } from './content-rights-routes.ts'"));
  assert.ok(routesTs.includes('registerContentRightsRoutes(router, services, modules)'));
});

// ---------------------------------------------------------------------------
// 7. The dependency posture (arch-check on the REAL codebase)
// ---------------------------------------------------------------------------

test('MKT-063: the real codebase enforces the frozen boundaries — zero violations, the module public imports only the matrix-listed publics', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );

  // The frozen matrix row is parsed from the spec docs.
  const modules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.ok(modules.includes('content-rights'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  // The disclosed subset was COMPLETED by the MKT-064 delivery (the
  // mutual registration: /content-assets now exists and joined the row).
  assert.deepEqual(matrix['content-rights'], ['evidence', 'policies', 'content-assets']);

  // The module public imports exactly the matrix-listed module publics
  // and platform contracts.
  const publicImports = [...rightsPublic.matchAll(/from '\.\.\/\.\.\/([a-z/-]+)\/|from '\.\.\/([a-z-]+)\/public\.ts'/g)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    [...new Set(publicImports)].sort(),
    ['evidence', 'policies', 'platform/clock', 'platform/db', 'platform/ids'].sort(),
  );

  // The application surface carries the module (the shared-file
  // registration — the composition root constructs it).
  assert.ok(applicationTs.includes('contentRights: ContentRightsModuleApi'));
  assert.ok(compositionRoot.includes('createContentRightsModule'));
  assert.ok(
    compositionRoot.includes('const contentRights = createContentRightsModule({'),
    'the composition root constructs the content-rights module',
  );
});

// ---------------------------------------------------------------------------
// 8. The disclosed spec registration
// ---------------------------------------------------------------------------

test('MKT-063: the disclosed spec registration exists (the §6 line + sentence, the matrix row + bullet, the migration position)', () => {
  // §6 module list line.
  assert.ok(/^\/content-rights$/m.test(architectureSpec));
  // §6 registration sentence.
  assert.ok(architectureSpec.includes('`/content-rights` is the v1.6 Content Rights and Provenance authority'));
  // The matrix row (the subset COMPLETED at MKT-064 time — the mutual registration).
  assert.ok(matrixSpec.includes('/content-rights ──→ /evidence, /policies, /content-assets'));
  // The authority bullet (the disclosed /content-assets seam).
  assert.ok(matrixSpec.includes('- `/content-rights` is the v1.6 Content Rights and Provenance authority'));
  assert.ok(matrixSpec.includes('`/content-assets` joined the row at MKT-064 time'));

  // 051 holds its numeric position; the MKT-064 delivery appends
  // 053 after it in the ordered expected-migration list of the
  // infra-adapters architecture test (the sibling-tail reconciliation
  // precedent — the tail is the merged-tree truth).
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const expectedListMatch = infraAdapters.match(/assert\.deepEqual\(migrations, \[([\s\S]*?)\]\);/);
  assert.ok(expectedListMatch !== null, 'the expected-migration list must exist');
  const listEntries = [...expectedListMatch[1]!.matchAll(/'(\d{3}_[a-z_]+\.sql)'/g)].map((m) => m[1]!);
  // The MKT-067 /experiment-analysis sibling delivery appends 054 and
  // the MKT-065 /cross-platform-distribution sibling delivery appends
  // 055 after it (the same additive precedent — every tail position
  // shifts once more; the merged-tree truth).
  // The MKT-062 sibling delivery appends 056_research.sql and
  // 057_content_intelligence.sql (the PRE-ASSIGNED numbers — every tail
  // position shifts once more; the same additive re-pin precedent).
  assert.equal(listEntries[listEntries.length -2], '057_content_intelligence.sql');
  // The MKT-066 sibling delivery appends 058_platform_health.sql (the
  // PRE-ASSIGNED number — every tail position shifts once more; the same
  // additive re-pin precedent).
  assert.equal(listEntries[listEntries.length - 1], '058_platform_health.sql');
  assert.equal(listEntries[listEntries.length -3], '056_research.sql');
  assert.equal(listEntries[listEntries.length -4], '055_cross_platform_distribution.sql');
  assert.equal(listEntries[listEntries.length -5], '054_experiment_analysis.sql');
  assert.equal(listEntries[listEntries.length -6], '053_content_assets.sql');
  assert.equal(listEntries[listEntries.length -7], '052_growth_operator.sql');
  assert.equal(listEntries[listEntries.length -8], '051_content_rights.sql');
  assert.equal(listEntries[listEntries.length -9], '050_social_adapter_contract.sql');
  // The migration file exists.
  assert.ok(existsSync(src('platform', 'db', 'migrations', '051_content_rights.sql')));
});

// ---------------------------------------------------------------------------
// 9. The MKT-064 seam disclosure (the ordering decision)
// ---------------------------------------------------------------------------

test('MKT-063: the content-asset reference seam is disclosed — opaque refs + the typed port, never an import of a nonexistent module', () => {
  // The public contract declares the seam.
  assert.ok(rightsPublic.includes('ContentAssetReferencePort'));
  assert.ok(rightsPublic.includes('THE CONTENT-ASSET REFERENCE SEAM'));
  assert.ok(rightsPublic.includes('never an import of a nonexistent module'));

  // The module NEVER resolves asset refs through a /content-assets
  // import (the arch-check zero-violation proof above pins the import
  // set; additionally pinned directly).
  assert.ok(!rightsPublic.includes("from '../content-assets/"));
  assert.ok(!stripComments(rightsModule).includes('content-assets'));
  assert.ok(!stripComments(rightsStore).includes('content-assets'));

  // The refs ride as grammar-fenced opaque data.
  assert.ok(migration051.includes("content_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'"));
  assert.ok(migration051.includes("composite_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'"));
  assert.ok(migration051.includes("ingredient_asset_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'"));
});
