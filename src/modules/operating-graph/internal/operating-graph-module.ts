/**
 * The /operating-graph module implementation (MKT-041 — Agency Operating
 * Graph).
 *
 * A DERIVED COORDINATION MODEL over the canonical authorities — never a
 * second authority (architecture-lock-v1.5 #4). The module:
 *
 *   - REBUILDS: `rebuildClientOperatingGraph` resolves the canonical Client
 *     scope first (/clients + /workspaces publics — isolation before any
 *     dependent access), gathers the authority snapshots READ-ONLY through
 *     the composed public contracts, derives the relation set with the PURE
 *     projection (internal/graph-projection.ts) and converges the
 *     append-oriented ledger (internal/operating-graph-store.ts). A rebuild
 *     against unchanged authorities appends NOTHING.
 *
 *   - READS: the Client's full graph (current relations + version history +
 *     superseded relations) and the Agency's portfolio rollup (scope-as-data
 *     — the route resolves the agency's live Clients, the command-center
 *     posture).
 *
 * The module owns exactly TWO derived structures (migration 035) and has ZERO
 * mutation paths against any other authority: every composed call is a read.
 */

import { NotFoundError } from '../../../platform/errors/errors.ts';
import type { PlaybookRecord, PlaybookVersionRecord } from '../../playbooks/public.ts';
import type {
  WorkflowDefinitionRecord,
  WorkflowInstanceRecord,
  WorkflowRecord,
} from '../../workflows/public.ts';
import type { DeploymentRecord } from '../../deployments/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type {
  OperatingGraphEdgeRelation,
  OperatingGraphModuleApi,
  OperatingGraphModuleDeps,
  OperatingGraphRebuildReport,
} from '../public.ts';
import type {
  ClientGraphAuthoritySnapshot,
  ResolvedPlaybookVersion,
  ResolvedWorkflowDefinition,
} from './graph-projection.ts';
import {
  composeAgencyOperatingGraphView,
  composeClientOperatingGraphView,
  deriveClientGraphProjection,
} from './graph-projection.ts';
import { OperatingGraphStore } from './operating-graph-store.ts';

/** The server-derived writer label stamped on every rebuild row. */
const REBUILD_RECORDED_BY = 'operating-graph-rebuild';

