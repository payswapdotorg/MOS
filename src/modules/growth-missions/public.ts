/**
 * MarketingOS module: /growth-missions
 * Authority: Growth Mission and Objective Model (MKT-053 —
 * spec/effective-backlog-v1.6.md section A; spec/architecture-v1.6.md §1/§2/§3;
 * spec/architecture-lock-v1.6.md rules 16/17/41).
 *
 * MKT-053 implements the durable mission DATA MODEL layer:
 *
 *   - AGENCY-SCOPED durable Growth Mission records that express the outcome
 *     being pursued (architecture-v1.6.md §1: "A Growth Mission expresses
 *     the outcome being pursued. The outcome may be creator-specific or
 *     business/product-specific.");
 *   - the DECLARED OBJECTIVE (the business outcome, VERBATIM), the OBJECTIVE
 *     FAMILY (the frozen architecture-v1.6.md §3 vocabulary), the
 *     product/market context and the current lifecycle state;
 *   - the mission→goal MAPPING: a mission maps to one or more EXISTING Goals
 *     by canonical goal reference through the /goals PUBLIC CONTRACT
 *     (READ-ONLY — the Goal authority remains the canonical measurable
 *     business-intent authority; this module never re-states, re-computes or
 *     owns goal progress);
 *   - the append-only VERSION tail: the declared objective is IMMUTABLE —
 *     corrections are NEW version records, never in-place rewrites (the
 *     /decisions correction-chain discipline);
 *   - the append-only HISTORY tail: every lifecycle state transition is an
 *     append-only history event carrying actor + provenance + reason (the
 *     /experiments transition-history discipline);
 *   - the frozen LIFECYCLE STATE MACHINE of architecture-v1.6.md §2,
 *     including EVERY terminal state — achieved, stopped by user, blocked
 *     pending human action, blocked by unavailable capability, budget/quota
 *     exhausted, policy-constrained, failed after bounded recovery. A
 *     terminal state has NO outgoing transitions: the record NEVER
 *     silently converts a block into success (the honest-state rule).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-053):
 *   - NO Growth Operator, controller, scheduler, timer, loop or replanning
 *     logic of ANY kind (architecture-lock-v1.6.md rule 17: the Growth
 *     Operator is a decision/replanning controller and is MKT-054 — a LATER
 *     Work Item; this module is the durable record contract that later
 *     drives it);
 *   - NO second workflow/execution engine (architecture-lock-v1.6.md rule
 *     16: Growth Mission is a durable orchestration LAYER over existing
 *     Goals/Playbooks/Workflows/Executions/Experiments/Evidence/Learning —
 *     never a replacement authority);
 *   - NO goal mutation of ANY kind: /goals is consumed READ-ONLY through
 *     the structural port below (canonical goal resolution only);
 *   - NO human-amplification dependency (architecture-lock-v1.6.md rule 41:
 *     the autonomous mission path is executable with zero human treatment —
 *     a genuinely mandatory human approval is represented EXPLICITLY as the
 *     terminal 'blocked_pending_human_action' state, never a hidden
 *     dependency);
 *   - NO experiment/evidence/learning re-statement: the mission record
 *     carries goal references and declared target metrics only.
 *
 * The frozen vocabularies are versioned (GROWTH_MISSION_VOCABULARY_VERSION,
 * the am-meter-v1/pi-calc-v1 discipline): a change to ANY family, ANY state
 * or ANY transition is a NEW version string — never silently re-stated.
 *
 * DEPENDENCY POSTURE (the disclosed MKT-053 registration row of
 * spec/module-dependency-matrix.md: /growth-missions ──→ /agencies, /goals):
 * both consumed public contracts arrive through declared narrow STRUCTURAL
 * PORTS (the /experiments ExperimentsClientOwnershipSnapshot precedent) —
 * zero imports of any other module anywhere under src/modules/growth-missions
 * (verified by tools/arch-check and
 * tests/architecture/growth-missions-boundary.test.ts); the real
 * AgenciesModuleApi/GoalsModuleApi instances satisfy the ports structurally
 * at the composition root.
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';

// ---------------------------------------------------------------------------
// The frozen objective-family vocabulary (architecture-v1.6.md §3, verbatim)
// ---------------------------------------------------------------------------

/**
 * The closed objective-family vocabulary of architecture-v1.6.md §3
 * ("Objective families"), VERBATIM: audience_growth, creator_growth,
 * product_marketing, acquisition, lead_generation, revenue,
 * commerce_discovery, hybrid.
 *
 * The family is part of the DECLARED objective (it rides the immutable
 * version records): the TERMINAL decision vocabulary references the declared
 * business objective family — a mission may optimize intermediate metrics,
 * but the terminal decision is evaluated against the declared business
 * objective (architecture-v1.6.md §3; the terminal transition events carry
 * the declared family as their decision basis).
 */
