/**
 * MOS App SDK — the OFFLINE manifest + App-project validator
 * (MKT-049; spec/effective-backlog-v1.5.md "community developer workflow
 * for scaffolding, local validation, capability contracts, UI surfaces,
 * manifests, tests, signing/publishing and documentation").
 *
 * TWO layers, both standalone (NO imports from the MOS repository):
 *
 *   1. validateAppManifest — the HAND-FROZEN MIRROR of the /apps
 *      registry's publish-time guard (assertValidAppManifest,
 *      src/modules/apps/internal/store.ts). It is a mirror BY DESIGN —
 *      the registry guard runs SERVER-SIDE on the publish path; the SDK
 *      runs OFFLINE on the developer's machine — and the shared-source
 *      DRIFT TEST (tests/unit/app-sdk-drift.test.ts) proves the two
 *      agree: over the mutation corpus (a fully valid manifest +
 *      systematically-invalid manifests covering every rejection class),
 *      the mirror's verdict, problem strings and rejection class are
 *      asserted IDENTICAL to the authority guard's. The schema is never
 *      forked silently — a registry-side change without an SDK
 *      regeneration fails the drift test.
 *
 *   2. validateAppProjectFiles — the PROJECT-level validator: manifest
 *      conformance + capability-contract reference resolution
 *      (capabilities/<slug>.json files must exist and match the manifest
 *      declarations — the capability contracts), UI-surface declarations
 *      (ui/surfaces.json must correspond 1:1 to the manifest's
 *      presentation-only surfaces), test-file presence (tests/*.test.ts)
 *      and the optional signature.json attestation. Clear,
 *      file-prefixed error messages; exit-1 semantics for the CLI.
 */

import { compareSemver } from './semver.ts';
import { appManifestSignatureProblems, appManifestFingerprint } from './fingerprint.ts';
import type {
  AppDependencyDeclaration,
  AppManifest,
  AppManifestValidationResult,
  AppProjectValidationResult,
} from './types.ts';
import {
  APPS_MATERIAL_SHAPED_KEYS,
  APP_CORE_AUTHORITY_NAMESPACES,
  APP_DATA_SCOPES,
  APP_METERING_DIMENSIONS,
  APP_MUTATION_SCOPES,
  APP_RUNTIME_CLASSES,
  APP_STATE_NAMESPACE_PATTERN,
  APP_UI_SURFACE_KINDS,
} from './vocabularies.ts';

// ---------------------------------------------------------------------------
// Bounds + patterns (the single source of truth for the mirror guard —
// identical to the registry store's constants)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const CAPABILITY_NAME_PATTERN = /^.{1,64}$/;
const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,47}$/;
const UI_ROUTE_PATTERN = /^\/[a-zA-Z0-9._/-]{0,120}$/;

const MAX_CAPABILITIES = 64;
const MAX_SCOPES = 16;
const MAX_NETWORK_DESTINATIONS = 32;
const MAX_EVENT_SUBSCRIPTIONS = 32;
const MAX_UI_SURFACES = 32;
const MAX_CONFIG_FIELDS = 64;
const MAX_CREDENTIAL_NAMES = 32;
const MAX_STATE_NAMESPACES = 16;
const MAX_DEPENDENCIES = 32;
const MAX_METERING_DIMENSIONS = 8;
const MAX_SCHEMA_JSON_BYTES = 64 * 1024;
const MAX_CONFIG_JSON_BYTES = 64 * 1024;

const CERTIFICATION_SHAPED_KEYS = [
  'certificationState',
  'certification',
  'trustLevel',
  'trust',
  'certified',
] as const;

const MANIFEST_AUTHORITY_SHAPED_KEYS = [
  'publisher',
  'publisherId',
  'ownerPublisher',
  'agencyId',
  'clientId',
  'workspaceId',
  'tenantId',
  'appVersionId',
  'createFingerprint',
  'certificationState',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
] as const;

const MANIFEST_FIELDS = [
  'appKey',
  'version',
  'compatibility',
  'capabilities',
  'inputSchema',
  'outputSchema',
  'dataScopes',
  'mutationScopes',
  'networkDestinations',
  'runtimeClass',
  'eventSubscriptions',
  'uiSurfaces',
  'configSchema',
  'requiredCredentialNames',
  'stateNamespaces',
  'migrationVersion',
  'dependencies',
  'supportLevel',
  'meteringDimensions',
] as const;

const MANIFEST_SHAPE_SUMMARY =
  'app manifest failed the frozen mos-app-ecosystem-v1.5.md §Manifest shape contract';

// ---------------------------------------------------------------------------
// Shared helper mirrors (identical problem strings)
// ---------------------------------------------------------------------------

/**
 * Mirror of the registry's appPublisherIdentityString: serialize the
 * server-derived publisher identity ('dev:<userId>' | 'svc:<label>') —
 * for SDK tooling labels only (the identity itself is ALWAYS derived
 * server-side from the authenticated principal, never a request field).
 */
