/**
 * The /ai-operator PURE derivations (MKT-045 — AI Operator / Attention
 * Queue): every attention-item derivation and the deterministic ranking
 * core. NO I/O, NO clock reads, NO randomness: the same input rows + the
 * same rank version derive byte-identical items in byte-identical order
 * (the ao-rank-v1 pinning proof — the score NEVER reads the clock, so
 * ranking determinism holds for identical authority state at ANY time).
 *
 * The /profit-intelligence pure-derivation posture: all row gathering
 * lives in internal/ai-operator-module.ts (through the composed
 * authorities' PUBLIC CONTRACTS only); these functions take plain rows
 * and return plain items. Margin-pressure and scope-leakage items CONSUME
 * /profit-intelligence views (ClientProfitIntelligenceView) — the figures
 * are never recomputed here; their calculation version ships inside the
 * item rationale ('source-calculation-version').
 */

import type { DeploymentRecord } from '../../deployments/public.ts';
import type { EvidenceRecord } from '../../evidence/public.ts';
import type { ExecutionRecord } from '../../executions/public.ts';
import type { ExperimentRecord } from '../../experiments/public.ts';
import type { HumanAgentRecord } from '../../field-agents/public.ts';
import type { JobRecord } from '../../jobs/public.ts';
import type { LearningRecord } from '../../learnings/public.ts';
import type { PolicyDecisionRecord } from '../../policies/public.ts';
import { PROFIT_INTELLIGENCE_CALCULATION_VERSION } from '../../profit-intelligence/public.ts';
import type {
  ClientProfitIntelligenceView,
  ProfitSourceRef,
} from '../../profit-intelligence/public.ts';
import type { WorkflowInstanceRecord } from '../../workflows/public.ts';
import {
  AI_OPERATOR_ASSUMPTIONS,
  AI_OPERATOR_RANK_VERSION,
  ATTENTION_CATEGORIES,
} from '../public.ts';
import type {
  AttentionActionContract,
  AttentionCategory,
  AttentionCategoryCounts,
  AttentionItem,
  AttentionRationale,
  AttentionRationaleFactor,
  AttentionSourceRef,
  AttentionSourceRefKind,
  RankingDisclosure,
} from '../public.ts';

// NOTE (the PI circular-import posture): the frozen constants from
// ../public.ts are referenced at CALL time only — never re-bound into
// top-level locals — because public.ts re-exports this file's module
// factory (the module-eval order would hit the TDZ otherwise). The
// derivations below therefore reference AI_OPERATOR_ASSUMPTIONS /
// AI_OPERATOR_RANK_VERSION / ATTENTION_CATEGORIES directly.

/** The frozen total sort rule, stated verbatim (ships in every response). */
export const ATTENTION_SORT_RULE =
  'priorityScore DESC, then category ASC (vocabulary order is irrelevant; the tiebreak is lexicographic), then itemId ASC — a total deterministic order: identical authority rows always rank identically';

// ---------------------------------------------------------------------------
// Snapshot row types (the module gathers these through public contracts)
// ---------------------------------------------------------------------------

/** The per-client authority rows the pure derivations consume. */
export interface ClientScopeRows {
  readonly agencyId: string;
  readonly clientId: string;
  readonly clientStatus: string;
  /** LIVE workspaces of the client with their delivery-surface rows. */
  readonly workspaces: ReadonlyArray<{
    readonly workspaceId: string;
    readonly instances: readonly WorkflowInstanceRecord[];
    readonly deployments: readonly DeploymentRecord[];
    readonly executions: readonly ExecutionRecord[];
  }>;
  /** Jobs visible through the agency's human-agent offer/marketplace window. */
  readonly jobs: readonly JobRecord[];
  readonly evidence: readonly EvidenceRecord[];
  readonly experiments: readonly ExperimentRecord[];
  readonly learnings: readonly LearningRecord[];
  /**
   * The /profit-intelligence CLIENT view consumed for scope-leakage and
   * margin-pressure items (its figures are NEVER recomputed here).
   */
  readonly profit: ClientProfitIntelligenceView | null;
}

/** The agency-scope job rows for the capacity-constraint derivation. */
export interface CapacityJobRows {
  /** OPEN jobs (projected/offered — the forward-looking demand). */
  readonly openJobs: readonly JobRecord[];
  /** IN-FLIGHT jobs (accepted, outcome not yet submitted). */
  readonly inFlightJobs: readonly JobRecord[];
}

