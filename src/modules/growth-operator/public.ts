/**
 * MarketingOS module: /growth-operator
 * Authority: Growth Operator (MKT-054 — spec/effective-backlog-v1.6.md
 * section A; spec/architecture-v1.6.md §13; spec/architecture-lock-v1.6.md
 * rule 17; spec/module-dependency-matrix-v1.6.md boundary rules 3, 11, 12).
 *
 * MKT-054 implements the PERSISTENT GOAL-PURSUIT CONTROLLER over the Growth
 * Mission model (MKT-053):
 *
 *   - a per-mission RESTART-SAFE controller (ONE controller per mission)
 *     that selects BOUNDED next experiments/actions and DELEGATES ALL
 *     PHYSICAL WORK to the existing Workflow/Execution authorities
 *     (architecture-v1.6.md §13: "Growth Operator is a persistent
 *     controller, not a workflow engine.");
 *   - the frozen CONTROLLER STATE MACHINE — running / paused /
 *     blocked_pending_human_action (ONLY for genuine rights/policy/
 *     capability gates) / terminal (achieved / exhausted /
 *     terminated_by_policy) — with resume semantics and the full
 *     append-only transition audit trail (migration 050's
 *     growth_operator_events);
 *   - IDEMPOTENT REPLANNING: the same mission state + evidence snapshot →
 *     the same plan (a deterministic, versioned selection over a bounded
 *     strategy space) or a RECORDED deliberate change — replans are
 *     append-only decision records, never silent history rewrites;
 *   - RESTART-SAFETY: on recovery the controller RECONCILES mission state
 *     vs in-flight delegated work (idempotent re-entry; no double-dispatch
 *     of the same plan step — the deterministic plan-step idempotency key
 *     is DB-fenced UNIQUE per mission, and every delegation converges
 *     through the existing authorities' own idempotency fences).
 *
 * THE CARDINAL RULE (architecture-lock-v1.6.md rule 17; AGENTS.md, twice):
 * the Growth Operator is a CONTROLLER, never a second Workflow or Execution
 * engine. It may create/advance mission decisions, select strategies,
 * propose bounded next experiments/actions and REQUEST work — but ALL
 * physical work (workflows, tasks, executions, deployments) flows through
 * the EXISTING /workflows and /executions authorities. This module
 * deliberately contains NO job pickup, NO execution lifecycle, NO sandbox
 * leasing, NO dispatch/queue submit, NO worker pool and NO retry
 * orchestration: delegated executions are created through the /executions
 * public contract (born 'created') and the RUNTIME PLANE (the existing
 * worker/dispatch machinery outside this module) drives them; the operator
 * only OBSERVES their outcomes through the authorities' public read
 * surfaces.
 *
 * HUMAN-GROWTH INVARIANT (frozen, tested — architecture-v1.6.md §21;
 * architecture-lock-v1.6.md rules 43/44/45; matrix rules 11/12): the
 * controller remains FULLY FUNCTIONAL when human budget = 0, when no
 * eligible creator exists, when no offer is accepted, when offers expire or
 * are declined, and when human work is priced outside budget. Zero-human
 * states are NORMAL STRATEGY INPUTS — the operator continues with non-human
 * treatments, reallocates, pauses, or terminates truthfully per mission
 * policy. It NEVER fabricates a human result and NEVER imports a
 * human-marketplace module (no /field-agents, /jobs or human-agent surface
 * exists anywhere in this module — the optional human-amplification arm
 * arrives with the later MKT-076..078 Work Items through the existing Job
 * authority). The ONLY truthful human blocker is a genuine rights/policy/
 * capability gate → the explicit `blocked_pending_human_action` state.
 *
 * Mission-record composition (MKT-053 stays the mission authority): the
 * operator advances the mission's OWN state machine conservatively —
 * running ↔ active, paused ↔ paused, and the terminal recording (achieved /
 * budget_quota_exhausted / policy_constrained, or the honest terminal
 * recording of an unresolved block) — always through the mission module's
 * public setGrowthMissionStatus command with the REQUIRED reason. While
 * the controller WAITS in blocked_pending_human_action the MISSION record
 * stays in its current non-terminal state (the MKT-053 mission machine has
 * no resumable blocked state — its §2 terminal vocabulary records
 * blocked_pending_human_action as TERMINAL; the resumable wait lives HERE,
 * in the controller state, exactly as the MKT-053 runbook disclosed: "the
 * MKT-054 controller semantics need pause/resume" and "a future
 * unblock/resume-after-human-action semantics for MKT-054 would need ...
 * (or successor missions)"). If the controller terminates while blocked,
 * the mission receives the honest terminal blocked_pending_human_action
 * transition.
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row):
 * /growth-operator ──→ /growth-missions, /goals, /playbooks, /deployments,
 * /workflows, /executions, /evidence, /experiments, /learnings,
 * /decisions, /policies, /platform-health. DISCLOSED REGISTRATION SUBSET
 * (the /product-intelligence MKT-069 precedent): /platform-health arrives
 * with MKT-066 (a later Worker B Work Item — not yet merged at this base),
 * so the registered row lists the currently-satisfiable subset and
 * /platform-health joins the row at MKT-066 time; the seam is preserved as
 * the typed GrowthOperatorPlatformHealthPort below (NO import, NO wiring
 * until then). /playbooks and /deployments are matrix-listed allowances the
 * MVP controller loop deliberately does not yet exercise (the MKT-070/072
 * planners compose them) — recorded here, disclosed in the runbook. ALL
 * consumed public contracts arrive through declared narrow STRUCTURAL
 * PORTS (the /notification-delivery MKT-068 convention): every port is a
 * Pick over exactly the consumed methods of the matrix-listed public
 * contract, imported TYPE-ONLY (zero runtime imports exist anywhere under
 * src/modules/growth-operator — proven by tools/arch-check and
 * tests/architecture/growth-operator-boundary.test.ts, which additionally
 * proves every cross-module import is type-only and targets a
 * matrix-listed public entry); the real module instances satisfy the
 * ports structurally at the composition root. The ONE off-matrix port
 * (/workspaces — the pursuit-scope resolution) is hand-declared and
 * satisfied by a composition-root wrapper, exactly the
 * notification-delivery /agencies+/users recipient-resolution precedent.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// The consumed matrix-listed public contracts (TYPE-ONLY — the structural
// ports below are narrow Picks over these; zero runtime imports exist
// anywhere under src/modules/growth-operator).
import type { GrowthMissionsModuleApi } from '../growth-missions/public.ts';
import type { GoalsModuleApi } from '../goals/public.ts';
import type { WorkflowsModuleApi } from '../workflows/public.ts';
import type { ExecutionsModuleApi } from '../executions/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { DecisionsModuleApi } from '../decisions/public.ts';
import type { LearningsModuleApi } from '../learnings/public.ts';
import type { PoliciesModuleApi } from '../policies/public.ts';

// ---------------------------------------------------------------------------
// The frozen controller state machine (MKT-054, verbatim)
// ---------------------------------------------------------------------------

/**
 * The controller lifecycle state vocabulary, VERBATIM from the MKT-054
 * work item: "State machine: running / paused / blocked_pending_human_action
 * (only for genuine rights/policy/capability gates) / terminal (achieved /
 * exhausted / terminated-by-policy), with resume semantics and full
 * transition audit trail."
 */
