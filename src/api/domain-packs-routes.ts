/**
 * /domain-packs API routes (MKT-036 — Versioned Domain Pack framework:
 * PACK-001).
 *
 *   POST /api/domain-packs                                    publish a version (platform admin OR agency owner|admin — the internal-team posture; specific packs arrive with their own Work Items)
 *   GET  /api/domain-packs                                    list published versions (any active member)
 *   GET  /api/domain-packs/:packId                            read one version (any active member)
 *
 *   POST /api/workspaces/:workspaceId/domain-pack-installs             install a version into the workspace (owner|admin of the owning agency|platform admin — scope server-derived from the canonical workspace ownership)
 *   GET  /api/workspaces/:workspaceId/domain-pack-installs             the workspace installs in ALL states (any active member)
 *   GET  /api/workspaces/:workspaceId/domain-pack-installs/:installId  read one install (any active member; uniform 404 for foreign)
 *   POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/disable     the disable edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/enable     the enable edge (owner|admin)
 *   POST /api/workspaces/:workspaceId/domain-pack-installs/:installId/uninstall  the terminal uninstall edge (owner|admin)
 *
 *   GET /api/workspaces/:workspaceId/domain-pack-artifacts     the artifacts materialized by this workspace's installs, BOTH scopes, each carrying its explicit scope (any active member)
 *   GET /api/agencies/:agencyId/domain-pack-artifacts          the AGENCY-SCOPED REUSABLE artifact surface ONLY (scope='agency-reusable' — the §5 explicit distinction as a query; any active member)
 *   GET /api/domain-pack-artifacts/:artifactId                 read one artifact scope record (boundary-checked: client-scoped needs the owning client's boundary; agency-reusable needs the owning agency; uniform 404 for foreign)
 *
 * Server-derived authority posture (implementation-contract §3/§23): every
 * mutation route resolves the canonical owner from durable state BEFORE
 * authorize/validate/execute (the /workspaces canonical ownership chain),
 * authorizes against the SAME /agencies membership authority as every
 * other scoped check (no second authorization authority) and yields a
 * UNIFORM 404 for unknown/foreign identifiers (no cross-tenant oracle).
 * Identity, scope, lifecycle and provenance fields are NEVER
 * request-suppliable — the DTOs reject them explicitly, and artifact
 * payloads additionally reject material-shaped keys (§21).
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
  recordField,
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requireClientAccess, requirePlatformAdministrator, requireWorkspaceAccess, resolveContext } from './authorize.ts';
import { recordMutationAudit } from './audit-emit.ts';
import type {
  DomainPackArtifactDeclaration,
  DomainPackArtifactRecord,
  DomainPackInstallRecord,
  DomainPackRegistryRecord,
} from '../modules/domain-packs/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACT_KIND_PATTERN = /^(domain-entity|view|goal-definition|metric-definition|playbook-template|workflow-template|ai-capability|human-capability|policy|integration-binding|extension-binding|evidence-schema|evaluator|ui-surface)$/;
const SCOPE_PATTERN = /^(client|agency-reusable)$/;

/**
 * Fields always server-derived on PUBLICATION — plus every
 * material-shaped key is rejected so no secret VALUE can be smuggled into
 * a pack manifest (§21/CRED-001).
 */
const PUBLISH_AUTHORITY_FIELDS = [
  'packId',
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
  // Material-shaped keys are rejected outright on every domain-packs surface.
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
  'version',
  'createdBy',
  'createdAt',
  'updatedAt',
  'uninstalledAt',
  'provenance',
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

/** Fields always server-derived on the lifecycle edges. */
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

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations)
// ---------------------------------------------------------------------------

