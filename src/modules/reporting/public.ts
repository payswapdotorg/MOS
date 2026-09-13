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
 * MKT-029 adds the second route family of the SAME read side: the AGENCY
 * COMMAND CENTER read model (UI-001, UI-AC-01..02) — the agency-scoped
 * sibling that answers, strictly from the durable state the SAME composed
 * authorities already expose through their public contracts:
 *
 *   - PORTFOLIO GOALS: every Goal of the agency's LIVE clients (all
 *     lifecycle states, client-attributed, with agency-wide and per-client
 *     tallies — /goals publics);
 *   - WORKFLOW STATE: every Workflow container of the agency's clients'
 *     Workspaces with its instances in every §5 state, client-attributed,
 *     agency-wide and per-client tallies (/workflows publics);
 *   - EVIDENCE QUALITY: the agency's quality posture — the quality-grade
 *     distribution per class across the portfolio plus the low-grade
 *     (D/E/F) signal (/evidence publics);
 *   - RISKS: a PRESENTATION of the risk-relevant signals durable state
 *     already exposes — the goal-DECLARED risk constraints (kind 'risk',
 *     /goals publics), FAILED executions and UNRESOLVED executions
 *     ('unknown'/'reconciling' — the frozen v1.2 runtime rule makes these
 *     the canonical pending-reconciliation risk, /executions publics), the
 *     blocked/paused instance counts (/workflows publics) and the low-grade
 *     evidence counts (/evidence publics). NEVER a risk engine, never a
 *     re-assessment: every item is an authoritative row surfaced verbatim;
 *   - PENDING APPROVALS: the MKT-030 derivation semantics at agency scope —
 *     experiments awaiting decision and workflow instances awaiting
 *     continuation across the portfolio, client-attributed for drill-down.
 *
 * Bounded authority (the frozen rules this module structurally cannot break):
 *
 *   - READ-ONLY: the reporting module owns NO state. This is a PURE
 *     LIVE AGGREGATION over the composed authorities' public contracts —
 *     no projection tables, no cache, nothing to migrate or rebuild. The
 *     dependency matrix line /reporting ──→ /goals, /workflows, /executions,
 *     /evidence, /experiments, /metrics, /learnings is honored with the
 *     six-contract subset the two route families consume (MKT-030:
 *     /goals, /workflows, /evidence, /experiments, /learnings; MKT-029
 *     adds the /executions direction for the risk posture — /metrics
 *     stays an unused allowed direction);
 *   - NO SECOND AUTHORITY: no state transitions, no authorization decisions,
 *     no workflow/experiment/evidence mutations originate here;
 *     recommendations are presentations of authoritative learnings and
 *     experiment decisions, never new conclusions;
 *   - SCOPE IS SERVER-DERIVED DATA: the route layer resolves the canonical
 *     Client ownership (/clients) and the Client's Workspace enumeration
 *     (/workspaces) — matrix directions /reporting does not hold — and hands
 *     them to this module as already-resolved server-derived inputs (the
 *     /agents and /domain-packs scope-as-data posture). The MKT-029 agency
 *     family follows the same posture one level up: the route resolves the
 *     agency's LIVE client listing (/clients) and each client's Workspace
 *     enumeration (/workspaces) AFTER authorizing the agency principal
 *     against durable membership state, and hands the resolved scope as
 *     data. A caller-supplied identifier is never authorization.
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
import type { ExecutionsModuleApi } from '../executions/public.ts';
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
// The Agency Command Center view (MKT-029 — UI-001, the agency-scoped
// sibling of the Client Decision Room: portfolio goals, workflow state,
// evidence quality, risks and pending approvals over authoritative
// backend state — the SAME read-only live-aggregation posture)
// ---------------------------------------------------------------------------

/**
 * One CLIENT scope entry of the agency portfolio — SERVER-DERIVED data the
 * route layer resolves from durable state (/clients live-client listing +
 * /workspaces enumeration, matrix directions this module does not hold) and
 * hands to this module as aggregation input. A caller-supplied identifier is
 * never authorization (§23); the entries only SELECT which authorized scope
 * gets aggregated.
 */
