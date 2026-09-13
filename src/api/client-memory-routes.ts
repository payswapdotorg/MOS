/**
 * /client-memory API routes (MKT-044 — Client Operating Memory).
 *
 *   GET    /api/client-memory/:agencyId/clients/:clientId                              the Client's operating memory (the full governed projection)
 *   GET    /api/client-memory/:agencyId/clients/:clientId/workspaces/:workspaceId      the Workspace's memory slice (the covering-rule projection)
 *   GET    /api/client-memory/:agencyId/clients/:clientId/records/:kind                the kind-filtered retrieval over the projected records
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the /client-memory module's public contract,
 * the MKT-043 profit-intelligence route precedent):
 *
 *   - AGENCY-SCOPED, SERVER-DERIVED SCOPE: the route authorizes the agency
 *     principal against the SAME durable-membership authority as every
 *     agency-scoped surface (users + agency memberships resolved FRESH from
 *     durable state — headers, body fields or client-side claims are never
 *     trusted). The agency existence and the caller's membership resolve
 *     from durable state BEFORE any dependent traversal; the path agencyId
 *     only SELECTS which durable agency scope gets resolved (§14: a
 *     caller-supplied identifier is never authorization);
 *   - THE HARD TENANT BOUNDARY: a caller with NO membership in the OWNING
 *     agency gets the UNIFORM 404 — a foreign agency identifier is
 *     indistinguishable from an unknown or malformed one (no
 *     existence/traversal oracle). A SUSPENDED membership or disabled
 *     identity is the 403 (an authenticated-but-intra-tenant failure, the
 *     house posture); anonymous calls are 401 (fail closed). The client,
 *     workspace and record-kind detail selectors resolve against the
 *     agency's OWN live-client / live-workspace listings and the frozen
 *     projection vocabulary — a foreign or unknown selector is the SAME
 *     uniform 404;
 *   - SERVER-SIDE AGENCY SCOPING BEFORE TRAVERSAL: the client and
 *     workspace selectors are re-validated against durable state on EVERY
 *     step (authorize + execute — the execute step never trusts anything
 *     resolved earlier in the pipeline); the memory itself is derived by
 *     the module through the composed authorities' public contracts only;
 *   - READ-ONLY BY CONSTRUCTION: the surface registers EXACTLY THREE
 *     routes and all are GETs — no mutating verb is registered anywhere in
 *     this file (the router 405s POST/PUT/PATCH/DELETE on the paths), the
 *     routes read NO request body, validate NO DTO and read NO query
 *     parameter (the platform router strips the query string before
 *     handlers run; the record-kind filter is a PATH selector over the
 *     frozen vocabulary, never an authority field). There is NO HTTP write
 *     path into any authority, so a frontend bypass has nothing to drive
 *     (no second tenant/data authority — PostgreSQL remains authoritative);
 *   - the response discloses the governance honestly: every memory item
 *     cites its canonical record id, the full frozen projection vocabulary
 *     (record kinds + selection rules + ordering + summary bound +
 *     freshness policy) ships in every response (`projection` disclosure
 *     — policy-visible composition, no hidden rules).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import type {
  ClientMemoryItem,
  ClientMemoryKindSlice,
  ClientMemoryRecordKind,
  ClientMemoryView,
  MemorySourceRef,
  ProjectionDisclosure,
  WorkspaceMemoryView,
} from '../modules/client-memory/public.ts';
import { CLIENT_MEMORY_RECORD_KINDS } from '../modules/client-memory/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped client-memory posture (the profit-intelligence
 * posture): the durable agency row and the caller's membership in THAT
 * agency resolve from durable state BEFORE any dependent traversal. A
 * malformed, unknown or FOREIGN agency identifier is the uniform 404
 * (cross-agency data must 404, not 403-leak existence); a caller with an
 * ACTIVE membership passes (any agency role — the read posture of every
 * agency-scoped read surface); a suspended membership or a disabled
 * identity is the 403.
 */
