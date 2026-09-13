/**
 * MKT-046 static tests — the Sales-to-Delivery Continuity boundary is
 * structurally correct in the ACTUAL route file, the /sales-continuity
 * module, the shared registration files and the additive spec entries
 * (pure static analysis, no DB; the MKT-043 profit-intelligence-boundary
 * precedent). Proves the frozen architecture boundaries
 * (spec/architecture-v1.5.md §8; the primary contract
 * spec/operating-graph-v1.5.md "Sales-to-delivery continuity";
 * spec/module-dependency-matrix.md "/sales-continuity ──→ /decisions,
 * /playbooks, /deployments, /clients, /workspaces, /evidence" + the
 * orchestrator forbidden-direction bullet):
 *
 *   1. the surface registers EXACTLY SEVEN routes (two POSTs + five
 *      GETs) and NO PUT/PATCH/DELETE — the continuity ledger is
 *      append-only with a forward-only completion ladder;
 *   2. NO validate/activate/transition surface: the route family NEVER
 *      calls the /deployments authority's validate/transition/request
 *      methods and NEVER the /playbooks create-update/profile methods —
 *      the MKT-040 gate and the playbook lifecycle stay the composed
 *      authorities' own surfaces (orchestrates, never duplicates);
 *   3. NO MANUAL RE-ENTRY (the §8 core): the carry DTO accepts ONLY the
 *      idempotency key + the optional goalId — every carried-payload,
 *      strategy, name, description or selection field is a FORBIDDEN
 *      authority field; the deployment-carry DTO accepts ONLY the
 *      workspace + the workflow definition references + the key (the
 *      selection is DERIVED from the published version's own metadata);
 *   4. the route file's imports are whitelisted: platform + authorize +
 *      audit-emit + application + the /sales-continuity and composed
 *      public contracts' TYPES only;
 *   5. thin delegation: the route file's ONLY module calls are the
 *      authorization reads, the sales-continuity module API and the
 *      ownership resolutions of the composed authorities;
 *   6. the ORCHESTRATES-NOT-DUPLICATES proof at the module level: the
 *      store's SQL touches ONLY the two sales_continuity_* tables (no
 *      INSERT/UPDATE/DELETE against decisions, playbooks,
 *      playbook_versions or deployments tables); the module writes
 *      playbook/deployment state ONLY through the composed public
 *      commands (createClientPlaybook/createPlaybookVersion/
 *      setPlaybookVersionStatus/createDeployment — never a second store);
 *   7. the module API exposes exactly the carry commands + the read/view
 *      surface; no method exists that mutates any OTHER authority's
 *      records;
 *   8. the migration discipline: exactly ONE module-owned migration
 *      (040_sales_continuity.sql — the pre-assigned number), creating
 *      ONLY the two sales_continuity_* tables, with the append-only +
 *      forward-only + cross-tenant triggers;
 *   9. the shared registration files wire the surface ONCE (one module
 *      in the composition root, one registration in routes.ts, one
 *      ApplicationModules member) and the additive spec entries exist
 *      (architecture.md §6 module line + the dependency-matrix row +
 *      the bullet);
 * 10. the module structure follows the house pattern (public.ts +
 *      internal/ only) and imports ONLY the frozen matrix's allowed
 *      public contracts;
 * 11. the structural ports: /clients + /workspaces arrive as the
 *      module's own declared port types (the /decisions precedent) —
 *      satisfied structurally at the composition root, never imported
 *      as concrete internals.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const spec = (...parts: string[]) => join(repoRoot, 'spec', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const continuityRoutes = read(src('api', 'sales-continuity-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));
const applicationFile = read(src('api', 'application.ts'));
const publicEntry = read(src('modules', 'sales-continuity', 'public.ts'));
const moduleFile = read(src('modules', 'sales-continuity', 'internal', 'sales-continuity-module.ts'));
const storeFile = read(src('modules', 'sales-continuity', 'internal', 'continuity-store.ts'));
const derivationFile = read(src('modules', 'sales-continuity', 'internal', 'continuity-derivation.ts'));
const migrationFile = read(src('platform', 'db', 'migrations', '040_sales_continuity.sql'));

/** Imports of a file as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  return specifiers;
}

// ---------------------------------------------------------------------------
// 1. Exactly seven surfaces — two POSTs + five GETs, nothing else
// ---------------------------------------------------------------------------

test('the sales-continuity routes register EXACTLY SEVEN surfaces — two POSTs + five GETs — and no other verb exists', () => {
  const registered = [...continuityRoutes.matchAll(/'(?:GET|POST|PUT|PATCH|DELETE)',\s*'(\/[^']+)'/g)]
    .map((match) => match[1]!);
  assert.deepEqual(registered, [
    '/api/decisions/:decisionId/carry',
    '/api/decisions/:decisionId/carry',
    '/api/sales-continuity/carries/:carryId/deployment',
    '/api/sales-continuity/carries/:carryId',
    '/api/sales-continuity/carries/:carryId/events',
    '/api/clients/:clientId/sales-continuity/carries',
    '/api/playbooks/:playbookId/carry',
  ]);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !continuityRoutes.includes(`'${verb}',`),
      `sales continuity must never register a ${verb} route (the ledger is append-only with a forward-only ladder)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. No validate/activate/transition surface — the composed authorities'
//    own gates are never duplicated or bypassed
// ---------------------------------------------------------------------------

test('the route family NEVER drives the deployment gate or the playbook lifecycle directly', () => {
  // The MKT-040 validate-before-activate gate stays the /deployments
  // routes' alone; the playbook lifecycle stays the /playbooks routes'.
  for (const forbiddenCall of [
    'validateDeployment',
    'transitionDeployment',
    'requestDeploymentExecution',
    'createAgencyPlaybook',
    'updatePlaybookProfile',
    'updatePlaybookVersionContent',
  ]) {
    assert.ok(
      !continuityRoutes.includes(forbiddenCall),
      `the sales-continuity route family must never call '${forbiddenCall}' (the composed authority's own surface)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. NO MANUAL RE-ENTRY — the carry DTOs reject every content field
// ---------------------------------------------------------------------------

test('the carry DTO accepts ONLY the key + the optional goalId — every content field is a forbidden authority field', () => {
  // The create surface: goalId + idempotencyKey only.
  const createFields = continuityRoutes.match(
    /const CARRY_CREATE_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(createFields !== null, 'the create authority-field list exists');
  for (const forbidden of [
    "'carriedPayload'",
    "'payload'",
    "'strategy'",
    "'name'",
    "'description'",
    "'templates'",
    "'deploymentMetadata'",
    "'objective'",
    "'hypothesisSummary'",
    "'expectedImpact'",
    "'expectedCost'",
    "'alternatives'",
    "'sourceDecisionId'",
    "'playbookId'",
    "'deploymentId'",
  ]) {
    assert.ok(
      createFields![1]!.includes(forbidden),
      `the carry create DTO must reject the content field ${forbidden} (no manual re-entry — the payload is derived)`,
    );
  }
  // The deployment-carry surface: workspace + definitions + key only.
  const deployFields = continuityRoutes.match(
    /const CARRY_DEPLOYMENT_AUTHORITY_FIELDS = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(deployFields !== null, 'the deployment-carry authority-field list exists');
  for (const forbidden of [
    "'selection'",
    "'requiredDomainPacks'",
    "'requiredCapabilities'",
    "'runtimeRequirements'",
    "'triggerConfig'",
    "'triggers'",
  ]) {
    assert.ok(
      deployFields![1]!.includes(forbidden),
      `the deployment-carry DTO must reject the selection field ${forbidden} (the selection is derived from the carried version's own metadata)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. Import whitelist — the composed authorities are reached through the
//    ApplicationModules aggregate + the /sales-continuity public contract
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + authorize + audit-emit + application + the /sales-continuity contract types', () => {
  const allowed = [
    /^node:/,
    /^\.\.\/platform\//,
    /^\.\.\/modules\/sales-continuity\/public\.ts$/,
    /^\.\.\/modules\/agencies\/public\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/application\.ts$/,
    /^\.\/audit-emit\.ts$/,
  ];
  for (const specifier of importsOf(src('api', 'sales-continuity-routes.ts'))) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import '${specifier}' — the sales-continuity routes compose the module contract + authorization only`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. Thin delegation — authorization + ownership + the module API only
// ---------------------------------------------------------------------------

test('the route file performs ONLY the durable authorization reads + the module API calls', () => {
  const allowedModuleCalls = [
    'modules.decisions.resolveDecisionOwnership',
    'modules.salesContinuity.resolveCarryOwnership',
    'modules.salesContinuity.carryProposalToPlaybook',
    'modules.salesContinuity.carryPlaybookToDeployment',
    'modules.salesContinuity.getContinuity',
    'modules.salesContinuity.getContinuityForProposal',
    'modules.salesContinuity.getContinuityForPlaybook',
    'modules.salesContinuity.listCarriesForClient',
    'modules.salesContinuity.listCarryEvents',
  ];
  for (const match of continuityRoutes.matchAll(/modules\.[a-zA-Z]+\.[A-Za-z]+/g)) {
    assert.ok(
      allowedModuleCalls.includes(match[0]),
      `unexpected module call '${match[0]}' — the sales-continuity surface is a thin delegation layer`,
    );
  }
  assert.ok(continuityRoutes.includes('requireDecisionAccess'));
  assert.ok(continuityRoutes.includes('requireClientAccess'));
  assert.ok(continuityRoutes.includes('requirePlaybookAccess'));
  assert.ok(continuityRoutes.includes('requireCarryAccess'));
});

// ---------------------------------------------------------------------------
// 6. ORCHESTRATES-NOT-DUPLICATES — the store SQL touches ONLY the
//    module-owned tables; the module writes only through the composed
//    public commands
// ---------------------------------------------------------------------------

/** Source text with line + block comments stripped (SQL matching over code only). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\s--.*$/, ''))
    .join('\n');
}

test('the store SQL touches ONLY the two sales_continuity_* tables (no second playbook/deployment/decision store)', () => {
  const code = stripComments(storeFile);
  for (const statement of [...code.matchAll(/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)]) {
    assert.equal(
      statement[1]!.startsWith('sales_continuity_'),
      true,
      `the store may only DML the module-owned tables, found '${statement[1]}'`,
    );
  }
  for (const statement of [...code.matchAll(/\bFROM\s+([a-z_]+)/g)]) {
    assert.ok(
      statement[1]!.startsWith('sales_continuity_'),
      `the store may only read the module-owned tables, found FROM ${statement[1]}`,
    );
  }
  for (const file of [moduleFile, derivationFile]) {
    for (const forbidden of ['INSERT INTO decisions', 'INSERT INTO playbooks', 'INSERT INTO playbook_versions', 'INSERT INTO deployments']) {
      assert.ok(
        !file.includes(forbidden),
        `the module implementation never writes other modules' tables (found '${forbidden}')`,
      );
    }
    assert.ok(!file.includes('db.query'), 'the module implementation holds no direct SQL (the store owns the module tables)');
  }
});

test('the module reaches the composed authorities ONLY through their public creation/status commands', () => {
  // The sanctioned write surface: exactly the four existing commands.
  assert.ok(moduleFile.includes('playbooks.createClientPlaybook('));
  assert.ok(moduleFile.includes('playbooks.createPlaybookVersion('));
  assert.ok(moduleFile.includes('playbooks.setPlaybookVersionStatus('));
  assert.ok(moduleFile.includes('deployments.createDeployment('));
  // And NO other mutation call over the composed authorities.
  for (const forbidden of [
    'playbooks.updatePlaybookProfile',
    'playbooks.updatePlaybookVersionContent',
    'deployments.validateDeployment',
    'deployments.transitionDeployment',
    'deployments.requestDeploymentExecution',
    'decisions.createDecision',
    'decisions.recordDecisionDisposition',
    'decisions.recordObservedOutcome',
  ]) {
    assert.ok(
      !moduleFile.includes(forbidden),
      `the module must never call '${forbidden}' (that authority stays the composed module's own surface)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 7. The module API surface — the carry commands + reads only
// ---------------------------------------------------------------------------

test('the module API exposes EXACTLY the two carry commands + the read/view surface', () => {
  const apiBlock = publicEntry.match(
    /export interface SalesContinuityModuleApi \{([\s\S]*?)\n\}/,
  );
  assert.ok(apiBlock !== null, 'the module API interface is declared');
  const methods = [...apiBlock[1]!.matchAll(/^\s{2}([a-z][A-Za-z]*)\(/gm)].map((match) => match[1]!);
  assert.deepEqual(
    [...methods].sort(),
    [
      'carryPlaybookToDeployment',
      'carryProposalToPlaybook',
      'getCarry',
      'getContinuity',
      'getContinuityForPlaybook',
      'getContinuityForProposal',
      'listCarriesForClient',
      'listCarryEvents',
      'resolveCarryOwnership',
    ].sort(),
  );
});

// ---------------------------------------------------------------------------
// 8. The migration discipline — exactly one module-owned migration with
//    the disclosed ledger semantics
// ---------------------------------------------------------------------------

test('the module owns EXACTLY ONE migration (040 — the pre-assigned number) creating ONLY the two ledger tables', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((name) =>
    name.endsWith('.sql'),
  );
  const owned = migrations.filter((name) => name.includes('sales_continuity'));
  assert.deepEqual(owned, ['040_sales_continuity.sql']);
  assert.equal(
    (migrationFile.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length,
    2,
    'migration 040 creates exactly the two sales_continuity_* tables',
  );
  assert.ok(migrationFile.includes('CREATE TABLE IF NOT EXISTS sales_continuity_carries'));
  assert.ok(migrationFile.includes('CREATE TABLE IF NOT EXISTS sales_continuity_events'));
  for (const forbidden of ['CREATE TABLE IF NOT EXISTS decisions', 'CREATE TABLE IF NOT EXISTS playbooks', 'CREATE TABLE IF NOT EXISTS playbook_versions', 'CREATE TABLE IF NOT EXISTS deployments', 'ALTER TABLE decisions', 'ALTER TABLE playbooks', 'ALTER TABLE deployments']) {
    assert.ok(
      !migrationFile.includes(forbidden),
      `migration 040 must never create or alter another module's table (found '${forbidden}')`,
    );
  }
});

test('migration 040 carries the 035/036 house style: append-only triggers, the forward-only completion guard and the cross-tenant fences', () => {
  // The append-only event tail.
  assert.ok(migrationFile.includes('sales_continuity_events_append_only'));
  // The no-delete carry history.
  assert.ok(migrationFile.includes('sales_continuity_carries_no_delete'));
  // The identity-immutability backstop.
  assert.ok(migrationFile.includes('sales_continuity_carry_identity_immutable'));
  // The forward-only completion ladder.
  assert.ok(migrationFile.includes('sales_continuity_carry_completion_guard'));
  assert.ok(migrationFile.includes('carry completion is forward-only'));
  // The cross-tenant reference fences.
  assert.ok(migrationFile.includes('sales_continuity_carry_reference_fences'));
  assert.ok(migrationFile.includes('cannot cross the Client boundary'));
  // The SOURCE fence (one carry per proposal version) + the §8 logical fence.
  assert.ok(migrationFile.includes('sales_continuity_carries_source_decision_id_key'));
  assert.ok(migrationFile.includes('sales_continuity_carries_idempotency_key_unique'));
  // The closed enums.
  assert.ok(migrationFile.includes("CHECK (carry_state IN ('carrying', 'carried',"));
  assert.ok(migrationFile.includes("CHECK (event_kind IN ('carry-claimed',"));
});

// ---------------------------------------------------------------------------
// 9. The shared registration files + the additive spec entries
// ---------------------------------------------------------------------------

test('routes.ts registers the sales-continuity family ONCE; application.ts exposes the SAME module contract', () => {
  assert.ok(
    routesFile.includes("import { registerSalesContinuityRoutes } from './sales-continuity-routes.ts'"),
  );
  assert.equal(
    (routesFile.match(/registerSalesContinuityRoutes\(router, services, modules\)/g) ?? []).length,
    1,
    'the sales-continuity family is registered exactly once',
  );
  assert.ok(routesFile.includes('MKT-046'));
  assert.ok(compositionRoot.includes('MKT-046'));
  assert.equal(
    (compositionRoot.match(/createSalesContinuityModule\(/g) ?? []).length,
    1,
    'the composition root must not wire a second sales-continuity module',
  );
  assert.ok(applicationFile.includes('readonly salesContinuity: SalesContinuityModuleApi'));
});

test('the additive spec entries exist (architecture.md §6 + the dependency-matrix row + the forbidden-direction bullet)', () => {
  const architecture = read(spec('architecture.md'));
  assert.ok(
    /^\/sales-continuity$/m.test(architecture),
    'the frozen module set includes /sales-continuity (required by the static checker)',
  );
  assert.ok(
    architecture.includes('`/sales-continuity` is the v1.5 Sales-to-Delivery Continuity orchestrator'),
    'the §6 provenance sentence registers the module (the MKT-043 mirror)',
  );
  const matrix = read(spec('module-dependency-matrix.md'));
  assert.ok(
    matrix.includes('/sales-continuity ──→ /decisions, /playbooks, /deployments, /clients, /workspaces, /evidence'),
    'the dependency matrix carries the additive /sales-continuity line',
  );
  assert.ok(
    matrix.includes('`/sales-continuity` is the v1.5 Sales-to-Delivery Continuity orchestrator'),
    'the forbidden-direction bullet for /sales-continuity exists',
  );
});

// ---------------------------------------------------------------------------
// 10. The module structure + the frozen import matrix
// ---------------------------------------------------------------------------

test('the module structure follows the house pattern (public.ts + internal/ only)', () => {
  const moduleDir = src('modules', 'sales-continuity');
  const entries = readdirSync(moduleDir, { withFileTypes: true })
    .filter((entry) => entry.name !== 'internal')
    .map((entry) => entry.name);
  assert.deepEqual(entries, ['public.ts'], 'exactly public.ts + internal/');
  const internal = readdirSync(join(moduleDir, 'internal')).sort();
  assert.deepEqual(internal, [
    'continuity-derivation.ts',
    'continuity-store.ts',
    'sales-continuity-module.ts',
  ]);
});

test('the module imports ONLY the frozen matrix allowances (decisions, playbooks, deployments, evidence — clients/workspaces as structural ports)', () => {
  const allowed = new Set([
    'decisions',
    'playbooks',
    'deployments',
    'evidence',
  ]);
  const moduleFiles = [
    src('modules', 'sales-continuity', 'public.ts'),
    src('modules', 'sales-continuity', 'internal', 'sales-continuity-module.ts'),
    src('modules', 'sales-continuity', 'internal', 'continuity-store.ts'),
    src('modules', 'sales-continuity', 'internal', 'continuity-derivation.ts'),
  ];
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      const match = specifier.match(/\/modules\/([a-z-]+)\/public\.ts$/);
      if (match === null) continue;
      assert.ok(
        allowed.has(match[1]!),
        `unexpected cross-module import '${specifier}' (the frozen matrix allows /decisions, /playbooks, /deployments, /evidence only — /clients and /workspaces arrive as structural ports)`,
      );
    }
  }
  // The structural ports: /clients + /workspaces are NEVER imported —
  // the port types are declared in the module's own public contract and
  // satisfied structurally at the composition root (the /decisions
  // precedent).
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !/\/modules\/(clients|workspaces)\//.test(specifier),
        `the /${specifier.includes('clients') ? 'clients' : 'workspaces'} contract is consumed as a STRUCTURAL PORT (declared in the module contract, satisfied at the composition root) — never imported (found '${specifier}')`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 11. The frozen carry vocabulary is exported (the pinning proof)
// ---------------------------------------------------------------------------

test('the frozen carry vocabulary is exported (states, event kinds, carried dimensions, derivation version)', () => {
  assert.ok(
    publicEntry.includes("export const SALES_CONTINUITY_CARRY_STATES = ['carrying', 'carried', 'deployed'] as const"),
  );
  assert.ok(
    publicEntry.includes("export const SALES_CONTINUITY_EVENT_KINDS = ["),
  );
  assert.ok(
    publicEntry.includes("export const SALES_CONTINUITY_CARRIED_DIMENSIONS = ["),
  );
  assert.ok(
    publicEntry.includes("export const SALES_CONTINUITY_DERIVATION_VERSION = 'sc-carry-v1' as const"),
  );
});

// ---------------------------------------------------------------------------
// 12. The composition-root wiring passes the real public-contract
//     instances (the structural ports are satisfied structurally)
// ---------------------------------------------------------------------------

test('the composition root wires the module ONCE with the composed public instances + platform services', () => {
  const wiring = compositionRoot.match(/createSalesContinuityModule\(\{[\s\S]*?\}\);/);
  assert.ok(wiring !== null, 'the composition root constructs the sales-continuity module');
  for (const expected of ['db,', 'clock,', 'ids,', 'decisions,', 'playbooks,', 'deployments,', 'clients,', 'workspaces,']) {
    assert.ok(
      wiring[0]!.includes(expected),
      `the wiring passes '${expected.trim()}' (the composed instances/platform services)`,
    );
  }
});
