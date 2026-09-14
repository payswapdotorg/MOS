/**
 * MKT-049 unit tests — THE SDK DRIFT-PINNING suite (the AC-1 "drift test
 * that fails when the public contract changes without the SDK being
 * regenerated" + the AC-3 "shared-source test [that] proves the
 * validator and the registry agree").
 *
 * The App SDK (tools/app-sdk) is a HAND-FROZEN MIRROR of the /apps
 * registry public contract (src/modules/apps/public.ts + the guard
 * exports of internal/store.ts re-exported through it). This suite pins
 * EVERY mirrored dimension to the authority, so any authority-side
 * change without a same-change SDK regeneration FAILS here:
 *
 *   1. TYPE-LEVEL pins (compile-time — `npm run typecheck` fails on
 *      shape drift): the mirror types are asserted EQUAL to the
 *      authority types for the manifest contract, the record, the
 *      signature, the compatibility query, the publisher identity and
 *      the /app-installs read model;
 *   2. RUNTIME vocabulary pins: every closed vocabulary array and every
 *      meaning map is DEEP-EQUAL to the authority export;
 *   3. FINGERPRINT pin: the SDK's canonical-manifest digest equals the
 *      authority's appCreateFingerprint over the manifest corpus (the
 *      signing contract);
 *   4. SIGNATURE-GUARD pin: the SDK's appManifestSignatureProblems
 *      equals the authority's over the signature corpus;
 *   5. VALIDATOR EQUIVALENCE (AC-3 — the shared-source test): over a
 *      MUTATION CORPUS (a fully valid manifest + systematically-invalid
 *      manifests covering EVERY rejection class of the frozen guard),
 *      the SDK's offline validateAppManifest returns the IDENTICAL
 *      verdict, problem strings, rejection class and summary the
 *      authority's assertValidAppManifest produces (ForbiddenError →
 *      'certification-territory'; InvalidRequestError → 'invalid');
 *   6. DOCUMENTATION pin: the served route's manifest-schema table
 *      equals the SDK's offline table (the served and offline docs
 *      never fork).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppCapabilityDeclaration as AuthorityAppCapabilityDeclaration,
  AppCertificationState as AuthorityAppCertificationState,
  AppConfigFieldContract as AuthorityAppConfigFieldContract,
  AppCompatibilityQuery as AuthorityAppCompatibilityQuery,
  AppCompatibilityReport as AuthorityAppCompatibilityReport,
  AppDataScope as AuthorityAppDataScope,
  AppDependencyDeclaration as AuthorityAppDependencyDeclaration,
  AppIneligibleVersion as AuthorityAppIneligibleVersion,
  AppManifest as AuthorityAppManifest,
  AppManifestSignature as AuthorityAppManifestSignature,
  AppMeteringDimension as AuthorityAppMeteringDimension,
  AppMutationScope as AuthorityAppMutationScope,
  AppNetworkDestination as AuthorityAppNetworkDestination,
  AppPublisherIdentity as AuthorityAppPublisherIdentity,
  AppQueryExtensionVersion as AuthorityAppQueryExtensionVersion,
  AppRuntimeClass as AuthorityAppRuntimeClass,
  AppSignatureAlgorithm as AuthorityAppSignatureAlgorithm,
  AppUiSurfaceDeclaration as AuthorityAppUiSurfaceDeclaration,
  AppUiSurfaceKind as AuthorityAppUiSurfaceKind,
  AppVersionRecord as AuthorityAppVersionRecord,
} from '../../src/modules/apps/public.ts';
import type {
  AppInstallOperation as AuthorityAppInstallOperation,
  AppInstallRecord as AuthorityAppInstallRecord,
  AppInstallStatus as AuthorityAppInstallStatus,
} from '../../src/modules/app-installs/public.ts';
import {
  APP_CERTIFICATION_STATES as AUTHORITY_CERTIFICATION_STATES,
  APP_CERTIFICATION_STATE_MEANINGS as AUTHORITY_CERTIFICATION_MEANINGS,
  APP_CORE_AUTHORITY_NAMESPACES as AUTHORITY_CORE_AUTHORITY_NAMESPACES,
  APP_DATA_SCOPES as AUTHORITY_DATA_SCOPES,
  APP_DATA_SCOPE_MEANINGS as AUTHORITY_DATA_SCOPE_MEANINGS,
  APP_METERING_DIMENSIONS as AUTHORITY_METERING_DIMENSIONS,
  APP_METERING_DIMENSION_MEANINGS as AUTHORITY_METERING_MEANINGS,
  APP_MUTATION_SCOPES as AUTHORITY_MUTATION_SCOPES,
  APP_MUTATION_SCOPE_MEANINGS as AUTHORITY_MUTATION_MEANINGS,
  APP_RUNTIME_CLASSES as AUTHORITY_RUNTIME_CLASSES,
  APP_RUNTIME_CLASS_MEANINGS as AUTHORITY_RUNTIME_CLASS_MEANINGS,
  APP_SIGNATURE_ALGORITHMS as AUTHORITY_SIGNATURE_ALGORITHMS,
  APP_UI_SURFACE_KINDS as AUTHORITY_UI_SURFACE_KINDS,
  APP_UI_SURFACE_KIND_MEANINGS as AUTHORITY_UI_SURFACE_KIND_MEANINGS,
  APPS_MATERIAL_SHAPED_KEYS as AUTHORITY_MATERIAL_SHAPED_KEYS,
  appCreateFingerprint as authorityFingerprint,
  appManifestSignatureProblems as authoritySignatureProblems,
  assertValidAppManifest as authorityGuard,
  compareSemver as authorityCompareSemver,
} from '../../src/modules/apps/public.ts';
import { ForbiddenError, InvalidRequestError } from '../../src/platform/errors/errors.ts';
import { DEVELOPER_PORTAL_MANIFEST_FIELD_DOCS } from '../../src/api/developer-portal-routes.ts';
import type {
  AppCapabilityDeclaration as SdkAppCapabilityDeclaration,
  AppCertificationState as SdkAppCertificationState,
  AppConfigFieldContract as SdkAppConfigFieldContract,
  AppCompatibilityQuery as SdkAppCompatibilityQuery,
  AppCompatibilityReport as SdkAppCompatibilityReport,
  AppDataScope as SdkAppDataScope,
  AppDependencyDeclaration as SdkAppDependencyDeclaration,
  AppIneligibleVersion as SdkAppIneligibleVersion,
  AppInstallOperation as SdkAppInstallOperation,
  AppInstallRecord as SdkAppInstallRecord,
  AppInstallStatus as SdkAppInstallStatus,
  AppManifest as SdkAppManifest,
  AppManifestSignature as SdkAppManifestSignature,
  AppMeteringDimension as SdkAppMeteringDimension,
  AppMutationScope as SdkAppMutationScope,
  AppNetworkDestination as SdkAppNetworkDestination,
  AppPublisherIdentity as SdkAppPublisherIdentity,
  AppQueryExtensionVersion as SdkAppQueryExtensionVersion,
  AppRuntimeClass as SdkAppRuntimeClass,
  AppSignatureAlgorithm as SdkAppSignatureAlgorithm,
  AppUiSurfaceDeclaration as SdkAppUiSurfaceDeclaration,
  AppUiSurfaceKind as SdkAppUiSurfaceKind,
  AppVersionRecord as SdkAppVersionRecord,
} from '../../tools/app-sdk/src/types.ts';
import {
  APP_CERTIFICATION_STATES as SDK_CERTIFICATION_STATES,
  APP_CERTIFICATION_STATE_MEANINGS as SDK_CERTIFICATION_MEANINGS,
  APP_CORE_AUTHORITY_NAMESPACES as SDK_CORE_AUTHORITY_NAMESPACES,
  APP_DATA_SCOPES as SDK_DATA_SCOPES,
  APP_DATA_SCOPE_MEANINGS as SDK_DATA_SCOPE_MEANINGS,
  APP_METERING_DIMENSIONS as SDK_METERING_DIMENSIONS,
  APP_METERING_DIMENSION_MEANINGS as SDK_METERING_MEANINGS,
  APP_MUTATION_SCOPES as SDK_MUTATION_SCOPES,
  APP_MUTATION_SCOPE_MEANINGS as SDK_MUTATION_MEANINGS,
  APP_RUNTIME_CLASSES as SDK_RUNTIME_CLASSES,
  APP_RUNTIME_CLASS_MEANINGS as SDK_RUNTIME_CLASS_MEANINGS,
  APP_SIGNATURE_ALGORITHMS as SDK_SIGNATURE_ALGORITHMS,
  APP_UI_SURFACE_KINDS as SDK_UI_SURFACE_KINDS,
  APP_UI_SURFACE_KIND_MEANINGS as SDK_UI_SURFACE_MEANINGS,
  APPS_MATERIAL_SHAPED_KEYS as SDK_MATERIAL_SHAPED_KEYS,
} from '../../tools/app-sdk/src/vocabularies.ts';
import { appManifestFingerprint as sdkFingerprint } from '../../tools/app-sdk/src/fingerprint.ts';
import { appManifestSignatureProblems as sdkSignatureProblems } from '../../tools/app-sdk/src/fingerprint.ts';
import { compareSemver as sdkCompareSemver } from '../../tools/app-sdk/src/semver.ts';
import { validateAppManifest as sdkValidate } from '../../tools/app-sdk/src/validate.ts';
import { MANIFEST_FIELD_DOCS as SDK_MANIFEST_FIELD_DOCS } from '../../tools/app-sdk/src/docs.ts';

// ---------------------------------------------------------------------------
// Type-level equality pins (compile-time drift — tsc --noEmit enforces)
// ---------------------------------------------------------------------------

/** Structural type equality oracle (strict, mutually assignable). */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

