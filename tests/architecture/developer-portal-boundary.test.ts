/**
 * MKT-049 static tests — the App SDK and Developer Portal delivery is
 * structurally correct, authority-bounded and composition-only in the
 * ACTUAL route family, SDK source tree and repo layout (pure static
 * analysis, no DB; the extension-portal-boundary + apps-boundary
 * precedents).
 *
 * Acceptance proofs (spec/mos-app-ecosystem-v1.5.md "UI and developer
 * model"; spec/architecture-lock-v1.5.md #7/#11/#12/#13; spec/
 * effective-backlog-v1.5.md MKT-049; the dispatch AC-4/AC-7/AC-8):
 *
 *   1. AC-4 (thin route family): the Developer Portal registers EXACTLY
 *      the six frozen routes — catalog, version history view, version
 *      view, validate (pure), publish (delegated), docs — and NO
 *      update/delete verb exists anywhere in the file;
 *
 *   2. AC-4 (thin over /apps — the portal NEVER becomes a second app
 *      authority): the route file imports ONLY platform + api shared
 *      helpers + the /apps public contract; every operation delegates
 *      to the /apps module API (publishAppVersion / listAppVersions /
 *      findAppVersion) or to the authority's EXPORTED pure guards
 *      (assertValidAppManifest / appManifestSignatureProblems /
 *      appCreateFingerprint); the file contains NO store, NO SQL, NO
 *      table, NO second engine of its own;
 *
 *   3. AC-1 (the SDK is an OUTBOUND artifact — NO runtime dependency
 *      from core modules on the SDK): NO file under src/ imports
 *      anything from tools/app-sdk (both directions pinned);
 *
 *   4. AC-1 (the SDK is STANDALONE): nothing under tools/app-sdk
 *      imports the MOS repository source — only node builtins and
 *      intra-package relative imports;
 *
 *   5. AC-8 (NO new authority, NO migration): NO module directory was
 *      added for the portal (it rides the /apps registration — the
 *      MKT-032 precedent), the arch-check provision list is unchanged
 *      (still exactly the MKT-047 /apps entry), application.ts and the
 *      composition root carry NO portal wiring (the portal composes the
 *      existing modules.apps contract), and migration number 041 was
 *      NOT taken (no portal-owned migration file exists);
 *
 *   6. AC-4 (publish posture): the delegated publish wires the frozen
 *      platform_developer role, the server-derived publisher identity
 *      and the authority-field/material-key rejection contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkArchitecture,
  parseFrozenModules,
} from '../../tools/arch-check/checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
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

/** Imports of `file` as raw specifier strings. */
function importsOf(file: string): string[] {
  const text = read(file);
  const specifiers: string[] = [];
  for (const match of text.matchAll(/from\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/import\s+'([^']+)'/g)) specifiers.push(match[1]!);
  for (const match of text.matchAll(/from\s+"([^"]+)"/g)) specifiers.push(match[1]!);
  return specifiers;
}

/** Strips comments so code-token checks never match documentation. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:'" ])\/\/[^\n]*/g, '$1');
}

