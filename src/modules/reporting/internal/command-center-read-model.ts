/**
 * The Agency Command Center PURE read-model derivations (MKT-029 — UI-001,
 * UI-AC-01). Every function here is PURE: the same authoritative inputs
 * always compose the same view, nothing is re-decided, nothing is invented,
 * and no function performs I/O or mutates anything (the decision-room
 * read-model's composition rules, widened to the agency portfolio).
 *
 * The composition rules (frozen sources only):
 *
 *   - PORTFOLIO GOALS present every Goal of the agency's clients (all
 *     lifecycle states — terminal goals are visible business history),
 *     client-attributed, with agency-wide and per-client full-key tallies;
 *   - WORKFLOW STATE presents every Workflow container of the agency's
 *     clients' Workspaces with its instances in every frozen §5 state,
 *     client-attributed, with agency-wide and per-client full-key tallies;
 *   - EVIDENCE QUALITY is the caller-DECLARED grade distribution by class
 *     over the /evidence public listings of the agency's clients (a tally
 *     of immutable rows, never a re-grading) plus the LOW-GRADE (D/E/F)
 *     signal the risk posture consumes;
 *   - RISKS are a PRESENTATION of the risk-relevant signals durable state
 *     already exposes: the goal-DECLARED risk constraints (kind 'risk' —
 *     architecture.md §7 "risk constraints"), FAILED executions, UNRESOLVED
 *     executions ('unknown'/'reconciling' — the frozen v1.2 runtime rule
 *     "UNKNOWN execution outcome is unresolved, never success, and requires
 *     reconciliation"), the blocked/paused instance counts and the
 *     low-grade evidence counts. NEVER a risk engine, never a re-assessment,
 *     never a synthesized score: every item is an authoritative row
 *     surfaced verbatim;
 *   - APPROVALS are the MKT-030 derivation semantics at agency scope:
 *     experiments in NON-TERMINAL lifecycle states (draft/ready/running/
 *     analyzing) whose result is still UNDECIDED, and workflow instances
 *     BLOCKED or PAUSED (the frozen §5 awaiting-continuation states) —
 *     client-attributed for drill-down;
 *   - every tally includes EVERY frozen status key (zeros included) so the
 *     response shape is stable for the frontend regardless of data.
 */

import type {
  AgencyCommandCenterClientScope,
  CommandCenterApproval,
  CommandCenterApprovals,
  CommandCenterClientEvidencePosture,
  CommandCenterClientGoalTally,
  CommandCenterClientInstanceTally,
  CommandCenterEvidenceClassPosture,
  CommandCenterEvidenceQuality,
  CommandCenterGoalRecap,
  CommandCenterPortfolioGoals,
  CommandCenterRiskItem,
  CommandCenterRiskSummary,
  CommandCenterRisks,
  CommandCenterWorkflowInstanceRecap,
  CommandCenterWorkflowRecap,
  CommandCenterWorkflowState,
} from '../public.ts';
import {
  EVIDENCE_CLASSES,
  EVIDENCE_QUALITY_GRADES,
  type EvidenceRecord,
} from '../../evidence/public.ts';
import type { ExperimentRecord, ExperimentStatus } from '../../experiments/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type { GoalRecord } from '../../goals/public.ts';
import type {
  WorkflowInstanceRecord,
  WorkflowInstanceStatus,
  WorkflowRecord,
} from '../../workflows/public.ts';
import { tallyGoalStatuses, tallyInstanceStatuses } from './decision-room-read-model.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Zeroed tally with every frozen key present. */
function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

/** The frozen §5 instance states that mean "awaiting continuation". */
const AWAITING_INSTANCE_STATUSES: ReadonlySet<WorkflowInstanceStatus> = new Set([
  'blocked',
  'paused',
]);

/** Experiment lifecycle states that are NOT terminal (a decision may still come). */
const NON_TERMINAL_EXPERIMENT_STATUSES: ReadonlySet<ExperimentStatus> = new Set([
  'draft',
  'ready',
  'running',
  'analyzing',
]);

/** The LOW evidence quality grades (D/E/F) — the evidence-quality risk signal. */
const LOW_GRADES: ReadonlySet<string> = new Set(['D', 'E', 'F']);