/**
 * THE 23 compile-time drift pins: every tuple element's type must be the
 * literal `true` — `Equal<Mirror, Authority>` resolves to `false` the
 * moment the /apps (or /app-installs) public contract changes shape
 * without the SDK mirror being regenerated, and `Expect<false>` violates
 * `T extends true` so `tsc --noEmit` FAILS (the compile-time half of the
 * AC-1 drift test). The runtime test below pins the tuple length so the
 * assertions can never be silently dropped.
 */
const TYPE_PINS: readonly [
  Expect<Equal<SdkAppManifest, AuthorityAppManifest>>,
  Expect<Equal<SdkAppVersionRecord, AuthorityAppVersionRecord>>,
  Expect<Equal<SdkAppManifestSignature, AuthorityAppManifestSignature>>,
  Expect<Equal<SdkAppSignatureAlgorithm, AuthorityAppSignatureAlgorithm>>,
  Expect<Equal<SdkAppCapabilityDeclaration, AuthorityAppCapabilityDeclaration>>,
  Expect<Equal<SdkAppNetworkDestination, AuthorityAppNetworkDestination>>,
  Expect<Equal<SdkAppUiSurfaceDeclaration, AuthorityAppUiSurfaceDeclaration>>,
  Expect<Equal<SdkAppConfigFieldContract, AuthorityAppConfigFieldContract>>,
  Expect<Equal<SdkAppDependencyDeclaration, AuthorityAppDependencyDeclaration>>,
  Expect<Equal<SdkAppCertificationState, AuthorityAppCertificationState>>,
  Expect<Equal<SdkAppRuntimeClass, AuthorityAppRuntimeClass>>,
  Expect<Equal<SdkAppDataScope, AuthorityAppDataScope>>,
  Expect<Equal<SdkAppMutationScope, AuthorityAppMutationScope>>,
  Expect<Equal<SdkAppUiSurfaceKind, AuthorityAppUiSurfaceKind>>,
  Expect<Equal<SdkAppMeteringDimension, AuthorityAppMeteringDimension>>,
  Expect<Equal<SdkAppCompatibilityQuery, AuthorityAppCompatibilityQuery>>,
  Expect<Equal<SdkAppQueryExtensionVersion, AuthorityAppQueryExtensionVersion>>,
  Expect<Equal<SdkAppIneligibleVersion, AuthorityAppIneligibleVersion>>,
  Expect<Equal<SdkAppCompatibilityReport, AuthorityAppCompatibilityReport>>,
  Expect<Equal<SdkAppPublisherIdentity, AuthorityAppPublisherIdentity>>,
  Expect<Equal<SdkAppInstallOperation, AuthorityAppInstallOperation>>,
  Expect<Equal<SdkAppInstallStatus, AuthorityAppInstallStatus>>,
  Expect<Equal<SdkAppInstallRecord, AuthorityAppInstallRecord>>,
] = [
  true, true, true, true, true, true, true, true, true, true, true, true,
  true, true, true, true, true, true, true, true, true, true, true,
];