export const GROWTH_MISSION_OBJECTIVE_FAMILIES = [
  'audience_growth',
  'creator_growth',
  'product_marketing',
  'acquisition',
  'lead_generation',
  'revenue',
  'commerce_discovery',
  'hybrid',
] as const;

export type GrowthMissionObjectiveFamily = (typeof GROWTH_MISSION_OBJECTIVE_FAMILIES)[number];

export function isKnownGrowthMissionObjectiveFamily(
  value: string,
): value is GrowthMissionObjectiveFamily {
  return (GROWTH_MISSION_OBJECTIVE_FAMILIES as readonly string[]).includes(value);
}

/**
 * The TERMINAL-DECISION BASIS (architecture-v1.6.md §3: "A mission may
 * optimize intermediate metrics, but the terminal decision is evaluated
 * against the declared business objective."): every terminal transition
 * event cites the mission's declared objective family as its decision
 * basis — never an intermediate metric. This constant ships on every
 * mission view so the rule is disclosed, not implicit.
 */
export const GROWTH_MISSION_TERMINAL_DECISION_BASIS =
  'declared-business-objective-family' as const;

/**
 * The frozen vocabulary version (the am-meter-v1 discipline): the family
 * vocabulary, the state vocabulary, the transition table and the
 * terminal-decision basis below. A change to ANY of them is a NEW version
 * string — the vocabularies are versioned, never silently re-stated.
 */
export const GROWTH_MISSION_VOCABULARY_VERSION = 'gm-vocab-v1' as const;

// ---------------------------------------------------------------------------
// The frozen lifecycle state machine (architecture-v1.6.md §2)
// ---------------------------------------------------------------------------

/**
 * The mission lifecycle state vocabulary. TERMINAL states are exactly the
 * architecture-v1.6.md §2 "Terminal states" list, VERBATIM:
 *   - achieved;
 *   - stopped_by_user              (stopped by user);
 *   - blocked_pending_human_action  (blocked pending human action);
 *   - blocked_by_unavailable_capability (blocked by unavailable capability);
 *   - budget_quota_exhausted        (budget/quota exhausted);
 *   - policy_constrained            (policy-constrained);
 *   - failed_after_bounded_recovery (failed after bounded recovery).
 *
 * The NON-TERMINAL states are the disclosed MKT-053 implementation decision
 * (recorded in docs/implementation/MKT-053.md — the architecture defines no
 * non-terminal mission machine, exactly like the MKT-006 Goal-state
 * precedent):
 *   - draft  — declared, not yet activated (no goal mapping required yet;
 *             activation requires at least one);
 *   - active — being pursued (the autonomous mission path);
 *   - paused — deliberately paused (resumable; the pause/resume verbs the
 *             MKT-054 controller semantics need).
 */
export const GROWTH_MISSION_STATUSES = [
  'draft',
  'active',
  'paused',
  'achieved',
  'stopped_by_user',
  'blocked_pending_human_action',
  'blocked_by_unavailable_capability',
  'budget_quota_exhausted',
  'policy_constrained',
  'failed_after_bounded_recovery',
] as const;

