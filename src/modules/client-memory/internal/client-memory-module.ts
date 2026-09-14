/**
 * The /client-memory module implementation (MKT-044 — Client Operating
 * Memory).
 *
 * A PURE LIVE DERIVATION over the canonical authorities — the
 * /reporting read-model posture (MKT-029/030), the exact /profit-
 * intelligence house pattern (MKT-043): the module gathers the resolved
 * scope's authoritative rows through the composed authorities' PUBLIC
 * CONTRACTS (READ-ONLY), hands the plain snapshot to the PURE
 * projections (internal/memory-projection.ts) and composes the view. It
 * owns NO durable state — no tables, no snapshot store, no retrieval
 * index, no rebuild operation — so there is nothing to recompute and
 * nothing that can drift: authority changes are visible on the very
 * next read (the live-follow proof). Retrieval/index technology is
 * NON-AUTHORITATIVE (spec/architecture-v1.5.md §6) and this delivery
 * adds none at all.
 *
 * Every composed dependency is consumed READ-ONLY; the module exposes
 * three READ methods and ZERO mutation methods of any kind (no second
 * tenant/data authority — PostgreSQL remains authoritative).
 *
 * Isolation before traversal: the Client view resolves canonical Client
 * ownership first (/clients public contract); the Workspace view
 * resolves canonical Workspace ownership first (/workspaces public
 * contract) AND requires the workspace among the Client's LIVE
 * workspaces before composing; unknown, tombstoned or foreign
 * identifiers are the uniform 404 upstream.
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type {
  ClientMemoryKindSlice,
  ClientMemoryModuleApi,
  ClientMemoryModuleDeps,
  ClientMemoryView,
  WorkspaceMemoryView,
} from '../public.ts';
import type { ClientMemoryAuthoritySnapshot } from './memory-projection.ts';
import {
  composeClientMemoryView,
  composeKindMemorySlice,
  composeWorkspaceMemoryView,
} from './memory-projection.ts';

export function createClientMemoryModule(
  deps: ClientMemoryModuleDeps,
): ClientMemoryModuleApi {
  // -------------------------------------------------------------------------
  // Snapshot gathering (ALL I/O lives here — the projections stay pure)
  // -------------------------------------------------------------------------

  /**
   * Gathers one Client's authority snapshot through the public contracts
   * (READ-ONLY): the LIVE client row (ownership already resolved by the
   * caller), the LIVE workspace enumeration, the goals, the client's OWN
   * playbooks with every version, the deployments across the LIVE
   * workspaces, the evidence ledger, the experiments, the decisions (with
   * their observed outcomes) and the learnings. `workspaceId` non-null
   * additionally requires that workspace among the LIVE enumeration (the
   * workspace-slice fail-closed posture).
   */
  async function gatherClientSnapshot(input: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
  }): Promise<ClientMemoryAuthoritySnapshot> {
    const { agencyId, clientId, workspaceId } = input;

    const client = await deps.clients.getClient(clientId);
    if (client === null || client.clientId !== clientId) {
      // The ownership resolution upstream makes this unreachable except
      // for a concurrent tombstone — fail closed with the uniform 404.
      throw new NotFoundError('client', clientId);
    }

    const liveWorkspaces = await deps.workspaces.listWorkspacesForClient(clientId);
    if (workspaceId !== null && !liveWorkspaces.some((w) => w.workspaceId === workspaceId)) {
      // A workspace outside the Client's LIVE enumeration (foreign,
      // tombstoned or concurrently deleted) is the uniform 404.
      throw new NotFoundError('workspace', workspaceId);
    }

    const goals = await deps.goals.listGoalsForClient(clientId);
    const evidence = await deps.evidence.listEvidenceForClient(clientId);
    const experiments = await deps.experiments.listExperimentsForClient(clientId);
    const decisions = await deps.decisions.listDecisionsForClient(clientId);
    const learnings = await deps.learnings.listLearningsForClient(clientId);

    // The client's OWN playbooks (client-scoped only — the frozen
    // selection rule; agency-scoped reusable IP is a disclosed exclusion)
    // with every immutable version of each.
    const ownPlaybooks = (await deps.playbooks.listPlaybooksForClient(clientId)).filter(
      (playbook) => playbook.clientId === clientId,
    );
    const playbookEntries: Array<{
      readonly playbook: ClientMemoryAuthoritySnapshot['playbookEntries'][number]['playbook'];
      readonly versions: ClientMemoryAuthoritySnapshot['playbookEntries'][number]['versions'];
    }> = [];
    for (const playbook of ownPlaybooks) {
      const versions = await deps.playbooks.listPlaybookVersions(playbook.playbookId);
      playbookEntries.push({ playbook, versions });
    }

    // Every deployment across the Client's LIVE workspaces.
    const deployments: Array<ClientMemoryAuthoritySnapshot['deployments'][number]> = [];
    for (const workspace of liveWorkspaces) {
      const workspaceDeployments = await deps.deployments.listDeploymentsForWorkspace(
        workspace.workspaceId,
      );
      deployments.push(...workspaceDeployments);
    }

    return {
      agencyId,
      clientId,
      client,
      workspaces: liveWorkspaces,
      goals,
      playbookEntries,
      deployments,
      evidence,
      experiments,
      decisions,
      learnings,
    };
  }

  // -------------------------------------------------------------------------
  // READS — the three derived surfaces
  // -------------------------------------------------------------------------

  return {
    async getClientMemory({ clientId }): Promise<ClientMemoryView> {
      // Canonical Client ownership BEFORE any dependent traversal (§14):
      // unknown or tombstoned Client → the uniform 404 (a foreign Client
      // identifier is not a traversal oracle).
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const agencyId = ownership.scope.agencyId;

      const snapshot = await gatherClientSnapshot({ agencyId, clientId, workspaceId: null });
      return composeClientMemoryView(snapshot, deps.clock.nowIso());
    },

    async getWorkspaceMemory({ workspaceId }): Promise<WorkspaceMemoryView> {
      // Canonical Workspace ownership BEFORE any dependent traversal (§14):
      // unknown, tombstoned or foreign Workspace → the uniform 404.
      const ownership = await deps.workspaces.resolveWorkspaceOwnership(workspaceId);
      if (ownership === null) {
        throw new NotFoundError('workspace', workspaceId);
      }
      const { agencyId, clientId } = ownership.scope;

      const snapshot = await gatherClientSnapshot({ agencyId, clientId, workspaceId });
      return composeWorkspaceMemoryView(snapshot, workspaceId, deps.clock.nowIso());
    },

    async getClientMemoryByKind({ clientId, kind }): Promise<ClientMemoryKindSlice> {
      // Canonical Client ownership BEFORE any dependent traversal (§14):
      // unknown or tombstoned Client → the uniform 404. The full memory
      // composes first, then the ONE frozen vocabulary kind's items are
      // presented — a filter over DERIVED data, never a second query
      // authority.
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const agencyId = ownership.scope.agencyId;

      const snapshot = await gatherClientSnapshot({ agencyId, clientId, workspaceId: null });
      return composeKindMemorySlice(snapshot, kind, deps.clock.nowIso());
    },
  };
}
