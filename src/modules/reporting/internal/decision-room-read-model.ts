/**
 * The Client Decision Room PURE read-model derivations (MKT-030 — UI-001,
 * UI-AC-01). Every function here is PURE: the same authoritative inputs
 * always compose the same view, nothing is re-decided, nothing is invented,
 * and no function performs I/O or mutates anything.
 *
 * The composition rules (frozen sources only):
 *
 *   - EVIDENCE QUALITY is the caller-DECLARED grade distribution by class
 *     over the /evidence public listing — a tally of immutable rows, never a
 *     re-grading;
 *   - APPROVALS are the pending states the authorities already expose:
 *     experiments in a NON-TERMINAL lifecycle state (draft/ready/running/
 *     analyzing) whose result is still UNDECIDED, and workflow instances
 *     BLOCKED or PAUSED (the frozen §5 awaiting-continuation states);
 *   - RECOMMENDATIONS present exactly two authoritative sources — the
 *     APPLICABLE (derived-status 'active') learnings and the experiments'
 *     DECLARED resulting decisions (concluded with a decision). The frozen
 *     evidence-and-experimentation contract forbids presenting attribution
 *     as causal lift: design type and analysis method ride verbatim and no
 *     lift is ever synthesized;
 *   - every tally includes EVERY frozen status key (zeros included) so the
 *     response shape is stable for the frontend regardless of data.
 */

import type {
  DecisionRoomApprovals,
  DecisionRoomApproval,
  DecisionRoomEvidenceClassPosture,
  DecisionRoomEvidenceQuality,
  DecisionRoomExperimentRecap,
  DecisionRoomExperiments,
  DecisionRoomGoalRecap,
  DecisionRoomLearningRationale,
  DecisionRoomRecommendation,
  DecisionRoomRecommendations,
  DecisionRoomWhatHappened,
  DecisionRoomWhy,
  DecisionRoomWorkflowInstanceRecap,
  DecisionRoomWorkflowRecap,
} from '../public.ts';
import {
  EVIDENCE_CLASSES,
  EVIDENCE_QUALITY_GRADES,
  type EvidenceRecord,
} from '../../evidence/public.ts';
import {
  EXPERIMENT_STATUSES,
  type ExperimentRecord,
  type ExperimentStatus,
} from '../../experiments/public.ts';
import type { GoalRecord, GoalStatus } from '../../goals/public.ts';
import { LEARNING_STATUSES, type LearningRecord, type LearningStatus } from '../../learnings/public.ts';
import {
  WORKFLOW_INSTANCE_STATUSES,
  type WorkflowInstanceRecord,
  type WorkflowInstanceStatus,
  type WorkflowRecord,
} from '../../workflows/public.ts';

// ---------------------------------------------------------------------------
// Status tallies (every frozen key present, zeros included)
// ---------------------------------------------------------------------------

/** Zeroed tally with every frozen key present. */
function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const key of keys) out[key] = 0;
  return out;
}

/** Goal counts per lifecycle status (draft/active/achieved/abandoned). */
export function tallyGoalStatuses(goals: readonly GoalRecord[]): Record<GoalStatus, number> {
  const counts = zeroed([
    'draft',
    'active',
    'achieved',
    'abandoned',
  ] as readonly GoalStatus[]);
  for (const goal of goals) counts[goal.status] += 1;
  return counts;
}

/** Workflow-instance counts per frozen §5 status. */
export function tallyInstanceStatuses(
  instances: readonly WorkflowInstanceRecord[],
): Record<WorkflowInstanceStatus, number> {
  const counts = zeroed(WORKFLOW_INSTANCE_STATUSES);
  for (const instance of instances) counts[instance.status] += 1;
  return counts;
}

/** Learning counts per DERIVED state (active/superseded/contradicted/retired). */
export function tallyLearningStatuses(
  learnings: readonly LearningRecord[],
): Record<LearningStatus, number> {
  const counts = zeroed(LEARNING_STATUSES);
  for (const learning of learnings) counts[learning.status] += 1;
  return counts;
}

