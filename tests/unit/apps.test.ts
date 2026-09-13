/**
 * MKT-047 unit tests — the frozen App registry contract as PURE functions
 * (spec/mos-app-ecosystem-v1.5.md "Manifest"/"Trust levels"/"Bounded app
 * state"/"UI and developer model"/"Economics"; spec/effective-backlog-v1.5.md
 * MKT-047 "expand EXT-001 into immutable App Version manifests";
 * spec/architecture-lock-v1.5.md #7/#9/#11; spec/frozen-manifest-v1.5.json
 * appRules + singularAuthorities; spec/implementation-contract.md §3
 * server-derived authority, §21 material-key backstop).
 *
 * Acceptance mapping (MKT-047 AC-10 — "manifest shape/validation pure
 * functions, compatibility-range matcher, namespace denylist,
 * semantic-version ordering"):
 *   - the CLOSED VOCABULARIES: certification states (3), runtime classes
 *     (4), data scopes (4), mutation scopes (5), UI surface kinds (6),
 *     metering dimensions (5) — each with an interpretable meaning;
 *   - SEMANTIC-VERSION ORDERING: the REAL comparator — numeric component
 *     ordering (1.9.0 < 1.10.0, the text-ordering trap), prerelease
 *     below release, prerelease identifier ordering, equality;
 *   - the COMPATIBILITY-RANGE MATCHER: inclusive bounds;
 *   - the NAMESPACE DENYLIST: the fourteen singular authorities; a legal
 *     app-owned namespace passes; a foreign-key claim, a non-namespaced
 *     label and every core-authority claim are rejected;
 *   - the MANIFEST GUARD: a fully-declared §Manifest manifest passes;
 *     closed-vocabulary violations, unordered ranges, duplicate
 *     capability names, material-shaped keys (§21), self-dependencies,
 *     malformed identities are rejected 422; CERTIFICATION-shaped keys
 *     are rejected 403 (platform territory — a developer can never
 *     self-certify); authority-shaped keys are rejected 422;
 *   - the compatibility-query input guard and the shared dependency
 *     satisfaction predicate;
 *   - the deterministic manifest fingerprint (canonicalization).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_CERTIFICATION_STATES,
  APP_CERTIFICATION_STATE_MEANINGS,
  APP_CORE_AUTHORITY_NAMESPACES,
  APP_DATA_SCOPES,
  APP_DATA_SCOPE_MEANINGS,
  APP_METERING_DIMENSIONS,
  APP_METERING_DIMENSION_MEANINGS,
  APP_MUTATION_SCOPES,
  APP_MUTATION_SCOPE_MEANINGS,
  APP_RUNTIME_CLASSES,
  APP_RUNTIME_CLASS_MEANINGS,
  APP_UI_SURFACE_KINDS,
  APP_UI_SURFACE_KIND_MEANINGS,
  appPublisherIdentityString,
  type AppManifest,
} from '../../src/modules/apps/public.ts';
import {
  APPS_MATERIAL_SHAPED_KEYS,
  appCreateFingerprint,
  appDependenciesValid,
  appVersionInRange,
  assertValidAppManifest,
  assertValidCompatibilityQuery,
  compareSemver,
  isLegalAppStateNamespace,
  payloadHasNoAppsMaterialKeys,
} from '../../src/modules/apps/public.ts';
import { ForbiddenError, InvalidRequestError } from '../../src/platform/errors/errors.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function validManifest(overrides: Record<string, unknown> = {}): AppManifest {
  return {
    appKey: 'agency-analytics',
    version: '1.2.0',
    compatibility: { minPlatform: '1.0.0', maxPlatform: '2.0.0' },
    capabilities: [
      { name: 'render-dashboard', version: '1.0.0' },
      { name: 'export-report', version: '1.1.0' },
    ],
    inputSchema: { required: ['workspaceId'] },
    outputSchema: { required: ['dashboardUrl'] },
    dataScopes: ['client:read', 'workspace:read'],
    mutationScopes: ['evidence:append', 'metric:append'],
    networkDestinations: [
      { host: 'api.example.com', protocol: 'https', port: 443, reason: 'fetch analytics sources' },
    ],
    runtimeClass: 'pooled-worker',
    eventSubscriptions: ['metric.observed'],
    uiSurfaces: [
      { surface: 'command-center-card', route: '/command-center/apps/agency-analytics' },
      { surface: 'client-room-panel', route: '/client-room/apps/agency-analytics' },
    ],
    configSchema: {
      region: {
        type: 'string',
        required: true,
        description: 'The reporting region',
        pattern: '^(eu|us)$',
      },
    },
    requiredCredentialNames: ['ANALYTICS_PROVIDER_KEY'],
    stateNamespaces: ['app:agency-analytics:spreadsheets', 'app:agency-analytics:report-definitions'],
    migrationVersion: 3,
    dependencies: [
      {
        kind: 'extension',
        publisher: 'payswap-labs',
        key: 'audience-enricher',
        minVersion: '1.0.0',
        maxVersion: '2.0.0',
      },
    ],
    supportLevel: 'standard',
    meteringDimensions: ['installations', 'invocations'],
    ...overrides,
  } as AppManifest;
}

/** Deep-writable copy for smuggling negative payloads. */
function writable(manifest: AppManifest): Record<string, unknown> {
  return JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
}