/** The full agency-scope snapshot the module hands to the derivations. */
export interface AgencyScopeSnapshot {
  readonly agencyId: string;
  readonly clients: readonly ClientScopeRows[];
  /** The agency's undecided policy decisions (outcome 'unknown'). */
  readonly undecidedPolicyDecisions: readonly PolicyDecisionRecord[];
  /** The agency's active Human Agent profiles (the capacity pool). */
  readonly humanAgentProfiles: readonly HumanAgentRecord[];
  readonly capacityJobs: CapacityJobRows;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ref(kind: AttentionSourceRefKind, id: string): AttentionSourceRef {
  return { kind, id };
}

/**
 * Maps a /profit-intelligence source reference into the attention
 * vocabulary — kind identity preserved verbatim (every PI kind is an
 * attention kind; a consumed figure's canonical references are never
 * dropped or renamed).
 */
const PI_REF_KIND_MAP: Readonly<Record<ProfitSourceRef['kind'], AttentionSourceRefKind>> = {
  'metric-observation': 'metric-observation',
  evidence: 'evidence',
  execution: 'execution',
  'usage-telemetry': 'usage-telemetry',
  'task-profile': 'task-profile',
  job: 'job',
  'job-offer': 'job-offer',
  goal: 'goal',
  playbook: 'playbook',
  'playbook-version': 'playbook-version',
  deployment: 'deployment',
  workflow: 'workflow',
  'workflow-definition': 'workflow-definition',
  'workflow-instance': 'workflow-instance',
  'human-agent-profile': 'human-agent-profile',
  'integration-connection': 'integration-connection',
  'ingested-integration-event': 'ingested-integration-event',
};

/** One consumed figure's canonical references, mapped verbatim. */
function piRefs(refs: readonly ProfitSourceRef[]): AttentionSourceRef[] {
  return refs.map((source) => ref(PI_REF_KIND_MAP[source.kind], source.id));
}

function factor(key: AttentionRationaleFactor['key'], value: string): AttentionRationaleFactor {
  return { key, value };
}

/** Caps a non-negative integer into [lo, hi]. */
function cap(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** The deterministic item identity (AC-3: canonical ids only, stable across reads). */
export function attentionItemKey(
  category: AttentionCategory,
  primaryKind: string,
  primaryId: string,
  subKind: string | null = null,
): string {
  return subKind === null
    ? `ao:${category}:${primaryKind}:${primaryId}`
    : `ao:${category}:${primaryKind}:${primaryId}:${subKind}`;
}

// ---------------------------------------------------------------------------
// The raw item shape (pre-ranking: no score/rank yet)
// ---------------------------------------------------------------------------

/** One derived candidate before ranking (score inputs attach here). */
interface RawItem {
  readonly itemId: string;
  readonly category: AttentionCategory;
  readonly scope: { agencyId: string; clientId: string | null; workspaceId: string | null };
  readonly severity: number;
  readonly recurrence: number;
  /** The assumption keys the final score consumes (category keys + per-item keys). */
  readonly scoreAssumptionKeys: readonly string[];
  readonly sourceRefs: readonly AttentionSourceRef[];
  readonly rationale: AttentionRationale;
  readonly actionContract: AttentionActionContract;
}

// ---------------------------------------------------------------------------
// 1. Blocked work (jobs/workflows/executions states) — AC-2
// ---------------------------------------------------------------------------

const INSTANCE_BLOCKED_SEVERITY: Readonly<Record<string, number>> = {
  blocked: 8,
  paused: 4,
};
const EXECUTION_BLOCKED_SEVERITY: Readonly<Record<string, number>> = {
  paused: 4,
  pausing: 5,
};
const DEPLOYMENT_BLOCKED_SEVERITY: Readonly<Record<string, number>> = {
  blocked: 10,
  disabled: 6,
};
const JOB_BLOCKED_SEVERITY: Readonly<Record<string, number>> = {
  expired: 6,
  declined: 5,
};

const BLOCKED_WORK_CATEGORY_KEYS = ['categoryBaseWeights', 'severityModifierRange', 'recurrenceModifierRange'];

/**
 * Derives blocked-work items: workflow instances stuck out of forward
 * progress (blocked/paused), executions held (pausing/paused), deployments
 * terminally blocked (blocked/disabled — the operator path is a NEW
 * deployment), and jobs that will not proceed (expired/declined terminal
 * unfulfilled states). The recurrence modifier counts FAILED executions
 * linked to the same workflow instance (blocked work with failure
 * history is more urgent).
 */
export function deriveBlockedWorkItems(client: ClientScopeRows): RawItem[] {
  const items: RawItem[] = [];
  const failedExecutionsByInstance = new Map<string, number>();
  for (const workspace of client.workspaces) {
    for (const execution of workspace.executions) {
      if (execution.status !== 'failed') continue;
      if (execution.taskLink.kind !== 'workflow-node') continue;
      failedExecutionsByInstance.set(
        execution.taskLink.workflowInstanceId,
        (failedExecutionsByInstance.get(execution.taskLink.workflowInstanceId) ?? 0) + 1,
      );
    }
  }

  for (const workspace of client.workspaces) {
    // 1a. Blocked/paused workflow instances.
    for (const instance of workspace.instances) {
      const severity = INSTANCE_BLOCKED_SEVERITY[instance.status];
      if (severity === undefined) continue;
      const linkedFailed = failedExecutionsByInstance.get(instance.workflowInstanceId) ?? 0;
      const recurrence = cap(linkedFailed, 0, AI_OPERATOR_ASSUMPTIONS.recurrenceModifierRange[1]);
      items.push({
        itemId: attentionItemKey('blocked-work', 'workflow-instance', instance.workflowInstanceId),
        category: 'blocked-work',
        scope: {
          agencyId: client.agencyId,
          clientId: client.clientId,
          workspaceId: instance.workspaceId,
        },
        severity,
        recurrence,
        scoreAssumptionKeys: [...BLOCKED_WORK_CATEGORY_KEYS],
        sourceRefs: [
          ref('workflow-instance', instance.workflowInstanceId),
          ref('workspace', workspace.workspaceId),
        ],
        rationale: {
          headline: `workflow instance ${instance.workflowInstanceId} is ${instance.status}`,
          factors: [
            factor('instance-status', instance.status),
            factor('linked-failed-executions', String(linkedFailed)),
          ],
        },
        actionContract: {
          kind: 'workflow-instance-transition',
          surface: '/workflows instance transition (POST /api/workflows/:workflowId/instances/:instanceId/transitions)',
          policyDimension: null,
          policyScopeKind: null,
          targetRef: ref('workflow-instance', instance.workflowInstanceId),
          note: 'resuming or abandoning the blocked work continues through the workflow instance transition contract (its own legal-transition authority; approval nodes carry their humanApproval requirement there)',
        },
      });
    }

    // 1b. Held executions (pausing/paused — out of forward progress).
    for (const execution of workspace.executions) {
      const severity = EXECUTION_BLOCKED_SEVERITY[execution.status];
      if (severity === undefined) continue;
      items.push({
        itemId: attentionItemKey('blocked-work', 'execution', execution.executionId),
        category: 'blocked-work',
        scope: {
          agencyId: client.agencyId,
          clientId: client.clientId,
          workspaceId: execution.workspaceId,
        },
        severity,
        recurrence: 0,
        scoreAssumptionKeys: [...BLOCKED_WORK_CATEGORY_KEYS],
        sourceRefs: [ref('execution', execution.executionId)],
        rationale: {
          headline: `execution ${execution.executionId} is ${execution.status}`,
          factors: [factor('execution-status', execution.status)],
        },
        actionContract: {
          kind: 'execution-reconciliation',
          surface: '/executions execution transition (the lifecycle authority)',
          policyDimension: null,
          policyScopeKind: null,
          targetRef: ref('execution', execution.executionId),
          note: 'resuming the held execution continues through the execution transition contract (never a second retry engine here)',
        },
      });
    }

    // 1c. Terminally blocked/disabled deployments.
    for (const deployment of workspace.deployments) {
      const severity = DEPLOYMENT_BLOCKED_SEVERITY[deployment.status];
      if (severity === undefined) continue;
      items.push({
        itemId: attentionItemKey('blocked-work', 'deployment', deployment.deploymentId),
        category: 'blocked-work',
        scope: {
          agencyId: client.agencyId,
          clientId: client.clientId,
          workspaceId: deployment.workspaceId,
        },
        severity,
        recurrence: 0,
        scoreAssumptionKeys: [...BLOCKED_WORK_CATEGORY_KEYS],
        sourceRefs: [ref('deployment', deployment.deploymentId)],
        rationale: {
          headline: `deployment ${deployment.deploymentId} is ${deployment.status} (terminal)`,
          factors: [factor('deployment-status', deployment.status)],
        },
        actionContract: {
          kind: 'deployment-lifecycle',
          surface: '/deployments lifecycle (the sole deployment authority — the operator path from a blocked/disabled deployment is a NEW deployment)',
          policyDimension: null,
          policyScopeKind: null,
          targetRef: ref('deployment', deployment.deploymentId),
          note: 're-aligning delivery continues through the deployment lifecycle contract (deployment validation re-runs its policy gate there)',
        },
      });
    }
  }

  // 1d. Jobs that will not proceed (expired/declined terminal states).
  for (const job of client.jobs) {
    const severity = JOB_BLOCKED_SEVERITY[job.status];
    if (severity === undefined) continue;
    items.push({
      itemId: attentionItemKey('blocked-work', 'job', job.jobId),
      category: 'blocked-work',
      scope: {
        agencyId: client.agencyId,
        clientId: job.clientId,
        workspaceId: job.workspaceId,
      },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...BLOCKED_WORK_CATEGORY_KEYS],
      sourceRefs: [ref('job', job.jobId)],
      rationale: {
        headline: `job ${job.jobId} is ${job.status} (the work will not proceed)`,
        factors: [factor('job-status', job.status)],
      },
      actionContract: {
        kind: 'job-outcome-submission',
        surface: '/jobs projection + outcome (the human job authority)',
        policyDimension: null,
        policyScopeKind: null,
        targetRef: ref('job', job.jobId),
        note: 're-commissioning the work continues through the job authority (a new projection on the same instance, offered and settled through its own contracts)',
      },
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// 2. Pending approvals (policies) — AC-2
// ---------------------------------------------------------------------------

const APPROVAL_SEVERITY_BY_REASON: Readonly<Record<string, number>> = {
  'no-active-policy': 10,
  'no-matching-rule': 8,
};

const APPROVAL_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'approvalDimensionRecurrenceCap',
];

/**
 * Derives approval items: policy decision records with outcome 'unknown'
 * — actions that knocked on the approval contract and remain UNDECIDED
 * (no matching rule / no active policy). These are the pending approvals:
 * the consequential action is stuck at the policy gate; the item carries
 * the gate's dimension and scope. The recurrence modifier counts OTHER
 * undecided decisions on the SAME dimension in the same ledger slice (a
 * repeated policy gap pattern).
 */
export function deriveApprovalItems(
  decisions: readonly PolicyDecisionRecord[],
  clientNarrowing: string | null,
): RawItem[] {
  const undecided = decisions.filter((decision) => decision.outcome === 'unknown');
  const dimensionCounts = new Map<string, number>();
  for (const decision of undecided) {
    dimensionCounts.set(decision.dimension, (dimensionCounts.get(decision.dimension) ?? 0) + 1);
  }

  const items: RawItem[] = [];
  for (const decision of undecided) {
    // Client narrowing (the client slice): agency-scoped decisions (no
    // client) stay in the agency queue only.
    if (clientNarrowing !== null && decision.clientId !== clientNarrowing) continue;
    const severity = APPROVAL_SEVERITY_BY_REASON[decision.reasonCode] ?? 5;
    const sameDimension = dimensionCounts.get(decision.dimension) ?? 1;
    const recurrence = cap(sameDimension - 1, 0, AI_OPERATOR_ASSUMPTIONS.approvalDimensionRecurrenceCap);
    const scopeKind = decision.clientId !== null ? 'client' : 'agency';
    items.push({
      itemId: attentionItemKey('approval', 'policy-decision', decision.decisionId),
      category: 'approval',
      scope: {
        agencyId: decision.agencyId,
        clientId: decision.clientId,
        workspaceId: null,
      },
      severity,
      recurrence,
      scoreAssumptionKeys: [...APPROVAL_CATEGORY_KEYS],
      sourceRefs: [
        ref('policy-decision', decision.decisionId),
        ...(decision.clientId !== null ? [ref('client', decision.clientId)] : []),
      ],
      rationale: {
        headline: `action '${decision.action.operation}' (${decision.dimension}) is pending approval — the policy evaluation is undecided`,
        factors: [
          factor('policy-outcome', decision.outcome),
          factor('policy-reason', decision.reasonCode),
          factor('policy-dimension', decision.dimension),
          factor('policy-scope-kind', scopeKind),
          factor('same-dimension-undecided-count', String(sameDimension)),
        ],
      },
      actionContract: {
        kind: 'policy-evaluation',
        surface: '/policies evaluateAction (the fail-closed approval contract)',
        policyDimension: decision.dimension,
        policyScopeKind: scopeKind,
        targetRef: ref('policy-decision', decision.decisionId),
        note: 'the pending action continues through the policy evaluation contract — it re-evaluates once a matching active policy version exists (declared through the /policies declaration surface, its own authority)',
      },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 3. Client risk (clients + evidence) — AC-2
// ---------------------------------------------------------------------------

const CLIENT_RISK_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'clientRiskWeakEvidenceGrades',
  'clientRiskWeakEvidenceThreshold',
  'clientRiskSeverityCap',
];

/**
 * Derives client-risk items: a Client whose CURRENT evidence base carries
 * weak-quality records (grades D/E/F — the frozen assumption set). The
 * severity modifier is the weak-evidence count (capped); the rationale
 * carries the full grade distribution. The item exists only at/above the
 * frozen weak-evidence threshold.
 */
export function deriveClientRiskItems(client: ClientScopeRows): RawItem[] {
  const weakGrades = new Set<string>(AI_OPERATOR_ASSUMPTIONS.clientRiskWeakEvidenceGrades);
  const gradeCounts = new Map<string, number>();
  const weakRefs: AttentionSourceRef[] = [];
  let weakCount = 0;
  for (const record of client.evidence) {
    if (record.supersededBy !== null) continue; // only CURRENT records count
    gradeCounts.set(record.quality, (gradeCounts.get(record.quality) ?? 0) + 1);
    if (weakGrades.has(record.quality)) {
      weakCount += 1;
      weakRefs.push(ref('evidence', record.evidenceId));
    }
  }
  if (weakCount < AI_OPERATOR_ASSUMPTIONS.clientRiskWeakEvidenceThreshold) return [];

  const severity = cap(weakCount, 0, AI_OPERATOR_ASSUMPTIONS.clientRiskSeverityCap);
  const distribution = [...gradeCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([grade, count]) => `${grade}:${count}`)
    .join(',');
  const gradesList = [...weakGrades].join('/');

  return [
    {
      itemId: attentionItemKey('client-risk', 'client', client.clientId),
      category: 'client-risk',
      scope: {
        agencyId: client.agencyId,
        clientId: client.clientId,
        workspaceId: null,
      },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...CLIENT_RISK_CATEGORY_KEYS],
      sourceRefs: [ref('client', client.clientId), ...weakRefs],
      rationale: {
        headline: `client ${client.clientId} rests on ${weakCount} weak-quality evidence record${weakCount === 1 ? '' : 's'} (grades ${gradesList})`,
        factors: [
          factor('client-status', client.clientStatus),
          factor('weak-evidence-count', String(weakCount)),
          factor('weak-evidence-grades', gradesList),
          factor('evidence-grade-counts', distribution),
        ],
      },
      actionContract: {
        kind: 'evidence-append',
        surface: '/evidence append (the append-only evidence authority, supersession chain)',
        policyDimension: null,
        policyScopeKind: null,
        targetRef: ref('client', client.clientId),
        note: 'strengthening the evidence base continues through the evidence append contract (new authoritative records supersede weak ones — history is never rewritten)',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Anomalies (execution failure patterns) — AC-2
// ---------------------------------------------------------------------------

const ANOMALY_SEVERITY: Readonly<Record<string, number>> = {
  unknown: 10,
  reconciling: 8,
  failed: 6,
};

const ANOMALY_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'anomalyAttemptRecurrenceCap',
];

/**
 * Derives anomaly items: executions in failed / unknown / reconciling
 * states — the failure pattern surface. UNKNOWN is the worst posture
 * (unresolved outcome — never success); 'failed' with an UNSAFE retry
 * classification is escalated (+2, capped). The recurrence modifier is
 * the attempt number (retries of the same logical operation).
 */
export function deriveAnomalyItems(client: ClientScopeRows): RawItem[] {
  const items: RawItem[] = [];
  for (const workspace of client.workspaces) {
    for (const execution of workspace.executions) {
      const base = ANOMALY_SEVERITY[execution.status];
      if (base === undefined) continue;
      let severity = base;
      if (
        execution.status === 'failed' &&
        execution.retryClassification === 'unsafe'
      ) {
        severity = Math.min(AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1], severity + 2);
      }
      const recurrence = cap(
        execution.attemptNumber - 1,
        0,
        AI_OPERATOR_ASSUMPTIONS.anomalyAttemptRecurrenceCap,
      );
      items.push({
        itemId: attentionItemKey('anomaly', 'execution', execution.executionId),
        category: 'anomaly',
        scope: {
          agencyId: client.agencyId,
          clientId: execution.clientId,
          workspaceId: execution.workspaceId,
        },
        severity,
        recurrence,
        scoreAssumptionKeys: [...ANOMALY_CATEGORY_KEYS],
        sourceRefs: [ref('execution', execution.executionId)],
        rationale: {
          headline: `execution ${execution.executionId} is ${execution.status}${execution.retryClassification !== null ? ` (retry ${execution.retryClassification})` : ''}`,
          factors: [
            factor('execution-status', execution.status),
            factor('execution-kind', execution.executionKind),
            factor('attempt-number', String(execution.attemptNumber)),
            factor(
              'retry-classification',
              execution.retryClassification ?? 'unset',
            ),
          ],
        },
        actionContract: {
          kind: 'execution-reconciliation',
          surface: '/executions transition/reconciliation (the execution lifecycle authority)',
          policyDimension: null,
          policyScopeKind: null,
          targetRef: ref('execution', execution.executionId),
          note: 'resolving the anomaly continues through the execution reconciliation contract (UNKNOWN requires explicit reconciliation — non-idempotent side effects are never blindly replayed; retries respect the recorded retry classification)',
        },
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// 5. Scope leakage — CONSUMED from /profit-intelligence (never recomputed)
// ---------------------------------------------------------------------------

const SCOPE_LEAKAGE_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'scopeLeakageSeverityCap',
];

/**
 * Derives scope-leakage items: the /profit-intelligence CLIENT view's
 * scope-leakage indicators, consumed verbatim (count + source refs + the
 * PI calculation version — NEVER recomputed here). One item per indicator
 * kind with count > 0. The severity modifier is the leaked-unit count
 * (capped).
 */
export function deriveScopeLeakageItems(client: ClientScopeRows): RawItem[] {
  if (client.profit === null) return [];
  const items: RawItem[] = [];
  for (const indicator of client.profit.scopeLeakage.indicators) {
    if (indicator.count <= 0) continue;
    const severity = cap(indicator.count, 0, AI_OPERATOR_ASSUMPTIONS.scopeLeakageSeverityCap);
    items.push({
      itemId: attentionItemKey(
        'scope-leakage',
        'client',
        client.clientId,
        indicator.kind,
      ),
      category: 'scope-leakage',
      scope: {
        agencyId: client.agencyId,
        clientId: client.clientId,
        workspaceId: null,
      },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...SCOPE_LEAKAGE_CATEGORY_KEYS],
      sourceRefs: [ref('client', client.clientId), ...piRefs(indicator.sourceRefs)],
      rationale: {
        headline: `scope leakage on client ${client.clientId}: ${indicator.count} × ${indicator.kind}`,
        factors: [
          factor('leakage-kind', indicator.kind),
          factor('leaked-count', String(indicator.count)),
          factor('source-calculation-version', client.profit.calculation.calculationVersion),
        ],
      },
      actionContract: {
        kind: 'decision-recording',
        surface: '/decisions record (the append-only Decision Ledger)',
        policyDimension: null,
        policyScopeKind: null,
        targetRef: ref('client', client.clientId),
        note: 'the scope response (expand the deployed envelope, re-scope the goal, or stop the work) continues through the decision-recording contract — the consequential re-deployment/re-scoping then flows through the deployment and workflow authorities under their own policy gates',
      },
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 6. Margin pressure — CONSUMED from /profit-intelligence (never recomputed)
// ---------------------------------------------------------------------------

const MARGIN_PRESSURE_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'marginPressureThresholdRatio',
  'marginPressureNegativeIsAlwaysPressure',
];

/** Rounds a ratio to 4 decimal places (deterministic float presentation). */
function roundRatio(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Derives margin-pressure items from the /profit-intelligence CLIENT
 * view's REALIZED margin figures (consumed verbatim — never recomputed).
 * An item exists when the realized margin is derivable and negative, or
 * when the realized margin ratio (realizedMargin ÷ realizedRevenue) is
 * below the frozen pressure threshold. Non-derivable margins (e.g.
 * currency mismatch) produce NO item — an honest absence, not pressure.
 */
export function deriveMarginPressureItems(client: ClientScopeRows): RawItem[] {
  if (client.profit === null) return [];
  const margin = client.profit.margin.realizedMargin;
  const revenue = client.profit.margin.realizedRevenue;
  if (margin.value === null || revenue.value === null) return [];

  const marginValue = margin.value;
  const revenueValue = revenue.value;
  const threshold = AI_OPERATOR_ASSUMPTIONS.marginPressureThresholdRatio;
  const ratio = revenueValue > 0 ? roundRatio(marginValue / revenueValue) : null;
  const isPressure =
    marginValue < 0 ||
    (ratio !== null && ratio < threshold) ||
    (revenueValue === 0 && marginValue < 0);
  if (!isPressure) return [];

  let severity: number;
  if (marginValue < 0) {
    severity = AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1];
  } else if (ratio === null) {
    severity = AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1]; // zero revenue with a non-positive margin: maximal pressure
  } else {
    // Deterministic depth-below-threshold severity, clamped into [1, 9].
    severity = cap(
      Math.ceil(((threshold - ratio) / threshold) * 9),
      1,
      9,
    );
  }

  const factors: AttentionRationaleFactor[] = [
    factor('realized-margin', String(marginValue)),
    factor('realized-revenue', String(revenueValue)),
    factor('margin-ratio', ratio === null ? 'not-derivable-zero-revenue' : String(ratio)),
    factor('pressure-threshold-ratio', String(threshold)),
    factor('source-calculation-version', client.profit.calculation.calculationVersion),
  ];

  return [
    {
      itemId: attentionItemKey('margin-pressure', 'client', client.clientId),
      category: 'margin-pressure',
      scope: {
        agencyId: client.agencyId,
        clientId: client.clientId,
        workspaceId: null,
      },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...MARGIN_PRESSURE_CATEGORY_KEYS],
      sourceRefs: [ref('client', client.clientId), ...piRefs(margin.sourceRefs)],
      rationale: {
        headline:
          marginValue < 0
            ? `client ${client.clientId} realized margin is negative (${marginValue} ${margin.currency})`
            : `client ${client.clientId} realized margin ratio ${ratio} is below the pressure threshold ${threshold}`,
        factors,
      },
      actionContract: {
        kind: 'decision-recording',
        surface: '/decisions record (the append-only Decision Ledger)',
        policyDimension: null,
        policyScopeKind: null,
        targetRef: ref('client', client.clientId),
        note: 'the commercial response (reprice, resize, re-scope or stop) continues through the decision-recording contract — consequential changes to delivery then flow through the deployment/workflow/policy authorities under their own gates',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 7. Capacity constraints (field-agents availability + jobs) — AC-2
// ---------------------------------------------------------------------------

const CAPACITY_CONSTRAINT_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
  'capacityConstraintTriggerRatio',
  'capacityDemandMinutesPerJob',
  'capacityWindowRecurrence',
];

/** Weekly declared capacity minutes over the ACTIVE profiles (the pool). */
export function declaredWeeklyCapacityMinutes(
  profiles: readonly HumanAgentRecord[],
): number {
  let minutes = 0;
  for (const profile of profiles) {
    if (profile.authorizationState !== 'active') continue;
    for (const window of profile.availability) {
      minutes += window.endMinute - window.startMinute;
    }
  }
  return minutes;
}

/**
 * Derives the AGENCY capacity-constraint item (exactly one at most — the
 * human pool is agency-scoped): projected demand minutes (open jobs +
 * in-flight jobs × the frozen per-job demand minutes) against declared
 * weekly availability minutes. An item exists when demand exceeds
 * capacity (the frozen trigger ratio) — or when there is open demand but
 * NO declared capacity at all.
 */
export function deriveCapacityConstraintItem(
  agencyId: string,
  profiles: readonly HumanAgentRecord[],
  capacityJobs: CapacityJobRows,
): RawItem[] {
  const activeProfiles = profiles.filter(
    (profile) => profile.authorizationState === 'active',
  );
  const capacityMinutes = declaredWeeklyCapacityMinutes(profiles);
  const openJobCount = capacityJobs.openJobs.length;
  const inFlightJobCount = capacityJobs.inFlightJobs.length;
  const demandMinutes =
    (openJobCount + inFlightJobCount) * AI_OPERATOR_ASSUMPTIONS.capacityDemandMinutesPerJob;

  const hasDemand = demandMinutes > 0;
  const exceeds =
    capacityMinutes > 0
      ? demandMinutes / capacityMinutes > AI_OPERATOR_ASSUMPTIONS.capacityConstraintTriggerRatio
      : hasDemand; // no declared capacity + open demand: the constraint IS total
  if (!hasDemand || !exceeds) return [];

  const severity =
    capacityMinutes === 0
      ? AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1]
      : cap(
          Math.ceil((demandMinutes / capacityMinutes) * 5),
          1,
          AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1],
        );

  const jobRefs: AttentionSourceRef[] = [
    ...capacityJobs.openJobs.map((job) => ref('job', job.jobId)),
    ...capacityJobs.inFlightJobs.map((job) => ref('job', job.jobId)),
  ];

  return [
    {
      itemId: attentionItemKey('capacity-constraint', 'agency', agencyId),
      category: 'capacity-constraint',
      scope: { agencyId, clientId: null, workspaceId: null },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...CAPACITY_CONSTRAINT_CATEGORY_KEYS],
      sourceRefs: [
        ...activeProfiles.map((profile) => ref('human-agent-profile', profile.agentId)),
        ...jobRefs,
      ],
      rationale: {
        headline: `projected human demand ${demandMinutes} min/week exceeds declared capacity ${capacityMinutes} min/week`,
        factors: [
          factor('declared-capacity-minutes', String(capacityMinutes)),
          factor('projected-demand-minutes', String(demandMinutes)),
          factor('open-job-count', String(openJobCount)),
          factor('in-flight-job-count', String(inFlightJobCount)),
          factor('active-profile-count', String(activeProfiles.length)),
        ],
      },
      actionContract: {
        kind: 'field-agent-availability',
        surface: '/field-agents profile availability (the Human Agent profile authority; field-dimension policy-gated)',
        policyDimension: 'field',
        policyScopeKind: 'agency',
        targetRef: ref('agency', agencyId),
        note: 'balancing the pool continues through the field-agent availability surface (and the job projection surface for demand) — both under their own authorization; field work is field-dimension policy-gated',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// 8. Opportunities (experiments/learnings) — AC-2
// ---------------------------------------------------------------------------

const OPPORTUNITY_CATEGORY_KEYS = [
  'categoryBaseWeights',
  'severityModifierRange',
  'recurrenceModifierRange',
];

const EXPERIMENT_OPPORTUNITIES: Readonly<Record<string, number>> = {
  'experiment-awaiting-start': 4,
  'experiment-analysis-pending': 6,
  'experiment-promotable': 8,
};

/**
 * Derives opportunity items: experiments ready to advance the knowledge
 * loop (status 'ready' — awaiting start; 'analyzing' — awaiting
 * conclusion; concluded with resultState 'causal_supported' — a
 * promotable causal finding awaiting its decision), plus CONTRADICTED
 * learnings (later evidence undermined a standing conclusion — the
 * revision opportunity).
 */
export function deriveOpportunityItems(client: ClientScopeRows): RawItem[] {
  const items: RawItem[] = [];

  for (const experiment of client.experiments) {
    let opportunityKind: string | null = null;
    if (experiment.status === 'ready') opportunityKind = 'experiment-awaiting-start';
    else if (experiment.status === 'analyzing') opportunityKind = 'experiment-analysis-pending';
    else if (
      experiment.status === 'concluded' &&
      experiment.resultState === 'causal_supported'
    ) {
      opportunityKind = 'experiment-promotable';
    }
    if (opportunityKind === null) continue;
    const severity = EXPERIMENT_OPPORTUNITIES[opportunityKind] ?? 0;
    const promotable = opportunityKind === 'experiment-promotable';
    items.push({
      itemId: attentionItemKey('opportunity', 'experiment', experiment.experimentId),
      category: 'opportunity',
      scope: {
        agencyId: client.agencyId,
        clientId: experiment.clientId,
        workspaceId: experiment.workspaceId,
      },
      severity,
      recurrence: 0,
      scoreAssumptionKeys: [...OPPORTUNITY_CATEGORY_KEYS],
      sourceRefs: [ref('experiment', experiment.experimentId)],
      rationale: {
        headline: `experiment ${experiment.experimentId} is ${experiment.status}${promotable ? ' with a causal-supported result — promotable into a decision' : ''}`,
        factors: [
          factor('opportunity-kind', opportunityKind),
          factor('experiment-status', experiment.status),
          factor('experiment-result-state', experiment.resultState),
        ],
      },
      actionContract: promotable
        ? {
            kind: 'decision-recording',
            surface: '/decisions record (the append-only Decision Ledger)',
            policyDimension: null,
            policyScopeKind: null,
            targetRef: ref('experiment', experiment.experimentId),
            note: 'promoting the causal-supported finding continues through the decision-recording contract (the recorded decision then drives deployment changes through their own policy gates)',
          }
        : {
            kind: 'experiment-lifecycle',
            surface: '/experiments lifecycle transitions (the experiment authority)',
            policyDimension: null,
            policyScopeKind: null,
            targetRef: ref('experiment', experiment.experimentId),
            note: 'advancing the experiment continues through the experiment lifecycle contract (start/analysis/conclusion transitions — its own authority)',
          },
    });
  }

  for (const learning of client.learnings) {
    if (learning.status !== 'contradicted') continue;
    items.push({
      itemId: attentionItemKey('opportunity', 'learning', learning.learningId),
      category: 'opportunity',
      scope: {
        agencyId: client.agencyId,
        clientId: learning.clientId,
        workspaceId: learning.workspaceId,
      },
      severity: 7,
      recurrence: 0,
      scoreAssumptionKeys: [...OPPORTUNITY_CATEGORY_KEYS],
      sourceRefs: [ref('learning', learning.learningId)],
      rationale: {
        headline: `learning ${learning.learningId} is contradicted by later evidence`,
        factors: [
          factor('opportunity-kind', 'learning-contradicted'),
          factor('learning-status', learning.status),
        ],
      },
      actionContract: {
        kind: 'learning-revision',
        surface: '/learnings append (the append-only learning authority, supersession chain)',
        policyDimension: null,
        policyScopeKind: null,
        targetRef: ref('learning', learning.learningId),
        note: 'revising the contradicted conclusion continues through the learning append contract (a new learning supersedes or retires it — contradictory history is preserved, never rewritten)',
      },
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// The ranking core (AC-6: deterministic, versioned, never time-based)
// ---------------------------------------------------------------------------

/**
 * Computes the deterministic priority score: category base weight +
 * severity modifier + recurrence modifier (all pure functions of the
 * authority rows; every input range is frozen in the assumption set).
 */
export function computeAttentionScore(item: {
  readonly category: AttentionCategory;
  readonly severity: number;
  readonly recurrence: number;
}): number {
  return (
    (AI_OPERATOR_ASSUMPTIONS.categoryBaseWeights[item.category] ?? 0) +
    cap(
      item.severity,
      AI_OPERATOR_ASSUMPTIONS.severityModifierRange[0],
      AI_OPERATOR_ASSUMPTIONS.severityModifierRange[1],
    ) +
    cap(
      item.recurrence,
      AI_OPERATOR_ASSUMPTIONS.recurrenceModifierRange[0],
      AI_OPERATOR_ASSUMPTIONS.recurrenceModifierRange[1],
    )
  );
}

/**
 * Ranks the derived candidates into the deterministic queue: score DESC,
 * then category ASC (lexicographic), then itemId ASC — a total order.
 * Ranks are 1-based positions. The returned items are FROZEN views of the
 * same derivation (source refs, rationale and action contract carried
 * verbatim).
 */
export function rankAttentionItems(items: readonly RawItem[]): readonly AttentionItem[] {
  const scored = items.map((item) => ({
    item,
    score: computeAttentionScore(item),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.item.category !== b.item.category) {
      return a.item.category.localeCompare(b.item.category);
    }
    return a.item.itemId.localeCompare(b.item.itemId);
  });
  return scored.map((entry, index) => ({
    itemId: entry.item.itemId,
    category: entry.item.category,
    scope: entry.item.scope,
    priorityScore: entry.score,
    rank: index + 1,
    sourceRefs: entry.item.sourceRefs,
    rationale: entry.item.rationale,
    actionContract: entry.item.actionContract,
    scoreAssumptionKeys: entry.item.scoreAssumptionKeys,
  }));
}

/** Tallies per-category counts (every category key always present). */
export function tallyCategoryCounts(
  items: readonly AttentionItem[],
): AttentionCategoryCounts {
  const counts = {} as Record<AttentionCategory, number>;
  for (const category of ATTENTION_CATEGORIES) counts[category] = 0;
  for (const item of items) counts[item.category] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The per-client derivations + the agency aggregate
// ---------------------------------------------------------------------------

/** All client-scoped attention candidates for one client's rows (pure). */
function deriveClientItems(client: ClientScopeRows): RawItem[] {
  return [
    ...deriveBlockedWorkItems(client),
    ...deriveAnomalyItems(client),
    ...deriveClientRiskItems(client),
    ...deriveScopeLeakageItems(client),
    ...deriveMarginPressureItems(client),
    ...deriveOpportunityItems(client),
  ];
}

/**
 * Derives the FULL agency attention candidate set: every client-scoped
 * candidate over the agency's clients + the agency-scope approvals and
 * capacity constraint. (Unranked — feed to rankAttentionItems.)
 */
export function deriveAgencyAttentionItems(snapshot: AgencyScopeSnapshot): readonly RawItem[] {
  const items: RawItem[] = [];
  for (const client of snapshot.clients) {
    items.push(...deriveClientItems(client));
  }
  items.push(...deriveApprovalItems(snapshot.undecidedPolicyDecisions, null));
  items.push(
    ...deriveCapacityConstraintItem(
      snapshot.agencyId,
      snapshot.humanAgentProfiles,
      snapshot.capacityJobs,
    ),
  );
  return items;
}

// ---------------------------------------------------------------------------
// The ranking disclosure (AC-3/AC-6: versioned, assumption-explicit)
// ---------------------------------------------------------------------------

/**
 * Composes the ranking disclosure carried by every view. The consumed
 * /profit-intelligence calculation version is disclosed verbatim (the
 * consumed figures are never recomputed here — the version travels with
 * them into the item rationale).
 */
export function composeRankingDisclosure(): RankingDisclosure {
  return {
    rankVersion: AI_OPERATOR_RANK_VERSION,
    categoryVocabularyVersion: 'ao-categories-v1',
    assumptions: AI_OPERATOR_ASSUMPTIONS,
    sortRule: ATTENTION_SORT_RULE,
    basis: 'live-derivation-over-canonical-authorities',
    persistence: 'none-derived-read-model',
    consumedProfitIntelligenceVersion: PROFIT_INTELLIGENCE_CALCULATION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Exported type re-exports for the module + tests
// ---------------------------------------------------------------------------

export type { RawItem };
