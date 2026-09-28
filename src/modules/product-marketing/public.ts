/**
 * MarketingOS module: /product-marketing
 * Authority: Product Marketing Mission Planner (MKT-070 —
 * spec/effective-backlog-v1.6.md section E: "choose social platform mix,
 * target metrics, content strategy, attribution and experiment plan for a
 * product-marketing mission. Acceptance: product URL/code context changes
 * the selected platform portfolio and metric plan in auditable,
 * evidence-linked decisions."; the frozen v1.6 matrix row, VERBATIM:
 * /product-marketing → /growth-missions, /product-intelligence,
 * /content-intelligence, /platform-health, /experiment-analysis).
 *
 * MKT-070 implements the DETERMINISTIC, AUDITABLE PLANNING LAYER for a
 * product-marketing Growth Mission:
 *
 *   - every chosen PLATFORM MIX entry, TARGET METRIC, CONTENT-STRATEGY
 *     profile, ATTRIBUTION plan and EXPERIMENT plan is a record carrying
 *     its EVIDENCE BASIS — WHICH product-intelligence inputs/facts/
 *     models/risk flags, research insights, platform-health evaluation
 *     verdicts, experiment-analysis results and content-intelligence
 *     hypotheses produced it — as FK-anchored scope-fenced citation links
 *     (the MKT-066 platform-health evaluation-record discipline);
 *   - the PRODUCT URL/CODE CONTEXT changes the outcome: the deterministic
 *     pure core derives product signals from the cited /product-intelligence
 *     records (a source_repository/source_workspace declared input is the
 *     code-context signal; evidence-backed content-worthy features, market
 *     language, ICP hypotheses, value propositions and commercial metrics
 *     scale the platform portfolio tiers and the metric-plan targets) — a
 *     different product context produces a different (or differently-
 *     scored) platform portfolio + metric plan, with the influencing
 *     records visible in the citation links;
 *   - PLATFORM-MIX decisions respect live platform-health states: the
 *     candidates are the pursuit client's accounts with platform-health
 *     evaluations on record, and a restricted/publishing_blocked/
 *     authorization_blocked account is EXCLUDED — with the health verdict
 *     evaluation cited, never silently; degraded/quota-limited/suspected
 *     states are deprioritized with the verdict cited;
 *   - TARGET METRICS come from the frozen objective-family vocabulary
 *     (the plan is keyed to the mission's declared 'product_marketing'
 *     family) wired to the mission's EXISTING mapped goals BY REFERENCE —
 *     goal ids ride the plan as canonical references and goal progress is
 *     NEVER re-stated or re-computed here (the /goals authority stays
 *     sole; the goal references arrive through the MKT-053 mission read
 *     model, the only /growth-missions consumption);
 *   - the ATTRIBUTION PLAN stays distinct from causality (the v1.6 rule):
 *     the plan declares WHAT will be measured and HOW attribution will be
 *     computed (a closed method vocabulary over attribution-id
 *     propagation) — it never claims causal truth; the
 *     attribution-is-not-causality disclosure ships on every plan view;
 *   - the EXPERIMENT PLAN goes through the EXISTING experiments authority
 *     surface: the plan records the BOUNDED next experiment as DATA (the
 *     hypothesis, the primary metric, the arms, the stop criteria, the
 *     analysis method) for the Growth Operator's bounded-experiment
 *     delegation through /experiments — the planner itself creates NO
 *     experiment, owns NO workflow/execution lifecycle and runs NO
 *     scheduler/timer/loop of any kind (architecture-lock-v1.6.md rule
 *     17; the Growth Operator MKT-054 stays the only bounded delegation
 *     controller);
 *   - APPEND-ONLY DISCIPLINE: plan corrections are NEW versions, never
 *     in-place rewrites; every version carries actor + provenance + a
 *     REQUIRED reason + the deterministic input digest (idempotent
 *     replanning: the same observable world → the same digest → the
 *     honest replay convergence, never a duplicate version).
 *
 * What it is NOT (the bounded scope — the MKT-066 posture):
 *
 *   - NO second mission authority: the mission record, its versions, its
 *     goal mappings and its lifecycle belong to /growth-missions (MKT-053)
 *     — the planner CONSUMES the mission read model and never mutates a
 *     mission;
 *   - NO second workflow/execution engine: no task/job pickup, no
 *     execution lifecycle, no dispatch, no scheduler/timer/loop exists
 *     anywhere in this module (the Growth Operator's bounded role);
 *   - NO provider calls of any kind: no social provider HTTP, no adapter
 *     invocation — the platform mix is composed from the cited
 *     platform-health evaluation records (the descriptive states), never
 *     from live provider traffic (adapters only, and none are called
 *     here);
 *   - NO goal-progress computation, NO experiment creation, NO
 *     distribution dispatch (the 065 authority), NO console surface
 *     (Worker C owns console/**).
 *
 * DEPENDENCY POSTURE (the frozen v1.6 matrix row registered for this Work
 * Item: /product-marketing ──→ /growth-missions, /product-intelligence,
 * /content-intelligence, /platform-health, /experiment-analysis —
 * verbatim, all five consumed READ-ONLY through their public contracts).
 * The MKT-062 research dependency of the Work Item is satisfied through
 * the declared narrow RESEARCH REFERENCE PORT below (the MKT-069
 * disclosure: "the model records are attachable BY REFERENCE from
 * missions later (MKT-070)"; the /research direction is deliberately NOT
 * an import — the port is the off-matrix structural-port wiring the
 * growth-operator /workspaces precedent established, wired READ-ONLY at
 * the composition root and disclosed in the runbook). The same disclosed
 * off-matrix wiring resolves the PURSUIT SCOPE (pursuitWorkspaceId →
 * client → agency, validated against the mission's agency — the Growth
 * Operator's pursuit-scope composition exactly).
 *
 * Cross-module access may only target this public entry (public.ts) —
 * internal/ is unimportable from other modules (enforced by the static
 * architecture checker, tools/arch-check).
 */