function castManifest(value: Record<string, unknown>): AppManifest {
  return value as unknown as AppManifest;
}

function assertRejected(fn: () => void, needle: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InvalidRequestError, `expected InvalidRequestError, got ${String(caught)}`);
  const details = (caught as InvalidRequestError).details ?? [];
  const haystack = [caught.message, ...details].join('\n');
  assert.ok(
    haystack.includes(needle),
    `expected rejection detail containing '${needle}', got: ${haystack}`,
  );
}

// ---------------------------------------------------------------------------
// The closed vocabularies
// ---------------------------------------------------------------------------

test('APP-001 vocabularies: the three frozen certification states, each with an interpretable meaning', () => {
  assert.deepEqual(APP_CERTIFICATION_STATES, ['UNVERIFIED', 'COMMUNITY_VERIFIED', 'MOS_CERTIFIED']);
  for (const state of APP_CERTIFICATION_STATES) {
    assert.ok(APP_CERTIFICATION_STATE_MEANINGS[state].length > 0, `meaning for ${state}`);
  }
});

test('APP-001 vocabularies: the four frozen runtime classes (the /executions set), each with a meaning', () => {
  assert.deepEqual(APP_RUNTIME_CLASSES, [
    'pooled-worker',
    'ephemeral-sandbox',
    'persistent-sandbox',
    'dedicated-runtime',
  ]);
  for (const runtimeClass of APP_RUNTIME_CLASSES) {
    assert.ok(APP_RUNTIME_CLASS_MEANINGS[runtimeClass].length > 0);
  }
});

test('APP-001 vocabularies: the frozen data-scope and mutation-scope sets, each with a meaning', () => {
  assert.deepEqual(APP_DATA_SCOPES, ['client:read', 'client:write', 'workspace:read', 'workspace:write']);
  assert.deepEqual(APP_MUTATION_SCOPES, [
    'workflow:dispatch',
    'execution:request',
    'evidence:append',
    'metric:append',
    'credential:bind',
  ]);
  for (const scope of APP_DATA_SCOPES) assert.ok(APP_DATA_SCOPE_MEANINGS[scope].length > 0);
  for (const scope of APP_MUTATION_SCOPES) assert.ok(APP_MUTATION_SCOPE_MEANINGS[scope].length > 0);
  // No mutation scope names a direct core-table write: every entry is an
  // authority-invocation request (the closed set has no "workflow:write"
  // or "credential:create").
  for (const scope of APP_MUTATION_SCOPES) {
    assert.ok(scope.includes(':'), `scope ${scope} is authority-qualified`);
    assert.ok(!scope.startsWith('table:'));
  }
});

test('APP-001 vocabularies: the six frozen UI surface kinds and five metering dimensions', () => {
  assert.deepEqual(APP_UI_SURFACE_KINDS, [
    'command-center-card',
    'client-room-panel',
    'workspace-tab',
    'report-page',
    'editor-pane',
    'action-menu',
  ]);
  assert.deepEqual(APP_METERING_DIMENSIONS, [
    'installations',
    'invocations',
    'compute-runtime',
    'data-volume',
    'premium-capabilities',
  ]);
  for (const surface of APP_UI_SURFACE_KINDS) assert.ok(APP_UI_SURFACE_KIND_MEANINGS[surface].length > 0);
  for (const dimension of APP_METERING_DIMENSIONS) {
    assert.ok(APP_METERING_DIMENSION_MEANINGS[dimension].length > 0);
  }
});