export function appPublisherIdentityString(identity: {
  readonly kind: 'platform_developer' | 'platform_service';
  readonly userId?: string;
  readonly label?: string;
}): string {
  return identity.kind === 'platform_developer'
    ? `dev:${identity.userId ?? ''}`
    : `svc:${identity.label ?? ''}`;
}

function semverProblems(label: string, value: string): string[] {
  return [`${label}: '${value}' is not a semver label X.Y.Z(-prerelease)`];
}

function scopeListProblems(
  label: string,
  scopes: readonly unknown[],
  vocabulary: readonly string[],
  max: number,
): string[] {
  const problems: string[] = [];
  if (scopes.length > max) {
    problems.push(`${label}: at most ${max} entries`);
  }
  const seen = new Set<string>();
  scopes.forEach((scope, index) => {
    if (typeof scope !== 'string') {
      problems.push(`${label}[${index}]: must be a string`);
      return;
    }
    if (!vocabulary.includes(scope)) {
      problems.push(
        `${label}[${index}]: '${scope}' is not in the closed ${label} vocabulary (a frozen scope vocabulary — MKT-047 AC-6)`,
      );
    }
    if (seen.has(scope)) {
      problems.push(`${label}[${index}]: duplicate scope '${scope}'`);
    }
    seen.add(scope);
  });
  return problems;
}

function dependencyProblems(dependency: unknown, index: number, ownAppKey: string): string[] {
  const problems: string[] = [];
  const label = `dependencies[${index}]`;
  if (dependency === null || typeof dependency !== 'object') {
    problems.push(`${label}: must be an object { kind, publisher, key, minVersion, maxVersion }`);
    return problems;
  }
  const declaration = dependency as Partial<AppDependencyDeclaration>;
  if (declaration.kind !== 'extension' && declaration.kind !== 'app') {
    problems.push(`${label}.kind: must be 'extension' or 'app'`);
  }
  if (declaration.kind === 'extension') {
    if (
      typeof declaration.publisher !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(declaration.publisher)
    ) {
      problems.push(`${label}.publisher: extension dependencies require the /extensions registry publisher label`);
    }
  } else if (declaration.publisher !== null && declaration.publisher !== undefined) {
    problems.push(`${label}.publisher: app dependencies carry no publisher (app keys are global lineages)`);
  }
  if (typeof declaration.key !== 'string' || !KEY_PATTERN.test(declaration.key)) {
    problems.push(`${label}.key: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter`);
  }
  if (typeof declaration.minVersion !== 'string' || !SEMVER_PATTERN.test(declaration.minVersion)) {
    problems.push(...semverProblems(`${label}.minVersion`, String(declaration.minVersion)));
  }
  if (typeof declaration.maxVersion !== 'string' || !SEMVER_PATTERN.test(declaration.maxVersion)) {
    problems.push(...semverProblems(`${label}.maxVersion`, String(declaration.maxVersion)));
  }
  if (
    typeof declaration.minVersion === 'string' &&
    typeof declaration.maxVersion === 'string' &&
    SEMVER_PATTERN.test(declaration.minVersion) &&
    SEMVER_PATTERN.test(declaration.maxVersion) &&
    compareSemver(declaration.minVersion, declaration.maxVersion) > 0
  ) {
    problems.push(
      `${label}: the declared range [${declaration.minVersion} .. ${declaration.maxVersion}] is not ordered (min must be <= max under real semver ordering)`,
    );
  }
  if (declaration.key === ownAppKey) {
    problems.push(
      `${label}: an app version cannot declare a dependency on its own app key '${ownAppKey}' (dependencies are other, already-published lineages)`,
    );
  }
  return problems;
}

/**
 * Mirror of the registry's isLegalAppStateNamespace: is this a LEGAL
 * app-owned state namespace for `appKey`? (structurally namespaced, own
 * key, not a MOS core-authority namespace).
 */
export function isLegalAppStateNamespace(appKey: string, namespace: string): {
  legal: boolean;
  reason: string | null;
} {
  if (!APP_STATE_NAMESPACE_PATTERN.test(namespace)) {
    return {
      legal: false,
      reason: `'${namespace}' is not structurally namespaced (the frozen pattern is app:<appKey>:<local>)`,
    };
  }
  const segments = namespace.split(':');
  const ownerKey = segments[1]!;
  const local = segments[2]!;
  if (ownerKey !== appKey) {
    return {
      legal: false,
      reason: `'${namespace}' claims the namespace of app key '${ownerKey}' (an app may only claim namespaces under its OWN key)`,
    };
  }
  if ((APP_CORE_AUTHORITY_NAMESPACES as readonly string[]).includes(local)) {
    return {
      legal: false,
      reason: `'${namespace}' claims the MOS core-authority namespace '${local}' (singular authority — app-owned state may not shadow a core object)`,
    };
  }
  return { legal: true, reason: null };
}