export interface AgencyCommandCenterClientScope {
  readonly clientId: string;
  readonly workspaceIds: readonly string[];
}

/** PORTFOLIO GOALS — one Goal recap at agency scope (client-attributed). */
export interface CommandCenterGoalRecap {
  readonly goalId: string;
  /** The Client of the agency portfolio this goal belongs to. */
  readonly clientId: string;
  /** Optional Workspace scope inside the owning Client (null = client-wide). */
  readonly workspaceId: string | null;
  readonly objective: string;
  readonly status: GoalStatus;
  readonly successCriteria: readonly GoalSuccessCriterion[];
  readonly metrics: readonly GoalMetric[];
  /** ALL declared constraints (the goal-declared RISK constraints surface verbatim in the risks section too). */
  readonly constraints: readonly GoalConstraint[];
  readonly timeHorizon: GoalTimeHorizon | null;
}

/** PORTFOLIO GOALS — one Client's drill-down tally. */
export interface CommandCenterClientGoalTally {
  readonly clientId: string;
  readonly total: number;
  readonly goalStatusCounts: Readonly<Record<GoalStatus, number>>;
}

/** PORTFOLIO GOALS — the agency-wide portfolio with per-client drill-down. */
export interface CommandCenterPortfolioGoals {
  readonly goals: readonly CommandCenterGoalRecap[];
  /** Agency-wide goal counts per lifecycle status (every status key present, zeros included). */
  readonly goalStatusCounts: Readonly<Record<GoalStatus, number>>;
  readonly perClient: readonly CommandCenterClientGoalTally[];
}

