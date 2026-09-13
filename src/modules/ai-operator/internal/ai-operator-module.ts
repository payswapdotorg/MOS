/**
 * The /ai-operator module implementation (MKT-045 — AI Operator /
 * Attention Queue).
 *
 * A PURE LIVE DERIVATION over the canonical authorities — the
 * /profit-intelligence read-model posture (MKT-043): the module fetches
 * the resolved scope's authoritative rows through the composed
 * authorities' PUBLIC CONTRACTS, hands the plain snapshots to the PURE
 * derivations (internal/attention-derivation.ts) and composes the ranked
 * queue. It owns NO durable state — no tables, no persisted queue, no
 * refresh operation — so there is nothing to recompute and nothing that
 * can drift: authority changes are visible on the very next read (the
 * live-follow proof).
 *
 * Every composed dependency is consumed READ-ONLY (scope-leakage and
 * margin-pressure items CONSUME the /profit-intelligence public views —
 * its figures are never recomputed here); the module exposes three READ
 * methods and ZERO mutation methods of any kind (architecture-v1.5.md §7:
 * consequential actions continue through the existing policy/approval
 * contracts — this module only ranks action candidates).
 *
 * Isolation before traversal (§14): every view resolves canonical Client
 * ownership first (/clients public contract); the agency view re-resolves
 * each SERVER-DERIVED client entry (the route resolved the agency's LIVE
 * clients + ACTIVE human_agent memberships from durable state — the
 * scope-as-data posture); unknown or tombstoned identifiers are the
 * uniform 404 upstream (foreign ≡ unknown ≡ malformed, no existence
 * oracle).
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { HumanAgentRecord } from '../../field-agents/public.ts';
import type {
  AgencyAttentionQueueView,
  AiOperatorModuleApi,
  AiOperatorModuleDeps,
  AttentionItemDetailView,
  ClientAttentionQueueView,
} from '../public.ts';
import type {
  AgencyScopeSnapshot,
  CapacityJobRows,
  ClientScopeRows,
} from './attention-derivation.ts';
import {
  composeRankingDisclosure,
  deriveAgencyAttentionItems,
  deriveApprovalItems,
  deriveAnomalyItems,
  deriveBlockedWorkItems,
  deriveClientRiskItems,
  deriveMarginPressureItems,
  deriveOpportunityItems,
  deriveScopeLeakageItems,
  rankAttentionItems,
  tallyCategoryCounts,
} from './attention-derivation.ts';

export function createAiOperatorModule(deps: AiOperatorModuleDeps): AiOperatorModuleApi {
  // -------------------------------------------------------------------------
  // Snapshot gathering (ALL I/O lives here — the derivations stay pure)
  // -------------------------------------------------------------------------

  /**
   * Gathers ONE client's authority rows through the public contracts
   * (READ-ONLY). The /profit-intelligence CLIENT view is consumed for the
   * scope-leakage and margin-pressure items (its figures are never
   * recomputed here — its own module derives them under its own frozen
   * calculation version); a consumption failure propagates (fail closed —
   * this module invents no error surface of its own). `workspaceId`
   * non-null narrows rows to the workspace slice.
   */
  async function gatherClientRows(input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<ClientScopeRows> {
    const { agencyId, clientId, workspaceId } = input;

    const ownership = await deps.clients.resolveClientOwnership(clientId);
    if (ownership === null) {
      throw new NotFoundError('client', clientId);
    }
    const clientStatus = ownership.client.status;

    const liveWorkspaces = await deps.workspaces.listWorkspacesForClient(clientId);
    const targetWorkspaces = liveWorkspaces.filter(
      (workspace) => workspaceId === null || workspace.workspaceId === workspaceId,
    );

    const workspaceEntries: ClientScopeRows['workspaces'][number][] = [];
    for (const workspace of targetWorkspaces) {
      const instances = [];
      for (const workflow of await deps.workflows.listWorkflowsForWorkspace(
        workspace.workspaceId,
      )) {
        instances.push(
          ...(await deps.workflows.listWorkflowInstances(workflow.workflowId)),
        );
      }
      const deployments = await deps.deployments.listDeploymentsForWorkspace(
        workspace.workspaceId,
      );
      const executions = await deps.executions.listExecutionsForWorkspace(
        workspace.workspaceId,
      );
      workspaceEntries.push({
        workspaceId: workspace.workspaceId,
        instances,
        deployments,
        executions,
      });
    }

    // The /jobs surface enumeration (the PI precedent): jobs are reached
    // through the ACCEPTED offers of the agency's human agents and
    // filtered to THIS client scope. This is the disclosed enumeration
    // window (jobs never offered to this agency's humans stay out of it).
    const jobs = [];
    const seenJobIds = new Set<string>();
    for (const userId of input.humanAgentUserIds) {
      const offers = await deps.jobs.listOffersForCandidate(userId);
      for (const offer of offers) {
        if (seenJobIds.has(offer.jobId)) continue;
        const job = await deps.jobs.getJob(offer.jobId);
        if (job === null) continue;
        if (job.agencyId !== agencyId || job.clientId !== clientId) continue;
        if (workspaceId !== null && job.workspaceId !== workspaceId) continue;
        seenJobIds.add(offer.jobId);
        jobs.push(job);
      }
    }

    const evidence = await deps.evidence.listEvidenceForClient(clientId);
    const experiments = await deps.experiments.listExperimentsForClient(clientId);
    const learnings = await deps.learnings.listLearningsForClient(clientId);

    // The /profit-intelligence CONSUMPTION (scope-leakage + margin
    // pressure): its public client view, computed by its own module —
    // never recomputed here.
    const profit = await deps.profitIntelligence.getClientProfitIntelligence({
      clientId,
      humanAgentUserIds: [...input.humanAgentUserIds],
    });

    return {
      agencyId,
      clientId,
      clientStatus,
      workspaces: workspaceEntries,
      jobs,
      evidence,
      experiments,
      learnings,
      profit,
    };
  }

  /**
   * Gathers the AGENCY-scope rows: the capacity demand jobs (open jobs via
   * each human agent's marketplace listing + in-flight jobs via accepted
   * offers — the disclosed enumeration window) and the active Human Agent
   * profiles (the capacity pool).
   */
  async function gatherAgencyRows(input: {
    readonly agencyId: string;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<{
    readonly profiles: readonly HumanAgentRecord[];
    readonly capacityJobs: CapacityJobRows;
  }> {
    const profiles: HumanAgentRecord[] = [];
    for (const userId of input.humanAgentUserIds) {
      const profile = await deps.fieldAgents.getHumanAgentByUser(userId);
      if (profile !== null) profiles.push(profile);
    }

    const openJobs = [];
    const inFlightJobs = [];
    const seenJobIds = new Set<string>();
    // The jobs surface enumeration runs over the RESOLVED profiles (the
    // marketplace listing takes the Human Agent PROFILE id through the
    // /field-agents contract — a membership user id is never an agent id;
    // listOffersForCandidate takes the user id). Both stay inside the
    // disclosed enumeration window: jobs never reachable through this
    // agency's human agents stay out of the derivations.
    for (const profile of profiles) {
      // OPEN work: the marketplace listing of each human agent (projected
      // / offered jobs the candidate is eligible for).
      for (const job of await deps.jobs.listMarketplaceJobs(profile.agentId)) {
        if (job.agencyId !== input.agencyId) continue;
        if (seenJobIds.has(job.jobId)) continue;
        if (job.status !== 'projected' && job.status !== 'offered') continue;
        seenJobIds.add(job.jobId);
        openJobs.push(job);
      }
      // IN-FLIGHT work: accepted offers whose jobs are not yet settled.
      for (const offer of await deps.jobs.listOffersForCandidate(profile.userId)) {
        if (offer.status !== 'accepted') continue;
        if (seenJobIds.has(offer.jobId)) continue;
        const job = await deps.jobs.getJob(offer.jobId);
        if (job === null) continue;
        if (job.agencyId !== input.agencyId) continue;
        if (job.status !== 'accepted') continue;
        seenJobIds.add(offer.jobId);
        inFlightJobs.push(job);
      }
    }

    return { profiles, capacityJobs: { openJobs, inFlightJobs } };
  }

  /** Gathers the FULL agency snapshot (per-client rows + agency rows). */
  async function gatherAgencySnapshot(input: {
    readonly agencyId: string;
    readonly clients: ReadonlyArray<{ readonly clientId: string }>;
    readonly humanAgentUserIds: readonly string[];
  }): Promise<AgencyScopeSnapshot> {
    const clientRows: ClientScopeRows[] = [];
    for (const entry of input.clients) {
      // The tombstoned-Client backstop: the route's listing already
      // excluded tombstones; this re-check fails closed for concurrent
      // deletes (the PI posture).
      const ownership = await deps.clients.resolveClientOwnership(entry.clientId);
      if (ownership === null) continue;
      clientRows.push(
        await gatherClientRows({
          agencyId: input.agencyId,
          clientId: entry.clientId,
          workspaceId: null,
          humanAgentUserIds: input.humanAgentUserIds,
        }),
      );
    }

    const undecided = await deps.policies.listPolicyDecisions({
      agencyId: input.agencyId,
      clientId: null,
    });

    const { profiles, capacityJobs } = await gatherAgencyRows({
      agencyId: input.agencyId,
      humanAgentUserIds: input.humanAgentUserIds,
    });

    return {
      agencyId: input.agencyId,
      clients: clientRows,
      undecidedPolicyDecisions: undecided.filter(
        (decision) => decision.outcome === 'unknown',
      ),
      humanAgentProfiles: profiles,
      capacityJobs,
    };
  }

  // -------------------------------------------------------------------------
  // READS — the three derived surfaces
  // -------------------------------------------------------------------------

  return {
    async getAgencyAttentionQueue({
      agencyId,
      clients,
      humanAgentUserIds,
    }): Promise<AgencyAttentionQueueView> {
      // The aggregation scope arrived as SERVER-DERIVED data (the route
      // resolved the agency's LIVE Clients + ACTIVE human_agent
      // memberships from durable state — scope-as-data). Each Client's
      // items derive from that Client's OWN authority rows; the ranking
      // is the pure deterministic core.
      const snapshot = await gatherAgencySnapshot({
        agencyId,
        clients,
        humanAgentUserIds,
      });
      const items = rankAttentionItems(deriveAgencyAttentionItems(snapshot));
      const activeProfiles = snapshot.humanAgentProfiles.filter(
        (profile) => profile.authorizationState === 'active',
      );

      return {
        scope: {
          kind: 'agency-attention-queue',
          agencyId,
          clientCount: snapshot.clients.length,
          humanAgentCount: activeProfiles.length,
        },
        items,
        counts: tallyCategoryCounts(items),
        ranking: composeRankingDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },

    async getClientAttentionQueue({
      clientId,
      humanAgentUserIds,
    }): Promise<ClientAttentionQueueView> {
      // Canonical Client ownership BEFORE any dependent traversal (§14):
      // unknown or tombstoned Client → the uniform 404.
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const agencyId = ownership.scope.agencyId;
      const liveWorkspaces = await deps.workspaces.listWorkspacesForClient(clientId);

      const rows = await gatherClientRows({
        agencyId,
        clientId,
        workspaceId: null,
        humanAgentUserIds,
      });

      // The client slice: client-scoped items only. The undecided policy
      // decisions narrow to THIS client (the /policies public contract's
      // client narrowing); the capacity-constraint item is agency-pool
      // scoped and lives in the agency queue only (disclosed below).
      const undecided = await deps.policies.listPolicyDecisions({
        agencyId,
        clientId,
      });
      const rawItems = [
        ...deriveBlockedWorkItems(rows),
        ...deriveAnomalyItems(rows),
        ...deriveClientRiskItems(rows),
        ...deriveScopeLeakageItems(rows),
        ...deriveMarginPressureItems(rows),
        ...deriveOpportunityItems(rows),
        ...deriveApprovalItems(undecided, clientId),
      ];
      const items = rankAttentionItems(rawItems);

      return {
        scope: {
          kind: 'client-attention-queue',
          agencyId,
          clientId,
          workspaceCount: liveWorkspaces.length,
        },
        items,
        counts: tallyCategoryCounts(items),
        scopeExclusions: [
          {
            category: 'capacity-constraint',
            reason:
              'the capacity-constraint item is agency-pool-scoped (field-agents availability + jobs across the whole agency): it is ranked in the agency attention queue only and is never sliced per client',
          },
        ],
        ranking: composeRankingDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },

    async getAttentionItem({
      agencyId,
      itemId,
      clients,
      humanAgentUserIds,
    }): Promise<AttentionItemDetailView> {
      // The queue is RE-DERIVED (no cache, no store — the live-derivation
      // posture) and the item located by its deterministic id. A foreign,
      // unknown or malformed itemId is simply absent from THIS agency's
      // queue: the uniform 404 (no existence oracle).
      const snapshot = await gatherAgencySnapshot({
        agencyId,
        clients,
        humanAgentUserIds,
      });
      const items = rankAttentionItems(deriveAgencyAttentionItems(snapshot));
      const match = items.find((item) => item.itemId === itemId);
      if (match === undefined) {
        throw new NotFoundError('attention-item', itemId);
      }

      return {
        scope: {
          kind: 'agency-attention-item',
          agencyId,
        },
        item: match,
        totalItemCount: items.length,
        categoryCounts: tallyCategoryCounts(items),
        ranking: composeRankingDisclosure(),
        generatedAt: deps.clock.nowIso(),
      };
    },
  };
}
