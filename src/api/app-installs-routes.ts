/**
 * /api/workspaces/:workspaceId/app-installs* + /api/agencies/:agencyId/app-installs
 * routes (MKT-048 — App Installation, Upgrade and Rollback: the
 * workspace-scoped App lifecycle over the /apps registry).
 *
 *   POST /api/workspaces/:workspaceId/app-installs                          INSTALL one EXACT published App Version into the workspace (agency owner|admin of the owning agency | platform admin | service). The scope is SERVER-DERIVED from the canonical workspace ownership; the granted scopes are DERIVED SERVER-SIDE inside the module (never request-suppliable); the install is policy-gated fail-closed.
 *   GET  /api/workspaces/:workspaceId/app-installs                          the workspace's installed apps — the CURRENT selections + the FULL append-oriented history (every selection row of every lineage; any active member of the owning agency)
 *   GET  /api/workspaces/:workspaceId/app-installs/:installId              one selection row (any active member; uniform 404 for foreign install ids)
 *   POST /api/workspaces/:workspaceId/app-installs/:installId/upgrade       select a NEW exact version for FUTURE invocations (owner|admin; the prior row's historical identity is preserved — the append-oriented ledger)
 *   POST /api/workspaces/:workspaceId/app-installs/:installId/rollback      reselect a PREVIOUSLY INSTALLED approved version (owner|admin; a prior selection row of the same lineage — no history rewrite)
 *
 *   GET  /api/agencies/:agencyId/app-installs                               the agency rollup: the CURRENT selections across the agency's workspaces, newest first (any active member of the agency)
 *
 * NO UPDATE ROUTE. NO DELETE ROUTE. The install ledger is append-oriented
 * (mos-app-ecosystem-v1.5.md "Upgrade and rollback"; architecture-lock
 * v1.5 #11): upgrade and rollback APPEND successor selections and supersede
 * the prior row through the single sanctioned transition; historical rows
 * retain their ORIGINAL (app key, version) forever — the route surface is
 * exactly the six frozen routes above (asserted by
 * tests/architecture/app-installs-boundary.test.ts).
 *
 * Server-derived authority posture (implementation-contract §3/§23; the
 * extensions/deployments precedents): every mutation resolves the caller's
 * authorization context and the canonical workspace ownership from durable
 * state BEFORE validate/execute; the workspace/client/agency scope chain,
 * the granted scopes, the installer identity, the provenance and the
 * lifecycle are NEVER request-suppliable (the DTOs reject them explicitly
 * plus every material-shaped key — §21); foreign workspaces and foreign
 * install ids are the UNIFORM 404 (no cross-tenant existence oracle);
 * anonymous callers fail closed 401 at the authenticator.
 */

import { NotFoundError } from '../platform/errors/errors.ts';
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
  stringField,
  validateObject,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireAgencyAccess, requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type { AppInstallEventRecord, AppInstallRecord } from '../modules/app-installs/public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[a-z0-9.-]{1,32})?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Material-shaped keys rejected on EVERY /app-installs surface (§21/CRED-001
 * — the module guard and the migration-038 CHECK functions enforce the
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
 * Fields always server-derived on EVERY selection mutation (scope chain,
 * granted scopes, registry identity, lifecycle, provenance) — plus every
 * material-shaped key, so no secret VALUE and no spoofed grant can be
 * smuggled through the route surface (AC-7: granted scopes are NEVER
 * caller-suppliable — the DTO has no scopes field at all).
 */
const SELECTION_AUTHORITY_FIELDS = [
  'installId',
  'agencyId',
  'clientId',
  'workspaceId',
  'scope',
  'appVersionId',
  'grantedScopes',
  'grantedDataScopes',
  'grantedMutationScopes',
  'policyDecisionId',
  'policyDecision',
  'status',
  'selectionSeq',
  'supersededAt',
  'supersededByInstallId',
  'installedBy',
  'installedAt',
  'createFingerprint',
  'provenance',
  'actor',
  'recordedActor',
  'recordedVia',
  'correlationId',
  'causationId',
  'recordedAt',
  'replayed',
  'prior',
  'certificationState',
  ...MATERIAL_KEYS,
] as const;

