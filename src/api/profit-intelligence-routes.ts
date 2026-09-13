/**
 * /profit-intelligence API routes (MKT-043 — Profit Intelligence).
 *
 *   GET    /api/profit-intelligence/:agencyId                                        the Agency's portfolio profit intelligence
 *   GET    /api/profit-intelligence/:agencyId/clients/:clientId                      the Client's profit intelligence
 *   GET    /api/profit-intelligence/:agencyId/clients/:clientId/workspaces/:workspaceId   the Workspace's profit intelligence
 *
 * Authority composition (the frozen boundary — this file is a THIN
 * delegation layer over the /profit-intelligence module's public contract,
 * the MKT-041 operating-graph precedent):
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
 *     house posture); anonymous calls are 401 (fail closed). The client and
 *     workspace detail selectors resolve against the agency's OWN
 *     live-client / live-workspace listings — a foreign identifier is the
 *     SAME uniform 404;
 *   - SERVER-SIDE AGENCY SCOPING BEFORE TRAVERSAL: the aggregation scope
 *     (the agency's LIVE clients + each client's workspaces + the agency's
 *     ACTIVE human_agent membership users) is resolved from durable state
 *     at the route layer (/clients, /workspaces, /agencies public
 *     contracts) and handed to the module as SERVER-DERIVED aggregation
 *     inputs (the scope-as-data posture). A client, workspace or human
 *     identifier is never accepted from the caller beyond the path
 *     SELECTORS, which are re-validated against durable state;
 *   - READ-ONLY BY CONSTRUCTION: the surface registers EXACTLY THREE
 *     routes and all are GETs — no mutating verb is registered anywhere in
 *     this file (the router 405s POST/PUT/PATCH/DELETE on the paths), the
 *     routes read NO request body, validate NO DTO, read NO query
 *     parameter, and no authority field (agency/client/workspace
 *     identifiers, statuses, provenance, assumptions, calculation version)
 *     can be supplied by the caller at all. Profit Intelligence can
 *     recommend but cannot mutate financial/accounting authority — there
 *     is no HTTP write path into any authority, so a frontend bypass has
 *     nothing to drive (architecture-lock-v1.5 #6);
 *   - the response discloses the derivation honestly: every material
 *     figure carries its source references, its calculation version and
 *     the assumption keys it consumed; the full frozen assumption record
 *     ships in every response (no hidden constants).
 */

import type { AppServices } from '../platform/app-services.ts';
import type { Router } from '../platform/http/router.ts';
import { jsonResponse, defineQueryRoute } from '../platform/http/pipeline.ts';
import { ForbiddenError, NotFoundError } from '../platform/errors/errors.ts';
import type { Principal } from '../platform/http/auth/contract.ts';
import type { ApplicationModules } from './application.ts';
import { resolveContext } from './authorize.ts';
import type {
  AgencyProfitIntelligenceView,
  ClientProfitIntelligenceView,
  ProfitFigure,
  WorkspaceProfitIntelligenceView,
} from '../modules/profit-intelligence/public.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agency-scoped profit-intelligence posture (the operating-graph
 * posture): the durable agency row and the caller's membership in THAT
 * agency resolve from durable state BEFORE any dependent traversal. A
 * malformed, unknown or FOREIGN agency identifier is the uniform 404
 * (cross-agency data must 404, not 403-leak existence); a caller with an
 * ACTIVE membership passes (any agency role — the read posture of every
 * agency-scoped read surface); a suspended membership or a disabled
 * identity is the 403.
 */