/**
 * Mirror of the registry's payloadHasNoAppsMaterialKeys: rejects
 * material-shaped keys at EVERY nesting level of an arbitrary JSON
 * value (§21 — the identical problem strings).
 */
export function payloadHasNoAppsMaterialKeys(value: unknown, path = 'manifest'): string[] {
  const problems: string[] = [];
  if (value === null || value === undefined) return problems;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      problems.push(...payloadHasNoAppsMaterialKeys(item, `${path}[${index}]`));
    });
    return problems;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((APPS_MATERIAL_SHAPED_KEYS as readonly string[]).includes(key)) {
        problems.push(
          `${path}.${key}: material-shaped keys are rejected (secrets never appear in app manifests — §21; credential references are logical names only)`,
        );
      }
      problems.push(...payloadHasNoAppsMaterialKeys(child, `${path}.${key}`));
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// THE manifest guard mirror (identical verdicts + problem strings)
// ---------------------------------------------------------------------------

/**
 * The OFFLINE mirror of the /apps registry's assertValidAppManifest
 * publish-time guard. Verdict semantics (drift-pinned to the authority):
 *   - CERTIFICATION-SHAPED keys → rejectionClass
 *     'certification-territory' (the registry answers 403 — platform
 *     territory; a developer can never self-certify);
 *   - every other violation → rejectionClass 'invalid' (the registry
 *     answers 422);
 *   - a null/non-object manifest → 'invalid' with the registry's own
 *     message.
 * Never throws — returns the verdict.
 */
