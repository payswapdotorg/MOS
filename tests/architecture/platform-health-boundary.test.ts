/**
 * MKT-066 static tests — the /platform-health domain is structurally
 * correct in the ACTUAL migration, module contract and route surface
 * (pure static analysis, no DB; the content-intelligence-boundary
 * precedent).
 *
 * Proofs (spec/effective-backlog-v1.6.md MKT-066; spec/architecture-v1.6.md
 * §11 — the primary contract; frozen matrix registration
 * /platform-health ──→ /social-accounts, /integrations, /metrics,
 * /evidence, /experiments — verbatim):
 *   1. migration 058 (the PRE-ASSIGNED number) creates exactly the FOUR
 *      own tables — OWN tables ONLY, NO evidence/metric/experiment/
 *      account/grant/attempt/integration/mission/workflow/execution/
 *      learning/decision/tenant table (the composed authorities stay
 *      sole; the health evaluation COMPOSES observable records through
 *      the five frozen-row public contracts and cites them by reference);
 *   2. the FROZEN VOCABULARIES are CHECK-fenced: the NINE §11 states
 *      (there is deliberately NO shadow-ban state or synonym anywhere —
 *      lock rule 26), the three confidence tiers and the ph-vocab-v1 /
 *      ph-baseline-v1 version strings;
 *   3. THE APPEND-ONLY + SCOPE BATTERY: the append-only UPDATE/DELETE
 *      rejection triggers on every table and every cross-module FK scope
 *      fence (evidence same-Client, metric observations same-Client,
 *      publish attempts same-Client — all read CHECK-ONLY);
 *   4. THE OBSERVABLE-SIGNALS-ONLY BATTERY (§11; lock rules 25/26): the
 *      observability disclosure constant ships on the public contract; NO
 *      shadow-ban vocabulary exists anywhere in the module source; the
 *      FORBIDDEN response actions are structurally absent from the
 *      recommendation vocabulary; the module imports NO
 *      /cross-platform-distribution (not an allowance of the frozen row);
 *   5. THE READ-ONLY BOUNDARY BATTERY: the module imports EXACTLY the
 *      five frozen matrix allowances through their public contracts, all
 *      consumed READ-ONLY (no account/attempt/metric/evidence/experiment
 *      mutation method is called from the module code) — DML against the
 *      module's OWN tables only;
 *   6. the ROUTE surface is EXACTLY the four GET/POST record routes —
 *      no PUT/PATCH/DELETE anywhere in the family (evaluations are
 *      append-only), NO authority-shaped request field, NO enforcement
 *      verb, and the audit details carry ONLY scalar values (the
 *      append-guard discipline);
 *   7. the spec registration exists: /platform-health in
 *      spec/architecture.md §6 + the authority paragraph + the matrix
 *      row + the authority-notes bullet in
 *      spec/module-dependency-matrix.md;
 *      058_platform_health.sql is the migration tail;
 *   8. the real codebase enforces the frozen boundaries with ZERO
 *      violations (49 enforced modules after this registration).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import {
  PLATFORM_HEALTH_STATES,
  PLATFORM_HEALTH_MANEUVERS,
  PLATFORM_HEALTH_FORBIDDEN_ACTIONS,
  PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE,
} from '../../src/modules/platform-health/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration058 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '058_platform_health.sql'));
const phPublic = read(src('modules', 'platform-health', 'public.ts'));
const phModule = read(src('modules', 'platform-health', 'internal', 'platform-health-module.ts'));
const phStore = read(src('modules', 'platform-health', 'internal', 'platform-health-store.ts'));
const phEvaluation = read(src('modules', 'platform-health', 'internal', 'evaluation.ts'));
const phRoutes = read(src('api', 'platform-health-routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const architectureSpec = read(join(repoRoot, 'spec', 'architecture.md'));
const matrixSpec = read(join(repoRoot, 'spec', 'module-dependency-matrix.md'));

const moduleFiles = [
  src('modules', 'platform-health', 'public.ts'),
  src('modules', 'platform-health', 'internal', 'platform-health-module.ts'),
  src('modules', 'platform-health', 'internal', 'platform-health-store.ts'),
  src('modules', 'platform-health', 'internal', 'evaluation.ts'),
];

/** Comment-stripped source (prose must not confuse the code scans). */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