async function requireClientMemoryAgency(
  modules: ApplicationModules,
  principal: Principal,
  agencyId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(agencyId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('agency', agencyId);
  }
  const agency = await modules.agencies.getAgency(agencyId);
  if (agency === null) {
    throw new NotFoundError('agency', agencyId);
  }

  if (principal.kind === 'service') return;

  const context = await resolveContext(modules, principal);
  if (context === null || context.principal.status !== 'active') {
    throw new ForbiddenError('Active user identity required');
  }
  if (context.platformRoles.includes('platform_administrator')) return;

  const membership = context.memberships.find((entry) => entry.agencyId === agencyId);
  if (membership === undefined) {
    // Hard boundary: not a member of the OWNING agency → the same 404 as
    // for an unknown agency (uniform, no cross-agency existence oracle).
    throw new NotFoundError('agency', agencyId);
  }
  if (membership.membershipStatus !== 'active') {
    throw new ForbiddenError('Active membership in this agency required');
  }
}

/**
 * The client-detail selector posture: the path clientId must be one of the
 * OWNING agency's live Clients (resolved FRESH from durable state) — a
 * foreign, unknown or malformed Client identifier is the uniform 404.
 */
async function requireClientInAgency(
  modules: ApplicationModules,
  agencyId: string,
  clientId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(clientId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('client', clientId);
  }
  const clients = await modules.clients.listClientsForAgency(agencyId);
  const match = clients.find((client) => client.clientId === clientId);
  if (match === undefined) {
    // Hard boundary: the Client belongs to another agency (or is unknown) —
    // the same 404 as an unknown client (no cross-agency existence oracle).
    throw new NotFoundError('client', clientId);
  }
}

/**
 * The workspace-detail selector posture: the path workspaceId must be one
 * of the OWNING client's LIVE workspaces (resolved FRESH from durable
 * state) — a foreign, unknown or malformed Workspace identifier is the
 * uniform 404.
 */
async function requireWorkspaceInClient(
  modules: ApplicationModules,
  clientId: string,
  workspaceId: string,
): Promise<void> {
  if (!UUID_PATTERN.test(workspaceId)) {
    // A malformed identifier is indistinguishable from an unknown one.
    throw new NotFoundError('workspace', workspaceId);
  }
  const workspaces = await modules.workspaces.listWorkspacesForClient(clientId);
  const match = workspaces.find((workspace) => workspace.workspaceId === workspaceId);
  if (match === undefined) {
    // Hard boundary: the Workspace belongs to another client (or is
    // unknown) — the same 404 as an unknown workspace.
    throw new NotFoundError('workspace', workspaceId);
  }
}

/**
 * The record-kind selector posture: the path kind must be one of the
 * FROZEN projection vocabulary's record kinds — an unknown or malformed
 * kind is the uniform 404 (fail-closed, no vocabulary oracle: an unknown
 * selector is indistinguishable from an unknown record).
 */
function requireKnownMemoryKind(kind: string): asserts kind is ClientMemoryRecordKind {
  if (!(CLIENT_MEMORY_RECORD_KINDS as readonly string[]).includes(kind)) {
    throw new NotFoundError('client-memory-record-kind', kind);
  }
}

// ---------------------------------------------------------------------------
// Serialization — the client-memory response vocabulary (presentation
// only; every field of the derived view ships, nothing invented)
// ---------------------------------------------------------------------------

function serializeSourceRef(ref: MemorySourceRef): Record<string, unknown> {
  return { kind: ref.kind, id: ref.id };
}

function serializeItem(item: ClientMemoryItem): Record<string, unknown> {
  return {
    kind: item.kind,
    id: item.id,
    summary: item.summary,
    status: item.status,
    workspaceId: item.workspaceId,
    recordedAt: item.recordedAt,
    links: item.links.map(serializeSourceRef),
  };
}

function serializeProjection(view: { readonly projection: ProjectionDisclosure }): Record<string, unknown> {
  const projection = view.projection;
  return {
    projectionVersion: projection.projectionVersion,
    recordKinds: [...projection.recordKinds],
    selectionRules: projection.selectionRules,
    basis: projection.basis,
    persistence: projection.persistence,
    retrievalTechnology: projection.retrievalTechnology,
  };
}

