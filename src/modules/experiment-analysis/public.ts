/**
 * MarketingOS module: /experiment-analysis
 * Authority: Experiment Analysis and Adaptive Allocation (MKT-067).
 *
 * This module is the v1.6 ANALYSIS LAYER over the existing /experiments
 * authority (spec/architecture-v1.6.md §12: "The existing Experiment
 * authority remains responsible for experiment identity/design. v1.6 adds
 * an analysis layer that computes treatment/comparison effects,
 * uncertainty, sample sizes, observation windows, sequential-analysis
 * state, confounders, limitations, practical effect thresholds and
 * recommended next allocation."). The module owns:
 *
 *   - the APPEND-ONLY ANALYSIS RECORDS (migration 054): every analysis is
 *     a durable first-class record carrying the FULL §12 computed set as
 *     DATA — treatment/comparison effects (per-arm means, effect
 *     estimate, standard error), uncertainty (interval with level),
 *     sample sizes (per arm), the observation window consumed, the
 *     sequential-analysis state (interim look, Bonferroni per-look level,
 *     cumulative alpha spent, boundary crossing), confounders and
 *     limitations (declared inputs MERGED with deterministic derived
 *     entries), the practical effect threshold (recorded value + source),
 *     the recommended next allocation, and the EXACT INPUT SNAPSHOT the
 *     computation consumed (the experiment references, the metric
 *     observations consumed with their values and timestamps, the
 *     evidence links, the consumed learnings, the window, the prior
 *     analysis count) with its canonical deterministic digest;
 *   - the APPEND-ONLY ADAPTIVE-ALLOCATION RECOMMENDATIONS (migration 054):
 *     bounded exploration/exploitation over declared strategy-variant arms
 *     (treatment / comparison / strategy_variant / human_treatment kinds)
 *     — the allocator may increase exposure to promising variants while
 *     RETAINING explicit exploration (the exploration floor is RECORDED
 *     DATA with its source, never a hardcoded magic number), stays VALID
 *     at zero capacity on ANY arm including the human-treatment arm (the
 *     human-growth invariant: absence of human capacity never blocks,
 *     crashes or invalidates the non-human allocation), and records its
 *     full deterministic input snapshot + digest so re-running the
 *     allocator on the same inputs reproduces the same decision;
 *   - DETERMINISTIC STATISTICS: the module's frozen matrix row lists NO
 *     /ai-runtime dependency — the entire computation is pure and
 *     versioned ('two_sample_means_v1'), the same inputs always produce
 *     the same outputs, and NO model assistance is used or needed;
 *   - A NEGATIVE OR INCONCLUSIVE RESULT IS A VALID SCIENTIFIC OUTCOME
 *     (§12's closing rule): 'effect_negative', 'effect_negligible',
 *     'inconclusive' and 'insufficient_observations' are first-class
 *     recorded outcome values — preserved verbatim in append-only rows,
 *     never discarded, never rewritten as success, never silently
 *     retried away (a re-analysis is a NEW record; the old one stays).
 *
 * What this module deliberately does NOT do (bounded scope, MKT-067):
 *   - NO second experiment engine: experiment identity, design and
 *     lifecycle remain the SOLE authority of /experiments — this module
 *     only READS experiment records through their public contract and
 *     never creates, mutates or concludes experiments;
 *   - NO direct mutation of experiment exposure, platform state or
 *     workflow inputs: allocation results are RECOMMENDATIONS recorded as
 *     DATA toward the mission/operator layer — the module exposes zero
 *     execution, dispatch, publish or exposure methods (no second
 *     execution engine);
 *   - NO AI/model assistance (deterministic by frozen matrix row); if
 *     model assistance ever appears required, the honest answer is a
 *     disclosure, never an /ai-runtime import;
 *   - NO provider state, no provider SDKs, no external statistics
 *     services — observations are MOS /metric observation records
 *     consumed through the public contract.
 *
 * DEPENDENCY POSTURE (frozen matrix: /experiment-analysis ──→
 * /experiments, /metrics, /evidence, /learnings): all four are consumed
 * READ-ONLY through their public contracts — /experiments for experiment
 * identity/design (resolveExperimentOwnership), /metrics for the
 * observation ledger consumed by the window (listMetricObservationsForClient
 * — bounded, server-chosen limit), /evidence for the canonical same-Client
 * resolution of cited evidence links (getEvidence), /learnings for the
 * recorded confounder/outcome context of learnings citing the experiment
 * (listLearningsForClient). The REQUIRED canonical Client/Workspace
 * ownership resolution ("never caller-supplied") is expressed as
 * STRUCTURAL PORTS declared below — narrow typed views of the /clients and
 * /workspaces public contracts' canonical ownership resolution methods,
 * wired at the composition root (identical posture to /metrics,
 * /experiments and /learnings), so the frozen import matrix stays intact
 * (verified by tools/arch-check and
 * tests/architecture/experiment-analysis-boundary.test.ts).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { EvidenceModuleApi } from '../evidence/public.ts';
import type { ExperimentsModuleApi } from '../experiments/public.ts';
import type { LearningsModuleApi } from '../learnings/public.ts';
import type { MetricsModuleApi } from '../metrics/public.ts';

// ---------------------------------------------------------------------------
// Frozen vocabularies (ea-vocab-v1) — CHECK-fenced in migration 054
// ---------------------------------------------------------------------------

/** The module's frozen vocabulary version (recorded on every row). */
export const EXPERIMENT_ANALYSIS_VOCABULARY_VERSION = 'ea-vocab-v1';

