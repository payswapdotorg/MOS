/**
 * The /reporting module implementation (MKT-030 — the Client Decision Room
 * read model). A PURE LIVE AGGREGATION: the module fetches the Client's
 * authoritative state through the composed authorities' PUBLIC CONTRACTS
 * and composes the view with the pure read-model derivations.
 *
 * The decision room owns NO durable state — there are no projection tables
 * (migration 031 stays RESERVED and unused: the live aggregation is the
 * preferred architecture) — and exposes exactly ONE read method. Every
 * composed module read resolves canonical Client ownership server-side
 * before traversal (each composed module's own contract), so the room can
 * never traverse a tenant it is not scoped to.
 */

import type {
  ClientDecisionRoomView,
  ReportingModuleApi,
  ReportingModuleDeps,
} from '../public.ts';
import type { WorkflowInstanceRecord, WorkflowRecord } from '../../workflows/public.ts';
import {
  composeDecisionRoomEvidenceQuality,
  composeDecisionRoomExperiments,
  composeDecisionRoomWhatHappened,
  composeDecisionRoomWhy,
  deriveDecisionRoomApprovals,
  deriveDecisionRoomRecommendations,
} from './decision-room-read-model.ts';

export function createReportingModule(deps: ReportingModuleDeps): ReportingModuleApi {
  return {
    async getClientDecisionRoom(input): Promise<ClientDecisionRoomView> {
      // WHAT HAPPENED — the Client's goals (all lifecycle states) from the
      // /goals public contract (canonical ownership resolved inside it).
      const goals = await deps.goals.listGoalsForClient(input.clientId);

      // WHY — the Learning ledger (newest first) from the /learnings public
      // contract; the DERIVED states and supersession chains arrive with it.
      const learnings = await deps.learnings.listLearningsForClient(input.clientId);

      // EVIDENCE QUALITY — the Client's bounded evidence listing from the
      // /evidence public contract (the posture tallies exactly those rows).
      const evidenceRecords = await deps.evidence.listEvidenceForClient(input.clientId);

      // EXPERIMENTS — the Client's experiment ledger (newest first) from the
      // /experiments public contract, decisions included verbatim.
      const experiments = await deps.experiments.listExperimentsForClient(input.clientId);

      // WHAT HAPPENED (workflow side) — the Workflow containers of the
      // SERVER-DERIVED workspace enumeration the route resolved, each with
      // its instances in every §5 state (terminal history stays visible).
      const workflows: Array<{
        workflow: WorkflowRecord;
        instances: readonly WorkflowInstanceRecord[];
      }> = [];
      const seenWorkflowIds = new Set<string>();
      for (const workspaceId of input.workspaceIds) {
        const workspaceWorkflows = await deps.workflows.listWorkflowsForWorkspace(workspaceId);
        for (const workflow of workspaceWorkflows) {
          if (seenWorkflowIds.has(workflow.workflowId)) continue;
          seenWorkflowIds.add(workflow.workflowId);
          const instances = await deps.workflows.listWorkflowInstances(workflow.workflowId);
          workflows.push({ workflow, instances });
        }
      }

      const whatHappened = composeDecisionRoomWhatHappened({ goals, workflows });
      const why = composeDecisionRoomWhy(learnings);
      const evidenceQuality = composeDecisionRoomEvidenceQuality(evidenceRecords);
      const experimentsView = composeDecisionRoomExperiments(experiments);
      const recommendations = deriveDecisionRoomRecommendations({ learnings, experiments });
      const approvals = deriveDecisionRoomApprovals({
        experiments,
        instances: workflows.flatMap((entry) => entry.instances),
      });

      return {
        scope: {
          kind: 'client-decision-room',
          clientId: input.clientId,
          agencyId: input.agencyId,
        },
        whatHappened,
        why,
        evidenceQuality,
        experiments: experimentsView,
        recommendations,
        approvals,
        generatedAt: deps.clock.nowIso(),
      };
    },
  };
}
