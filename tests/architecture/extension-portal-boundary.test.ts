/**
 * MKT-032 static tests — the Extension Developer Portal boundary is
 * structurally correct in the ACTUAL route file and the shared registration
 * files (pure static analysis, no DB). Proves the frozen architecture
 * boundaries (spec/work-items.md MKT-032 = UI-003 "Provide Extension
 * Developer/installation surfaces"; requirements.md UI-003 + EXT-001;
 * spec/architecture.md §5 the Platform Developer/Extension Publisher role,
 * §25 UI; spec/extension-model.md §2–§5; spec/implementation-contract.md
 * §3 server-derived authority fields, §19 extension contract, §21 material
 * keys; AGENTS.md "No extension ... may become an alternate authority"):
 *
 *   1. the portal registers EXACTLY the frozen surface set (17 routes) and
 *      NO PUT/PATCH/DELETE verb exists in the file (registry versions,
 *      review history and invocation history are immutable/append-only at
 *      the authorities);
 *   2. the route file's imports are whitelisted: platform + api shared
 *      helpers + the /extensions and /policies PUBLIC contracts ONLY — no
 *      module internal, no store implementation, no second composition
 *      engine at the route layer;
 *   3. THIN DELEGATION ONLY: every portal operation delegates to the
 *      /extensions authority public contract (registerExtensionVersion,
 *      listExtensionVersions, getExtensionVersion, installExtension,
 *      configureExtension, setExtensionInstallStatus,
 *      beginExtensionInvocation, listExtensionInstalls) — the file never
 *      imports or constructs a store, never touches a /extensions-own table
 *      through any other module, and adds NO second lifecycle engine (the
 *      only invocation path is the authority's beginExtensionInvocation);
 *   4. the permission-review action is a DELEGATED /policies declaration
 *      (declarePolicyVersion + the read composition) — the surface NEVER
 *      evaluates permissions (no evaluateAction call anywhere in the
 *      file);
 *   5. the frozen platform_developer role (users/public.ts: "Publishes and
 *      manages platform extensions (wired by later extension Work Items)")
 *      is wired by the portal publish surface;
 *   6. every mutation DTO rejects the server-derived authority fields
 *      (identity, scope, lifecycle, provenance, policy posture) and every
 *      material-shaped key (§21);
 *   7. the shared registration files wire the surface (routes.ts registers
 *      the family AFTER the direct MKT-022 family) and NO new module
 *      directory exists — the portal is a surface, not a module;
 *   8. the portal owns NO state: no extension_portal/portal_review table
 *      exists in ANY migration and no portal-owned migration file exists
 *      (the authoritative state stays exactly the MKT-022 extensions
 *      tables + the MKT-021 policies tables). NUMBERING NOTE (MKT-019
 *      worker, per the Tech Lead's dispatch): migration number 032 was
 *      reserved for MKT-019 (AI evaluations) and is now taken by
 *      032_ai_evaluations.sql — the portal-owns-no-state proof below is
 *      content-based (no portal-owned table), not number-based.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

const portalRoutes = read(src('api', 'extension-portal-routes.ts'));
const routesFile = read(src('api', 'routes.ts'));
const applicationFile = read(src('api', 'application.ts'));
const migrationsDir = src('platform', 'db', 'migrations');
const modulesDir = src('modules');

// ---------------------------------------------------------------------------
// 1. The frozen surface set — no update/delete verbs
// ---------------------------------------------------------------------------

test('the portal routes register EXACTLY the frozen MKT-032 surface set — and no update/delete verb exists in the file', () => {
  // router.add literals + the three shared reviewer-action routes (POST,
  // registered through the reviewRoute helper) + the three shared
  // lifecycle-edge routes (POST, registered through statusEdgeRoute).
  const added = [...portalRoutes.matchAll(/'(GET|POST|PUT|PATCH|DELETE)',\s*\n?\s*'(\/[^']+)'/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  const reviewed = [...portalRoutes.matchAll(/reviewRoute\(\s*\n?\s*'(\/[^']+)'/g)]
    .map((match) => `POST ${match[1]}`);
  const edged = [...portalRoutes.matchAll(/statusEdgeRoute\(\s*\n?\s*'(\/[^']+)'/g)]
    .map((match) => `POST ${match[1]}`);
  const registered = [...added, ...reviewed, ...edged].sort();
  assert.deepEqual(registered, [
    // DEVELOPER surface.
    'POST /api/extension-portal/versions',
    'GET /api/extension-portal/catalog',
    'GET /api/extension-portal/extensions/:extensionKey/versions',
    'GET /api/extension-portal/versions/:extensionId',
    'POST /api/extension-portal/executions/:executionId/extensions/:extensionId/test',
    // PERMISSION REVIEW surface.
    'GET /api/extension-portal/workspaces/:workspaceId/versions/:extensionId/permission-review',
    'POST /api/extension-portal/versions/:extensionId/permission-review',
    'POST /api/extension-portal/agencies/:agencyId/versions/:extensionId/permission-review',
    'POST /api/extension-portal/clients/:clientId/versions/:extensionId/permission-review',
    // INSTALLATION surface.
    'POST /api/extension-portal/workspaces/:workspaceId/installs',
    'GET /api/extension-portal/workspaces/:workspaceId/installs',
    'POST /api/extension-portal/workspaces/:workspaceId/installs/:installId/configure',
    'POST /api/extension-portal/workspaces/:workspaceId/installs/:installId/authorize',
    'POST /api/extension-portal/workspaces/:workspaceId/installs/:installId/disable',
    'POST /api/extension-portal/workspaces/:workspaceId/installs/:installId/uninstall',
    // VERSION MANAGEMENT.
    'GET /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/versions',
    'POST /api/extension-portal/workspaces/:workspaceId/extensions/:extensionKey/upgrade',
  ].sort());
  assert.equal(registered.length, 17, 'exactly seventeen frozen portal routes');
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(
      !portalRoutes.includes(`'${verb}',`),
      `the portal must never register a ${verb} route (registry versions, review history and invocation history are immutable)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Whitelisted imports only — no module internals, no second engine
// ---------------------------------------------------------------------------

test('the route file imports ONLY platform + api shared helpers + the /extensions and /policies public contracts', () => {
  const specifiers: string[] = [];
  for (const match of portalRoutes.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of portalRoutes.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  const allowed = [
    /^\.\.\/platform\/errors\/errors\.ts$/,
    /^\.\.\/platform\/http\/auth\/contract\.ts$/,
    /^\.\.\/platform\/http\/pipeline\.ts$/,
    /^\.\.\/platform\/http\/router\.ts$/,
    /^\.\.\/platform\/http\/validation\.ts$/,
    /^\.\.\/platform\/observability\/correlation\.ts$/,
    /^\.\.\/platform\/app-services\.ts$/,
    /^\.\/application\.ts$/,
    /^\.\/authorize\.ts$/,
    /^\.\/audit-emit\.ts$/,
    // The two composed authorities — PUBLIC contracts only.
    /^\.\.\/modules\/extensions\/public\.ts$/,
    /^\.\.\/modules\/policies\/public\.ts$/,
  ];
  for (const specifier of specifiers) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `unexpected import in the portal route file: ${specifier} (only platform, api shared helpers and the /extensions + /policies public contracts are allowed)`,
    );
  }
  assert.ok(
    specifiers.includes('../modules/extensions/public.ts'),
    'the portal delegates through the /extensions public contract',
  );
  assert.ok(
    specifiers.includes('../modules/policies/public.ts'),
    'the permission-review action delegates through the /policies public contract',
  );
});

// ---------------------------------------------------------------------------
// 3. Thin delegation — every operation is an /extensions authority call
// ---------------------------------------------------------------------------

test('every portal operation delegates to the /extensions authority public contract — no store, no second engine', () => {
  for (const delegated of [
    'modules.extensions.registerExtensionVersion',
    'modules.extensions.listExtensionVersions',
    'modules.extensions.getExtensionVersion',
    'modules.extensions.installExtension',
    'modules.extensions.configureExtension',
    'modules.extensions.setExtensionInstallStatus',
    'modules.extensions.beginExtensionInvocation',
    'modules.extensions.listExtensionInstalls',
    'modules.extensions.getExtensionInstall',
  ]) {
    assert.ok(
      portalRoutes.includes(delegated),
      `the portal must delegate through ${delegated}`,
    );
  }
  // No second execution/lifecycle engine at the surface: the ONLY
  // invocation path is the authority's beginExtensionInvocation, and no
  // sandbox/worker/dispatch surface is registered here.
  assert.equal(
    (portalRoutes.match(/beginExtensionInvocation/g) ?? []).length >= 1,
    true,
    'the testing hook is a pass-through to the authority invocation contract',
  );
  for (const forbidden of [
    'new ExtensionsStore',
    'from \'../modules/extensions/internal',
    'from \'../modules/policies/internal',
    'spawnSandbox',
    'dispatchExecution',
    'createExtensionRuntime',
    'insertExtension',
    'UPDATE extension',
    'DELETE FROM extension',
  ]) {
    assert.ok(
      !portalRoutes.includes(forbidden),
      `the portal must never contain "${forbidden}" (thin delegation only)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. The surface never evaluates permissions
// ---------------------------------------------------------------------------

test('the permission-review surface never evaluates permissions — no evaluateAction call anywhere in the file', () => {
  assert.ok(
    !portalRoutes.includes('evaluateAction'),
    'the portal must never evaluate policy outcomes itself (evaluation happens exclusively in the /extensions authority gates through the /policies engine)',
  );
  assert.ok(
    portalRoutes.includes('modules.policies.declarePolicyVersion'),
    'the reviewer action is a delegated /policies declaration',
  );
  for (const delegated of [
    'modules.policies.getActivePolicyVersion',
    'modules.policies.listPolicyVersions',
    'modules.policies.listPolicyDecisions',
  ]) {
    assert.ok(
      portalRoutes.includes(delegated),
      `the review view composes the authoritative policy reads (${delegated})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 5. The frozen platform_developer role is wired by the publish surface
// ---------------------------------------------------------------------------

test('the publish surface wires the frozen platform_developer role (the Platform Developer/Extension Publisher)', () => {
  const usersPublic = read(src('modules', 'users', 'public.ts'));
  assert.ok(
    usersPublic.includes("'platform_developer'"),
    'the frozen platform role vocabulary includes platform_developer',
  );
  assert.ok(
    usersPublic.includes('wired by later extension Work Items'),
    'the role definition defers its wiring to this Work Item',
  );
  assert.ok(
    portalRoutes.includes("context.platformRoles.includes('platform_developer')"),
    'the portal publish surface authorizes the platform_developer role',
  );
});

// ---------------------------------------------------------------------------
// 6. DTO authority-field rejection contracts on every mutation surface
// ---------------------------------------------------------------------------

test('every portal mutation DTO rejects server-derived authority fields and material-shaped keys', () => {
  for (const forbidden of [
    'extensionId',
    'createFingerprint',
    'installId',
    'agencyId',
    'clientId',
    'workspaceId',
    'status',
    'policyId',
    'versionSeq',
    'supersededByPolicyId',
    'provenance',
    'correlationId',
    'causationId',
    'policyDecisionId',
    'invocationId',
    'grantedCapabilities',
    'grantedDataScopes',
    'secret',
    'secretMaterial',
    'material',
    'password',
    'token',
    'apiKey',
    'api_key',
    'accessKey',
    'secretHandle',
  ]) {
    assert.ok(
      portalRoutes.includes(`'${forbidden}',`),
      `the authority-field rejection sets must include '${forbidden}'`,
    );
  }
  // Every mutation surface validates a DTO with forbiddenKeys (the
  // shared reviewer-action + status-edge specs count once each as
  // literals: publish, review, test, install, configure, status, upgrade).
  const validations = portalRoutes.match(/validateObject</g) ?? [];
  assert.equal(
    validations.length,
    7,
    `every mutation surface validates a strict DTO (found ${validations.length})`,
  );
});

// ---------------------------------------------------------------------------
// 7. Shared registration files — a surface, not a module
// ---------------------------------------------------------------------------

test('routes.ts registers the portal family; application.ts is unchanged in module wiring; no new module directory exists', () => {
  assert.ok(
    routesFile.includes("import { registerExtensionPortalRoutes } from './extension-portal-routes.ts'"),
    'routes.ts imports the portal family',
  );
  assert.ok(
    routesFile.includes('registerExtensionPortalRoutes(router, services, modules)'),
    'routes.ts registers the portal family',
  );
  // The frozen module set: no extension-portal module exists (the portal
  // is a route family, not a module).
  const moduleDirs = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(
    !moduleDirs.includes('extension-portal'),
    'the portal must NOT be a module (a surface over /extensions, never a new authority)',
  );
  assert.ok(
    !applicationFile.includes('ExtensionPortal'),
    'application.ts must not wire a portal module (no module exists)',
  );
  assert.ok(
    applicationFile.includes('readonly extensions: ExtensionsModuleApi'),
    'the portal composes the existing /extensions module contract',
  );
  assert.ok(
    applicationFile.includes('readonly policies: PoliciesModuleApi'),
    'the portal composes the existing /policies module contract',
  );
});

// ---------------------------------------------------------------------------
// 8. The portal owns NO state — migration 032 stays reserved and unused
// ---------------------------------------------------------------------------

test('no portal-owned migration or table exists — the authoritative state stays the MKT-022 + MKT-021 tables', () => {
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
  // The portal owns NO state: no portal-owned migration FILE exists. (The
  // migration NUMBER 032 is taken by MKT-019's ai_evaluations migration,
  // reserved for that Work Item by the Tech Lead's dispatch — the proof
  // here is that no migration creates portal-owned TABLES.)
  assert.ok(
    !migrations.some((name) => /portal/i.test(name)),
    `a portal-owned migration file must not exist (a surface owns no state); found: ${migrations.filter((name) => /portal/i.test(name)).join(', ')}`,
  );
  for (const migration of migrations) {
    const text = read(join(migrationsDir, migration));
    assert.ok(
      !/extension_portal|extension_permission_review|portal_review/i.test(text),
      `no migration may create portal-owned state (${migration})`,
    );
  }
  // The extensions authority tables remain exactly the three MKT-022
  // tables (asserted in depth by extensions-boundary.test.ts); the portal
  // reads/writes them ONLY through the authority.
  assert.ok(
    existsSync(src('platform', 'db', 'migrations', '028_extensions.sql')),
    'the /extensions authority migration remains the sole extension schema',
  );
  assert.ok(
    existsSync(src('platform', 'db', 'migrations', '025_policies.sql')),
    'the /policies authority migration remains the sole policy schema',
  );
});