export type GrowthMissionStatus = (typeof GROWTH_MISSION_STATUSES)[number];

export function isKnownGrowthMissionStatus(value: string): value is GrowthMissionStatus {
  return (GROWTH_MISSION_STATUSES as readonly string[]).includes(value);
}

/** The frozen terminal-state list (architecture-v1.6.md §2, verbatim). */
export const GROWTH_MISSION_TERMINAL_STATUSES = [
  'achieved',
  'stopped_by_user',
  'blocked_pending_human_action',
  'blocked_by_unavailable_capability',
  'budget_quota_exhausted',
  'policy_constrained',
  'failed_after_bounded_recovery',
] as const;

export type GrowthMissionTerminalStatus = (typeof GROWTH_MISSION_TERMINAL_STATUSES)[number];

export function isTerminalGrowthMissionStatus(status: GrowthMissionStatus): boolean {
  return (GROWTH_MISSION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * The frozen transition table (the EXPERIMENT_TRANSITION_TABLE discipline):
 *
 *   draft  → active (activation — requires ≥1 mapped goal), stopped_by_user
 *   active → paused, achieved, stopped_by_user, blocked_pending_human_action,
 *            blocked_by_unavailable_capability, budget_quota_exhausted,
 *            policy_constrained, failed_after_bounded_recovery
 *   paused → active (resume), stopped_by_user
 *
 * TERMINAL states have NO outgoing transitions — the honest-state rule
 * (architecture-v1.6.md §2: "The controller never silently converts a block
 * into success."): a blocked/failed/stopped/exhausted/constrained mission
 * can never be moved to 'achieved' by ANY later transition, and 'achieved'
 * is reachable ONLY from 'active' (an evaluation result recorded while the
 * mission is being pursued).
 */
export const GROWTH_MISSION_TRANSITIONS: Readonly<
  Record<GrowthMissionStatus, readonly GrowthMissionStatus[]>
> = {
  draft: ['active', 'stopped_by_user'],
  active: [
    'paused',
    'achieved',
    'stopped_by_user',
    'blocked_pending_human_action',
    'blocked_by_unavailable_capability',
    'budget_quota_exhausted',
    'policy_constrained',
    'failed_after_bounded_recovery',
  ],
  paused: ['active', 'stopped_by_user'],
  achieved: [],
  stopped_by_user: [],
  blocked_pending_human_action: [],
  blocked_by_unavailable_capability: [],
  budget_quota_exhausted: [],
  policy_constrained: [],
  failed_after_bounded_recovery: [],
};

export function isLegalGrowthMissionTransition(
  from: GrowthMissionStatus,
  to: GrowthMissionStatus,
): boolean {
  return GROWTH_MISSION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// The declared content (the immutable version records)
// ---------------------------------------------------------------------------

/** Comparators a target metric may bind to its numeric target (the /goals set). */
export type GrowthMissionMetricComparator = '>=' | '>' | '<=' | '<' | '==';

export const GROWTH_MISSION_METRIC_COMPARATORS: readonly GrowthMissionMetricComparator[] = [
  '>=',
  '>',
  '<=',
  '<',
  '==',
];

/**
 * ONE declared target metric (architecture-v1.6.md §3: "v1.6 adds a Growth
 * Mission layer that maps a mission into one or more existing Goals and
 * target metrics."). `intermediate: true` marks a metric as an INTERMEDIATE
 * metric — a mission may optimize intermediate metrics, but the terminal
 * decision is evaluated against the declared business objective family
 * (never an intermediate metric); the flag makes the distinction durable.
 */
export interface GrowthMissionTargetMetric {
  /** Metric name this target measures (e.g. "qualified_views"). */
  readonly metric: string;
  /** How the observed value must relate to targetValue. */
  readonly comparator: GrowthMissionMetricComparator;
  /** The numeric target. */
  readonly targetValue: number;
  /** Optional unit label (e.g. "USD", "count", "%"). */
  readonly unit: string | null;
  /** Optional human-facing description. */
  readonly description: string | null;
  /** true = intermediate metric (not a terminal-decision basis). */
  readonly intermediate: boolean;
}

/**
 * The declared product context (architecture-v1.6.md §1: a mission's
 * outcome "may be creator-specific or business/product-specific"; §8's
 * Product Context arrives through MKT-069 — this is the mission's own
 * declared snapshot, bounded free-form description only).
 */
export interface GrowthMissionProductContext {
  /** The product name when the mission pursues a business/product outcome. */
  readonly name: string | null;
  /** A public product/site URL when applicable. */
  readonly url: string | null;
  /** Bounded free-form summary of the product context. */
  readonly summary: string | null;
}

/**
 * The declared market context (the audience/geography framing of the
 * outcome being pursued — bounded free-form description only).
 */
export interface GrowthMissionMarketContext {
  /** The declared target audience. */
  readonly audience: string | null;
  /** The declared target geography/market. */
  readonly geography: string | null;
  /** Bounded free-form summary of the market context. */
  readonly summary: string | null;
}

/**
 * The declared mission content — exactly what rides an IMMUTABLE version
 * record. The `objective` is the business outcome being pursued, VERBATIM
 * (architecture-v1.6.md §1); the objective family is the §3 vocabulary.
 */
export interface GrowthMissionDeclaration {
  /** The business outcome being pursued, VERBATIM (immutable per version). */
  readonly objective: string;
  /** The frozen objective family of the declared business outcome. */
  readonly objectiveFamily: GrowthMissionObjectiveFamily;
  /** The declared product context (null when creator/audience-specific). */
  readonly productContext: GrowthMissionProductContext | null;
  /** The declared market context. */
  readonly marketContext: GrowthMissionMarketContext | null;
  /** The declared target metrics (intermediate metrics allowed). */
  readonly targetMetrics: readonly GrowthMissionTargetMetric[];
}

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every mission command (the
 * ExperimentProvenance precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface GrowthMissionProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface GrowthMissionRecordedProvenance extends GrowthMissionProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Records (the migration 045 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted mission record (the durable orchestration record). */
export interface GrowthMissionRecord {
  readonly missionId: string;
  readonly agencyId: string;
  readonly status: GrowthMissionStatus;
  /** The mission's CURRENT declared version (the version-tail pointer). */
  readonly currentVersionSeq: number;
  /** The CAS token (row-locked transitions). */
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One IMMUTABLE version record of the declared content (append-only tail). */
export interface GrowthMissionVersionRecord {
  readonly missionVersionId: string;
  readonly missionId: string;
  readonly versionSeq: number;
  readonly objective: string;
  readonly objectiveFamily: GrowthMissionObjectiveFamily;
  readonly productContext: GrowthMissionProductContext | null;
  readonly marketContext: GrowthMissionMarketContext | null;
  readonly targetMetrics: readonly GrowthMissionTargetMetric[];
  readonly provenance: GrowthMissionRecordedProvenance;
}

/** The closed event-kind vocabulary of the append-only history tail. */
export const GROWTH_MISSION_EVENT_KINDS = [
  'mission_created',
  'version_recorded',
  'goal_mapped',
  'goal_unmapped',
  'state_transition',
] as const;

export type GrowthMissionEventKind = (typeof GROWTH_MISSION_EVENT_KINDS)[number];

/** The kind-specific structured detail of a history event (never prose). */
export type GrowthMissionEventDetail =
  | { readonly kind: 'goal'; readonly goalId: string }
  | { readonly kind: 'version'; readonly versionSeq: number }
  | null;

/**
 * One append-only history event. Every state transition is a
 * 'state_transition' event carrying fromStatus + toStatus + a REQUIRED
 * reason + actor + provenance; terminal transitions additionally carry the
 * DECLARED objective family as their terminal_decision_family (the
 * architecture-v1.6.md §3 terminal-decision basis, made durable).
 */
export interface GrowthMissionEventRecord {
  readonly eventId: string;
  readonly missionId: string;
  /** Gapless per-mission sequence (assigned under the mission row lock). */
  readonly eventSeq: number;
  readonly eventKind: GrowthMissionEventKind;
  readonly fromStatus: GrowthMissionStatus | null;
  readonly toStatus: GrowthMissionStatus | null;
  /** The declared objective family a TERMINAL transition was evaluated against. */
  readonly terminalDecisionFamily: GrowthMissionObjectiveFamily | null;
  /** REQUIRED for state transitions and goal unmappings (the honest record). */
  readonly reason: string | null;
  readonly detail: GrowthMissionEventDetail;
  readonly provenance: GrowthMissionRecordedProvenance;
}

/**
 * One mission→goal mapping row. A mapping is added ONCE and may later be
 * REMOVED (honestly: removed_at/by + a required removal reason — history is
 * never erased); the active fence is UNIQUE (mission, goal) WHERE
 * removed_at IS NULL, so a removed goal can be re-mapped as a NEW row.
 */
export interface GrowthMissionGoalMappingRecord {
  readonly mappingId: string;
  readonly missionId: string;
  /** The CANONICAL goal reference (the /goals public-contract identity). */
  readonly goalId: string;
  readonly addedAt: string;
  readonly addedBy: string;
  readonly removedAt: string | null;
  readonly removedBy: string | null;
  readonly removalReason: string | null;
}

/**
 * One mapped goal as surfaced in the mission read model — the mapping row
 * PLUS the goal's CURRENT status resolved LIVE through the /goals public
 * contract (READ-ONLY). `goalStatus: null` means the goal no longer
 * resolves through canonical ownership (its Client was tombstoned): the
 * removal/deletion surfaces HONESTLY, never silently.
 */
export interface GrowthMissionGoalView extends GrowthMissionGoalMappingRecord {
  /** The goal's live status through the /goals public contract (null = unresolvable). */
  readonly goalStatus: string | null;
  /** The goal's owning client id when canonical ownership resolves. */
  readonly goalClientId: string | null;
}

/**
 * The composed mission read model: the record, the CURRENT declared version,
 * every goal mapping with the live goal status, the complete append-only
 * history (oldest first) and the terminal-decision-basis disclosure. This is
 * the honest read-back surface — objective, version and history in one view.
 */
export interface GrowthMissionDetail {
  readonly mission: GrowthMissionRecord;
  /** The CURRENT declared version (objective verbatim + family + context + metrics). */
  readonly currentVersion: GrowthMissionVersionRecord;
  /** EVERY mapping row (active and honestly removed), live goal status included. */
  readonly goalMappings: readonly GrowthMissionGoalView[];
  /** The complete append-only event tail (oldest first). */
  readonly history: readonly GrowthMissionEventRecord[];
  /** The §3 terminal-decision basis, disclosed on every view (never implicit). */
  readonly terminalDecisionBasis: typeof GROWTH_MISSION_TERMINAL_DECISION_BASIS;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /agencies + /goals
// resolution — the ExperimentsClientOwnershipSnapshot precedent)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /agencies public contract this module
 * consumes: the agency row for the fail-closed agency-scope resolution.
 * The real AgenciesModuleApi satisfies this structurally — /agencies
 * remains the ONLY agency authority; the mission scope is always
 * server-derived.
 */
export interface GrowthMissionAgencySnapshot {
  readonly agencyId: string;
  readonly status: string;
}

export interface GrowthMissionAgencyPort {
  getAgency(agencyId: string): Promise<GrowthMissionAgencySnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /goals CANONICAL public contract this
 * module consumes (READ-ONLY — the mapping target authority): the raw goal
 * row and the canonical goal ownership resolution (goal → owning Client →
 * owning Agency). The real GoalsModuleApi satisfies this structurally —
 * /goals remains the ONLY Goal authority and is NEVER mutated from here.
 */
export interface GrowthMissionGoalSnapshot {
  readonly goalId: string;
  readonly clientId: string;
  readonly status: string;
}

export interface GrowthMissionGoalOwnershipSnapshot {
  readonly scope: {
    readonly agencyId: string;
    readonly clientId: string;
    readonly goalId: string;
  };
  readonly goal: GrowthMissionGoalSnapshot;
}

export interface GrowthMissionGoalPort {
  getGoal(goalId: string): Promise<GrowthMissionGoalSnapshot | null>;
  resolveGoalOwnership(goalId: string): Promise<GrowthMissionGoalOwnershipSnapshot | null>;
}

/** The canonical mission ownership context (the route-layer authorization input). */
export interface GrowthMissionOwnerContext {
  readonly scope: {
    readonly kind: 'growth-mission';
    readonly agencyId: string;
    readonly missionId: string;
  };
  readonly mission: GrowthMissionRecord;
  /** The /agencies row resolved through the agency port. */
  readonly agency: GrowthMissionAgencySnapshot;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface GrowthMissionsModuleApi {
  /**
   * Creates an AGENCY-SCOPED Growth Mission (born 'draft', version 1 of the
   * declared content, one 'mission_created' history event). The agency
   * resolves SERVER-SIDE through the /agencies structural port BEFORE any
   * write: unknown agency → NotFoundError (uniform 404); a disabled agency
   * blocks new use (ConflictError) without rewriting history. The declared
   * objective is stored VERBATIM; the family must be the frozen §3
   * vocabulary; target metrics are optional but structurally validated.
   */
  createGrowthMission(
    input: {
      readonly agencyId: string;
      readonly declaration: GrowthMissionDeclaration;
    },
    provenance: GrowthMissionProvenance,
  ): Promise<GrowthMissionDetail>;

  /** Raw mission record by id (terminal states included). */
  getGrowthMission(missionId: string): Promise<GrowthMissionRecord | null>;

  /**
   * Canonical mission ownership resolution: the mission row + the owning
   * agency row through the /agencies port. Null when the mission does not
   * exist — callers surface the uniform 404 so foreign and unknown
   * identifiers are indistinguishable.
   */
  resolveGrowthMissionOwnership(missionId: string): Promise<GrowthMissionOwnerContext | null>;

  /** The agency's missions in ALL lifecycle states (oldest first). */
  listGrowthMissionsForAgency(agencyId: string): Promise<readonly GrowthMissionRecord[]>;

  /**
   * The composed honest read-back: record + CURRENT declared version + every
   * goal mapping (live goal status through the /goals port, READ-ONLY) +
   * the complete append-only history. Null when unknown.
   */
  getGrowthMissionDetail(missionId: string): Promise<GrowthMissionDetail | null>;

  /** The append-only version tail (oldest first). Null when the mission is unknown. */
  getGrowthMissionVersions(
    missionId: string,
  ): Promise<readonly GrowthMissionVersionRecord[] | null>;

  /** The append-only history tail (oldest first). Null when the mission is unknown. */
  getGrowthMissionHistory(missionId: string): Promise<readonly GrowthMissionEventRecord[] | null>;

  /**
   * Records a NEW declared version (the correction path — the objective is
   * IMMUTABLE per version; corrections are NEW version records, never
   * in-place rewrites). CAS on the mission's `version`
   * (ConflictError on loss); requires a NON-TERMINAL mission (terminal
   * history is frozen — ConflictError) and an ACTIVE agency (new use); the
   * version tail pointer only ever ADVANCES. Appends one
   * 'version_recorded' event.
   */
  recordGrowthMissionVersion(
    input: {
      readonly missionId: string;
      readonly declaration: GrowthMissionDeclaration;
      readonly expectedVersion: number;
    },
    provenance: GrowthMissionProvenance,
  ): Promise<GrowthMissionDetail>;

  /**
   * CAS lifecycle transition guarded by the frozen
   * GROWTH_MISSION_TRANSITIONS table (row-locked transaction): append-only
   * 'state_transition' event with the REQUIRED reason + actor + provenance;
   * a TERMINAL transition cites the declared objective family as its
   * terminal_decision_family (the §3 terminal-decision basis). Transition
   * TO 'active' (activation or resumption) requires an ACTIVE agency and
   * AT LEAST ONE mapped goal (a mission pursues through the Goal authority —
   * ConflictError otherwise); TERMINAL transitions remain available for any
   * non-terminal mission (recording history is never blocked by boundary
   * state). A block is NEVER silently converted into success — terminal
   * states have no outgoing transitions (the DB trigger is the backstop).
   */
  setGrowthMissionStatus(
    input: {
      readonly missionId: string;
      readonly status: GrowthMissionStatus;
      /** The REQUIRED transition reason (bounded, honest). */
      readonly reason: string;
      readonly expectedVersion: number;
    },
    provenance: GrowthMissionProvenance,
  ): Promise<GrowthMissionDetail>;

  /**
   * Maps an EXISTING Goal onto the mission (canonical goal reference
   * through the /goals public contract, READ-ONLY). The goal must resolve
   * through canonical goal ownership AND its owning Client must belong to
   * the mission's agency — unknown, tombstoned-client or CROSS-AGENCY goal
   * references are the uniform 404 (a foreign goal identifier is not a
   * traversal/existence oracle); a dangling reference never persists (the
   * DB FK + scope triggers are the backstops). Requires a NON-TERMINAL
   * mission and an ACTIVE agency; an ALREADY-ACTIVE mapping of the same
   * goal is an honest ConflictError. Appends one 'goal_mapped' event.
   */
  addGrowthMissionGoalMapping(
    input: {
      readonly missionId: string;
      readonly goalId: string;
    },
    provenance: GrowthMissionProvenance,
  ): Promise<GrowthMissionDetail>;

  /**
   * Removes a goal mapping HONESTLY: the mapping row keeps its history and
   * gains removed_at/removed_by + the REQUIRED removal reason (never a
   * DELETE — goal removal surfaces honestly, history is never erased).
   * Requires a NON-TERMINAL mission, an ACTIVE agency and an ACTIVE
   * mapping for the goal (ConflictError otherwise). Appends one
   * 'goal_unmapped' event (with the reason).
   */
  removeGrowthMissionGoalMapping(
    input: {
      readonly missionId: string;
      readonly goalId: string;
      /** The REQUIRED honest removal reason. */
      readonly reason: string;
    },
    provenance: GrowthMissionProvenance,
  ): Promise<GrowthMissionDetail>;
}

export interface GrowthMissionsModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Matrix-listed direction (/growth-missions ──→ /agencies): the agency row authority. */
  readonly agencies: GrowthMissionAgencyPort;
  /** Matrix-listed direction (/growth-missions ──→ /goals): the Goal authority, READ-ONLY. */
  readonly goals: GrowthMissionGoalPort;
}

export { createGrowthMissionsModule } from './internal/growth-missions-module.ts';
/**
 * The input guards (declaration/mapping/provenance validation) and the pure
 * owner-context composer — exported for unit tests and future server-side
 * callers (the MKT-054 controller composes these same commands) so the
 * guard semantics are part of the module contract. Pure functions.
 */
export {
  assertValidGrowthMissionDeclaration,
  assertValidGrowthMissionProvenance,
  assertValidGrowthMissionReason,
  composeGrowthMissionOwnerContext,
} from './internal/growth-missions-store.ts';
