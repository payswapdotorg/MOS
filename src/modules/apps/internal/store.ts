/**
 * /apps persistence + the frozen input guards (MKT-047, APP-001 — the App
 * registry authority for manifests).
 *
 * DB backstops (migration 037 + implementation-contract §21/§25):
 *   - the (app_key, version) UNIQUE fence: a published App Version is
 *     IMMUTABLE — re-publishing converges to a constraint violation
 *     (ConflictError upstream, never a silent rewrite) and a new version
 *     is a new row (mos-app-ecosystem-v1.5.md "Upgrade and rollback";
 *     architecture-lock v1.5 #11);
 *   - the apps ownership rows: one row per app key, the first publisher
 *     owns the lineage; the publisher-consistency trigger fences every
 *     version row against the owning publisher;
 *   - the registry rows themselves reject UPDATE and DELETE outright
 *     (triggers — including certification_state: trust transitions are
 *     the MKT-050 platform surface, never a manifest rewrite);
 *   - the app_dependencies rows are APPEND-ONLY with the dependency
 *     validation backstop trigger (extension target must have a
 *     published version in range in the migration-028 registry;
 *     app target must exist with a version in range; no
 *     self-dependency);
 *   - every jsonb payload is CHECKed against material-shaped keys at
 *     every nesting level, and there is NO column capable of holding
 *     secret material or a secret handle anywhere in this module's
 *     tables.
 *
 * The §21 material-key backstop and the authority-shaped-key rejection
 * contract (MKT-047 AC-3: "No secret material, tenant identity,
 * provenance or lifecycle authority is supplied by the caller in the
 * manifest") run HERE — the module boundary is the single semantic
 * enforcement point behind every surface (route DTOs are surface-level
 * input hygiene only, the extension-portal posture):
 *   - CERTIFICATION-SHAPED keys (certificationState, certification,
 *     trustLevel, trust) are rejected with 403 ForbiddenError —
 *     certification is PLATFORM territory and the registry starts every
 *     developer publish at UNVERIFIED (AC-5: a developer can never
 *     self-certify);
 *   - PUBLISHER-SHAPED keys (publisher, publisherId, ownerPublisher)
 *     are rejected with 422 — the publisher identity is SERVER-DERIVED
 *     from the authenticated platform developer (AC-5);
 *   - TENANT-IDENTITY keys (agencyId, clientId, workspaceId, tenantId)
 *     and PROVENANCE keys (createdBy, createdAt, updatedAt, provenance,
 *     actor, correlationId, causationId, recordedAt) are rejected with
 *     422 — an App Version is global catalog state with server-derived
 *     provenance only;
 *   - MATERIAL-SHAPED keys are rejected at every nesting level with 422
 *     (§21/CRED-001 — credential references are required BY LOGICAL NAME
 *     ONLY; values are never acceptable anywhere in a manifest).
 */

import { createHash } from 'node:crypto';
import { ForbiddenError, InvalidRequestError } from '../../../platform/errors/errors.ts';
import type { Clock } from '../../../platform/clock/clock.ts';
import type { Db, DbRow } from '../../../platform/db/contract.ts';
import type { IdGenerator } from '../../../platform/ids/ids.ts';
import type {
  AppCapabilityDeclaration,
  AppConfigFieldContract,
  AppDataScope,
  AppDependencyDeclaration,
  AppManifest,
  AppMeteringDimension,
  AppMutationScope,
  AppNetworkDestination,
  AppRuntimeClass,
  AppUiSurfaceDeclaration,
  AppVersionRecord,
} from '../public.ts';
import {
  APP_CORE_AUTHORITY_NAMESPACES,
  APP_DATA_SCOPES,
  APP_METERING_DIMENSIONS,
  APP_MUTATION_SCOPES,
  APP_RUNTIME_CLASSES,
  APP_STATE_NAMESPACE_PATTERN,
  APP_UI_SURFACE_KINDS,
} from '../public.ts';

// ---------------------------------------------------------------------------
// Bounds (single source of truth for every guard below)
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const PUBLISHER_IDENTITY_PATTERN = /^(dev|svc):[a-z0-9][a-z0-9._-]{0,63}$/;
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
const MAX_MANIFEST_JSON_BYTES = 512 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Material-shaped keys that can never appear in ANY app payload (§21 —
 * the migration 025/028/030 set plus the credential-value aliases; the
 * migration 037 CHECK functions enforce the identical set).
 */
