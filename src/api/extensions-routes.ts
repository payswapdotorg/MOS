/**
 * /extensions API routes (MKT-022 — extension registry and manifest
 * contract: EXT-001).
 *
 *   POST /api/extensions                                    publish a version (platform admin OR agency owner|admin — the internal-team posture; the Developer Portal is MKT-032)
 *   GET  /api/extensions                                    list published versions (any active member)
 *   GET  /api/extensions/:extensionId                       read one version (any active member)
 *
 *   POST /api/workspaces/:workspaceId/extension-installs             install a version into the workspace (owner|admin of the owning agency|platform admin)
 *   GET  /api/workspaces/:workspaceId/extension-installs             the workspace installs in ALL states (any active member)
 *   GET  /api/workspaces/:workspaceId/extension-installs/:installId  read one install (any active member; uniform 404 for foreign)
 *   POST /api/workspaces/:workspaceId/extension-installs/:installId/configure   validate+store config against the manifest config contract (owner|admin)
 *   POST /api/workspaces/:workspaceId/extension-installs/:installId/authorize   the authorize edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/extension-installs/:installId/disable     the disable edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/extension-installs/:installId/uninstall   the terminal uninstall edge (owner|admin)
 *
 *   POST /api/executions/:executionId/extension-invocations  DERIVE the short-lived invocation context (any active member of the execution's owning agency — the scope is always the execution's canonical owner, never caller-supplied)
 *   GET  /api/workspaces/:workspaceId/extension-invocations  the workspace invocation ledger (any active member)
 *   GET  /api/extension-invocations/:invocationId            read one invocation record (member of the owning agency; uniform 404 for foreign)
 *
 * Server-derived authority posture (implementation-contract §3/§23): every
 * mutation route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /workspaces or /executions canonical
 * ownership chain), authorizes against the SAME /agencies membership
 * authority as every other scoped check (no second authorization
 * authority) and yields a UNIFORM 404 for unknown/foreign identifiers (no
 * cross-tenant oracle). Identity, scope, lifecycle, provenance and policy
 * posture fields are NEVER request-suppliable — the DTOs reject them
 * explicitly, and the invocation input additionally rejects material-
 * shaped keys (§21) and authority-shaped keys (§3).
 */

import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import {
  defineMutationRoute,
  defineQueryRoute,
  jsonResponse,
  type OwnerScope,
} from '../platform/http/pipeline.ts';
import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { currentCorrelation } from '../platform/observability/correlation.ts';
import {
  arrayField,
  intField,
  objectField,
  optionalString,
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireExecutionAccess, requirePlatformAdministrator, requireWorkspaceAccess, resolveContext } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  ExtensionInstallRecord,
  ExtensionInvocationContext,
  ExtensionInvocationRecord,
  ExtensionRegistryRecord,
} from '../modules/extensions/public.ts';
import { isInvocationContextExpired } from '../modules/extensions/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_PATTERN = /^(client:read|client:write|workspace:read|workspace:write)$/;
const CAPABILITY_NAME_PATTERN = /^.{1,64}$/;
const CREDENTIAL_REF_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._:-]{0,63}$/;

/**
 * Fields always server-derived on REGISTRATION — plus every
 * material-shaped key is rejected so no secret VALUE can be smuggled into
 * a manifest (requiredSecretNames are logical names only — CRED-001).
 */