export function validateAppManifest(manifest: unknown): AppManifestValidationResult {
  // NOTE: the authority guard's own first check is `manifest === null ||
  // typeof manifest !== 'object'` — a JSON ARRAY is typeof 'object' and
  // flows through the SAME problem path (per-index unknown-field
  // problems + every missing-field problem). The mirror reproduces that
  // behavior exactly (the drift corpus includes the array case).
  if (manifest === null || typeof manifest !== 'object') {
    return {
      valid: false,
      problems: ['app manifest must be an object'],
      rejectionClass: 'invalid',
      summary: 'app manifest must be an object',
    };
  }

  const rawKeys = Object.keys(manifest as Record<string, unknown>);

  // CERTIFICATION TERRITORY FIRST: any caller attempt to supply
  // certification/trust state is a 403-class rejection — never a silent
  // default (the registry throws ForbiddenError immediately).
  for (const key of rawKeys) {
    if ((CERTIFICATION_SHAPED_KEYS as readonly string[]).includes(key)) {
      const message = `certification state is platform territory (the registry starts every developer publish at UNVERIFIED — a developer can never self-certify): the manifest input must not carry '${key}'`;
      return {
        valid: false,
        problems: [message],
        rejectionClass: 'certification-territory',
        summary: message,
      };
    }
  }

  const problems: string[] = [];

  // Authority-shaped keys (server-derived identity/provenance/tenant).
  for (const key of rawKeys) {
    if ((MANIFEST_AUTHORITY_SHAPED_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `${key}: forbidden authority field; this value is derived server-side and must not be supplied`,
      );
    }
  }
  // Strict shape: unknown keys are rejected.
  for (const key of rawKeys) {
    if (!(MANIFEST_FIELDS as readonly string[]).includes(key)) {
      problems.push(`${key}: unknown field`);
    }
  }

  const view = manifest as Partial<AppManifest> & Record<string, unknown>;

  if (typeof view.appKey !== 'string' || !KEY_PATTERN.test(view.appKey)) {
    problems.push('appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter');
  }
  if (typeof view.version !== 'string' || !SEMVER_PATTERN.test(view.version)) {
    problems.push(...semverProblems('version', String(view.version)));
  }

  if (
    view.compatibility === null ||
    typeof view.compatibility !== 'object'
  ) {
    problems.push('compatibility: { minPlatform, maxPlatform } are required semver bounds');
  } else {
    const { minPlatform, maxPlatform } = view.compatibility;
    if (typeof minPlatform !== 'string' || !SEMVER_PATTERN.test(minPlatform)) {
      problems.push(...semverProblems('compatibility.minPlatform', String(minPlatform)));
    }
    if (typeof maxPlatform !== 'string' || !SEMVER_PATTERN.test(maxPlatform)) {
      problems.push(...semverProblems('compatibility.maxPlatform', String(maxPlatform)));
    }
    if (
      typeof minPlatform === 'string' &&
      typeof maxPlatform === 'string' &&
      SEMVER_PATTERN.test(minPlatform) &&
      SEMVER_PATTERN.test(maxPlatform) &&
      compareSemver(minPlatform, maxPlatform) > 0
    ) {
      problems.push(
        `compatibility: the range [${minPlatform} .. ${maxPlatform}] is not ordered (min must be <= max under real semver ordering)`,
      );
    }
  }

  if (!Array.isArray(view.capabilities) || view.capabilities.length === 0) {
    problems.push('capabilities: a manifest must declare at least one capability (mos-app-ecosystem-v1.5.md §Manifest)');
  } else if (view.capabilities.length > MAX_CAPABILITIES) {
    problems.push(`capabilities: at most ${MAX_CAPABILITIES} capabilities per manifest`);
  } else {
    const names = new Set<string>();
    view.capabilities.forEach((capability, index) => {
      const label = `capabilities[${index}]`;
      if (capability === null || typeof capability !== 'object') {
        problems.push(`${label}: must be an object { name, version }`);
        return;
      }
      const declaration = capability as Partial<AppCapabilityMirror>;
      if (
        Object.keys(declaration).length !== 2 ||
        declaration.name === undefined ||
        declaration.version === undefined
      ) {
        problems.push(`${label}: must declare exactly { name, version }`);
      }
      if (typeof declaration.name !== 'string' || !CAPABILITY_NAME_PATTERN.test(declaration.name)) {
        problems.push(`${label}.name: must be 1-64 characters`);
      } else if (names.has(declaration.name)) {
        problems.push(`${label}: duplicate capability name '${declaration.name}' (one name = one callable unit)`);
      } else {
        names.add(declaration.name);
      }
      if (typeof declaration.version !== 'string' || !SEMVER_PATTERN.test(declaration.version)) {
        problems.push(...semverProblems(`${label}.version`, String(declaration.version)));
      }
    });
  }

  for (const [label, schema] of [
    ['inputSchema', view.inputSchema],
    ['outputSchema', view.outputSchema],
  ] as const) {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      problems.push(`${label}: must be a JSON object (the capability input/output schema)`);
    } else {
      if (Object.keys(schema).length > MAX_CONFIG_FIELDS) {
        problems.push(`${label}: at most ${MAX_CONFIG_FIELDS} keys`);
      }
      if (Buffer.byteLength(JSON.stringify(schema), 'utf8') > MAX_SCHEMA_JSON_BYTES) {
        problems.push(`${label}: must serialize to at most ${MAX_SCHEMA_JSON_BYTES} bytes`);
      }
      problems.push(...payloadHasNoAppsMaterialKeys(schema, label));
    }
  }

  if (!Array.isArray(view.dataScopes)) {
    problems.push('dataScopes: must be an array of the closed data-scope vocabulary');
  } else {
    problems.push(
      ...scopeListProblems('dataScopes', view.dataScopes, APP_DATA_SCOPES as readonly string[], MAX_SCOPES),
    );
  }
  if (!Array.isArray(view.mutationScopes)) {
    problems.push('mutationScopes: must be an array of the closed mutation-scope vocabulary');
  } else {
    problems.push(
      ...scopeListProblems(
        'mutationScopes',
        view.mutationScopes,
        APP_MUTATION_SCOPES as readonly string[],
        MAX_SCOPES,
      ),
    );
  }

  if (!Array.isArray(view.networkDestinations)) {
    problems.push('networkDestinations: must be an array of { host, protocol, port, reason } declarations');
  } else if (view.networkDestinations.length > MAX_NETWORK_DESTINATIONS) {
    problems.push(`networkDestinations: at most ${MAX_NETWORK_DESTINATIONS} destinations`);
  } else {
    view.networkDestinations.forEach((destination, index) => {
      const label = `networkDestinations[${index}]`;
      if (destination === null || typeof destination !== 'object') {
        problems.push(`${label}: must be an object { host, protocol, port, reason }`);
        return;
      }
      const declaration = destination as Partial<AppNetworkDestinationMirror>;
      if (Object.keys(declaration).length !== 4) {
        problems.push(`${label}: must declare exactly { host, protocol, port, reason }`);
      }
      if (typeof declaration.host !== 'string' || declaration.host.length < 1 || declaration.host.length > 253) {
        problems.push(`${label}.host: must be 1-253 characters`);
      }
      if (typeof declaration.protocol !== 'string' || declaration.protocol.length < 1 || declaration.protocol.length > 16) {
        problems.push(`${label}.protocol: must be 1-16 characters`);
      }
      if (
        typeof declaration.port !== 'number' ||
        !Number.isSafeInteger(declaration.port) ||
        declaration.port < 1 ||
        declaration.port > 65535
      ) {
        problems.push(`${label}.port: must be an integer 1-65535`);
      }
      if (typeof declaration.reason !== 'string' || declaration.reason.length < 1 || declaration.reason.length > 256) {
        problems.push(`${label}.reason: must be 1-256 characters`);
      }
    });
  }

  if (typeof view.runtimeClass !== 'string' || !(APP_RUNTIME_CLASSES as readonly string[]).includes(view.runtimeClass)) {
    problems.push(
      `runtimeClass: '${String(view.runtimeClass)}' is not in the closed runtime-class vocabulary (the /executions set)`,
    );
  }

  if (!Array.isArray(view.eventSubscriptions)) {
    problems.push('eventSubscriptions: must be an array of bounded unique event labels');
  } else if (view.eventSubscriptions.length > MAX_EVENT_SUBSCRIPTIONS) {
    problems.push(`eventSubscriptions: at most ${MAX_EVENT_SUBSCRIPTIONS} subscriptions`);
  } else {
    const seen = new Set<string>();
    view.eventSubscriptions.forEach((label, index) => {
      if (typeof label !== 'string' || label.length < 1 || label.length > 64) {
        problems.push(`eventSubscriptions[${index}]: must be 1-64 characters`);
      } else if (seen.has(label)) {
        problems.push(`eventSubscriptions[${index}]: duplicate event label '${label}'`);
      } else {
        seen.add(label);
      }
    });
  }

  if (!Array.isArray(view.uiSurfaces)) {
    problems.push('uiSurfaces: must be an array of { surface, route } declarations');
  } else if (view.uiSurfaces.length > MAX_UI_SURFACES) {
    problems.push(`uiSurfaces: at most ${MAX_UI_SURFACES} surfaces`);
  } else {
    view.uiSurfaces.forEach((surface, index) => {
      const label = `uiSurfaces[${index}]`;
      if (surface === null || typeof surface !== 'object') {
        problems.push(`${label}: must be an object { surface, route }`);
        return;
      }
      const declaration = surface as Partial<AppUiSurfaceMirror>;
      if (Object.keys(declaration).length !== 2) {
        problems.push(`${label}: must declare exactly { surface, route }`);
      }
      if (
        typeof declaration.surface !== 'string' ||
        !(APP_UI_SURFACE_KINDS as readonly string[]).includes(declaration.surface)
      ) {
        problems.push(
          `${label}.surface: '${String(declaration.surface)}' is not in the closed UI-surface-kind vocabulary (command-center-card, client-room-panel, workspace-tab, report-page, editor-pane, action-menu)`,
        );
      }
      if (typeof declaration.route !== 'string' || !UI_ROUTE_PATTERN.test(declaration.route)) {
        problems.push(`${label}.route: must be a bounded route path (max 120 chars, starting with '/')`);
      }
    });
  }

  if (view.configSchema === null || typeof view.configSchema !== 'object' || Array.isArray(view.configSchema)) {
    problems.push('configSchema: must be a JSON object of field contracts');
  } else {
    const entries = Object.entries(view.configSchema as Record<string, unknown>);
    if (entries.length > MAX_CONFIG_FIELDS) {
      problems.push(`configSchema: at most ${MAX_CONFIG_FIELDS} fields`);
    }
    if (
      Buffer.byteLength(JSON.stringify(view.configSchema), 'utf8') > MAX_CONFIG_JSON_BYTES
    ) {
      problems.push(`configSchema: must serialize to at most ${MAX_CONFIG_JSON_BYTES} bytes`);
    }
    for (const [fieldKey, fieldValue] of entries) {
      const label = `configSchema.${fieldKey}`;
      if (fieldKey.length < 1 || fieldKey.length > 64) {
        problems.push(`${label}: field names must be 1-64 characters`);
      }
      if (fieldValue === null || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
        problems.push(`${label}: must be an object { type, required, description, pattern }`);
        continue;
      }
      const contract = fieldValue as Partial<AppConfigFieldMirror>;
      if (Object.keys(contract).length !== 4) {
        problems.push(`${label}: must declare exactly { type, required, description, pattern }`);
      }
      if (
        typeof contract.type !== 'string' ||
        !['string', 'number', 'boolean', 'object'].includes(contract.type)
      ) {
        problems.push(`${label}.type: must be one of string | number | boolean | object`);
      }
      if (typeof contract.required !== 'boolean') {
        problems.push(`${label}.required: must be a boolean`);
      }
      if (
        typeof contract.description !== 'string' ||
        contract.description.length < 1 ||
        contract.description.length > 512
      ) {
        problems.push(`${label}.description: must be 1-512 characters`);
      }
      if (contract.pattern !== null && contract.pattern !== undefined) {
        if (typeof contract.pattern !== 'string' || contract.pattern.length < 1 || contract.pattern.length > 256) {
          problems.push(`${label}.pattern: must be null or 1-256 characters`);
        }
      }
    }
    problems.push(...payloadHasNoAppsMaterialKeys(view.configSchema, 'configSchema'));
  }

  if (!Array.isArray(view.requiredCredentialNames)) {
    problems.push('requiredCredentialNames: must be an array of LOGICAL credential name labels');
  } else if (view.requiredCredentialNames.length > MAX_CREDENTIAL_NAMES) {
    problems.push(`requiredCredentialNames: at most ${MAX_CREDENTIAL_NAMES} names`);
  } else {
    const seen = new Set<string>();
    view.requiredCredentialNames.forEach((name, index) => {
      if (typeof name !== 'string' || !CREDENTIAL_NAME_PATTERN.test(name)) {
        problems.push(
          `requiredCredentialNames[${index}]: '${String(name)}' is not a LOGICAL name (uppercase snake case) — credential references are required BY NAME ONLY, never values`,
        );
      } else if (seen.has(name)) {
        problems.push(`requiredCredentialNames[${index}]: duplicate logical name '${name}'`);
      } else {
        seen.add(name);
      }
    });
  }

  if (!Array.isArray(view.stateNamespaces)) {
    problems.push('stateNamespaces: must be an array of app-owned state namespaces');
  } else if (view.stateNamespaces.length > MAX_STATE_NAMESPACES) {
    problems.push(`stateNamespaces: at most ${MAX_STATE_NAMESPACES} namespaces`);
  } else {
    const seen = new Set<string>();
    const appKey = typeof view.appKey === 'string' ? view.appKey : '';
    view.stateNamespaces.forEach((namespace, index) => {
      if (typeof namespace !== 'string') {
        problems.push(`stateNamespaces[${index}]: must be a string`);
        return;
      }
      const verdict = isLegalAppStateNamespace(appKey, namespace);
      if (!verdict.legal) {
        problems.push(`stateNamespaces[${index}]: ${verdict.reason}`);
      } else if (seen.has(namespace)) {
        problems.push(`stateNamespaces[${index}]: duplicate namespace '${namespace}'`);
      } else {
        seen.add(namespace);
      }
    });
  }

  if (
    typeof view.migrationVersion !== 'number' ||
    !Number.isSafeInteger(view.migrationVersion) ||
    view.migrationVersion < 0
  ) {
    problems.push('migrationVersion: must be a non-negative integer (the app storage migration version)');
  }

  if (!Array.isArray(view.dependencies)) {
    problems.push('dependencies: must be an array of { kind, publisher, key, minVersion, maxVersion } declarations');
  } else if (view.dependencies.length > MAX_DEPENDENCIES) {
    problems.push(`dependencies: at most ${MAX_DEPENDENCIES} dependencies`);
  } else {
    const seen = new Set<string>();
    const appKey = typeof view.appKey === 'string' ? view.appKey : '';
    view.dependencies.forEach((dependency, index) => {
      problems.push(...dependencyProblems(dependency, index, appKey));
      const declaration = dependency as Partial<AppDependencyDeclaration>;
      const ref =
        declaration.kind === 'app'
          ? `app:${String(declaration.key)}`
          : `extension:${String(declaration.publisher)}/${String(declaration.key)}`;
      if (seen.has(ref)) {
        problems.push(`dependencies[${index}]: duplicate dependency '${ref}'`);
      } else {
        seen.add(ref);
      }
    });
  }

  if (typeof view.supportLevel !== 'string' || view.supportLevel.length < 1 || view.supportLevel.length > 64) {
    problems.push('supportLevel: must be 1-64 characters (the declared support level)');
  }

  if (!Array.isArray(view.meteringDimensions)) {
    problems.push('meteringDimensions: must be an array of the closed metering-dimension vocabulary');
  } else {
    problems.push(
      ...scopeListProblems(
        'meteringDimensions',
        view.meteringDimensions,
        APP_METERING_DIMENSIONS as readonly string[],
        MAX_METERING_DIMENSIONS,
      ),
    );
  }

  // The full-manifest §21 material-key backstop (every field, every
  // nesting level).
  problems.push(...payloadHasNoAppsMaterialKeys(manifest, 'manifest'));

  if (problems.length > 0) {
    return {
      valid: false,
      problems,
      rejectionClass: 'invalid',
      summary: MANIFEST_SHAPE_SUMMARY,
    };
  }
  return { valid: true, problems: [], rejectionClass: null, summary: null };
}