function serializePack(record: DomainPackRegistryRecord): Record<string, unknown> {
  return {
    packId: record.packId,
    manifest: {
      packKey: record.manifest.packKey,
      publisher: record.manifest.publisher,
      version: record.manifest.version,
      displayName: record.manifest.displayName,
      description: record.manifest.description,
      compatibility: record.manifest.compatibility,
      requiredPacks: record.manifest.requiredPacks,
      artifacts: record.manifest.artifacts,
    },
    idempotencyKey: record.idempotencyKey,
    createFingerprint: record.createFingerprint,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeInstall(record: DomainPackInstallRecord): Record<string, unknown> {
  return {
    installId: record.installId,
    packId: record.packId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    version: record.version,
    ...(record.createdBy === null ? {} : { createdBy: record.createdBy }),
    ...(record.uninstalledAt === null ? {} : { uninstalledAt: record.uninstalledAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function serializeArtifact(record: DomainPackArtifactRecord): Record<string, unknown> {
  return {
    artifactId: record.artifactId,
    installId: record.installId,
    packId: record.packId,
    artifactKind: record.artifactKind,
    artifactName: record.artifactName,
    // The §5 explicit scope distinction — present on EVERY artifact
    // representation (records AND queries).
    scope: record.scope,
    boundary: {
      agencyId: record.agencyId,
      ...(record.clientId === null ? {} : { clientId: record.clientId }),
      workspaceId: record.workspaceId,
    },
    payload: record.payload,
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerDomainPacksRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('domain-packs.api');

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
   * The install-scoped owner: the install row → its workspace, resolved
   * from durable state BEFORE authorize (uniform 404 for
   * foreign/unknown; the install's scope is immutable, so it always
   * matches the workspace path).
   */
  async function installOwner(workspaceId: string, installId: string): Promise<OwnerScope> {
    const install = await modules.domainPacks.getDomainPackInstall(installId);
    if (install === null || install.workspaceId !== workspaceId) {
      throw new NotFoundError('domain pack install', installId);
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
   * SOME agency (internal teams publish framework packs before specific
   * business packs arrive — MKT-037+). The registry itself stays global
   * catalog state.
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
      throw new ForbiddenError('Publishing a domain pack version requires the platform administrator role or an active agency owner/admin membership');
    }
  }

  /**
   * The §5 scope-matrix authorization for ONE artifact record (the
   * by-id route — no path context, so the boundary comes from the ROW):
   *   - a 'client' artifact needs the OWNING CLIENT's boundary
   *     (requireClientAccess resolves the canonical client ownership and
   *     yields a UNIFORM 404 for callers outside the owning agency — no
   *     cross-tenant oracle);
   *   - an 'agency-reusable' artifact needs the OWNING AGENCY membership
   *     (non-members get the same uniform 404 — the by-id posture of the
   *     extensions invocation reads).
   */
  async function requireDomainPackArtifactAccess(
    modules: ApplicationModules,
    principal: Principal,
    artifact: DomainPackArtifactRecord,
  ): Promise<void> {
    if (artifact.scope === 'client' && artifact.clientId !== null) {
      await requireClientAccess(modules, principal, artifact.clientId);
      return;
    }
    const agency = await modules.agencies.getAgency(artifact.agencyId);
    if (agency === null) {
      throw new NotFoundError('domain pack artifact', artifact.artifactId);
    }
    if (principal.kind === 'service') return;
    const context = await resolveContext(modules, principal);
    if (context === null || context.principal.status !== 'active') {
      throw new ForbiddenError('Active user identity required');
    }
    if (context.platformRoles.includes('platform_administrator')) return;
    const membership = context.memberships.find((entry) => entry.agencyId === artifact.agencyId);
    if (membership === undefined) {
      // Hard boundary: not a member of the OWNING agency →
      // indistinguishable from an unknown artifact (uniform 404, no
      // cross-tenant oracle).
      throw new NotFoundError('domain pack artifact', artifact.artifactId);
    }
    if (membership.membershipStatus !== 'active') {
      throw new ForbiddenError('Active membership in the agency required');
    }
  }

  /**
   * The shared manifest DTO spec: the frozen PACK-001 field contract —
   * identity (key/publisher/version), display metadata, the platform
   * compatibility range, the required-pack dependencies and the artifact
   * declarations with the closed §2 kind vocabulary and the closed §5
   * scope vocabulary. Identity, provenance and lifecycle are
   * server-derived; material-shaped keys are rejected everywhere.
   */
  function manifestSpec() {
    return {
      forbiddenKeys: PUBLISH_AUTHORITY_FIELDS,
      fields: {
        manifest: objectField({
          fields: {
            packKey: stringField({ pattern: /^[a-z][a-z0-9-]{1,62}$/ }),
            publisher: stringField({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
            version: stringField({ pattern: /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/ }),
            displayName: stringField({ minLength: 1, maxLength: 128 }),
            description: stringField({ minLength: 1, maxLength: 512 }),
            compatibility: objectField({
              fields: {
                minPlatform: stringField({ minLength: 1, maxLength: 32 }),
                maxPlatform: stringField({ minLength: 1, maxLength: 32 }),
              },
            }),
            requiredPacks: arrayField({
              minItems: 0,
              maxItems: 16,
              item: objectField({
                fields: {
                  publisher: stringField({ pattern: /^[a-z0-9][a-z0-9._-]{0,63}$/ }),
                  packKey: stringField({ pattern: /^[a-z][a-z0-9-]{1,62}$/ }),
                  version: stringField({ pattern: /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/ }),
                },
              }),
            }),
            artifacts: arrayField({
              minItems: 1,
              maxItems: 128,
              item: objectField({
                fields: {
                  kind: stringField({ pattern: ARTIFACT_KIND_PATTERN }),
                  name: stringField({ minLength: 1, maxLength: 64 }),
                  description: stringField({ minLength: 1, maxLength: 512 }),
                  scope: stringField({ pattern: SCOPE_PATTERN }),
                  // The kind-specific artifact content — a bounded free
                  // form object. The module guard runs the FULL §2/§5
                  // contract including §4 workflow-template conformance
                  // (through the /workflows authority validator) and the
                  // §21 material-key backstop at every nesting level.
                  payload: recordField({ maxDepthKeys: 64 }),
                },
              }),
            }),
          },
        }),
        idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
      },
    };
  }

  type ValidatedArtifact = {
    readonly kind: string;
    readonly name: string;
    readonly description: string;
    readonly scope: string;
    readonly payload: Record<string, unknown>;
  };

  type ValidatedPublication = {
    readonly manifest: {
      readonly packKey: string;
      readonly publisher: string;
      readonly version: string;
      readonly displayName: string;
      readonly description: string;
      readonly compatibility: { readonly minPlatform: string; readonly maxPlatform: string };
      readonly requiredPacks: ReadonlyArray<{
        readonly publisher: string;
        readonly packKey: string;
        readonly version: string;
      }>;
      readonly artifacts: readonly ValidatedArtifact[];
    };
    readonly idempotencyKey: string;
  };

  /** Rebuilds the typed manifest from the validated DTO. */
  function deserializeManifest(dto: ValidatedPublication['manifest']) {
    return {
      packKey: dto.packKey,
      publisher: dto.publisher,
      version: dto.version,
      displayName: dto.displayName,
      description: dto.description,
      compatibility: {
        minPlatform: dto.compatibility.minPlatform,
        maxPlatform: dto.compatibility.maxPlatform,
      },
      requiredPacks: dto.requiredPacks.map((required) => ({
        publisher: required.publisher,
        packKey: required.packKey,
        version: required.version,
      })),
      artifacts: dto.artifacts.map(
        (artifact): DomainPackArtifactDeclaration => ({
          kind: artifact.kind as DomainPackArtifactDeclaration['kind'],
          name: artifact.name,
          description: artifact.description,
          scope: artifact.scope as DomainPackArtifactDeclaration['scope'],
          payload: artifact.payload,
        }),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // The registry surface (publication — global catalog state)
  // -------------------------------------------------------------------------

  // POST /api/domain-packs — publish one immutable Domain Pack version.
  // The manifest guard runs server-side (§2/§5/§4 conformance); re-
  // publication of the same (publisher, packKey, version) is a 409 — a
  // new version is a new row.
  router.add(
    'POST',
    '/api/domain-packs',
    defineMutationRoute<Record<string, string>, DomainPackRegistryRecord>({
      authenticator: services.auth,
      resolveOwner: async () => ({ kind: 'platform' }),
      authorize: async (ctx) => {
        await requirePublisherRole(ctx.principal);
      },
      validate: (ctx) => validateObject<ValidatedPublication>(ctx.request.body, manifestSpec()),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedPublication;
        return modules.domainPacks.publishDomainPackVersion({
          manifest: deserializeManifest(body.manifest),
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
          idempotencyKey: body.idempotencyKey,
        });
      },
      emit: async (ctx) => {
        logger.info('domain_packs.version.published', undefined, {
          pack_id: ctx.result.packId,
          pack_key: ctx.result.manifest.packKey,
          publisher: ctx.result.manifest.publisher,
          version: ctx.result.manifest.version,
          artifact_count: ctx.result.manifest.artifacts.length,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'domain_packs.version.published',
          targetType: 'domain_pack_version',
          targetId: ctx.result.packId,
          idempotencyKey: `domain_packs.version.published:${ctx.result.packId}`,
          details: {
            packKey: ctx.result.manifest.packKey,
            publisher: ctx.result.manifest.publisher,
            version: ctx.result.manifest.version,
            artifacts: ctx.result.manifest.artifacts.length,
            requiredPacks: ctx.result.manifest.requiredPacks.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(201, serializePack(ctx.result)),
    }),
  );

  // GET /api/domain-packs — the published versions (any active member;
  // the catalog is global read state for tenant members).
  router.add(
    'GET',
    '/api/domain-packs',
    defineQueryRoute<Record<string, string>, readonly DomainPackRegistryRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async () => {
        return modules.domainPacks.listDomainPackVersions({ packKey: null });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          packs: ctx.result.map(serializePack),
        }),
    }),
  );

  // GET /api/domain-packs/:packId — read one published version.
  router.add(
    'GET',
    '/api/domain-packs/:packId',
    defineQueryRoute<{ packId: string }, DomainPackRegistryRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        if (ctx.principal.kind === 'service') return;
        const context = await resolveContext(modules, ctx.principal);
        if (context === null || context.principal.status !== 'active') {
          throw new ForbiddenError('Active user identity required');
        }
      },
      execute: async (ctx) => {
        const pack = await modules.domainPacks.getDomainPackVersion(ctx.params.packId);
        if (pack === null) {
          throw new NotFoundError('domain pack', ctx.params.packId);
        }
        return pack;
      },
      respond: (ctx) => jsonResponse(200, serializePack(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The install lifecycle surface (workspace-scoped)
  // -------------------------------------------------------------------------

  // POST /api/workspaces/:workspaceId/domain-pack-installs — install a
  // published version into the workspace. The scope is SERVER-DERIVED
  // from the canonical workspace ownership (resolved BEFORE authorize);
  // the module runs the dependency checks and materializes the artifact
  // scope records atomically.
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/domain-pack-installs',
    defineMutationRoute<{ workspaceId: string }, { install: DomainPackInstallRecord; replayed: boolean }>({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          'agency_owner',
          'agency_admin',
        ]);
      },
      validate: (ctx) =>
        validateObject<{ packId: string; idempotencyKey: string }>(ctx.request.body, {
          forbiddenKeys: INSTALL_AUTHORITY_FIELDS,
          fields: {
            packId: stringField({ pattern: UUID_PATTERN }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as { packId: string; idempotencyKey: string };
        // The scope is SERVER-DERIVED from the pipeline's canonical owner
        // (resolved from durable state BEFORE authorize) — never from the
        // request body.
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.domainPacks.installDomainPack({
          scope: {
            agencyId: owner.agencyId,
            clientId: owner.clientId,
            workspaceId: owner.workspaceId,
          },
          packId: body.packId,
          idempotencyKey: body.idempotencyKey,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('domain_packs.installed', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          pack_id: ctx.result.install.packId,
          status: ctx.result.install.status,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'domain_packs.installed',
          targetType: 'domain_pack_install',
          targetId: ctx.result.install.installId,
          afterVersion: ctx.result.install.version,
          idempotencyKey: `domain_packs.installed:${ctx.result.install.installId}`,
          details: {
            packId: ctx.result.install.packId,
            workspaceId: ctx.result.install.workspaceId,
            clientId: ctx.result.install.clientId,
            status: ctx.result.install.status,
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

  // GET /api/workspaces/:workspaceId/domain-pack-installs — the
  // workspace's installs in EVERY state (terminal history stays visible).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/domain-pack-installs',
    defineQueryRoute<{ workspaceId: string }, readonly DomainPackInstallRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.domainPacks.listDomainPackInstalls(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          installs: ctx.result.map(serializeInstall),
        }),
    }),
  );

  // GET /api/workspaces/:workspaceId/domain-pack-installs/:installId —
  // one install (uniform 404 for foreign install ids).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/domain-pack-installs/:installId',
    defineQueryRoute<{ workspaceId: string; installId: string }, DomainPackInstallRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const install = await modules.domainPacks.getDomainPackInstall(ctx.params.installId);
        if (install === null || install.workspaceId !== ctx.params.workspaceId) {
          throw new NotFoundError('domain pack install', ctx.params.installId);
        }
        return install;
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../disable — the disable edge (installed → disabled).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/domain-pack-installs/:installId/disable',
    defineMutationRoute<{ workspaceId: string; installId: string }, DomainPackInstallRecord>({
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
        return modules.domainPacks.setDomainPackInstallStatus({
          installId: ctx.params.installId,
          status: 'disabled',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('domain_packs.install.disabled', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'domain_packs.install.disabled',
          targetType: 'domain_pack_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../enable — the enable edge (disabled → installed).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/domain-pack-installs/:installId/enable',
    defineMutationRoute<{ workspaceId: string; installId: string }, DomainPackInstallRecord>({
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
        return modules.domainPacks.setDomainPackInstallStatus({
          installId: ctx.params.installId,
          status: 'installed',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('domain_packs.install.enabled', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'domain_packs.install.enabled',
          targetType: 'domain_pack_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // POST .../uninstall — the terminal uninstall edge (tombstone).
  router.add(
    'POST',
    '/api/workspaces/:workspaceId/domain-pack-installs/:installId/uninstall',
    defineMutationRoute<{ workspaceId: string; installId: string }, DomainPackInstallRecord>({
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
        return modules.domainPacks.setDomainPackInstallStatus({
          installId: ctx.params.installId,
          status: 'uninstalled',
          expectedVersion: body.expectedVersion,
          actorId: ctx.principal.kind === 'user' ? ctx.principal.userId : null,
        });
      },
      emit: async (ctx) => {
        logger.info('domain_packs.install.uninstalled', undefined, {
          install_id: ctx.result.installId,
          status: ctx.result.status,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'domain_packs.install.uninstalled',
          targetType: 'domain_pack_install',
          targetId: ctx.result.installId,
          afterVersion: ctx.result.version,
          details: { status: ctx.result.status },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeInstall(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // The artifact scope surface (PACK-AC-03 — the §5 explicit distinction)
  // -------------------------------------------------------------------------

  // GET /api/workspaces/:workspaceId/domain-pack-artifacts — the
  // artifacts materialized by THIS workspace's installs (both scopes,
  // each carrying its explicit scope field; the listing derives from the
  // workspace's OWN installs only — pack-owned Client data of other
  // workspaces/clients never appears).
  router.add(
    'GET',
    '/api/workspaces/:workspaceId/domain-pack-artifacts',
    defineQueryRoute<{ workspaceId: string }, readonly DomainPackArtifactRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.domainPacks.listDomainPackArtifactsForWorkspace(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          artifacts: ctx.result.map(serializeArtifact),
        }),
    }),
  );

  // GET /api/agencies/:agencyId/domain-pack-artifacts — the AGENCY-SCOPED
  // REUSABLE surface ONLY (scope='agency-reusable' — the §5 explicit
  // distinction as a query; Client-scoped pack-owned data is never
  // aggregated at agency scope).
  router.add(
    'GET',
    '/api/agencies/:agencyId/domain-pack-artifacts',
    defineQueryRoute<{ agencyId: string }, readonly DomainPackArtifactRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.domainPacks.listDomainPackArtifactsForAgency(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          scope: 'agency-reusable',
          artifacts: ctx.result.map(serializeArtifact),
        }),
    }),
  );

  // GET /api/domain-pack-artifacts/:artifactId — one artifact scope
  // record, boundary-checked by its §5 scope (client-scoped needs the
  // owning client's boundary; agency-reusable needs the owning agency;
  // uniform 404 for foreign — no cross-tenant oracle).
  router.add(
    'GET',
    '/api/domain-pack-artifacts/:artifactId',
    defineQueryRoute<{ artifactId: string }, DomainPackArtifactRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        const artifact = await modules.domainPacks.getDomainPackArtifact(ctx.params.artifactId);
        if (artifact === null) {
          throw new NotFoundError('domain pack artifact', ctx.params.artifactId);
        }
        await requireDomainPackArtifactAccess(modules, ctx.principal, artifact);
      },
      execute: async (ctx) => {
        const artifact = await modules.domainPacks.getDomainPackArtifact(ctx.params.artifactId);
        if (artifact === null) {
          throw new NotFoundError('domain pack artifact', ctx.params.artifactId);
        }
        return artifact;
      },
      respond: (ctx) => jsonResponse(200, serializeArtifact(ctx.result)),
    }),
  );
}