// ---------------------------------------------------------------------------
// PORTFOLIO GOALS — every Goal of the agency's clients, client-attributed
// ---------------------------------------------------------------------------

/**
 * PORTFOLIO GOALS composition: the authoritative /goals rows of every
 * client scope, presented field for field with the owning-client
 * attribution, plus agency-wide and per-client lifecycle tallies (every
 * frozen status key present, zeros included). Inputs arrive in the
 * authorities' list order (goals oldest first per client; clients in the
 * route-resolved scope order).
 */
export function composeCommandCenterPortfolioGoals(input: {
  readonly clients: ReadonlyArray<{
    readonly clientId: string;
    readonly goals: readonly GoalRecord[];
  }>;
}): CommandCenterPortfolioGoals {
  const goals: CommandCenterGoalRecap[] = [];
  const perClient: CommandCenterClientGoalTally[] = [];
  const agencyCounts = zeroed(['draft', 'active', 'achieved', 'abandoned'] as const);
  for (const entry of input.clients) {
    for (const goal of entry.goals) {
      goals.push({
        goalId: goal.goalId,
        clientId: entry.clientId,
        workspaceId: goal.workspaceId,
        objective: goal.objective,
        status: goal.status,
        successCriteria: goal.successCriteria,
        metrics: goal.metrics,
        constraints: goal.constraints,
        timeHorizon: goal.timeHorizon,
      });
      agencyCounts[goal.status] += 1;
    }
    perClient.push({
      clientId: entry.clientId,
      total: entry.goals.length,
      goalStatusCounts: tallyGoalStatuses(entry.goals),
    });
  }
  return {
    goals,
    goalStatusCounts: agencyCounts,
    perClient,
  };
}

// ---------------------------------------------------------------------------
// WORKFLOW STATE — every Workflow container of the portfolio, client-attributed
// ---------------------------------------------------------------------------

/**
 * WORKFLOW STATE composition: the agency's workflow containers (one per
 * distinct Workflow of the resolved workspace scopes) with their instances
 * in every §5 state, the owning-client attribution (the record's OWN
 * server-derived clientId — resolved from the canonical Workspace owner at
 * creation, never caller-supplied), and agency-wide + per-client instance
 * tallies. Workflows arrive oldest first per workspace; instances oldest
 * first per workflow (the authorities' list order).
 */
export function composeCommandCenterWorkflowState(input: {
  readonly clients: readonly AgencyCommandCenterClientScope[];
  readonly workflows: ReadonlyArray<{
    readonly workflow: WorkflowRecord;
    readonly instances: readonly WorkflowInstanceRecord[];
  }>;
}): CommandCenterWorkflowState {
  const workflows: CommandCenterWorkflowRecap[] = [];
  const seenWorkflowIds = new Set<string>();
  const instancesByClient = new Map<string, WorkflowInstanceRecord[]>();
  const allInstances: WorkflowInstanceRecord[] = [];
  for (const { workflow, instances } of input.workflows) {
    if (seenWorkflowIds.has(workflow.workflowId)) continue;
    seenWorkflowIds.add(workflow.workflowId);
    const clientId = workflow.clientId;
    const recaps: CommandCenterWorkflowInstanceRecap[] = instances.map((instance) => ({
      workflowInstanceId: instance.workflowInstanceId,
      workflowId: instance.workflowId,
      status: instance.status,
      createdAt: instance.createdAt,
      updatedAt: instance.updatedAt,
    }));
    workflows.push({
      workflowId: workflow.workflowId,
      workspaceId: workflow.workspaceId,
      clientId,
      name: workflow.name,
      description: workflow.description,
      instanceCounts: tallyInstanceStatuses(instances),
      instances: recaps,
    });
    allInstances.push(...instances);
    const bucket = instancesByClient.get(clientId) ?? [];
    bucket.push(...instances);
    instancesByClient.set(clientId, bucket);
  }

  const perClient: CommandCenterClientInstanceTally[] = input.clients.map((entry) => {
    const bucket = instancesByClient.get(entry.clientId) ?? [];
    return {
      clientId: entry.clientId,
      total: bucket.length,
      instanceStatusCounts: tallyInstanceStatuses(bucket),
    };
  });

  return {
    workflows,
    instanceStatusCounts: tallyInstanceStatuses(allInstances),
    perClient,
  };
}