function serializeClientView(view: ClientMemoryView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceCount: view.scope.workspaceCount,
    },
    profile: {
      sourceRef: serializeSourceRef(view.profile.sourceRef),
      name: view.profile.name,
      slug: view.profile.slug,
      status: view.profile.status,
      createdAt: view.profile.createdAt,
      updatedAt: view.profile.updatedAt,
    },
    workspaces: view.workspaces.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      status: workspace.status,
    })),
    items: view.items.map(serializeItem),
    perKind: view.perKind,
    supersededEvidenceCount: view.supersededEvidenceCount,
    projection: serializeProjection(view),
    generatedAt: view.generatedAt,
  };
}

function serializeWorkspaceView(view: WorkspaceMemoryView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceId: view.scope.workspaceId,
    },
    profile: {
      sourceRef: serializeSourceRef(view.profile.sourceRef),
      name: view.profile.name,
      slug: view.profile.slug,
      status: view.profile.status,
      createdAt: view.profile.createdAt,
      updatedAt: view.profile.updatedAt,
    },
    workspace: {
      workspaceId: view.workspace.workspaceId,
      name: view.workspace.name,
      status: view.workspace.status,
    },
    items: view.items.map(serializeItem),
    perKind: view.perKind,
    supersededEvidenceCount: view.supersededEvidenceCount,
    projection: serializeProjection(view),
    generatedAt: view.generatedAt,
  };
}

function serializeKindSlice(view: ClientMemoryKindSlice): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      recordKind: view.scope.recordKind,
    },
    items: view.items.map(serializeItem),
    perKindTotal: view.perKindTotal,
    projection: serializeProjection(view),
    generatedAt: view.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerClientMemoryRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/client-memory/:agencyId/clients/:clientId — THE CLIENT'S
  // OPERATING MEMORY (the full governed projection over the client
  // profile, goals, own playbooks + versions, deployments, current
  // evidence, experiments, observed outcomes, decisions and learnings —
  // every item citing its canonical record id, the frozen projection
  // vocabulary shipping in the response). READ-ONLY by construction: the
  // scope is server-derived from the authenticated identity + durable
  // agency/membership + live-client state.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/client-memory/:agencyId/clients/:clientId',
    defineQueryRoute<{ agencyId: string; clientId: string }, ClientMemoryView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);

        return modules.clientMemory.getClientMemory({
          clientId: ctx.params.clientId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClientView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/client-memory/:agencyId/clients/:clientId/workspaces/:workspaceId
  // — THE WORKSPACE'S MEMORY SLICE (the covering-rule projection:
  // client-wide items + the workspace's own items). The path Workspace is
  // validated against the OWNING client's live workspaces — a foreign
  // Workspace is the same uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/client-memory/:agencyId/clients/:clientId/workspaces/:workspaceId',
    defineQueryRoute<
      { agencyId: string; clientId: string; workspaceId: string },
      WorkspaceMemoryView
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        await requireWorkspaceInClient(modules, ctx.params.clientId, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        await requireWorkspaceInClient(modules, ctx.params.clientId, ctx.params.workspaceId);

        return modules.clientMemory.getWorkspaceMemory({
          workspaceId: ctx.params.workspaceId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkspaceView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/client-memory/:agencyId/clients/:clientId/records/:kind — THE
  // KIND-FILTERED RETRIEVAL over the projected records: the full client
  // memory composes first (the same live derivation through the composed
  // authorities' public contracts), then the items of ONE frozen
  // vocabulary record kind are presented — a filter over DERIVED data,
  // NEVER a second query authority. The path kind is validated against
  // the exported frozen vocabulary; an unknown kind is the uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/client-memory/:agencyId/clients/:clientId/records/:kind',
    defineQueryRoute<
      { agencyId: string; clientId: string; kind: string },
      ClientMemoryKindSlice
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        requireKnownMemoryKind(ctx.params.kind);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireClientMemoryAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        requireKnownMemoryKind(ctx.params.kind);

        return modules.clientMemory.getClientMemoryByKind({
          clientId: ctx.params.clientId,
          kind: ctx.params.kind,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeKindSlice(ctx.result)),
    }),
  );
}