/**
 * The frozen deterministic analysis method this Work Item implements:
 * the two-sample means analysis (per-arm means, Welch standard error,
 * normal-approximation interval, Bonferroni sequential state). Extension
 * is a code + DB migration change, never a caller freedom.
 */
export const EXPERIMENT_ANALYSIS_METHOD = 'two_sample_means_v1';

/** The analysis method version (determinism pin — same inputs, same outputs). */
export const EXPERIMENT_ANALYSIS_METHOD_VERSION = '1.0.0';

/**
 * The frozen ANALYSIS OUTCOME vocabulary (ea-vocab-v1). A NEGATIVE or
 * INCONCLUSIVE result is a first-class value (§12's closing rule):
 *   - effect_positive: the uncertainty interval lies entirely above the
 *     practical threshold (+t);
 *   - effect_negative: the interval lies entirely below −t;
 *   - effect_negligible: the interval is bounded within ±t (a precise
 *     null result — an effect too small to matter practically);
 *   - inconclusive: the interval straddles a boundary (the honest
 *     unknown);
 *   - insufficient_observations: a per-arm sample below the declared
 *     minimum (recorded with the consumed observations — the empty
 *     analysis is still a first-class record).
 */
export const EXPERIMENT_ANALYSIS_OUTCOMES = [
  'effect_positive',
  'effect_negative',
  'effect_negligible',
  'inconclusive',
  'insufficient_observations',
] as const;

export type ExperimentAnalysisOutcome = (typeof EXPERIMENT_ANALYSIS_OUTCOMES)[number];

export function isKnownExperimentAnalysisOutcome(value: string): value is ExperimentAnalysisOutcome {
  return (EXPERIMENT_ANALYSIS_OUTCOMES as readonly string[]).includes(value);
}

/** The outcomes that are NOT a supported positive effect (the honest-negative spine). */
export const NON_POSITIVE_ANALYSIS_OUTCOMES: readonly ExperimentAnalysisOutcome[] = [
  'effect_negative',
  'effect_negligible',
  'inconclusive',
  'insufficient_observations',
];

/**
 * The frozen RECOMMENDED-NEXT-ALLOCATION vocabulary (the §12 two-arm
 * guidance, recorded as DATA): shift exposure toward the treatment or the
 * comparison, hold the balanced exploration, or conclude-and-adopt when
 * the difference is precisely negligible. A recommendation never mutates
 * experiment exposure by itself.
 */
export const RECOMMENDED_ALLOCATION_DIRECTIONS = [
  'shift_toward_treatment',
  'shift_toward_comparison',
  'hold_balanced',
  'conclude_and_adopt',
] as const;

export type RecommendedAllocationDirection = (typeof RECOMMENDED_ALLOCATION_DIRECTIONS)[number];