test('APP-001: the server-derived publisher identity serialization', () => {
  assert.equal(
    appPublisherIdentityString({ kind: 'platform_developer', userId: '550e8400-e29b-7d4a-9f38-03f4b2c2a1ab' }),
    'dev:550e8400-e29b-7d4a-9f38-03f4b2c2a1ab',
  );
  assert.equal(appPublisherIdentityString({ kind: 'platform_service', label: 'internal' }), 'svc:internal');
});

// ---------------------------------------------------------------------------
// Semantic-version ordering (MKT-047 AC-10 — REAL ordering, never text)
// ---------------------------------------------------------------------------

test('semver ordering: NUMERIC component comparison — 1.9.0 < 1.10.0 (the text-ordering trap)', () => {
  assert.equal(compareSemver('1.9.0', '1.10.0'), -1);
  assert.equal(compareSemver('1.10.0', '1.9.0'), 1);
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('1.2.3', '1.3.0'), -1);
  assert.equal(compareSemver('1.2.3', '2.0.0'), -1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
});

test('semver ordering: prereleases sort BELOW their release; identifiers compare per semver', () => {
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareSemver('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareSemver('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.1-alpha'), -1);
  // Transitivity spot checks across the interesting region.
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0', '1.0.1', '1.1.0', '1.9.0', '1.10.0', '2.0.0'];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(compareSemver(ordered[index - 1]!, ordered[index]!), -1, `${ordered[index - 1]} < ${ordered[index]}`);
  }
});

// ---------------------------------------------------------------------------
// The compatibility-range matcher (MKT-047 AC-10 — inclusive bounds)
// ---------------------------------------------------------------------------

test('compatibility-range matcher: INCLUSIVE bounds under real semver ordering', () => {
  assert.equal(appVersionInRange('1.5.0', '1.0.0', '2.0.0'), true);
  assert.equal(appVersionInRange('1.0.0', '1.0.0', '2.0.0'), true); // min inclusive
  assert.equal(appVersionInRange('2.0.0', '1.0.0', '2.0.0'), true); // max inclusive
  assert.equal(appVersionInRange('0.9.9', '1.0.0', '2.0.0'), false);
  assert.equal(appVersionInRange('2.0.1', '1.0.0', '2.0.0'), false);
  assert.equal(appVersionInRange('1.10.0', '1.9.0', '1.10.0'), true); // numeric ordering
  assert.equal(appVersionInRange('1.9.5', '1.9.0', '1.10.0'), true);
  assert.equal(appVersionInRange('1.0.0-beta', '1.0.0', '1.0.1'), false); // prerelease below release
  assert.equal(appVersionInRange('1.0.0-beta', '1.0.0-alpha', '1.0.0-beta'), true);
});

// ---------------------------------------------------------------------------
// The namespace denylist (MKT-047 AC-10 — the singular authorities)
// ---------------------------------------------------------------------------

test('namespace denylist: exactly the fourteen singular authorities (frozen-manifest-v1.5.json)', () => {
  assert.deepEqual(APP_CORE_AUTHORITY_NAMESPACES, [
    'client',
    'workspace',
    'goal',
    'playbook',
    'deployment',
    'workflow',
    'task',
    'execution',
    'evidence',
    'experiment',
    'learning',
    'policy',
    'credential',
    'job',
  ]);
});

test('namespace denylist: a legal app-owned namespace passes; foreign claims, bare labels and core-authority claims are rejected', () => {
  assert.deepEqual(isLegalAppStateNamespace('agency-analytics', 'app:agency-analytics:spreadsheets'), {
    legal: true,
    reason: null,
  });
  // Not structurally namespaced.
  assert.equal(isLegalAppStateNamespace('agency-analytics', 'spreadsheets').legal, false);
  assert.equal(isLegalAppStateNamespace('agency-analytics', 'app/spreadsheets').legal, false);
  // Claims ANOTHER app's namespace.
  assert.equal(isLegalAppStateNamespace('agency-analytics', 'app:competitor-crm:docs').legal, false);
  // Claims every singular core authority.
  for (const core of APP_CORE_AUTHORITY_NAMESPACES) {
    const verdict = isLegalAppStateNamespace('agency-analytics', `app:agency-analytics:${core}`);
    assert.equal(verdict.legal, false, `core namespace ${core} must be denied`);
    assert.ok(verdict.reason?.includes('core-authority'), verdict.reason ?? '');
  }
});