test('MKT-049 AC-1 drift pin (type-level): the SDK mirror types are EQUAL to the /apps authority types', () => {
  // The assertions are COMPILE-TIME (the TYPE_PINS tuple above fails
  // `npm run typecheck` when the authority contract changes shape without
  // the SDK being regenerated). This runtime half proves the pins are
  // wired into the suite and can never be silently dropped.
  assert.equal(TYPE_PINS.length, 23, '23 type-level drift pins are declared');
  assert.ok(TYPE_PINS.every((pin) => pin === true));
});

// ---------------------------------------------------------------------------
// Runtime vocabulary pins
// ---------------------------------------------------------------------------

test('MKT-049 AC-1 drift pin (runtime): every frozen vocabulary + meaning map is DEEP-EQUAL to the authority export', () => {
  assert.deepEqual(SDK_CERTIFICATION_STATES, AUTHORITY_CERTIFICATION_STATES);
  assert.deepEqual(SDK_CERTIFICATION_MEANINGS, AUTHORITY_CERTIFICATION_MEANINGS);
  assert.deepEqual(SDK_RUNTIME_CLASSES, AUTHORITY_RUNTIME_CLASSES);
  assert.deepEqual(SDK_RUNTIME_CLASS_MEANINGS, AUTHORITY_RUNTIME_CLASS_MEANINGS);
  assert.deepEqual(SDK_DATA_SCOPES, AUTHORITY_DATA_SCOPES);
  assert.deepEqual(SDK_DATA_SCOPE_MEANINGS, AUTHORITY_DATA_SCOPE_MEANINGS);
  assert.deepEqual(SDK_MUTATION_SCOPES, AUTHORITY_MUTATION_SCOPES);
  assert.deepEqual(SDK_MUTATION_MEANINGS, AUTHORITY_MUTATION_MEANINGS);
  assert.deepEqual(SDK_UI_SURFACE_KINDS, AUTHORITY_UI_SURFACE_KINDS);
  assert.deepEqual(SDK_UI_SURFACE_MEANINGS, AUTHORITY_UI_SURFACE_KIND_MEANINGS);
  assert.deepEqual(SDK_METERING_DIMENSIONS, AUTHORITY_METERING_DIMENSIONS);
  assert.deepEqual(SDK_METERING_MEANINGS, AUTHORITY_METERING_MEANINGS);
  assert.deepEqual(SDK_CORE_AUTHORITY_NAMESPACES, AUTHORITY_CORE_AUTHORITY_NAMESPACES);
  assert.deepEqual(SDK_SIGNATURE_ALGORITHMS, AUTHORITY_SIGNATURE_ALGORITHMS);
  assert.deepEqual([...SDK_MATERIAL_SHAPED_KEYS], [...AUTHORITY_MATERIAL_SHAPED_KEYS]);
});

