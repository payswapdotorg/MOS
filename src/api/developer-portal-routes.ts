/**
 * /api/developer-portal APP DEVELOPER PORTAL routes (MKT-049 — the App
 * SDK and Developer Portal: "community developer workflow for
 * scaffolding, local validation, capability contracts, UI surfaces,
 * manifests, tests, signing/publishing and documentation";
 * spec/mos-app-ecosystem-v1.5.md "UI and developer model": "The
 * Developer Portal publishes, validates, certifies, versions, tests and
 * documents Apps").
 *
 *   DEVELOPER surface (thin delegation over the EXISTING /apps authority
 *   — the MKT-032 extension-portal precedent: one authority, multiple
 *   route families; the portal NEVER becomes a second app authority):
 *     GET    /api/developer-portal/catalog                          the developer catalog: distinct app keys, version counts, the newest version (any active member)
 *     GET    /api/developer-portal/apps/:appKey/versions            the version history view of one app key (any active member)
 *     GET    /api/developer-portal/apps/:appKey/versions/:version   the developer version view: manifest + VALIDATION STATUS (integrity) + vocabulary annotations (any active member; unknown/malformed → uniform 404)
 *     POST   /api/developer-portal/validate                         ONLINE validation through the REAL registry guard (pure — no state change, no audit; the /api/apps/compatibility POST-read precedent)
 *     POST   /api/developer-portal/publish                          publish a NEW immutable App Version — DELEGATES to the /apps registry publish command (platform_developer | platform_administrator; the optional signature is verified by the authority; publish remains immutable-versioned, MKT-047 semantics)
 *     GET    /api/developer-portal/docs                             the DOCUMENTATION SURFACE: generated read-only from the frozen /apps public contract + manifest schema (any active member; NO runtime mutation)
 *
 * NO UPDATE ROUTE. NO DELETE ROUTE. NO portal-owned module, store,
 * table or migration: published App Versions are immutable
 * (architecture-lock v1.5 #11), certification transitions are the MKT-050
 * platform marketplace surface, and EVERY portal operation delegates to
 * the /apps registry public contract (publishAppVersion /
 * listAppVersions / findAppVersion) or to the authority's exported pure
 * guards (assertValidAppManifest / appManifestSignatureProblems /
 * appCreateFingerprint — exported by the MKT-047 module contract
 * precisely "for future server-side callers (the App SDK / Developer
 * Portal Work Items)"). The route surface is exactly the six frozen
 * routes above (asserted by
 * tests/architecture/developer-portal-boundary.test.ts).
 *
 * Server-derived authority posture (implementation-contract §3/§23; the
 * apps-routes/extension-portal precedents): publishing is PLATFORM
 * territory (the frozen platform_developer role); reads are open to
 * AUTHENTICATED ACTIVE MEMBERS (the global-catalog posture — the
 * catalog is global read state for tenant members); every mutating
 * route resolves the caller's authorization context from durable state
 * BEFORE validate/execute; identity, publisher, certification,
 * provenance and lifecycle fields are NEVER request-suppliable (the
 * DTOs reject them explicitly plus every material-shaped key — §21; the
 * module input guard remains the single semantic enforcement point);
 * unknown/foreign/malformed identifiers are the UNIFORM 404 (no
 * cross-tenant oracle); the surface derives NO permissions of its own.
 *
 * Documentation-surface disclosure (the MKT-049 dispatch AC-6 choice):
 * the developer documentation is SERVED at GET /api/developer-portal/docs
 * and DERIVED AT READ TIME from the frozen /apps public contract exports
 * (the closed vocabularies + meanings constants) plus the frozen
 * manifest-schema field table below — a PURE READ: no file is written,
 * no state changes, no build step. The SDK CLI `docs` command
 * (tools/app-sdk) generates the equivalent reference OFFLINE from the
 * drift-pinned mirror; the unit drift test asserts the two vocabularies
 * are identical.
 */