// ---------------------------------------------------------------------------
// The manifest guard (the frozen mos-app-ecosystem-v1.5.md §Manifest shape)
// ---------------------------------------------------------------------------

test('manifest guard: a fully-declared §Manifest manifest passes the shape guard', () => {
  assertValidAppManifest(validManifest());
});

test('manifest guard: closed-vocabulary violations are rejected (scopes, runtime, UI surface, metering)', () => {
  assertRejected(
    () => assertValidAppManifest(validManifest({ dataScopes: ['client:admin'] })),
    'closed dataScopes vocabulary',
  );
  assertRejected(
    () => assertValidAppManifest(validManifest({ mutationScopes: ['workflow:write'] })),
    'closed mutationScopes vocabulary',
  );
  assertRejected(
    () => assertValidAppManifest(validManifest({ runtimeClass: 'serverless' })),
    'closed runtime-class vocabulary',
  );
  const badSurface = writable(validManifest());
  (badSurface['uiSurfaces'] as Record<string, unknown>[])[0]!['surface'] = 'floating-widget';
  assertRejected(() => assertValidAppManifest(castManifest(badSurface)), 'closed UI-surface-kind vocabulary');
  assertRejected(
    () => assertValidAppManifest(validManifest({ meteringDimensions: ['seats'] })),
    'closed meteringDimensions vocabulary',
  );
});

test('manifest guard: malformed identity/version/compatibility declarations are rejected', () => {
  assertRejected(() => assertValidAppManifest(validManifest({ appKey: 'Bad_Key' })), 'appKey');
  assertRejected(() => assertValidAppManifest(validManifest({ version: '1.2' })), 'semver label');
  assertRejected(
    () => assertValidAppManifest(validManifest({ compatibility: { minPlatform: '2.0.0', maxPlatform: '1.0.0' } })),
    'not ordered',
  );
  // 1.10.0 > 1.9.0 under REAL semver — this range IS ordered and passes.
  assertValidAppManifest(validManifest({ compatibility: { minPlatform: '1.9.0', maxPlatform: '1.10.0' } }));
});

test('manifest guard: capabilities are bounded, unique-named, versioned', () => {
  assertRejected(() => assertValidAppManifest(validManifest({ capabilities: [] })), 'at least one capability');
  const duplicate = writable(validManifest());
  (duplicate['capabilities'] as Record<string, unknown>[])[1]!['name'] = 'render-dashboard';
  assertRejected(() => assertValidAppManifest(castManifest(duplicate)), 'duplicate capability name');
  const badVersion = writable(validManifest());
  (badVersion['capabilities'] as Record<string, unknown>[])[0]!['version'] = '1';
  assertRejected(() => assertValidAppManifest(castManifest(badVersion)), 'capabilities[0].version');
});

test('manifest guard: secret VALUES are never acceptable anywhere in a manifest (§21/CRED-001)', () => {
  const smuggled = writable(validManifest());
  (smuggled['inputSchema'] as Record<string, unknown>)['apiKey'] = 'sk-live-1234567890';
  assertRejected(() => assertValidAppManifest(castManifest(smuggled)), 'material-shaped keys are rejected');
  const deep = writable(validManifest());
  (deep['configSchema'] as Record<string, unknown>)['region'] = {
    type: 'string',
    required: true,
    description: 'x',
    pattern: { nested: { secretHandle: 'h' } },
  };
  assertRejected(() => assertValidAppManifest(castManifest(deep)), 'material-shaped keys are rejected');
  // The pure walker fences every nesting level (arrays included).
  assert.deepEqual(
    payloadHasNoAppsMaterialKeys({ deep: { list: [{ password: 'x' }] } }),
    ['manifest.deep.list[0].password: material-shaped keys are rejected (secrets never appear in app manifests — §21; credential references are logical names only)'],
  );
  // The frozen material-key set itself (the migration-037 CHECK twin).
  assert.ok(APPS_MATERIAL_SHAPED_KEYS.includes('secret'));
  assert.ok(APPS_MATERIAL_SHAPED_KEYS.includes('apiKey'));
  assert.ok(APPS_MATERIAL_SHAPED_KEYS.includes('credentialValue'));
});