import type { Clock } from '../../platform/clock/clock.ts';
import type { Db } from '../../platform/db/contract.ts';
import type { IdGenerator } from '../../platform/ids/ids.ts';
import type { ContentIntelligenceModuleApi } from '../content-intelligence/public.ts';
import type { ExperimentAnalysisModuleApi } from '../experiment-analysis/public.ts';
import type { GrowthMissionsModuleApi } from '../growth-missions/public.ts';
import type { PlatformHealthModuleApi } from '../platform-health/public.ts';
import type { ProductIntelligenceModuleApi } from '../product-intelligence/public.ts';

// ---------------------------------------------------------------------------
// The frozen vocabularies (pm-vocab-v1 — CHECK-fenced in migration 060;
// pinned by unit + boundary tests)
// ---------------------------------------------------------------------------

/**
 * The frozen strategy version of the deterministic planning core: the
 * platform-classification table, the product-signal derivation rules, the
 * scoring constants, the objective-family metric vocabulary and formulas,
 * the content-strategy profiles, the attribution methods and the
 * experiment-plan templates. A change to ANY of them is a NEW version
 * string — the scoring is versioned, never silently re-stated (the
 * GROWTH_OPERATOR_STRATEGY_VERSION discipline).
 */
export const PRODUCT_MARKETING_STRATEGY_VERSION = 'pm-plan-v1' as const;

/**
 * The frozen vocabulary version (the gm-vocab-v1 discipline): the
 * inclusion tiers, the platform classes, the content-strategy profiles,
 * the attribution methods and the metric names. A change to ANY of them is
 * a NEW version string.
 */
export const PRODUCT_MARKETING_VOCABULARY_VERSION = 'pm-vocab-v1' as const;

/**
 * THE PLANNER FAMILY GATE: this planner serves the 'product_marketing'
 * objective family of the frozen MKT-053 §3 vocabulary (VERBATIM from the
 * /growth-missions public contract). A mission of any other family is an
 * honest ConflictError — the planner never re-states another family's
 * metric vocabulary.
 */
export const PRODUCT_MARKETING_PLANNER_FAMILY = 'product_marketing' as const;

/** The closed platform-mix inclusion tier vocabulary. */
export const PRODUCT_MARKETING_INCLUSION_TIERS = [
  'primary',
  'secondary',
  'excluded',
] as const;

export type ProductMarketingInclusionTier = (typeof PRODUCT_MARKETING_INCLUSION_TIERS)[number];

export function isKnownProductMarketingInclusionTier(
  value: string,
): value is ProductMarketingInclusionTier {
  return (PRODUCT_MARKETING_INCLUSION_TIERS as readonly string[]).includes(value);
}