// ---------------------------------------------------------------------------
// EVIDENCE QUALITY — the agency posture (grade distribution + low-grade signal)
// ---------------------------------------------------------------------------

/**
 * EVIDENCE QUALITY composition: the quality-grade distribution per class
 * across the whole portfolio (the clients' /evidence bounded public
 * listings combined — the append-only ledger grows without end, so the
 * posture is computed over the newest windows; the bound is the /evidence
 * authority's server-chosen limit, disclosed by the route), plus the
 * per-client drill-down with the LOW-GRADE (D/E/F) record counts the risk
 * posture consumes.
 *
 * Superseded records are included exactly as the /evidence listing includes
 * them (immutable history stays readable). Classes appear in the frozen
 * EVIDENCE_CLASSES order with every grade key present (zeros included) so
 * the response shape is stable; classes with zero records are omitted from
 * `byClass` (an empty class carries no posture).
 */
export function composeCommandCenterEvidenceQuality(input: {
  readonly clients: ReadonlyArray<{
    readonly clientId: string;
    readonly records: readonly EvidenceRecord[];
  }>;
}): CommandCenterEvidenceQuality {
  const byClass: CommandCenterEvidenceClassPosture[] = [];
  let totalRecords = 0;
  let lowGradeRecords = 0;
  const perClient: CommandCenterClientEvidencePosture[] = [];
  for (const entry of input.clients) {
    let clientTotal = 0;
    let clientLow = 0;
    for (const record of entry.records) {
      clientTotal += 1;
      if (LOW_GRADES.has(record.quality)) clientLow += 1;
    }
    perClient.push({
      clientId: entry.clientId,
      totalRecords: clientTotal,
      lowGradeRecords: clientLow,
    });
    totalRecords += clientTotal;
    lowGradeRecords += clientLow;
  }

  const allRecords = input.clients.flatMap((entry) => [...entry.records]);
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const gradeCounts = zeroed(EVIDENCE_QUALITY_GRADES);
    let total = 0;
    for (const record of allRecords) {
      if (record.class !== evidenceClass) continue;
      gradeCounts[record.quality] += 1;
      total += 1;
    }
    if (total === 0) continue;
    byClass.push({ class: evidenceClass, gradeCounts, total });
  }

  return { byClass, totalRecords, lowGradeRecords, perClient };
}

// ---------------------------------------------------------------------------
// RISKS — the risk-relevant signals durable state already exposes
// ---------------------------------------------------------------------------

/**
 * RISKS derivation (durable state ONLY, never invented — there is NO risk
 * engine and NO re-assessment anywhere in this composition):
 *
 *   - `goal_risk_constraint`: a Goal's DECLARED constraint of kind 'risk'
 *     (architecture.md §7), surfaced verbatim with its owning goal/client;
 *   - `execution_failed`: a terminal FAILED Execution — the authoritative
 *     operational failure signal;
 *   - `execution_unresolved`: an Execution in the 'unknown' or 'reconciling'
 *     state — the frozen v1.2 runtime rule makes these the canonical
 *     pending-reconciliation risk ("UNKNOWN execution outcome is
 *     unresolved, never success, and requires reconciliation").
 *
 * The summary tallies additionally count the blocked/paused workflow
 * instances (the awaiting-continuation states — their full-key tallies live
 * in the workflow-state section) and the low-grade (D/E/F) evidence records
 * (the evidence-quality risk signal computed by the evidence posture).
 *
 * Risk items appear in the caller's input order: goal risk constraints
 * first (the portfolio-goals order: per client, oldest goal first), then
 * failed executions, then unresolved executions (each the executions list
 * order).
 */