// Local structural view types (the authority guard casts the same way).
interface AppCapabilityMirror {
  readonly name?: unknown;
  readonly version?: unknown;
}
interface AppNetworkDestinationMirror {
  readonly host?: unknown;
  readonly protocol?: unknown;
  readonly port?: unknown;
  readonly reason?: unknown;
}
interface AppUiSurfaceMirror {
  readonly surface?: unknown;
  readonly route?: unknown;
}
interface AppConfigFieldMirror {
  readonly type?: unknown;
  readonly required?: unknown;
  readonly description?: unknown;
  readonly pattern?: unknown;
}

// ---------------------------------------------------------------------------
// The PROJECT validator (structure + cross-references + tests + signature)
// ---------------------------------------------------------------------------

/** The expected file layout of a scaffolded/existing App project. */
export const APP_PROJECT_FILES = {
  manifest: 'mos-app.json',
  signature: 'signature.json',
  uiSurfaces: 'ui/surfaces.json',
  testsGlob: 'tests/*.test.ts',
} as const;

/** Deterministic capability-contract file name for a capability name. */
export function capabilityContractFileName(capabilityName: string): string {
  const slug = capabilityName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `capabilities/${slug.length > 0 ? slug : 'capability'}.json`;
}

interface ParsedJsonResult {
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: string | null;
}