/** Comment-stripped SQL (the migration prose disclosures are not vocabulary). */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// ---------------------------------------------------------------------------
// 1. Migration 058: OWN TABLES ONLY, no authority table
// ---------------------------------------------------------------------------

test('MKT-066: migration 058 creates exactly the four own tables — OWN tables ONLY (no authority table, no shadow ledger)', () => {
  const created = [...migration058.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(created, [
    'platform_health_evaluations',
    'platform_health_evaluation_evidence',
    'platform_health_evaluation_metric_observations',
    'platform_health_evaluation_publication_refs',
  ]);
  // No other table is created or mutated anywhere in the migration.
  assert.ok(!/INSERT INTO|UPDATE [a-z_]+ SET|DELETE FROM/i.test(
    migration058.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?LANGUAGE plpgsql;/g, ''),
  ));
  // The anchored authority tables are read CHECK-ONLY (scope fences only).
  for (const authorityTable of ['evidence ', 'metric_observations ', 'social_publish_attempts ']) {
    assert.ok(
      migration058.includes(`FROM ${authorityTable.trim()} WHERE`),
      `the ${authorityTable.trim()} table is read CHECK-ONLY inside a scope fence`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. The frozen vocabularies are CHECK-fenced
// ---------------------------------------------------------------------------

test('MKT-066: the FROZEN NINE §11 states, the confidence tiers and the version strings are CHECK-fenced in migration 058', () => {
  const evaluationsTable = migration058.slice(
    migration058.indexOf('CREATE TABLE IF NOT EXISTS platform_health_evaluations'),
    migration058.indexOf('CREATE INDEX IF NOT EXISTS platform_health_evaluations_client_idx'),
  );
  for (const state of PLATFORM_HEALTH_STATES) {
    assert.ok(evaluationsTable.includes(`'${state}'`), `state '${state}' is CHECK-fenced`);
  }
  // Lock rule 26: NO shadow-ban state or synonym exists anywhere in the
  // migration DDL (the header's deliberate-nonexistence DISCLOSURE
  // comments are prose, not vocabulary — stripped before the scan) or
  // the module contract.
  assert.ok(!/shadow/i.test(stripSqlComments(migration058)), 'no shadow-ban vocabulary in the migration');
  assert.ok(!/shadow.?ban/i.test(stripComments(phPublic).replace(/never a shadow-ban claim/g, '')), 'no shadow-ban state in the contract');

  for (const tier of ['high', 'medium', 'low']) {
    assert.ok(
      evaluationsTable.includes(`confidence                     text        NOT NULL`),
      'the confidence column is CHECK-fenced',
    );
    assert.ok(evaluationsTable.includes(`'${tier}'`), `confidence tier '${tier}' is CHECK-fenced`);
  }
  assert.ok(migration058.includes("vocabulary_version             text        NOT NULL"));
  assert.ok(migration058.includes("CHECK (vocabulary_version = 'ph-vocab-v1')"));
  assert.ok(migration058.includes("CHECK (baseline_version = 'ph-baseline-v1')"));
  // The bounded jsonb blocks.
  assert.ok(migration058.includes("jsonb_array_length(reason_codes) <= 24"));
  assert.ok(migration058.includes("jsonb_array_length(evidence_basis) <= 128"));
});

// ---------------------------------------------------------------------------
// 3. The append-only + scope-fence battery
// ---------------------------------------------------------------------------

test('MKT-066: the append-only UPDATE/DELETE rejection triggers exist on EVERY table', () => {
  // table → the append-only FUNCTION prefix its triggers execute (the
  // house naming: the metric link table's functions use the
  // 'metric_links' short name — the migration-057 precedent).
  const triggerFamilies: Readonly<Record<string, string>> = {
    platform_health_evaluations: 'platform_health_evaluations',
    platform_health_evaluation_evidence: 'platform_health_evaluation_evidence',
    platform_health_evaluation_metric_observations: 'platform_health_evaluation_metric_links',
    platform_health_evaluation_publication_refs: 'platform_health_evaluation_publication_refs',
  };
  for (const [table, family] of Object.entries(triggerFamilies)) {
    assert.ok(
      migration058.includes(`CREATE OR REPLACE FUNCTION ${family}_append_only()`),
      `${family}_append_only exists`,
    );
    assert.ok(
      migration058.includes(`CREATE TRIGGER ${family}_append_only_update_trigger`),
      `${family}_append_only_update_trigger exists`,
    );
    assert.ok(
      migration058.includes(`CREATE TRIGGER ${family}_append_only_delete_trigger`),
      `${family}_append_only_delete_trigger exists`,
    );
    assert.ok(
      migration058.includes(`ON ${table}`),
      `the triggers fence ${table}`,
    );
  }
});

test('MKT-066: every cross-module FK link is scope-fenced same-Client (the anchored tables read CHECK-ONLY)', () => {
  assert.ok(migration058.includes('CREATE OR REPLACE FUNCTION platform_health_evaluation_evidence_scope_consistent()'));
  assert.ok(migration058.includes('CREATE TRIGGER platform_health_evaluation_evidence_scope_trigger'));
  assert.ok(migration058.includes('CREATE OR REPLACE FUNCTION platform_health_evaluation_metric_scope_consistent()'));
  assert.ok(migration058.includes('CREATE TRIGGER platform_health_evaluation_metric_scope_trigger'));
  assert.ok(migration058.includes('CREATE OR REPLACE FUNCTION platform_health_evaluation_publication_scope_consistent()'));
  assert.ok(migration058.includes('CREATE TRIGGER platform_health_evaluation_publication_scope_trigger'));
  // The evaluation FK-anchors the owning client + the 046 account.
  assert.ok(migration058.includes('REFERENCES clients(client_id)'));
  assert.ok(migration058.includes('REFERENCES social_accounts(social_account_id)'));
});

// ---------------------------------------------------------------------------
// 4. The observable-signals-only battery (§11; lock rules 25/26/27)
// ---------------------------------------------------------------------------

test('MKT-066: the observability disclosure ships on the public contract; NO shadow-ban vocabulary exists in the module source', () => {
  assert.ok(
    PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE.includes('hidden platform moderation state is never invented'),
  );
  assert.ok(phPublic.includes('export const PLATFORM_HEALTH_OBSERVABILITY_DISCLOSURE'));
  // No shadow-ban state/synonym exists in any module file's identifiers.
  // (The observability DISCLOSURE constant legitimately contains the
  // phrase "never a shadow-ban claim" — the §11 disclaimer itself; it is
  // excluded from the vocabulary scan.)
  for (const file of moduleFiles) {
    const code = stripComments(read(file)).replace(/never a shadow-ban claim/g, '');
    assert.ok(
      !/['"`][^'"`]*shadow[-_ ]?ban[^'"`]*['"`]/i.test(code),
      `${file}: no shadow-ban string literal exists`,
    );
  }
});

test('MKT-066: the FORBIDDEN response actions are structurally absent from the recommendation vocabulary (lock rule 27)', () => {
  for (const forbidden of PLATFORM_HEALTH_FORBIDDEN_ACTIONS) {
    assert.ok(!(PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(forbidden as never));
    // The maneuver mapping table in the evaluation core contains exactly
    // the frozen maneuver kinds — no evasion surface exists.
    assert.ok(!stripComments(phEvaluation).includes(forbidden));
  }
  // Every maneuver kind in the mapping is a frozen §11 maneuver.
  const maneuversBlock = stripComments(phEvaluation).slice(
    stripComments(phEvaluation).indexOf('STATE_MANEUVERS'),
    stripComments(phEvaluation).indexOf('STATE_RATIONALES'),
  );
  const maneuverMentions = [...maneuversBlock.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
  for (const mention of maneuverMentions) {
    assert.ok(
      (PLATFORM_HEALTH_MANEUVERS as readonly string[]).includes(mention as never),
      `maneuver '${mention}' is a frozen §11 maneuver`,
    );
  }
});

test('MKT-066: the module imports NO /cross-platform-distribution (not an allowance of the frozen row)', () => {
  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    assert.ok(!code.includes('cross-platform-distribution'), `${file}: no /cross-platform-distribution import`);
  }
});

// ---------------------------------------------------------------------------
// 5. The read-only boundary battery (the five frozen-row allowances)
// ---------------------------------------------------------------------------

test('MKT-066: the module imports EXACTLY the five frozen matrix allowances through their public contracts', () => {
  const specDir = join(repoRoot, 'spec');
  const modules = parseFrozenModules(join(specDir, 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(specDir, 'module-dependency-matrix.md'),
    join(specDir, 'module-dependency-v1.3.md'),
    [...modules, 'apps'],
  );
  assert.deepEqual(matrix['platform-health'], [
    'social-accounts', 'integrations', 'metrics', 'evidence', 'experiments',
  ]);

  const allowedImports = new Set(
    matrix['platform-health']!.map((target) => `../${target}/public.ts`),
  );
  allowedImports.add('../../platform/clock/clock.ts');
  allowedImports.add('../../platform/db/contract.ts');
  allowedImports.add('../../platform/ids/ids.ts');
  allowedImports.add('../../platform/errors/errors.ts');
  allowedImports.add('../../../platform/clock/clock.ts');
  allowedImports.add('../../../platform/db/contract.ts');
  allowedImports.add('../../../platform/ids/ids.ts');
  allowedImports.add('../../../platform/errors/errors.ts');
  allowedImports.add('../public.ts');
  allowedImports.add('./evaluation.ts');
  allowedImports.add('./platform-health-store.ts');
  allowedImports.add('./internal/platform-health-module.ts');
  allowedImports.add('./internal/evaluation.ts');
  allowedImports.add('./internal/platform-health-store.ts');

  for (const file of moduleFiles) {
    const code = stripComments(read(file));
    for (const match of code.matchAll(/from '(\.[^']+)'/g)) {
      const specifier = match[1]!;
      assert.ok(
        allowedImports.has(specifier),
        `${file}: import '${specifier}' is a frozen-row allowance (platform imports, the shared guards or the module's own files)`,
      );
    }
  }
});

test('MKT-066: DML against the module\'s OWN tables only — zero reads of another module\'s tables from the module code', () => {
  const storeCode = stripComments(phStore);
  for (const statement of storeCode.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+([a-z_]+)/g)) {
    const table = statement[1]!;
    assert.ok(
      table.startsWith('platform_health_'),
      `the store queries only the module's own tables (found '${table}')`,
    );
  }
  // No mutation method over any composed authority is called from the
  // module code (the five contracts are consumed READ-ONLY).
  const moduleCode = stripComments(phModule);
  const readOnlyCalls = [
    'resolveAccountOwnership',
    'resolveAccountCapabilityMatrix',
    'listAuthorizationGrantsForAccount',
    'listPublishAttemptsForAccount',
    'listPublishStatusObservations',
    'listSocialAccountsForClient',
    'getConnection',
    'listMetricObservationsForClient',
    'getEvidence',
    'listExperimentsForClient',
  ];
  for (const call of readOnlyCalls) {
    assert.ok(moduleCode.includes(`${call}(`), `the module composes ${call}`);
  }
  const forbiddenMutationCalls = [
    'submitPublish(',
    'disconnectAccount(',
    'recordExternalRevocation(',
    'startAuthorization(',
    'completeAuthorization(',
    'refreshAuthorization(',
    'expireAuthorizationGrant(',
    'appendEvidence(',
    'appendMetricObservation(',
    'createExperiment(',
    'applyExperimentTransition(',
    'registerConnection(',
    'connectConnection(',
    'suspendConnection(',
  ];
  for (const call of forbiddenMutationCalls) {
    assert.ok(!moduleCode.includes(call), `the module never calls the mutation surface ${call}`);
  }
});

// ---------------------------------------------------------------------------
// 6. The route surface battery
// ---------------------------------------------------------------------------

test('MKT-066: the route surface is EXACTLY the four GET/POST routes — no PUT/PATCH/DELETE, no authority field, no enforcement verb', () => {
  const registrations = [...phRoutes.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(registrations, [
    'POST /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations',
    'GET /api/clients/:clientId/platform-health/accounts/:socialAccountId/evaluations',
    'GET /api/clients/:clientId/platform-health',
    'GET /api/platform-health/evaluations/:evaluationId',
  ]);
  assert.ok(!/'(PUT|PATCH|DELETE)'/.test(phRoutes), 'no PUT/PATCH/DELETE exists in the family');
  // The evaluation command reads NO body: the empty-field shape gate with
  // the authority-field denylist (no signal/state/claim channel).
  assert.ok(phRoutes.includes('EVALUATION_AUTHORITY_FIELDS'));
  assert.ok(phRoutes.includes("'reasonCodes'"));
  assert.ok(phRoutes.includes("'confidence'"));
  assert.ok(phRoutes.includes("'evidenceBasis'"));
  // No enforcement verb exists anywhere in the route family.
  const routeCode = stripComments(phRoutes);
  for (const verb of ['pause', 'block', 'suspend', 'disconnect', 'revoke']) {
    assert.ok(!routeCode.includes(verb), `no enforcement verb '${verb}' in the route family`);
  }
  // The audit details carry ONLY scalar values (the append-guard
  // discipline — the MKT-065 route-fix precedent: no array-typed detail).
  const auditDetailsBlock = phRoutes.slice(
    phRoutes.indexOf("action: 'platformhealth.evaluation.recorded'"),
    phRoutes.indexOf('respond:', phRoutes.indexOf("action: 'platformhealth.evaluation.recorded'")),
  );
  assert.ok(auditDetailsBlock.includes('reasonCodes: ctx.result.evaluation.reasonCodes.join' + "(',')"),
    'the reason-code set rides as the deterministic comma-joined scalar');
  for (const detailLine of auditDetailsBlock.split('\n')) {
    if (detailLine.includes(':') && !detailLine.trim().startsWith('//') && detailLine.includes(',')) {
      assert.ok(!/:\s*\[/.test(detailLine) && !/\.map\(/.test(detailLine), `audit detail is scalar: ${line0(detailLine)}`);
    }
  }
});

function line0(text: string): string {
  return text.trim().slice(0, 90);
}

test('MKT-066: the audit emit cannot pass an array-shaped detail (the MKT-065 defect class is structurally excluded)', () => {
  // The route audit details are built from scalar fields only; this pins
  // the fix discipline that the MKT-065 dispatch-route defect disclosed.
  const auditBlock = phRoutes.slice(phRoutes.indexOf('recordMutationAudit'));
  assert.ok(!auditBlock.slice(0, 2000).includes('.map('), 'no array construction inside the audit details');
});

// ---------------------------------------------------------------------------
// 7. The spec registration
// ---------------------------------------------------------------------------

test('MKT-066: the disclosed spec registration exists — §6 line + authority paragraph + matrix row + authority-notes bullet; 058 is the migration tail', () => {
  // §6 module list line.
  assert.ok(/^\s*\/platform-health\s*$/m.test(architectureSpec), 'the §6 module list line');
  // The authority paragraph (the v1.4 promotion precedent).
  assert.ok(
    architectureSpec.includes('`/platform-health` is the v1.6 Platform Health and Distribution Anomaly Detection authority'),
    'the §6 authority paragraph',
  );
  // The matrix row VERBATIM (the frozen v1.6 row).
  assert.ok(
    matrixSpec.includes('/platform-health ──→ /social-accounts, /integrations, /metrics, /evidence, /experiments'),
    'the frozen matrix row registered verbatim',
  );
  // The authority-notes bullet.
  assert.ok(
    matrixSpec.includes('- `/platform-health` is the v1.6 Platform Health and Distribution Anomaly Detection authority'),
    'the authority-notes bullet',
  );
  // 058 is the migration tail.
  const migrations = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrations[migrations.length - 1], '058_platform_health.sql');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly platformHealth: PlatformHealthModuleApi'), 'ApplicationModules.platformHealth');
  assert.ok(applicationTs.includes("from '../modules/platform-health/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerPlatformHealthRoutes(router, services, modules)'), 'routes.ts registers the platform-health routes');
  assert.ok(routesTs.includes("from './platform-health-routes.ts'"), 'routes.ts imports the platform-health route builder');
  assert.ok(compositionRoot.includes('createPlatformHealthModule'), 'the composition root constructs the platform-health module');
});

// ---------------------------------------------------------------------------
// 8. The real codebase: zero violations (49 enforced modules)
// ---------------------------------------------------------------------------

test('MKT-066: the real codebase enforces the frozen boundaries with ZERO violations — /platform-health is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}: ${violation.detail}`),
    [],
  );
  assert.ok(result.frozenModules.includes('platform-health'));
  assert.equal(result.frozenModules.length, 49);
});