export function deriveCommandCenterRisks(input: {
  readonly goals: ReadonlyArray<{
    readonly clientId: string;
    readonly goal: GoalRecord;
  }>;
  readonly instances: readonly WorkflowInstanceRecord[];
  readonly executions: readonly ExecutionRecord[];
  readonly lowGradeEvidenceRecords: number;
}): CommandCenterRisks {
  const items: CommandCenterRiskItem[] = [];
  let goalRiskConstraintCount = 0;
  for (const entry of input.goals) {
    for (const constraint of entry.goal.constraints) {
      if (constraint.kind !== 'risk') continue;
      goalRiskConstraintCount += 1;
      items.push({
        kind: 'goal_risk_constraint',
        goalId: entry.goal.goalId,
        clientId: entry.clientId,
        description: constraint.description,
      });
    }
  }

  let failedExecutionCount = 0;
  let unknownExecutionCount = 0;
  let reconcilingExecutionCount = 0;
  for (const execution of input.executions) {
    if (execution.status === 'failed') {
      failedExecutionCount += 1;
      items.push({
        kind: 'execution_failed',
        executionId: execution.executionId,
        clientId: execution.clientId,
        workspaceId: execution.workspaceId,
        updatedAt: execution.updatedAt,
      });
    } else if (execution.status === 'unknown' || execution.status === 'reconciling') {
      if (execution.status === 'unknown') unknownExecutionCount += 1;
      else reconcilingExecutionCount += 1;
      items.push({
        kind: 'execution_unresolved',
        executionId: execution.executionId,
        clientId: execution.clientId,
        workspaceId: execution.workspaceId,
        status: execution.status,
        updatedAt: execution.updatedAt,
      });
    }
  }

  let blockedInstanceCount = 0;
  let pausedInstanceCount = 0;
  for (const instance of input.instances) {
    if (instance.status === 'blocked') blockedInstanceCount += 1;
    else if (instance.status === 'paused') pausedInstanceCount += 1;
  }

  const summary: CommandCenterRiskSummary = {
    goalRiskConstraintCount,
    blockedInstanceCount,
    pausedInstanceCount,
    failedExecutionCount,
    unknownExecutionCount,
    reconcilingExecutionCount,
    lowGradeEvidenceRecords: input.lowGradeEvidenceRecords,
  };
  return {
    items,
    summary,
    basis: 'declared_goal_risk_constraints_and_operational_and_evidence_quality_signals',
  };
}

// ---------------------------------------------------------------------------
// APPROVALS — the pending states durable state already exposes (MKT-029)
// ---------------------------------------------------------------------------

/**
 * APPROVALS derivation (durable state ONLY, never invented — the MKT-030
 * `deriveDecisionRoomApprovals` semantics at agency scope, client-attributed):
 *
 *   - `experiment_awaiting_decision`: an experiment in a NON-TERMINAL
 *     lifecycle state (draft/ready/running/analyzing) whose result state is
 *     still 'undecided' — the pending-decision state the /experiments
 *     authority exposes;
 *   - `workflow_instance_awaiting_continuation`: a workflow instance BLOCKED
 *     or PAUSED — the frozen §5 awaiting states the /workflows authority
 *     exposes.
 *
 * Experiments arrive first (the portfolio order: per client, the
 * /experiments list order), then instances (the workflow-state composition
 * order: per workflow, oldest first).
 */
export function deriveCommandCenterApprovals(input: {
  readonly experiments: ReadonlyArray<{
    readonly clientId: string;
    readonly experiment: ExperimentRecord;
  }>;
  readonly instances: ReadonlyArray<{
    readonly clientId: string;
    readonly instance: WorkflowInstanceRecord;
  }>;
}): CommandCenterApprovals {
  const items: CommandCenterApproval[] = [];
  for (const entry of input.experiments) {
    if (!NON_TERMINAL_EXPERIMENT_STATUSES.has(entry.experiment.status)) continue;
    if (entry.experiment.resultState !== 'undecided') continue;
    items.push({
      kind: 'experiment_awaiting_decision',
      experimentId: entry.experiment.experimentId,
      clientId: entry.clientId,
      status: entry.experiment.status,
      decisionTarget: entry.experiment.decisionTarget,
      hypothesis: entry.experiment.hypothesis,
    });
  }
  for (const entry of input.instances) {
    if (!AWAITING_INSTANCE_STATUSES.has(entry.instance.status)) continue;
    items.push({
      kind: 'workflow_instance_awaiting_continuation',
      workflowInstanceId: entry.instance.workflowInstanceId,
      workflowId: entry.instance.workflowId,
      clientId: entry.clientId,
      instanceStatus: entry.instance.status,
      updatedAt: entry.instance.updatedAt,
    });
  }
  return { items };
}