export const GROWTH_OPERATOR_CONTROLLER_STATUSES = [
  'running',
  'paused',
  'blocked_pending_human_action',
  'achieved',
  'exhausted',
  'terminated_by_policy',
] as const;

export type GrowthOperatorControllerStatus =
  (typeof GROWTH_OPERATOR_CONTROLLER_STATUSES)[number];

export function isKnownGrowthOperatorControllerStatus(
  value: string,
): value is GrowthOperatorControllerStatus {
  return (GROWTH_OPERATOR_CONTROLLER_STATUSES as readonly string[]).includes(value);
}

/** The TERMINAL controller states — no outgoing transitions, ever. */
export const GROWTH_OPERATOR_TERMINAL_STATUSES = [
  'achieved',
  'exhausted',
  'terminated_by_policy',
] as const;

export type GrowthOperatorTerminalStatus =
  (typeof GROWTH_OPERATOR_TERMINAL_STATUSES)[number];

export function isTerminalGrowthOperatorStatus(
  status: GrowthOperatorControllerStatus,
): boolean {
  return (GROWTH_OPERATOR_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The frozen controller transition table:
 *
 *   running → paused, blocked_pending_human_action, achieved, exhausted,
 *             terminated_by_policy
 *   paused  → running (resume), terminated_by_policy
 *   blocked_pending_human_action → running (resume after the human action),
 *             terminated_by_policy
 *   TERMINAL states have NO outgoing transitions — the honest-state rule
 *   (architecture-v1.6.md §2: "The controller never silently converts a
 *   block into success."): a blocked/failed/exhausted/constrained controller
 *   can never be moved to 'achieved' by ANY later transition, and
 *   'achieved' is reachable ONLY from 'running'.
 */
export const GROWTH_OPERATOR_TRANSITIONS: Readonly<
  Record<GrowthOperatorControllerStatus, readonly GrowthOperatorControllerStatus[]>
> = {
  running: [
    'paused',
    'blocked_pending_human_action',
    'achieved',
    'exhausted',
    'terminated_by_policy',
  ],
  paused: ['running', 'terminated_by_policy'],
  blocked_pending_human_action: ['running', 'terminated_by_policy'],
  achieved: [],
  exhausted: [],
  terminated_by_policy: [],
};

export function isLegalGrowthOperatorTransition(
  from: GrowthOperatorControllerStatus,
  to: GrowthOperatorControllerStatus,
): boolean {
  return GROWTH_OPERATOR_TRANSITIONS[from].includes(to);
}

/**
 * The genuine gate kinds that MAY block the controller (the ONLY truthful
 * human blocker — a rights, policy or capability constraint that requires
 * human action; never a marketplace dependency, never a hidden failure).
 */
export const GROWTH_OPERATOR_GATE_KINDS = ['rights', 'policy', 'capability'] as const;

export type GrowthOperatorGateKind = (typeof GROWTH_OPERATOR_GATE_KINDS)[number];

export function isKnownGrowthOperatorGateKind(value: string): value is GrowthOperatorGateKind {
  return (GROWTH_OPERATOR_GATE_KINDS as readonly string[]).includes(value);
}

/**
 * The honest terminal causes the controller may record (the reason the
 * pursuit ended, carried on the terminal event + the mission transition).
 */
export const GROWTH_OPERATOR_TERMINAL_CAUSES = [
  'goal_achieved',
  'delegation_budget_exhausted',
  'mission_already_terminal',
  'no_delegable_treatment',
  'policy_denied_no_alternative',
  'blocked_gate_abandoned',
  'operator_requested_stop',
] as const;

export type GrowthOperatorTerminalCause =
  (typeof GROWTH_OPERATOR_TERMINAL_CAUSES)[number];

export function isKnownGrowthOperatorTerminalCause(
  value: string,
): value is GrowthOperatorTerminalCause {
  return (GROWTH_OPERATOR_TERMINAL_CAUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The frozen vocabularies (versioned — a change is a NEW version string)
// ---------------------------------------------------------------------------

/** The frozen vocabulary version (states, kinds, event shapes). */
export const GROWTH_OPERATOR_VOCABULARY_VERSION = 'go-vocab-v1' as const;

/**
 * The frozen bounded strategy space (architecture-v1.6.md §13: "select ...
 * the next bounded experiment"; the manifest's "boundedExperimentsOnly"):
 * the closed treatment-family set the operator selects from. A change to
 * the set or the scoring is a NEW version string.
 */
export const GROWTH_OPERATOR_STRATEGY_VERSION = 'go-strategy-v1' as const;

/**
 * The bounded treatment-family vocabulary. The first four are the NON-HUMAN
 * families (always delegable through the existing Workflow/Execution
 * authorities). `human_amplification` is the DECLARED OPTIONAL ARM — it is
 * CONSIDERED with its recorded eligibility/budget inputs on every replan
 * (the zero-human state is a recorded strategy input, never an absence) but
 * is NOT DELEGABLE by the MKT-054 controller: authentic human work rides
 * the existing /field-agents + /jobs authorities, which are NOT matrix
 * allowances of this module and arrive with the optional MKT-076..078 Work
 * Items. When the human arm would be preferred but is unavailable,
 * unfunded or not yet delegable, the operator RECORDS the honest
 * non-selection rationale and continues with the best NON-HUMAN family —
 * never a fabricated human result (rules 43/44/45).
 */
export const GROWTH_OPERATOR_TREATMENT_FAMILIES = [
  'owned_channel_publish',
  'content_variant_test',
  'channel_reallocation',
  'measurement_enrichment',
  'human_amplification',
] as const;

export type GrowthOperatorTreatmentFamily =
  (typeof GROWTH_OPERATOR_TREATMENT_FAMILIES)[number];

export function isKnownGrowthOperatorTreatmentFamily(
  value: string,
): value is GrowthOperatorTreatmentFamily {
  return (GROWTH_OPERATOR_TREATMENT_FAMILIES as readonly string[]).includes(value);
}

/**
 * The frozen plan-step lifecycle: planned → dispatched → observed (and
 * planned → superseded for a deliberately replaced plan). 'observed' and
 * 'superseded' are frozen.
 */
export const GROWTH_OPERATOR_PLAN_STEP_STATES = [
  'planned',
  'dispatched',
  'observed',
  'superseded',
] as const;

export type GrowthOperatorPlanStepState = (typeof GROWTH_OPERATOR_PLAN_STEP_STATES)[number];

/** The honest observed-outcome vocabulary (the delegated work's verdict). */
export const GROWTH_OPERATOR_OBSERVED_OUTCOMES = [
  'delegated_work_succeeded',
  'delegated_work_failed',
  'delegated_work_cancelled',
] as const;

export type GrowthOperatorObservedOutcome =
  (typeof GROWTH_OPERATOR_OBSERVED_OUTCOMES)[number];

/**
 * The frozen operator decision-kind vocabulary (the append-only decision
 * tail): controller_initialized / replan / delegation / observation /
 * gate_encountered / state_transition / termination.
 */
export const GROWTH_OPERATOR_DECISION_KINDS = [
  'controller_initialized',
  'replan',
  'delegation',
  'observation',
  'gate_encountered',
  'state_transition',
  'termination',
] as const;

export type GrowthOperatorDecisionKind = (typeof GROWTH_OPERATOR_DECISION_KINDS)[number];

export function isKnownGrowthOperatorDecisionKind(
  value: string,
): value is GrowthOperatorDecisionKind {
  return (GROWTH_OPERATOR_DECISION_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every controller command: built
 * exclusively from the authenticated principal, the ambient correlation
 * context and the recording surface — never from a request body.
 */
export interface GrowthOperatorProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface GrowthOperatorRecordedProvenance extends GrowthOperatorProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 050 storage shapes)
// ---------------------------------------------------------------------------

/** The controller's budget/quota policy (architecture-v1.6.md §17). */
export interface GrowthOperatorBudgetPolicy {
  /**
   * The bounded in-flight delegation concurrency (1..5). The operator
   * never dispatches more than this many unobserved plan steps at once.
   */
  readonly maxInFlightSteps: number;
  /**
   * The total delegation budget for the pursuit (null = unlimited): when
   * the count of dispatched steps reaches this bound and the goal is not
   * achieved, the controller terminates truthfully as 'exhausted' —
   * exhaustion is a truthful reallocate/pause/terminate input, never a
   * fabricated success.
   */
  readonly maxDelegatedSteps: number | null;
  /**
   * The OPTIONAL human-amplification budget — ZERO BY DEFAULT (the
   * zero-human state is the normal default, never an error).
   */
  readonly humanAmplificationBudget: number;
  /**
   * The currently-observable eligible human-treatment capacity — ZERO in
   * the current tree (no human-growth marketplace capability exists at this
   * base; the value is a RUNTIME EVIDENCE input per matrix rule 12, never
   * a platform authority and never a mandatory prerequisite).
   */
  readonly humanAmplificationEligibleCapacity: number;
}

/** One persisted controller record (ONE per mission). */
export interface GrowthOperatorControllerRecord {
  readonly controllerId: string;
  readonly missionId: string;
  readonly agencyId: string;
  /** The pursuit scope: the Client/Workspace the delegated work runs in. */
  readonly pursuitClientId: string;
  readonly pursuitWorkspaceId: string;
  /** The mission's pursuit workflow container (null until first delegation). */
  readonly pursuitWorkflowId: string | null;
  readonly status: GrowthOperatorControllerStatus;
  /** The REQUIRED block context while blocked (else null). */
  readonly blockedReason: string | null;
  readonly blockedGateKind: GrowthOperatorGateKind | null;
  readonly strategyVersion: string;
  readonly vocabularyVersion: string;
  readonly budget: GrowthOperatorBudgetPolicy;
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The recorded human-amplification consideration of one replan. */
export interface GrowthOperatorHumanConsideration {
  /** Whether the human arm was ELIGIBLE for selection on this replan. */
  readonly eligible: boolean;
  /** The human-amplification budget observed at replan time. */
  readonly budget: number;
  /** The eligible human-treatment capacity observed at replan time. */
  readonly eligibleCapacity: number;
  /** The honest reason the human arm was or was not selected. */
  readonly reason: string;
}

/** One persisted plan step (the bounded next experiment/action). */
export interface GrowthOperatorPlanStepRecord {
  readonly stepId: string;
  readonly controllerId: string;
  readonly missionId: string;
  readonly stepSeq: number;
  /** The DETERMINISTIC idempotency key (the no-double-dispatch fence). */
  readonly idempotencyKey: string;
  readonly treatmentFamily: GrowthOperatorTreatmentFamily;
  readonly rationale: string;
  readonly evidenceSnapshotDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly consideredHuman: GrowthOperatorHumanConsideration;
  /** The delegation identity — every ref created through an EXISTING authority. */
  readonly experimentId: string | null;
  readonly decisionId: string | null;
  readonly workflowId: string | null;
  readonly workflowDefinitionId: string | null;
  readonly workflowInstanceId: string | null;
  readonly executionId: string | null;
  readonly observedOutcome: GrowthOperatorObservedOutcome | null;
  readonly observationEvidenceId: string | null;
  readonly observedAt: string | null;
  readonly state: GrowthOperatorPlanStepState;
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One append-only operator decision record. */
export interface GrowthOperatorDecisionRecord {
  readonly decisionId: string;
  readonly controllerId: string;
  readonly missionId: string;
  readonly decisionSeq: number;
  readonly decisionKind: GrowthOperatorDecisionKind;
  readonly treatmentFamily: GrowthOperatorTreatmentFamily | null;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
  /** The kind-specific structured detail (never prose-only). */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly provenance: GrowthOperatorRecordedProvenance;
}

/** One append-only controller state-transition event. */
export interface GrowthOperatorEventRecord {
  readonly eventId: string;
  readonly controllerId: string;
  readonly missionId: string;
  readonly eventSeq: number;
  readonly fromStatus: GrowthOperatorControllerStatus | null;
  readonly toStatus: GrowthOperatorControllerStatus;
  readonly terminalCause: GrowthOperatorTerminalCause | null;
  readonly blockedGateKind: GrowthOperatorGateKind | null;
  readonly reason: string;
  readonly provenance: GrowthOperatorRecordedProvenance;
}

// ---------------------------------------------------------------------------
// The composed controller view (the honest read-back surface)
// ---------------------------------------------------------------------------

/**
 * The composed controller read-back: the controller record, the CURRENT
 * mission record (through the mission port — MKT-053 stays the authority),
 * the plan-step tail and the decision tail. This is what the later
 * MKT-070/072 planners and MKT-074 console consume.
 */
export interface GrowthOperatorControllerDetail {
  readonly controller: GrowthOperatorControllerRecord;
  /** The mission's live record through the /growth-missions port (READ-ONLY). */
  readonly mission: {
    readonly missionId: string;
    readonly status: string;
    readonly currentVersionSeq: number;
  };
  /** The plan-step tail, oldest first. */
  readonly planSteps: readonly GrowthOperatorPlanStepRecord[];
  /** The append-only decision tail, oldest first. */
  readonly decisions: readonly GrowthOperatorDecisionRecord[];
  /** The append-only state-transition audit trail, oldest first. */
  readonly events: readonly GrowthOperatorEventRecord[];
}

// ---------------------------------------------------------------------------
// The tick outcome (what one pursueMission cycle did, honestly)
// ---------------------------------------------------------------------------

/** What one reconcile observation recorded about a delegated step. */
export interface GrowthOperatorReconciledStep {
  readonly stepId: string;
  readonly outcome: GrowthOperatorObservedOutcome | null;
  readonly observationEvidenceId: string | null;
}

/** What one pursuit tick did — the honest, auditable summary. */
export interface GrowthOperatorTickOutcome {
  readonly controller: GrowthOperatorControllerRecord;
  /** The in-flight steps reconciled to outcomes on this tick. */
  readonly reconciledSteps: readonly GrowthOperatorReconciledStep[];
  /** The newly delegated step, if this tick planned + dispatched one. */
  readonly dispatchedStep: GrowthOperatorPlanStepRecord | null;
  /** True when the controller entered a terminal state on this tick. */
  readonly terminated: boolean;
  /** The decision records appended on this tick, oldest first. */
  readonly decisions: readonly GrowthOperatorDecisionRecord[];
  /** The controller events appended on this tick, oldest first. */
  readonly events: readonly GrowthOperatorEventRecord[];
}

// ---------------------------------------------------------------------------
// Structural ports (the MKT-068 notification-delivery convention: narrow
// TYPE-ONLY views over the matrix-listed public contracts — every port is a
// Pick of exactly the consumed methods, so compatibility with the real
// module instances is compiler-verified at the composition root; ZERO
// runtime imports exist anywhere under src/modules/growth-operator. The
// ONE off-matrix port — /workspaces, the pursuit-scope resolution — is
// hand-declared and satisfied by a composition-root wrapper, exactly the
// notification-delivery /agencies+/users recipient-resolution precedent.)
// ---------------------------------------------------------------------------


/**
 * Narrow STRUCTURAL view of the /growth-missions public contract the
 * controller consumes: the mission record + the composed detail (the live
 * goal views + the CURRENT declared version included) + the public
 * transition command. The real GrowthMissionsModuleApi satisfies this
 * structurally — the mission authority stays sole; the operator advances
 * mission state ONLY through the same public command routes and API
 * callers use.
 */
export type GrowthOperatorMissionPort = Pick<
  GrowthMissionsModuleApi,
  'getGrowthMission' | 'getGrowthMissionDetail' | 'setGrowthMissionStatus'
>;

/**
 * Narrow STRUCTURAL view of the /goals public contract the controller
 * consumes (READ-ONLY): the goal rows + canonical ownership resolution
 * (goal → client → agency). The Goal authority remains the canonical
 * measurable business-intent authority — the operator never re-states,
 * re-computes or owns goal progress.
 */
export type GrowthOperatorGoalPort = Pick<
  GoalsModuleApi,
  'getGoal' | 'resolveGoalOwnership'
>;

/**
 * The PURSUIT-SCOPE port (off-matrix structural wiring — the MKT-068
 * /notification-delivery recipient-resolution precedent): the canonical
 * workspace ownership chain (workspace → client → agency), READ-ONLY,
 * satisfied at the composition root by a wrapper over the REAL
 * /workspaces resolveWorkspaceOwnership. /workspaces is not a listed
 * allowance of the frozen v1.6 /growth-operator row, but the
 * pursuit-scope validation requires the canonical chain (disclosed in the
 * matrix authority notes and the runbook); the workspace is never mutated.
 */
export interface GrowthOperatorWorkspacePort {
  resolveWorkspace(workspaceId: string): Promise<
    | {
        readonly workspaceId: string;
        readonly clientId: string;
        readonly agencyId: string;
        readonly status: string;
      }
    | null
  >;
}

/**
 * Narrow STRUCTURAL view of the /workflows public contract the controller
 * delegates through (THE DELEGATION AUTHORITY — every physical workflow
 * object is created/transitioned ONLY through these existing public
 * commands; the operator never implements its own workflow machinery).
 */
export type GrowthOperatorWorkflowPort = Pick<
  WorkflowsModuleApi,
  | 'createWorkflow'
  | 'listWorkflowsForWorkspace'
  | 'createWorkflowDefinition'
  | 'getWorkflowDefinition'
  | 'listWorkflowDefinitions'
  | 'setWorkflowDefinitionStatus'
  | 'createWorkflowInstance'
  | 'getWorkflowInstance'
  | 'listWorkflowInstances'
  | 'transitionWorkflowInstance'
>;

/**
 * Narrow STRUCTURAL view of the /executions public contract the controller
 * delegates through: CREATE the delegated execution with the §8 logical
 * idempotency key (convergent) + READ it back. The execution lifecycle
 * belongs to /executions and the runtime plane — this port deliberately
 * exposes NO transition/mutation method at all, so the operator
 * structurally cannot own execution lifecycle.
 */
export type GrowthOperatorExecutionPort = Pick<
  ExecutionsModuleApi,
  'createExecution' | 'getExecution'
>;

/**
 * Narrow STRUCTURAL view of the /experiments public contract the
 * controller consumes: the bounded next experiment is DECLARED through the
 * existing Experiment authority (identity/design stay its own; the
 * operator only proposes) and the client's experiment tail serves the
 * crash-window convergence search (the step-tagged hypothesis).
 */
export type GrowthOperatorExperimentPort = Pick<
  ExperimentsModuleApi,
  'createExperiment' | 'listExperimentsForClient'
>;

/**
 * Narrow STRUCTURAL view of the /evidence public contract the controller
 * consumes: the operator's own OBSERVATION records are appended through
 * the existing Evidence authority, and the client's evidence tail is the
 * listed READ surface the snapshot digest covers.
 */
export type GrowthOperatorEvidencePort = Pick<
  EvidenceModuleApi,
  'appendEvidence' | 'listEvidenceForClient'
>;

/**
 * Narrow STRUCTURAL view of the /decisions public contract the controller
 * consumes: the operator's strategic replan decisions land in the CANONICAL
 * Decision Ledger (createDecision through the public contract) with the
 * operator's own tail as the controller-local index.
 */
export type GrowthOperatorDecisionLedgerPort = Pick<
  DecisionsModuleApi,
  'createDecision'
>;

/**
 * Narrow STRUCTURAL view of the /learnings public contract the controller
 * consumes (READ-ONLY): the learnings inform the strategy selection as
 * evidence references; the Learning authority stays sole.
 */
export type GrowthOperatorLearningPort = Pick<
  LearningsModuleApi,
  'listLearningsForClient'
>;

/**
 * Narrow STRUCTURAL view of the /policies public contract the controller
 * consumes: the fail-closed delegation gate (every gate decision recorded
 * in the policy engine's own ledger).
 */
export type GrowthOperatorPolicyPort = Pick<
  PoliciesModuleApi,
  'evaluateAction'
>;

/**
 * THE DELEGATION GATE (the rights/policy/capability seam): evaluated
 * BEFORE every delegation. The DEFAULT composition-root implementation
 * composes the REAL /policies engine (dimension 'tools', operation
 * 'growth-operator.delegate'): an explicit policy ALLOW gates the
 * delegation through; an explicit DENY is a genuine human-declared
 * governance boundary → 'deny_pending_human_action' (gateKind 'policy',
 * the policy decision cited); an UNDECIDED evaluation fails closed as
 * 'deny' (the treatment is skipped — only an explicit allow permits). The
 * /content-rights authority (MKT-063, Worker B's parallel delivery)
 * becomes the real RIGHTS gate when it lands: it composes into this same
 * port (gateKind 'rights').
 */
export interface GrowthOperatorDelegationGatePort {
  evaluateDelegation(
    input: {
      readonly missionId: string;
      readonly treatmentFamily: GrowthOperatorTreatmentFamily;
      readonly actionSummary: string;
      readonly agencyId: string;
      readonly clientId: string;
    },
    provenance: GrowthOperatorProvenance,
  ): Promise<{
    readonly outcome: 'allow' | 'deny' | 'deny_pending_human_action';
    readonly gateKind: GrowthOperatorGateKind | null;
    readonly reason: string;
    readonly policyDecisionRef: string | null;
  }>;
}

/**
 * THE PLATFORM-HEALTH SEAM (MKT-066 — a future Worker B Work Item, NOT
 * merged at this base): the typed port the controller will consume for
 * observable distribution-anomaly signals once /platform-health exists.
 * NO import, NO wiring until then — the seam is preserved here exactly as
 * the /product-intelligence MKT-069 precedent preserved /research, and the
 * registered matrix row joins /platform-health at MKT-066 time.
 */
export interface GrowthOperatorPlatformHealthPort {
  getDistributionHealth(
    input: { readonly clientId: string; readonly missionId: string },
  ): Promise<{
    readonly state: string;
    readonly reasonCodes: readonly string[];
  }>;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface GrowthOperatorModuleApi {
  /**
   * Initializes the persistent controller for a mission (ONE per mission —
   * ConflictError when one already exists; uniform NotFoundError when the
   * mission does not).
   *
   * The mission must be NON-TERMINAL (a terminal mission's history is
   * frozen — no new pursuit starts on it) and must have at least one
   * ACTIVE goal mapping (the measurable anchor — the mission authority
   * itself enforces this on activation, and the controller requires it
   * before any pursuit).
   *
   * The PURSUIT SCOPE: the Client/Workspace the delegated work runs in.
   * `pursuitWorkspaceId` is resolved through the /workspaces structural
   * port (canonical ownership: unknown/tombstoned → the uniform 404;
   * disabled → ConflictError — new use is blocked without rewriting
   * history) and must belong to the MISSION'S AGENCY (a workspace of
   * another agency is indistinguishable from an unknown one — the uniform
   * 404, never a cross-tenant existence oracle). `pursuitClientId` is
   * server-derived from that chain, never caller-supplied.
   *
   * The controller is born 'running' and the mission is ACTIVATED through
   * the mission authority's own command (draft → active, or resumed from
   * paused) — the first append-only event is the initialization record.
   */
  initializeController(
    input: {
      readonly missionId: string;
      readonly pursuitWorkspaceId: string;
      readonly budget?: Partial<GrowthOperatorBudgetPolicy>;
    },
    provenance: GrowthOperatorProvenance,
  ): Promise<GrowthOperatorControllerDetail>;

  /**
   * THE PURSUIT TICK — the persistent goal-pursuit cycle (idempotent;
   * safe to call repeatedly, concurrently and after any restart):
   *
   *   1. TERMINAL controller → the honest no-op outcome (nothing runs
   *      after a terminal state — the audit trail is the record).
   *   2. PAUSED controller → the honest paused outcome (no work while
   *      deliberately paused).
   *   3. BLOCKED controller → the honest blocked outcome (the human
   *      action is still pending; the outcome carries the block context).
   *   4. RECONCILE (restart-safety): every 'dispatched' step's delegated
   *      work is read through the EXISTING authorities' public read
   *      surfaces; terminal delegated work is OBSERVED (an evidence
   *      record through /evidence citing the workflow instance +
   *      execution, the step moves to 'observed', an observation decision
   *      is appended); still-running work stays in flight. In-flight
   *      'planned' steps (a crash window) are driven to completion
   *      convergently (idempotency keys at every authority — no
   *      double-dispatch). A mission that became terminal out-of-band is
   *      reconciled into the controller's own terminal recording.
   *   5. REPLAN (only when no step remains in flight, bounded by
   *      maxInFlightSteps): the achievement check runs first (all mapped
   *      goals achieved → terminal 'achieved'); then the bounded
   *      next-experiment/action is selected (deterministic, versioned,
   *      evidence-referenced, budget/quota-aware, human-amplification
   *      considered-and-optional), gated (deny_pending_human_action →
   *      blocked; deny → next family; none → terminated_by_policy) and
   *      DELEGATED through the existing Workflow/Execution authorities.
   *
   * Returns the honest tick outcome (reconciled observations, the
   * dispatched step, terminal flag, the decisions/events appended).
   */
  pursueMission(
    input: { readonly missionId: string },
    provenance: GrowthOperatorProvenance,
  ): Promise<GrowthOperatorTickOutcome>;

  /**
   * PAUSE the running controller (the deliberate stop): the controller →
   * 'paused' and the mission record → 'paused' through the mission
   * authority's own command (REQUIRED reason). In-flight delegated work is
   * NOT cancelled (the existing authorities own those lifecycles; the next
   * tick after resume observes them honestly).
   */
  pauseController(
    input: {
      readonly missionId: string;
      readonly reason: string;
      readonly expectedVersion: number;
    },
    provenance: GrowthOperatorProvenance,
  ): Promise<GrowthOperatorControllerDetail>;

  /**
   * RESUME the paused or blocked controller: the controller → 'running'
   * and the mission record → 'active' through the mission authority's own
   * command (REQUIRED reason). Resuming a blocked controller requires the
   * human-action resolution to be recorded in the reason (the honest
   * unblock); the block context clears.
   */
  resumeController(
    input: {
      readonly missionId: string;
      readonly reason: string;
      readonly expectedVersion: number;
    },
    provenance: GrowthOperatorProvenance,
  ): Promise<GrowthOperatorControllerDetail>;

  /**
   * TERMINATE the controller by policy (the honest stop): the controller →
   * 'terminated_by_policy' with the REQUIRED honest terminal cause, and
   * the mission record receives the corresponding TERMINAL transition
   * through the mission authority's own command — 'policy_constrained' by
   * default, or the honest alternative recording when the cause is the
   * abandoned block ('blocked_pending_human_action'), the missing
   * capability ('blocked_by_unavailable_capability') or the bounded-
   * recovery failure ('failed_after_bounded_recovery'). A terminal
   * controller/mission rejects everything (ConflictError).
   */
  terminateControllerByPolicy(
    input: {
      readonly missionId: string;
      readonly terminalCause: GrowthOperatorTerminalCause;
      readonly missionTerminalStatus:
        | 'policy_constrained'
        | 'blocked_pending_human_action'
        | 'blocked_by_unavailable_capability'
        | 'failed_after_bounded_recovery';
      readonly reason: string;
      readonly expectedVersion: number;
    },
    provenance: GrowthOperatorProvenance,
  ): Promise<GrowthOperatorControllerDetail>;

  /** The controller of a mission (null when none was initialized). */
  getController(missionId: string): Promise<GrowthOperatorControllerRecord | null>;

  /** The composed honest read-back (controller + mission + tails). Null when no controller exists. */
  getControllerDetail(missionId: string): Promise<GrowthOperatorControllerDetail | null>;

  /** The append-only decision tail of a mission's controller (oldest first). */
  listControllerDecisions(
    missionId: string,
  ): Promise<readonly GrowthOperatorDecisionRecord[] | null>;

  /** The append-only state-transition audit trail (oldest first). */
  listControllerEvents(
    missionId: string,
  ): Promise<readonly GrowthOperatorEventRecord[] | null>;

  /** The plan-step tail of a mission's controller (oldest first). */
  listControllerPlanSteps(
    missionId: string,
  ): Promise<readonly GrowthOperatorPlanStepRecord[] | null>;
}

export interface GrowthOperatorModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Matrix-listed direction: the mission authority (MKT-053) — composed, never duplicated. */
  readonly missions: GrowthOperatorMissionPort;
  /** Matrix-listed direction: the Goal authority, READ-ONLY (the measurable anchor). */
  readonly goals: GrowthOperatorGoalPort;
  /** DISCLOSED off-matrix structural port (the MKT-068 precedent): the pursuit-scope resolution. */
  readonly workspaces: GrowthOperatorWorkspacePort;
  /** Matrix-listed direction: the DELEGATION authority (all physical workflow work). */
  readonly workflows: GrowthOperatorWorkflowPort;
  /** Matrix-listed direction: the DELEGATION authority (execution identity + §8 idempotency). */
  readonly executions: GrowthOperatorExecutionPort;
  /** Matrix-listed direction: the Experiment authority (the bounded next experiment). */
  readonly experiments: GrowthOperatorExperimentPort;
  /** Matrix-listed direction: the Evidence authority (the operator's observations). */
  readonly evidence: GrowthOperatorEvidencePort;
  /** Matrix-listed direction: the Decision Ledger (the operator's strategic decisions). */
  readonly decisions: GrowthOperatorDecisionLedgerPort;
  /** Matrix-listed direction: the Learning authority, READ-ONLY. */
  readonly learnings: GrowthOperatorLearningPort;
  /** Matrix-listed direction: the policy engine (the fail-closed delegation gate). */
  readonly policies: GrowthOperatorPolicyPort;
  /**
   * The delegation gate (the rights/policy/capability seam). Defaults to
   * the /policies-composing implementation when absent.
   */
  readonly delegationGate?: GrowthOperatorDelegationGatePort | undefined;
}

export { createGrowthOperatorModule } from './internal/growth-operator-module.ts';
/**
 * The pure strategy-space selection + the evidence-snapshot digest +
 * the input guards — exported for unit tests and future server-side
 * callers (the MKT-070/072 planners compose the same selection) so the
 * strategy semantics are part of the module contract. Pure functions.
 */
export {
  computeEvidenceSnapshotDigest,
  selectNextTreatment,
  GROWTH_OPERATOR_DEFAULT_BUDGET,
} from './internal/strategy-space.ts';
export {
  assertValidGrowthOperatorProvenance,
  assertValidGrowthOperatorReason,
} from './internal/growth-operator-store.ts';