function parseJson(text: string): ParsedJsonResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown, error: null };
  } catch (error) {
    return { ok: false, value: null, error: String(error) };
  }
}

interface UiSurfaceEntryMirror {
  readonly surface?: unknown;
  readonly route?: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
}

/**
 * Validate an App PROJECT offline: the file map (relative path →
 * content) of a scaffolded or existing project directory. Checks:
 *   - mos-app.json: parse + the frozen manifest guard (the mirror);
 *   - capability-contract reference resolution: every manifest
 *     capability has a capabilities/<slug>.json file declaring the SAME
 *     name + version (the capability contracts), and no orphan files;
 *   - UI-surface declarations: ui/surfaces.json entries correspond 1:1
 *     to the manifest's presentation-only surfaces (closed vocabulary);
 *   - test-file presence: at least one tests/*.test.ts;
 *   - signature.json (optional): the hash attestation must verify
 *     against the canonical manifest fingerprint.
 * Deterministic problem order; clear file-prefixed messages.
 */
export function validateAppProjectFiles(
  files: Readonly<Record<string, string>>,
): AppProjectValidationResult {
  const problems: string[] = [];

  // --- the manifest ---------------------------------------------------------
  const manifestText = files[APP_PROJECT_FILES.manifest];
  if (manifestText === undefined) {
    problems.push(`${APP_PROJECT_FILES.manifest}: missing — the App manifest is required`);
    return {
      valid: false,
      problems,
      manifest: {
        valid: false,
        problems: [`${APP_PROJECT_FILES.manifest}: missing — the App manifest is required`],
        rejectionClass: 'invalid',
        summary: `${APP_PROJECT_FILES.manifest}: missing — the App manifest is required`,
      },
    };
  }
  const parsed = parseJson(manifestText);
  if (!parsed.ok) {
    const message = `${APP_PROJECT_FILES.manifest}: not valid JSON (${parsed.error})`;
    return {
      valid: false,
      problems: [message, ...problems],
      manifest: {
        valid: false,
        problems: [message],
        rejectionClass: 'invalid',
        summary: message,
      },
    };
  }
  const manifestVerdict = validateAppManifest(parsed.value);
  for (const problem of manifestVerdict.problems) {
    problems.push(`${APP_PROJECT_FILES.manifest}: ${problem}`);
  }
  // The registry store's own manifest byte bound (a store-level check
  // the publish path enforces before any write).
  if (Buffer.byteLength(manifestText, 'utf8') > 512 * 1024) {
    problems.push(`${APP_PROJECT_FILES.manifest}: must be at most 524288 bytes (the registry store bound)`);
  }

  const manifest = parsed.value as Partial<AppManifest> & Record<string, unknown>;
  const manifestIsObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest);
  const capabilities: ReadonlyArray<{ name?: unknown; version?: unknown }> = manifestIsObject && Array.isArray(manifest.capabilities)
    ? manifest.capabilities
    : [];
  const uiSurfaces: ReadonlyArray<{ surface?: unknown; route?: unknown }> = manifestIsObject && Array.isArray(manifest.uiSurfaces)
    ? manifest.uiSurfaces
    : [];

  // --- capability-contract reference resolution ------------------------------
  const capabilityFiles: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith('capabilities/') && path.endsWith('.json')) {
      capabilityFiles[path] = content;
    }
  }
  const declaredCapabilityFiles = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability?.name !== 'string') continue;
    const expectedFile = capabilityContractFileName(capability.name);
    declaredCapabilityFiles.add(expectedFile);
    const contractText = capabilityFiles[expectedFile];
    if (contractText === undefined) {
      problems.push(
        `${expectedFile}: missing — the manifest declares capability '${String(capability.name)}'@'${String(capability.version)}'; every declared capability needs a contract file`,
      );
      continue;
    }
    const contract = parseJson(contractText);
    if (!contract.ok) {
      problems.push(`${expectedFile}: not valid JSON (${contract.error})`);
      continue;
    }
    const value = contract.value as Record<string, unknown> | null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`${expectedFile}: must be an object { name, version, description, inputSchema, outputSchema }`);
      continue;
    }
    const keys = Object.keys(value);
    const expectedKeys = ['name', 'version', 'description', 'inputSchema', 'outputSchema'];
    if (keys.length !== expectedKeys.length || !expectedKeys.every((key) => keys.includes(key))) {
      problems.push(`${expectedFile}: must declare exactly { name, version, description, inputSchema, outputSchema }`);
    }
    if (value['name'] !== capability.name || value['version'] !== capability.version) {
      problems.push(
        `${expectedFile}: declares capability '${String(value['name'])}'@'${String(value['version'])}' but the manifest declares '${String(capability.name)}'@'${String(capability.version)}' (the manifest is the authority)`,
      );
    }
    if (typeof value['description'] !== 'string' || value['description'].length < 1 || value['description'].length > 512) {
      problems.push(`${expectedFile}: description must be 1-512 characters`);
    }
    for (const schemaKey of ['inputSchema', 'outputSchema'] as const) {
      const schema = value[schemaKey];
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        problems.push(`${expectedFile}: ${schemaKey} must be a JSON object`);
      }
    }
  }
  for (const path of Object.keys(capabilityFiles).sort()) {
    if (!declaredCapabilityFiles.has(path)) {
      problems.push(
        `${path}: no matching manifest capability declaration (declare the capability in ${APP_PROJECT_FILES.manifest} or remove the file)`,
      );
    }
  }

  // --- UI-surface declarations (presentation only) ---------------------------
  if (uiSurfaces.length > 0) {
    const uiText = files[APP_PROJECT_FILES.uiSurfaces];
    if (uiText === undefined) {
      problems.push(
        `${APP_PROJECT_FILES.uiSurfaces}: missing — the manifest declares UI surfaces, so the presentation declarations file is required (UI is presentation only; mutations go through server capabilities)`,
      );
    } else {
      const uiParsed = parseJson(uiText);
      if (!uiParsed.ok) {
        problems.push(`${APP_PROJECT_FILES.uiSurfaces}: not valid JSON (${uiParsed.error})`);
      } else {
        const value = uiParsed.value as Record<string, unknown> | null;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          problems.push(`${APP_PROJECT_FILES.uiSurfaces}: must be an object { surfaces: [...] }`);
        } else {
          const entries = value['surfaces'];
          if (!Array.isArray(entries)) {
            problems.push(`${APP_PROJECT_FILES.uiSurfaces}: surfaces must be an array of { surface, route, title, description } declarations`);
          } else {
            const manifestKeys = new Set(
              uiSurfaces.map((surface) => `${String(surface.surface)}:${String(surface.route)}`),
            );
            const declaredKeys = new Set<string>();
            entries.forEach((entry, index) => {
              const label = `${APP_PROJECT_FILES.uiSurfaces}: entry ${index}`;
              const declaration = (entry === null || typeof entry !== 'object' || Array.isArray(entry)
                ? {}
                : entry) as UiSurfaceEntryMirror;
              if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
                problems.push(`${label}: must be an object { surface, route, title, description }`);
              } else if (
                Object.keys(declaration).length !== 4 ||
                declaration.surface === undefined ||
                declaration.route === undefined ||
                declaration.title === undefined ||
                declaration.description === undefined
              ) {
                problems.push(`${label}: must declare exactly { surface, route, title, description }`);
              }
              if (
                typeof declaration.surface !== 'string' ||
                !(APP_UI_SURFACE_KINDS as readonly string[]).includes(declaration.surface)
              ) {
                problems.push(
                  `${label}: surface '${String(declaration.surface)}' is not in the closed UI-surface-kind vocabulary`,
                );
              }
              const entryKey = `${String(declaration.surface)}:${String(declaration.route)}`;
              const matched = manifestKeys.has(entryKey);
              if (
                typeof declaration.surface === 'string' &&
                (APP_UI_SURFACE_KINDS as readonly string[]).includes(declaration.surface) &&
                !matched
              ) {
                problems.push(
                  `${label} (surface '${String(declaration.surface)}', route '${String(declaration.route)}') has no matching ${APP_PROJECT_FILES.manifest} uiSurfaces declaration`,
                );
              } else {
                declaredKeys.add(entryKey);
              }
            });
            for (const surface of uiSurfaces) {
              const key = `${String(surface.surface)}:${String(surface.route)}`;
              if (!declaredKeys.has(key)) {
                problems.push(
                  `${APP_PROJECT_FILES.uiSurfaces}: missing the presentation declaration for manifest surface '${String(surface.surface)}' at route '${String(surface.route)}'`,
                );
              }
            }
          }
        }
      }
    }
  }

  // --- test-file presence -----------------------------------------------------
  const testFiles = Object.keys(files).filter(
    (path) => path.startsWith('tests/') && path.endsWith('.test.ts'),
  );
  if (testFiles.length === 0) {
    problems.push(
      'tests: no test file found — at least one tests/*.test.ts is required (the developer model tests Apps before publishing)',
    );
  }

  // --- the optional signature (hash attestation) ------------------------------
  const signatureText = files[APP_PROJECT_FILES.signature];
  if (signatureText !== undefined) {
    const signatureParsed = parseJson(signatureText);
    if (!signatureParsed.ok) {
      problems.push(`${APP_PROJECT_FILES.signature}: not valid JSON (${signatureParsed.error})`);
    } else {
      const signatureProblems = appManifestSignatureProblems(parsed.value, signatureParsed.value);
      for (const problem of signatureProblems) {
        problems.push(`${APP_PROJECT_FILES.signature}: ${problem}`);
      }
      // Helpful integrity context when the attestation mismatches.
      if (signatureProblems.length > 0) {
        const digest = appManifestFingerprint(parsed.value);
        problems.push(
          `${APP_PROJECT_FILES.signature}: the canonical fingerprint of the current ${APP_PROJECT_FILES.manifest} is '${digest}' (re-run: node tools/app-sdk/cli.ts sign <project-dir>)`,
        );
      }
    }
  }

  return {
    valid: problems.length === 0,
    problems,
    manifest: manifestVerdict,
  };
}