const REGISTRATION_AUTHORITY_FIELDS = [
  'extensionId',
  'createFingerprint',
  'createdBy',
  'createdAt',
  'updatedAt',
  // Provenance is SERVER-DERIVED — never a request field.
  'provenance',
  'actor',
  'correlationId',
  'causationId',
  'recordedAt',
  // Material-shaped keys are rejected outright on every extensions surface.
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on INSTALL (scope, identity, lifecycle). */
const INSTALL_AUTHORITY_FIELDS = [
  'installId',
  'agencyId',
  'clientId',
  'workspaceId',
  'scope',
  'status',
  'config',
  'secretBindings',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uninstalledAt',
  'provenance',
  'policyDecisionId',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on CONFIGURE. */
const CONFIGURE_AUTHORITY_FIELDS = [
  'installId',
  'status',
  'grantedScopes',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'provenance',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Fields always server-derived on the STATUS edges. */
const STATUS_AUTHORITY_FIELDS = [
  'status',
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uninstalledAt',
  'provenance',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Fields always server-derived on INVOCATION: the invocation identity,
 * the tenant scope, the granted capability set, the granted data scopes,
 * the policy posture, the runtime class and the whole provenance block —
 * a caller can never supply ANY of them (the context is derived from the
 * execution's canonical owner and the installed manifest, §3/§19). The
 * invocation INPUT is a separate bounded object with its own rejection
 * set (below) — an extension can never smuggle provenance, scope or
 * authority fields through it (EXT-AC-02/EXT-AC-04).
 */
const INVOCATION_AUTHORITY_FIELDS = [
  'invocationId',
  'extensionKey',
  'publisher',
  'version',
  'installId',
  'scope',
  'agencyId',
  'clientId',
  'workspaceId',
  'grantedCapabilities',
  'grantedDataScopes',
  'grantedScopes',
  'policyDecisionId',
  'policyOutcome',
  'runtimeClass',
  'inputContract',
  'outputContract',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'issuedAt',
  'expiresAt',
  'recordedAt',
  'replayed',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/**
 * Authority-shaped keys rejected INSIDE the invocation input payload:
 * invocation identity, tenant scope and provenance are server-derived —
 * an extension invocation can never assert them (EXT-AC-04: provenance
 * fabrication; EXT-AC-02: scope smuggling).
 */
const INVOCATION_INPUT_FORBIDDEN_KEYS = [
  'invocationId',
  'extensionId',
  'installId',
  'executionId',
  'scope',
  'agencyId',
  'clientId',
  'workspaceId',
  'grantedCapabilities',
  'grantedDataScopes',
  'grantedScopes',
  'policyDecisionId',
  'policyOutcome',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'issuedAt',
  'expiresAt',
  'recordedAt',
  'runtimeClass',
  'evidenceId',
  'evidenceRef',
  'actorProvenance',
  'collectedBy',
  'secret',
  'secretMaterial',
  'material',
  'password',
  'token',
  'apiKey',
  'api_key',
  'accessKey',
  'secretHandle',
] as const;

/** Server-derived provenance for HTTP surfaces (never a request field). */
function serverProvenance(principal: Principal): {
  readonly actor: string;
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
} {
  const correlation = currentCorrelation();
  return {
    actor: auditActor(principal),
    recordedVia: 'api',
    correlationId: correlation.correlationId,
    causationId: correlation.causationId,
  };
}

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations)
// ---------------------------------------------------------------------------

function serializeExtension(record: ExtensionRegistryRecord): Record<string, unknown> {
  return {
    extensionId: record.extensionId,
    manifest: {
      extensionKey: record.manifest.extensionKey,
      publisher: record.manifest.publisher,
      version: record.manifest.version,
      compatibility: record.manifest.compatibility,
      capabilities: record.manifest.capabilities,
      permissions: record.manifest.permissions,
      requiredSecretNames: record.manifest.requiredSecretNames,
      dataScopes: record.manifest.dataScopes,
      networkRequirements: record.manifest.networkRequirements,
      runtimeClass: record.manifest.runtimeClass,
      inputContract: record.manifest.inputContract,
      outputContract: record.manifest.outputContract,
      eventSubscriptions: record.manifest.eventSubscriptions,
      uiSurfaces: record.manifest.uiSurfaces,
      configContract: record.manifest.configContract,
    },
    idempotencyKey: record.idempotencyKey,
    createFingerprint: record.createFingerprint,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeInstall(record: ExtensionInstallRecord): Record<string, unknown> {
  return {
    installId: record.installId,
    extensionId: record.extensionId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    status: record.status,
    config: record.config,
    secretBindings: record.secretBindings,
    grantedScopes: record.grantedScopes,
    idempotencyKey: record.idempotencyKey,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeInvocationContext(context: ExtensionInvocationContext): Record<string, unknown> {
  return {
    invocationId: context.invocationId,
    extensionId: context.extensionId,
    extensionKey: context.extensionKey,
    version: context.version,
    installId: context.installId,
    executionId: context.executionId,
    scope: context.scope,
    grantedCapabilities: context.grantedCapabilities,
    grantedDataScopes: context.grantedDataScopes,
    policyDecisionId: context.policyDecisionId,
    policyOutcome: 'allow',
    runtimeClass: context.runtimeClass,
    input: context.input,
    provenance: context.provenance,
    issuedAt: context.issuedAt,
    expiresAt: context.expiresAt,
    // The honest lifetime statement: the context is short-lived; this
    // field is derived, not a request field.
    expired: isInvocationContextExpired({ expiresAt: context.expiresAt }, new Date().toISOString()),
  };
}

function serializeInvocationRecord(record: ExtensionInvocationRecord): Record<string, unknown> {
  return {
    invocationId: record.invocationId,
    extensionId: record.extensionId,
    extensionKey: record.extensionKey,
    version: record.version,
    installId: record.installId,
    executionId: record.executionId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    grantedCapabilities: record.grantedCapabilities,
    grantedDataScopes: record.grantedDataScopes,
    policyDecisionId: record.policyDecisionId,
    policyOutcome: record.policyOutcome,
    input: record.input,
    provenance: {
      actor: record.recordedActor,
      recordedVia: record.recordedVia,
      correlationId: record.correlationId,
      ...(record.causationId === null ? {} : { causationId: record.causationId }),
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      recordedAt: record.recordedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerExtensionsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('extensions.api');

  /** Canonical workspace owner scope; 404 BEFORE dependent traversal. */
  async function workspaceOwner(workspaceId: string): Promise<OwnerScope> {
    const ownership = await modules.workspaces.resolveWorkspaceOwnership(workspaceId);
    if (ownership === null) {
      throw new NotFoundError('workspace', workspaceId);
    }
    return {
      kind: 'workspace',
      agencyId: ownership.scope.agencyId,
      clientId: ownership.scope.clientId,
      workspaceId: ownership.scope.workspaceId,
    };
  }

  /**
   * The install-scoped owner: the install row → its workspace → client →
   * agency, resolved from durable state BEFORE authorize (uniform 404 for
   * foreign/unknown; the install's scope is immutable, so it always
   * matches the workspace path).
   */
  async function installOwner(workspaceId: string, installId: string): Promise<OwnerScope> {
    const install = await modules.extensions.getExtensionInstall(installId);
    if (install === null || install.workspaceId !== workspaceId) {
      throw new NotFoundError('extension install', installId);
    }
    return {
      kind: 'workspace',
      agencyId: install.agencyId,
      clientId: install.clientId,
      workspaceId: install.workspaceId,
    };
  }

  /**
   * Publisher authorization: platform administrators pass; otherwise the
   * caller needs an ACTIVE agency membership with the owner/admin role in
   * SOME agency (internal teams publish before the Developer Portal
   * arrives — MKT-032). The registry itself stays global catalog state.
   */
  async function requirePublisherRole(principal: Principal): Promise<void> {
    if (principal.kind === 'service') return;
    const context = await requirePlatformAdministrator(modules, principal).catch(() => null);
    if (context !== null) return;
    const userContext = await resolveContext(modules, principal);
    if (userContext === null || userContext.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    const publisherMembership = userContext.memberships.find(
      (entry) => entry.membershipStatus === 'active' && (entry.role === 'agency_owner' || entry.role === 'agency_admin'),
    );
    if (publisherMembership === undefined) {
      throw new ForbiddenError('Publishing an extension version requires the platform administrator role or an active agency owner/admin membership');
    }
  }

  /**
   * The shared manifest DTO spec: the frozen EXT-001 field contract —
   * identity (key/publisher/version), compatibility range, the §3
   * capability list, the §5 permission list, required secret LOGICAL
   * NAMES, data scopes, network requirements, runtime class, the
   * input/output contracts, event subscriptions, UI surfaces and the
   * config contract. Identity, provenance and lifecycle are
   * server-derived.
   */
  function manifestSpec() {
    return {
      forbiddenKeys: REGISTRATION_AUTHORITY_FIELDS,
      fields: {
        manifest: objectField({
          fields: {
            extensionKey: stringField({ pattern: /^[a-z][a-z0-9-]{1,62}$/ }),
            publisher: stringField({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
            version: stringField({ pattern: /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/ }),
            compatibility: objectField({
              fields: {
                minPlatform: stringField({ minLength: 1, maxLength: 32 }),
                maxPlatform: stringField({ minLength: 1, maxLength: 32 }),
              },
            }),
            capabilities: arrayField({
              minItems: 1,
              maxItems: 32,
              item: objectField({
                fields: {
                  category: stringField({
                    pattern: /^(data-source|research-discovery|content-creative-generation|execution-action|measurement|crm-commerce-integration|field-acquisition|ai-capability|approval-ui-surface)$/,
                  }),
                  name: stringField({ minLength: 1, maxLength: 64 }),
                },
              }),
            }),
            permissions: arrayField({
              minItems: 1,
              maxItems: 64,
              item: objectField({
                fields: {
                  action: stringField({ pattern: /^(data:read|data:write|network:egress|secret:use)$/ }),
                  resource: optionalString({ minLength: 1, maxLength: 256 }),
                },
              }),
            }),
            requiredSecretNames: arrayField({
              minItems: 0,
              maxItems: 16,
              item: stringField({ pattern: /^[A-Z][A-Z0-9_]{2,47}$/ }),
            }),
            dataScopes: arrayField({
              minItems: 0,
              maxItems: 8,
              item: stringField({ pattern: SCOPE_PATTERN }),
            }),
            networkRequirements: arrayField({
              minItems: 0,
              maxItems: 16,
              item: objectField({
                fields: {
                  host: stringField({ minLength: 1, maxLength: 253 }),
                  protocol: stringField({ minLength: 1, maxLength: 16 }),
                  port: stringField({ pattern: /^(?:[1-9][0-9]{0,4})$/ }),
                  reason: stringField({ minLength: 1, maxLength: 256 }),
                },
              }),
            }),
            runtimeClass: stringField({
              pattern: /^(pooled-worker|ephemeral-sandbox|persistent-sandbox|dedicated-runtime)$/,
            }),
            inputContract: recordField({ maxDepthKeys: 32 }),
            outputContract: recordField({ maxDepthKeys: 32 }),
            eventSubscriptions: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            uiSurfaces: arrayField({
              minItems: 0,
              maxItems: 32,
              item: stringField({ minLength: 1, maxLength: 64 }),
            }),
            configContract: recordField({ maxDepthKeys: 32 }),
          },
        }),
        idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
      },
    };
  }

  type ValidatedRegistration = {
    readonly manifest: {
      readonly extensionKey: string;
      readonly publisher: string;
      readonly version: string;
      readonly compatibility: { readonly minPlatform: string; readonly maxPlatform: string };
      readonly capabilities: ReadonlyArray<{ readonly category: string; readonly name: string }>;
      readonly permissions: ReadonlyArray<{ readonly action: string; readonly resource: string | undefined }>;
      readonly requiredSecretNames: readonly string[];
      readonly dataScopes: readonly string[];
      readonly networkRequirements: ReadonlyArray<{
        readonly host: string;
        readonly protocol: string;
        readonly port: string;
        readonly reason: string;
      }>;
      readonly runtimeClass: string;
      readonly inputContract: Record<string, unknown>;
      readonly outputContract: Record<string, unknown>;
      readonly eventSubscriptions: readonly string[];
      readonly uiSurfaces: readonly string[];
      readonly configContract: Record<string, unknown>;
    };
    readonly idempotencyKey: string;
  };

  /** Rebuilds the typed manifest from the validated DTO. */
  function deserializeManifest(dto: ValidatedRegistration['manifest']) {
    const configContract: Record<string, {
      type: 'string' | 'number' | 'boolean' | 'object';
      required: boolean;
      description: string;
      pattern: string | null;
    }> = {};
    const rawConfig = dto.configContract as Record<string, unknown>;
    for (const [key, field] of Object.entries(rawConfig)) {
      if (field !== null && typeof field === 'object' && !Array.isArray(field)) {
        const typed = field as {
          type?: unknown;
          required?: unknown;
          description?: unknown;
          pattern?: unknown;
        };
        configContract[key] = {
          type: (typeof typed.type === 'string' && ['string', 'number', 'boolean', 'object'].includes(typed.type)
            ? typed.type
            : 'string') as 'string' | 'number' | 'boolean' | 'object',
          required: typed.required === true,
          description: typeof typed.description === 'string' ? typed.description : '',
          pattern: typeof typed.pattern === 'string' ? typed.pattern : null,
        };
      }
    }
    return {
      extensionKey: dto.extensionKey,
      publisher: dto.publisher,
      version: dto.version,
      compatibility: { minPlatform: dto.compatibility.minPlatform, maxPlatform: dto.compatibility.maxPlatform },
      capabilities: dto.capabilities.map((capability) => ({
        category: capability.category as ExtensionRegistryRecord['manifest']['capabilities'][number]['category'],
        name: capability.name,
      })),
      permissions: dto.permissions.map((permission) => ({
        action: permission.action as ExtensionRegistryRecord['manifest']['permissions'][number]['action'],
        resource: permission.resource === undefined ? null : permission.resource,
      })),
      requiredSecretNames: dto.requiredSecretNames,
      dataScopes: dto.dataScopes as ExtensionRegistryRecord['manifest']['dataScopes'],
      networkRequirements: dto.networkRequirements.map((requirement) => ({
        host: requirement.host,
        protocol: requirement.protocol,
        port: Number(requirement.port),
        reason: requirement.reason,
      })),
      runtimeClass: dto.runtimeClass as ExtensionRegistryRecord['manifest']['runtimeClass'],
      inputContract: dto.inputContract,
      outputContract: dto.outputContract,
      eventSubscriptions: dto.eventSubscriptions,
      uiSurfaces: dto.uiSurfaces,
      configContract,
    };
  }

  // -------------------------------------------------------------------------
  // The registry surface (publication — global catalog state)
  // -------------------------------------------------------------------------

  // POST /api/extensions — publish one immutable extension version. The
  // manifest guard runs server-side (EXT-AC-01); re-registration of the
  // same (publisher, key, version) is a 409 — a new version is a new row.
  router.add(
    'POST',
    '/api/extensions',
    defineMutationRoute<Record<string, string>, ExtensionRegistryRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePublisherRole(ctx.principal);
      },
      validate: (ctx) => validateObject<ValidatedRegistration>(ctx.request.body, manifestSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRegistration;
        return modules.extensions.registerExtensionVersion({
          manifest: deserializeManifest(body.manifest),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          idempotencyKey: body.idempotencyKey,
        });
      },
      emit: async (ctx) => {
        logger.info('extensions.version.published', undefined, {
          extension_id: ctx.result.extensionId,
          extension_key: ctx.result.manifest.extensionKey,
          publisher: ctx.result.manifest.publisher,
          version: ctx.result.manifest.version,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.version.published',
          targetType: 'extension_version',
          targetId: ctx.result.extensionId,
          idempotencyKey: `extensions.version.published:${ctx.result.extensionId}`,
          details: {
            extensionKey: ctx.result.manifest.extensionKey,
            publisher: ctx.result.manifest.publisher,
            version: ctx.result.manifest.version,
            runtimeClass: ctx.result.manifest.runtimeClass,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeExtension(ctx.result)),
    }),
  );

  // GET /api/extensions — the published versions (any active member; the
  // catalog is global read state for tenant members).
  router.add(
    'GET',
    '/api/extensions',
    defineQueryRoute<Record<string, string>, readonly ExtensionRegistryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async () => {
        return modules.extensions.listExtensionVersions({ extensionKey: null });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          extensions: ctx.result.map(serializeExtension),
        }),
    }),
  );

  // GET /api/extensions/:extensionId — read one published version.
  router.add(
    'GET',
    '/api/extensions/:extensionId',
    defineQueryRoute<{ extensionId: string }, ExtensionRegistryRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async (ctx) => {
        const extension = await modules.extensions.getExtensionVersion(ctx.params.extensionId);
        if (extension === null) {
          throw new NotFoundError('extension', ctx.params.extensionId);
        }
        return extension;
      },
      respond: (ctx) => jsonResponse(200, serializeExtension(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The install/configure lifecycle surface (workspace-scoped)
  // -------------------------------------------------------------------------

  // POST /api/workspaces/:workspaceId/extension-installs — install a
  // published version into the workspace with least-privilege granted
  // scopes. The scope is SERVER-DERIVED from the canonical workspace
  // ownership (resolved BEFORE authorize); the install is policy-gated
  // inside the module (fail-closed).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/extension-installs',
    defineMutationRoute<{ workspaceId: string }, { install: ExtensionInstallRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ extensionId: string; grantedScopes: readonly string[]; idempotencyKey: string }>(
          ctx.request.body,
          {
            forbiddenKeys: INSTALL_AUTHORITY_FIELDS,
            fields: {
              extensionId: stringField({ pattern: UUID_PATTERN }),
              grantedScopes: arrayField({
                minItems: 0,
                maxItems: 8,
                item: stringField({ pattern: SCOPE_PATTERN }),
              }),
              idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as { extensionId: string; grantedScopes: readonly string[]; idempotencyKey: string };
        // The scope is SERVER-DERIVED from the pipeline's canonical owner
        // (resolved from durable state BEFORE authorize) — never from the
        // request body.
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.extensions.installExtension(
          {
            scope: {
              agencyId: owner.agencyId,
              clientId: owner.clientId,
              workspaceId: owner.workspaceId,
            },
            extensionId: body.extensionId,
            grantedScopes: body.grantedScopes as ExtensionInstallRecord['grantedScopes'],
            idempotencyKey: body.idempotencyKey,
            actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('extensions.installed', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          extension_id: ctx.result.install.extensionId,
          status: ctx.result.install.status,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.installed',
          targetType: 'extension_install',
          targetId: ctx.result.install.installId,
          afterVersion: ctx.result.install.version,
          idempotencyKey: `extensions.installed:${ctx.result.install.installId}`,
          details: {
            extensionId: ctx.result.install.extensionId,
            workspaceId: ctx.result.install.workspaceId,
            status: ctx.result.install.status,
            grantedScopes: [...ctx.result.install.grantedScopes].sort().join(','),
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          install: serializeInstall(ctx.result.install),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/extension-installs — the workspace's
  // installs in EVERY state (terminal history stays visible).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/extension-installs',
    defineQueryRoute<{ workspaceId: string }, readonly ExtensionInstallRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.extensions.listExtensionInstalls(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          installs: ctx.result.map(serializeInstall),
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/extension-installs/:installId — one
  // install (uniform 404 for foreign install ids).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/extension-installs/:installId',
    defineQueryRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const install = await modules.extensions.getExtensionInstall(ctx.params.installId);
        if (install === null || install.workspaceId !== ctx.params.workspaceId) {
          throw new NotFoundError('extension install', ctx.params.installId);
        }
        return install;
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../configure — validate + store configuration values against
  // the manifest's declared config contract, binding every required
  // secret LOGICAL NAME to a credential REFERENCE (never material).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/extension-installs/:installId/configure',
    defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ config: Record<string, unknown>; secretBindings: Record<string, unknown>; expectedVersion: number }>(
          ctx.request.body,
          {
            forbiddenKeys: CONFIGURE_AUTHORITY_FIELDS,
            fields: {
              config: recordField({ maxDepthKeys: 32 }),
              secretBindings: recordField({ maxDepthKeys: 16 }),
              expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
            },
          },
        ),
      execute: async (ctx) => {
        const body = ctx.validated as {
          config: Record<string, unknown>;
          secretBindings: Record<string, unknown>;
          expectedVersion: number;
        };
        const secretBindings: Record<string, string> = {};
        for (const [name, reference] of Object.entries(body.secretBindings)) {
          if (typeof reference !== 'string' || !CREDENTIAL_REF_PATTERN.test(reference)) {
            throw new NotFoundError('credential reference', String(reference));
          }
          secretBindings[name] = reference;
        }
        return modules.extensions.configureExtension({
          installId: ctx.params.installId,
          config: body.config,
          secretBindings,
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('extensions.configured', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.configured',
          targetType: 'extension_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: {
            status: ctx.result.status,
            boundSecretNames: Object.keys(ctx.result.secretBindings).sort().join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../authorize — the authorize edge (invocable).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/extension-installs/:installId/authorize',
    defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: STATUS_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number };
        return modules.extensions.setExtensionInstallStatus({
          installId: ctx.params.installId,
          status: 'authorized',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('extensions.install.authorized', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.install.authorized',
          targetType: 'extension_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../disable — the disable edge.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/extension-installs/:installId/disable',
    defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: STATUS_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number };
        return modules.extensions.setExtensionInstallStatus({
          installId: ctx.params.installId,
          status: 'disabled',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('extensions.install.disabled', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.install.disabled',
          targetType: 'extension_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../uninstall — the TERMINAL uninstall edge (tombstone).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/extension-installs/:installId/uninstall',
    defineMutationRoute<{ workspaceId: string; installId: string }, ExtensionInstallRecord>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ expectedVersion: number }>(ctx.request.body, {
          forbiddenKeys: STATUS_AUTHORITY_FIELDS,
          fields: {
            expectedVersion: intField({ min: 1, max: Number.MAX_SAFE_INTEGER }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { expectedVersion: number };
        return modules.extensions.setExtensionInstallStatus({
          installId: ctx.params.installId,
          status: 'uninstalled',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('extensions.install.uninstalled', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'extensions.install.uninstalled',
          targetType: 'extension_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The invocation surface (the short-lived context — EXT-AC-02)
  // -------------------------------------------------------------------------

  // POST /api/executions/:executionId/extension-invocations — derive the
  // short-lived invocation context. The scope is ALWAYS the execution's
  // canonical owner (resolved inside the module THROUGH /executions);
  // the policy posture is evaluated fail-closed inside the module.
  router.add(
    'POST',
    '/api/executions/:executionId/extension-invocations',
    defineMutationRoute<{ executionId: string }, ExtensionInvocationContext>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        const ownership = await modules.executions.resolveExecutionOwnership(params.executionId);
        if (ownership === null) {
          throw new NotFoundError('execution', params.executionId);
        }
        return {
          kind: 'execution',
          agencyId: ownership.scope.agencyId,
          clientId: ownership.scope.clientId,
          workspaceId: ownership.scope.workspaceId,
          executionId: ownership.scope.executionId,
        };
      },
      authorize: async (ctx) => {
        await requireExecutionAccess(modules, ctx.principal, ctx.params.executionId);
      },
      validate: (ctx) =>
        validateObject<{
          extensionId: string;
          requestedCapabilities: readonly string[];
          input: Record<string, unknown>;
        }>(ctx.request.body, {
          forbiddenKeys: INVOCATION_AUTHORITY_FIELDS,
          fields: {
            extensionId: stringField({ pattern: UUID_PATTERN }),
            requestedCapabilities: arrayField({
              minItems: 1,
              maxItems: 32,
              item: stringField({ pattern: CAPABILITY_NAME_PATTERN }),
            }),
            // The invocation INPUT payload is free-form EXCEPT the
            // authority/material-shaped keys: identity, scope, provenance
            // and policy posture are server-derived (an extension can
            // never assert them — EXT-AC-02/EXT-AC-04); the module guard
            // additionally rejects material keys at every nesting level.
            input: recordField({
              forbiddenKeys: INVOCATION_INPUT_FORBIDDEN_KEYS,
            }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as {
          extensionId: string;
          requestedCapabilities: readonly string[];
          input: Record<string, unknown>;
        };
        return modules.extensions.beginExtensionInvocation(
          {
            executionId: ctx.params.executionId,
            extensionId: body.extensionId,
            requestedCapabilities: body.requestedCapabilities,
            input: body.input,
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('extensions.invoked', undefined, {
          execution_id: ctx.params.executionId,
          invocation_id: ctx.result.invocationId,
          extension_id: ctx.result.extensionId,
          extension_key: ctx.result.extensionKey,
          policy_decision_id: ctx.result.policyDecisionId,
          correlation_id: currentCorrelation().correlationId,
        });
        const owner = ctx.owner;
        await recordMutationAudit(modules, ctx.principal, owner, {
          action: 'extensions.invoked',
          targetType: 'extension_invocation',
          targetId: ctx.result.invocationId,
          details: {
            extensionId: ctx.result.extensionId,
            extensionKey: ctx.result.extensionKey,
            version: ctx.result.version,
            executionId: ctx.result.executionId,
            policyDecisionId: ctx.result.policyDecisionId,
            grantedDataScopes: [...ctx.result.grantedDataScopes].sort().join(','),
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializeInvocationContext(ctx.result)),
    }),
  );

  // GET /api/workspaces/:workspaceId/extension-invocations — the
  // workspace's append-only invocation ledger (Observe).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/extension-invocations',
    defineQueryRoute<{ workspaceId: string }, readonly ExtensionInvocationRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.extensions.listExtensionInvocations(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          invocations: ctx.result.map(serializeInvocationRecord),
        }),
    }),
  );

  // GET /api/extension-invocations/:invocationId — one invocation record
  // (member of the owning agency; uniform 404 for foreign).
  router.add(
    'GET',
    '/api/extension-invocations/:invocationId',
    defineQueryRoute<{ invocationId: string }, ExtensionInvocationRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const invocation = await modules.extensions.getExtensionInvocation(ctx.params.invocationId);
        if (invocation === null) {
          throw new NotFoundError('extension invocation', ctx.params.invocationId);
        }
        await requireWorkspaceAccess(modules, ctx.principal, invocation.workspaceId);
      },
      execute: async (ctx) => {
        const invocation = await modules.extensions.getExtensionInvocation(ctx.params.invocationId);
        if (invocation === null) {
          throw new NotFoundError('extension invocation', ctx.params.invocationId);
        }
        return invocation;
      },
      respond: (ctx) => jsonResponse(200, serializeInvocationRecord(ctx.result)),
    }),
  );
}