/**
 * THE PLATFORM-CLASS DATA SEAM (pm-platform-classes-v1 — the 055/056
 * platform-knowledge fence): the deterministic classification of platform
 * ids (the 056 adapter keys carried as data by the account records) into
 * content-format classes is COMPOSITION DATA, not module knowledge —
 * platform-specific identifiers live exclusively behind the sanctioned
 * adapter subtrees and the composition root (the MKT-056 AC-3 fence; the
 * adapter-registry precedent: capabilities arrive as DATA wired at the
 * composition root). The module declares the closed class-VALUE
 * vocabulary + this pure classifier; the concrete id→class table is
 * supplied through ProductMarketingModuleDeps.platformClasses and is
 * frozen with the strategy version (pm-plan-v1 covers
 * pm-platform-classes-v1 — a table change is a NEW strategy version).
 * An UNKNOWN platform id classifies 'unknown' with the neutral multiplier
 * and the honest disclosure — never a guess.
 */
/** The closed platform-class vocabulary. */
export const PRODUCT_MARKETING_PLATFORM_CLASS_VALUES = [
  'short_video',
  'long_video',
  'image',
  'text',
  'unknown',
] as const;

export type ProductMarketingPlatformClass =
  (typeof PRODUCT_MARKETING_PLATFORM_CLASS_VALUES)[number];

/** The composition-supplied platform-class table (DATA, never module knowledge). */
export type ProductMarketingPlatformClassTable = Readonly<Record<string, ProductMarketingPlatformClass>>;

export function classifyPlatformForProductMarketing(
  platformId: string,
  classes: ProductMarketingPlatformClassTable,
): ProductMarketingPlatformClass {
  const classified = classes[platformId];
  return classified === undefined ? 'unknown' : classified;
}

/**
 * The closed content-strategy profile vocabulary (pm-content-v1): the
 * deterministic profiles the pure core selects from the product signals.
 */
export const PRODUCT_MARKETING_CONTENT_PROFILES = [
  'broad_reach_visual',
  'technical_authority',
  'conversion_focused',
  'community_narrative',
] as const;

export type ProductMarketingContentProfile =
  (typeof PRODUCT_MARKETING_CONTENT_PROFILES)[number];

export function isKnownProductMarketingContentProfile(
  value: string,
): value is ProductMarketingContentProfile {
  return (PRODUCT_MARKETING_CONTENT_PROFILES as readonly string[]).includes(value);
}

/**
 * The closed attribution-method vocabulary (pm-attribution-v1): HOW
 * attribution will be computed over the propagated attribution ids — a
 * measurement plan, never a causal claim.
 */
export const PRODUCT_MARKETING_ATTRIBUTION_METHODS = [
  'attribution_id_last_touch',
  'attribution_id_first_touch',
  'attribution_id_linear_multi_touch',
] as const;

export type ProductMarketingAttributionMethod =
  (typeof PRODUCT_MARKETING_ATTRIBUTION_METHODS)[number];

export function isKnownProductMarketingAttributionMethod(
  value: string,
): value is ProductMarketingAttributionMethod {
  return (PRODUCT_MARKETING_ATTRIBUTION_METHODS as readonly string[]).includes(value);
}

/**
 * THE ATTRIBUTION-IS-NOT-CAUSALITY DISCLOSURE (the v1.6 rule, on every
 * plan view): the attribution plan declares WHAT will be measured and HOW
 * attribution will be computed — it never claims causal truth (AGENTS.md
 * v1.6 rules: "Attribution is distinct from causality").
 */
export const PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE =
  'the attribution plan declares what will be measured and how attribution will be computed over propagated attribution ids — attribution is distinct from causality and this plan claims no causal truth' as const;

/**
 * The frozen objective-family METRIC vocabulary for the product_marketing
 * family (pm-metrics-v1): the closed metric set the plan targets, wired
 * to the mission's EXISTING mapped goals BY REFERENCE. Terminal-anchored
 * metrics (intermediate: false) are business-outcome metrics; the
 * intermediate metrics are optimization signals only — the terminal
 * decision basis stays the mission's declared business objective family
 * (the MKT-053 terminal-decision-basis discipline).
 */
export const PRODUCT_MARKETING_METRIC_NAMES = [
  'qualified_site_visits',
  'attributable_conversions',
  'engaged_platform_reach',
  'content_engagement_rate',
] as const;

export type ProductMarketingMetricName = (typeof PRODUCT_MARKETING_METRIC_NAMES)[number];

export function isKnownProductMarketingMetricName(
  value: string,
): value is ProductMarketingMetricName {
  return (PRODUCT_MARKETING_METRIC_NAMES as readonly string[]).includes(value);
}