// ---------------------------------------------------------------------------
// The manifest corpus (the shared fixtures of the fingerprint/validator pins)
// ---------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function baseManifest(): Mutable<SdkAppManifest> {
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
      { surface: 'report-page', route: '/reports/agency-analytics' },
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
    stateNamespaces: ['app:agency-analytics:spreadsheets'],
    migrationVersion: 1,
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
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** One corpus case built by mutating a deep clone of the base manifest (untyped — invalid inputs are the point). */
function mutateCase(
  label: string,
  mutate: (manifest: Record<string, unknown>) => void,
): { label: string; manifest: unknown } {
  const manifest = clone(baseManifest()) as unknown as Record<string, unknown>;
  mutate(manifest);
  return { label, manifest };
}

/** The mutation corpus: { label, manifest } pairs covering every rejection class + valid shapes. */
function manifestCorpus(): ReadonlyArray<{ label: string; manifest: unknown }> {
  const cases: Array<{ label: string; manifest: unknown }> = [];

  // --- valid shapes ----------------------------------------------------------
  cases.push({ label: 'the fully-declared manifest is valid', manifest: baseManifest() });
  cases.push(mutateCase('the minimal-but-complete manifest is valid', (manifest) => {
    manifest['dataScopes'] = [];
    manifest['mutationScopes'] = [];
    manifest['networkDestinations'] = [];
    manifest['eventSubscriptions'] = [];
    manifest['uiSurfaces'] = [];
    manifest['configSchema'] = {};
    manifest['requiredCredentialNames'] = [];
    manifest['stateNamespaces'] = [];
    manifest['dependencies'] = [];
    manifest['meteringDimensions'] = [];
  }));
  cases.push(mutateCase('prerelease semver labels are valid', (manifest) => {
    manifest['version'] = '2.0.0-rc.1';
  }));
  cases.push(mutateCase('app dependencies (publisher null) are valid', (manifest) => {
    manifest['dependencies'] = [
      { kind: 'app', publisher: null, key: 'other-app', minVersion: '1.0.0', maxVersion: '1.9.9' },
    ];
  }));
  cases.push(mutateCase('config pattern null is valid', (manifest) => {
    manifest['configSchema'] = {
      region: { type: 'string', required: false, description: 'optional region', pattern: null },
    };
  }));

  // --- non-object manifests ---------------------------------------------------
  cases.push({ label: 'null manifest', manifest: null });
  cases.push({ label: 'string manifest', manifest: 'app' });
  cases.push({ label: 'number manifest', manifest: 42 });
  cases.push({ label: 'array manifest (flows the object path — per-index unknown fields)', manifest: ['a'] });

  // --- certification territory (the 403 class) ---------------------------------
  for (const key of ['certificationState', 'certification', 'trustLevel', 'trust', 'certified']) {
    cases.push(mutateCase(`certification-shaped key '${key}' (403 territory)`, (manifest) => {
      manifest[key] = 'MOS_CERTIFIED';
    }));
  }

  // --- authority-shaped keys (422 class) ------------------------------------------
  for (const key of ['publisher', 'publisherId', 'ownerPublisher', 'agencyId', 'clientId', 'workspaceId', 'tenantId', 'appVersionId', 'createFingerprint', 'createdBy', 'createdAt', 'updatedAt', 'provenance', 'actor', 'correlationId', 'causationId', 'recordedAt']) {
    cases.push(mutateCase(`authority-shaped key '${key}' (422)`, (manifest) => {
      manifest[key] = 'spoofed';
    }));
  }

  // --- unknown fields -------------------------------------------------------------
  cases.push(mutateCase('unknown manifest field (strict shape)', (manifest) => {
    manifest['extraField'] = 'nope';
  }));
  cases.push(mutateCase('unknown nested capability field is NOT an unknown top-level field (capabilities items only check key count)', (manifest) => {
    (manifest['capabilities'] as Array<Record<string, unknown>>)[0]!['extra'] = 1;
  }));

  // --- identity + semver ------------------------------------------------------------
  cases.push(mutateCase('malformed appKey', (manifest) => {
    manifest['appKey'] = 'Bad_Key';
  }));
  cases.push(mutateCase('malformed version semver', (manifest) => {
    manifest['version'] = '1.2';
  }));
  cases.push(mutateCase('unordered compatibility range', (manifest) => {
    manifest['compatibility'] = { minPlatform: '2.0.0', maxPlatform: '1.0.0' };
  }));
  cases.push(mutateCase('null compatibility', (manifest) => {
    manifest['compatibility'] = null;
  }));

  // --- capabilities -----------------------------------------------------------------
  cases.push(mutateCase('empty capabilities', (manifest) => {
    manifest['capabilities'] = [];
  }));
  cases.push(mutateCase('duplicate capability name', (manifest) => {
    manifest['capabilities'] = [
      { name: 'render-dashboard', version: '1.0.0' },
      { name: 'render-dashboard', version: '1.1.0' },
    ];
  }));
  cases.push(mutateCase('capability item not an object', (manifest) => {
    manifest['capabilities'] = ['render'];
  }));
  cases.push(mutateCase('capability item with extra key (key-count violation)', (manifest) => {
    (manifest['capabilities'] as Array<Record<string, unknown>>)[0]!['mode'] = 'x';
  }));
  cases.push(mutateCase('empty capability name', (manifest) => {
    (manifest['capabilities'] as Array<Record<string, unknown>>)[0]!['name'] = '';
  }));

  // --- schemas + material keys ---------------------------------------------------------
  cases.push(mutateCase('inputSchema as array', (manifest) => {
    manifest['inputSchema'] = [];
  }));
  cases.push(mutateCase('material-shaped key nested in outputSchema (§21)', (manifest) => {
    (manifest['outputSchema'] as Record<string, unknown>)['apiKey'] = 'spoofed-secret';
  }));
  cases.push(mutateCase('material-shaped top-level key (§21)', (manifest) => {
    manifest['token'] = 'x';
  }));

  // --- closed vocabularies -------------------------------------------------------------
  cases.push(mutateCase('out-of-vocabulary data scope', (manifest) => {
    manifest['dataScopes'] = ['client:readd'];
  }));
  cases.push(mutateCase('duplicate data scope', (manifest) => {
    manifest['dataScopes'] = ['client:read', 'client:read'];
  }));
  cases.push(mutateCase('data scope not a string', (manifest) => {
    manifest['dataScopes'] = [7];
  }));
  cases.push(mutateCase('out-of-vocabulary mutation scope', (manifest) => {
    manifest['mutationScopes'] = ['workflow:rewrite'];
  }));
  cases.push(mutateCase('out-of-vocabulary runtime class', (manifest) => {
    manifest['runtimeClass'] = 'serverless-container';
  }));
  cases.push(mutateCase('out-of-vocabulary metering dimension', (manifest) => {
    manifest['meteringDimensions'] = ['seats'];
  }));
  cases.push(mutateCase('out-of-vocabulary UI surface kind', (manifest) => {
    (manifest['uiSurfaces'] as Array<Record<string, unknown>>)[0]!['surface'] = 'sidebar-widget';
  }));
  cases.push(mutateCase('malformed UI route', (manifest) => {
    (manifest['uiSurfaces'] as Array<Record<string, unknown>>)[1]!['route'] = 'not-a-route';
  }));

  // --- network destinations --------------------------------------------------------------
  cases.push(mutateCase('network port out of range', (manifest) => {
    (manifest['networkDestinations'] as Array<Record<string, unknown>>)[0]!['port'] = 70000;
  }));
  cases.push(mutateCase('network port as string (guard requires number)', (manifest) => {
    (manifest['networkDestinations'] as Array<Record<string, unknown>>)[0]!['port'] = '443';
  }));

  // --- events / credentials / namespaces ----------------------------------------------------
  cases.push(mutateCase('duplicate event subscription', (manifest) => {
    manifest['eventSubscriptions'] = ['metric.observed', 'metric.observed'];
  }));
  cases.push(mutateCase('lowercase credential name', (manifest) => {
    manifest['requiredCredentialNames'] = ['analytics-key'];
  }));
  cases.push(mutateCase('non-namespaced state namespace', (manifest) => {
    manifest['stateNamespaces'] = ['spreadsheets'];
  }));
  cases.push(mutateCase('foreign-key state namespace', (manifest) => {
    manifest['stateNamespaces'] = ['app:other-app:spreadsheets'];
  }));
  cases.push(mutateCase('core-authority state namespace (workflow)', (manifest) => {
    manifest['stateNamespaces'] = ['app:agency-analytics:workflow'];
  }));
  cases.push(mutateCase('duplicate state namespace', (manifest) => {
    manifest['stateNamespaces'] = [
      'app:agency-analytics:spreadsheets',
      'app:agency-analytics:spreadsheets',
    ];
  }));

  // --- migration version / dependencies -----------------------------------------------------
  cases.push(mutateCase('negative migration version', (manifest) => {
    manifest['migrationVersion'] = -1;
  }));
  cases.push(mutateCase('self-dependency', (manifest) => {
    manifest['dependencies'] = [
      { kind: 'app', publisher: null, key: 'agency-analytics', minVersion: '1.0.0', maxVersion: '2.0.0' },
    ];
  }));
  cases.push(mutateCase('unordered dependency range', (manifest) => {
    manifest['dependencies'] = [
      { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '2.0.0', maxVersion: '1.0.0' },
    ];
  }));
  cases.push(mutateCase('extension dependency without publisher', (manifest) => {
    (manifest['dependencies'] as Array<Record<string, unknown>>)[0]!['publisher'] = null;
  }));
  cases.push(mutateCase('app dependency with publisher', (manifest) => {
    manifest['dependencies'] = [
      { kind: 'app', publisher: 'someone', key: 'other-app', minVersion: '1.0.0', maxVersion: '1.9.9' },
    ];
  }));
  cases.push(mutateCase('invalid dependency kind', (manifest) => {
    (manifest['dependencies'] as Array<Record<string, unknown>>)[0]!['kind'] = 'plugin';
  }));
  cases.push(mutateCase('duplicate dependency declaration', (manifest) => {
    manifest['dependencies'] = [
      { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '1.0.0', maxVersion: '2.0.0' },
      { kind: 'extension', publisher: 'payswap-labs', key: 'audience-enricher', minVersion: '1.0.0', maxVersion: '1.5.0' },
    ];
  }));

  // --- support level + config contracts --------------------------------------------------------
  cases.push(mutateCase('empty support level', (manifest) => {
    manifest['supportLevel'] = '';
  }));
  cases.push(mutateCase('invalid config field type', (manifest) => {
    (manifest['configSchema'] as Record<string, Record<string, unknown>>)['region']!['type'] = 'array';
  }));
  cases.push(mutateCase('config pattern omitted (undefined — allowed like the authority)', (manifest) => {
    delete (manifest['configSchema'] as Record<string, Record<string, unknown>>)['region']!['pattern'];
  }));

  return cases;
}