async function requireProfitIntelligenceAgency(
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

// ---------------------------------------------------------------------------
// Serialization — the profit-intelligence response vocabulary (presentation
// only; every field of the derived view ships, nothing invented)
// ---------------------------------------------------------------------------

function serializeSourceRef(ref: { readonly kind: string; readonly id: string }): Record<string, unknown> {
  return { kind: ref.kind, id: ref.id };
}

function serializeFigure(figure: ProfitFigure): Record<string, unknown> {
  return {
    value: figure.value,
    currency: figure.currency,
    provenance: figure.provenance,
    calculationVersion: figure.calculationVersion,
    sourceRefs: figure.sourceRefs.map(serializeSourceRef),
    assumptionKeys: [...figure.assumptionKeys],
    ...(figure.notDerivableReason === null ? {} : { notDerivableReason: figure.notDerivableReason }),
  };
}

function serializeRevenueRollup(revenue: ClientProfitIntelligenceView['revenue']): Record<string, unknown> {
  return {
    byCurrency: revenue.byCurrency.map((entry) => ({
      currency: entry.currency,
      total: serializeFigure(entry.total),
      identityCount: entry.identityCount,
      sourceRefs: entry.sourceRefs.map(serializeSourceRef),
    })),
    observationCount: revenue.observationCount,
    restatedIdentityCount: revenue.restatedIdentityCount,
    supersededObservationCount: revenue.supersededObservationCount,
    qualityCounts: revenue.qualityCounts,
    evidenceRefs: revenue.evidenceRefs.map(serializeSourceRef),
  };
}

function serializeAiProvider(aiProvider: ClientProfitIntelligenceView['costs']['aiProvider']): Record<string, unknown> {
  return {
    telemetryCost: serializeFigure(aiProvider.telemetryCost),
    telemetryRowCount: aiProvider.telemetryRowCount,
    adapterActivity: aiProvider.adapterActivity.map((row) => ({
      adapterKey: row.adapterKey,
      connectionCount: row.connectionCount,
      ingestedEventCount: row.ingestedEventCount,
      connectionRefs: row.connectionRefs.map(serializeSourceRef),
      eventRefs: row.eventRefs.map(serializeSourceRef),
    })),
    adapterActivityNote: aiProvider.adapterActivityNote,
  };
}

function serializeCosts(costs: ClientProfitIntelligenceView['costs']): Record<string, unknown> {
  return {
    humanDeliveryCost: serializeFigure(costs.humanDeliveryCost),
    deliveredJobCount: costs.deliveredJobCount,
    inFlightJobCount: costs.inFlightJobCount,
    automationDeliveryCost: serializeFigure(costs.automationDeliveryCost),
    totalDeliveryCost: serializeFigure(costs.totalDeliveryCost),
    executionCounts: costs.executionCounts,
    executionStatusCounts: costs.executionStatusCounts,
    aiProvider: serializeAiProvider(costs.aiProvider),
    humanExecutionCostAttribution: costs.humanExecutionCostAttribution,
  };
}

function serializeCapacity(capacity: ClientProfitIntelligenceView['capacity']): Record<string, unknown> {
  return {
    activeProfileCount: capacity.activeProfileCount,
    skippedProfileCount: capacity.skippedProfileCount,
    weeklyCapacityMinutes: capacity.weeklyCapacityMinutes,
    weeklyCapacityCost: serializeFigure(capacity.weeklyCapacityCost),
    profileRefs: capacity.profileRefs.map(serializeSourceRef),
  };
}

function serializeUtilization(utilization: ClientProfitIntelligenceView['utilization']): Record<string, unknown> {
  return {
    deliveredWorkMinutes: serializeFigure(utilization.deliveredWorkMinutes),
    capacityMinutes: serializeFigure(utilization.capacityMinutes),
    utilization: serializeFigure(utilization.utilization),
    humanExecutionCount: utilization.humanExecutionCount,
    numeratorNote: utilization.numeratorNote,
  };
}

function serializeScopeLeakage(leakage: ClientProfitIntelligenceView['scopeLeakage']): Record<string, unknown> {
  return {
    indicators: leakage.indicators.map((indicator) => ({
      kind: indicator.kind,
      rule: indicator.rule,
      count: indicator.count,
      sourceRefs: indicator.sourceRefs.map(serializeSourceRef),
    })),
  };
}

function serializeMargin(margin: ClientProfitIntelligenceView['margin']): Record<string, unknown> {
  return {
    realizedRevenue: serializeFigure(margin.realizedRevenue),
    realizedDeliveryCost: serializeFigure(margin.realizedDeliveryCost),
    realizedMargin: serializeFigure(margin.realizedMargin),
    estimatedRevenue: serializeFigure(margin.estimatedRevenue),
    estimatedDeliveryCost: serializeFigure(margin.estimatedDeliveryCost),
    estimatedMargin: serializeFigure(margin.estimatedMargin),
    currencyPolicyNote: margin.currencyPolicyNote,
  };
}

function serializeCalculation(calculation: ClientProfitIntelligenceView['calculation']): Record<string, unknown> {
  return {
    calculationVersion: calculation.calculationVersion,
    assumptions: calculation.assumptions,
    basis: calculation.basis,
    persistence: calculation.persistence,
  };
}

function serializeClientView(view: ClientProfitIntelligenceView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceCount: view.scope.workspaceCount,
    },
    revenue: serializeRevenueRollup(view.revenue),
    costs: serializeCosts(view.costs),
    capacity: serializeCapacity(view.capacity),
    utilization: serializeUtilization(view.utilization),
    scopeLeakage: serializeScopeLeakage(view.scopeLeakage),
    margin: serializeMargin(view.margin),
    serviceContributions: view.serviceContributions.map((row) => ({
      playbookId: row.playbookId,
      deliveryCost: serializeFigure(row.deliveryCost),
      revenue: serializeFigure(row.revenue),
      deliveredJobCount: row.deliveredJobCount,
      executionCount: row.executionCount,
    })),
    unattributedServiceDeliveryCost: serializeFigure(view.unattributedServiceDeliveryCost),
    projectContributions: view.projectContributions.map((row) => ({
      deploymentId: row.deploymentId,
      deploymentStatus: row.deploymentStatus,
      deliveryCost: serializeFigure(row.deliveryCost),
      revenue: serializeFigure(row.revenue),
      deliveredJobCount: row.deliveredJobCount,
      executionCount: row.executionCount,
    })),
    unattributedProjectDeliveryCost: serializeFigure(view.unattributedProjectDeliveryCost),
    calculation: serializeCalculation(view.calculation),
    generatedAt: view.generatedAt,
  };
}