export const APPS_MATERIAL_SHAPED_KEYS = [
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
  'credentialValue',
  'secretValue',
] as const;

/**
 * CERTIFICATION-SHAPED keys: caller-supplied certification is PLATFORM
 * TERRITORY — rejected 403 (the registry starts every developer publish
 * at UNVERIFIED; a developer can never self-certify, AC-5).
 */
const CERTIFICATION_SHAPED_KEYS = [
  'certificationState',
  'certification',
  'trustLevel',
  'trust',
  'certified',
] as const;

/**
 * AUTHORITY-SHAPED keys (server-derived identity/provenance/tenant
 * fields): rejected 422 — the publisher identity is SERVER-DERIVED and
 * no tenant identity or provenance may be supplied by the caller (AC-3).
 */
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

/** The frozen manifest field set (strict shape — unknown keys rejected). */
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

// ---------------------------------------------------------------------------
// REAL semantic-version ordering (never text ordering)
// ---------------------------------------------------------------------------

/**
 * REAL semantic-version comparison for X.Y.Z(-prerelease) labels:
 * numeric major/minor/patch ordering (1.10.0 > 1.9.0 — text ordering
 * would get this wrong), prerelease labels sort BELOW their release
 * (1.0.0-alpha < 1.0.0 < 1.0.1), dot-separated prerelease identifiers
 * compare numerically when both numeric, lexically otherwise, shorter
 * identifier lists sort lower. Non-semver labels compare 0 (guards
 * reject them before ordering matters). Pure; mirrors the
 * migration-037 apps_semver_cmp function exactly.
 */
export function compareSemver(a: string, b: string): number {
  if (a === b) return 0;
  const coreA = a.includes('-') ? a.slice(0, a.indexOf('-')) : a;
  const coreB = b.includes('-') ? b.slice(0, b.indexOf('-')) : b;
  const partsA = coreA.split('.').map((part) => Number.parseInt(part, 10));
  const partsB = coreB.split('.').map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < 3; index += 1) {
    const numA = partsA[index] ?? 0;
    const numB = partsB[index] ?? 0;
    if (!Number.isFinite(numA) || !Number.isFinite(numB)) return 0;
    if (numA !== numB) return numA < numB ? -1 : 1;
  }
  const preA = a.includes('-') ? a.slice(a.indexOf('-') + 1) : null;
  const preB = b.includes('-') ? b.slice(b.indexOf('-') + 1) : null;
  if (preA === null && preB === null) return 0;
  if (preA === null) return 1; // release sorts above prereleases
  if (preB === null) return -1;
  const identsA = preA.split('.');
  const identsB = preB.split('.');
  const length = Math.min(identsA.length, identsB.length);
  for (let index = 0; index < length; index += 1) {
    const identA = identsA[index]!;
    const identB = identsB[index]!;
    if (identA === identB) continue;
    const bothNumeric = /^[0-9]+$/.test(identA) && /^[0-9]+$/.test(identB);
    if (bothNumeric) {
      const numA = Number.parseInt(identA, 10);
      const numB = Number.parseInt(identB, 10);
      return numA < numB ? -1 : 1;
    }
    return identA < identB ? -1 : 1;
  }
  if (identsA.length !== identsB.length) {
    return identsA.length < identsB.length ? -1 : 1;
  }
  return 0;
}

/**
 * Pure compatibility-range matcher: is `version` inside the INCLUSIVE
 * [min, max] range under REAL semver ordering? (The bounds are inclusive
 * exactly like the platform compatibility ranges.)
 */
export function appVersionInRange(version: string, min: string, max: string): boolean {
  return compareSemver(version, min) >= 0 && compareSemver(version, max) <= 0;
}

// ---------------------------------------------------------------------------
// The app-owned state-namespace contract (bounded app state — AC-6)
// ---------------------------------------------------------------------------