/** The authority's verdict as the SDK result shape (the oracle). */
function authorityVerdict(manifest: unknown): {
  valid: boolean;
  problems: readonly string[];
  rejectionClass: 'certification-territory' | 'invalid' | null;
  summary: string | null;
} {
  try {
    authorityGuard(manifest as AuthorityAppManifest);
    return { valid: true, problems: [], rejectionClass: null, summary: null };
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return {
        valid: false,
        problems: [error.message],
        rejectionClass: 'certification-territory',
        summary: error.message,
      };
    }
    if (error instanceof InvalidRequestError) {
      return {
        valid: false,
        problems: [...(error.details ?? [error.message])],
        rejectionClass: 'invalid',
        summary: error.message,
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// AC-3 — THE shared-source validator equivalence (the drift core)
// ---------------------------------------------------------------------------

test('MKT-049 AC-3 shared-source test: the SDK offline validator agrees with the registry guard over the full mutation corpus', () => {
  const corpus = manifestCorpus();
  assert.ok(corpus.length >= 60, `the corpus covers every rejection class (found ${corpus.length} cases)`);
  let validCount = 0;
  let rejectedCount = 0;
  for (const { label, manifest } of corpus) {
    const expected = authorityVerdict(manifest);
    const actual = sdkValidate(manifest);
    if (expected.valid) validCount += 1;
    else rejectedCount += 1;
    assert.deepEqual(
      {
        valid: actual.valid,
        problems: [...actual.problems],
        rejectionClass: actual.rejectionClass,
        summary: actual.summary,
      },
      {
        valid: expected.valid,
        problems: [...expected.problems],
        rejectionClass: expected.rejectionClass,
        summary: expected.summary,
      },
      `corpus case '${label}': the SDK mirror verdict must be IDENTICAL to the authority guard (verdict, problem strings, rejection class, summary)`,
    );
  }
  assert.ok(validCount >= 5, 'the corpus includes multiple valid shapes');
  assert.ok(rejectedCount >= 50, 'the corpus covers the rejection classes broadly');
});

// ---------------------------------------------------------------------------
// AC-5 — the fingerprint + signature drift pins
// ---------------------------------------------------------------------------

test('MKT-049 AC-5 drift pin: the SDK canonical-manifest fingerprint equals the registry appCreateFingerprint over the corpus', () => {
  for (const { label, manifest } of manifestCorpus()) {
    assert.equal(
      sdkFingerprint(manifest),
      authorityFingerprint(manifest as AuthorityAppManifest),
      `corpus case '${label}': the offline signing digest must equal the server-side fingerprint`,
    );
  }
  // Key-order independence: the same manifest with different key order
  // hashes identically (canonicalization sorts at every level).
  const reordered: Record<string, unknown> = {};
  const base = baseManifest() as unknown as Record<string, unknown>;
  for (const key of Object.keys(base).reverse()) {
    reordered[key] = clone(base[key]);
  }
  assert.equal(
    sdkFingerprint(reordered),
    authorityFingerprint(base as unknown as AuthorityAppManifest),
  );
});

test('MKT-049 AC-5 drift pin: the SDK signature guard equals the registry appManifestSignatureProblems over the signature corpus', () => {
  const valid = baseManifest();
  const signatureCorpus: ReadonlyArray<{ label: string; signature: unknown }> = [
    { label: 'absent (undefined)', signature: undefined },
    { label: 'explicit null', signature: null },
    {
      label: 'the correct attestation',
      signature: { algorithm: 'manifest-sha256-fingerprint', digest: authorityFingerprint(valid as AuthorityAppManifest) },
    },
    {
      label: 'a mismatched digest (integrity failure)',
      signature: { algorithm: 'manifest-sha256-fingerprint', digest: 'a'.repeat(64) },
    },
    { label: 'wrong algorithm', signature: { algorithm: 'ed25519', digest: 'a'.repeat(64) } },
    { label: 'digest not hex', signature: { algorithm: 'manifest-sha256-fingerprint', digest: 'A'.repeat(64) } },
    { label: 'short digest', signature: { algorithm: 'manifest-sha256-fingerprint', digest: 'abc' } },
    { label: 'extra key', signature: { algorithm: 'manifest-sha256-fingerprint', digest: 'a'.repeat(64), kid: 'k1' } },
    { label: 'not an object', signature: 'signed' },
    { label: 'array signature', signature: ['manifest-sha256-fingerprint'] },
  ];
  for (const { label, signature } of signatureCorpus) {
    assert.deepEqual(
      sdkSignatureProblems(valid, signature),
      authoritySignatureProblems(valid as AuthorityAppManifest, signature as AuthorityAppManifestSignature | null),
      `signature corpus case '${label}': the SDK mirror signature guard must be IDENTICAL to the authority guard`,
    );
  }
});

// ---------------------------------------------------------------------------
// The semver mirror pin
// ---------------------------------------------------------------------------

test('MKT-049 drift pin: the SDK semver comparator equals the registry comparator over the ordering corpus', () => {
  const pairs: ReadonlyArray<[string, string]> = [
    ['1.0.0', '1.0.0'],
    ['1.9.0', '1.10.0'],
    ['1.10.0', '1.9.0'],
    ['1.0.0-alpha', '1.0.0'],
    ['1.0.0', '1.0.0-alpha'],
    ['1.0.0-alpha', '1.0.0-alpha.1'],
    ['1.0.0-alpha.1', '1.0.0-alpha'],
    ['1.0.0-alpha', '1.0.0-beta'],
    ['2.0.0-rc.1', '2.0.0-rc.2'],
    ['1.0.0', '2.0.0'],
    ['not-semver', '1.0.0'],
    ['1.0.0-x.7.z.92', '1.0.0-x.7.z.92'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(
      sdkCompareSemver(a, b),
      authorityCompareSemver(a, b),
      `compareSemver('${a}', '${b}') must agree with the registry comparator`,
    );
  }
});

// ---------------------------------------------------------------------------
// AC-6 — the documentation drift pin (served table === offline table)
// ---------------------------------------------------------------------------

test('MKT-049 AC-6 drift pin: the served documentation manifest-schema table equals the SDK offline table', () => {
  assert.deepEqual(DEVELOPER_PORTAL_MANIFEST_FIELD_DOCS, SDK_MANIFEST_FIELD_DOCS);
  assert.equal(SDK_MANIFEST_FIELD_DOCS.length, 19, 'the frozen manifest contract is the 19 fields');
});