import { ForbiddenError, InvalidRequestError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import type { FieldSpec } from '../platform/http/validation.ts';
import {
  arrayField,
  intField,
  objectField,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  AppCertificationState,
  AppDataScope,
  AppMeteringDimension,
  AppMutationScope,
  AppRuntimeClass,
  AppUiSurfaceKind,
  AppVersionRecord,
} from '../modules/apps/public.ts';
import {
  APP_CERTIFICATION_STATE_MEANINGS,
  APP_DATA_SCOPE_MEANINGS,
  APP_METERING_DIMENSION_MEANINGS,
  APP_MUTATION_SCOPE_MEANINGS,
  APP_RUNTIME_CLASS_MEANINGS,
  APP_UI_SURFACE_KIND_MEANINGS,
  appCreateFingerprint,
  appManifestSignatureProblems,
  assertValidAppManifest,
} from '../modules/apps/public.ts';
import type {
  AppCapabilityDeclaration,
  AppConfigFieldContract,
  AppDependencyDeclaration,
  AppManifest,
  AppManifestSignature,
  AppNetworkDestination,
  AppPublisherIdentity,
  AppSignatureAlgorithm,
  AppUiSurfaceDeclaration,
} from '../modules/apps/public.ts';
import { compareSemver } from '../modules/apps/public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const PUBLISHER_LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,47}$/;
const DATA_SCOPE_PATTERN = /^(client:read|client:write|workspace:read|workspace:write)$/;
const MUTATION_SCOPE_PATTERN = /^(workflow:dispatch|execution:request|evidence:append|metric:append|credential:bind)$/;
const METERING_DIMENSION_PATTERN = /^(installations|invocations|compute-runtime|data-volume|premium-capabilities)$/;
const RUNTIME_CLASS_PATTERN = /^(pooled-worker|ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/;
const UI_SURFACE_KIND_PATTERN = /^(command-center-card|client-room-panel|workspace-tab|report-page|editor-pane|action-menu)$/;
const UI_ROUTE_PATTERN = /^\/[a-zA-Z0-9._/-]{0,120}$/;

/**
 * Material-shaped keys rejected on EVERY portal surface (§21/CRED-001 —
 * the /apps route family's identical set; the module guard and the
 * migration-037 CHECK functions enforce the same set behind the DTO).
 */
const MATERIAL_KEYS = [
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
 * Fields always server-derived on PUBLICATION (identity, publisher,
 * certification, provenance, lifecycle) — plus every material-shaped
 * key. Mirrors the /api/apps PUBLISH_AUTHORITY_FIELDS contract exactly
 * (the same rejection set on both publish surfaces).
 */
const PUBLISH_AUTHORITY_FIELDS = [
  'appVersionId',
  'publisher',
  'publisherId',
  'ownerPublisher',
  'certificationState',
  'certification',
  'trustLevel',
  'trust',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
  ...MATERIAL_KEYS,
] as const;

const MANIFEST_AUTHORITY_FIELDS = [
  'publisher',
  'publisherId',
  'ownerPublisher',
  'agencyId',
  'clientId',
  'workspaceId',
  'tenantId',
  'appVersionId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  'certificationState',
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
  ...MATERIAL_KEYS,
] as const;

// ---------------------------------------------------------------------------
// The frozen manifest-schema field table (the documentation surface's
// manifest reference — spec/mos-app-ecosystem-v1.5.md "Manifest")
// ---------------------------------------------------------------------------

/**
 * The frozen 19-field manifest-schema reference served by the
 * documentation surface. Mirrors the SDK's
 * tools/app-sdk/src/docs.ts MANIFEST_FIELD_DOCS (the unit drift test
 * asserts the two tables are IDENTICAL — the served and offline
 * documentation never fork).
 */
export const DEVELOPER_PORTAL_MANIFEST_FIELD_DOCS: ReadonlyArray<{
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly description: string;
}> = [
  { field: 'appKey', type: 'string', required: true, description: 'app key and publisher identity (the publisher identity is SERVER-DERIVED from the authenticated platform developer — never a manifest field)' },
  { field: 'version', type: 'semver', required: true, description: 'immutable semantic version and compatibility range (a published (appKey, version) pair is immutable; corrections publish a NEW version)' },
  { field: 'compatibility', type: '{ minPlatform, maxPlatform }', required: true, description: 'inclusive platform compatibility range under REAL semver ordering' },
  { field: 'capabilities', type: 'array of { name, version }', required: true, description: 'capabilities and capability versions (bounded, unique names — one name is one callable unit)' },
  { field: 'inputSchema', type: 'object', required: true, description: 'input/output schemas (bounded JSON objects)' },
  { field: 'outputSchema', type: 'object', required: true, description: 'input/output schemas (bounded JSON objects)' },
  { field: 'dataScopes', type: 'array (closed vocabulary)', required: true, description: 'requested data scopes (the frozen tenant-data boundary kinds)' },
  { field: 'mutationScopes', type: 'array (closed vocabulary)', required: true, description: 'requested mutation scopes (the MOS authority surfaces an App may INVOKE — always server-mediated; direct database writes to MOS core tables are forbidden)' },
  { field: 'networkDestinations', type: 'array of { host, protocol, port, reason }', required: true, description: 'network destinations (policy-gated at use)' },
  { field: 'runtimeClass', type: 'enum (closed vocabulary)', required: true, description: 'runtime class (the closed /executions set: pooled-worker | ephemeral-sandbox | persistent-sandbox | dedicated-runtime)' },
  { field: 'eventSubscriptions', type: 'array of labels', required: true, description: 'event subscriptions (bounded unique labels)' },
  { field: 'uiSurfaces', type: 'array of { surface, route }', required: true, description: 'UI surfaces and routes (the closed six-kind vocabulary — presentation only; UI invokes server capabilities for mutations)' },
  { field: 'configSchema', type: 'object of field contracts', required: true, description: 'configuration schema ({ type, required, description, pattern } field contracts — validated at install time)' },
  { field: 'requiredCredentialNames', type: 'array (uppercase snake)', required: true, description: 'credential references required BY NAME ONLY (never values — §21)' },
  { field: 'stateNamespaces', type: 'array (app:<appKey>:<local>)', required: true, description: 'app-owned state namespaces (must claim the OWN app key; the local segment may never be a MOS core-authority namespace — bounded app state)' },
  { field: 'migrationVersion', type: 'integer >= 0', required: true, description: 'migration version (the app\'s own storage migration version)' },
  { field: 'dependencies', type: 'array of { kind, publisher, key, minVersion, maxVersion }', required: true, description: 'dependency Apps/Extensions (a published compatible version must exist inside the declared range; no self-dependency)' },
  { field: 'supportLevel', type: 'string', required: true, description: 'declared support level (bounded publisher-declared label)' },
  { field: 'meteringDimensions', type: 'array (closed vocabulary)', required: true, description: 'metering dimensions (the closed economics vocabulary — MKT-052 owns the ledger)' },
];

/** The frozen portal endpoint reference (the served documentation). */
const PORTAL_ENDPOINT_DOCS: ReadonlyArray<{
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly description: string;
}> = [
  { method: 'GET', path: '/api/developer-portal/catalog', description: 'the developer catalog: distinct app keys, version counts, the newest published version (any active member)' },
  { method: 'GET', path: '/api/developer-portal/apps/:appKey/versions', description: 'the version history view of one app key (any active member)' },
  { method: 'GET', path: '/api/developer-portal/apps/:appKey/versions/:version', description: 'the developer version view: the manifest + validation status (integrity) + vocabulary annotations (any active member)' },
  { method: 'POST', path: '/api/developer-portal/validate', description: 'online validation through the REAL registry guard (pure — no state change; any active member)' },
  { method: 'POST', path: '/api/developer-portal/publish', description: 'publish a NEW immutable App Version (delegates to the /apps registry publish command; platform_developer | platform_administrator; optional signature verified)' },
  { method: 'GET', path: '/api/developer-portal/docs', description: 'this documentation surface, derived read-only from the frozen /apps public contract (any active member)' },
  { method: 'POST', path: '/api/apps', description: 'the DIRECT registry publish surface (the same authority command; the SDK client uses the portal family)' },
  { method: 'GET', path: '/api/apps/:appKey/versions/:version', description: 'the DIRECT registry manifest read by exact (app key, semantic version)' },
  { method: 'POST', path: '/api/apps/compatibility', description: 'the compatibility query: given platform version + available extension versions → eligible app versions with honest reasons' },
];

// ---------------------------------------------------------------------------
// Serialization (the /api/apps serializeAppVersion shape — the same
// public read model on both route families)
// ---------------------------------------------------------------------------

function serializeAppVersion(record: AppVersionRecord): Record<string, unknown> {
  return {
    appVersionId: record.appVersionId,
    appKey: record.appKey,
    // SERVER-DERIVED publisher identity (never a request field).
    publisher: record.publisher,
    manifest: {
      appKey: record.manifest.appKey,
      version: record.manifest.version,
      compatibility: record.manifest.compatibility,
      capabilities: record.manifest.capabilities,
      inputSchema: record.manifest.inputSchema,
      outputSchema: record.manifest.outputSchema,
      dataScopes: record.manifest.dataScopes,
      mutationScopes: record.manifest.mutationScopes,
      networkDestinations: record.manifest.networkDestinations,
      runtimeClass: record.manifest.runtimeClass,
      eventSubscriptions: record.manifest.eventSubscriptions,
      uiSurfaces: record.manifest.uiSurfaces,
      configSchema: record.manifest.configSchema,
      requiredCredentialNames: record.manifest.requiredCredentialNames,
      stateNamespaces: record.manifest.stateNamespaces,
      migrationVersion: record.manifest.migrationVersion,
      dependencies: record.manifest.dependencies,
      supportLevel: record.manifest.supportLevel,
      meteringDimensions: record.manifest.meteringDimensions,
    },
    // PLATFORM TERRITORY (born UNVERIFIED; trust transitions are the
    // MKT-050 surface — read-only here).
    certificationState: record.certificationState,
    idempotencyKey: record.idempotencyKey,
    createFingerprint: record.createFingerprint,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * The vocabulary ANNOTATIONS of one published version — the per-manifest
 * documentation generated from the frozen meanings (the version view's
 * "documentation generated from manifests/contracts" dimension).
 */
function vocabularyAnnotations(record: AppVersionRecord): Record<string, unknown> {
  const dataScopes: Record<string, string> = {};
  for (const scope of record.manifest.dataScopes) {
    dataScopes[scope] = APP_DATA_SCOPE_MEANINGS[scope as AppDataScope];
  }
  const mutationScopes: Record<string, string> = {};
  for (const scope of record.manifest.mutationScopes) {
    mutationScopes[scope] = APP_MUTATION_SCOPE_MEANINGS[scope as AppMutationScope];
  }
  const uiSurfaces: Record<string, string> = {};
  for (const surface of record.manifest.uiSurfaces) {
    uiSurfaces[surface.surface] = APP_UI_SURFACE_KIND_MEANINGS[surface.surface as AppUiSurfaceKind];
  }
  const meteringDimensions: Record<string, string> = {};
  for (const dimension of record.manifest.meteringDimensions) {
    meteringDimensions[dimension] = APP_METERING_DIMENSION_MEANINGS[dimension as AppMeteringDimension];
  }
  return {
    dataScopes,
    mutationScopes,
    uiSurfaceKinds: uiSurfaces,
    meteringDimensions,
    runtimeClass: APP_RUNTIME_CLASS_MEANINGS[record.manifest.runtimeClass as AppRuntimeClass],
    certificationState: APP_CERTIFICATION_STATE_MEANINGS[record.certificationState as AppCertificationState],
  };
}

// ---------------------------------------------------------------------------
// DTO field helpers (the apps-routes.ts shapes — the publish DTO mirrors
// the /api/apps contract exactly; the module guard remains the single
// semantic enforcement point)
// ---------------------------------------------------------------------------

/**
 * An optional field that accepts an EXPLICIT null in addition to
 * omission (the apps-routes nullableStringField contract).
 */
function nullableStringField(options: { pattern?: RegExp } = {}): FieldSpec<string | null | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (value === null) return null;
      if (typeof value !== 'string') {
        problems.push('must be a string or null');
        return null;
      }
      if (options.pattern !== undefined && !options.pattern.test(value)) {
        problems.push('has an invalid format');
      }
      return value;
    },
  };
}

/**
 * The OPTIONAL manifest signature DTO field (MKT-049): { algorithm,
 * digest } or an explicit null / omission — surface-level shape hygiene
 * only; the module's appManifestSignatureProblems guard is the single
 * semantic enforcement point.
 */
function signatureField(): FieldSpec<{ readonly algorithm: string; readonly digest: string } | null> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined || value === null) return null;
      if (typeof value !== 'object' || Array.isArray(value)) {
        problems.push('must be an object { algorithm, digest } or null');
        return null;
      }
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (key !== 'algorithm' && key !== 'digest') {
          problems.push(`${key}: unknown field`);
        }
      }
      const algorithm = record['algorithm'];
      const digest = record['digest'];
      if (typeof algorithm !== 'string' || algorithm !== 'manifest-sha256-fingerprint') {
        problems.push('algorithm: must be manifest-sha256-fingerprint (the closed v1 attestation vocabulary)');
      }
      if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
        problems.push('digest: must be a 64-character lowercase hex sha256 digest of the canonical manifest');
      }
      return {
        algorithm: typeof algorithm === 'string' ? algorithm : '',
        digest: typeof digest === 'string' ? digest : '',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDeveloperPortalRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('developer-portal.api');

  /**
   * PUBLISHER authorization (the frozen platform_developer role — the
   * /api/apps + extension-portal precedent): the developer role or the
   * platform administrator; the internal service principal publishes
   * like every platform surface. Publishing is PLATFORM territory.
   *
   * MKT-051 DISCLOSED FIX (the first-party publish path — the identical
   * fix applied to /api/apps): the service principal's display label
   * ('Internal API token') does not satisfy the frozen 'svc:<label>'
   * publisher shape (migration 037 CHECK), so the label is SLUGGED here
   * the same way. Display-only normalization, zero authority semantics;
   * dev:<userId> publishes are byte-identical to the MKT-049 delivery.
   */
  function servicePrincipalPublisherLabel(label: string): string {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return slug.length > 0 ? slug : 'internal-service';
  }

  async function requireDeveloperRole(principal: Principal): Promise<AppPublisherIdentity> {
    if (principal.kind === 'service') {
      return { kind: 'platform_service', label: servicePrincipalPublisherLabel(principal.label) };
    }
    if (principal.kind !== 'user') {
      throw new ForbiddenError('Active user identity required');
    }
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (
      context.platformRoles.includes('platform_developer') ||
      context.platformRoles.includes('platform_administrator')
    ) {
      return { kind: 'platform_developer', userId: principal.userId };
    }
    throw new ForbiddenError(
      'Publishing an App Version requires the platform_developer or platform_administrator role',
    );
  }

  /** Any ACTIVE authenticated member (the global-catalog read posture). */
  async function requireActiveMember(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
  }

  /**
   * The manifest DTO spec — MIRRORS the /api/apps publish DTO exactly
   * (the frozen mos-app-ecosystem-v1.5.md §Manifest field contract with
   * the authority-field/material-key rejection lists; the module guard
   * is the single semantic enforcement point behind both surfaces).
   */
  function manifestSpec() {
    return {
      forbiddenKeys: PUBLISH_AUTHORITY_FIELDS,
      fields: {
        manifest: objectField({
          forbiddenKeys: MANIFEST_AUTHORITY_FIELDS,
          fields: {
            appKey: stringField({ pattern: KEY_PATTERN }),
            version: stringField({ pattern: SEMVER_PATTERN }),
            compatibility: objectField({
              fields: {
                minPlatform: stringField({ pattern: SEMVER_PATTERN }),
                maxPlatform: stringField({ pattern: SEMVER_PATTERN }),
              },
            }),
            capabilities: arrayField({
              minItems: 1,
              maxItems: 64,
              item: objectField({
                fields: {
                  name: stringField({ minLength: 1, maxLength: 64 }),
                  version: stringField({ pattern: SEMVER_PATTERN }),
                },
              }),
            }),
            inputSchema: recordField({ maxDepthKeys: 64 }),
            outputSchema: recordField({ maxDepthKeys: 64 }),
            dataScopes: arrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ pattern: DATA_SCOPE_PATTERN }),
            }),
            mutationScopes: arrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ pattern: MUTATION_SCOPE_PATTERN }),
            }),
            networkDestinations: arrayField({
              minItems: 0,
              maxItems: 32,
              item: objectField({
                fields: {
                  host: stringField({ minLength: 1, maxLength: 253 }),
                  protocol: stringField({ minLength: 1, maxLength: 16 }),
                  port: stringField({ pattern: /^(?:[1-9][0-9]{0,4})$/ }),
                  reason: stringField({ minLength: 1, maxLength: 256 }),
                },
              }),
            }),
            runtimeClass: stringField({ pattern: RUNTIME_CLASS_PATTERN }),
            eventSubscriptions: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            uiSurfaces: arrayField({
              minItems: 0,
              maxItems: 32,
              item: objectField({
                fields: {
                  surface: stringField({ pattern: UI_SURFACE_KIND_PATTERN }),
                  route: stringField({ pattern: UI_ROUTE_PATTERN }),
                },
              }),
            }),
            configSchema: recordField({ maxDepthKeys: 64 }),
            requiredCredentialNames: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ pattern: CREDENTIAL_NAME_PATTERN }),
            }),
            stateNamespaces: arrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ minLength: 1, maxLength: 120 }),
            }),
            migrationVersion: intField({ min: 0 }),
            dependencies: arrayField({
              minItems: 0,
              maxItems: 32,
              item: objectField({
                fields: {
                  kind: stringField({ pattern: /^(extension|app)$/ }),
                  publisher: nullableStringField({ pattern: PUBLISHER_LABEL_PATTERN }),
                  key: stringField({ pattern: KEY_PATTERN }),
                  minVersion: stringField({ pattern: SEMVER_PATTERN }),
                  maxVersion: stringField({ pattern: SEMVER_PATTERN }),
                },
              }),
            }),
            supportLevel: stringField({ minLength: 1, maxLength: 64 }),
            meteringDimensions: arrayField({
              minItems: 0,
              maxItems: 8,
              item: stringField({ pattern: METERING_DIMENSION_PATTERN }),
            }),
          },
        }),
        idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
        // MKT-049: the OPTIONAL publish-envelope hash attestation (the
        // module guard verifies the digest against the server-computed
        // canonical manifest fingerprint — fail-closed 422 on mismatch).
        signature: signatureField(),
      },
    };
  }

  type ValidatedPublish = {
    readonly manifest: {
      readonly appKey: string;
      readonly version: string;
      readonly compatibility: { readonly minPlatform: string; readonly maxPlatform: string };
      readonly capabilities: ReadonlyArray<{ readonly name: string; readonly version: string }>;
      readonly inputSchema: Record<string, unknown>;
      readonly outputSchema: Record<string, unknown>;
      readonly dataScopes: readonly string[];
      readonly mutationScopes: readonly string[];
      readonly networkDestinations: ReadonlyArray<{
        readonly host: string;
        readonly protocol: string;
        readonly port: string;
        readonly reason: string;
      }>;
      readonly runtimeClass: string;
      readonly eventSubscriptions: readonly string[];
      readonly uiSurfaces: ReadonlyArray<{ readonly surface: string; readonly route: string }>;
      readonly configSchema: Record<string, unknown>;
      readonly requiredCredentialNames: readonly string[];
      readonly stateNamespaces: readonly string[];
      readonly migrationVersion: number;
      readonly dependencies: ReadonlyArray<{
        readonly kind: string;
        readonly publisher: string | null | undefined;
        readonly key: string;
        readonly minVersion: string;
        readonly maxVersion: string;
      }>;
      readonly supportLevel: string;
      readonly meteringDimensions: readonly string[];
    };
    readonly idempotencyKey: string;
    readonly signature: { readonly algorithm: string; readonly digest: string } | null;
  };

  /** Rebuilds the typed manifest from the validated DTO (the apps-routes contract). */
  function deserializeManifest(dto: ValidatedPublish['manifest']): AppManifest {
    const configSchema: Record<string, AppConfigFieldContract> = {};
    const rawConfig = dto.configSchema as Record<string, unknown>;
    for (const [key, field] of Object.entries(rawConfig)) {
      if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
        const typed = field as {
          type?: unknown;
          required?: unknown;
          description?: unknown;
          pattern?: unknown;
        };
        configSchema[key] = {
          type: (typeof typed.type === 'string' &&
            ['string', 'number', 'boolean', 'object'].includes(typed.type)
            ? typed.type
            : 'string') as AppConfigFieldContract['type'],
          required: typed.required === true,
          description: typeof typed.description === 'string' ? typed.description : '',
          pattern: typeof typed.pattern === 'string' ? typed.pattern : null,
        };
      }
    }
    return {
      appKey: dto.appKey,
      version: dto.version,
      compatibility: {
        minPlatform: dto.compatibility.minPlatform,
        maxPlatform: dto.compatibility.maxPlatform,
      },
      capabilities: dto.capabilities.map(
        (capability): AppCapabilityDeclaration => ({
          name: capability.name,
          version: capability.version,
        }),
      ),
      inputSchema: dto.inputSchema,
      outputSchema: dto.outputSchema,
      dataScopes: dto.dataScopes as AppDataScope[],
      mutationScopes: dto.mutationScopes as AppMutationScope[],
      networkDestinations: dto.networkDestinations.map(
        (destination): AppNetworkDestination => ({
          host: destination.host,
          protocol: destination.protocol,
          port: Number(destination.port),
          reason: destination.reason,
        }),
      ),
      runtimeClass: dto.runtimeClass as AppRuntimeClass,
      eventSubscriptions: dto.eventSubscriptions,
      uiSurfaces: dto.uiSurfaces.map(
        (surface): AppUiSurfaceDeclaration => ({
          surface: surface.surface as AppUiSurfaceKind,
          route: surface.route,
        }),
      ),
      configSchema,
      requiredCredentialNames: dto.requiredCredentialNames,
      stateNamespaces: dto.stateNamespaces,
      migrationVersion: dto.migrationVersion,
      dependencies: dto.dependencies.map(
        (dependency): AppDependencyDeclaration => ({
          kind: dependency.kind as AppDependencyDeclaration['kind'],
          publisher:
            dependency.kind === 'extension'
              ? dependency.publisher === undefined || dependency.publisher === null
                ? ''
                : dependency.publisher
              : null,
          key: dependency.key,
          minVersion: dependency.minVersion,
          maxVersion: dependency.maxVersion,
        }),
      ),
      supportLevel: dto.supportLevel,
      meteringDimensions: dto.meteringDimensions as AppMeteringDimension[],
    };
  }

  // -------------------------------------------------------------------------
  // GET /api/developer-portal/catalog — the developer catalog
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/developer-portal/catalog',
    defineQueryRoute<Record<string, string>, readonly AppVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async () => {
        // THIN delegation: the /apps registry authority listing (the
        // portal owns NO catalog state of its own).
        return modules.apps.listAppVersions({ appKey: null });
      },
      respond: (ctx) => {
        // The developer rollup derived from the authority listing:
        // distinct app keys, version counts, the newest version (REAL
        // semver ordering) + the publication-newest record.
        const byKey = new Map<string, AppVersionRecord[]>();
        for (const record of ctx.result) {
          const list = byKey.get(record.appKey) ?? [];
          list.push(record);
          byKey.set(record.appKey, list);
        }
        const apps = [...byKey.entries()].map(([appKey, versions]) => {
          let newest = versions[0]!;
          for (const candidate of versions) {
            if (compareSemver(candidate.manifest.version, newest.manifest.version) > 0) {
              newest = candidate;
            }
          }
          return {
            appKey,
            publisher: versions[0]!.publisher,
            versionCount: versions.length,
            newestVersion: newest.manifest.version,
            newestByPublication: serializeAppVersion(versions[0]!),
            certificationState: newest.certificationState,
          };
        });
        return jsonResponse(200, { apps });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/developer-portal/apps/:appKey/versions — the version
  // history view (thin delegation; malformed key → uniform 404)
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/developer-portal/apps/:appKey/versions',
    defineQueryRoute<{ appKey: string }, readonly AppVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        if (!KEY_PATTERN.test(ctx.params.appKey)) {
          throw new NotFoundError('app key', ctx.params.appKey);
        }
        // THIN delegation: the authority's version-history listing (the
        // same semantics as the direct GET /api/apps/:appKey/versions —
        // an unknown but well-formed key lists empty; the exact-version
        // read below is the uniform-404 surface).
        return modules.apps.listAppVersions({ appKey: ctx.params.appKey });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          appKey: ctx.params.appKey,
          versions: ctx.result.map(serializeAppVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/developer-portal/apps/:appKey/versions/:version — the
  // developer version view: manifest + VALIDATION STATUS + vocabulary
  // annotations (unknown/malformed → uniform 404)
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/developer-portal/apps/:appKey/versions/:version',
    defineQueryRoute<{ appKey: string; version: string }, AppVersionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        if (!KEY_PATTERN.test(ctx.params.appKey) || !SEMVER_PATTERN.test(ctx.params.version)) {
          throw new NotFoundError('app version', `${ctx.params.appKey}@${ctx.params.version}`);
        }
        // THIN delegation: the authority's exact-version read.
        const record = await modules.apps.findAppVersion(ctx.params.appKey, ctx.params.version);
        if (record === null) {
          throw new NotFoundError('app version', `${ctx.params.appKey}@${ctx.params.version}`);
        }
        return record;
      },
      respond: (ctx) => {
        const record = ctx.result;
        // The VALIDATION STATUS: a published version passed the registry
        // guard at publish (published = validated); the INTEGRITY check
        // recomputes the canonical manifest fingerprint against the row's
        // persisted createFingerprint — the immutable-row anchor of the
        // MKT-049 signing step (a mismatch would mean the stored manifest
        // no longer matches its attested/persisted digest).
        const digest = appCreateFingerprint(record.manifest);
        return jsonResponse(200, {
          ...serializeAppVersion(record),
          validationStatus: {
            published: true,
            manifestValidAtPublish: true,
            integrity: {
              algorithm: 'manifest-sha256-fingerprint',
              digest: record.createFingerprint,
              verified: digest === record.createFingerprint,
            },
          },
          // The documentation annotations generated from THIS manifest +
          // the frozen contract meanings.
          vocabulary: vocabularyAnnotations(record),
        });
      },
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/developer-portal/validate — ONLINE validation through the
  // REAL registry guard (PURE: no state change, no audit — the
  // POST /api/apps/compatibility pure-read precedent)
  // -------------------------------------------------------------------------

  type ValidatedValidate = {
    readonly manifest: Record<string, unknown>;
    readonly signature: { readonly algorithm: string; readonly digest: string } | null;
  };

  router.add(
    'POST',
    '/api/developer-portal/validate',
    defineQueryRoute<Record<string, string>, Record<string, unknown>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        // The envelope DTO: the manifest rides as a RAW bounded object so
        // the AUTHORITY GUARD is the one that speaks (its unknown-field,
        // authority-field, material-key and closed-vocabulary problems
        // are the validation verdict — not the DTO layer's). Only the
        // envelope itself is DTO-fenced (authority-shaped + material keys).
        const body = validateObject<ValidatedValidate>(ctx.request.body, {
          forbiddenKeys: [
            'appVersionId',
            'publisher',
            'certificationState',
            'idempotencyKey',
            'provenance',
            ...MATERIAL_KEYS,
          ],
          fields: {
            manifest: recordField({ maxDepthKeys: 256 }),
            signature: signatureField(),
          },
        });
        const manifest = body.manifest as unknown as AppManifest;
        let valid = true;
        let problems: string[] = [];
        let rejectionClass: 'certification-territory' | 'invalid' | null = null;
        try {
          // The REAL registry guard (the single semantic enforcement
          // point — the same function publishAppVersion runs).
          assertValidAppManifest(manifest);
        } catch (error) {
          valid = false;
          if (error instanceof ForbiddenError) {
            // Certification territory: the registry answers 403 for
            // caller-supplied certification state.
            rejectionClass = 'certification-territory';
            problems = [error.message];
          } else if (error instanceof InvalidRequestError) {
            rejectionClass = 'invalid';
            problems = [...(error.details ?? [error.message])];
          } else {
            throw error;
          }
        }
        // The OPTIONAL signature verification (the same guard publish
        // runs — pure; verified only when a signature is supplied).
        let signature: Record<string, unknown> | null = null;
        const suppliedSignature = body.signature ?? null;
        if (suppliedSignature !== null) {
          const signatureProblems = appManifestSignatureProblems(manifest, {
            algorithm: suppliedSignature.algorithm as AppSignatureAlgorithm,
            digest: suppliedSignature.digest,
          });
          problems = [...problems, ...signatureProblems];
          if (signatureProblems.length > 0) valid = false;
          signature = {
            algorithm: suppliedSignature.algorithm,
            digest: suppliedSignature.digest,
            verified: signatureProblems.length === 0,
          };
        }
        return {
          valid,
          problems,
          ...(rejectionClass === null ? {} : { rejectionClass }),
          ...(signature === null ? {} : { signature }),
        };
      },
      respond: (ctx) => jsonResponse(200, ctx.result),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/developer-portal/publish — the delegated publish (the SAME
  // /apps registry publish command; platform_developer; optional
  // signature verified by the authority)
  // -------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/developer-portal/publish',
    defineMutationRoute<Record<string, string>, { record: AppVersionRecord; signature: { algorithm: string; digest: string } | null }>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        // PLATFORM TERRITORY: the frozen developer role gate. The
        // SERVER-DERIVED publisher identity is resolved in execute from
        // the SAME authenticated principal — it is NEVER a request field.
        await requireDeveloperRole(ctx.principal);
      },
      validate: (ctx) =>
        validateObject<ValidatedPublish>(ctx.request.body, manifestSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedPublish;
        const identity = await requireDeveloperRole(ctx.principal);
        // Absent optional field arrives as undefined (validateObject skips
        // absent fields) — normalize to the explicit null envelope.
        const signature = body.signature ?? null;
        // THIN DELEGATION to the /apps registry publish command — the
        // portal NEVER publishes through its own path (one authority,
        // multiple route families; the publish remains immutable-versioned
        // with server-derived publisher identity and born-UNVERIFIED
        // certification — MKT-047 semantics).
        const record = await modules.apps.publishAppVersion({
          manifest: deserializeManifest(body.manifest),
          identity,
          idempotencyKey: body.idempotencyKey,
          ...(signature === null
            ? { signature: null }
            : {
                signature: {
                  algorithm: signature.algorithm as AppSignatureAlgorithm,
                  digest: signature.digest,
                } satisfies AppManifestSignature,
              }),
        });
        return { record, signature };
      },
      emit: async (ctx) => {
        logger.info('developer-portal.app.published', undefined, {
          app_version_id: ctx.result.record.appVersionId,
          app_key: ctx.result.record.appKey,
          version: ctx.result.record.manifest.version,
          publisher: ctx.result.record.publisher,
          certification_state: ctx.result.record.certificationState,
          signed: ctx.result.signature !== null,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'developer_portal.app.published',
          targetType: 'app_version',
          targetId: ctx.result.record.appVersionId,
          idempotencyKey: `developer_portal.app.published:${ctx.result.record.appVersionId}`,
          details: {
            appKey: ctx.result.record.appKey,
            version: ctx.result.record.manifest.version,
            publisher: ctx.result.record.publisher,
            certificationState: ctx.result.record.certificationState,
            signed: ctx.result.signature !== null,
            capabilities: ctx.result.record.manifest.capabilities.length,
            dependencies: ctx.result.record.manifest.dependencies.length,
            stateNamespaces: ctx.result.record.manifest.stateNamespaces.length,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(201, {
          appVersion: serializeAppVersion(ctx.result.record),
          // The signature acceptance disclosure: when the caller signed,
          // the authority verified the digest against the server-computed
          // canonical fingerprint before any write (a mismatch would have
          // been a 422 with zero rows — reaching 201 means verified).
          ...(ctx.result.signature === null || ctx.result.signature === undefined
            ? { signature: null }
            : {
                signature: {
                  algorithm: ctx.result.signature.algorithm,
                  digest: ctx.result.signature.digest,
                  verified: true,
                },
              }),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/developer-portal/docs — the DOCUMENTATION SURFACE (derived
  // read-only from the frozen /apps public contract; NO runtime mutation)
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/developer-portal/docs',
    defineQueryRoute<Record<string, string>, Record<string, unknown>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async () => {
        // PURE derivation from the frozen authority contract exports —
        // no state is read or mutated: the documentation is a function
        // of the frozen constants (the closed vocabularies + meanings)
        // and the frozen manifest-schema field table.
        return {};
      },
      respond: () =>
        jsonResponse(200, {
          title: 'MOS App SDK and Developer Portal — developer documentation',
          generatedFrom:
            'the frozen /apps registry public contract (spec/mos-app-ecosystem-v1.5.md Manifest + the MKT-047 closed vocabularies) — derived at read time, no runtime mutation',
          manifestFields: DEVELOPER_PORTAL_MANIFEST_FIELD_DOCS,
          vocabularies: {
            certificationStates: Object.entries(APP_CERTIFICATION_STATE_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
            runtimeClasses: Object.entries(APP_RUNTIME_CLASS_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
            dataScopes: Object.entries(APP_DATA_SCOPE_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
            mutationScopes: Object.entries(APP_MUTATION_SCOPE_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
            uiSurfaceKinds: Object.entries(APP_UI_SURFACE_KIND_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
            meteringDimensions: Object.entries(APP_METERING_DIMENSION_MEANINGS).map(([value, meaning]) => ({
              value,
              meaning,
            })),
          },
          signature: {
            algorithms: ['manifest-sha256-fingerprint'],
            description:
              'The optional publish-envelope hash attestation: sha256 over the canonical manifest (keys sorted at every level) + the mkt-047 domain suffix — the identical digest the registry computes server-side, persists as the immutable row\'s createFingerprint and verifies at publish (mismatch → 422, zero rows). Sign offline: node tools/app-sdk/cli.ts sign <project-dir>.',
          },
          portalEndpoints: PORTAL_ENDPOINT_DOCS,
          developerWorkflow: [
            'scaffold — node tools/app-sdk/cli.ts scaffold <dir> --app-key <key>',
            'validate (offline) — node tools/app-sdk/cli.ts validate <dir>',
            'test — node --test \'<dir>/tests/*.test.ts\'',
            'sign (optional) — node tools/app-sdk/cli.ts sign <dir> (writes signature.json)',
            'publish — node tools/app-sdk/cli.ts publish <dir> --base-url <url> --token <token> --idempotency-key <key>',
            'document — this route (served) or node tools/app-sdk/cli.ts docs (offline)',
          ],
          sdk: {
            location: 'tools/app-sdk/',
            cli: 'node tools/app-sdk/cli.ts help',
            posture: 'standalone outbound artifact — no MOS core module imports it; drift-pinned to the /apps public contract by tests/unit/app-sdk-drift.test.ts',
          },
        }),
    }),
  );
}