export function isKnownRecommendedAllocationDirection(
  value: string,
): value is RecommendedAllocationDirection {
  return (RECOMMENDED_ALLOCATION_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * The frozen ARM-KIND vocabulary of the adaptive allocator: the two
 * experiment arms plus strategy variants plus the OPTIONAL
 * human-treatment arm (architecture-lock-v1.6 rule 43: human
 * amplification is an optional experiment treatment — ordinary data
 * here, never a required dependency).
 */
export const EXPERIMENT_ALLOCATION_ARM_KINDS = [
  'treatment',
  'comparison',
  'strategy_variant',
  'human_treatment',
] as const;

export type ExperimentAllocationArmKind = (typeof EXPERIMENT_ALLOCATION_ARM_KINDS)[number];

export function isKnownExperimentAllocationArmKind(
  value: string,
): value is ExperimentAllocationArmKind {
  return (EXPERIMENT_ALLOCATION_ARM_KINDS as readonly string[]).includes(value);
}

/**
 * The exploration-floor SOURCE vocabulary: every recorded recommendation
 * carries its floor AND where it came from — the bounded-exploration
 * guarantee is recorded data, never a hardcoded magic number.
 */
export const EXPLORATION_FLOOR_SOURCES = ['declared_input', 'module_default_v1'] as const;

export type ExplorationFloorSource = (typeof EXPLORATION_FLOOR_SOURCES)[number];

export function isKnownExplorationFloorSource(value: string): value is ExplorationFloorSource {
  return (EXPLORATION_FLOOR_SOURCES as readonly string[]).includes(value);
}

/**
 * The module's recorded default exploration floor: 10% of exposure is
 * always reserved for exploration and distributed equally over the
 * eligible arms. It rides every recommendation row as DATA (value +
 * source 'module_default_v1') — a declared input within (0, 0.5]
 * overrides it and is recorded with source 'declared_input'.
 */
export const EXPERIMENT_ANALYSIS_DEFAULT_EXPLORATION_FLOOR = 0.1;

/**
 * The recorded default minimum per-arm observation count (the
 * insufficient_observations fence). Null input → this default; the
 * RESOLVED value always rides the input snapshot.
 */
export const EXPERIMENT_ANALYSIS_DEFAULT_MIN_OBSERVATIONS_PER_ARM = 30;

/**
 * The recorded default practical effect threshold (any positive effect
 * is practical by default; a declared threshold overrides it and rides
 * the record with source 'declared_input').
 */
export const EXPERIMENT_ANALYSIS_DEFAULT_PRACTICAL_THRESHOLD = 0;

/**
 * The frozen uncertainty levels the two-sample method supports, with the
 * fixed normal quantiles (deterministic — no external statistics
 * dependency; the same constants every time).
 */
export const EXPERIMENT_ANALYSIS_UNCERTAINTY_LEVELS = [0.9, 0.95, 0.99] as const;

export type ExperimentAnalysisUncertaintyLevel =
  (typeof EXPERIMENT_ANALYSIS_UNCERTAINTY_LEVELS)[number];

/** The fixed two-sided z quantiles of the supported levels. */
export const UNCERTAINTY_LEVEL_Z: Readonly<Record<ExperimentAnalysisUncertaintyLevel, number>> = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
};

export function isKnownUncertaintyLevel(value: number): value is ExperimentAnalysisUncertaintyLevel {
  return (EXPERIMENT_ANALYSIS_UNCERTAINTY_LEVELS as readonly number[]).includes(value);
}

/**
 * The recorded default sequential-analysis look budget: the maximum
 * number of interim analyses before the sequential state flags the
 * alpha budget exhausted (Bonferroni over the look budget).
 */
export const EXPERIMENT_ANALYSIS_DEFAULT_MAX_LOOKS = 5;

// ---------------------------------------------------------------------------
// Provenance (server-derived) — the dimension callers can never supply
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance of one analysis/allocation mutation (the
 * MKT-013/014 pattern). Built exclusively by server code from the
 * authenticated principal, the ambient correlation context and the
 * recording system — never from a request body. `recordedAt` is stamped
 * by the module's clock.
 */
export interface ExperimentAnalysisProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording system label: 'api' today; later server-side emitters. */
  readonly recordedVia: string;
  /** Correlation identity of the logical flow that performed the mutation. */
  readonly correlationId: string;
  /** Causation identity (e.g. the job id) when the mutation was worker-caused. */
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only records. */
export interface ExperimentAnalysisRecordedProvenance extends ExperimentAnalysisProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The input snapshot — the exact inputs the computation consumed
// ---------------------------------------------------------------------------

/** The reserved dimension key the analysis splits arms on. */
export const EXPERIMENT_ANALYSIS_ARM_DIMENSION_KEY = 'arm';

/** The arm values the reserved split dimension carries. */
export const EXPERIMENT_ANALYSIS_ARM_VALUES = ['treatment', 'comparison'] as const;

export type ExperimentAnalysisArmValue = (typeof EXPERIMENT_ANALYSIS_ARM_VALUES)[number];

/** One consumed /metrics observation, as it entered the computation. */
export interface ExperimentAnalysisConsumedObservation {
  readonly observationId: string;
  readonly arm: ExperimentAnalysisArmValue;
  readonly value: number;
  readonly observedAt: string;
  readonly unit: string;
  readonly quality: string;
}

/** One consumed /learnings record (the confounder/outcome context). */
export interface ExperimentAnalysisConsumedLearning {
  readonly learningId: string;
  readonly statement: string;
  readonly confidence: number | null;
}

/**
 * The FULL INPUT SNAPSHOT of one analysis (the dispatch's required
 * provenance): everything the computation consumed, canonically ordered —
 * the experiment design fields read through the /experiments public
 * contract, the metric observations consumed through the /metrics public
 * contract (sorted by observation id), the evidence links (sorted), the
 * consumed learnings (sorted by learning id), the window, the prior
 * analysis count (the sequential-analysis state input), the resolved
 * minimum/level/threshold with their defaulted flags, and the declared
 * confounders/limitations. Same snapshot → same digest → same analysis.
 */
export interface ExperimentAnalysisInputSnapshot {
  readonly experiment: {
    readonly experimentId: string;
    readonly clientId: string;
    readonly treatment: string;
    readonly comparison: string;
    readonly primaryMetricName: string;
    readonly primaryMetricDimensions: Readonly<Record<string, string | number | boolean>>;
    readonly expectedDirection: string | null;
    readonly designType: string;
    readonly status: string;
    readonly resultState: string;
  };
  readonly window: {
    /** Inclusive window start over observed_at. */
    readonly start: string;
    /** Exclusive window end over observed_at. */
    readonly end: string;
  };
  readonly observations: readonly ExperimentAnalysisConsumedObservation[];
  readonly evidenceRefs: readonly string[];
  readonly learnings: readonly ExperimentAnalysisConsumedLearning[];
  readonly priorAnalysisCount: number;
  readonly minObservationsPerArm: number;
  readonly minObservationsPerArmDefaulted: boolean;
  readonly uncertaintyLevel: ExperimentAnalysisUncertaintyLevel;
  readonly uncertaintyLevelDefaulted: boolean;
  readonly practicalThreshold: {
    readonly value: number;
    readonly source: string;
    readonly description: string | null;
  };
  readonly declaredConfounders: readonly string[];
  readonly declaredLimitations: readonly string[];
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string;
}

// ---------------------------------------------------------------------------
// Computed payloads (the §12 list as typed data)
// ---------------------------------------------------------------------------

/** The uncertainty payload of the two-sample means analysis. */
export type ExperimentAnalysisUncertainty =
  | {
      readonly kind: 'interval';
      readonly level: number;
      readonly lower: number;
      readonly upper: number;
    }
  | {
      /** An arm with zero observations carries no interval — the honest null. */
      readonly kind: 'none';
      readonly reason: string;
    };

/** The sequential-analysis state (§12), computed from the analysis tail. */
export interface ExperimentSequentialAnalysisState {
  /** This analysis's 1-based interim-look index (prior count + 1). */
  readonly interimIndex: number;
  /** The recorded look budget (Bonferroni family). */
  readonly maxLooks: number;
  /** The per-look interval level: 1 − (1 − level)/maxLooks (Bonferroni). */
  readonly perLookLevel: number;
  /** Cumulative alpha spent across the looks so far, including this one. */
  readonly cumulativeAlphaSpent: number;
  /** Whether the nominal-level effect conclusion would ALSO hold at the per-look level. */
  readonly boundaryCrossed: boolean;
  /** Whether another interim look remains within the recorded budget. */
  readonly continueAllowed: boolean;
  /** The explicit deterministic note (recorded, honest, bounded). */
  readonly note: string;
}

// ---------------------------------------------------------------------------
// Records + inputs
// ---------------------------------------------------------------------------

/** One append-only analysis record (the §12 computed set as durable data). */
export interface ExperimentAnalysisRecord {
  readonly analysisId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The /experiments record this analysis was computed over (read-only anchor). */
  readonly experimentId: string;
  readonly analysisMethod: string;
  readonly analysisMethodVersion: string;
  readonly vocabularyVersion: string;
  readonly observationWindowStart: string;
  readonly observationWindowEnd: string;
  readonly sampleSizes: {
    readonly treatment: number;
    readonly comparison: number;
  };
  readonly treatmentMean: number | null;
  readonly comparisonMean: number | null;
  readonly effectEstimate: number | null;
  readonly standardError: number | null;
  readonly uncertainty: ExperimentAnalysisUncertainty;
  readonly sequentialState: ExperimentSequentialAnalysisState;
  readonly confounders: readonly string[];
  readonly limitations: readonly string[];
  readonly practicalThreshold: {
    readonly value: number;
    readonly source: string;
    readonly description: string | null;
  };
  readonly outcome: ExperimentAnalysisOutcome;
  readonly recommendedNextAllocation: RecommendedAllocationDirection;
  readonly inputSnapshot: ExperimentAnalysisInputSnapshot;
  readonly inputDigest: string;
  readonly evidenceRefs: readonly string[];
  readonly metricObservationRefs: readonly string[];
  readonly learningRefs: readonly string[];
  readonly provenance: ExperimentAnalysisRecordedProvenance;
}

/** Module input for recording one analysis (the computation runs server-side). */
export interface ExperimentAnalysisCreateInput {
  readonly clientId: string;
  /** Optional Workspace scope; resolved canonically, must be inside the Client. */
  readonly workspaceId: string | null;
  /** The /experiments record to analyze (SAME Client, uniform 404 otherwise). */
  readonly experimentId: string;
  /** Inclusive observation-window start (over observed_at). */
  readonly windowStart: string;
  /** Exclusive observation-window end (over observed_at). */
  readonly windowEnd: string;
  /** Interval level: 0.9 | 0.95 | 0.99; null → the recorded default 0.95. */
  readonly uncertaintyLevel: ExperimentAnalysisUncertaintyLevel | null;
  /** Minimum per-arm observations; null → the recorded default. */
  readonly minObservationsPerArm: number | null;
  /** The practical effect threshold (magnitude below which an effect is negligible). */
  readonly practicalThreshold: {
    readonly value: number;
    readonly source: 'declared_input' | 'module_default_v1';
    readonly description: string | null;
  };
  /** Declared confounders (retained verbatim, merged with derived entries). */
  readonly declaredConfounders: readonly string[];
  /** Declared limitations (retained verbatim, merged with derived entries). */
  readonly declaredLimitations: readonly string[];
  /** /evidence records cited by this analysis (SAME Client, uniform 404 otherwise). */
  readonly evidenceRefs: readonly string[];
}

// ---------------------------------------------------------------------------
// Adaptive allocation (§12 "recommended next allocation", Part B)
// ---------------------------------------------------------------------------

/** One declared arm of the adaptive allocator. */
export interface ExperimentAllocationArmInput {
  /** Grammar-fenced arm key: ^[a-z][a-z0-9_-]{0,63}$ (unique per recommendation). */
  readonly armKey: string;
  readonly kind: ExperimentAllocationArmKind;
  /** Observable capacity (integer ≥ 0; 0 = the arm cannot take exposure this cycle). */
  readonly capacity: number;
  /** Observations behind the arm so far (integer ≥ 0). */
  readonly sampleSize: number;
  /** The arm's observed mean effect signal. */
  readonly mean: number;
  /** The arm's observed variance (≥ 0). */
  readonly variance: number;
}

/** The recorded human-arm consideration (the human-growth invariant trail). */
export interface HumanTreatmentConsideration {
  /** Whether a human_treatment arm was declared in this allocation's input. */
  readonly present: boolean;
  /** The declared observable capacity of the human arm (0 when absent). */
  readonly capacity: number;
  /** Whether the human arm was excluded from the allocation (zero capacity or absent). */
  readonly excluded: boolean;
  /** The explicit honest note (recorded, never an absence). */
  readonly note: string;
}

/** The computed bounded exploration/exploitation allocation (deterministic). */
export interface ExperimentAllocationComputed {
  /** The arms that can take exposure this cycle (capacity > 0), sorted by armKey. */
  readonly eligibleArms: readonly string[];
  /** The arms excluded for zero capacity, with kind + the recorded reason. */
  readonly zeroCapacityArms: readonly {
    readonly armKey: string;
    readonly kind: ExperimentAllocationArmKind;
    readonly reason: string;
  }[];
  /** The per-eligible-arm shares (sum to 1; empty when no arm is eligible — the honest all-zero state). */
  readonly shares: Readonly<Record<string, number>>;
  /** The recorded human-arm consideration (never an absence). */
  readonly humanTreatmentConsideration: HumanTreatmentConsideration;
  /** The exploration share actually reserved, distributed equally over the eligible arms. */
  readonly explorationShare: number;
}

/** The FULL INPUT SNAPSHOT of one allocation decision (the reproducibility anchor). */
export interface ExperimentAllocationInputSnapshot {
  readonly experiment: {
    readonly experimentId: string;
    readonly clientId: string;
    readonly status: string;
  };
  readonly analysisId: string | null;
  readonly arms: readonly ExperimentAllocationArmInput[];
  readonly explorationFloor: number;
  readonly explorationFloorSource: string;
  readonly uncertaintyLevel: number;
  readonly strategyVersion: string;
}

/** One append-only allocation recommendation record. */
export interface AllocationRecommendationRecord {
  readonly recommendationId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  readonly experimentId: string;
  /** Optional linkage to the analysis this allocation was derived from (SAME Client + experiment). */
  readonly analysisId: string | null;
  readonly vocabularyVersion: string;
  readonly arms: readonly ExperimentAllocationArmInput[];
  readonly allocation: ExperimentAllocationComputed;
  readonly explorationFloor: number;
  readonly explorationFloorSource: ExplorationFloorSource;
  readonly inputSnapshot: ExperimentAllocationInputSnapshot;
  readonly inputDigest: string;
  readonly rationale: string;
  readonly provenance: ExperimentAnalysisRecordedProvenance;
}

/** Module input for recording one allocation recommendation. */
export interface AllocationRecommendationCreateInput {
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The /experiments record whose strategy variants the allocation is over (SAME Client). */
  readonly experimentId: string;
  /** Optional analysis linkage (SAME Client + experiment, uniform 404 otherwise). */
  readonly analysisId: string | null;
  readonly arms: readonly ExperimentAllocationArmInput[];
  /** Bounded exploration floor; null → the recorded module default (0.1). */
  readonly explorationFloor: number | null;
}

// ---------------------------------------------------------------------------
// Canonical ownership ports (frozen-matrix-compliant /clients + /workspaces
// resolution — the metrics/experiments/learnings posture)
// ---------------------------------------------------------------------------

/**
 * Narrow STRUCTURAL view of the /clients CANONICAL OWNER CONTEXT (the
 * public-contract shape /experiment-analysis consumes). The real
 * ClientOwnerContext satisfies this structurally — /clients remains the
 * ONLY Client ownership authority.
 */
export interface ExperimentAnalysisClientOwnershipSnapshot {
  readonly scope: {
    readonly kind: 'client';
    readonly agencyId: string;
    readonly clientId: string;
  };
  readonly client: {
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /clients public contract /experiment-analysis depends
 * on: canonical server-side Client ownership resolution from durable
 * state. Satisfied structurally by ClientsModuleApi; wired at the
 * composition root.
 */
export interface ClientOwnershipResolutionPort {
  resolveClientOwnership(clientId: string): Promise<ExperimentAnalysisClientOwnershipSnapshot | null>;
}

/**
 * Narrow STRUCTURAL view of the /workspaces canonical ownership
 * resolution. The real WorkspaceOwnerContext satisfies this structurally
 * — /workspaces remains the ONLY Workspace authority.
 */
export interface ExperimentAnalysisWorkspaceOwnershipSnapshot {
  readonly workspace: {
    readonly workspaceId: string;
    readonly clientId: string;
    readonly status: string;
  };
}

/**
 * The slice of the /workspaces public contract /experiment-analysis
 * depends on: canonical server-side Workspace ownership resolution.
 * Satisfied structurally by WorkspacesModuleApi; wired at the composition
 * root.
 */
export interface WorkspaceOwnershipResolutionPort {
  resolveWorkspaceOwnership(
    workspaceId: string,
  ): Promise<ExperimentAnalysisWorkspaceOwnershipSnapshot | null>;
}

// ---------------------------------------------------------------------------
// Canonical owner contexts (implementation-contract §2)
// ---------------------------------------------------------------------------

/**
 * The CANONICAL EXPERIMENT-ANALYSIS OWNER CONTEXT: the single server-side
 * resolution of WHICH Client owns the analysis (and which Agency owns
 * that Client), plus the scoped Workspace ownership snapshot when
 * workspace-scoped — all derived from durable state on every call.
 * The Client is the hard security boundary: a tombstoned (deleted)
 * Client never resolves (null — uniform 404 upstream).
 */
export interface ExperimentAnalysisOwnerContext {
  readonly scope: {
    readonly kind: 'experiment_analysis';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly analysisId: string;
  };
  readonly analysis: ExperimentAnalysisRecord;
  readonly clientOwnership: ExperimentAnalysisClientOwnershipSnapshot;
  readonly workspace: ExperimentAnalysisWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical analysis owner context from an
 * ALREADY-RESOLVED /clients canonical ownership snapshot, the analysis
 * record and (for workspace-scoped records) the /workspaces ownership
 * snapshot. Purity is asserted by unit tests — the same inputs always
 * compose the same context; a caller-supplied agency id appears nowhere
 * in the composition inputs.
 */
export function composeExperimentAnalysisOwnerContext(
  analysis: ExperimentAnalysisRecord,
  clientOwnership: ExperimentAnalysisClientOwnershipSnapshot,
  workspace: ExperimentAnalysisWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): ExperimentAnalysisOwnerContext {
  return {
    scope: {
      kind: 'experiment_analysis',
      agencyId: clientOwnership.scope.agencyId,
      clientId: analysis.clientId,
      workspaceId: analysis.workspaceId,
      analysisId: analysis.analysisId,
    },
    analysis,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

/**
 * The CANONICAL ALLOCATION-RECOMMENDATION OWNER CONTEXT (the same
 * resolution discipline as the analysis owner context).
 */
export interface AllocationRecommendationOwnerContext {
  readonly scope: {
    readonly kind: 'experiment_allocation_recommendation';
    readonly agencyId: string;
    readonly clientId: string;
    readonly workspaceId: string | null;
    readonly recommendationId: string;
  };
  readonly recommendation: AllocationRecommendationRecord;
  readonly clientOwnership: ExperimentAnalysisClientOwnershipSnapshot;
  readonly workspace: ExperimentAnalysisWorkspaceOwnershipSnapshot | null;
  readonly resolvedAt: string;
}

/**
 * Pure composition of the canonical allocation-recommendation owner
 * context (same discipline as the analysis composition).
 */
export function composeAllocationRecommendationOwnerContext(
  recommendation: AllocationRecommendationRecord,
  clientOwnership: ExperimentAnalysisClientOwnershipSnapshot,
  workspace: ExperimentAnalysisWorkspaceOwnershipSnapshot | null,
  resolvedAt: string,
): AllocationRecommendationOwnerContext {
  return {
    scope: {
      kind: 'experiment_allocation_recommendation',
      agencyId: clientOwnership.scope.agencyId,
      clientId: recommendation.clientId,
      workspaceId: recommendation.workspaceId,
      recommendationId: recommendation.recommendationId,
    },
    recommendation,
    clientOwnership,
    workspace,
    resolvedAt,
  };
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ExperimentAnalysisModuleApi {
  /**
   * Records one analysis (the append-only §12 computed set). The module
   * resolves the owning Client canonically THROUGH the /clients public
   * contract BEFORE any write, resolves the experiment THROUGH the
   * /experiments public contract (unknown, foreign or tombstoned-Client
   * → uniform NotFoundError), validates every cited evidence ref through
   * the /evidence public contract (uniform 404), consumes the Client's
   * /metrics observations inside the declared window (name + declared
   * dimensions match, split on the reserved 'arm' dimension), consumes
   * the /learnings citing this experiment, builds the FULL INPUT
   * SNAPSHOT + digest, computes the deterministic two-sample analysis
   * (pure 'two_sample_means_v1') and appends the immutable record.
   *
   * A NEGATIVE, NEGLIGIBLE, INCONCLUSIVE or INSUFFICIENT-OBSERVATIONS
   * result is recorded exactly like a positive one — the record is
   * first-class, never discarded, never rewritten.
   */
  recordExperimentAnalysis(
    input: ExperimentAnalysisCreateInput,
    provenance: ExperimentAnalysisProvenance,
  ): Promise<ExperimentAnalysisRecord>;
  /** Raw record by id — the recorded analyses stay readable forever. */
  getExperimentAnalysis(analysisId: string): Promise<ExperimentAnalysisRecord | null>;
  /**
   * Canonical ownership resolution: the analysis, its owning Client
   * resolved through the /clients public contract, and its scoped
   * Workspace ownership snapshot, composed into the canonical owner
   * context. Null when the analysis does not exist OR its Client is a
   * deleted tombstone — callers surface a uniform 404 so foreign,
   * unknown and orphaned identifiers are indistinguishable.
   */
  resolveExperimentAnalysisOwnership(
    analysisId: string,
  ): Promise<ExperimentAnalysisOwnerContext | null>;
  /**
   * The experiment's analyses, oldest first (the sequential tail). The
   * Client and the experiment anchor are both resolved canonically
   * BEFORE the read — a foreign experiment identifier is not a
   * traversal/existence oracle (uniform 404).
   */
  listExperimentAnalysesForExperiment(
    clientId: string,
    experimentId: string,
  ): Promise<readonly ExperimentAnalysisRecord[]>;
  /** The Client's analyses, newest first (bounded, server-chosen limit). */
  listExperimentAnalysesForClient(clientId: string): Promise<readonly ExperimentAnalysisRecord[]>;
  /**
   * Records one adaptive-allocation recommendation (the append-only §12
   * "recommended next allocation" surface). Resolves the same canonical
   * ownership chain, validates the declared arms (closed kind
   * vocabulary, grammar-fenced unique keys, non-negative capacity/
   * sample/variance), resolves the optional analysis linkage (SAME
   * Client + experiment, uniform 404), builds the allocation input
   * snapshot + digest, computes the DETERMINISTIC bounded
   * exploration/exploitation allocation (pure) and appends the immutable
   * recommendation.
   *
   * ZERO-CAPACITY ARMS (including the human-treatment arm) are excluded
   * and RECORDED with their reason — allocation continues over the
   * remaining arms; absence of human capacity never blocks, crashes or
   * invalidates the non-human allocation. The recommendation is DATA
   * toward the mission/operator layer — the module exposes no method
   * that mutates experiment exposure, platform state or workflow
   * inputs.
   */
  recordAllocationRecommendation(
    input: AllocationRecommendationCreateInput,
    provenance: ExperimentAnalysisProvenance,
  ): Promise<AllocationRecommendationRecord>;
  /** Raw record by id — the recorded recommendations stay readable forever. */
  getAllocationRecommendation(recommendationId: string): Promise<AllocationRecommendationRecord | null>;
  /**
   * Canonical ownership resolution (the same discipline as the analysis
   * owner context; null when unknown OR the owning Client is a deleted
   * tombstone).
   */
  resolveAllocationRecommendationOwnership(
    recommendationId: string,
  ): Promise<AllocationRecommendationOwnerContext | null>;
  /**
   * The experiment's recommendations, oldest first (the Client and
   * the experiment anchor resolved canonically before the read —
   * uniform 404 for foreign identifiers).
   */
  listAllocationRecommendationsForExperiment(
    clientId: string,
    experimentId: string,
  ): Promise<readonly AllocationRecommendationRecord[]>;
}

export interface ExperimentAnalysisModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Frozen matrix: /experiment-analysis ──→ /experiments, /metrics,
   * /evidence, /learnings — all four consumed READ-ONLY through their
   * public contracts (experiment identity/design resolution, the
   * observation ledger, evidence-link validation, the learning context).
   */
  readonly experiments: ExperimentsModuleApi;
  readonly metrics: MetricsModuleApi;
  readonly evidence: EvidenceModuleApi;
  readonly learnings: LearningsModuleApi;
  /**
   * Canonical Client ownership resolution THROUGH the /clients public
   * contract (structural port — the concrete ClientsModuleApi instance is
   * wired at the composition root).
   */
  readonly clients: ClientOwnershipResolutionPort;
  /**
   * Canonical Workspace ownership resolution THROUGH the /workspaces
   * public contract (structural port; wired at the composition root).
   */
  readonly workspaces: WorkspaceOwnershipResolutionPort;
}

export { createExperimentAnalysisModule } from './internal/module.ts';
/**
 * The pure deterministic cores — the two-sample statistics (effects,
 * uncertainty, sequential state, outcome classification, recommended
 * next allocation), the adaptive allocator (bounded
 * exploration/exploitation, zero-capacity validity, reproducibility),
 * the canonical snapshot digests, the observation selection filter and
 * the input/provenance guards — exported for unit tests and future
 * server-side emitters so the determinism semantics are part of the
 * module contract. Pure functions, zero I/O.
 */
export {
  computeTwoArmEffect,
  classifyAnalysisOutcome,
  computeSequentialState,
  recommendedAllocationForOutcome,
  mergeConfounders,
  mergeLimitations,
} from './internal/statistics.ts';
export { computeAdaptiveAllocation } from './internal/allocator.ts';
export {
  computeExperimentAnalysisSnapshotDigest,
  computeAllocationSnapshotDigest,
} from './internal/digest.ts';
export { selectObservationsForAnalysis } from './internal/selection.ts';
export {
  assertValidExperimentAnalysisCreate,
  assertValidAllocationRecommendationCreate,
  assertValidExperimentAnalysisProvenance,
} from './internal/validation.ts';
