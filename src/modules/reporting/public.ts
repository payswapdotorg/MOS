/**
 * MarketingOS module: /reporting
 * Authority: Read-side reporting (spec/implementation-contract.md §1;
 * spec/architecture.md §25 UI: "The frontend consumes authoritative backend
 * state... The frontend owns presentation only, not workflow, deployment or
 * authorization authority").
 *
 * MKT-001 established this module BOUNDARY; MKT-030 delivers the first route
 * family of the read side: the CLIENT DECISION ROOM read model (UI-001,
 * UI-AC-01..02) — the client-scoped authoritative presentation surface that
 * answers, strictly from the durable state the composed authorities already
 * expose through their public contracts:
 *
 *   - WHAT HAPPENED: the Client's Goal recaps (status, success criteria,
 *     constraints, time horizon — /goals publics) and Workflow instance
 *     states (/workflows publics) — the same authoritative state the Agency
 *     Command Center summarizes (MKT-029), narrowed to THIS Client;
 *   - WHY: the Client's Learning-derived rationale — every Learning with its
 *     applicability conditions, DERIVED state and supersession chain
 *     (/learnings publics); presentation of learnings ONLY, no new inference
 *     authority;
 *   - EVIDENCE QUALITY: the Client's evidence quality posture — the quality
 *     grade distribution per evidence class (/evidence publics);
 *   - EXPERIMENTS: the Client's experiment records with their declared
 *     hypothesis, design, analysis method and RESULTING DECISION — the
 *     /experiments contract's decision field surfaced, never re-derived;
 *   - RECOMMENDATIONS: strictly a presentation of applicable (active)
 *     learnings plus the experiments' declared resulting decisions — the
 *     frozen evidence-and-experimentation contract forbids presenting
 *     attribution as causal lift, so the declared analysis method and design
 *     type are surfaced verbatim and lift is never invented;
 *   - APPROVALS: the pending-approval states the authorities already expose
 *     in durable state — experiments in a non-terminal lifecycle state with
 *     an undecided result (awaiting decision) and workflow instances blocked
 *     or paused (awaiting continuation) — derived reads, never invented.
 *
 * Bounded authority (the frozen rules this module structurally cannot break):
 *
 *   - READ-ONLY: the reporting module owns NO state. This is a PURE
 *     LIVE AGGREGATION over the composed authorities' public contracts —
 *     no projection tables, no cache, nothing to migrate or rebuild. The
 *     dependency matrix line /reporting ──→ /goals, /workflows, /executions,
 *     /evidence, /experiments, /metrics, /learnings is honored with the
 *     five-contract subset this Work Item consumes (/executions and /metrics
 *     stay unused allowed directions — the MKT-029 agency-scoped family may
 *     compose them later through this same public entry);
 *   - NO SECOND AUTHORITY: no state transitions, no authorization decisions,
 *     no workflow/experiment/evidence mutations originate here;
 *     recommendations are presentations of authoritative learnings and
 *     experiment decisions, never new conclusions;
 *   - SCOPE IS SERVER-DERIVED DATA: the route layer resolves the canonical
 *     Client ownership (/clients) and the Client's Workspace enumeration
 *     (/workspaces) — matrix directions /reporting does not hold — and hands
 *     them to this module as already-resolved server-derived inputs (the
 *     /agents and /domain-packs scope-as-data posture). A caller-supplied
 *     identifier is never authorization.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type {
  EvidenceClass,
  EvidenceQualityGrade,
} from '../evidence/public.ts';
import type {
  ExperimentDesignType,
  ExperimentResultState,
  ExperimentStatus,
} from '../experiments/public.ts';
import type {
  GoalConstraint,
  GoalMetric,
  GoalStatus,
  GoalSuccessCriterion,
  GoalTimeHorizon,
  GoalsModuleApi,
} from '../goals/public.ts';
import type {
  LearningApplicabilityValue,
  LearningStatus,
  LearningsModuleApi,
} from '../learnings/public.ts';
import type {
  WorkflowInstanceStatus,
  WorkflowsModuleApi,
} from '../workflows/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';

// ---------------------------------------------------------------------------
// The Client Decision Room view (UI-001 — the read model the frontend consumes)
// ---------------------------------------------------------------------------

/** WHAT HAPPENED — one Goal recap (the authoritative /goals row, presented). */
export interface DecisionRoomGoalRecap {
  readonly goalId: string;
  /** Optional Workspace scope inside the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly metrics: readonly GoalMetric[];
  readonly constraints: readonly GoalConstraint[];
  readonly timeHorizon: GoalTimeHorizon | null;
}

/** WHAT HAPPENED — one Workflow's instance-state recap (read-side summary). */
export interface DecisionRoomWorkflowRecap {
  readonly workflowId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string;
  /** Instance counts per frozen §5 status (every status key present, zeros included). */
  readonly instanceCounts: Readonly<Record<WorkflowInstanceStatus, number>>;
  /** The instances in every lifecycle state (terminal history stays visible), oldest first. */
  readonly instances: readonly DecisionRoomWorkflowInstanceRecap[];
}

/** WHAT HAPPENED — one workflow instance recap. */
export interface DecisionRoomWorkflowInstanceRecap {
  readonly workflowInstanceId: string;
  readonly workflowId: string;
  readonly status: WorkflowInstanceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** WHAT HAPPENED — the Client's goal/workflow recap with status tallies. */
export interface DecisionRoomWhatHappened {
  readonly goals: readonly DecisionRoomGoalRecap[];
  readonly workflows: readonly DecisionRoomWorkflowRecap[];
  /** Goal counts per lifecycle status (every status key present, zeros included). */
  readonly goalStatusCounts: Readonly<Record<GoalStatus, number>>;
  /** Instance counts per frozen §5 status across ALL the Client's workflows. */
  readonly instanceStatusCounts: Readonly<Record<WorkflowInstanceStatus, number>>;
}

/** WHY — one Learning-derived rationale (the authoritative row + DERIVED state). */
export interface DecisionRoomLearningRationale {
  readonly learningId: string;
  readonly workspaceId: string | null;
  readonly statement: string;
  readonly applicability: Readonly<Record<string, LearningApplicabilityValue>>;
  /** The DERIVED /learnings state (active/superseded/contradicted/retired). */
  readonly status: LearningStatus;
  /** The DERIVED successor pointer (null unless superseded) — the supersession chain. */
  readonly supersededBy: string | null;
  readonly confidence: number | null;
  readonly evidenceRefs: readonly string[];
  readonly experimentRefs: readonly string[];
}

/** WHY — the Client's Learning ledger presented with applicability + supersession. */
export interface DecisionRoomWhy {
  readonly learnings: readonly DecisionRoomLearningRationale[];
  /** Learning counts per DERIVED state (every state key present, zeros included). */
  readonly learningStatusCounts: Readonly<Record<LearningStatus, number>>;
}

/** EVIDENCE QUALITY — one evidence class's quality-grade distribution. */
export interface DecisionRoomEvidenceClassPosture {
  readonly class: EvidenceClass;
  /** Record counts per quality grade (every grade key present, zeros included). */
  readonly gradeCounts: Readonly<Record<EvidenceQualityGrade, number>>;
  readonly total: number;
}

/** EVIDENCE QUALITY — the Client's quality posture: grade distribution by class. */
export interface DecisionRoomEvidenceQuality {
  readonly byClass: readonly DecisionRoomEvidenceClassPosture[];
  /** Total records in the aggregated window. */
  readonly totalRecords: number;
}

/** EXPERIMENTS — one experiment recap (declared design + lifecycle + decision). */
export interface DecisionRoomExperimentRecap {
  readonly experimentId: string;
  readonly workspaceId: string | null;
  readonly hypothesis: string;
  /** The decision being informed (the frozen §16 "decision target"). */
  readonly decisionTarget: string;
  readonly status: ExperimentStatus;
  readonly designType: ExperimentDesignType;
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string | null;
  /** Primary metric NAME (identity by name + dimensions — never a provider id). */
  readonly primaryMetricName: string;
  readonly resultState: ExperimentResultState;
  /** The RESULTING DECISION from the /experiments contract — surfaced, never re-derived. */
  readonly resultingDecision: string | null;
  readonly concludedAt: string | null;
}

/** EXPERIMENTS — the Client's experiment ledger with resulting decisions. */
export interface DecisionRoomExperiments {
  readonly experiments: readonly DecisionRoomExperimentRecap[];
  /** Experiment counts per lifecycle status (every status key present, zeros included). */
  readonly experimentStatusCounts: Readonly<Record<ExperimentStatus, number>>;
}

/**
 * RECOMMENDATIONS — one presentation entry. `kind` distinguishes the two —
 * and only two — authoritative sources a recommendation may present: an
 * APPLICABLE (active) Learning, or an experiment's DECLARED resulting
 * decision. The frozen evidence-and-experimentation contract forbids
 * presenting attribution as causal lift: the declared design type and
 * analysis method ride verbatim and no lift number is ever synthesized.
 */
export type DecisionRoomRecommendation =
  | {
      readonly kind: 'applicable_learning';
      readonly learningId: string;
      readonly statement: string;
      readonly applicability: Readonly<Record<string, LearningApplicabilityValue>>;
      readonly confidence: number | null;
    }
  | {
      readonly kind: 'experiment_decision';
      readonly experimentId: string;
      readonly decisionTarget: string;
      readonly resultingDecision: string;
      readonly designType: ExperimentDesignType;
      readonly analysisMethod: string;
      readonly analysisMethodVersion: string | null;
      readonly resultState: ExperimentResultState;
    };

/** RECOMMENDATIONS — the presentation of applicable learnings + experiment decisions. */
export interface DecisionRoomRecommendations {
  readonly items: readonly DecisionRoomRecommendation[];
  /** The honest-capability note the contract requires (never causal lift from attribution). */
  readonly basis: 'applicable_learnings_and_declared_experiment_decisions';
}

/**
 * APPROVALS — one pending-approval entry the authorities already expose in
 * durable state. `kind` distinguishes the two families: an experiment in a
 * NON-TERMINAL lifecycle state whose result is still undecided (awaiting
 * decision), or a workflow instance blocked/paused (awaiting continuation).
 * Derived reads over authoritative state — never invented, never mutated.
 */
export type DecisionRoomApproval =
  | {
      readonly kind: 'experiment_awaiting_decision';
      readonly experimentId: string;
      readonly status: ExperimentStatus;
      readonly decisionTarget: string;
      readonly hypothesis: string;
    }
  | {
      readonly kind: 'workflow_instance_awaiting_continuation';
      readonly workflowInstanceId: string;
      readonly workflowId: string;
      readonly instanceStatus: WorkflowInstanceStatus;
      readonly updatedAt: string;
    };

/** APPROVALS — the Client's pending-approval states from durable state only. */
export interface DecisionRoomApprovals {
  readonly items: readonly DecisionRoomApproval[];
}

/** The full Client Decision Room view — one live aggregation, one response. */
export interface ClientDecisionRoomView {
  /** SERVER-DERIVED scope of the room (resolved by the route from durable ownership). */
  readonly scope: {
    readonly kind: 'client-decision-room';
    readonly clientId: string;
    readonly agencyId: string;
  };
  readonly whatHappened: DecisionRoomWhatHappened;
  readonly why: DecisionRoomWhy;
  readonly evidenceQuality: DecisionRoomEvidenceQuality;
  readonly experiments: DecisionRoomExperiments;
  readonly recommendations: DecisionRoomRecommendations;
  readonly approvals: DecisionRoomApprovals;
  /** Server-stamped generation time (the module clock — a read marker, never data). */
  readonly generatedAt: string;
}

// ---------------------------------------------------------------------------
// Module API — the read-only decision-room surface
// ---------------------------------------------------------------------------

export interface ReportingModuleApi {
  /**
   * THE CLIENT DECISION ROOM (UI-001, UI-AC-01): a PURE LIVE AGGREGATION of
   * the Client's authoritative backend state through the composed
   * authorities' public contracts — /goals, /workflows, /evidence,
   * /experiments and /learnings reads only. Every listed module read
   * resolves canonical Client ownership server-side before traversal (the
   * composed modules' own contract), so an unknown or tombstoned Client
   * surfaces the uniform 404 from the owning authorities.
   *
   * `workspaceIds` is SERVER-DERIVED data resolved by the route layer
   * (canonical /clients ownership + /workspaces enumeration — matrix
   * directions this module does not hold); it selects which Workflow
   * containers get recapped. It is an aggregation input, never an
   * authorization input.
   *
   * READ-ONLY BY CONSTRUCTION: no method on this contract mutates any
   * authority's state (asserted by the static architecture tests); there is
   * no write path, no projection and nothing to rebuild.
   */
  getClientDecisionRoom(input: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly workspaceIds: readonly string[];
  }): Promise<ClientDecisionRoomView>;
}

export interface ReportingModuleDeps {
  readonly clock: Clock;
  /** Frozen matrix: /reporting ──→ /goals, /workflows, /executions, /evidence, /experiments, /metrics, /learnings (this Work Item: /goals, /workflows, /evidence, /experiments, /learnings). */
  readonly goals: GoalsModuleApi;
  readonly workflows: WorkflowsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly experiments: ExperimentsModuleApi;
  readonly learnings: LearningsModuleApi;
}

export { createReportingModule } from './internal/reporting-module.ts';
/**
 * The PURE decision-room derivations (unit-tested; re-exported through the
 * public entry so tests and future read-side emitters compose the exact
 * module semantics): the evidence-quality posture (grade distribution by
 * class), the pending-approval derivation (experiments awaiting decision +
 * blocked/paused workflow instances), the recommendation presentation
 * (applicable learnings + declared experiment decisions only) and the
 * status-tally helpers. Pure functions — the same inputs always compose the
 * same view.
 */
export {
  composeDecisionRoomEvidenceQuality,
  composeDecisionRoomExperiments,
  composeDecisionRoomWhatHappened,
  composeDecisionRoomWhy,
  deriveDecisionRoomApprovals,
  deriveDecisionRoomRecommendations,
  tallyExperimentStatuses,
  tallyGoalStatuses,
  tallyInstanceStatuses,
  tallyLearningStatuses,
} from './internal/decision-room-read-model.ts';