test('manifest guard: CERTIFICATION-shaped keys are rejected 403 — platform territory, a developer can never self-certify', () => {
  for (const key of ['certificationState', 'certification', 'trustLevel', 'trust', 'certified']) {
    const smuggled = writable(validManifest());
    smuggled[key] = 'MOS_CERTIFIED';
    assert.throws(
      () => assertValidAppManifest(castManifest(smuggled)),
      (error: unknown) => {
        assert.ok(error instanceof ForbiddenError, `expected ForbiddenError for ${key}, got ${String(error)}`);
        assert.ok(
          (error as ForbiddenError).message.includes('platform territory'),
          `the 403 must name the platform-territory rule: ${(error as ForbiddenError).message}`,
        );
        return true;
      },
      `certification key '${key}' must be rejected 403`,
    );
  }
});

test('manifest guard: authority-shaped keys (publisher, tenant identity, provenance) are rejected 422', () => {
  const publisher = writable(validManifest());
  publisher['publisher'] = 'spoofed-publisher';
  assertRejected(() => assertValidAppManifest(castManifest(publisher)), 'forbidden authority field');
  const tenant = writable(validManifest());
  tenant['clientId'] = '00000000-0000-0000-0000-000000000000';
  assertRejected(() => assertValidAppManifest(castManifest(tenant)), 'forbidden authority field');
  const provenance = writable(validManifest());
  provenance['createdBy'] = '00000000-0000-0000-0000-000000000000';
  assertRejected(() => assertValidAppManifest(castManifest(provenance)), 'forbidden authority field');
  const unknown = writable(validManifest());
  unknown['surpriseField'] = true;
  assertRejected(() => assertValidAppManifest(castManifest(unknown)), 'unknown field');
});

test('manifest guard: app-owned state namespaces must be namespaced under the OWN key (bounded app state)', () => {
  assertRejected(
    () => assertValidAppManifest(validManifest({ stateNamespaces: ['spreadsheets'] })),
    'structurally namespaced',
  );
  assertRejected(
    () => assertValidAppManifest(validManifest({ stateNamespaces: ['app:other-app:docs'] })),
    'its OWN key',
  );
  assertRejected(
    () => assertValidAppManifest(validManifest({ stateNamespaces: ['app:agency-analytics:workflow'] })),
    'core-authority namespace',
  );
  // A legal bounded app-owned namespace (a spreadsheet-document namespace
  // is valid; a competing Workflow state machine is not).
  assertValidAppManifest(
    validManifest({ stateNamespaces: ['app:agency-analytics:spreadsheet-documents'] }),
  );
});

test('manifest guard: dependencies are shape-checked, range-ordered and never self-referencing', () => {
  assertRejected(
    () =>
      assertValidAppManifest(
        validManifest({
          dependencies: [
            { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '2.0.0', maxVersion: '1.0.0' },
          ],
        }),
      ),
    'not ordered',
  );
  assertRejected(
    () =>
      assertValidAppManifest(
        validManifest({
          dependencies: [
            { kind: 'app', publisher: null, key: 'agency-analytics', minVersion: '1.0.0', maxVersion: '2.0.0' },
          ],
        }),
      ),
    'own app key',
  );
  assertRejected(
    () =>
      assertValidAppManifest(
        validManifest({
          dependencies: [
            { kind: 'widget', publisher: null, key: 'thing', minVersion: '1.0.0', maxVersion: '2.0.0' },
          ],
        }),
      ),
    "'extension' or 'app'",
  );
});