/** WORKFLOW STATE — one Workflow instance recap at agency scope. */
export interface CommandCenterWorkflowInstanceRecap {
  readonly workflowInstanceId: string;
  readonly workflowId: string;
  readonly status: WorkflowInstanceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** WORKFLOW STATE — one Workflow container recap (client-attributed). */
export interface CommandCenterWorkflowRecap {
  readonly workflowId: string;
  readonly workspaceId: string;
  /** The owning Client of the agency portfolio (server-derived attribution). */
  readonly clientId: string;
  readonly name: string;
  readonly description: string;
  /** Instance counts per frozen §5 status (every status key present, zeros included). */
  readonly instanceCounts: Readonly<Record<WorkflowInstanceStatus, number>>;
  /** The instances in every lifecycle state (terminal history stays visible), oldest first. */
  readonly instances: readonly CommandCenterWorkflowInstanceRecap[];
}

/** WORKFLOW STATE — one Client's drill-down tally. */
export interface CommandCenterClientInstanceTally {
  readonly clientId: string;
  readonly total: number;
  readonly instanceStatusCounts: Readonly<Record<WorkflowInstanceStatus, number>>;
}

/** WORKFLOW STATE — the agency's workflow containers with per-client drill-down. */
export interface CommandCenterWorkflowState {
  readonly workflows: readonly CommandCenterWorkflowRecap[];
  /** Agency-wide instance counts per frozen §5 status (every status key present, zeros included). */
  readonly instanceStatusCounts: Readonly<Record<WorkflowInstanceStatus, number>>;
  readonly perClient: readonly CommandCenterClientInstanceTally[];
}

/** EVIDENCE QUALITY — one evidence class's agency-wide quality-grade distribution. */
export interface CommandCenterEvidenceClassPosture {
  readonly class: EvidenceClass;
  /** Record counts per quality grade (every grade key present, zeros included). */
  readonly gradeCounts: Readonly<Record<EvidenceQualityGrade, number>>;
  readonly total: number;
}

/** EVIDENCE QUALITY — one Client's drill-down posture. */
export interface CommandCenterClientEvidencePosture {
  readonly clientId: string;
  /** Records in the aggregated window (the /evidence authority's bounded listing). */
  readonly totalRecords: number;
  /** LOW-GRADE records (D/E/F) — the evidence-quality risk signal (see risks). */
  readonly lowGradeRecords: number;
}

/** EVIDENCE QUALITY — the agency's quality posture: grade distribution + drill-down. */
export interface CommandCenterEvidenceQuality {
  /** Agency-wide grade distribution by class (zero-record classes omitted). */
  readonly byClass: readonly CommandCenterEvidenceClassPosture[];
  /** Total records in the aggregated window across the portfolio. */
  readonly totalRecords: number;
  /** Agency-wide LOW-GRADE (D/E/F) record count — the evidence-quality risk signal. */
  readonly lowGradeRecords: number;
  readonly perClient: readonly CommandCenterClientEvidencePosture[];
}

/**
 * RISKS — one risk-relevant signal the composed authorities already expose
 * in durable state. `kind` distinguishes the families (a PRESENTATION of
 * authoritative rows — never a risk engine, never a re-assessment):
 *
 *   - `goal_risk_constraint`: a Goal's DECLARED constraint of kind 'risk'
 *     (/goals — architecture.md §7 "risk constraints"), surfaced verbatim;
 *   - `execution_failed`: a terminal FAILED Execution (/executions) — the
 *     authoritative operational failure signal;
 *   - `execution_unresolved`: an Execution in the 'unknown' or 'reconciling'
 *     state — the frozen v1.2 runtime rule ("UNKNOWN execution outcome is
 *     unresolved, never success, and requires reconciliation") makes these
 *     the canonical pending-reconciliation risk.
 */
export type CommandCenterRiskItem =
  | {
      readonly kind: 'goal_risk_constraint';
      readonly goalId: string;
      readonly clientId: string;
      /** The declared risk-constraint description, verbatim. */
      readonly description: string;
    }
  | {
      readonly kind: 'execution_failed';
      readonly executionId: string;
      readonly clientId: string;
      readonly workspaceId: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'execution_unresolved';
      readonly executionId: string;
      readonly clientId: string;
      readonly workspaceId: string;
      /** 'unknown' or 'reconciling' — both require explicit reconciliation. */
      readonly status: 'unknown' | 'reconciling';
      readonly updatedAt: string;
    };

/** RISKS — the glanceable tallies of every risk-relevant signal (full-key instance tallies live in workflowState). */
export interface CommandCenterRiskSummary {
  readonly goalRiskConstraintCount: number;
  readonly blockedInstanceCount: number;
  readonly pausedInstanceCount: number;
  readonly failedExecutionCount: number;
  readonly unknownExecutionCount: number;
  readonly reconcilingExecutionCount: number;
  readonly lowGradeEvidenceRecords: number;
}

/** RISKS — the agency's risk posture from durable state only. */
export interface CommandCenterRisks {
  readonly items: readonly CommandCenterRiskItem[];
  readonly summary: CommandCenterRiskSummary;
  /** The honest derivation disclosure (same posture as the recommendations basis). */
  readonly basis: 'declared_goal_risk_constraints_and_operational_and_evidence_quality_signals';
}

/**
 * PENDING APPROVALS — one pending-approval entry the authorities already
 * expose in durable state (the EXACT MKT-030 derivation semantics, widened
 * with the owning-client attribution the agency portfolio needs): an
 * experiment in a NON-TERMINAL lifecycle state whose result is still
 * undecided (awaiting decision), or a workflow instance blocked/paused
 * (awaiting continuation). Derived reads over authoritative state — never
 * invented, never mutated.
 */
export type CommandCenterApproval =
  | {
      readonly kind: 'experiment_awaiting_decision';
      readonly experimentId: string;
      readonly clientId: string;
      readonly status: ExperimentStatus;
      readonly decisionTarget: string;
      readonly hypothesis: string;
    }
  | {
      readonly kind: 'workflow_instance_awaiting_continuation';
      readonly workflowInstanceId: string;
      readonly workflowId: string;
      readonly clientId: string;
      readonly instanceStatus: WorkflowInstanceStatus;
      readonly updatedAt: string;
    };

/** PENDING APPROVALS — the agency's pending-approval states from durable state only. */
export interface CommandCenterApprovals {
  readonly items: readonly CommandCenterApproval[];
}

/** The full Agency Command Center view — one live aggregation, one response. */
export interface AgencyCommandCenterView {
  /** SERVER-DERIVED scope of the center (resolved by the route from durable ownership). */
  readonly scope: {
    readonly kind: 'agency-command-center';
    readonly agencyId: string;
    /** The LIVE clients of the agency in scope (tombstones excluded by the owning authority's listing). */
    readonly clientCount: number;
  };
  readonly portfolioGoals: CommandCenterPortfolioGoals;
  readonly workflowState: CommandCenterWorkflowState;
  readonly evidenceQuality: CommandCenterEvidenceQuality;
  readonly risks: CommandCenterRisks;
  readonly pendingApprovals: CommandCenterApprovals;
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

