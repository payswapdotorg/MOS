/**
 * /api/apps APP REGISTRY routes (MKT-047 — App Manifest and Packaging v1:
 * the App registry authority for manifests).
 *
 *   POST /api/apps                                        publish a NEW immutable App Version (platform_developer | platform_administrator — the frozen Platform Developer/Extension Publisher role, the MKT-032 extension-portal precedent; the internal service principal publishes like every platform surface). Publisher identity is SERVER-DERIVED from the authenticated principal; the certification state is born UNVERIFIED (platform territory).
 *   GET  /api/apps                                        the published version catalog, newest first (any active member)
 *   GET  /api/apps/:appKey/versions                       the VERSION HISTORY of one app key, newest first (any active member)
 *   GET  /api/apps/:appKey/versions/:version              read the manifest by EXACT (app key, semantic version) — the frozen read contract of MKT-047 AC-8 (any active member; unknown → 404)
 *   POST /api/apps/compatibility                          the COMPATIBILITY QUERY: given the runtime's platform version, an optional runtime class and the available extension versions → the eligible app versions + honest per-version ineligibility reasons (any active member; pure read — no audit, no state change)
 *
 * NO UPDATE ROUTE. NO DELETE ROUTE. Published App Versions are immutable
 * (mos-app-ecosystem-v1.5.md "Upgrade and rollback"; architecture-lock
 * v1.5 #11): corrections publish a NEW version; certification
 * transitions are the future MKT-050 platform marketplace/trust surface,
 * never a route here. The route surface is exactly the five frozen
 * routes above (asserted by tests/architecture/apps-boundary.test.ts).
 *
 * Server-derived authority posture (implementation-contract §3/§23; the
 * domain-packs/extension-portal precedents): publishing is PLATFORM
 * territory (the frozen platform_developer role); reads are open to
 * AUTHENTICATED ACTIVE MEMBERS (the global-catalog posture of the
 * /extensions and /domain-packs registries — the catalog is global read
 * state for tenant members; the choice is documented in the runbook);
 * every mutating route resolves the caller's authorization context from
 * durable state BEFORE validate/execute; identity, publisher,
 * certification, provenance and lifecycle fields are NEVER
 * request-suppliable (the DTOs reject them explicitly plus every
 * material-shaped key — §21); the module input guard is the single
 * semantic enforcement point behind the DTO (certification-shaped keys
 * are 403 there — platform territory).
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
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
  AppCapabilityDeclaration,
  AppConfigFieldContract,
  AppDependencyDeclaration,
  AppManifest,
  AppNetworkDestination,
  AppPublisherIdentity,
  AppUiSurfaceDeclaration,
  AppUiSurfaceKind,
  AppVersionRecord,
} from '../modules/apps/public.ts';
import type { AppRuntimeClass, AppDataScope, AppMutationScope, AppMeteringDimension } from '../modules/apps/public.ts';

/**
 * An optional field that accepts an EXPLICIT null (the "no value" form —
 * e.g. an app dependency's absent publisher, a compatibility query's
 * absent runtime-class filter) in addition to omission.
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
 * Material-shaped keys rejected on EVERY /apps surface (§21/CRED-001 —
 * the store guard and the migration-037 CHECK functions enforce the
 * identical set behind the DTO).
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
 * key, so no secret VALUE can be smuggled into an app manifest through
 * the route surface either (the module input guard remains the single
 * semantic enforcement point).
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

/**
 * Authority-shaped keys rejected INSIDE the manifest object (the same
 * contract at the nested level — a publisher/tenant/provenance/cert
 * value smuggled into the manifest is a 422 at the route surface and a
 * 403 for certification at the module guard).
 */
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
// Serialization (opaque, non-secret representations)
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

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAppsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('apps.api');

  /**
   * PUBLISHER authorization (the MKT-032 extension-portal precedent): the
   * frozen platform_developer role ("Platform Developer/Extension
   * Publisher ... wired by later extension Work Items") or the platform
   * administrator; the internal service principal publishes like every
   * platform surface. Publishing is PLATFORM territory (MKT-047 AC-8).
   */
  async function requireDeveloperRole(principal: Principal): Promise<AppPublisherIdentity> {
    if (principal.kind === 'service') {
      return { kind: 'platform_service', label: principal.label };
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
   * The manifest DTO spec: the frozen mos-app-ecosystem-v1.5.md §Manifest
   * field contract — app key, semantic version + compatibility range,
   * capabilities + capability versions, input/output schemas, requested
   * data/mutation scopes (closed vocabularies), network destinations,
   * runtime class, event subscriptions, UI surfaces + routes,
   * configuration schema, credential references BY LOGICAL NAME,
   * app-owned state namespaces, migration version, dependencies, support
   * level and metering dimensions. Identity, publisher, certification,
   * provenance and lifecycle are SERVER-DERIVED; material-shaped keys
   * are rejected everywhere (§21). The module guard remains the single
   * semantic enforcement point behind this surface-level hygiene.
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
  };

  /** Rebuilds the typed manifest from the validated DTO. */
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
  // POST /api/apps — publish one immutable App Version (platform_developer)
  // -------------------------------------------------------------------------

  router.add(
    'POST',
    '/api/apps',
    defineMutationRoute<Record<string, string>, AppVersionRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        // PLATFORM TERRITORY (AC-8): the frozen developer role gate.
        // The SERVER-DERIVED publisher identity is resolved in execute
        // from the SAME authenticated principal (AC-5) — it is NEVER a
        // request field, and authorization runs BEFORE validate/execute.
        await requireDeveloperRole(ctx.principal);
      },
      validate: (ctx) =>
        validateObject<ValidatedPublish>(ctx.request.body, manifestSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedPublish;
        const identity = await requireDeveloperRole(ctx.principal);
        return modules.apps.publishAppVersion({
          manifest: deserializeManifest(body.manifest),
          identity,
          idempotencyKey: body.idempotencyKey,
        });
      },
      emit: async (ctx) => {
        logger.info('apps.version.published', undefined, {
          app_version_id: ctx.result.appVersionId,
          app_key: ctx.result.appKey,
          version: ctx.result.manifest.version,
          publisher: ctx.result.publisher,
          certification_state: ctx.result.certificationState,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'apps.version.published',
          targetType: 'app_version',
          targetId: ctx.result.appVersionId,
          idempotencyKey: `apps.version.published:${ctx.result.appVersionId}`,
          details: {
            appKey: ctx.result.appKey,
            version: ctx.result.manifest.version,
            publisher: ctx.result.publisher,
            certificationState: ctx.result.certificationState,
            capabilities: ctx.result.manifest.capabilities.length,
            dependencies: ctx.result.manifest.dependencies.length,
            stateNamespaces: ctx.result.manifest.stateNamespaces.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeAppVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/apps — the published version catalog (any active member)
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/apps',
    defineQueryRoute<Record<string, string>, readonly AppVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async () => {
        return modules.apps.listAppVersions({ appKey: null });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          apps: ctx.result.map(serializeAppVersion),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/apps/:appKey/versions — the version history of one app key
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/apps/:appKey/versions',
    defineQueryRoute<{ appKey: string }, readonly AppVersionRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        if (!KEY_PATTERN.test(ctx.params.appKey)) {
          throw new NotFoundError('app key', ctx.params.appKey);
        }
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
  // GET /api/apps/:appKey/versions/:version — read the manifest by EXACT
  // (app key, semantic version)
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/apps/:appKey/versions/:version',
    defineQueryRoute<{ appKey: string; version: string }, AppVersionRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        if (!KEY_PATTERN.test(ctx.params.appKey) || !SEMVER_PATTERN.test(ctx.params.version)) {
          throw new NotFoundError('app version', `${ctx.params.appKey}@${ctx.params.version}`);
        }
        const record = await modules.apps.findAppVersion(ctx.params.appKey, ctx.params.version);
        if (record === null) {
          throw new NotFoundError('app version', `${ctx.params.appKey}@${ctx.params.version}`);
        }
        return record;
      },
      respond: (ctx) => jsonResponse(200, serializeAppVersion(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/apps/compatibility — the compatibility query (AC-8):
  // given runtime/extension versions → the eligible app versions.
  // A PURE READ with a structured body (no audit emit, no state change).
  // -------------------------------------------------------------------------

  type ValidatedCompatibilityQuery = {
    readonly platformVersion: string;
    readonly runtimeClass: string | null | undefined;
    readonly extensionVersions: ReadonlyArray<{
      readonly publisher: string;
      readonly extensionKey: string;
      readonly version: string;
    }>;
  };

  router.add(
    'POST',
    '/api/apps/compatibility',
    defineQueryRoute<Record<string, string>, Awaited<ReturnType<typeof modules.apps.queryCompatibleAppVersions>>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireActiveMember(ctx.principal);
      },
      execute: async (ctx) => {
        const query = validateObject<ValidatedCompatibilityQuery>(ctx.request.body, {
          forbiddenKeys: [
            'appKey',
            'appVersionId',
            'publisher',
            'certificationState',
            'provenance',
            ...MATERIAL_KEYS,
          ],
          fields: {
            platformVersion: stringField({ pattern: SEMVER_PATTERN }),
            runtimeClass: nullableStringField({ pattern: RUNTIME_CLASS_PATTERN }),
            extensionVersions: arrayField({
              minItems: 0,
              maxItems: 256,
              item: objectField({
                fields: {
                  publisher: stringField({ pattern: PUBLISHER_LABEL_PATTERN }),
                  extensionKey: stringField({ pattern: KEY_PATTERN }),
                  version: stringField({ pattern: SEMVER_PATTERN }),
                },
              }),
            }),
          },
        });
        return modules.apps.queryCompatibleAppVersions({
          platformVersion: query.platformVersion,
          runtimeClass:
            query.runtimeClass === undefined || query.runtimeClass === null
              ? null
              : (query.runtimeClass as AppRuntimeClass),
          extensionVersions: query.extensionVersions,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          eligible: ctx.result.eligible.map(serializeAppVersion),
          ineligible: ctx.result.ineligible.map((entry) => ({
            appVersion: serializeAppVersion(entry.record),
            reasons: entry.reasons,
          })),
        }),
    }),
  );
}
