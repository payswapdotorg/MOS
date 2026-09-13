/**
 * MKT-047 static tests — the App registry (App Manifest and Packaging v1)
 * is structurally correct, authority-bounded and composition-only in the
 * ACTUAL module contract, migration, routes and source tree (pure static
 * analysis, no DB; the deployments-boundary + domain-packs-boundary
 * precedent).
 *
 * Acceptance proofs (spec/mos-app-ecosystem-v1.5.md; spec/
 * architecture-lock-v1.5.md #7/#9/#11/#13; spec/effective-backlog-v1.5.md
 * MKT-047; the dispatch AC-1/AC-4/AC-6/AC-7/AC-8/AC-11):
 *
 *   1. AC-1/AC-11 (composition, not authority transfer): the /apps module
 *      code imports ONLY platform ports (errors/clock/db/ids) + its own
 *      module — a LITERAL ZERO cross-module import (not even type-only:
 *      the module holds an EMPTY dependency-matrix allowance, the
 *      /deployments posture; every consumed /extensions contract arrives
 *      as the READ-ONLY AppsExtensionsPort structural port wired at the
 *      composition root);
 *
 *   2. AC-11 (no mutation surface over extensions): the module's public
 *      API declares NO extension mutation method (no
 *      registerExtensionVersion/installExtension/configureExtension/
 *      setExtensionInstallStatus/beginExtensionInvocation) and the port
 *      type exposes EXACTLY the two read-only extension lookups;
 *
 *   3. AC-7 (storage): the migration creates ONLY the apps +
 *      app_versions + app_dependencies tables — NO core-authority table
 *      (workflow/instance/execution/task/evidence/policy/credential/job/
 *      tenant store) and no column capable of holding secret material;
 *      the frozen closed-vocabulary CHECKs (certification enum, runtime
 *      class, scopes, UI surfaces, metering), the REAL semver comparator,
 *      the state-namespace denylist, the §21 material-key CHECK functions
 *      and the dependency-validation trigger exist;
 *
 *   4. AC-4 (immutability backstops): the UNIQUE (app_key, version)
 *      fence, the outright UPDATE/DELETE triggers on app_versions and
 *      app_dependencies and the app-key ownership fence exist;
 *
 *   5. AC-8 (the frozen route surface): exactly the five frozen routes —
 *      publish, catalog list, version history by app key, manifest read
 *      by exact (app key, version), compatibility query; NO update or
 *      delete route exists (every mutating verb 405s at the router);
 *
 *   6. AC-1 (wiring): application.ts exposes AppsModuleApi, routes.ts
 *      registers the routes, and the composition root constructs the
 *      module with the REAL /extensions public-contract instance as the
 *      structural port;
 *
 *   7. the DISCLOSED arch-check provision: the static checker enforces
 *      /apps as a frozen boundary with an EMPTY matrix allowance while
 *      the spec-parsed module set remains exactly the 26 frozen modules
 *      (parseFrozenModules is untouched — no drift of the frozen spec
 *      enforcement).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkArchitecture,
  parseFrozenModules,
  parseFrozenMatrix,
} from '../../tools/arch-check/checker.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (...parts: string[]) => join(repoRoot, 'src', ...parts);
const read = (path: string): string => readFileSync(path, 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
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

const appsDir = src('modules', 'apps');
const moduleFiles = walk(appsDir);
const migration037 = read(join(repoRoot, 'src', 'platform', 'db', 'migrations', '037_apps.sql'));
const appsPublic = read(src('modules', 'apps', 'public.ts'));
const appsModule = read(src('modules', 'apps', 'internal', 'module.ts'));
const appsStore = read(src('modules', 'apps', 'internal', 'store.ts'));
const appsRoutes = read(src('api', 'apps-routes.ts'));
const applicationTs = read(src('api', 'application.ts'));
const routesTs = read(src('api', 'routes.ts'));
const compositionRoot = read(src('composition-root.ts'));

// ---------------------------------------------------------------------------
// 1. AC-1/AC-11: ZERO cross-module imports (the structural-port posture)
// ---------------------------------------------------------------------------

test('MKT-047 AC-1/AC-11 static: the /apps module imports ONLY platform ports + its own module', () => {
  assert.ok(moduleFiles.length >= 3, 'public.ts + internal module/store exist');
  for (const file of moduleFiles) {
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) {
        assert.ok(
          specifier.startsWith('node:'),
          `external import '${specifier}' in ${file} is forbidden (platform ports only)`,
        );
        continue;
      }
      // Resolve the specifier against the importing file's DIRECTORY.
      const parts = file.split('/');
      parts.pop(); // drop the filename
      for (const segment of specifier.split('/')) {
        if (segment === '..') {
          parts.pop();
        } else if (segment !== '.' && segment !== '') {
          parts.push(segment);
        }
      }
      const resolved = parts.join('/');
      assert.ok(
        resolved.includes('/src/platform/') || resolved.startsWith(`${appsDir}/`) || resolved === appsDir,
        `import '${specifier}' in ${file} must resolve into src/platform or the /apps module itself (found '${resolved}')`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. AC-11: NO mutation surface over /extensions (composition, not
//    authority transfer)
// ---------------------------------------------------------------------------

test('MKT-047 AC-11 static: the module API adds NO mutation surface over /extensions — the port is read-only', () => {
  const publicCode = stripComments(appsPublic);
  // The module API exposes exactly the App registry surface.
  for (const method of ['publishAppVersion', 'getAppVersion', 'findAppVersion', 'listAppVersions', 'queryCompatibleAppVersions']) {
    assert.ok(publicCode.includes(method), `AppsModuleApi declares ${method}`);
  }
  // The extension MUTATION surface of the /extensions authority is NOT
  // re-declared here — the App registry composes, it never transfers
  // authority (architecture-lock v1.5 #7).
  for (const forbidden of [
    'registerExtensionVersion',
    'installExtension',
    'configureExtension',
    'setExtensionInstallStatus',
    'beginExtensionInvocation',
  ]) {
    assert.ok(
      !publicCode.includes(forbidden),
      `the /apps public contract must not declare the extension mutation method '${forbidden}' (composition, not authority transfer)`,
    );
  }
  // The structural port exposes EXACTLY the two read-only lookups.
  const portStart = publicCode.indexOf('export interface AppsExtensionsPort');
  const portEnd = publicCode.indexOf('}', publicCode.indexOf('listExtensionVersions', portStart));
  const portCode = publicCode.slice(portStart, portEnd);
  assert.ok(portStart >= 0, 'the AppsExtensionsPort interface exists');
  assert.ok(portCode.includes('getExtensionVersion'), 'the port resolves extension versions');
  assert.ok(portCode.includes('listExtensionVersions'), 'the port lists extension versions');
  for (const mutation of ['register', 'install', 'configure', 'uninstall', 'invoke']) {
    assert.ok(!portCode.includes(mutation), `the port must be read-only (no '${mutation}' method)`);
  }
  // The module implementation never writes through the port.
  const moduleCode = stripComments(appsModule);
  assert.ok(moduleCode.includes('extensions.listExtensionVersions'), 'dependency validation reads the port');
  assert.ok(!moduleCode.includes('extensions.register'), 'the module never registers extensions');
  assert.ok(!moduleCode.includes('extensions.install'), 'the module never installs extensions');
});

// ---------------------------------------------------------------------------
// 3. AC-7: the migration creates ONLY the app-registry tables with the
//    frozen closed-vocabulary CHECKs and the §21 backstops
// ---------------------------------------------------------------------------

test('MKT-047 AC-7 static: migration 037 creates exactly the three /apps tables — no core-authority table', () => {
  const created = [...migration037.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map((match) => match[1]!);
  assert.deepEqual(created.sort(), ['app_dependencies', 'app_versions', 'apps']);
  for (const forbidden of [
    'workflow', 'workflow_instances', 'execution', 'task', 'evidence', 'policy',
    'policies', 'credential', 'job', 'client', 'workspace', 'agency', 'tenant',
    'app_installs', 'marketplace', 'metering',
  ]) {
    assert.ok(
      !created.includes(forbidden),
      `migration 037 must not create a '${forbidden}' table (app install is MKT-048; marketplace MKT-050; metering MKT-052; core authorities stay singular)`,
    );
  }
});

test('MKT-047 AC-7 static: the frozen closed-vocabulary CHECKs + semver comparator + namespace denylist + §21 backstops exist', () => {
  // The certification enum is exactly the three frozen values.
  assert.ok(
    migration037.includes("CHECK (certification_state IN ('UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED'))"),
    'the certification CHECK is the frozen three-value enum',
  );
  assert.ok(migration037.includes("DEFAULT 'UNVERIFIED'"), 'certification is born UNVERIFIED');
  // The runtime-class closed set.
  assert.ok(
    /CHECK \(runtime_class IN \('pooled-worker', 'ephemeral-sandbox',\s*'persistent-sandbox', 'dedicated-runtime'\)\)/.test(
      migration037,
    ),
    'the runtime-class CHECK is the closed /executions vocabulary',
  );
  // The scope CHECKs (closed vocabularies).
  assert.ok(
    /IF scope NOT IN \('client:read', 'client:write', 'workspace:read', 'workspace:write'\)/.test(
      migration037,
    ),
    'the closed data-scope vocabulary',
  );
  assert.ok(
    /IF scope NOT IN \('workflow:dispatch', 'execution:request', 'evidence:append',\s*'metric:append', 'credential:bind'\)/.test(
      migration037,
    ),
    'the closed mutation-scope vocabulary',
  );
  // The REAL semver comparator (numeric ordering — the 1.10.0 > 1.9.0 case
  // is explicit in the function).
  assert.ok(migration037.includes('CREATE OR REPLACE FUNCTION apps_semver_cmp'));
  assert.ok(
    migration037.includes('a_num <> b_num') && migration037.includes('::integer'),
    'numeric component comparison (never text ordering)',
  );
  // The state-namespace denylist (the singular authorities).
  assert.ok(migration037.includes('CREATE OR REPLACE FUNCTION apps_state_namespaces_valid'));
  for (const core of ['client', 'workspace', 'goal', 'playbook', 'deployment', 'workflow', 'task', 'execution', 'evidence', 'experiment', 'learning', 'policy', 'credential', 'job']) {
    assert.ok(migration037.includes(`'${core}'`), `the singular authority '${core}' is in the denylist`);
  }
  // The §21 material-key backstops.
  assert.ok(migration037.includes('CREATE OR REPLACE FUNCTION apps_payload_has_no_material_keys'));
  assert.ok(migration037.includes("'credentialValue', 'secretValue'"), 'credential-value aliases are fenced');
  // No secret-material column anywhere.
  assert.ok(!/secret_material|api_key\s+text|material\s+text/.test(migration037));
});

// ---------------------------------------------------------------------------
// 4. AC-4: the immutability + ownership + dependency backstops
// ---------------------------------------------------------------------------

test('MKT-047 AC-4 static: the immutability fences are database backstops', () => {
  assert.ok(
    migration037.includes('CONSTRAINT app_versions_key_version_unique UNIQUE (app_key, version)'),
    'the (app key, semantic version) immutable fence',
  );
  // Published manifests reject UPDATE and DELETE outright.
  assert.ok(migration037.includes('app_versions_registry_immutable_update_trigger'));
  assert.ok(migration037.includes('app_versions_registry_immutable_delete_trigger'));
  assert.ok(migration037.includes('app_dependencies_append_only_update_trigger'));
  assert.ok(migration037.includes('app_dependencies_append_only_delete_trigger'));
  // The app-key ownership lineage fence.
  assert.ok(migration037.includes('app_versions_publisher_consistent_trigger'));
  assert.ok(migration037.includes('apps_owner_immutable_update_trigger'));
  // The dependency validation backstop trigger.
  assert.ok(migration037.includes('app_dependencies_valid_target_trigger'));
  assert.ok(migration037.includes('FROM extensions e'), 'extension dependency validation READS the 028 registry');
});

// ---------------------------------------------------------------------------
// 5. AC-8: exactly the five frozen routes — no update/delete surface
// ---------------------------------------------------------------------------

test('MKT-047 AC-8 static: the route set is exactly the five frozen routes (no update/delete surface)', () => {
  const routes = [...stripComments(appsRoutes).matchAll(/router\.add\(\s*'([A-Z]+)',\s*'([^']+)'/g)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
  assert.deepEqual(routes.sort(), [
    'GET /api/apps',
    'GET /api/apps/:appKey/versions',
    'GET /api/apps/:appKey/versions/:version',
    'POST /api/apps',
    'POST /api/apps/compatibility',
  ]);
  for (const verb of ['PUT', 'PATCH', 'DELETE']) {
    assert.ok(!routes.some((route) => route.startsWith(`${verb} `)), `no ${verb} route may exist`);
  }
  // The DTO layer wires the authority-field rejection contract on the
  // publish surface (both levels).
  const routesCode = stripComments(appsRoutes);
  assert.ok(routesCode.includes('PUBLISH_AUTHORITY_FIELDS'), 'the publish authority-field rejection list');
  assert.ok(routesCode.includes('MANIFEST_AUTHORITY_FIELDS'), 'the nested manifest authority-field rejection list');
  assert.ok(routesCode.includes('forbiddenKeys'), 'forbiddenKeys wired into the specs');
  // The platform_developer gate + the server-derived publisher identity.
  assert.ok(routesCode.includes('platform_developer'), 'the frozen developer role gate');
  assert.ok(routesCode.includes('appPublisherIdentityString') || routesCode.includes('AppPublisherIdentity'), 'the server-derived publisher identity');
});

// ---------------------------------------------------------------------------
// 6. AC-1: the shared registration files wire the module
// ---------------------------------------------------------------------------

test('MKT-047 AC-1 static: application.ts exposes the module, routes.ts registers it, the composition root wires the REAL port', () => {
  assert.ok(applicationTs.includes('readonly apps: AppsModuleApi'), 'ApplicationModules.apps');
  assert.ok(applicationTs.includes("from '../modules/apps/public.ts'"), 'the module public entry import');
  assert.ok(routesTs.includes('registerAppsRoutes(router, services, modules)'), 'routes.ts registers the apps routes');
  assert.ok(routesTs.includes("from './apps-routes.ts'"), 'routes.ts imports the apps route builder');
  // The composition root constructs the module with the REAL /extensions
  // instance as the structural port (TypeScript structural typing — no
  // cross-module import exists inside src/modules/apps).
  assert.ok(compositionRoot.includes('createAppsModule'), 'the composition root constructs the apps module');
  assert.ok(
    compositionRoot.includes('createAppsModule({ db, clock, ids, extensions })'),
    'the REAL /extensions public-contract instance satisfies the read-only port',
  );
});

// ---------------------------------------------------------------------------
// 7. The disclosed arch-check provision (no frozen-spec enforcement drift)
// ---------------------------------------------------------------------------

test('MKT-047 provision: the checker enforces /apps with an EMPTY matrix allowance; the spec-parsed set stays 26', () => {
  // The spec parser is untouched: exactly the 26 frozen modules.
  const specModules = parseFrozenModules(join(repoRoot, 'spec', 'architecture.md'));
  assert.equal(specModules.length, 26);
  assert.ok(!specModules.includes('apps'), 'the v1.4-era spec module list does not name /apps');
  // The enforced set (spec + the disclosed v1.5 composition provision)
  // includes /apps and /apps only holds an EMPTY dependency allowance.
  const result = checkArchitecture({
    codeRoot: repoRoot,
    specDir: join(repoRoot, 'spec'),
    skip: ['tests/architecture/fixtures'],
  });
  assert.ok(result.frozenModules.includes('apps'), 'the enforced module set includes /apps');
  const specMatrix = parseFrozenMatrix(
    join(repoRoot, 'spec', 'module-dependency-matrix.md'),
    join(repoRoot, 'spec', 'module-dependency-v1.3.md'),
    [...specModules, 'apps'],
  );
  assert.deepEqual(specMatrix['apps'], [], 'the /apps matrix allowance is EMPTY (structural ports only)');
  // The provision is present and documented in the checker itself.
  const checker = read(join(repoRoot, 'tools', 'arch-check', 'checker.ts'));
  assert.ok(checker.includes('v15CompositionModules'), 'the provision is the named, documented list');
  assert.ok(
    checker.includes("'apps'"),
    'the provision names apps (additive; sibling v1.5 workers append their own entries)',
  );
});

test('MKT-047 AC-7: the expected-migration list carries 037 in numeric position (the shared infra-adapters surface)', () => {
  const infraAdapters = read(join(repoRoot, 'tests', 'architecture', 'infra-adapters.test.ts'));
  const last = [...infraAdapters.matchAll(/'(\d{3})_[a-z_]+\.sql',/g)].map((match) => match[1]!);
  assert.equal(last[last.length - 1], '037', '037_apps.sql is appended in numeric position');
  const migrationsOnDisk = readdirSync(src('platform', 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.ok(migrationsOnDisk.includes('037_apps.sql'));
  assert.equal(migrationsOnDisk[migrationsOnDisk.length - 1], '037_apps.sql');
  // The store/entrypoint exist (the module boundary is complete).
  assert.ok(existsSync(src('modules', 'apps', 'public.ts')));
  assert.ok(existsSync(src('modules', 'apps', 'internal', 'module.ts')));
  assert.ok(existsSync(src('modules', 'apps', 'internal', 'store.ts')));
});

// ---------------------------------------------------------------------------
// The authority-field rejection contract in the store guard (static half;
// the runtime battery is the unit + integration suites)
// ---------------------------------------------------------------------------

test('MKT-047 AC-3/AC-5 static: the store guard encodes the authority/certification rejection contract', () => {
  const storeCode = stripComments(appsStore);
  assert.ok(storeCode.includes('CERTIFICATION_SHAPED_KEYS'), 'certification-shaped keys are a named rejection class');
  assert.ok(storeCode.includes('MANIFEST_AUTHORITY_SHAPED_KEYS'), 'authority-shaped keys are a named rejection class');
  assert.ok(storeCode.includes('ForbiddenError'), 'certification territory violations throw the 403 error class');
  assert.ok(storeCode.includes('platform territory'), 'the 403 message names the platform-territory rule');
  assert.ok(storeCode.includes("'publisher'"), 'publisher spoofing is explicitly rejected');
  assert.ok(storeCode.includes("'agencyId'"), 'tenant identity keys are explicitly rejected');
});
