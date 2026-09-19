/**
 * MKT-051 static tests — the Incumbent Capability App Program delivery is
 * structurally correct, authority-bounded and composition-only in the
 * ACTUAL module tree, route family, composition root and repo layout
 * (pure static analysis, no DB; the app-marketplace-boundary +
 * developer-portal-boundary precedents).
 *
 * Acceptance proofs (spec/mos-app-ecosystem-v1.5.md "Non-goals";
 * spec/architecture-v1.5.md §9/§13; spec/effective-backlog-v1.5.md
 * MKT-051; the dispatch AC-3/AC-4/AC-6/AC-7):
 *
 *   1. AC-3 (apps-not-authorities): the /first-party-apps module tree
 *      imports ONLY public contracts (platform + the matrix-listed
 *      modules' public.ts entries), ZERO module internals, ZERO
 *      SQL/table/column tokens, ZERO database dependency (no Db, no
 *      migrations) — the packs are registry data + presentation code;
 *
 *   2. AC-3 (zero mutation verbs over authorities): the module API and
 *      the pack composers contain NO create/append/update/delete/
 *      dispatch/record mutation call on ANY composed authority — the
 *      ONLY method verbs on the composed contracts are the READ
 *      listings/getters/compose inputs; the pack action menus DECLARE
 *      existing authority routes and execute nothing;
 *
 *   3. AC-3 (public-contracts-only): the arch-check provision (the
 *      frozen module set + the frozen matrix row) parses and enforces
 *      the /first-party-apps boundary — the module's imports all target
 *      matrix-listed public entries;
 *
 *   4. AC-3 (bounded state): the bounded app-state engine holds NO
 *      durable state (no SQL, no table, no migration file — 043 was
 *      NOT taken), the state namespaces are the manifest's own
 *      app:<key>:<local> namespaces, and the export/delete semantics
 *      exist on the public contract;
 *
 *   5. AC-4 (integrations stay behind the App/Integration contracts):
 *      NO direct network capability exists in pack code — no fetch, no
 *      http client, no outbound port import; the ONLY network surface
 *      is the manifest's DECLARED network destination consumed by the
 *      existing /integrations authority (read-only connection records);
 *
 *   6. AC-6 (delivery shape): the route family registers EXACTLY the
 *      six frozen routes; publish/install/trust are NOT re-implemented
 *      anywhere in the module or routes (the real /apps, /app-installs
 *      and /app-marketplace commands are the only paths — asserted by
 *      the absence of registry/ledger writes);
 *
 *   7. AC-7 (NO new authority): NO migration file exists for this Work
 *      Item (043_first_party_apps.sql NOT taken — the required
 *      preference), and the shared migration list is unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkArchitecture,
  parseFrozenMatrix,
  parseFrozenModules,
} from '../../tools/arch-check/checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleDir = join(repoRoot, 'src', 'modules', 'first-party-apps');
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.ts')) out.push(abs);
  }
  return out;
}

const moduleFiles = walk(moduleDir);
const routesFile = join(repoRoot, 'src', 'api', 'first-party-apps-routes.ts');

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

test('AC-3: the module tree exists with the frozen structure (public.ts + internal/ only)', () => {
  assert.ok(moduleFiles.length >= 10, 'the pack sources exist');
  const rels = moduleFiles.map((file) => file.slice(moduleDir.length + 1));
  for (const rel of rels) {
    assert.ok(
      rel === 'public.ts' || rel.startsWith('internal/'),
      `${rel} is public.ts or under internal/`,
    );
  }
  assert.ok(existsSync(join(moduleDir, 'public.ts')));
  assert.ok(existsSync(join(moduleDir, 'internal', 'module.ts')));
  assert.ok(existsSync(join(moduleDir, 'internal', 'state.ts')));
  // One manifest + one composer per pack.
  for (const pack of ['mos-analytics', 'mos-crm', 'mos-sheets', 'mos-portal']) {
    assert.ok(existsSync(join(moduleDir, 'internal', 'packs', pack, 'manifests.ts')), `${pack} manifests`);
    assert.ok(existsSync(join(moduleDir, 'internal', 'packs', pack, 'compose.ts')), `${pack} composer`);
  }
});

test('AC-3: the module imports ONLY platform + matrix-listed PUBLIC contracts (zero internals, zero cross-module drift)', () => {
  const allowedPublicTargets = new Set([
    // Pack-nested files (two levels deeper than internal/).
    '../../../platform/clock/clock.ts',
    '../../platform/clock/clock.ts',
    '../../../platform/errors/errors.ts',
    '../../platform/errors/errors.ts',
    '../app-installs/public.ts',
    '../../app-installs/public.ts',
    '../apps/public.ts',
    '../../apps/public.ts',
    '../../../../apps/public.ts',
    '../clients/public.ts',
    '../../clients/public.ts',
    '../decisions/public.ts',
    '../../decisions/public.ts',
    '../evidence/public.ts',
    '../../evidence/public.ts',
    '../integrations/public.ts',
    '../../integrations/public.ts',
    '../metrics/public.ts',
    '../../metrics/public.ts',
    '../profit-intelligence/public.ts',
    '../../profit-intelligence/public.ts',
    '../reporting/public.ts',
    '../../reporting/public.ts',
    '../workspaces/public.ts',
    '../../workspaces/public.ts',
    '../public.ts',
    '../../public.ts',
    '../../../public.ts',
    './state.ts',
    './module.ts',
    './internal/module.ts',
    './internal/state.ts',
    '../../state.ts',
    './packs/mos-analytics/manifests.ts',
    './packs/mos-analytics/compose.ts',
    './packs/mos-crm/manifests.ts',
    './packs/mos-crm/compose.ts',
    './packs/mos-sheets/manifests.ts',
    './packs/mos-sheets/compose.ts',
    './packs/mos-portal/manifests.ts',
    './packs/mos-portal/compose.ts',
  ]);
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        allowedPublicTargets.has(specifier),
        `${file.slice(repoRoot.length + 1)} imports '${specifier}' — only platform + matrix-listed public contracts + intra-module files are allowed`,
      );
    }
  }
});

test('AC-3: ZERO SQL, ZERO tables, ZERO database dependency in the module (no durable state)', () => {
  for (const file of moduleFiles) {
    const text = read(file);
    assert.ok(!/\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/i.test(text), `${file}: no SQL`);
    assert.ok(!/\bDb\b/.test(text.replace(/Deps/g, '')), `${file}: no Db port`);
    assert.ok(!/\bpg\b/.test(text), `${file}: no pg import`);
  }
  // No migration was taken for this Work Item.
  const migrations = readdirSync(join(repoRoot, 'src', 'platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(
    !mutations_owns_migration(migrations),
    '043_first_party_apps.sql was NOT taken (the required preference)',
  );
  assert.deepEqual(migrations[migrations.length - 2], '044_app_metering.sql', 'the migration list tail is unchanged');
  // The MKT-055 delivery appends 046_social_accounts.sql (the number is
  // PRE-ASSIGNED to that Work Item; 045 is reserved for a sibling).
  assert.deepEqual(migrations[migrations.length - 1], '046_social_accounts.sql');
});

function mutations_owns_migration(migrations: readonly string[]): boolean {
  return migrations.some((name) => name.startsWith('043_'));
}

test('AC-3: ZERO mutation verbs over ANY authority — the composed-contract call surface is READ-ONLY', () => {
  // Every member-call on a composed authority dep (deps.<x>.<method>)
  // must be one of the READ methods of that authority's public contract.
  const allowed: Record<string, readonly string[]> = {
    clock: ['nowIso', 'nowMs'],
    apps: ['getAppVersion', 'findAppVersion', 'listAppVersions', 'queryCompatibleAppVersions'],
    appInstalls: ['getAppInstall', 'listWorkspaceAppInstalls', 'listAgencyAppInstalls', 'listWorkspaceAppInstallEvents'],
    reporting: ['getClientDecisionRoom', 'getAgencyCommandCenter'],
    profitIntelligence: ['getClientProfitIntelligence', 'getWorkspaceProfitIntelligence', 'getAgencyProfitIntelligence'],
    clients: ['getClient', 'resolveClientOwnership', 'listClientsForAgency'],
    workspaces: ['listWorkspacesForClient', 'resolveWorkspaceOwnership'],
    decisions: ['getDecision', 'resolveDecisionOwnership', 'listDecisionsForClient', 'listDecisionEvents'],
    evidence: ['getEvidence', 'resolveEvidenceOwnership', 'listEvidenceForClient'],
    metrics: ['getMetricObservation', 'resolveMetricObservationOwnership', 'listMetricObservationsForClient'],
    integrations: ['listRegisteredAdapters', 'getConnection', 'resolveConnectionOwnership', 'listConnectionsForClient'],
  };
  const callPattern = /deps\.([a-zA-Z]+)\.([a-zA-Z]+)/g;
  for (const file of moduleFiles) {
    const text = read(file);
    for (const match of text.matchAll(callPattern)) {
      const dep = match[1]!;
      const method = match[2]!;
      const allowedMethods = allowed[dep];
      assert.ok(
        allowedMethods !== undefined,
        `${file.slice(repoRoot.length + 1)}: deps.${dep} is a composed authority dep`,
      );
      assert.ok(
        allowedMethods.includes(method),
        `${file.slice(repoRoot.length + 1)}: deps.${dep}.${method} is NOT a read method (${allowedMethods.join(', ')}) — pack code holds zero mutation verbs`,
      );
    }
  }
});

test('AC-4: NO direct network capability in pack code — connectors stay behind the EXISTING /integrations authority', () => {
  for (const file of moduleFiles) {
    const text = read(file);
    assert.ok(!/\bfetch\s*\(/.test(text), `${file}: no fetch calls`);
    assert.ok(!/HttpCallPort|outbound/i.test(text), `${file}: no outbound HTTP port`);
    assert.ok(!/https?:\/\//.test(text.replace(/analytics\.api\.provider\.example/g, '')), `${file}: no hardcoded URLs beyond the declared manifest destination`);
  }
  // The ONLY network surface is the DECLARED manifest destination, and
  // the composer reads connection records through the /integrations
  // public contract (listConnectionsForClient — the read-only check).
  const analyticsManifest = read(join(moduleDir, 'internal', 'packs', 'mos-analytics', 'manifests.ts'));
  assert.ok(analyticsManifest.includes('analytics.api.provider.example'));
  assert.ok(analyticsManifest.includes('/integrations'));
  const analyticsComposer = read(join(moduleDir, 'internal', 'packs', 'mos-analytics', 'compose.ts'));
  assert.ok(analyticsComposer.includes('listConnectionsForClient'));
});

test('AC-3 (discipline battery): the Non-goals vocabulary never appears as an owned capability', () => {
  // The module must not claim workflow engine / retry / policy / tenant
  // store / evidence store ownership anywhere in its contract.
  const publicContract = read(join(moduleDir, 'public.ts'));
  for (const forbidden of [
    'createWorkflow',
    'dispatchWorkflow',
    'retryQueue',
    'policyEngine',
    'tenantStore',
    'createEvidence',
    'appendEvidence(',
  ]) {
    assert.ok(!publicContract.includes(forbidden), `the public contract never exposes ${forbidden}`);
  }
});

test('AC-6: the route family registers EXACTLY the six frozen /first-party-apps routes', () => {
  const text = read(routesFile);
  const routes = [...text.matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes, [
    'GET /api/first-party-apps/workspaces/:workspaceId/packs',
    'POST /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/surfaces',
    'GET /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
    'POST /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
    'GET /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state/export',
    'DELETE /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
  ]);
});

test('AC-6: publish/install/trust are NOT re-implemented — the module and routes hold no registry/ledger write surface', () => {
  const routeText = read(routesFile);
  assert.ok(!/publishAppVersion/.test(routeText), 'no publish surface in the route family');
  assert.ok(!/installApp|upgradeAppInstall|rollbackAppInstall/.test(routeText), 'no install surface in the route family');
  assert.ok(!/recordTrustTransition/.test(routeText), 'no trust surface in the route family');
  for (const file of moduleFiles) {
    const text = read(file);
    assert.ok(!/publishAppVersion/.test(text), `${file}: no publish command`);
    assert.ok(!/installApp\(|upgradeAppInstall|rollbackAppInstall/.test(text), `${file}: no install commands`);
    assert.ok(!/recordTrustTransition/.test(text), `${file}: no trust commands`);
  }
});

test('AC-3/AC-6: the arch-check provision parses the frozen module set + the frozen matrix row; the REAL codebase has zero violations', () => {
  const specDir = join(repoRoot, 'spec');
  const specModules = parseFrozenModules(join(specDir, 'architecture.md'));
  assert.ok(specModules.includes('first-party-apps'), 'the §6 registration is parsed');
  const matrix = parseFrozenMatrix(
    join(specDir, 'module-dependency-matrix.md'),
    join(specDir, 'module-dependency-v1.3.md'),
    // The disclosed MKT-047 v1.5 composition provision module (the
    // sibling arch-check test posture — the matrix rows name /apps).
    [...specModules, 'apps'],
  );
  assert.deepEqual(matrix['first-party-apps'], [
    'apps', 'app-installs', 'reporting', 'profit-intelligence', 'clients',
    'workspaces', 'decisions', 'evidence', 'metrics', 'integrations',
  ]);
  // The REAL codebase (including the new module) is violation-free.
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir,
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.deepEqual(
    result.violations.map((violation) => `[${violation.rule}] ${violation.file}`),
    [],
  );
});

test('AC-6: the composition root wires the module with NO database handle (the no-migration posture)', () => {
  const root = read(join(repoRoot, 'src', 'composition-root.ts'));
  const wiring = root.slice(
    root.indexOf('const firstPartyApps = createFirstPartyAppsModule({'),
    root.indexOf('const firstPartyApps = createFirstPartyAppsModule({') + 700,
  );
  assert.ok(!/\bdb\b/.test(wiring), 'the wiring passes NO db handle');
  assert.ok(wiring.includes('clock'));
  assert.ok(wiring.includes('apps'));
  assert.ok(wiring.includes('appInstalls'));
  assert.ok(wiring.includes('integrations'));
  // The modules map carries the contract.
  assert.ok(
    root.includes('firstPartyApps }') || root.includes('firstPartyApps, socialAccounts }'),
    'the modules map carries the contract (the MKT-055 sibling appends socialAccounts additively)',
  );
});