/**
 * Pure predicate: is this a LEGAL app-owned state namespace for `appKey`?
 * The namespace must be structurally namespaced (app:<appKey>:<local>),
 * must claim the app's OWN key (never another app's namespace), and the
 * local segment must not be a MOS CORE-AUTHORITY namespace (the
 * singular authorities denylist — an app-owned spreadsheet namespace is
 * valid; an app-owned competing Workflow state machine is not).
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

// ---------------------------------------------------------------------------
// Generic payload walking (the module-side §21 backstop)
// ---------------------------------------------------------------------------

/**
 * Rejects material-shaped keys at EVERY nesting level of an arbitrary
 * JSON value. Pure; used by the manifest guard below (the database
 * CHECK functions of migration 037 enforce the identical set).
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
// The manifest guard (the frozen mos-app-ecosystem-v1.5.md §Manifest shape)
// ---------------------------------------------------------------------------

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
  // Self-dependency: an App Version can never depend on its own app key
  // (the dependency DAG is built from already-published lineages).
  if (declaration.key === ownAppKey) {
    problems.push(
      `${label}: an app version cannot declare a dependency on its own app key '${ownAppKey}' (dependencies are other, already-published lineages)`,
    );
  }
  return problems;
}

/**
 * THE manifest shape guard (mos-app-ecosystem-v1.5.md "Manifest" — every
 * listed field present and valid; MKT-047 AC-2/AC-3/AC-6). A manifest
 * that fails shape — unknown field, closed-vocabulary violation,
 * unnamespaced or core-authority-claiming state namespace, unordered
 * compatibility/dependency range, self-dependency, material-shaped key,
 * authority-shaped key — is REJECTED before any state is touched:
 *   - certification-shaped keys → ForbiddenError (403, platform
 *     territory: the registry starts every developer publish at
 *     UNVERIFIED — a developer can never self-certify);
 *   - every other authority-shaped key → InvalidRequestError (422 with
 *     the dedicated authority-field message);
 *   - material-shaped keys anywhere → InvalidRequestError (422).
 * Pure.
 */