test('manifest guard: configuration schema field contracts and bounded metadata', () => {
  const badConfig = writable(validManifest());
  (badConfig['configSchema'] as Record<string, unknown>)['region'] = { type: 'yaml' };
  assertRejected(() => assertValidAppManifest(castManifest(badConfig)), 'configSchema.region.type');
  assertRejected(() => assertValidAppManifest(validManifest({ supportLevel: '' })), 'supportLevel');
  assertRejected(
    () => assertValidAppManifest(validManifest({ migrationVersion: -1 })),
    'migrationVersion',
  );
  assertRejected(
    () => assertValidAppManifest(validManifest({ requiredCredentialNames: ['lowercase_key'] })),
    'LOGICAL name',
  );
});

// ---------------------------------------------------------------------------
// The compatibility-query guard + the shared dependency predicate
// ---------------------------------------------------------------------------

test('compatibility-query guard: platform version, optional runtime class, bounded extension descriptors', () => {
  assertValidCompatibilityQuery({
    platformVersion: '1.5.0',
    runtimeClass: 'pooled-worker',
    extensionVersions: [{ publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.4.0' }],
  });
  assertValidCompatibilityQuery({
    platformVersion: '1.5.0',
    runtimeClass: null,
    extensionVersions: [],
  });
  assertRejected(
    () => assertValidCompatibilityQuery({ platformVersion: '1.5', runtimeClass: null, extensionVersions: [] }),
    'platformVersion',
  );
  assertRejected(
    () =>
      assertValidCompatibilityQuery({
        platformVersion: '1.5.0',
        runtimeClass: 'serverless',
        extensionVersions: [],
      }),
    'closed runtime-class vocabulary',
  );
});

test('the shared dependency predicate: extension/app satisfaction and self-dependency detection', () => {
  const manifest = validManifest({
    dependencies: [
      { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '1.0.0', maxVersion: '2.0.0' },
      { kind: 'app', publisher: null, key: 'spreadsheet-engine', minVersion: '1.0.0', maxVersion: '1.9.0' },
    ],
  });
  // Both satisfied.
  assert.deepEqual(
    appDependenciesValid(manifest, {
      extensionVersions: [{ publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.5.0' }],
      appVersions: [{ appKey: 'spreadsheet-engine', version: '1.4.2' }],
    }),
    [],
  );
  // Extension outside range (numeric ordering: 3.0.0 > 2.0.0).
  const extensionMiss = appDependenciesValid(manifest, {
    extensionVersions: [{ publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '3.0.0' }],
    appVersions: [{ appKey: 'spreadsheet-engine', version: '1.4.2' }],
  });
  assert.equal(extensionMiss.length, 1);
  assert.ok(extensionMiss[0]!.includes('audience-enricher'));
  // Missing app dependency.
  const appMiss = appDependenciesValid(manifest, {
    extensionVersions: [{ publisher: 'payswap-labs', extensionKey: 'audience-enricher', version: '1.5.0' }],
    appVersions: [],
  });
  assert.equal(appMiss.length, 1);
  assert.ok(appMiss[0]!.includes('spreadsheet-engine'));
  // Self-dependency is always reported.
  const selfDep = appDependenciesValid(
    { appKey: 'agency-analytics', dependencies: [{ kind: 'app', publisher: null, key: 'agency-analytics', minVersion: '1.0.0', maxVersion: '2.0.0' }] },
    { extensionVersions: [], appVersions: [{ appKey: 'agency-analytics', version: '1.2.0' }] },
  );
  assert.equal(selfDep.length, 1);
  assert.ok(selfDep[0]!.includes('self-dependency'));
});

// ---------------------------------------------------------------------------
// The deterministic fingerprint (canonical JSON)
// ---------------------------------------------------------------------------

test('the manifest fingerprint is deterministic and key-order independent (canonical JSON)', () => {
  const first = appCreateFingerprint(validManifest());
  assert.equal(first, appCreateFingerprint(validManifest()));
  const reordered = JSON.parse(JSON.stringify(validManifest())) as Record<string, unknown>;
  const compatibility = reordered['compatibility'] as Record<string, unknown>;
  reordered['compatibility'] = { maxPlatform: compatibility['maxPlatform'], minPlatform: compatibility['minPlatform'] };
  assert.equal(appCreateFingerprint(reordered as unknown as AppManifest), first);
  assert.notEqual(
    appCreateFingerprint(validManifest({ version: '1.3.0' })),
    first,
    'different content produces a different fingerprint',
  );
});