/**
 * THE BOUNDED-EXPERIMENT DISCLOSURE (shipped on every plan view): the
 * experiment plan is DATA toward the Growth Operator, which declares the
 * bounded next experiment through the EXISTING /experiments authority —
 * the planner itself creates no experiment and owns no execution
 * lifecycle (architecture-lock-v1.6.md rule 17).
 */
export const PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE =
  'the experiment plan is recorded data toward the Growth Operator, which declares the bounded next experiment through the existing /experiments authority — this planner creates no experiment and owns no workflow/execution lifecycle' as const;

/**
 * THE EVIDENCE-TIER DISCLOSURE: only EVIDENCE-BACKED /product-intelligence
 * derived models and /research insights INFLUENCE plan decisions (the §7
 * discipline: "Model output is a claim unless backed by evidence" — an
 * unverified record can never be presented as established); unverified
 * records are disclosed as present-but-non-influencing, never silently
 * used.
 */
export const PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE =
  'only evidence-backed derived records influence plan decisions — unverified product-intelligence models and research insights are disclosed as non-influencing and never scored as established facts' as const;

// ---------------------------------------------------------------------------
// Provenance (server-derived — implementation-contract §3)
// ---------------------------------------------------------------------------

/**
 * SERVER-DERIVED provenance for every planner command (the
 * growth-missions precedent): built exclusively from the authenticated
 * principal, the ambient correlation context and the recording surface —
 * never from a request body.
 */