/** The sanctioned mutation roles (the extensions install posture). */
const INSTALLER_ROLES = ['agency_owner', 'agency_admin'] as const;

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations)
// ---------------------------------------------------------------------------

function serializeAppInstall(record: AppInstallRecord): Record<string, unknown> {
  return {
    installId: record.installId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    appKey: record.appKey,
    // The EXACT App Version identity (immutable registry reference).
    appVersionId: record.appVersionId,
    version: record.version,
    operation: record.operation,
    // SERVER-DERIVED granted scopes (never request fields).
    grantedDataScopes: record.grantedDataScopes,
    grantedMutationScopes: record.grantedMutationScopes,
    policyDecisionId: record.policyDecisionId,
    selectionSeq: record.selectionSeq,
    status: record.status,
    supersededAt: record.supersededAt,
    ...(record.installedBy === null ? {} : { installedBy: record.installedBy }),
    installedAt: record.installedAt,
    idempotencyKey: record.idempotencyKey,
    createFingerprint: record.createFingerprint,
  };
}

function serializeAppInstallEvent(record: AppInstallEventRecord): Record<string, unknown> {
  return {
    eventId: record.eventId,
    installId: record.installId,
    agencyId: record.agencyId,
    clientId: record.clientId,
    workspaceId: record.workspaceId,
    appKey: record.appKey,
    eventType: record.eventType,
    priorInstallId: record.priorInstallId,
    fromVersion: record.fromVersion,
    toVersion: record.toVersion,
    policyDecisionId: record.policyDecisionId,
    idempotencyKey: record.idempotencyKey,
    recordedActor: record.recordedActor,
    recordedVia: record.recordedVia,
    correlationId: record.correlationId,
    ...(record.causationId === null ? {} : { causationId: record.causationId }),
    recordedAt: record.recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerAppInstallsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('app-installs.api');

  /** SERVER-DERIVED provenance (the extensions route precedent). */
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

  /** The SERVER-DERIVED installer identity from the authenticated principal. */
  function actorId(principal: Principal): string | null {
    return principal.kind === 'user' ? principal.userId : null;
  }

  /** Canonical workspace owner scope (uniform 404 for unknown/foreign). */
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
   * The install-scoped owner: the install row must belong to the PATH
   * workspace (a foreign or unknown install id is the uniform 404 — no
   * existence oracle), then the canonical workspace ownership resolves.
   */
  async function installOwner(
    workspaceId: string,
    installId: string,
  ): Promise<{ owner: OwnerScope; record: AppInstallRecord }> {
    const record = await modules.appInstalls.getAppInstall(installId);
    if (record === null || record.workspaceId !== workspaceId) {
      throw new NotFoundError('app install', installId);
    }
    const owner = await workspaceOwner(workspaceId);
    return { owner, record };
  }

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/app-installs — INSTALL one exact
  // published App Version (the lineage's first selection).
  // -------------------------------------------------------------------------

  type ValidatedInstall = {
    readonly appKey: string;
    readonly version: string;
    readonly idempotencyKey: string;
  };

  router.add(
    'POST',
    '/api/workspaces/:workspaceId/app-installs',
    defineMutationRoute<
      { workspaceId: string },
      { install: AppInstallRecord; prior: AppInstallRecord | null; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => workspaceOwner(params.workspaceId),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          ...INSTALLER_ROLES,
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedInstall>(ctx.request.body, {
          forbiddenKeys: SELECTION_AUTHORITY_FIELDS,
          fields: {
            appKey: stringField({ pattern: KEY_PATTERN }),
            version: stringField({ pattern: SEMVER_PATTERN }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedInstall;
        // The scope is SERVER-DERIVED from the pipeline's canonical owner
        // (resolved from durable state BEFORE authorize) — never from the
        // request body. Granted scopes are derived INSIDE the module.
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.appInstalls.installApp(
          {
            workspaceId: owner.workspaceId,
            appKey: body.appKey,
            version: body.version,
            idempotencyKey: body.idempotencyKey,
            actorId: actorId(ctx.principal),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('app-installs.installed', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          app_key: ctx.result.install.appKey,
          version: ctx.result.install.version,
          selection_seq: ctx.result.install.selectionSeq,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'appinstalls.installed',
          targetType: 'app_install',
          targetId: ctx.result.install.installId,
          details: {
            appKey: ctx.result.install.appKey,
            version: ctx.result.install.version,
            workspaceId: ctx.result.install.workspaceId,
            operation: ctx.result.install.operation,
            grantedDataScopes: [...ctx.result.install.grantedDataScopes].sort().join(','),
            grantedMutationScopes: [...ctx.result.install.grantedMutationScopes].sort().join(','),
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          install: serializeAppInstall(ctx.result.install),
          ...(ctx.result.prior === null
            ? {}
            : { prior: serializeAppInstall(ctx.result.prior) }),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/app-installs — the workspace's
  // installed apps: CURRENT selections + the FULL append-oriented history.
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/workspaces/:workspaceId/app-installs',
    defineQueryRoute<{ workspaceId: string }, readonly AppInstallRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.appInstalls.listWorkspaceAppInstalls(ctx.params.workspaceId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          workspaceId: ctx.params.workspaceId,
          installs: ctx.result.map(serializeAppInstall),
          currentSelections: ctx.result
            .filter((record) => record.status === 'ACTIVE')
            .map((record) => record.installId),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/workspaces/:workspaceId/app-installs/:installId — one
  // selection row (uniform 404 for foreign install ids).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/workspaces/:workspaceId/app-installs/:installId',
    defineQueryRoute<{ workspaceId: string; installId: string }, AppInstallRecord>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const record = await modules.appInstalls.getAppInstall(ctx.params.installId);
        if (record === null || record.workspaceId !== ctx.params.workspaceId) {
          throw new NotFoundError('app install', ctx.params.installId);
        }
        return record;
      },
      respond: (ctx) => jsonResponse(200, serializeAppInstall(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/app-installs/:installId/upgrade —
  // select a NEW exact version for FUTURE invocations (append-oriented: the
  // prior row is superseded, never rewritten).
  // -------------------------------------------------------------------------

  type ValidatedUpgrade = {
    readonly version: string;
    readonly idempotencyKey: string;
  };

  router.add(
    'POST',
    '/api/workspaces/:workspaceId/app-installs/:installId/upgrade',
    defineMutationRoute<
      { workspaceId: string; installId: string },
      { install: AppInstallRecord; prior: AppInstallRecord | null; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId).then((r) => r.owner),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          ...INSTALLER_ROLES,
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedUpgrade>(ctx.request.body, {
          forbiddenKeys: SELECTION_AUTHORITY_FIELDS,
          fields: {
            version: stringField({ pattern: SEMVER_PATTERN }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedUpgrade;
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.appInstalls.upgradeAppInstall(
          {
            installId: ctx.params.installId,
            version: body.version,
            idempotencyKey: body.idempotencyKey,
            actorId: actorId(ctx.principal),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('app-installs.upgraded', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          app_key: ctx.result.install.appKey,
          version: ctx.result.install.version,
          prior_version: ctx.result.prior === null ? null : ctx.result.prior.version,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'appinstalls.upgraded',
          targetType: 'app_install',
          targetId: ctx.result.install.installId,
          details: {
            appKey: ctx.result.install.appKey,
            version: ctx.result.install.version,
            priorVersion: ctx.result.prior === null ? null : ctx.result.prior.version,
            priorInstallId: ctx.result.prior === null ? null : ctx.result.prior.installId,
            workspaceId: ctx.result.install.workspaceId,
            grantedDataScopes: [...ctx.result.install.grantedDataScopes].sort().join(','),
            grantedMutationScopes: [...ctx.result.install.grantedMutationScopes].sort().join(','),
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          install: serializeAppInstall(ctx.result.install),
          ...(ctx.result.prior === null
            ? {}
            : { prior: serializeAppInstall(ctx.result.prior) }),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/workspaces/:workspaceId/app-installs/:installId/rollback —
  // reselect a PREVIOUSLY INSTALLED approved version (append-oriented: no
  // history rewrite).
  // -------------------------------------------------------------------------

  type ValidatedRollback = {
    readonly targetInstallId: string;
    readonly idempotencyKey: string;
  };

  router.add(
    'POST',
    '/api/workspaces/:workspaceId/app-installs/:installId/rollback',
    defineMutationRoute<
      { workspaceId: string; installId: string },
      { install: AppInstallRecord; prior: AppInstallRecord | null; replayed: boolean }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => installOwner(params.workspaceId, params.installId).then((r) => r.owner),
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          ...INSTALLER_ROLES,
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedRollback>(ctx.request.body, {
          forbiddenKeys: SELECTION_AUTHORITY_FIELDS,
          fields: {
            targetInstallId: stringField({ pattern: UUID_PATTERN }),
            idempotencyKey: stringField({ minLength: 1, maxLength: 200 }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedRollback;
        const owner = ctx.owner;
        if (owner.kind !== 'workspace') {
          throw new NotFoundError('workspace', ctx.params.workspaceId);
        }
        return modules.appInstalls.rollbackAppInstall(
          {
            installId: ctx.params.installId,
            targetInstallId: body.targetInstallId,
            idempotencyKey: body.idempotencyKey,
            actorId: actorId(ctx.principal),
          },
          serverProvenance(ctx.principal),
        );
      },
      emit: async (ctx) => {
        logger.info('app-installs.rolled_back', undefined, {
          workspace_id: ctx.params.workspaceId,
          install_id: ctx.result.install.installId,
          app_key: ctx.result.install.appKey,
          version: ctx.result.install.version,
          prior_version: ctx.result.prior === null ? null : ctx.result.prior.version,
          replayed: ctx.result.replayed,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'appinstalls.rolled_back',
          targetType: 'app_install',
          targetId: ctx.result.install.installId,
          details: {
            appKey: ctx.result.install.appKey,
            version: ctx.result.install.version,
            priorVersion: ctx.result.prior === null ? null : ctx.result.prior.version,
            priorInstallId: ctx.result.prior === null ? null : ctx.result.prior.installId,
            workspaceId: ctx.result.install.workspaceId,
            grantedDataScopes: [...ctx.result.install.grantedDataScopes].sort().join(','),
            grantedMutationScopes: [...ctx.result.install.grantedMutationScopes].sort().join(','),
            replayed: ctx.result.replayed,
          },
        });
      },
      respond: (ctx) =>
        jsonResponse(ctx.result.replayed ? 200 : 201, {
          install: serializeAppInstall(ctx.result.install),
          ...(ctx.result.prior === null
            ? {}
            : { prior: serializeAppInstall(ctx.result.prior) }),
          replayed: ctx.result.replayed,
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/agencies/:agencyId/app-installs — the agency rollup of CURRENT
  // selections (any active member of the agency).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/agencies/:agencyId/app-installs',
    defineQueryRoute<{ agencyId: string }, readonly AppInstallRecord[]>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireAgencyAccess(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        return modules.appInstalls.listAgencyAppInstalls(ctx.params.agencyId);
      },
      respond: (ctx) =>
        jsonResponse(200, {
          agencyId: ctx.params.agencyId,
          installs: ctx.result.map(serializeAppInstall),
        }),
    }),
  );

  // The append-only lifecycle EVENT tail of one workspace — exposed as a
  // module-level read (listWorkspaceAppInstallEvents) consumed by tests and
  // future surfaces; deliberately NOT a route: the frozen route surface of
  // this Work Item is exactly the six routes above.
  void serializeAppInstallEvent;
}
