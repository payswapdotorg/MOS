/**
 * The reporting/analytics family composer (mos-analytics) — the
 * PRESENTATION-ONLY composition over the /reporting Agency Command
 * Center + /profit-intelligence + /integrations public contracts
 * (MKT-051 AC-1a).
 *
 * INCUMBENT-CAPABILITY DISCIPLINE (the Non-goals rule): every figure of
 * the command-center card and the workspace report is READ from the
 * incumbent authorities' own views and CITED as composedFrom — the pack
 * reproduces the AgencyAnalytics-style surfaces over the SAME
 * authorities and never recomputes or shadows a single number. The
 * connected data sources come from the /integrations connection records
 * (the existing authority); the declared network destination and the
 * ANALYTICS_API_KEY credential name are consumed ONLY there — this
 * composer holds no HTTP client, no fetch, no SDK and no secret.
 */

import type { FirstPartyAppsModuleDeps } from '../../../public.ts';
import type {
  AnalyticsCommandCenterCardModel,
  AnalyticsReportPageModel,
  AppManifest,
} from '../../../public.ts';

/**
 * Composes the AgencyAnalytics-style command-center card for the agency
 * of the install's scope chain: the /reporting Agency Command Center
 * headline + risks, the /profit-intelligence portfolio margin (cited),
 * and the /integrations connected data sources. READ-ONLY.
 */
export async function composeAnalyticsCommandCenterCard(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly agencyId: string },
  manifest: AppManifest,
): Promise<AnalyticsCommandCenterCardModel> {
  // The agency's LIVE clients (the /clients authority's own listing —
  // the scope-as-data input the /reporting contract prescribes), each
  // with its workspace enumeration resolved through /workspaces exactly
  // as the incumbent command-center route does.
  const clients = await deps.clients.listClientsForAgency(scope.agencyId);
  const clientScopes: {
    readonly clientId: string;
    readonly workspaceIds: readonly string[];
  }[] = [];
  for (const client of clients) {
    const workspaces = await deps.workspaces.listWorkspacesForClient(client.clientId);
    clientScopes.push({
      clientId: client.clientId,
      workspaceIds: workspaces.map((workspace) => workspace.workspaceId),
    });
  }

  // The /reporting Agency Command Center (the incumbent authority view —
  // goals, workflow state, risks, approvals; never recomputed here).
  const commandCenter = await deps.reporting.getAgencyCommandCenter({
    agencyId: scope.agencyId,
    clients: clientScopes,
  });

  // The /profit-intelligence agency rollup (the incumbent authority
  // view — the portfolio margin figure is CITED from the authority's own
  // derivation with its calculation version; never recomputed here).
  const profit = await deps.profitIntelligence.getAgencyProfitIntelligence({
    agencyId: scope.agencyId,
    clients: clients.map((client) => ({ clientId: client.clientId })),
    humanAgentUserIds: [],
  });

  // The connected data sources of the declared connector family: the
  // /integrations authority's connection records of the agency's clients
  // (the ONLY place the declared network destination and the
  // ANALYTICS_API_KEY credential name are ever consumed — read-only
  // here; the composer lists what exists, it never connects).
  const adapters = new Set<string>();
  let connectionCount = 0;
  for (const client of clients) {
    const connections = await deps.integrations.listConnectionsForClient(client.clientId);
    for (const connection of connections) {
      connectionCount += 1;
      adapters.add(connection.adapterKey);
    }
  }

  // The per-status goal tally, read from the authority view's own
  // perClient tallies (a presentation grouping of cited rows).
  const goalsByStatus: Record<string, number> = {};
  for (const tally of commandCenter.portfolioGoals.perClient) {
    for (const [status, count] of Object.entries(tally.goalStatusCounts)) {
      goalsByStatus[status] = (goalsByStatus[status] ?? 0) + count;
    }
  }

  return {
    headline: {
      clientCount: commandCenter.scope.clientCount,
      goalCount: commandCenter.portfolioGoals.goals.length,
      goalsByStatus,
      workflowInstanceCount: commandCenter.workflowState.workflows.reduce(
        (sum, workflow) =>
          sum + Object.values(workflow.instanceCounts).reduce((a, b) => a + b, 0),
        0,
      ),
      pendingApprovals: commandCenter.pendingApprovals.items.length,
    },
    risks: {
      blockedInstanceCount: commandCenter.risks.summary.blockedInstanceCount,
      failedExecutionCount: commandCenter.risks.summary.failedExecutionCount,
      lowGradeEvidenceCount: commandCenter.risks.summary.lowGradeEvidenceRecords,
    },
    portfolio: {
      realizedMargin: {
        amount: profit.margin.realizedMargin.value,
        currency: profit.margin.realizedMargin.currency,
      },
      revenueObservationCount: profit.revenue.observationCount,
    },
    dataSources: {
      connectionCount,
      adapters: [...adapters].sort(),
    },
  };
  void manifest;
}

/**
 * Composes the workspace-scoped profit report page: the
 * /profit-intelligence WORKSPACE view (revenue, costs, utilization,
 * scope leakage, margins — every figure the authority's own derivation
 * with its calculation version). The v1.1.0 'compose-margin-breakdown'
 * capability adds the estimated-side breakdown; v1.0.0 reports null
 * (the capability-gated presentation, proven by the upgrade lifecycle).
 * READ-ONLY.
 */
export async function composeAnalyticsReportPage(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly workspaceId: string; readonly clientId: string },
  manifest: AppManifest,
): Promise<AnalyticsReportPageModel> {
  const profit = await deps.profitIntelligence.getWorkspaceProfitIntelligence({
    workspaceId: scope.workspaceId,
    humanAgentUserIds: [],
  });

  const hasBreakdown = manifest.capabilities.some(
    (capability) => capability.name === 'compose-margin-breakdown',
  );

  return {
    revenue: {
      observationCount: profit.revenue.observationCount,
      restatedIdentityCount: profit.revenue.restatedIdentityCount,
    },
    costs: {
      deliveredJobCount: profit.costs.deliveredJobCount,
      inFlightJobCount: profit.costs.inFlightJobCount,
    },
    utilization: { ratio: profit.utilization.utilization.value },
    scopeLeakage: { indicatorCount: profit.scopeLeakage.indicators.length },
    margin: {
      realizedRevenue: profit.margin.realizedRevenue.value,
      realizedDeliveryCost: profit.margin.realizedDeliveryCost.value,
      realizedMargin: profit.margin.realizedMargin.value,
      currency: profit.margin.realizedRevenue.currency,
    },
    calculation: {
      calculationVersion: profit.calculation.calculationVersion,
      basis: profit.calculation.basis,
      persistence: profit.calculation.persistence,
    },
    marginBreakdown: hasBreakdown
      ? {
          estimatedRevenue: profit.margin.estimatedRevenue.value,
          estimatedDeliveryCost: profit.margin.estimatedDeliveryCost.value,
        }
      : null,
  };
}