export function createOperatingGraphModule(deps: OperatingGraphModuleDeps): OperatingGraphModuleApi {
  const store = new OperatingGraphStore(deps.db, deps.clock, deps.ids);

  return {
    // -------------------------------------------------------------------------
    // REBUILD — the derived-edge recomputation (module-level: background
    // workers and later v1.5 Work Items; NEVER an HTTP route).
    // -------------------------------------------------------------------------
    async rebuildClientOperatingGraph({ clientId }): Promise<OperatingGraphRebuildReport> {
      // CANONICAL CLIENT OWNERSHIP from durable state BEFORE any dependent
      // access (§14/§3: isolation before traversal). Unknown or tombstoned
      // Client → the uniform 404 (a foreign Client identifier is not a
      // traversal oracle). Disabled Clients stay derivable: the graph is
      // history-inclusive and the rebuild writes only the module's own
      // derived structures.
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const agencyId = ownership.scope.agencyId;

      // The Client's Workspaces — the server-derived delivery scope.
      const workspaces = await deps.workspaces.listWorkspacesForClient(clientId);

      // --- Gather the authority snapshots (READ-ONLY public contracts) ---
      const goals = await deps.goals.listGoalsForClient(clientId);

      const playbooks = await deps.playbooks.listPlaybooksForClient(clientId);
      const playbookEntries: Array<{
        readonly playbook: PlaybookRecord;
        readonly versions: readonly PlaybookVersionRecord[];
      }> = [];
      for (const playbook of playbooks) {
        playbookEntries.push({
          playbook,
          versions: await deps.playbooks.listPlaybookVersions(playbook.playbookId),
        });
      }

      const workspaceEntries: Array<{
        readonly workspaceId: string;
        readonly deployments: readonly DeploymentRecord[];
        readonly workflows: Array<{
          readonly workflow: WorkflowRecord;
          readonly definitions: readonly WorkflowDefinitionRecord[];
          readonly instances: readonly WorkflowInstanceRecord[];
        }>;
        readonly executions: readonly ExecutionRecord[];
      }> = [];
      for (const workspace of workspaces) {
        const deployments = await deps.deployments.listDeploymentsForWorkspace(
          workspace.workspaceId,
        );
        const workflows = await deps.workflows.listWorkflowsForWorkspace(workspace.workspaceId);
        const workflowEntries: Array<
          ClientGraphAuthoritySnapshot['workspaces'][number]['workflows'][number]
        > = [];
        for (const workflow of workflows) {
          workflowEntries.push({
            workflow,
            definitions: await deps.workflows.listWorkflowDefinitions(workflow.workflowId),
            instances: await deps.workflows.listWorkflowInstances(workflow.workflowId),
          });
        }
        workspaceEntries.push({
          workspaceId: workspace.workspaceId,
          deployments,
          workflows: workflowEntries,
          executions: await deps.executions.listExecutionsForWorkspace(workspace.workspaceId),
        });
      }

      // The /evidence authority's bounded newest-first listing (disclosed by
      // the view's derivation notes).
      const evidence = await deps.evidence.listEvidenceForClient(clientId);
      const experiments = await deps.experiments.listExperimentsForClient(clientId);
      const learnings = await deps.learnings.listLearningsForClient(clientId);

      // --- Resolve the cross-references the listings do not carry ---
      // Deployment pins: the EXACT immutable playbook version + its owning
      // playbook (an agency-reusable playbook is legal inside the owning
      // agency's client graphs — the projection applies the scope checks).
      const resolvedPlaybookVersions = new Map<string, ResolvedPlaybookVersion | null>();
      for (const workspace of workspaceEntries) {
        for (const deployment of workspace.deployments) {
          if (resolvedPlaybookVersions.has(deployment.playbookVersionId)) continue;
          const version = await deps.playbooks.getPlaybookVersion(deployment.playbookVersionId);
          if (version === null) {
            resolvedPlaybookVersions.set(deployment.playbookVersionId, null);
            continue;
          }
          const playbook = await deps.playbooks.getPlaybook(version.playbookId);
          resolvedPlaybookVersions.set(
            deployment.playbookVersionId,
            playbook === null ? null : { version, playbook },
          );
        }
      }

      // Deployment workflow references: the enumerated definitions cover the
      // Client's own workflows; anything else resolves individually (a
      // foreign or unknown reference derives NOTHING — fail-closed).
      const knownDefinitions = new Map<string, ResolvedWorkflowDefinition>();
      for (const workspace of workspaceEntries) {
        for (const entry of workspace.workflows) {
          for (const definition of entry.definitions) {
            knownDefinitions.set(definition.workflowDefinitionId, {
              definition,
              workflow: entry.workflow,
            });
          }
        }
      }
      const resolvedDefinitions = new Map<string, ResolvedWorkflowDefinition | null>();
      for (const workspace of workspaceEntries) {
        for (const deployment of workspace.deployments) {
          for (const definitionId of deployment.workflowDefinitionIds) {
            if (knownDefinitions.has(definitionId)) continue;
            if (resolvedDefinitions.has(definitionId)) continue;
            const definition = await deps.workflows.getWorkflowDefinition(definitionId);
            if (definition === null) {
              resolvedDefinitions.set(definitionId, null);
              continue;
            }
            const workflow = await deps.workflows.getWorkflow(definition.workflowId);
            resolvedDefinitions.set(
              definitionId,
              workflow === null ? null : { definition, workflow },
            );
          }
        }
      }
      for (const [definitionId, resolved] of knownDefinitions) {
        resolvedDefinitions.set(definitionId, resolved);
      }

      // Evidence beyond the listing window: supersession pointers and
      // learning citations resolve individually through the /evidence public
      // contract (the projection keeps only same-Client targets).
      const evidenceById = new Map(evidence.map((record) => [record.evidenceId, record]));
      const resolvedEvidence = new Map<string, Awaited<ReturnType<typeof deps.evidence.getEvidence>>>();
      const resolveEvidenceRef = async (evidenceId: string): Promise<void> => {
        if (evidenceById.has(evidenceId) || resolvedEvidence.has(evidenceId)) return;
        resolvedEvidence.set(evidenceId, await deps.evidence.getEvidence(evidenceId));
      };
      for (const record of evidence) {
        if (record.supersedes !== null) await resolveEvidenceRef(record.supersedes);
      }
      for (const learning of learnings) {
        for (const evidenceRef of learning.evidenceRefs) await resolveEvidenceRef(evidenceRef);
      }

      // Experiment citations resolve through the /experiments public
      // contract (same-Client only — the projection filters).
      const experimentsById = new Map(experiments.map((record) => [record.experimentId, record]));
      const resolvedExperiments = new Map<
        string,
        Awaited<ReturnType<typeof deps.experiments.getExperiment>>
      >();
      for (const learning of learnings) {
        for (const experimentRef of learning.experimentRefs) {
          if (experimentsById.has(experimentRef) || resolvedExperiments.has(experimentRef)) continue;
          resolvedExperiments.set(experimentRef, await deps.experiments.getExperiment(experimentRef));
        }
      }

      // --- The pure derivation + the converge ---
      const snapshot: ClientGraphAuthoritySnapshot = {
        agencyId,
        clientId,
        goals,
        playbooks: playbookEntries,
        workspaces: workspaceEntries,
        evidence,
        experiments,
        learnings,
        resolvedPlaybookVersions,
        resolvedDefinitions,
        resolvedEvidence,
        resolvedExperiments,
      };
      const projection = deriveClientGraphProjection(snapshot);
      const outcome = await store.convergeClientGraph({
        agencyId,
        clientId,
        nodes: projection.nodes,
        edges: projection.edges,
        recordedBy: REBUILD_RECORDED_BY,
      });

      const nodesSeen =
        1 +
        goals.length +
        playbookEntries.reduce(
          (sum, entry) => sum + 1 + entry.versions.length,
          0,
        ) +
        workspaceEntries.reduce(
          (sum, workspace) =>
            sum +
            workspace.deployments.length +
            workspace.executions.length +
            workspace.workflows.reduce(
              (inner, entry) => inner + 1 + entry.definitions.length + entry.instances.length,
              0,
            ),
          0,
        ) +
        evidence.length +
        experiments.length +
        learnings.length;

      return {
        scope: {
          kind: 'client-operating-graph-rebuild',
          agencyId,
          clientId,
          workspaceCount: workspaces.length,
        },
        nodesSeen,
        nodesUpserted: outcome.nodesUpserted,
        edgesDerived: projection.edges.length,
        edgesAppended: outcome.edgesAppended,
        edgesSuperseded: outcome.edgesSuperseded,
        edgesConverged: outcome.edgesConverged,
        converged: outcome.edgesAppended === 0 && outcome.edgesSuperseded === 0,
        rebuiltAt: deps.clock.nowIso(),
        recordedBy: REBUILD_RECORDED_BY,
      };
    },

    // -------------------------------------------------------------------------
    // READS — the derived views (the route layers resolve scope server-side)
    // -------------------------------------------------------------------------
    async getClientOperatingGraph({ clientId }) {
      // Canonical owner resolution before any dependent traversal (§14).
      const ownership = await deps.clients.resolveClientOwnership(clientId);
      if (ownership === null) {
        throw new NotFoundError('client', clientId);
      }
      const workspaces = await deps.workspaces.listWorkspacesForClient(clientId);

      const edgeRows = await store.listClientEdgeRows(clientId);
      const endpoints: Array<{ kind: string; id: string }> = [];
      for (const row of edgeRows) {
        endpoints.push({ kind: row.fromKind, id: row.fromId });
        endpoints.push({ kind: row.toKind, id: row.toId });
      }
      const nodes = await store.listNodesForEndpoints(endpoints);

      return composeClientOperatingGraphView({
        agencyId: ownership.scope.agencyId,
        clientId,
        workspaceCount: workspaces.length,
        nodes,
        edgeRows,
        generatedAt: deps.clock.nowIso(),
      });
    },

    async getAgencyOperatingGraph({ agencyId, clients }) {
      // The aggregation scope arrived as SERVER-DERIVED data (the route
      // resolved the agency's live Clients + Workspace counts from durable
      // state — the command-center posture). The tallies compute in SQL
      // over exactly those Clients.
      const tallies = await store.tallyClientGraphs(clients.map((entry) => entry.clientId));
      const tallyInputs = clients.map((client) => ({
        clientId: client.clientId,
        nodeCount: tallies.nodeCounts.get(client.clientId) ?? 0,
        relationCounts:
          tallies.relationCounts.get(client.clientId) ??
          new Map<OperatingGraphEdgeRelation, number>(),
      }));
      return composeAgencyOperatingGraphView({
        agencyId,
        clients,
        tallies: tallyInputs,
        totalNodeCount: tallies.totalDistinctNodes,
        generatedAt: deps.clock.nowIso(),
      });
    },
  };
}
