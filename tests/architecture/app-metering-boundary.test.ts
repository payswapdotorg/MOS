/**
 * MKT-052 static tests — the App Metering and Commercial Attribution
 * domain is structurally correct in the ACTUAL migration, module
 * contract and route surface (pure static analysis, no DB).
 *
 * Proofs (spec/mos-app-ecosystem-v1.5.md "Economics" — the primary
 * contract: "MOS may meter installations, invocation count,
 * compute/runtime, data volume and premium capabilities. Marketplace
 * attribution is separate from the core financial authority."; frozen by
 * spec/architecture-lock-v1.5.md rules #6-posture/#13; frozen matrix
 * registration /app-metering ──→ /apps, /app-installs, /extensions,
 * /workspaces):
 *   1. migration 044 (the PRE-ASSIGNED number) creates exactly
 *      `app_metering_events` + `app_metering_rollups` — OWN tables ONLY,
 *      NO app catalog/install/trust/invocation table (the /apps,
 *      /app-installs, /app-marketplace, /extensions authorities stay
 *      sole), no billing/invoice/payment/balance/pricing column ANYWHERE
 *      (THE FINANCIAL-AUTHORITY SEPARATION — the Economics rule);
 *   2. the FROZEN METERING VOCABULARY is CHECK-fenced: the five spec
 *      dimensions, the per-dimension unit fence, the payload-shape fence
 *      per source kind, the at-most-once partial unique source fence,
 *      the §8 (workspace_id, idempotency_key) command fence, the
 *      scope-chain + canonical identity re-verification triggers and the
 *      append-only UPDATE/DELETE rejection triggers;
 *   3. THE FINANCIAL-AUTHORITY SEPARATION BATTERY (AC-3's static half —
 *      the heart): ZERO billing/charging verbs anywhere in the module
 *      code, the routes, the migration or the public contract — no
 *      invoice, no payment, no charge, no balance, no price, no rate, no
 *      currency, no amount column or method; the module API's only
 *      mutation methods are the meter-event append (collection +
 *      ingestion) and the rollup recompute (a derived-projection
 *      rebuild), and DML targets ONLY the module's own two tables;
 *   4. the /app-metering public contract imports ONLY the /apps,
 *      /app-installs and /extensions public contracts (the
 *      matrix-listed directions) — NO other module imports, NO provider
 *      SDKs, NO module-internal cross imports (the real-codebase
 *      arch-check run with zero violations);
 *   5. the ROUTE surface is EXACTLY THE THREE GET attribution views —
 *      GET-ONLY, no body, no DTO, no query parameters; NO
 *      POST/PUT/PATCH/DELETE anywhere in the family (the collection,
 *      ingestion and recompute commands are module-level operations);
 *   6. the spec registration exists: /app-metering in
 *      spec/architecture.md §6 + the matrix row in
 *      spec/module-dependency-matrix.md; 044_app_metering.sql holds its
 *      numeric position in the expected-migration list;
 *   7. the version discipline: the frozen vocabulary version
 *      (am-meter-v1) + the attribution calculation version (am-attrib-v1)
 *      + the disclosed assumption set ship on the public contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitecture, parseFrozenMatrix, parseFrozenModules } from '../../tools/arch-check/checker.ts';
import { APP_METERING_DIMENSIONS } from '../../src/modules/apps/public.ts';
import {
  APP_METERING_ATTRIBUTION_CALCULATION_VERSION,
  APP_METERING_UNITS,
  APP_METERING_VOCABULARY_VERSION,
  APP_METERING_ASSUMPTIONS,
  APP_METERING_COLLECT_KEY_PREFIX,
  APP_METERING_INGESTIBLE_DIMENSIONS,
  APP_METERING_SOURCE_KINDS,
} from '../../src/modules/app-metering/public.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const migration044 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '044_app_metering.sql'));
const meteringPublic = read(src('modules', 'app-metering', 'public.ts'));
const meteringModule = read(src('modules', 'app-metering', 'internal', 'module.ts'));
const meteringStore = read(src('modules', 'app-metering', 'internal', 'store.ts'));
const meteringAttribution = read(src('modules', 'app-metering', 'internal', 'attribution.ts'));
const meteringRoutes = read(src('api', 'app-metering-routes.ts'));
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

// ---------------------------------------------------------------------------
// 1. Migration 044: OWN TABLES ONLY, no financial columns anywhere
// ---------------------------------------------------------------------------

test('MKT-052: migration 044 creates exactly the two metering tables — OWN tables ONLY (no catalog/install/trust/invocation table)', () => {
  const created = [...migration044.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    created,
    ['app_metering_events', 'app_metering_rollups'],
    'own tables ONLY — the metering tail + the rebuildable rollup projection; the /apps registry (037), the install ledger (038), the trust/review ledgers (042) and the invocation ledger (028) stay the sole authorities, consumed READ-ONLY through the public contracts',
  );

  // The tail's frozen columns: the metering vocabulary, the scope chain,
  // the canonical source references, the provenance and the §8 command
  // identity.
  const eventColumns = columnsOf(createTableBlock(migration044, 'app_metering_events'));
  for (const required of [
    'event_id', 'dimension', 'unit', 'quantity',
    'agency_id', 'client_id', 'workspace_id',
    'app_key', 'app_version_id', 'version',
    'extension_id', 'extension_key', 'extension_publisher', 'extension_version',
    'capability', 'state_namespace',
    'source_kind', 'source_id', 'source_link_id',
    'occurred_at',
    'recorded_actor', 'recorded_via', 'correlation_id', 'causation_id', 'recorded_at',
    'idempotency_key', 'create_fingerprint',
  ]) {
    assert.ok(eventColumns.includes(required), `app_metering_events must carry '${required}'`);
  }
  // The rollup's derived-aggregate grain.
  const rollupColumns = columnsOf(createTableBlock(migration044, 'app_metering_rollups'));
  for (const required of [
    'agency_id', 'client_id', 'workspace_id', 'app_key',
    'dimension', 'unit', 'period_start', 'quantity_sum', 'event_count', 'rebuilt_at',
  ]) {
    assert.ok(rollupColumns.includes(required), `app_metering_rollups must carry '${required}'`);
  }
  // No secret-material column anywhere (§21 posture: bounded scalars +
  // the closed-vocabulary labels only — NO jsonb payload column at all).
  for (const table of ['app_metering_events', 'app_metering_rollups']) {
    const block = createTableBlock(migration044, table);
    assert.ok(!/jsonb/.test(block), `${table} carries no jsonb payload`);
    assert.ok(
      !/secret|password|token|api_key/.test(columnsOf(block).join(',')),
      `${table} carries no material-shaped column`,
    );
  }
});

test('MKT-052 AC-3 static: NO billing/invoice/payment/balance/pricing column exists ANYWHERE in migration 044 (the financial-authority separation)', () => {
  const columns = [
    ...columnsOf(createTableBlock(migration044, 'app_metering_events')),
    ...columnsOf(createTableBlock(migration044, 'app_metering_rollups')),
  ].join(',').toLowerCase();
  for (const forbidden of [
    'price', 'amount', 'currency', 'rate', 'cost', 'invoice', 'payment',
    'charge', 'billing', 'balance', 'credit', 'debit', 'fee', 'monetary', 'money',
  ]) {
    assert.ok(
      !columns.includes(forbidden),
      `the metering tables must NEVER carry the financial column '${forbidden}' — meter records carry quantities, never money (mos-app-ecosystem-v1.5.md "Economics": marketplace attribution stays separate from the core financial authority)`,
    );
  }
  // The migration's own README states the separation.
  assert.ok(migration044.includes('NO price, rate, amount, currency, charge, invoice'));
  assert.ok(migration044.includes('METERING IS OBSERVATION, NOT BILLING'));
});

// ---------------------------------------------------------------------------
// 2. The frozen metering vocabulary + the database fences
// ---------------------------------------------------------------------------

test('MKT-052 AC-2 static: the five spec dimensions are CHECK-fenced with the per-dimension unit fence (the am-meter-v1 storage mirror)', () => {
  // The closed five-dimension vocabulary (mos-app-ecosystem-v1.5.md
  // "Economics", verbatim).
  assert.ok(
    migration044.includes(
      "CHECK (dimension IN ('installations', 'invocations', 'compute-runtime', 'data-volume', 'premium-capabilities'))",
    ),
    'the closed five-dimension vocabulary is CHECK-fenced on BOTH tables',
  );
  // The per-dimension unit fence: the IMMUTABLE validator + the CHECKs.
  assert.ok(
    migration044.includes('CREATE OR REPLACE FUNCTION app_metering_dimension_unit_valid(dimension text, unit text)'),
    'the dimension→unit validator exists',
  );
  for (const [dimension, unit] of Object.entries(APP_METERING_UNITS)) {
    assert.ok(
      migration044.includes(`(dimension = '${dimension}' AND unit = '${unit}')`),
      `the unit fence ties '${dimension}' to EXACTLY '${unit}'`,
    );
  }
  // The code-side frozen vocabulary agrees with the storage mirror (one
  // frozen set, one owner — re-exported from the /apps contract).
  assert.deepEqual(APP_METERING_DIMENSIONS, [
    'installations',
    'invocations',
    'compute-runtime',
    'data-volume',
    'premium-capabilities',
  ]);
  assert.deepEqual(APP_METERING_UNITS, {
    installations: 'selections',
    invocations: 'invocations',
    'compute-runtime': 'milliseconds',
    'data-volume': 'bytes',
    'premium-capabilities': 'capability-uses',
  });
});

test('MKT-052 AC-1/AC-6 static: the payload-shape fence, the at-most-once source fence, the §8 command fence and the append-only triggers exist', () => {
  // THE PAYLOAD-SHAPE FENCE (the frozen per-source event shapes).
  assert.ok(
    migration044.includes("CONSTRAINT app_metering_event_shape CHECK ("),
    'the payload-shape fence exists',
  );
  for (const kind of APP_METERING_SOURCE_KINDS) {
    assert.ok(
      migration044.includes(`source_kind = '${kind}'`),
      `the payload-shape fence names the source kind '${kind}'`,
    );
  }
  // THE AT-MOST-ONCE METERING FENCE for collected sources (the
  // idempotent-convergence backstop).
  assert.ok(migration044.includes('app_metering_events_source_once_fence'));
  assert.ok(
    migration044.includes("WHERE source_kind IN ('app-install-selection', 'extension-invocation')"),
    'the at-most-once fence covers the collected sources only (usage observations are §8 logical commands)',
  );
  // THE §8 COMMAND FENCE (one logical metering command per workspace).
  assert.ok(migration044.includes('app_metering_events_idempotency_key_unique'));
  // THE APPEND-ONLY TAIL (UPDATE and DELETE rejected outright).
  assert.ok(migration044.includes('CREATE OR REPLACE FUNCTION app_metering_events_append_only()'));
  assert.ok(migration044.includes('app_metering_events_append_only_update_trigger'));
  assert.ok(migration044.includes('app_metering_events_append_only_delete_trigger'));
  assert.ok(
    migration044.includes('app metering events are append-only'),
    'the append-only rejection message is explicit',
  );
  // THE TENANT FENCE + THE CANONICAL IDENTITY re-verification triggers.
  assert.ok(migration044.includes('CREATE OR REPLACE FUNCTION app_metering_scope_chain_consistent()'));
  assert.ok(migration044.includes('CREATE OR REPLACE FUNCTION app_metering_identity_consistent()'));
  assert.ok(
    migration044.includes('REFERENCES app_versions(app_version_id)'),
    'the app identity is FK-anchored to the immutable registry (read check-only)',
  );
  assert.ok(
    migration044.includes('REFERENCES extensions(extension_id)'),
    'the extension identity is FK-anchored to the immutable registry (read check-only)',
  );
  // THE RECOMPUTE DISCIPLINE: the rollup projection is a REPLACEABLE
  // derived projection (the disclosed rebuild path), never append-only —
  // and the migration says so.
  assert.ok(migration044.includes('replaceable atomically by the'));
  assert.ok(migration044.includes('A DERIVED PROJECTION, never a second truth'));
  assert.ok(migration044.includes('rebuildable from it'));
});

// ---------------------------------------------------------------------------
// 3. THE FINANCIAL-AUTHORITY SEPARATION BATTERY (AC-3's static heart)
// ---------------------------------------------------------------------------

test('MKT-052 AC-3 static: ZERO billing/charging verbs in the module code — the mutation surface is meter-event append + rollup recompute ONLY', () => {
  // The public contract's module API: the exact method set. The ONLY
  // methods that mutate anything are collectWorkspaceMetering (append),
  // recordMeterObservation (append) and recomputeAttributionRollups
  // (derived-projection rebuild) — zero billing/charging methods.
  const publicCode = stripComments(meteringPublic);
  for (const method of [
    'collectWorkspaceMetering',
    'recordMeterObservation',
    'recomputeAttributionRollups',
    'getWorkspaceAppMetering',
    'getAgencyAppMetering',
    'getPublisherAppMetering',
    'getAppMeterEvent',
    'listWorkspaceMeterEvents',
  ]) {
    assert.ok(publicCode.includes(method), `AppMeteringModuleApi declares ${method}`);
  }
  // THE BILLING-VERB BATTERY: none of these identifiers may appear as
  // CODE anywhere in the module, the routes or the migration (prose
  // comments DISCUSSING the absence are stripped first).
  for (const file of [meteringPublic, meteringModule, meteringStore, meteringAttribution, meteringRoutes]) {
    const code = stripComments(file).toLowerCase();
    for (const forbidden of [
      'invoice', 'payment', 'charge', 'billing', 'balance', 'settle', 'payout',
      'revenue', 'price', 'pricing', 'amountdue', 'debit', 'creditnote',
    ]) {
      assert.ok(
        !code.includes(forbidden),
        `the metering code must never contain the billing verb '${forbidden}' — derived attribution, never a financial authority (architecture-lock v1.5 #6 posture + the Economics rule)`,
      );
    }
  }
  // The migration's CODE (not prose) carries no financial column — the
  // column battery above already proved it; this pins the DML surface.
  const storeCode = stripComments(meteringStore);
  // DML-against-own-tables ONLY: the store's write statements target
  // exactly app_metering_events (INSERT) + app_metering_rollups
  // (DELETE + INSERT in the recompute).
  const insertTables = [...storeCode.matchAll(/INSERT INTO ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(insertTables)], ['app_metering_events', 'app_metering_rollups']);
  const deleteTables = [...storeCode.matchAll(/DELETE FROM ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(deleteTables, ['app_metering_rollups']);
  assert.ok(
    !/\bUPDATE\s+[a-z_]+\s+SET/i.test(storeCode),
    'the store never issues an UPDATE (the tail is append-only; the rollups are replaced atomically)',
  );
  // NO read of another module's table either — every cross-module read
  // composes the /apps, /app-installs, /extensions public contracts (the
  // only FROM targets are the OWN tail + the recompute's own projection).
  const selectTables = [...storeCode.matchAll(/FROM ([a-z_]+)/g)].map((m) => m[1]!);
  assert.deepEqual(
    [...new Set(selectTables)].sort(),
    ['app_metering_events', 'app_metering_rollups'],
    'the store reads ONLY the own tables — every other read composes a public contract',
  );
});

// ---------------------------------------------------------------------------
// 4. Zero cross-module internal imports (the real-codebase arch-check run)
// ---------------------------------------------------------------------------

test('MKT-052 AC-9 static: the real codebase enforces the frozen boundaries with ZERO violations — /app-metering is a registered frozen module', () => {
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((v) => `[${v.rule}] ${v.file}`),
    [],
  );
  assert.ok(result.frozenModules.includes('app-metering'), 'the enforced set includes /app-metering');
  // The matrix-listed composition directions are exactly the four.
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  const matrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['app-metering'], ['apps', 'app-installs', 'extensions', 'workspaces']);
  // The module's public contract imports ONLY the three matrix-listed
  // module publics + platform ports (structural typing covers
  // /workspaces at the composition root).
  const imports = [...meteringPublic.matchAll(/from '\.\.\/([\w-]+)\/public\.ts'/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(imports)].sort(), ['app-installs', 'apps', 'extensions']);
});

// ---------------------------------------------------------------------------
// 5. The GET-only route surface (AC-4)
// ---------------------------------------------------------------------------

test('MKT-052 AC-4 static: the route surface is EXACTLY the three GET attribution views — no mutation verb, no body, no DTO, no query parameters', () => {
  const routes = [...stripComments(meteringRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/app-metering/agencies/:agencyId',
    'GET /api/app-metering/publishers/:userId',
    'GET /api/app-metering/workspaces/:workspaceId',
  ]);
  const routesCode = stripComments(meteringRoutes);
  for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !routesCode.includes(`'${verb}'`),
      `the route file never registers the verb '${verb}' (module-level operations only)`,
    );
  }
  // No DTO/validation/body surface at all (the read-model posture).
  assert.ok(!routesCode.includes('validateObject'), 'no DTO validation exists (no body is read)');
  assert.ok(!routesCode.includes('ctx.request.body'), 'no request body is read');
  // The uniform-404/403/401 posture helpers exist.
  assert.ok(routesCode.includes('NotFoundError'), 'the uniform 404 error class');
  assert.ok(routesCode.includes('ForbiddenError'), 'the 403 error class');
  assert.ok(routesCode.includes('requireWorkspaceAccess'), 'the workspace ownership resolution');
  assert.ok(routesCode.includes('requireMeteringAgency'), 'the agency membership resolution');
  assert.ok(routesCode.includes('requireMeteringPublisher'), 'the publisher identity resolution');
  // The publisher view NEVER surfaces tenant identities (the route
  // derives 'dev:<userId>' and the view carries per-app/per-period rows
  // only — asserted on the module side by the integration suite).
  assert.ok(routesCode.includes('`dev:${ctx.params.userId}`'), 'the publisher identity is SERVER-DERIVED from the path selector');
});

// ---------------------------------------------------------------------------
// 6. The spec registration + the migration list position
// ---------------------------------------------------------------------------

test('MKT-052 AC-9 static: the disclosed spec registration exists — §6 line + the matrix row + 044 in numeric position', () => {
  // The §6 module list carries /app-metering.
  assert.ok(
    /^\/app-metering$/m.test(architectureSpec),
    'spec/architecture.md §6 lists /app-metering',
  );
  assert.ok(
    architectureSpec.includes('`/app-metering` is the v1.5 App metering and commercial attribution authority'),
    'the §6 registration sentence exists',
  );
  // The matrix row + the forbidden-directions bullet.
  assert.ok(
    matrixSpec.includes('/app-metering ──→ /apps, /app-installs, /extensions, /workspaces'),
    'the matrix dependency row exists',
  );
  assert.ok(
    matrixSpec.includes('- `/app-metering` is the v1.5 App metering and commercial attribution authority'),
    'the matrix forbidden-directions bullet exists',
  );
  // 044_app_metering.sql holds its numeric position (the PRE-ASSIGNED
  // number — 039/041/043 are reserved-but-unused by sibling deliveries;
  // the MKT-053/MKT-055 deliveries append 045/046 after it, so 044 is third-to-last).
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  // The MKT-053 delivery appends 045_growth_missions.sql after 044 and
  // the MKT-055 delivery appends 046_social_accounts.sql after it (both
  // numbers PRE-ASSIGNED to their Work Items; 039/041/043 reserved-but-
  // unused by the no-migration deliveries).
  // The MKT-068 /notification-delivery, MKT-069 /product-intelligence and
  // MKT-071 commerce-capability deliveries append 047, 048 and 049 after
  // 046 (all numbers PRE-ASSIGNED to those sibling Work Items), and the
  // MKT-056 social-adapter-contract delivery appends 050 after 049, so
  // this module's 044 shifts four positions earlier in the ordered tail.
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 7], '044_app_metering.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 6], '045_growth_missions.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 5], '046_social_accounts.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 4], '047_notification_delivery.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 3], '048_product_intelligence.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 2], '049_commerce_capabilities.sql');
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '050_social_adapter_contract.sql');
  // The shared files register the module additively.
  assert.ok(applicationTs.includes('readonly appMetering: AppMeteringModuleApi'), 'ApplicationModules.appMetering');
  assert.ok(applicationTs.includes("from '../modules/app-metering/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerAppMeteringRoutes(router, services, modules)'), 'routes.ts registers the metering routes');
  assert.ok(routesTs.includes("from './app-metering-routes.ts'"), 'routes.ts imports the metering route builder');
  assert.ok(compositionRoot.includes('createAppMeteringModule'), 'the composition root constructs the metering module');
  assert.ok(
    compositionRoot.includes('workspaceOwnership: workspaces'),
    'the REAL /workspaces public-contract instance satisfies the ownership port',
  );
  // The module boundary is complete.
  assert.ok(existsSync(src('modules', 'app-metering', 'public.ts')));
  assert.ok(existsSync(src('modules', 'app-metering', 'internal', 'module.ts')));
  assert.ok(existsSync(src('modules', 'app-metering', 'internal', 'store.ts')));
  assert.ok(existsSync(src('modules', 'app-metering', 'internal', 'attribution.ts')));
});

// ---------------------------------------------------------------------------
// 7. The version discipline + the frozen assumption set (AC-2/AC-3)
// ---------------------------------------------------------------------------

test('MKT-052 AC-2/AC-8 static: the version discipline ships — the frozen vocabulary version, the attribution calculation version and the disclosed assumption set', () => {
  assert.equal(APP_METERING_VOCABULARY_VERSION, 'am-meter-v1');
  assert.equal(APP_METERING_ATTRIBUTION_CALCULATION_VERSION, 'am-attrib-v1');
  // The assumption set: every disclosed derivation assumption pinned.
  assert.equal(APP_METERING_ASSUMPTIONS.installationUnit, 'one-per-selection-row');
  assert.equal(APP_METERING_ASSUMPTIONS.currentInstallationBasis, 'active-selection-rows');
  assert.equal(APP_METERING_ASSUMPTIONS.invocationAppAttribution, 'dependency-declared-current-selection');
  assert.equal(APP_METERING_ASSUMPTIONS.unattributedInvocationPolicy, 'disclosed-unattributed');
  assert.equal(APP_METERING_ASSUMPTIONS.periodBasis, 'source-occurred-at-utc-calendar-month');
  assert.equal(APP_METERING_ASSUMPTIONS.premiumCapabilityBasis, 'manifest-declared-capability-usage-observations');
  assert.equal(APP_METERING_ASSUMPTIONS.usageQuantityBasis, 'runtime-host-reported-observations');
  // The ingestible dimensions are the three usage dimensions (the
  // installations/invocations dimensions are collection-only).
  assert.deepEqual(APP_METERING_INGESTIBLE_DIMENSIONS, [
    'compute-runtime',
    'data-volume',
    'premium-capabilities',
  ]);
  // The reserved collection-key prefix.
  assert.equal(APP_METERING_COLLECT_KEY_PREFIX, 'collect:');
  // Every view composes the SAME disclosure (the pure helper).
  assert.ok(meteringPublic.includes('composeAppMeteringCalculationDisclosure'));
  // The pure linkage is on the public contract (unit-testable).
  assert.ok(meteringPublic.includes('export function attributeInvocationToApp'));
  assert.ok(meteringPublic.includes('export function meteringPeriodStartOf'));
});