/** Experiment counts per lifecycle status. */
export function tallyExperimentStatuses(
  experiments: readonly ExperimentRecord[],
): Record<ExperimentStatus, number> {
  const counts = zeroed(EXPERIMENT_STATUSES);
  for (const experiment of experiments) counts[experiment.status] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// WHAT HAPPENED — goal + workflow instance recaps (the authoritative state)
// ---------------------------------------------------------------------------

/** One Goal recap: the authoritative /goals row presented field for field. */
export function recapGoal(goal: GoalRecord): DecisionRoomGoalRecap {
  return {
    goalId: goal.goalId,
    workspaceId: goal.workspaceId,
    objective: goal.objective,
    status: goal.status,
    successCriteria: goal.successCriteria,
    metrics: goal.metrics,
    constraints: goal.constraints,
    timeHorizon: goal.timeHorizon,
  };
}

/** One instance recap: the §5 lifecycle identity, presented. */
export function recapInstance(instance: WorkflowInstanceRecord): DecisionRoomWorkflowInstanceRecap {
  return {
    workflowInstanceId: instance.workflowInstanceId,
    workflowId: instance.workflowId,
    status: instance.status,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
  };
}

/**
 * WHAT HAPPENED composition: the Client's goals (all lifecycle states —
 * terminal goals are visible business history) and, per workflow container,
 * the instance-state recap with per-workflow and client-wide §5 tallies.
 * Inputs arrive in the authorities' list order (goals oldest first;
 * workflows oldest first per workspace; instances oldest first per workflow).
 */
export function composeDecisionRoomWhatHappened(input: {
  readonly goals: readonly GoalRecord[];
  readonly workflows: ReadonlyArray<{
    readonly workflow: WorkflowRecord;
    readonly instances: readonly WorkflowInstanceRecord[];
  }>;
}): DecisionRoomWhatHappened {
  const goals = input.goals.map(recapGoal);
  const workflows: DecisionRoomWorkflowRecap[] = input.workflows.map(({ workflow, instances }) => ({
    workflowId: workflow.workflowId,
    workspaceId: workflow.workspaceId,
    name: workflow.name,
    description: workflow.description,
    instanceCounts: tallyInstanceStatuses(instances),
    instances: instances.map(recapInstance),
  }));
  const allInstances = input.workflows.flatMap((entry) => entry.instances);
  return {
    goals,
    workflows,
    goalStatusCounts: tallyGoalStatuses(input.goals),
    instanceStatusCounts: tallyInstanceStatuses(allInstances),
  };
}

// ---------------------------------------------------------------------------
// WHY — the Learning-derived rationale (applicability + supersession chain)
// ---------------------------------------------------------------------------

/**
 * WHY composition: every Learning of the Client with its applicability
 * conditions, DERIVED state and DERIVED successor pointer (the /learnings
 * contract computes both from the append-only relationship history — this
 * read model only presents them). Learnings arrive newest first (the
 * /learnings list order).
 */
export function composeDecisionRoomWhy(
  learnings: readonly LearningRecord[],
): DecisionRoomWhy {
  const rationale: DecisionRoomLearningRationale[] = learnings.map((learning) => ({
    learningId: learning.learningId,
    workspaceId: learning.workspaceId,
    statement: learning.statement,
    applicability: learning.applicability,
    status: learning.status,
    supersededBy: learning.supersededBy,
    confidence: learning.confidence,
    evidenceRefs: learning.evidenceRefs,
    experimentRefs: learning.experimentRefs,
  }));
  return {
    learnings: rationale,
    learningStatusCounts: tallyLearningStatuses(learnings),
  };
}

// ---------------------------------------------------------------------------
// EVIDENCE QUALITY — grade distribution by class (a tally, never a re-grading)
// ---------------------------------------------------------------------------

/**
 * EVIDENCE QUALITY composition: the quality-grade distribution per evidence
 * class over the /evidence records passed in (the module passes the Client's
 * bounded public listing — the append-only ledger grows without end, so the
 * posture is computed over the newest window; the bound is the /evidence
 * authority's server-chosen limit, disclosed by the route).
 *
 * Superseded records are included exactly as the /evidence listing includes
 * them (immutable history stays readable). Classes appear in the frozen
 * EVIDENCE_CLASSES order with every grade key present (zeros included) so
 * the response shape is stable; classes with zero records are omitted from
 * `byClass` (an empty class carries no posture).
 */
export function composeDecisionRoomEvidenceQuality(
  records: readonly EvidenceRecord[],
): DecisionRoomEvidenceQuality {
  const byClass: DecisionRoomEvidenceClassPosture[] = [];
  let totalRecords = 0;
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const gradeCounts = zeroed(EVIDENCE_QUALITY_GRADES);
    let total = 0;
    for (const record of records) {
      if (record.class !== evidenceClass) continue;
      gradeCounts[record.quality] += 1;
      total += 1;
    }
    if (total === 0) continue;
    byClass.push({ class: evidenceClass, gradeCounts, total });
    totalRecords += total;
  }
  return { byClass, totalRecords };
}

// ---------------------------------------------------------------------------
// EXPERIMENTS — declared design + lifecycle + the RESULTING DECISION (surfaced)
// ---------------------------------------------------------------------------

/**
 * EXPERIMENTS composition: every experiment of the Client with its declared
 * hypothesis, decision target, design type, analysis method (+version),
 * primary metric NAME and the lifecycle + result state — the resulting
 * decision field SURFACED verbatim from the /experiments contract, never
 * re-derived. Experiments arrive newest first (the /experiments list order).
 */
