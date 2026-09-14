/**
 * The CRM/pipeline family composer (mos-crm) — the PRESENTATION-ONLY
 * composition over the /clients + /decisions public contracts (MKT-051
 * AC-1b).
 *
 * INCUMBENT-CAPABILITY DISCIPLINE (the Non-goals rule): the client
 * roster is the /clients authority's own record and the pipeline stages
 * are the /decisions Decision Ledger's own lifecycle states — the pack
 * reproduces the HubSpot-style client-room panel over the SAME
 * authorities and never becomes a second CRM authority (no client or
 * pipeline table of its own, no mutation verb, no recomputation).
 */

import { MOS_CRM_RECORD_DECISION_ACTION, declaredActionFor } from '../../state.ts';
import type {
  AppManifest,
  CrmActionMenuModel,
  CrmClientRoomPanelModel,
  FirstPartyAppsModuleDeps,
} from '../../../public.ts';

/**
 * Composes the HubSpot-style client-room panel: the client's own record
 * (/clients) + the decision pipeline tally and recent decisions
 * (/decisions). READ-ONLY.
 */
export async function composeCrmClientRoomPanel(
  deps: FirstPartyAppsModuleDeps,
  scope: { readonly clientId: string },
  manifest: AppManifest,
): Promise<CrmClientRoomPanelModel> {
  const client = await deps.clients.getClient(scope.clientId);
  if (client === null) {
    // The install scope chain guarantees a live client; a missing record
    // surfaces as an honest empty panel (the authority is the truth, and
    // the composition never fabricates one).
    return {
      client: { clientId: scope.clientId, name: '', status: 'unknown' },
      pipeline: { totalDecisions: 0, proposed: 0, accepted: 0, rejected: 0, superseded: 0 },
      recentDecisions: [],
    };
  }

  const decisions = await deps.decisions.listDecisionsForClient(scope.clientId);
  const tally = { proposed: 0, accepted: 0, rejected: 0, superseded: 0 };
  for (const decision of decisions) {
    const status = decision.disposition;
    if (status === 'proposed' || status === 'accepted' || status === 'rejected' || status === 'superseded') {
      tally[status] += 1;
    }
  }

  const hasSummary = manifest.capabilities.some(
    (capability) => capability.name === 'compose-pipeline-summary',
  );
  void hasSummary;

  return {
    client: {
      clientId: client.clientId,
      name: client.name,
      status: client.status,
    },
    pipeline: {
      totalDecisions: decisions.length,
      ...tally,
    },
    recentDecisions: decisions.slice(0, 10).map((decision) => ({
      decisionId: decision.decisionId,
      objective: decision.objective,
      status: decision.disposition,
      proposedAt: decision.dispositionAt ?? decision.proposer.actor,
    })),
  };
}

/**
 * Composes the pipeline action menu: the DECLARED actions — presentation
 * declarations of EXISTING authority commands (the /decisions record
 * command route). Pack code executes NOTHING; the operator's client
 * invokes the authority route and the platform authorizes there.
 * READ-ONLY.
 */
export function composeCrmActionMenu(
  _deps: FirstPartyAppsModuleDeps,
  _scope: { readonly clientId: string },
  _manifest: AppManifest,
): CrmActionMenuModel {
  return { actions: [MOS_CRM_RECORD_DECISION_ACTION, ...declaredActionFor('mos-crm', 'action-menu').filter((action) => action.actionId !== MOS_CRM_RECORD_DECISION_ACTION.actionId)] };
}