const portalRoutes = read(src('api', 'developer-portal-routes.ts'));
const routesTs = read(src('api', 'routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const compositionRoot = read(src('composition-root.ts'));
const checkerTs = read(join(repoRoot, 'tools', 'arch-check', 'checker.ts'));
const sdkDir = join(repoRoot, 'tools', 'app-sdk');

// ---------------------------------------------------------------------------
// 1. AC-4: exactly the six frozen portal routes — no update/delete verb
// ---------------------------------------------------------------------------

test('MKT-049 AC-4 static: the portal registers EXACTLY the six frozen routes — no update/delete surface', () => {
  const routes = [...stripComments(portalRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/developer-portal/apps/:appKey/versions',
    'GET /api/developer-portal/apps/:appKey/versions/:version',
    'GET /api/developer-portal/catalog',
    'GET /api/developer-portal/docs',
    'POST /api/developer-portal/publish',
    'POST /api/developer-portal/validate',
  ]);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
    assert.ok(
      !stripComments(portalRoutes).includes(`'${verb}',`),
      `the portal must never register a ${verb} route (published App Versions are immutable)`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. AC-4: thin over /apps — whitelisted imports + delegated operations
// ---------------------------------------------------------------------------

test('MKT-049 AC-4 static: the route file imports ONLY platform + api shared helpers + the /apps public contract', () => {
  const specifiers: string[] = importsOf(src('api', 'developer-portal-routes.ts'));
  assert.ok(specifiers.length >= 10, 'the file is meaningfully wired');
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
    /^\.\.\/modules\/apps\/public\.ts$/,
  ];
  for (const specifier of specifiers) {
    assert.ok(
      allowed.some((pattern) => pattern.test(specifier)),
      `import '${specifier}' is not in the portal whitelist (platform + api helpers + the /apps public contract only — no module internals, no SDK, no second engine)`,
    );
  }
});

test('MKT-049 AC-4 static: every portal operation delegates to the /apps authority — no store, no SQL, no second engine', () => {
  const code = stripComments(portalRoutes);
  // The delegated authority operations (the /apps module API + the
  // exported pure guards the module contract earmarked for this Work
  // Item).
  for (const symbol of [
    'modules.apps.publishAppVersion',
    'modules.apps.listAppVersions',
    'modules.apps.findAppVersion',
    'assertValidAppManifest',
    'appManifestSignatureProblems',
    'appCreateFingerprint',
  ]) {
    assert.ok(code.includes(symbol), `the portal delegates through '${symbol}'`);
  }
  // NO portal-owned state, NO second registry, NO direct storage.
  for (const forbidden of [
    'new AppsStore',
    'AppsStore',
    'INSERT INTO',
    'UPDATE ',
    'DELETE FROM',
    'CREATE TABLE',
    'createDeveloperPortalModule',
    'developerPortalStore',
    'pool(',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `the portal must never contain its own storage/engine code ('${forbidden}')`,
    );
  }
  // The pure validation route emits NO audit record (the compatibility
  // pure-read precedent) — only the publish mutation audits.
  const validateBlock = code.slice(
    code.indexOf("'/api/developer-portal/validate'"),
    code.indexOf("'/api/developer-portal/publish'"),
  );
  assert.ok(!validateBlock.includes('recordMutationAudit'), 'validate is pure — no audit emit');
  assert.ok(code.includes('recordMutationAudit'), 'the publish mutation emits the audit record');
});

test('MKT-049 AC-4 static: the publish surface wires the frozen developer role + the authority-field rejection contract', () => {
  const code = stripComments(portalRoutes);
  assert.ok(code.includes('platform_developer'), 'the frozen developer role gate');
  assert.ok(code.includes('platform_administrator'), 'the platform administrator gate');
  assert.ok(code.includes('AppPublisherIdentity'), 'the server-derived publisher identity type');
  assert.ok(code.includes('PUBLISH_AUTHORITY_FIELDS'), 'the publish authority-field rejection list');
  assert.ok(code.includes('MANIFEST_AUTHORITY_FIELDS'), 'the nested manifest authority-field rejection list');
  assert.ok(code.includes('forbiddenKeys'), 'forbiddenKeys wired into the specs');
  // The immutable-version semantics stay with the authority (the portal
  // carries NO update/delete/certification surface of its own).
  for (const forbidden of [
    'certificationState =',
    'setCertification',
    'updateAppVersion',
    'deleteAppVersion',
  ]) {
    assert.ok(!code.includes(forbidden), `no portal-side authority mutation ('${forbidden}')`);
  }
});

// ---------------------------------------------------------------------------
// 3. + 4. AC-1: the SDK is an OUTBOUND, STANDALONE artifact (both import
//    directions pinned)
// ---------------------------------------------------------------------------

test('MKT-049 AC-1 static: NO file under src/ imports the SDK — the SDK is an outbound artifact, never a runtime dependency', () => {
  const srcFiles = [...walk(src('modules')), ...walk(src('api')), ...walk(src('platform')), ...walk(src('workers')), ...walk(src('entrypoints')), join(repoRoot, 'src', 'composition-root.ts')];
  assert.ok(srcFiles.length > 200, 'the src/ tree is scanned');
  for (const file of srcFiles) {
    for (const specifier of importsOf(file)) {
      assert.ok(
        !specifier.includes('tools/app-sdk') && !specifier.includes('app-sdk/'),
        `src file ${file} must not import the App SDK ('${specifier}') — the SDK is outbound-only`,
      );
    }
    const text = read(file);
    assert.ok(
      !text.includes("from '../../tools/app-sdk") && !text.includes("from '../../../tools/app-sdk"),
      `src file ${file} must not import the App SDK by path`,
    );
  }
});

test('MKT-049 AC-1 static: the SDK imports NOTHING from the MOS repository — standalone mirror (node builtins + intra-package only)', () => {
  const sdkFiles = [...walk(sdkDir), join(sdkDir, 'cli.ts')];
  assert.ok(sdkFiles.length >= 10, 'the SDK tree is scanned');
  for (const file of sdkFiles) {
    for (const specifier of importsOf(file)) {
      if (specifier.startsWith('node:')) continue;
      assert.ok(
        specifier.startsWith('./'),
        `SDK file ${file} may only import node builtins or intra-package relative paths (found '${specifier}')`,
      );
      // Every relative import must resolve INSIDE tools/app-sdk.
      const resolved = join(dirname(file), specifier);
      assert.ok(
        resolved.startsWith(join(repoRoot, 'tools', 'app-sdk')),
        `SDK file ${file} import '${specifier}' resolves outside the SDK package`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 5. AC-8: NO new module, NO provision change, NO migration
// ---------------------------------------------------------------------------

test('MKT-049 AC-8 static: NO portal module directory — the portal rides the /apps registration (the MKT-032 precedent)', () => {
  const moduleDirs = readdirSync(src('modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  assert.ok(
    !moduleDirs.includes('developer-portal'),
    'the portal must NOT be a module (a surface over /apps, never a new authority)',
  );
  assert.ok(
    !moduleDirs.includes('app-sdk') && !moduleDirs.includes('app-sdk-portal'),
    'the SDK must NOT be a module (an outbound tooling artifact under tools/)',
  );
  // application.ts and the composition root carry NO portal wiring: the
  // portal composes the EXISTING modules.apps contract (already wired by
  // MKT-047).
  assert.ok(!applicationTs.includes('DeveloperPortal'), 'application.ts has no portal wiring');
  assert.ok(!compositionRoot.includes('DeveloperPortal'), 'the composition root has no portal wiring');
  assert.ok(!compositionRoot.includes('app-sdk'), 'the composition root never wires the SDK');
  assert.ok(applicationTs.includes('readonly apps: AppsModuleApi'), 'the portal composes the existing /apps module contract');
  // routes.ts registers the family (the only shared-file touch).
  assert.ok(
    routesTs.includes("import { registerDeveloperPortalRoutes } from './developer-portal-routes.ts'"),
    'routes.ts imports the portal family',
  );
  assert.ok(
    routesTs.includes('registerDeveloperPortalRoutes(router, services, modules)'),
    'routes.ts registers the portal family',
  );
});

test('MKT-049 AC-8 static: the arch-check provision is unchanged — the spec-parsed set stays 31 and /apps remains the only v1.5 provision entry', () => {
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  // The spec module list is untouched by THIS Work Item: the count moved
  // 30 → 31 only through the disclosed MKT-050 /app-marketplace
  // registration (the promotion precedent this portal delivery itself
  // documented), 34 → 35 through the MKT-052 /app-metering
  // registration, 35 → 36 through the MKT-051 /first-party-apps
  // registration and 36 → 37 through the MKT-053 /growth-missions
  // registration (the sibling promotions — the same additive
  // precedent); no portal registration was added.
  assert.equal(specModules.length, 37, 'the spec module list (37 spec-parsed after the MKT-053 /growth-missions sibling registration) parses cleanly');
  assert.ok(!specModules.includes('developer-portal'), 'no portal registration was added to the frozen list');
  // The disclosed v1.5 composition provision: still EXACTLY the MKT-047
  // /apps entry (this Work Item appends nothing).
  const provision = stripComments(checkerTs).match(/v15CompositionModules[^=]*=\s*\[([^\]]*)\]/);
  assert.ok(provision !== null, 'the provision list is present');
  const entries = [...provision[1]!.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
  assert.deepEqual(entries, ['apps'], 'the provision carries exactly the MKT-047 /apps entry');
  // The full checker still passes with zero violations.
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures', 'console'],
  });
  assert.equal(result.violations.length, 0, 'the static architecture check is clean');
  assert.ok(result.frozenModules.includes('apps'), 'the enforced set includes /apps');
});

test('MKT-049 AC-8 static: migration number 041 was NOT taken — the no-migration delivery (tooling + thin routes over existing authorities)', () => {
  const migrations = readdirSync(src('platform', 'db', 'migrations')).filter((name) => name.endsWith('.sql')).sort();
  assert.ok(
    !migrations.some((name) => /app_sdk|app-sdk|developer_portal|developer-portal/i.test(name)),
    `no SDK/portal-owned migration file may exist (found: ${migrations.filter((name) => /app_sdk|developer_portal/i.test(name)).join(', ')})`,
  );
  // The pre-assigned-but-unused number: 041_app_sdk.sql deliberately NOT
  // taken (the REQUIRED no-migration preference).
  assert.ok(!migrations.includes('041_app_sdk.sql'), '041_app_sdk.sql is NOT taken by this delivery');
  // The /apps authority tables remain exactly the MKT-047 tables.
  assert.ok(existsSync(src('platform', 'db', 'migrations', '037_apps.sql')));
});

// ---------------------------------------------------------------------------
// The registry-side additive signing field (the disclosed AC-5 posture)
// ---------------------------------------------------------------------------

test('MKT-049 AC-5 static: the registry signing field is ADDITIVE — the frozen manifest shape and the /apps route set are unchanged', () => {
  // The /apps module public contract gained ONLY the optional signature
  // vocabulary + the publish-envelope field + the exported guard.
  const appsPublic = read(src('modules', 'apps', 'public.ts'));
  assert.ok(appsPublic.includes('AppManifestSignature'), 'the signature type is declared');
  assert.ok(appsPublic.includes("readonly signature?: AppManifestSignature | null"), 'the publish input field is OPTIONAL (backwards compatible)');
  assert.ok(appsPublic.includes('appManifestSignatureProblems'), 'the guard is exported through the public entry');
  // The frozen 19-field manifest shape is untouched: the strict MANIFEST_FIELDS
  // list carries no signature entry (the attestation rides the publish
  // envelope — the disclosed choice).
  const store = read(src('modules', 'apps', 'internal', 'store.ts'));
  const manifestFields = store.match(/const MANIFEST_FIELDS = \[([^\]]*)\]/);
  assert.ok(manifestFields !== null);
  assert.ok(!manifestFields[1]!.includes('signature'), 'the manifest field set carries NO signature field (frozen MKT-047 shape)');
  // The module verifies the attestation BEFORE any write.
  const appsModule = read(src('modules', 'apps', 'internal', 'module.ts'));
  assert.ok(appsModule.includes('appManifestSignatureProblems'), 'the module calls the signature guard');
  assert.ok(
    appsModule.indexOf('appManifestSignatureProblems') < appsModule.indexOf('insertAppVersion'),
    'the signature verification precedes the registry write (fail-closed)',
  );
  // The /apps direct route surface is unchanged: exactly the five frozen
  // routes (the apps-boundary suite pins them; the additive DTO field
  // passes the attestation through).
  const appsRoutes = read(src('api', 'apps-routes.ts'));
  const routes = [...stripComments(appsRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.equal(routes.length, 5, 'the /api/apps route family is exactly the five MKT-047 routes');
});