export function composeDecisionRoomExperiments(
  experiments: readonly ExperimentRecord[],
): DecisionRoomExperiments {
  const recaps: DecisionRoomExperimentRecap[] = experiments.map((experiment) => ({
    experimentId: experiment.experimentId,
    workspaceId: experiment.workspaceId,
    hypothesis: experiment.hypothesis,
    decisionTarget: experiment.decisionTarget,
    status: experiment.status,
    designType: experiment.designType,
    analysisMethod: experiment.analysisMethod,
    analysisMethodVersion: experiment.analysisMethodVersion,
    primaryMetricName: experiment.primaryMetric.name,
    resultState: experiment.resultState,
    resultingDecision: experiment.resultingDecision,
    concludedAt: experiment.concludedAt,
  }));
  return {
    experiments: recaps,
    experimentStatusCounts: tallyExperimentStatuses(experiments),
  };
}

// ---------------------------------------------------------------------------
// RECOMMENDATIONS — applicable learnings + declared experiment decisions ONLY
// ---------------------------------------------------------------------------

/**
 * RECOMMENDATIONS derivation (the frozen evidence-and-experimentation
 * contract): a recommendation may present EXACTLY an applicable (derived
 * status 'active') Learning or an experiment's DECLARED resulting decision
 * (a CONCLUDED experiment with a non-null decision). A CONTRADICTED learning
 * is excluded (later evidence explicitly contradicts it); SUPERSEDED and
 * RETIRED learnings are excluded (terminal). Attribution results ride as
 * `resultState: 'attribution'` with the declared design/analysis verbatim —
 * never serialized as causal lift. Items appear in the caller's list order
 * (learnings first, then experiments — each newest first per the module's
 * list reads).
 */
export function deriveDecisionRoomRecommendations(input: {
  readonly learnings: readonly LearningRecord[];
  readonly experiments: readonly ExperimentRecord[];
}): DecisionRoomRecommendations {
  const items: DecisionRoomRecommendation[] = [];
  for (const learning of input.learnings) {
    if (learning.status !== 'active') continue;
    items.push({
      kind: 'applicable_learning',
      learningId: learning.learningId,
      statement: learning.statement,
      applicability: learning.applicability,
      confidence: learning.confidence,
    });
  }
  for (const experiment of input.experiments) {
    if (experiment.status !== 'concluded') continue;
    if (experiment.resultingDecision === null) continue;
    items.push({
      kind: 'experiment_decision',
      experimentId: experiment.experimentId,
      decisionTarget: experiment.decisionTarget,
      resultingDecision: experiment.resultingDecision,
      designType: experiment.designType,
      analysisMethod: experiment.analysisMethod,
      analysisMethodVersion: experiment.analysisMethodVersion,
      resultState: experiment.resultState,
    });
  }
  return {
    items,
    basis: 'applicable_learnings_and_declared_experiment_decisions',
  };
}

// ---------------------------------------------------------------------------
// APPROVALS — the pending states durable state already exposes
// ---------------------------------------------------------------------------

/** Experiment lifecycle states that are NOT terminal (a decision may still come). */
const NON_TERMINAL_EXPERIMENT_STATUSES: ReadonlySet<ExperimentStatus> = new Set([
  'draft',
  'ready',
  'running',
  'analyzing',
]);

/** The frozen §5 instance states that mean "awaiting continuation". */
const AWAITING_INSTANCE_STATUSES: ReadonlySet<WorkflowInstanceStatus> = new Set([
  'blocked',
  'paused',
]);

/**
 * APPROVALS derivation (durable state ONLY, never invented):
 *
 *   - `experiment_awaiting_decision`: an experiment in a NON-TERMINAL
 *     lifecycle state (draft/ready/running/analyzing) whose result state is
 *     still 'undecided' — the pending-decision state the /experiments
 *     authority exposes;
 *   - `workflow_instance_awaiting_continuation`: a workflow instance BLOCKED
 *     or PAUSED — the frozen §5 awaiting states the /workflows authority
 *     exposes.
 *
 * Experiments arrive first (their list order), then instances (the WHAT
 * HAPPENED composition order: per workflow, oldest first).
 */
export function deriveDecisionRoomApprovals(input: {
  readonly experiments: readonly ExperimentRecord[];
  readonly instances: readonly WorkflowInstanceRecord[];
}): DecisionRoomApprovals {
  const items: DecisionRoomApproval[] = [];
  for (const experiment of input.experiments) {
    if (!NON_TERMINAL_EXPERIMENT_STATUSES.has(experiment.status)) continue;
    if (experiment.resultState !== 'undecided') continue;
    items.push({
      kind: 'experiment_awaiting_decision',
      experimentId: experiment.experimentId,
      status: experiment.status,
      decisionTarget: experiment.decisionTarget,
      hypothesis: experiment.hypothesis,
    });
  }
  for (const instance of input.instances) {
    if (!AWAITING_INSTANCE_STATUSES.has(instance.status)) continue;
    items.push({
      kind: 'workflow_instance_awaiting_continuation',
      workflowInstanceId: instance.workflowInstanceId,
      workflowId: instance.workflowId,
      instanceStatus: instance.status,
      updatedAt: instance.updatedAt,
    });
  }
  return { items };
}
