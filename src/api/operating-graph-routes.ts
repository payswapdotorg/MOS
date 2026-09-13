/**
 * /operating-graph API routes (MKT-041 — Agency Operating Graph).
 *
 *   GET    /api/operating-graph/:agencyId                      the Agency's operating graph (portfolio rollup)
 *   GET    /api/operating-graph/:agencyId/clients/:clientId    the Client's operating graph (full relation set + history)
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the /operating-graph module's public contract, the
 * MKT-029 command-center precedent):
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
 *     house posture); anonymous calls are 401 (fail closed). The client
 *     detail resolves the Client against the agency's OWN live-client
 *     listing — a Client of another agency is the SAME uniform 404;
 *   - SERVER-SIDE AGENCY SCOPING BEFORE TRAVERSAL: the aggregation scope
 *     (the agency's LIVE clients + each client's Workspace counts) is
 *     resolved from durable state at the route layer (/clients +
 *     /workspaces public contracts — matrix directions the /operating-graph
 *     module does not hold) and handed to the module as SERVER-DERIVED
 *     aggregation inputs (the scope-as-data posture). A client or
 *     workspace identifier is never accepted from the caller beyond the
 *     path SELECTOR, which is re-validated against durable state;
 *   - READ-ONLY BY CONSTRUCTION: the surface registers EXACTLY TWO routes
 *     and both are GETs — no mutating verb is registered anywhere in this
 *     file (the router 405s POST/PUT/PATCH/DELETE on the paths), the routes
 *     read NO request body, validate NO DTO, and no authority field
 *     (agency/client/workspace identifiers, statuses, provenance) can be
 *     supplied by the caller at all. The REBUILD is deliberately NOT a
 *     route: derived-edge recomputation is a module-level operation for
 *     background workers and later v1.5 Work Items — there is no HTTP
 *     write path into the graph, so a frontend bypass has nothing to
 *     drive;
 *   - the response discloses the derivation basis honestly: the graph
 *     presents the derived ledger of canonical source references (the
 *     /evidence relations derive from the authority's bounded
 *     newest-first listing — never an unbounded recount), and the frozen
 *     five-value epistemic vocabulary arrives DISTINCT (unknown/observed/
 *     predicted/attributed/causal are never conflated).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import type {
  AgencyOperatingGraphView,
  ClientOperatingGraphView,
} from '../modules/operating-graph/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped operating-graph posture (the command-center posture):
 * the durable agency row and the caller's membership in THAT agency resolve
 * from durable state BEFORE any dependent traversal. A malformed, unknown
 * or FOREIGN agency identifier is the uniform 404 (cross-agency data must
 * 404, not 403-leak existence — a foreign principal learns nothing about
 * whether the agency exists); a caller with an ACTIVE membership passes
 * (any agency role — the read posture of every agency-scoped read surface);
 * a suspended membership or a disabled identity is the 403.
 */
async function requireOperatingGraphAgency(
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

// ---------------------------------------------------------------------------
// Serialization — the operating-graph response vocabulary (presentation only)
// ---------------------------------------------------------------------------

function serializeAgencyGraph(view: AgencyOperatingGraphView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientCount: view.scope.clientCount,
    },
    totals: {
      nodeCount: view.totals.nodeCount,
      edgeCount: view.totals.edgeCount,
    },
    perClient: view.perClient.map((tally) => ({
      clientId: tally.clientId,
      workspaceCount: tally.workspaceCount,
      nodeCount: tally.nodeCount,
      edgeCount: tally.edgeCount,
      relationCounts: tally.relationCounts,
    })),
    derivation: {
      basis: view.derivation.basis,
      evidenceWindow: view.derivation.evidenceWindow,
      edgeStates: view.derivation.edgeStates,
    },
    generatedAt: view.generatedAt,
  };
}