export interface ProductMarketingProvenance {
  /** Server-derived actor label: 'user:<uuid>' | 'service:<label>' | 'worker:<label>'. */
  readonly actor: string;
  /** Server-derived recording surface label ('api' | 'module'). */
  readonly recordedVia: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

/** Provenance block as persisted on the append-only version records. */
export interface ProductMarketingRecordedProvenance extends ProductMarketingProvenance {
  /** Server-stamped recording time (module clock, never caller input). */
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// The pure-core input snapshots (record-derived facts ONLY — there is no
// verdict/plan/claim channel anywhere in these shapes)
// ---------------------------------------------------------------------------

/** The mission snapshot (the MKT-053 read model, consumed READ-ONLY). */
export interface PlannerMissionSnapshot {
  readonly missionId: string;
  readonly agencyId: string;
  readonly status: string;
  readonly versionSeq: number;
  readonly objectiveFamily: string;
  /** The declared objective (bounded excerpt, for rationales only). */
  readonly objectiveExcerpt: string;
  readonly productContext: {
    readonly name: string | null;
    readonly url: string | null;
    readonly summary: string | null;
  } | null;
  readonly marketContext: {
    readonly audience: string | null;
    readonly geography: string | null;
    readonly summary: string | null;
  } | null;
  /** The mission's ACTIVE goal mappings (canonical goal ids BY REFERENCE). */
  readonly goalRefs: readonly {
    readonly goalId: string;
    readonly goalStatus: string | null;
  }[];
}

/** The /product-intelligence context snapshot (the URL/code context). */
export interface PlannerProductContextSnapshot {
  readonly productContextId: string;
  readonly currentVersionSeq: number;
  readonly name: string | null;
  readonly inputs: readonly {
    readonly inputId: string;
    readonly kind: string;
    readonly reference: string;
    readonly authorization: string;
    readonly position: number;
  }[];
  readonly sourceFacts: readonly {
    readonly sourceFactId: string;
    readonly factKind: string;
    readonly content: Readonly<Record<string, unknown>>;
  }[];
  readonly derivedModels: readonly {
    readonly derivedModelId: string;
    readonly derivationKind: string;
    readonly verificationState: string;
    /** The retained source facts backing this model (the citation trail). */
    readonly evidenceSourceFactIds: readonly string[];
  }[];
  readonly riskFlags: readonly {
    readonly riskFlagId: string;
    readonly category: string;
    readonly severity: string;
    /** The retained source facts backing this flag (the citation trail). */
    readonly evidenceSourceFactIds: readonly string[];
  }[];
}

/** The attached /research session snapshot (BY REFERENCE — the MKT-069 seam). */
export interface PlannerResearchSnapshot {
  readonly researchSessionId: string;
  readonly currentVersionSeq: number;
  readonly topic: string | null;
  readonly insights: readonly {
    readonly researchInsightId: string;
    readonly derivationKind: string;
    readonly verificationState: string;
  }[];
}

/** One platform-health evaluation verdict (the MKT-066 descriptive record). */
export interface PlannerHealthEvaluationSnapshot {
  readonly evaluationId: string;
  readonly socialAccountId: string;
  readonly platformId: string;
  readonly workspaceId: string | null;
  readonly state: string;
  readonly confidence: string;
  readonly reasonCodes: readonly string[];
  readonly evaluatedAt: string;
}

/** One /experiment-analysis analysis result (the MKT-067 computed set). */
export interface PlannerExperimentAnalysisSnapshot {
  readonly analysisId: string;
  readonly experimentId: string;
  readonly outcome: string;
  readonly recommendedNextAllocation: string;
  readonly effectEstimate: number | null;
}

/** One /experiment-analysis allocation recommendation. */
export interface PlannerAllocationSnapshot {
  readonly recommendationId: string;
  readonly experimentId: string;
  readonly eligibleArms: readonly string[];
  readonly shares: Readonly<Record<string, number>>;
}

/** One /content-intelligence hypothesis (current, non-superseded only). */
export interface PlannerContentHypothesisSnapshot {
  readonly contentHypothesisId: string;
  readonly hypothesisKind: string;
  readonly researchInsightIds: readonly string[];
}

/**
 * THE PURE-CORE INPUT — the complete record-derived snapshot the
 * deterministic planner consumes. Every field arrives from a durable
 * record of the consumed public contracts; there is NO channel for a
 * caller-declared verdict, score or plan fragment (the fabrication-
 * resistance discipline is STRUCTURAL: the pure core can only cite ids
 * present in this snapshot).
 */
export interface PlannerInput {
  readonly mission: PlannerMissionSnapshot;
  readonly productContext: PlannerProductContextSnapshot;
  readonly research: PlannerResearchSnapshot | null;
  /** The pursuit client's platform-health evaluations (latest per account). */
  readonly healthEvaluations: readonly PlannerHealthEvaluationSnapshot[];
  /** The pursuit client's experiment analyses (newest first, bounded). */
  readonly experimentAnalyses: readonly PlannerExperimentAnalysisSnapshot[];
  /** The latest allocation recommendation per analyzed experiment. */
  readonly allocationRecommendations: readonly PlannerAllocationSnapshot[];
  /** The pursuit client's CURRENT content hypotheses (bounded). */
  readonly contentHypotheses: readonly PlannerContentHypothesisSnapshot[];
}

// ---------------------------------------------------------------------------
// The pure-core output (the composed plan + its complete citation basis)
// ---------------------------------------------------------------------------

/** One typed citation — WHICH record produced a decision. */
export interface PlannerCitation {
  readonly kind:
    | 'product_input'
    | 'product_source_fact'
    | 'product_derived_model'
    | 'product_risk_flag'
    | 'research_insight'
    | 'platform_health_evaluation'
    | 'experiment_analysis'
    | 'allocation_recommendation'
    | 'content_hypothesis';
  readonly refId: string;
}

/** One chosen platform-portfolio entry (the auditable platform-mix row). */
export interface PlannerPlatformPortfolioEntry {
  readonly platformId: string;
  readonly socialAccountId: string;
  /** The cited health verdict evaluation behind the entry. */
  readonly evaluationId: string;
  readonly healthState: string;
  readonly platformClass: ProductMarketingPlatformClass;
  readonly inclusion: ProductMarketingInclusionTier;
  /** The deterministic score (0 for excluded entries). */
  readonly score: number;
  /** The weight share (basis points, an integer 0..10000; sum = 10000). */
  readonly weightShareBps: number;
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** One target-metric entry (the objective-family vocabulary, goal-wired). */
export interface PlannerMetricPlanEntry {
  readonly metric: ProductMarketingMetricName;
  readonly comparator: '>=';
  readonly targetValue: number;
  readonly unit: 'count' | 'percent';
  /** true = intermediate optimization signal (never a terminal-decision basis). */
  readonly intermediate: boolean;
  /** The mission's EXISTING mapped goal ids BY REFERENCE (never progress). */
  readonly goalRefs: readonly string[];
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** The content-strategy profile selection. */
export interface PlannerContentStrategy {
  readonly profile: ProductMarketingContentProfile;
  readonly pillars: readonly string[];
  readonly formatPriorities: readonly string[];
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** The attribution plan (what will be measured + how it will be computed). */
export interface PlannerAttributionPlan {
  readonly method: ProductMarketingAttributionMethod;
  readonly measuredSurfaces: readonly {
    readonly surface: string;
    readonly description: string;
  }[];
  readonly disclosure: typeof PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE;
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** The bounded experiment plan (DATA toward the Growth Operator). */
export interface PlannerExperimentPlan {
  readonly hypothesis: string;
  readonly primaryMetric: ProductMarketingMetricName;
  readonly treatmentArm: string;
  readonly comparisonArm: string;
  readonly assignmentMethod: string;
  readonly analysisMethod: string;
  readonly stopCriteria: string;
  readonly boundedBy: 'growth-operator';
  readonly disclosure: typeof PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE;
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** One auditable decision entry of the plan. */
export interface PlannerDecisionEntry {
  readonly decisionKey: string;
  readonly summary: string;
  readonly rationale: string;
  readonly citations: readonly PlannerCitation[];
}

/** The composed plan (the complete deterministic output). */
export interface ComposedProductMarketingPlan {
  readonly strategyVersion: typeof PRODUCT_MARKETING_STRATEGY_VERSION;
  readonly inputDigest: string;
  readonly platformPortfolio: readonly PlannerPlatformPortfolioEntry[];
  readonly metricPlan: readonly PlannerMetricPlanEntry[];
  readonly contentStrategy: PlannerContentStrategy;
  readonly attributionPlan: PlannerAttributionPlan;
  readonly experimentPlan: PlannerExperimentPlan;
  readonly decisions: readonly PlannerDecisionEntry[];
  /** The deduplicated full citation set (the FK-anchored basis). */
  readonly citations: readonly PlannerCitation[];
}

// ---------------------------------------------------------------------------
// Records (the migration 060 storage shapes)
// ---------------------------------------------------------------------------

/** One persisted plan header (ONE plan per mission; the version-tail pointer). */
export interface ProductMarketingPlanRecord {
  readonly planId: string;
  readonly missionId: string;
  readonly agencyId: string;
  readonly clientId: string;
  readonly workspaceId: string | null;
  /** The plan's CURRENT version (the version-tail pointer). */
  readonly currentVersionSeq: number;
  /** The CAS token (row-locked version advance). */
  readonly version: number;
  readonly createdActor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One IMMUTABLE plan version record (the append-only tail). */
export interface ProductMarketingPlanVersionRecord {
  readonly planVersionId: string;
  readonly planId: string;
  readonly versionSeq: number;
  readonly productContextId: string;
  readonly productContextVersionId: string;
  readonly researchSessionId: string | null;
  /** The REQUIRED reason every version carries (actor + provenance + reason). */
  readonly reason: string;
  readonly inputSnapshot: Readonly<Record<string, unknown>>;
  readonly inputDigest: string;
  readonly platformPortfolio: readonly PlannerPlatformPortfolioEntry[];
  readonly metricPlan: readonly PlannerMetricPlanEntry[];
  readonly contentStrategy: PlannerContentStrategy;
  readonly attributionPlan: PlannerAttributionPlan;
  readonly experimentPlan: PlannerExperimentPlan;
  readonly decisions: readonly PlannerDecisionEntry[];
  readonly strategyVersion: typeof PRODUCT_MARKETING_STRATEGY_VERSION;
  readonly provenance: ProductMarketingRecordedProvenance;
  readonly createdAt: string;
}

/**
 * The composed plan read model: the header, the CURRENT version, the
 * complete append-only version tail and the CURRENT version's typed
 * citation links (the FK-anchored evidence basis) — the honest read-back
 * surface.
 */
export interface ProductMarketingPlanDetail {
  readonly plan: ProductMarketingPlanRecord;
  readonly currentVersion: ProductMarketingPlanVersionRecord;
  readonly versions: readonly ProductMarketingPlanVersionRecord[];
  readonly citations: readonly PlannerCitation[];
  /** The attribution-is-not-causality disclosure, on every view. */
  readonly attributionDisclosure: typeof PRODUCT_MARKETING_ATTRIBUTION_DISCLOSURE;
  /** The bounded-experiment disclosure, on every view. */
  readonly experimentDisclosure: typeof PRODUCT_MARKETING_EXPERIMENT_DISCLOSURE;
  /** The evidence-tier disclosure, on every view. */
  readonly evidenceTierDisclosure: typeof PRODUCT_MARKETING_EVIDENCE_TIER_DISCLOSURE;
}

// ---------------------------------------------------------------------------
// Structural ports (the /growth-missions precedent: narrow declared READ
// surfaces; the real module instances satisfy them structurally at the
// composition root)
// ---------------------------------------------------------------------------

/**
 * The narrow /research READ surface this module consumes through the
 * declared RESEARCH REFERENCE PORT (the MKT-069 disclosure: missions
 * attach research sessions/insights BY REFERENCE — the /research
 * direction is not a frozen import of this row, so the port is the
 * disclosed off-matrix structural-port wiring the growth-operator
 * /workspaces precedent established; READ-ONLY, wired at the composition
 * root).
 */
export interface ProductMarketingResearchReferencePort {
  /** Canonical research-session ownership resolution (null when unknown). */
  resolveResearchSessionOwnership(
    researchSessionId: string,
  ): Promise<{
    readonly scope: { readonly agencyId: string; readonly researchSessionId: string };
    readonly session: { readonly researchSessionId: string; readonly currentVersionSeq: number };
  } | null>;
  /** The composed session read-back (the insights with evidence links). */
  getResearchSessionDetail(
    researchSessionId: string,
  ): Promise<{
    readonly session: { readonly researchSessionId: string; readonly currentVersionSeq: number };
    readonly currentVersion: { readonly topic: string | null };
    readonly insights: readonly {
      readonly researchInsightId: string;
      readonly derivationKind: string;
      readonly verificationState: string;
      readonly supersededByResearchInsightId: string | null;
    }[];
  } | null>;
}

/**
 * The narrow /workspaces READ surface this module consumes through the
 * PURSUIT-SCOPE PORT (the Growth Operator's off-matrix composition
 * exactly — the MKT-068 precedent: the canonical workspace→client→agency
 * chain validates the pursuit scope; the workspace is never mutated).
 */
export interface ProductMarketingWorkspacePort {
  resolveWorkspace(workspaceId: string): Promise<{
    readonly workspaceId: string;
    readonly clientId: string;
    readonly agencyId: string;
    readonly status: string;
  } | null>;
}

/**
 * The canonical plan owner context (the route-layer authorization input):
 * the plan header resolved to its owning agency through the mission
 * anchor (the mission authority's own ownership chain — /agencies is not
 * an allowance of this module's row; the route layer resolves it).
 */
export interface ProductMarketingPlanOwnerContext {
  readonly scope: {
    readonly kind: 'product_marketing_plan';
    readonly agencyId: string;
    readonly missionId: string;
    readonly planId: string;
  };
  readonly plan: ProductMarketingPlanRecord;
  readonly resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Module API
// ---------------------------------------------------------------------------

export interface ProductMarketingModuleApi {
  /**
   * COMPOSES (or convergently replays) the product-marketing plan for a
   * mission — the deterministic, auditable planning command:
   *
   *   1. resolves the mission through the /growth-missions public contract
   *      (READ-ONLY — the mission authority stays sole): unknown mission →
   *      the uniform 404; a TERMINAL mission is an honest ConflictError
   *      (terminal history is frozen — no new planning on it); a mission
   *      whose declared objective family is NOT 'product_marketing' is an
   *      honest ConflictError (this planner is family-scoped);
   *   2. resolves the cited /product-intelligence Product Context through
   *      its public contract (READ-ONLY): unknown context → the uniform
   *      404; a context of ANOTHER agency than the mission is the uniform
   *      404 (a foreign product context is not a traversal oracle);
   *   3. resolves the optionally attached /research session through the
   *      research reference port (READ-ONLY, BY REFERENCE — the MKT-069
   *      seam): unknown session → the uniform 404; a session of another
   *      agency is the uniform 404;
   *   4. resolves the PURSUIT SCOPE through the workspace port (the
   *      operator's pursuit-scope composition): unknown workspace or a
   *      workspace of another agency than the mission → the uniform 404;
   *      a disabled workspace → ConflictError (new use is blocked without
   *      rewriting history);
   *   5. reads the pursuit client's platform-health evaluations (latest
   *      per account), experiment analyses (newest first, bounded) with
   *      their latest allocation recommendations, and CURRENT
   *      content-intelligence hypotheses — all READ-ONLY through the
   *      frozen-row public contracts;
   *   6. runs the DETERMINISTIC pure core (pm-plan-v1) and appends ONE
   *      immutable plan version (+ its FK-anchored citation links) with
   *      the REQUIRED reason + provenance — IDEMPOTENTLY: when the latest
   *      version's input digest equals the composed digest, the command
   *      converges to the EXISTING version (the honest replay — no
   *      duplicate version, no silent rewrite).
   *
   * The first composition creates the plan header (ONE plan per mission —
   * concurrent first compositions converge under the plan row lock). A
   * compose input is exactly the durable references + the REQUIRED
   * reason — there is NO channel for a caller-declared portfolio, metric,
   * verdict or citation (the fabrication-resistance discipline is
   * structural).
   */
  composeProductMarketingPlan(
    input: {
      readonly missionId: string;
      readonly productContextId: string;
      readonly pursuitWorkspaceId: string;
      readonly researchSessionId: string | null;
      /** The REQUIRED reason this plan version is recorded (1..4000 chars). */
      readonly reason: string;
    },
    provenance: ProductMarketingProvenance,
  ): Promise<ProductMarketingPlanDetail>;