  /**
   * THE AGENCY COMMAND CENTER (MKT-029 — UI-001, UI-AC-01): the
   * agency-scoped sibling of the Client Decision Room — a PURE LIVE
   * AGGREGATION of the AGENCY's authorized portfolio state through the
   * composed authorities' public contracts: portfolio goals (/goals),
   * workflow state (/workflows), evidence quality (/evidence), risks
   * (declared goal risk constraints + blocked/paused instance counts +
   * failed/unresolved executions + low-grade evidence counts — a
   * PRESENTATION of authoritative signals, never a risk engine) and pending
   * approvals (the MKT-030 derivation semantics: experiments awaiting
   * decision + workflow instances awaiting continuation, client-attributed).
   *
   * `clients` is SERVER-DERIVED data resolved by the route layer (the
   * /clients live-client listing of the agency + the /workspaces
   * enumeration per client — matrix directions this module does not hold,
   * the decision-room scope-as-data posture). It is an aggregation input,
   * never an authorization input: the ROUTE authorizes the agency principal
   * against durable membership state BEFORE any traversal, so the module
   * only ever sees the already-authorized scope.
   *
   * READ-ONLY BY CONSTRUCTION: no write path, no projection, no cache —
   * every call re-reads the authoritative state live (no staleness
   * shortcuts), and nothing this method returns can be driven back into
   * any authority (UI-AC-02).
   */
  getAgencyCommandCenter(input: {
    readonly agencyId: string;
    readonly clients: readonly AgencyCommandCenterClientScope[];
  }): Promise<AgencyCommandCenterView>;
}

export interface ReportingModuleDeps {
  readonly clock: Clock;
  /** Frozen matrix: /reporting ──→ /goals, /workflows, /executions, /evidence, /experiments, /metrics, /learnings (MKT-030: /goals, /workflows, /evidence, /experiments, /learnings; MKT-029 adds the /executions direction for the risk posture — /metrics stays an unused allowed direction). */
  readonly goals: GoalsModuleApi;
  readonly workflows: WorkflowsModuleApi;
  /** MKT-029: the /executions direction of the frozen matrix line (failed/unresolved executions are the canonical operational-risk signals). */
  readonly executions: ExecutionsModuleApi;
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
/**
 * The PURE Agency Command Center derivations (MKT-029 — unit-tested;
 * re-exported through the public entry so tests and future read-side
 * emitters compose the exact module semantics): the portfolio-goals
 * composition (agency-wide + per-client tallies), the workflow-state
 * composition, the agency evidence-quality posture (grade distribution by
 * class + the low-grade D/E/F risk signal), the risk-signal derivation
 * (declared goal risk constraints + failed/unresolved executions + the
 * operational/evidence tallies) and the agency pending-approval derivation
 * (the MKT-030 semantics, client-attributed). Pure functions — the same
 * inputs always compose the same view.
 */
export {
  composeCommandCenterEvidenceQuality,
  composeCommandCenterPortfolioGoals,
  composeCommandCenterWorkflowState,
  deriveCommandCenterApprovals,
  deriveCommandCenterRisks,
} from './internal/command-center-read-model.ts';