function serializeWorkspaceView(view: WorkspaceProfitIntelligenceView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientId: view.scope.clientId,
      workspaceId: view.scope.workspaceId,
    },
    revenue: serializeRevenueRollup(view.revenue),
    costs: serializeCosts(view.costs),
    utilization: serializeUtilization(view.utilization),
    scopeLeakage: serializeScopeLeakage(view.scopeLeakage),
    margin: serializeMargin(view.margin),
    calculation: serializeCalculation(view.calculation),
    generatedAt: view.generatedAt,
  };
}

function serializeAgencyView(view: AgencyProfitIntelligenceView): Record<string, unknown> {
  return {
    scope: {
      kind: view.scope.kind,
      agencyId: view.scope.agencyId,
      clientCount: view.scope.clientCount,
      humanAgentCount: view.scope.humanAgentCount,
    },
    perClient: view.perClient.map((row) => ({
      clientId: row.clientId,
      revenue: serializeFigure(row.revenue),
      deliveryCost: serializeFigure(row.deliveryCost),
      margin: serializeFigure(row.margin),
    })),
    serviceContributions: view.serviceContributions.map((row) => ({
      playbookId: row.playbookId,
      deliveryCost: serializeFigure(row.deliveryCost),
      revenue: serializeFigure(row.revenue),
      deliveredJobCount: row.deliveredJobCount,
      executionCount: row.executionCount,
    })),
    unattributedServiceDeliveryCost: serializeFigure(view.unattributedServiceDeliveryCost),
    projectContributions: view.projectContributions.map((row) => ({
      deploymentId: row.deploymentId,
      deploymentStatus: row.deploymentStatus,
      deliveryCost: serializeFigure(row.deliveryCost),
      revenue: serializeFigure(row.revenue),
      deliveredJobCount: row.deliveredJobCount,
      executionCount: row.executionCount,
    })),
    unattributedProjectDeliveryCost: serializeFigure(view.unattributedProjectDeliveryCost),
    revenue: serializeRevenueRollup(view.revenue),
    costs: serializeCosts(view.costs),
    capacity: serializeCapacity(view.capacity),
    utilization: serializeUtilization(view.utilization),
    scopeLeakage: serializeScopeLeakage(view.scopeLeakage),
    margin: serializeMargin(view.margin),
    calculation: serializeCalculation(view.calculation),
    generatedAt: view.generatedAt,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function registerProfitIntelligenceRoutes(
  router: Router,
  services: AppServices,
  modules: ApplicationModules,
): void {
  // -------------------------------------------------------------------------
  // GET /api/profit-intelligence/:agencyId — THE AGENCY PORTFOLIO VIEW (the
  // per-client contribution rows + service/project contributions + the
  // capacity, utilization, leakage and margin rollups). READ-ONLY by
  // construction: the scope is server-derived from the authenticated
  // identity + durable agency/membership + live-client state.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/profit-intelligence/:agencyId',
    defineQueryRoute<{ agencyId: string }, AgencyProfitIntelligenceView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline (the house
        // posture of the other read surfaces).
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);

        // SERVER-DERIVED aggregation scope: the agency's LIVE clients (the
        // /clients public contract — tombstones excluded by the authority)
        // and the agency's ACTIVE human_agent membership users (the
        // /agencies membership authority — the capacity pool + the jobs
        // enumeration window). A client or human identifier is never
        // accepted from the caller; cross-agency data is structurally
        // unreachable because both listings are scoped to the authorized
        // agency.
        const clients = await modules.clients.listClientsForAgency(ctx.params.agencyId);
        const memberships = await modules.agencies.listMemberships(ctx.params.agencyId);
        const humanAgentUserIds = memberships
          .filter(
            (membership) => membership.role === 'human_agent' && membership.status === 'active',
          )
          .map((membership) => membership.userId);
        return modules.profitIntelligence.getAgencyProfitIntelligence({
          agencyId: ctx.params.agencyId,
          clients: clients.map((client) => ({ clientId: client.clientId })),
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeAgencyView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/profit-intelligence/:agencyId/clients/:clientId — THE CLIENT'S
  // PROFIT INTELLIGENCE (the full derived surface: revenue, delivery cost,
  // capacity, utilization, scope leakage, margins and the service/project
  // contribution breakdown). The path Client is validated against the
  // agency's OWN live clients: a Client of another agency is the SAME
  // uniform 404 (no cross-agency existence oracle), and the module
  // re-resolves canonical ownership before any dependent traversal.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/profit-intelligence/:agencyId/clients/:clientId',
    defineQueryRoute<{ agencyId: string; clientId: string }, ClientProfitIntelligenceView>({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);

        const memberships = await modules.agencies.listMemberships(ctx.params.agencyId);
        const humanAgentUserIds = memberships
          .filter(
            (membership) => membership.role === 'human_agent' && membership.status === 'active',
          )
          .map((membership) => membership.userId);
        return modules.profitIntelligence.getClientProfitIntelligence({
          clientId: ctx.params.clientId,
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeClientView(ctx.result)),
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/profit-intelligence/:agencyId/clients/:clientId/workspaces/:workspaceId
  // — THE WORKSPACE'S PROFIT INTELLIGENCE (the workspace-scoped slice:
  // workspace-tagged revenue observations, the workspace's executions and
  // telemetry, the workspace slice of scope leakage). The path Workspace is
  // validated against the OWNING client's live workspaces — a foreign
  // Workspace is the same uniform 404.
  // -------------------------------------------------------------------------
  router.add(
    'GET',
    '/api/profit-intelligence/:agencyId/clients/:clientId/workspaces/:workspaceId',
    defineQueryRoute<
      { agencyId: string; clientId: string; workspaceId: string },
      WorkspaceProfitIntelligenceView
    >({
      authenticator: services.auth,
      authorize: async (ctx) => {
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        await requireWorkspaceInClient(modules, ctx.params.clientId, ctx.params.workspaceId);
      },
      execute: async (ctx) => {
        // Authorization is re-resolved FRESH here — the execute step never
        // trusts anything resolved earlier in the pipeline.
        await requireProfitIntelligenceAgency(modules, ctx.principal, ctx.params.agencyId);
        await requireClientInAgency(modules, ctx.params.agencyId, ctx.params.clientId);
        await requireWorkspaceInClient(modules, ctx.params.clientId, ctx.params.workspaceId);

        const memberships = await modules.agencies.listMemberships(ctx.params.agencyId);
        const humanAgentUserIds = memberships
          .filter(
            (membership) => membership.role === 'human_agent' && membership.status === 'active',
          )
          .map((membership) => membership.userId);
        return modules.profitIntelligence.getWorkspaceProfitIntelligence({
          workspaceId: ctx.params.workspaceId,
          humanAgentUserIds,
        });
      },
      respond: (ctx) => jsonResponse(200, serializeWorkspaceView(ctx.result)),
    }),
  );
}