  /** Raw plan header by mission id (null when no plan exists). */
  getProductMarketingPlan(missionId: string): Promise<ProductMarketingPlanRecord | null>;

  /**
   * Canonical plan ownership resolution: the plan header composed into the
   * canonical owner context. Null when no plan exists for the mission —
   * callers surface the uniform 404 so foreign, unknown and unmapped
   * mission identifiers are indistinguishable.
   */
  resolveProductMarketingPlanOwnership(
    missionId: string,
  ): Promise<ProductMarketingPlanOwnerContext | null>;

  /**
   * The composed honest read-back: the header + the CURRENT version + the
   * complete append-only version tail + the current version's typed
   * citation links + the disclosures. Null when no plan exists.
   */
  getProductMarketingPlanDetail(missionId: string): Promise<ProductMarketingPlanDetail | null>;

  /** The append-only version tail (oldest first). Null when no plan exists. */
  getProductMarketingPlanVersions(
    missionId: string,
  ): Promise<readonly ProductMarketingPlanVersionRecord[] | null>;
}

export interface ProductMarketingModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * The disclosed COMPOSITION DATA seam (the MKT-056 AC-3 fence + the
   * adapter-registry precedent): the concrete platform-id → content-class
   * table arrives as module DATA wired at the composition root — the
   * module itself carries NO platform-specific identifiers (proven by the
   * boundary battery); the table is frozen with pm-plan-v1.
   */
  readonly platformClasses: ProductMarketingPlatformClassTable;
  /** Frozen matrix: /product-marketing ──→ /growth-missions — the mission DATA MODEL, READ-ONLY. */
  readonly missions: GrowthMissionsModuleApi;
  /** Frozen matrix: /product-marketing ──→ /product-intelligence — the URL/code context, READ-ONLY. */
  readonly productIntelligence: ProductIntelligenceModuleApi;
  /** Frozen matrix: /product-marketing ──→ /content-intelligence — the hypotheses surface, READ-ONLY. */
  readonly contentIntelligence: ContentIntelligenceModuleApi;
  /** Frozen matrix: /product-marketing ──→ /platform-health — the descriptive health states, READ-ONLY. */
  readonly platformHealth: PlatformHealthModuleApi;
  /** Frozen matrix: /product-marketing ──→ /experiment-analysis — the analysis/allocation results, READ-ONLY. */
  readonly experimentAnalysis: ExperimentAnalysisModuleApi;
  /**
   * The disclosed off-matrix research reference port (the MKT-069
   * by-reference seam — the growth-operator /workspaces precedent):
   * research sessions/insights attach BY REFERENCE, READ-ONLY.
   */
  readonly researchReferences: ProductMarketingResearchReferencePort;
  /**
   * The disclosed off-matrix pursuit-scope port (the Growth Operator's
   * exact composition): workspace → client → agency, READ-ONLY.
   */
  readonly workspaces: ProductMarketingWorkspacePort;
}

export { createProductMarketingModule } from './internal/product-marketing-module.ts';
/**
 * The pure deterministic planning core (the pm-plan-v1 product-signal
 * derivation, the platform-portfolio scoring, the metric-plan formulas,
 * the content-strategy selection, the attribution/experiment plan
 * composition and the deterministic input digest) and the input guards —
 * exported for unit tests and future server-side callers so the planning
 * semantics are part of the module contract. Pure functions: no clock, no
 * randomness, no network, no I/O.
 */
export {
  composeProductMarketingPlanCore,
  computePlannerInputDigest,
  deriveProductSignals,
  cite,
  PRODUCT_MARKETING_BASE_PLATFORM_SCORE,
  PRODUCT_MARKETING_EXCLUDED_HEALTH_STATES,
  PRODUCT_MARKETING_HEALTH_SCORE_MODIFIERS,
  assertValidProductMarketingProvenance,
  assertValidComposeProductMarketingPlanInput,
} from './internal/planning.ts';
