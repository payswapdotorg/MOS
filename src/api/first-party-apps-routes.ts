/**
 * /api/first-party-apps/* routes (MKT-051 — the Incumbent Capability App
 * Program: the invoke/read surface of the four first-party capability
 * packs over the CURRENT install selection).
 *
 *   GET    /api/first-party-apps/workspaces/:workspaceId/packs            the pack catalog with LIVE registry + install state (any active member of the owning agency)
 *   POST   /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/surfaces   COMPOSE one declared surface (any active member) — the App-model invoke/read; surface + documentKey in the body; 422 undeclared surface, 403 missing granted scope, 404 not installed
 *   GET    /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state      read the bounded app state (any active member; ?namespace=)
 *   POST   /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state      set/delete bounded app-state entries + lineage (agency owner|admin | platform admin | service — app-owned presentation state)
 *   GET    /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state/export    the export serialization (any active member)
 *   DELETE /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state    the delete semantics (agency owner|admin | platform admin | service)
 *
 * The routes are a THIN DELEGATION over the /first-party-apps module: the
 * workspace authorization is the standard requireWorkspaceAccess posture
 * (uniform 404 for foreign/unknown workspaces, 403 for suspended
 * memberships, 401 anonymous); every mutation is audited through the
 * shared /audit wiring (recordMutationAudit). NO authority surface is
 * exposed here — the module composes the incumbent authorities'
 * read-only public contracts, and the pack action menus only DECLARE
 * existing authority routes (the operator invokes those directly under
 * the platform's own authorization).
 *
 * The bounded app-state mutations are APP-OWNED state only: the state
 * POST/DELETE audit records name the (workspace, app, namespace) — never
 * an authority record — and the integration tests prove with direct SQL
 * that NO authority table changes through this surface.
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
  objectField,
  stringField,
  validateObject,
  type FieldSpec,
} from '../platform/http/validation.ts';
import type { ApplicationModules } from './application.ts';
import { requireWorkspaceAccess } from './authorize.ts';
import { auditActor, recordMutationAudit } from './audit-emit.ts';
import type {
  PackSurfaceComposition,
} from '../modules/first-party-apps/public.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,62}$/;
const SURFACE_PATTERN =
  /^(command-center-card|client-room-panel|workspace-tab|report-page|editor-pane|action-menu)$/;
const NAMESPACE_PATTERN = /^app:[a-z][a-z0-9-]{1,62}:[a-z][a-z0-9-]{1,30}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_MANAGER_ROLES = ['agency_owner', 'agency_admin'] as const;

/**
 * Material-shaped keys rejected on every bounded app-state surface
 * (§21/CRED-001 — the module guard enforces the identical shared /apps
 * set behind the DTO; the route surface repeats the hygiene).
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
 * An optional bounded string field (omission allowed, no explicit null).
 */
function optionalStringField(options: { pattern?: RegExp } = {}): FieldSpec<string | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') {
        problems.push('must be a string');
        return undefined;
      }
      if (options.pattern !== undefined && !options.pattern.test(value)) {
        problems.push('has an invalid format');
      }
      return value;
    },
  };
}

/**
 * An optional JSON-object field for the app-state entries payload (the
 * §21 guard runs at the module; here we only require a JSON object).
 */
function entriesField(): FieldSpec<Record<string, unknown> | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        problems.push('set: must be a JSON object of app-state entries');
        return undefined;
      }
      return value as Record<string, unknown>;
    },
  };
}

/** A bounded array-of-strings field. */
function stringArrayField(label: string): FieldSpec<string[] | undefined> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) {
        problems.push(`${label}: must be an array of strings`);
        return undefined;
      }
      for (const entry of value) {
        if (typeof entry !== 'string' || entry.length < 1 || entry.length > 128) {
          problems.push(`${label}: every entry must be a 1-128 character string`);
        }
      }
      return value as string[];
    },
  };
}

/** A lineage-refs array field ({ kind, id }). */
function lineageField(): FieldSpec<
  { readonly kind: string; readonly id: string }[] | undefined
> {
  return {
    required: false,
    parse: (value, problems) => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value)) {
        problems.push('lineage: must be an array of { kind, id } references');
        return undefined;
      }
      const out: { readonly kind: string; readonly id: string }[] = [];
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          problems.push('lineage: every entry must be an object { kind, id }');
          continue;
        }
        const record = entry as Record<string, unknown>;
        const kind = record['kind'];
        const id = record['id'];
        if (typeof kind !== 'string' || typeof id !== 'string') {
          problems.push('lineage: every entry must be an object { kind, id }');
          continue;
        }
        out.push({ kind, id });
      }
      return out;
    },
  };
}

/** A well-formed app key or the uniform 404 (malformed ≡ unknown). */
function requireAppKeyShape(appKey: string): void {
  if (!KEY_PATTERN.test(appKey)) {
    throw new NotFoundError('app', appKey);
  }
}

// ---------------------------------------------------------------------------
// Serialization (opaque, non-secret representations)
// ---------------------------------------------------------------------------