function serializeClientGraph(view: ClientOperatingGraphView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceCount: view.scope.workspaceCount,
    },
    nodeCount: view.nodeCount,
    edgeCount: view.edgeCount,
    nodes: view.nodes.map((node) => ({
      kind: node.kind,
      id: node.id,
      agencyId: node.agencyId,
      ...(node.clientId === null ? {} : { clientId: node.clientId }),
      ...(node.workspaceId === null ? {} : { workspaceId: node.workspaceId }),
      firstSeenAt: node.firstSeenAt,
      lastRefreshedAt: node.lastRefreshedAt,
    })),
    edges: view.edges.map((edge) => ({
      fromKind: edge.fromKind,
      fromId: edge.fromId,
      toKind: edge.toKind,
      toId: edge.toId,
      relation: edge.relation,
      ...(edge.workspaceId === null ? {} : { workspaceId: edge.workspaceId }),
      current: {
        edgeId: edge.current.edgeId,
        edgeVersion: edge.current.edgeVersion,
        edgeState: edge.current.edgeState,
        recordedAt: edge.current.recordedAt,
        recordedBy: edge.current.recordedBy,
      },
      history: edge.history.map((version) => ({
        edgeId: version.edgeId,
        edgeVersion: version.edgeVersion,
        edgeState: version.edgeState,
        recordedAt: version.recordedAt,
        recordedBy: version.recordedBy,
        ...(version.supersededAt === null ? {} : { supersededAt: version.supersededAt }),
      })),
    })),
    supersededEdges: view.supersededEdges.map((edge) => ({
      fromKind: edge.fromKind,
      fromId: edge.fromId,
      toKind: edge.toKind,
      toId: edge.toId,
      relation: edge.relation,
      lastVersion: {
        edgeId: edge.lastVersion.edgeId,
        edgeVersion: edge.lastVersion.edgeVersion,
        edgeState: edge.lastVersion.edgeState,
        recordedAt: edge.lastVersion.recordedAt,
        recordedBy: edge.lastVersion.recordedBy,
        supersededAt: edge.lastVersion.supersededAt,
      },
    })),
    derivation: {
      basis: view.derivation.basis,
      evidenceWindow: view.derivation.evidenceWindow,
      edgeStates: view.derivation.edgeStates,
    },
    generatedAt: view.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerOperatingGraphRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/operating-graph/:agencyId — THE AGENCY OPERATING GRAPH (the
  // portfolio rollup over the agency's Client graphs). READ-ONLY by
  // construction: the scope is server-derived from the authenticated
  // identity + durable agency/membership + live-client state.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/operating-graph/:agencyId',
    defineQueryRoute<{ agencyId: string }, AgencyOperatingGraphView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireOperatingGraphAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        await requireOperatingGraphAgency(modules, ctx.principal, ctx.params.agencyId);

        // SERVER-DERIVED aggregation scope: the agency's LIVE clients (the
        // /clients public contract — tombstones excluded by the authority)
        // and each client's Workspace enumeration (the /workspaces public
        // contract). A client or workspace identifier is never accepted
        // from the caller; cross-agency data is structurally unreachable
        // because the listing itself is scoped to the authorized agency.
        const clients = await modules.clients.listClientsForAgency(ctx.params.agencyId);
        const clientScopes = [] as Array<{ clientId: string; workspaceCount: number }>;
        for (const client of clients) {
          const workspaces = await modules.workspaces.listWorkspacesForClient(client.clientId);
          clientScopes.push({
            clientId: client.clientId,
            workspaceCount: workspaces.length,
          });
        }
        return modules.operatingGraph.getAgencyOperatingGraph({
          agencyId: ctx.params.agencyId,
          clients: clientScopes,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgencyGraph(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/operating-graph/:agencyId/clients/:clientId — THE CLIENT'S
  // OPERATING GRAPH (the full derived relation set with version history).
  // The path Client is validated against the agency's OWN live clients: a
  // Client of another agency is the SAME uniform 404 (no cross-agency
  // existence oracle), and the module re-resolves canonical ownership
  // before any dependent traversal.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/operating-graph/:agencyId/clients/:clientId',
    defineQueryRoute<{ agencyId: string; clientId: string }, ClientOperatingGraphView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireOperatingGraphAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireOperatingGraphAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);

        return modules.operatingGraph.getClientOperatingGraph({
          clientId: ctx.params.clientId,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClientGraph(ctx.result)),
    }),
  );
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
