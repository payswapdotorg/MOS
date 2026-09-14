/**
 * The client-portal family composer (mos-portal) — the PRESENTATION-ONLY
 * composition over the /reporting Client Decision Room + /clients public
 * contracts (MKT-051 AC-1d).
 *
 * INCUMBENT-CAPABILITY DISCIPLINE (the Non-goals rule): the
 * client-facing room is the /reporting Client Decision Room — the pack
 * reproduces the client-facing presentation surfaces over the SAME
 * authority view and never creates a second client portal truth. The
 * client roster is the /clients authority's own record. The v1.1.0
 * 'compose-portal-highlights' capability adds the highlights block
 * (the capability-gated presentation, proven by the upgrade lifecycle).
 */

import type {
  AppManifest,
  FirstPartyAppsModuleDeps,
  PortalClientRoomPanelModel,
  PortalReportPageModel,
} from '../../../public.ts';

/**
 * Composes the client-facing client-room panel: the client's own record
 * (/clients) + the Client Decision Room tallies (/reporting — goals,
 * experiments, approvals, recommendations; every figure the authority's
 * own view). READ-ONLY.
 */
export async function composePortalClientRoomPanel(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly clientId: string; readonly agencyId: string; readonly workspaceId: string },
  manifest: AppManifest,
): Promise<PortalClientRoomPanelModel> {
  const client = await deps.clients.getClient(scope.clientId);
  const room = await deps.reporting.getClientDecisionRoom({
    clientId: scope.clientId,
    agencyId: scope.agencyId,
    workspaceIds: [scope.workspaceId],
  });

  const hasHighlights = manifest.capabilities.some(
    (capability) => capability.name === 'compose-portal-highlights',
  );

  let highlights: readonly string[] | null = null;
  if (hasHighlights) {
    const highlightsList: string[] = [];
    for (const recommendation of room.recommendations.items) {
      if (highlightsList.length >= 5) break;
      const statement =
        recommendation.kind === 'applicable_learning'
          ? recommendation.statement
          : `${recommendation.decisionTarget}: ${recommendation.resultingDecision}`;
      if (statement.length > 0) highlightsList.push(statement);
    }
    highlights = highlightsList;
  }

  return {
    client: {
      clientId: scope.clientId,
      name: client?.name ?? '',
      status: client?.status ?? 'unknown',
    },
    room: {
      goalCount: room.whatHappened.goals.length,
      experimentCount: room.experiments.experiments.length,
      pendingApprovals: room.approvals.items.length,
      recommendationCount: room.recommendations.items.length,
    },
    highlights,
  };
}

/**
 * Composes the client-facing report page: the Client Decision Room's own
 * evidence-quality distribution and experiment tallies (/reporting —
 * cited, never recomputed). READ-ONLY.
 */
export async function composePortalReportPage(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly clientId: string; readonly agencyId: string; readonly workspaceId: string },
  _manifest: AppManifest,
): Promise<PortalReportPageModel> {
  const client = await deps.clients.getClient(scope.clientId);
  const room = await deps.reporting.getClientDecisionRoom({
    clientId: scope.clientId,
    agencyId: scope.agencyId,
    workspaceIds: [scope.workspaceId],
  });

  const evidenceQuality: Record<string, number> = {};
  for (const posture of room.evidenceQuality.byClass) {
    for (const [grade, count] of Object.entries(posture.gradeCounts)) {
      evidenceQuality[grade] = (evidenceQuality[grade] ?? 0) + count;
    }
  }

  const experiments: Record<string, number> = {};
  for (const [status, count] of Object.entries(room.experiments.experimentStatusCounts)) {
    experiments[status] = (experiments[status] ?? 0) + count;
  }

  return {
    client: { name: client?.name ?? '' },
    evidenceQuality,
    experiments,
    generatedAt: room.generatedAt,
  };
}