export function assertValidAppManifest(manifest: AppManifest): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw new InvalidRequestError('app manifest must be an object');
  }

  // CERTIFICATION TERRITORY FIRST (AC-5): any caller attempt to supply
  // certification/trust state is a 403 — never a silent default.
  const rawKeys = Object.keys(manifest as unknown as Record<string, unknown>);
  for (const key of rawKeys) {
    if ((CERTIFICATION_SHAPED_KEYS as readonly string[]).includes(key)) {
      throw new ForbiddenError(
        `certification state is platform territory (the registry starts every developer publish at UNVERIFIED — a developer can never self-certify): the manifest input must not carry '${key}'`,
      );
    }
  }

  const problems: string[] = [];

  // Authority-shaped keys (server-derived identity/provenance/tenant):
  // the dedicated rejection contract (AC-3).
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

  if (typeof manifest.appKey !== 'string' || !KEY_PATTERN.test(manifest.appKey)) {
    problems.push('appKey: must be 2-63 chars, lowercase letters/digits/dashes, starting with a letter');
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    problems.push(...semverProblems('version', String(manifest.version)));
  }

  if (
    manifest.compatibility === null ||
    typeof manifest.compatibility !== 'object'
  ) {
    problems.push('compatibility: { minPlatform, maxPlatform } are required semver bounds');
  } else {
    const { minPlatform, maxPlatform } = manifest.compatibility;
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

  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    problems.push('capabilities: a manifest must declare at least one capability (mos-app-ecosystem-v1.5.md §Manifest)');
  } else if (manifest.capabilities.length > MAX_CAPABILITIES) {
    problems.push(`capabilities: at most ${MAX_CAPABILITIES} capabilities per manifest`);
  } else {
    const names = new Set<string>();
    manifest.capabilities.forEach((capability, index) => {
      const label = `capabilities[${index}]`;
      if (capability === null || typeof capability !== 'object') {
        problems.push(`${label}: must be an object { name, version }`);
        return;
      }
      const declaration = capability as Partial<AppCapabilityDeclaration>;
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
    ['inputSchema', manifest.inputSchema],
    ['outputSchema', manifest.outputSchema],
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

  if (!Array.isArray(manifest.dataScopes)) {
    problems.push('dataScopes: must be an array of the closed data-scope vocabulary');
  } else {
    problems.push(
      ...scopeListProblems('dataScopes', manifest.dataScopes, APP_DATA_SCOPES as readonly string[], MAX_SCOPES),
    );
  }
  if (!Array.isArray(manifest.mutationScopes)) {
    problems.push('mutationScopes: must be an array of the closed mutation-scope vocabulary');
  } else {
    problems.push(
      ...scopeListProblems(
        'mutationScopes',
        manifest.mutationScopes,
        APP_MUTATION_SCOPES as readonly string[],
        MAX_SCOPES,
      ),
    );
  }

  if (!Array.isArray(manifest.networkDestinations)) {
    problems.push('networkDestinations: must be an array of { host, protocol, port, reason } declarations');
  } else if (manifest.networkDestinations.length > MAX_NETWORK_DESTINATIONS) {
    problems.push(`networkDestinations: at most ${MAX_NETWORK_DESTINATIONS} destinations`);
  } else {
    manifest.networkDestinations.forEach((destination, index) => {
      const label = `networkDestinations[${index}]`;
      if (destination === null || typeof destination !== 'object') {
        problems.push(`${label}: must be an object { host, protocol, port, reason }`);
        return;
      }
      const declaration = destination as Partial<AppNetworkDestination>;
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

  if (typeof manifest.runtimeClass !== 'string' || !(APP_RUNTIME_CLASSES as readonly string[]).includes(manifest.runtimeClass)) {
    problems.push(
      `runtimeClass: '${String(manifest.runtimeClass)}' is not in the closed runtime-class vocabulary (the /executions set)`,
    );
  }

  if (!Array.isArray(manifest.eventSubscriptions)) {
    problems.push('eventSubscriptions: must be an array of bounded unique event labels');
  } else if (manifest.eventSubscriptions.length > MAX_EVENT_SUBSCRIPTIONS) {
    problems.push(`eventSubscriptions: at most ${MAX_EVENT_SUBSCRIPTIONS} subscriptions`);
  } else {
    const seen = new Set<string>();
    manifest.eventSubscriptions.forEach((label, index) => {
      if (typeof label !== 'string' || label.length < 1 || label.length > 64) {
        problems.push(`eventSubscriptions[${index}]: must be 1-64 characters`);
      } else if (seen.has(label)) {
        problems.push(`eventSubscriptions[${index}]: duplicate event label '${label}'`);
      } else {
        seen.add(label);
      }
    });
  }

  if (!Array.isArray(manifest.uiSurfaces)) {
    problems.push('uiSurfaces: must be an array of { surface, route } declarations');
  } else if (manifest.uiSurfaces.length > MAX_UI_SURFACES) {
    problems.push(`uiSurfaces: at most ${MAX_UI_SURFACES} surfaces`);
  } else {
    manifest.uiSurfaces.forEach((surface, index) => {
      const label = `uiSurfaces[${index}]`;
      if (surface === null || typeof surface !== 'object') {
        problems.push(`${label}: must be an object { surface, route }`);
        return;
      }
      const declaration = surface as Partial<AppUiSurfaceDeclaration>;
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

  if (manifest.configSchema === null || typeof manifest.configSchema !== 'object' || Array.isArray(manifest.configSchema)) {
    problems.push('configSchema: must be a JSON object of field contracts');
  } else {
    const entries = Object.entries(manifest.configSchema as Record<string, unknown>);
    if (entries.length > MAX_CONFIG_FIELDS) {
      problems.push(`configSchema: at most ${MAX_CONFIG_FIELDS} fields`);
    }
    if (
      Buffer.byteLength(JSON.stringify(manifest.configSchema), 'utf8') > MAX_CONFIG_JSON_BYTES
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
      const contract = fieldValue as Partial<AppConfigFieldContract>;
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
    problems.push(...payloadHasNoAppsMaterialKeys(manifest.configSchema, 'configSchema'));
  }

  if (!Array.isArray(manifest.requiredCredentialNames)) {
    problems.push('requiredCredentialNames: must be an array of LOGICAL credential name labels');
  } else if (manifest.requiredCredentialNames.length > MAX_CREDENTIAL_NAMES) {
    problems.push(`requiredCredentialNames: at most ${MAX_CREDENTIAL_NAMES} names`);
  } else {
    const seen = new Set<string>();
    manifest.requiredCredentialNames.forEach((name, index) => {
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

  if (!Array.isArray(manifest.stateNamespaces)) {
    problems.push('stateNamespaces: must be an array of app-owned state namespaces');
  } else if (manifest.stateNamespaces.length > MAX_STATE_NAMESPACES) {
    problems.push(`stateNamespaces: at most ${MAX_STATE_NAMESPACES} namespaces`);
  } else {
    const seen = new Set<string>();
    const appKey = typeof manifest.appKey === 'string' ? manifest.appKey : '';
    manifest.stateNamespaces.forEach((namespace, index) => {
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
    typeof manifest.migrationVersion !== 'number' ||
    !Number.isSafeInteger(manifest.migrationVersion) ||
    manifest.migrationVersion < 0
  ) {
    problems.push('migrationVersion: must be a non-negative integer (the app storage migration version)');
  }

  if (!Array.isArray(manifest.dependencies)) {
    problems.push('dependencies: must be an array of { kind, publisher, key, minVersion, maxVersion } declarations');
  } else if (manifest.dependencies.length > MAX_DEPENDENCIES) {
    problems.push(`dependencies: at most ${MAX_DEPENDENCIES} dependencies`);
  } else {
    const seen = new Set<string>();
    const appKey = typeof manifest.appKey === 'string' ? manifest.appKey : '';
    manifest.dependencies.forEach((dependency, index) => {
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

  if (typeof manifest.supportLevel !== 'string' || manifest.supportLevel.length < 1 || manifest.supportLevel.length > 64) {
    problems.push('supportLevel: must be 1-64 characters (the declared support level)');
  }

  if (!Array.isArray(manifest.meteringDimensions)) {
    problems.push('meteringDimensions: must be an array of the closed metering-dimension vocabulary');
  } else {
    problems.push(
      ...scopeListProblems(
        'meteringDimensions',
        manifest.meteringDimensions,
        APP_METERING_DIMENSIONS as readonly string[],
        MAX_METERING_DIMENSIONS,
      ),
    );
  }

  // The full-manifest §21 material-key backstop (every field, every
  // nesting level — the storage CHECK functions re-fence the jsonb
  // columns).
  problems.push(...payloadHasNoAppsMaterialKeys(manifest, 'manifest'));

  if (problems.length > 0) {
    throw new InvalidRequestError(
      'app manifest failed the frozen mos-app-ecosystem-v1.5.md §Manifest shape contract',
      problems,
    );
  }
}

/**
 * The compatibility-query input guard: a semver platform version, an
 * optional closed-vocabulary runtime class and bounded extension-version
 * descriptors. Pure.
 */
export function assertValidCompatibilityQuery(query: {
  readonly platformVersion: unknown;
  readonly runtimeClass: unknown;
  readonly extensionVersions: unknown;
}): void {
  const problems: string[] = [];
  if (typeof query.platformVersion !== 'string' || !SEMVER_PATTERN.test(query.platformVersion)) {
    problems.push(...semverProblems('platformVersion', String(query.platformVersion)));
  }
  if (
    query.runtimeClass !== null &&
    query.runtimeClass !== undefined &&
    (typeof query.runtimeClass !== 'string' ||
      !(APP_RUNTIME_CLASSES as readonly string[]).includes(query.runtimeClass))
  ) {
    problems.push(`runtimeClass: '${String(query.runtimeClass)}' is not in the closed runtime-class vocabulary`);
  }
  if (!Array.isArray(query.extensionVersions) || query.extensionVersions.length > 256) {
    problems.push('extensionVersions: must be an array of at most 256 { publisher, extensionKey, version } descriptors');
  } else {
    query.extensionVersions.forEach((entry, index) => {
      const label = `extensionVersions[${index}]`;
      if (entry === null || typeof entry !== 'object') {
        problems.push(`${label}: must be an object { publisher, extensionKey, version }`);
        return;
      }
      const descriptor = entry as { publisher?: unknown; extensionKey?: unknown; version?: unknown };
      if (typeof descriptor.publisher !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(descriptor.publisher)) {
        problems.push(`${label}.publisher: must be a /extensions publisher label`);
      }
      if (typeof descriptor.extensionKey !== 'string' || !KEY_PATTERN.test(descriptor.extensionKey)) {
        problems.push(`${label}.extensionKey: must be an extension key`);
      }
      if (typeof descriptor.version !== 'string' || !SEMVER_PATTERN.test(descriptor.version)) {
        problems.push(...semverProblems(`${label}.version`, String(descriptor.version)));
      }
    });
  }
  if (problems.length > 0) {
    throw new InvalidRequestError('app compatibility query failed the frozen contract', problems);
  }
}

/**
 * Pure: is every declared dependency of `manifest` satisfied by the given
 * available extension versions (extension dependencies) and app versions
 * (app dependencies)? Returns the unsatisfied-dependency reasons (empty
 * when satisfied) — the shared predicate of the publish-time validation
 * (resolved against the LIVE registries by the module) and the
 * compatibility query (resolved against the query's environment inputs).
 */
export function appDependenciesValid(
  manifest: Pick<AppManifest, 'dependencies' | 'appKey'>,
  available: {
    readonly extensionVersions: ReadonlyArray<{
      readonly publisher: string;
      readonly extensionKey: string;
      readonly version: string;
    }>;
    readonly appVersions: ReadonlyArray<{ readonly appKey: string; readonly version: string }>;
  },
): string[] {
  const reasons: string[] = [];
  for (const dependency of manifest.dependencies) {
    if (dependency.key === manifest.appKey) {
      reasons.push(
        `dependency on app '${dependency.key}' is a self-dependency (dependencies are other, already-published lineages)`,
      );
      continue;
    }
    if (dependency.kind === 'extension') {
      const satisfied = available.extensionVersions.some(
        (candidate) =>
          candidate.publisher === dependency.publisher &&
          candidate.extensionKey === dependency.key &&
          appVersionInRange(candidate.version, dependency.minVersion, dependency.maxVersion),
      );
      if (!satisfied) {
        reasons.push(
          `dependency on extension ${dependency.publisher}/${dependency.key} has no available version inside [${dependency.minVersion} .. ${dependency.maxVersion}]`,
        );
      }
    } else {
      const satisfied = available.appVersions.some(
        (candidate) =>
          candidate.appKey === dependency.key &&
          appVersionInRange(candidate.version, dependency.minVersion, dependency.maxVersion),
      );
      if (!satisfied) {
        reasons.push(
          `dependency on app '${dependency.key}' has no available version inside [${dependency.minVersion} .. ${dependency.maxVersion}]`,
        );
      }
    }
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// The §8-style create fingerprint (deterministic canonical JSON digest)
// ---------------------------------------------------------------------------

/**
 * The §8-style fingerprint of one logical publish command: a
 * deterministic digest of the CANONICAL manifest (sorted keys at every
 * level) — one idempotency key identifies one manifest; a key reused for
 * different content is a conflict. Pure.
 */
export function appCreateFingerprint(manifest: AppManifest): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(manifest as unknown as JSONValue)))
    .update('|mkt-047-app-manifest')
    .digest('hex');
}

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/** Canonical JSON: object keys sorted at EVERY level (deterministic digest). */
function canonicalize(value: JSONValue): JSONValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JSONValue> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]!);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface AppVersionRow extends DbRow {
  app_version_id: string;
  app_key: string;
  publisher: string;
  version: string;
  compat_min: string;
  compat_max: string;
  capabilities: AppCapabilityDeclaration[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  data_scopes: string[];
  mutation_scopes: string[];
  network_destinations: AppNetworkDestination[];
  runtime_class: string;
  event_subscriptions: string[];
  ui_surfaces: AppUiSurfaceDeclaration[];
  config_schema: Record<string, AppConfigFieldContract>;
  required_credential_names: string[];
  state_namespaces: string[];
  migration_version: number | string;
  dependencies: AppDependencyDeclaration[];
  certification_state: string;
  support_level: string;
  metering_dimensions: string[];
  idempotency_key: string;
  create_fingerprint: string;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const APP_VERSION_SELECT = `
  SELECT app_version_id, app_key, publisher, version, compat_min, compat_max,
         capabilities, input_schema, output_schema, data_scopes, mutation_scopes,
         network_destinations, runtime_class, event_subscriptions, ui_surfaces,
         config_schema, required_credential_names, state_namespaces,
         migration_version, dependencies, certification_state, support_level,
         metering_dimensions, idempotency_key, create_fingerprint,
         created_by, created_at, updated_at
  FROM app_versions
`;

function toAppVersionRecord(row: AppVersionRow): AppVersionRecord {
  return {
    appVersionId: row.app_version_id,
    appKey: row.app_key,
    publisher: row.publisher,
    certificationState: row.certification_state as AppVersionRecord['certificationState'],
    manifest: {
      appKey: row.app_key,
      version: row.version,
      compatibility: { minPlatform: row.compat_min, maxPlatform: row.compat_max },
      capabilities: row.capabilities,
      inputSchema: row.input_schema,
      outputSchema: row.output_schema,
      dataScopes: row.data_scopes as AppDataScope[],
      mutationScopes: row.mutation_scopes as AppMutationScope[],
      networkDestinations: row.network_destinations,
      runtimeClass: row.runtime_class as AppRuntimeClass,
      eventSubscriptions: row.event_subscriptions,
      uiSurfaces: row.ui_surfaces as AppUiSurfaceDeclaration[],
      configSchema: row.config_schema,
      requiredCredentialNames: row.required_credential_names,
      stateNamespaces: row.state_namespaces,
      migrationVersion: Number(row.migration_version),
      dependencies: row.dependencies.map((dependency) => ({
        kind: dependency.kind,
        publisher: dependency.publisher ?? null,
        key: dependency.key,
        minVersion: dependency.minVersion,
        maxVersion: dependency.maxVersion,
      })),
      supportLevel: row.support_level,
      meteringDimensions: row.metering_dimensions as AppMeteringDimension[],
    },
    idempotencyKey: row.idempotency_key,
    createFingerprint: row.create_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Classifies a postgres error on /apps writes into the domain conflict it
 * represents (version fence vs key-ownership fence vs dependency fence
 * vs validation backstop). Anything else propagates untouched.
 */
export function classifyAppsWriteConflict(
  error: unknown,
): 'version-fence' | 'key-ownership' | 'dependency-fence' | 'validation-backstop' | null {
  const candidate = error as { code?: string; constraint?: string; message?: string };
  if (candidate?.code === '23505') {
    if (candidate.constraint === 'app_dependencies_unique') return 'dependency-fence';
    // The (app key, version) immutable fence and the app-key ownership
    // fence are both surfaced by the module BEFORE the insert classifies
    // them (read-back); a raw unique violation here is the version fence.
    return 'version-fence';
  }
  if (candidate?.code === '23514' || candidate?.code === 'P0001') return 'validation-backstop';
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class AppsStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(db: Db, clock: Clock, ids: IdGenerator) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
  }

  /**
   * Inserts one published App Version — ONE ATOMIC TRANSACTION:
   *   1. the app-key OWNERSHIP row (ON CONFLICT DO NOTHING — concurrent
   *      first publishes of the same key converge to exactly one owner);
   *   2. the ownership check ('foreign-key' when another publisher owns
   *      the key lineage — ConflictError upstream);
   *   3. the immutable manifest row (ON CONFLICT (app_key, version) DO
   *      NOTHING — 'taken' means the immutable version already exists);
   *   4. the dependency rows (the migration-037 validation trigger
   *      re-fences every target: existence + in-range + no
   *      self-dependency).
   */
  async insertAppVersion(row: {
    readonly manifest: AppManifest;
    readonly publisher: string;
    readonly idempotencyKey: string;
    readonly createFingerprint: string;
    readonly createdBy: string | null;
  }): Promise<AppVersionRecord | 'taken' | 'foreign-key'> {
    const appVersionId = this.ids.newId();
    const now = this.clock.nowIso();
    const manifest = row.manifest;
    if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > MAX_MANIFEST_JSON_BYTES) {
      throw new InvalidRequestError(
        `app manifest must serialize to at most ${MAX_MANIFEST_JSON_BYTES} bytes`,
      );
    }
    // The server-derived publisher identity must satisfy the registry
    // format (the DB CHECK fence) — a derived identity that cannot be
    // stored fails closed before any write.
    if (!PUBLISHER_IDENTITY_PATTERN.test(row.publisher)) {
      throw new InvalidRequestError(
        `the server-derived publisher identity '${row.publisher}' does not satisfy the registry format`,
      );
    }
    if (
      typeof row.idempotencyKey !== 'string' ||
      row.idempotencyKey.length < 1 ||
      row.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new InvalidRequestError(
        `idempotencyKey: must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    const outcome = await this.db.transaction(async (tx) => {
      // 1. The app-key ownership row (first publisher owns the lineage).
      await tx.query(
        `INSERT INTO apps (app_key, owner_publisher)
         VALUES ($1, $2)
         ON CONFLICT (app_key) DO NOTHING`,
        [manifest.appKey, row.publisher],
      );
      // 2. The key-lineage ownership check.
      const owner = await tx.query<{ owner_publisher: string }>(
        'SELECT owner_publisher FROM apps WHERE app_key = $1',
        [manifest.appKey],
      );
      const ownerPublisher = owner.rows[0]?.owner_publisher;
      if (ownerPublisher !== undefined && ownerPublisher !== row.publisher) {
        return 'foreign-key' as const;
      }
      // 3. The immutable manifest row (the (app key, version) fence).
      const inserted = await tx.query(
        `INSERT INTO app_versions
           (app_version_id, app_key, publisher, version, compat_min, compat_max,
            capabilities, input_schema, output_schema, data_scopes, mutation_scopes,
            network_destinations, runtime_class, event_subscriptions, ui_surfaces,
            config_schema, required_credential_names, state_namespaces,
            migration_version, dependencies, certification_state, support_level,
            metering_dimensions, idempotency_key, create_fingerprint,
            created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                 $10::jsonb, $11::jsonb, $12::jsonb, $13, $14::jsonb, $15::jsonb,
                 $16::jsonb, $17::jsonb, $18::jsonb, $19, $20::jsonb, 'UNVERIFIED',
                 $21, $22::jsonb, $23, $24, $25, $26, $26)
         ON CONFLICT (app_key, version) DO NOTHING`,
        [
          appVersionId,
          manifest.appKey,
          row.publisher,
          manifest.version,
          manifest.compatibility.minPlatform,
          manifest.compatibility.maxPlatform,
          JSON.stringify(manifest.capabilities),
          JSON.stringify(manifest.inputSchema),
          JSON.stringify(manifest.outputSchema),
          JSON.stringify(manifest.dataScopes),
          JSON.stringify(manifest.mutationScopes),
          JSON.stringify(manifest.networkDestinations),
          manifest.runtimeClass,
          JSON.stringify(manifest.eventSubscriptions),
          JSON.stringify(manifest.uiSurfaces),
          JSON.stringify(manifest.configSchema),
          JSON.stringify(manifest.requiredCredentialNames),
          JSON.stringify(manifest.stateNamespaces),
          manifest.migrationVersion,
          JSON.stringify(manifest.dependencies),
          manifest.supportLevel,
          JSON.stringify(manifest.meteringDimensions),
          row.idempotencyKey,
          row.createFingerprint,
          row.createdBy,
          now,
        ],
      );
      if (inserted.rowCount !== 1) {
        return 'taken' as const;
      }
      // 4. The dependency rows (the validation trigger re-fences every
      //    target — defense in depth behind the module's own resolution).
      for (const dependency of manifest.dependencies) {
        await tx.query(
          `INSERT INTO app_dependencies
             (dependency_id, app_version_id, kind, ref_publisher, ref_key,
              min_version, max_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            this.ids.newId(),
            appVersionId,
            dependency.kind,
            dependency.kind === 'extension' ? dependency.publisher : null,
            dependency.key,
            dependency.minVersion,
            dependency.maxVersion,
            now,
          ],
        );
      }
      return 'inserted' as const;
    });
    if (outcome !== 'inserted') return outcome;
    const created = await this.getAppVersion(appVersionId);
    if (created === null) {
      throw new Error(`published app version ${appVersionId} could not be read back`);
    }
    return created;
  }

  async getAppVersion(appVersionId: string): Promise<AppVersionRecord | null> {
    const result = await this.db.query<AppVersionRow>(
      `${APP_VERSION_SELECT} WHERE app_version_id = $1`,
      [appVersionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAppVersionRecord(row);
  }

  async findAppVersion(appKey: string, version: string): Promise<AppVersionRecord | null> {
    const result = await this.db.query<AppVersionRow>(
      `${APP_VERSION_SELECT} WHERE app_key = $1 AND version = $2`,
      [appKey, version],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAppVersionRecord(row);
  }

  async listAppVersions(appKey: string | null): Promise<readonly AppVersionRecord[]> {
    const clauses: string[] = [];
    const params: (string | null)[] = [];
    if (appKey !== null) {
      params.push(appKey);
      clauses.push(`app_key = $${params.length}`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.db.query<AppVersionRow>(
      `${APP_VERSION_SELECT} ${where} ORDER BY created_at DESC, app_version_id LIMIT 500`,
      params,
    );
    return result.rows.map(toAppVersionRecord);
  }

  /** The published (app key, version) pairs of one key lineage. */
  async listAppVersionKeys(appKey: string): Promise<ReadonlyArray<{ appKey: string; version: string }>> {
    const result = await this.db.query<{ app_key: string; version: string }>(
      'SELECT app_key, version FROM app_versions WHERE app_key = $1 ORDER BY created_at DESC LIMIT 500',
      [appKey],
    );
    return result.rows.map((row) => ({ appKey: row.app_key, version: row.version }));
  }
}