function serializeComposition(
  composition: PackSurfaceComposition,
): Record<string, unknown> {
  return {
    app: composition.app,
    install: composition.install,
    surface: composition.surface,
    composedFrom: composition.composedFrom,
    model: composition.model,
    generatedAt: composition.generatedAt,
  };
}

function serializeStateRecord(record: {
  readonly workspaceId: string;
  readonly appKey: string;
  readonly namespace: string;
  readonly entries: Readonly<Record<string, unknown>>;
  readonly lineage: readonly { readonly kind: string; readonly id: string }[];
  readonly updatedAt: string;
}): Record<string, unknown> {
  return {
    workspaceId: record.workspaceId,
    appKey: record.appKey,
    namespace: record.namespace,
    entries: record.entries,
    lineage: record.lineage,
    updatedAt: record.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerFirstPartyAppsRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  const logger = services.observability.loggerFactory.forModule('first-party-apps.api');

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

  // -------------------------------------------------------------------------
  // GET /api/first-party-apps/workspaces/:workspaceId/packs — the pack
  // catalog with LIVE registry + install state.
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/first-party-apps/workspaces/:workspaceId/packs',
    defineQueryRoute<{ workspaceId: string }, Awaited<ReturnType<typeof modules.firstPartyApps.listFirstPartyPacks>>>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        return modules.firstPartyApps.listFirstPartyPacks({
          workspaceId: ctx.params.workspaceId,
        });
      },
      respond: (ctx) =>
        jsonResponse(200, {
          packs: ctx.result.map((pack) => ({
            appKey: pack.appKey,
            family: pack.family,
            description: pack.description,
            versions: pack.versions,
            surfaces: pack.surfaces,
            stateNamespaces: pack.stateNamespaces,
            publishedVersions: pack.publishedVersions,
            currentSelection: pack.currentSelection,
          })),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/surfaces
  // — COMPOSE one declared surface (the App-model invoke/read).
  // -------------------------------------------------------------------------

  type ValidatedSurface = {
    readonly surface: string;
    readonly documentKey: string | undefined;
  };

  router.add(
    'POST',
    '/api/first-party-apps/workspaces/:workspaceId/packs/:appKey/surfaces',
    defineMutationRoute<
      { workspaceId: string; appKey: string },
      PackSurfaceComposition
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        requireAppKeyShape(params.appKey);
        return workspaceOwner(params.workspaceId);
      },
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      validate: (ctx) =>
        validateObject<ValidatedSurface>(ctx.request.body, {
          forbiddenKeys: [...MATERIAL_KEYS],
          fields: {
            surface: stringField({ pattern: SURFACE_PATTERN }),
            documentKey: optionalStringField({ pattern: /^[a-z0-9][a-z0-9-]{0,63}$/ }),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedSurface;
        return modules.firstPartyApps.composePackSurface({
          workspaceId: ctx.params.workspaceId,
          appKey: ctx.params.appKey,
          surface: body.surface as PackSurfaceComposition['surface']['kind'],
          documentKey: body.documentKey ?? null,
        });
      },
      emit: async (ctx) => {
        logger.info('first-party-apps.surface-composed', undefined, {
          workspace_id: ctx.params.workspaceId,
          app_key: ctx.params.appKey,
          surface: ctx.result.surface.kind,
          version: ctx.result.app.version,
          correlation_id: currentCorrelation().correlationId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeComposition(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state
  // — read the bounded app state (?namespace=).
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
    defineQueryRoute<
      { workspaceId: string; appKey: string },
      { readonly record: Awaited<ReturnType<typeof modules.firstPartyApps.readPackAppState>>; readonly namespace: string }
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        requireAppKeyShape(ctx.params.appKey);
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const query = ctx.request.path.split('?')[1] ?? '';
        const namespace = new URLSearchParams(query).get('namespace');
        if (namespace === null || !NAMESPACE_PATTERN.test(namespace)) {
          throw new NotFoundError(
            'app state namespace',
            namespace ?? '(missing ?namespace=app:<key>:<local> query parameter)',
          );
        }
        const record = await modules.firstPartyApps.readPackAppState({
          workspaceId: ctx.params.workspaceId,
          appKey: ctx.params.appKey,
          namespace,
        });
        return { record, namespace };
      },
      respond: (ctx) =>
        jsonResponse(200, {
          state:
            ctx.result.record === null ? null : serializeStateRecord(ctx.result.record),
        }),
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state
  // — set/delete bounded app-state entries + lineage (app-owned state).
  // -------------------------------------------------------------------------

  type ValidatedStateMutation = {
    readonly namespace: string;
    readonly set: Record<string, unknown> | undefined;
    readonly delete: string[] | undefined;
    readonly lineage: { readonly kind: string; readonly id: string }[] | undefined;
  };

  router.add(
    'POST',
    '/api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
    defineMutationRoute<
      { workspaceId: string; appKey: string },
      Awaited<ReturnType<typeof modules.firstPartyApps.mutatePackAppState>>
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        requireAppKeyShape(params.appKey);
        return workspaceOwner(params.workspaceId);
      },
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          ...STATE_MANAGER_ROLES,
        ]);
      },
      validate: (ctx) =>
        validateObject<ValidatedStateMutation>(ctx.request.body, {
          forbiddenKeys: [...MATERIAL_KEYS],
          fields: {
            namespace: stringField({ pattern: NAMESPACE_PATTERN }),
            set: entriesField(),
            delete: stringArrayField('delete'),
            lineage: lineageField(),
          },
        }),
      execute: async (ctx) => {
        const body = ctx.validated as ValidatedStateMutation;
        return modules.firstPartyApps.mutatePackAppState({
          workspaceId: ctx.params.workspaceId,
          appKey: ctx.params.appKey,
          namespace: body.namespace,
          set: body.set ?? {},
          delete: body.delete ?? [],
          lineage:
            body.lineage?.map((ref) => ({
              kind: ref.kind as 'metric-observation',
              id: ref.id,
            })) ?? [],
        });
      },
      emit: async (ctx) => {
        logger.info('first-party-apps.state-mutated', undefined, {
          workspace_id: ctx.params.workspaceId,
          app_key: ctx.params.appKey,
          namespace: ctx.result.namespace,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'firstpartyapps.state-mutated',
          targetType: 'app_state',
          targetId: `${ctx.params.appKey}:${ctx.result.namespace}`,
          details: {
            workspaceId: ctx.params.workspaceId,
            appKey: ctx.params.appKey,
            namespace: ctx.result.namespace,
            entryCount: Object.keys(ctx.result.entries).length,
            lineageRefs: ctx.result.lineage.length,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, serializeStateRecord(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state/export
  // — the export serialization of the bounded app state.
  // -------------------------------------------------------------------------

  router.add(
    'GET',
    '/api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state/export',
    defineQueryRoute<
      { workspaceId: string; appKey: string },
      Awaited<ReturnType<typeof modules.firstPartyApps.exportPackAppState>>
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        requireAppKeyShape(ctx.params.appKey);
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        const query = ctx.request.path.split('?')[1] ?? '';
        const namespace = new URLSearchParams(query).get('namespace');
        if (namespace === null || !NAMESPACE_PATTERN.test(namespace)) {
          throw new NotFoundError(
            'app state namespace',
            namespace ?? '(missing ?namespace=app:<key>:<local> query parameter)',
          );
        }
        return modules.firstPartyApps.exportPackAppState({
          workspaceId: ctx.params.workspaceId,
          appKey: ctx.params.appKey,
          namespace,
        });
      },
      respond: (ctx) => jsonResponse(200, ctx.result as unknown as Record<string, unknown>),
    }),
  );

  // -------------------------------------------------------------------------
  // DELETE /api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state
  // — the delete semantics of the bounded app state.
  // -------------------------------------------------------------------------

  router.add(
    'DELETE',
    '/api/first-party-apps/workspaces/:workspaceId/packs/:appKey/state',
    defineMutationRoute<
      { workspaceId: string; appKey: string },
      { readonly existed: boolean; readonly namespace: string }
    >({
      authenticator: services.auth,
      resolveOwner: async (_ctx, params) => {
        requireAppKeyShape(params.appKey);
        return workspaceOwner(params.workspaceId);
      },
      authorize: async (ctx) => {
        await requireWorkspaceAccess(modules, ctx.principal, ctx.params.workspaceId, [
          ...STATE_MANAGER_ROLES,
        ]);
      },
      validate: (ctx) => {
        const query = ctx.request.path.split('?')[1] ?? '';
        const namespace = new URLSearchParams(query).get('namespace');
        if (namespace === null || !NAMESPACE_PATTERN.test(namespace)) {
          throw new NotFoundError(
            'app state namespace',
            namespace ?? '(missing ?namespace=app:<key>:<local> query parameter)',
          );
        }
        return { namespace };
      },
      execute: async (ctx) => {
        const body = ctx.validated as { readonly namespace: string };
        const existed = await modules.firstPartyApps.deletePackAppState({
          workspaceId: ctx.params.workspaceId,
          appKey: ctx.params.appKey,
          namespace: body.namespace,
        });
        return { existed, namespace: body.namespace };
      },
      emit: async (ctx) => {
        logger.info('first-party-apps.state-deleted', undefined, {
          workspace_id: ctx.params.workspaceId,
          app_key: ctx.params.appKey,
          namespace: ctx.result.namespace,
          correlation_id: currentCorrelation().correlationId,
        });
        await recordMutationAudit(modules, ctx.principal, ctx.owner, {
          action: 'firstpartyapps.state-deleted',
          targetType: 'app_state',
          targetId: `${ctx.params.appKey}:${ctx.result.namespace}`,
          details: {
            workspaceId: ctx.params.workspaceId,
            appKey: ctx.params.appKey,
            namespace: ctx.result.namespace,
          },
        });
      },
      respond: (ctx) => jsonResponse(200, { existed: ctx.result }),
    }),
  );

  void objectField;
  void UUID_PATTERN;
  void auditActor;
  void (null as unknown as Principal | null);
}
