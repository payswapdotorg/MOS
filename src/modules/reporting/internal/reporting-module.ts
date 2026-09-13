/**
 * The /reporting module implementation (MKT-030 — the Client Decision Room
 * read model; MKT-029 — the Agency Command Center read model). A PURE LIVE
 * AGGREGATION: the module fetches the caller's authorized scope's
 * authoritative state through the composed authorities' PUBLIC CONTRACTS
 * and composes the view with the pure read-model derivations.
 *
 * The decision room owns NO durable state — there are no projection tables
 * (migration 031 stays RESERVED and unused: the live aggregation is the
 * preferred architecture) — and exposes exactly TWO read methods. Every
 * composed module read resolves canonical Client ownership server-side
 * before traversal (each composed module's own contract), so the views can
 * never traverse a tenant they are not scoped to.
 */

import type {
  AgencyCommandCenterView,
  ClientDecisionRoomView,
  ReportingModuleApi,
  ReportingModuleDeps,
} from '../public.ts';
import type { WorkflowInstanceRecord, WorkflowRecord } from '../../workflows/public.ts';
import type { EvidenceRecord } from '../../evidence/public.ts';
import type { ExperimentRecord } from '../../experiments/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type { GoalRecord } from '../../goals/public.ts';
import {
  composeDecisionRoomEvidenceQuality,
  composeDecisionRoomExperiments,
  composeDecisionRoomWhatHappened,
  composeDecisionRoomWhy,
  deriveDecisionRoomApprovals,
  deriveDecisionRoomRecommendations,
} from './decision-room-read-model.ts';
import {
  composeCommandCenterEvidenceQuality,
  composeCommandCenterPortfolioGoals,
  composeCommandCenterWorkflowState,
  deriveCommandCenterApprovals,
  deriveCommandCenterRisks,
} from './command-center-read-model.ts';

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

    async getAgencyCommandCenter(input): Promise<AgencyCommandCenterView> {
      // PORTFOLIO GOALS — every Goal of every client scope (all lifecycle
      // states) from the /goals public contract (canonical ownership
      // resolved inside it — the route only ever passes the agency's OWN
      // live clients).
      const goalsByClient: Array<{ clientId: string; goals: readonly GoalRecord[] }> = [];
      // EVIDENCE QUALITY — the clients' bounded evidence listings from the
      // /evidence public contract (the posture tallies exactly those rows).
      const evidenceByClient: Array<{ clientId: string; records: readonly EvidenceRecord[] }> =
        [];
      // PENDING APPROVALS (experiment half) — the clients' experiment
      // ledgers from the /experiments public contract.
      const experimentsByClient: Array<{
        clientId: string;
        experiments: readonly ExperimentRecord[];
      }> = [];
      for (const entry of input.clients) {
        goalsByClient.push({
          clientId: entry.clientId,
          goals: await deps.goals.listGoalsForClient(entry.clientId),
        });
        evidenceByClient.push({
          clientId: entry.clientId,
          records: await deps.evidence.listEvidenceForClient(entry.clientId),
        });
        experimentsByClient.push({
          clientId: entry.clientId,
          experiments: await deps.experiments.listExperimentsForClient(entry.clientId),
        });
      }

      // WORKFLOW STATE (container side) + RISKS (execution side) — the
      // Workflow containers and Executions of the resolved workspace
      // scopes, each with its instances in every §5 state / lifecycle state
      // (terminal history stays visible).
      const workflows: Array<{
        workflow: WorkflowRecord;
        instances: readonly WorkflowInstanceRecord[];
      }> = [];
      const seenWorkflowIds = new Set<string>();
      const executions: ExecutionRecord[] = [];
      for (const entry of input.clients) {
        for (const workspaceId of entry.workspaceIds) {
          const workspaceWorkflows = await deps.workflows.listWorkflowsForWorkspace(workspaceId);
          for (const workflow of workspaceWorkflows) {
            if (seenWorkflowIds.has(workflow.workflowId)) continue;
            seenWorkflowIds.add(workflow.workflowId);
            const instances = await deps.workflows.listWorkflowInstances(workflow.workflowId);
            workflows.push({ workflow, instances });
          }
          // The /executions direction of the frozen matrix line (MKT-029):
          // every execution of the workspace in EVERY lifecycle state — the
          // failed/unresolved rows are the canonical operational-risk
          // signals; the records carry their own server-derived
          // client/workspace attribution.
          for (const execution of await deps.executions.listExecutionsForWorkspace(workspaceId)) {
            executions.push(execution);
          }
        }
      }

      const portfolioGoals = composeCommandCenterPortfolioGoals({ clients: goalsByClient });
      const workflowState = composeCommandCenterWorkflowState({
        clients: input.clients,
        workflows,
      });
      const evidenceQuality = composeCommandCenterEvidenceQuality({
        clients: evidenceByClient,
      });

      // RISKS — the client-attributed goal rows feed the declared
      // risk-constraint presentation; the flat instance list (the
      // workflow-state composition order) and the flat execution list feed
      // the operational signals; the low-grade count arrives from the
      // evidence posture.
      const goalEntries = goalsByClient.flatMap(({ clientId, goals }) =>
        goals.map((goal) => ({ clientId, goal })),
      );
      const instanceEntries = workflows.flatMap(({ instances }) => [...instances]);
      const risks = deriveCommandCenterRisks({
        goals: goalEntries,
        instances: instanceEntries,
        executions,
        lowGradeEvidenceRecords: evidenceQuality.lowGradeRecords,
      });

      // PENDING APPROVALS — the MKT-030 derivation semantics at agency
      // scope: undecided non-terminal experiments + blocked/paused
      // instances, client-attributed for drill-down (the records' OWN
      // server-derived client attribution, never caller-supplied).
      const experimentEntries = experimentsByClient.flatMap(({ clientId, experiments }) =>
        experiments.map((experiment) => ({ clientId, experiment })),
      );
      const instanceAttribution = workflows.flatMap(({ workflow, instances }) =>
        instances.map((instance) => ({ clientId: workflow.clientId, instance })),
      );
      const pendingApprovals = deriveCommandCenterApprovals({
        experiments: experimentEntries,
        instances: instanceAttribution,
      });

      return {
        scope: {
          kind: 'agency-command-center',
          agencyId: input.agencyId,
          clientCount: input.clients.length,
        },
        portfolioGoals,
        workflowState,
        evidenceQuality,
        risks,
        pendingApprovals,
        generatedAt: deps.clock.nowIso(),
      };
    },
  };
}
